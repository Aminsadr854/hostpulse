"""
Reading a machine over SSH, once a minute.

No agent is installed anywhere. Everything here comes out of /proc and one df,
in a single command, because the expensive part of polling twenty machines is
the SSH handshake and not the work at the far end. What comes back is a few
hundred bytes.

Counters like bytes-received are cumulative since boot, so the useful number -
how much moved since we last looked - is a difference between two readings. The
previous reading is kept per server; a reboot, an interface reset or a counter
wrap shows up as a decrease, and a decrease is recorded as no traffic rather
than as a wildly negative number.
"""
import asyncio
import logging
import time

import asyncssh

import crypto
import db

log = logging.getLogger("collector")

POLL_SECONDS = 60
CONNECT_TIMEOUT = 20
COMMAND_TIMEOUT = 25

# One round trip. Markers keep the parsing honest when a field is missing on an
# unusual kernel rather than shifting every value that follows.
PROBE = r"""
echo "@cpu"; head -1 /proc/stat
echo "@mem"; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo "@net"; cat /proc/net/dev | tail -n +3
echo "@disk"; df -P -B1 / | tail -1
echo "@load"; cat /proc/loadavg
echo "@up"; cat /proc/uptime
echo "@cores"; nproc
echo "@host"; hostname
"""


def _sections(text):
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith("@"):
            cur = line[1:].strip()
            out[cur] = []
        elif cur:
            out[cur].append(line)
    return out


def parse(text):
    """Turn the probe output into raw readings. Missing pieces stay None."""
    s = _sections(text)
    r = {}

    if s.get("cpu"):
        f = s["cpu"][0].split()
        if len(f) > 4 and f[0] == "cpu":
            nums = [int(x) for x in f[1:] if x.isdigit()]
            idle = nums[3] + (nums[4] if len(nums) > 4 else 0)   # idle + iowait
            total = sum(nums)
            r["cpu_busy"], r["cpu_total"] = total - idle, total

    mem = {}
    for line in s.get("mem", []):
        parts = line.split()
        if len(parts) >= 2:
            mem[parts[0].rstrip(":")] = int(parts[1]) * 1024      # kB -> bytes
    if "MemTotal" in mem:
        r["mem_total"] = mem["MemTotal"]
        if "MemAvailable" in mem:
            r["mem_used"] = mem["MemTotal"] - mem["MemAvailable"]

    rx = tx = 0
    for line in s.get("net", []):
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        name = name.strip()
        # Loopback is not traffic, and virtual interfaces would count the same
        # bytes a second time as they pass through.
        if name == "lo" or name.startswith(("veth", "docker", "br-", "virbr")):
            continue
        f = rest.split()
        if len(f) >= 9:
            rx += int(f[0])
            tx += int(f[8])
    r["rx_total"], r["tx_total"] = rx, tx

    if s.get("disk"):
        f = s["disk"][0].split()
        if len(f) >= 4:
            r["disk_total"], r["disk_used"] = int(f[1]), int(f[2])

    if s.get("load"):
        try:
            r["load1"] = float(s["load"][0].split()[0])
        except (ValueError, IndexError):
            pass
    if s.get("up"):
        try:
            r["uptime"] = int(float(s["up"][0].split()[0]))
        except (ValueError, IndexError):
            pass
    if s.get("cores"):
        try:
            r["cores"] = int(s["cores"][0].strip())
        except ValueError:
            pass
    if s.get("host"):
        r["hostname"] = s["host"][0].strip()[:64]
    return r


async def connect(server):
    """Open a session using whichever credential the server was added with."""
    opts = {
        "host": server["host"],
        "port": int(server["port"] or 22),
        "username": server["username"] or "root",
        "known_hosts": None,          # these are the operator's own machines
        "connect_timeout": CONNECT_TIMEOUT,
    }
    if server["auth"] == "key":
        key_text = crypto.decrypt(server["secret"])
        passphrase = crypto.decrypt(server["passphrase"]) if server.get("passphrase") else None
        try:
            key = asyncssh.import_private_key(key_text, passphrase or None)
        except asyncssh.KeyEncryptionError:
            raise RuntimeError("the private key is encrypted and the passphrase is wrong or missing")
        except asyncssh.KeyImportError as e:
            raise RuntimeError("this does not look like a valid private key: %s" % e)
        opts["client_keys"] = [key]
    else:
        opts["password"] = crypto.decrypt(server["secret"])
    return await asyncio.wait_for(asyncssh.connect(**opts), timeout=CONNECT_TIMEOUT + 5)


async def probe_once(server):
    """Connect, read, disconnect. Returns the parsed reading."""
    conn = await connect(server)
    try:
        res = await asyncio.wait_for(conn.run(PROBE, check=False),
                                     timeout=COMMAND_TIMEOUT)
        return parse(res.stdout or "")
    finally:
        conn.close()


def _delta(now, before, key):
    """A counter difference, with a reset read as 'no traffic' rather than
    a negative spike that would poison every total it lands in."""
    if before is None or before.get(key) is None or now.get(key) is None:
        return 0
    d = now[key] - before[key]
    return d if d >= 0 else 0


async def poll_server(con, server):
    sid = server["id"]
    try:
        reading = await probe_once(server)
    except Exception as e:
        db.mark_result(con, sid, False, "%s: %s" % (type(e).__name__, e))
        log.warning("poll %s (%s) failed: %s", server["name"], server["host"], e)
        return False

    now = int(time.time())
    before = db.previous_counters(con, sid)

    cpu_pct = None
    if before and before.get("cpu_total") is not None and "cpu_total" in reading:
        dt = reading["cpu_total"] - before["cpu_total"]
        dbusy = reading["cpu_busy"] - before["cpu_busy"]
        if dt > 0 and dbusy >= 0:
            cpu_pct = round(100.0 * dbusy / dt, 2)

    db.add_sample(
        con, sid, now,
        cpu_pct=cpu_pct,
        mem_used=reading.get("mem_used"), mem_total=reading.get("mem_total"),
        disk_used=reading.get("disk_used"), disk_total=reading.get("disk_total"),
        rx_delta=_delta(reading, before, "rx_total"),
        tx_delta=_delta(reading, before, "tx_total"),
        load1=reading.get("load1"), uptime=reading.get("uptime"))

    db.save_counters(con, sid, now, reading.get("rx_total"), reading.get("tx_total"),
                     reading.get("cpu_busy"), reading.get("cpu_total"))
    db.mark_result(con, sid, True)
    return True


async def run_forever():
    con = db.connect()
    last_roll = 0
    while True:
        started = time.time()
        try:
            servers = [s for s in db.list_servers(con, include_secrets=True)
                       if s["enabled"]]
            if servers:
                # All at once: twenty servers polled one after another would
                # take longer than the interval itself.
                await asyncio.gather(*(poll_server(con, s) for s in servers),
                                     return_exceptions=True)
            if time.time() - last_roll > 600:
                db.roll_up(con)
                last_roll = time.time()
        except Exception:
            log.exception("poll cycle failed")
        await asyncio.sleep(max(5, POLL_SECONDS - (time.time() - started)))
