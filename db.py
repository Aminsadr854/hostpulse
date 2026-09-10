"""
Storage: raw samples, rolled up as they age.

A minute-resolution sample is worth keeping for a few days and worthless after
that, but the totals computed from it - how much traffic a server moved in a
month - have to survive. So samples are folded into hourly and then daily rows
as they age, and the daily rows are never deleted. A year of history for twenty
servers costs a few megabytes.
"""
import os
import sqlite3
import time

DB_PATH = os.environ.get("HOSTPULSE_DB", "/opt/hostpulse/data/hostpulse.db")

RAW_KEEP_HOURS = 48          # minute samples
HOURLY_KEEP_DAYS = 120       # hourly rollups
# daily rollups are kept for ever


SCHEMA = """
CREATE TABLE IF NOT EXISTS servers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL DEFAULT 22,
    username    TEXT NOT NULL DEFAULT 'root',
    auth        TEXT NOT NULL,              -- 'password' | 'key'
    secret      TEXT NOT NULL,              -- encrypted password or private key
    passphrase  TEXT,                       -- encrypted, for an encrypted key
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    last_ok     INTEGER,
    last_error  TEXT
);

CREATE TABLE IF NOT EXISTS samples (
    server_id   INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    cpu_pct     REAL,
    mem_used    INTEGER,
    mem_total   INTEGER,
    disk_used   INTEGER,
    disk_total  INTEGER,
    rx_delta    INTEGER,      -- bytes since the previous sample
    tx_delta    INTEGER,
    load1       REAL,
    uptime      INTEGER,
    PRIMARY KEY (server_id, ts)
);

CREATE TABLE IF NOT EXISTS rollups (
    server_id   INTEGER NOT NULL,
    bucket      TEXT NOT NULL,      -- 'hour' | 'day'
    ts          INTEGER NOT NULL,   -- start of the bucket
    cpu_pct     REAL,
    mem_pct     REAL,
    disk_pct    REAL,
    rx_bytes    INTEGER,
    tx_bytes    INTEGER,
    samples     INTEGER,
    PRIMARY KEY (server_id, bucket, ts)
);

-- the raw counters, kept only to turn the next reading into a delta
CREATE TABLE IF NOT EXISTS counters (
    server_id   INTEGER PRIMARY KEY,
    ts          INTEGER,
    rx_total    INTEGER,
    tx_total    INTEGER,
    cpu_busy    INTEGER,
    cpu_total   INTEGER
);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);

CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts);
CREATE INDEX IF NOT EXISTS rollups_ts ON rollups (bucket, ts);
"""


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=10000")
    con.executescript(SCHEMA)
    return con


# ---------------------------------------------------------------- settings
def get_setting(con, k, default=None):
    r = con.execute("SELECT v FROM settings WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_setting(con, k, v):
    con.execute("INSERT OR REPLACE INTO settings (k,v) VALUES (?,?)", (k, str(v)))
    con.commit()


# ----------------------------------------------------------------- servers
def list_servers(con, include_secrets=False):
    cols = "*" if include_secrets else \
        "id,name,host,port,username,auth,enabled,created_at,last_ok,last_error"
    return [dict(r) for r in con.execute(
        f"SELECT {cols} FROM servers ORDER BY name COLLATE NOCASE")]


def get_server(con, sid, include_secrets=False):
    cols = "*" if include_secrets else \
        "id,name,host,port,username,auth,enabled,created_at,last_ok,last_error"
    r = con.execute(f"SELECT {cols} FROM servers WHERE id=?", (sid,)).fetchone()
    return dict(r) if r else None


def add_server(con, **f):
    cur = con.execute(
        """INSERT INTO servers (name,host,port,username,auth,secret,passphrase,
                                enabled,created_at)
           VALUES (?,?,?,?,?,?,?,1,?)""",
        (f["name"], f["host"], int(f.get("port") or 22), f.get("username") or "root",
         f["auth"], f["secret"], f.get("passphrase"), int(time.time())))
    con.commit()
    return cur.lastrowid


def update_server(con, sid, **f):
    sets, vals = [], []
    for k in ("name", "host", "port", "username", "auth", "secret",
              "passphrase", "enabled"):
        if k in f and f[k] is not None:
            sets.append(f"{k}=?")
            vals.append(f[k])
    if not sets:
        return
    vals.append(sid)
    con.execute(f"UPDATE servers SET {','.join(sets)} WHERE id=?", vals)
    con.commit()


def delete_server(con, sid):
    for t in ("samples", "rollups", "counters"):
        con.execute(f"DELETE FROM {t} WHERE server_id=?", (sid,))
    con.execute("DELETE FROM servers WHERE id=?", (sid,))
    con.commit()


def mark_result(con, sid, ok, error=None):
    if ok:
        con.execute("UPDATE servers SET last_ok=?, last_error=NULL WHERE id=?",
                    (int(time.time()), sid))
    else:
        con.execute("UPDATE servers SET last_error=? WHERE id=?",
                    (str(error)[:300], sid))
    con.commit()


# ----------------------------------------------------------------- samples
def previous_counters(con, sid):
    r = con.execute("SELECT * FROM counters WHERE server_id=?", (sid,)).fetchone()
    return dict(r) if r else None


def save_counters(con, sid, ts, rx, tx, busy, total):
    con.execute("""INSERT OR REPLACE INTO counters
                   (server_id,ts,rx_total,tx_total,cpu_busy,cpu_total)
                   VALUES (?,?,?,?,?,?)""", (sid, ts, rx, tx, busy, total))


def add_sample(con, sid, ts, **m):
    con.execute("""INSERT OR REPLACE INTO samples
        (server_id,ts,cpu_pct,mem_used,mem_total,disk_used,disk_total,
         rx_delta,tx_delta,load1,uptime)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (sid, ts, m.get("cpu_pct"), m.get("mem_used"), m.get("mem_total"),
         m.get("disk_used"), m.get("disk_total"), m.get("rx_delta"),
         m.get("tx_delta"), m.get("load1"), m.get("uptime")))
    con.commit()


def latest(con, sid):
    r = con.execute("""SELECT * FROM samples WHERE server_id=?
                       ORDER BY ts DESC LIMIT 1""", (sid,)).fetchone()
    return dict(r) if r else None


# ----------------------------------------------------------------- history
def series(con, sid, since, bucket=None):
    """Points for a graph. Raw below two days, rolled up above."""
    if bucket in ("hour", "day"):
        rows = con.execute(
            """SELECT ts, cpu_pct, mem_pct, disk_pct, rx_bytes, tx_bytes
               FROM rollups WHERE server_id=? AND bucket=? AND ts>=?
               ORDER BY ts""", (sid, bucket, since)).fetchall()
        return [dict(r) for r in rows]
    rows = con.execute(
        """SELECT ts, cpu_pct,
                  CASE WHEN mem_total>0 THEN 100.0*mem_used/mem_total END mem_pct,
                  CASE WHEN disk_total>0 THEN 100.0*disk_used/disk_total END disk_pct,
                  rx_delta rx_bytes, tx_delta tx_bytes
           FROM samples WHERE server_id=? AND ts>=? ORDER BY ts""",
        (sid, since)).fetchall()
    return [dict(r) for r in rows]


def traffic_total(con, sid, since, until=None):
    """Bytes moved in a period, from whichever table still has the detail."""
    until = until or int(time.time())
    row = con.execute(
        """SELECT COALESCE(SUM(rx_bytes),0) rx, COALESCE(SUM(tx_bytes),0) tx
           FROM rollups WHERE server_id=? AND bucket='day' AND ts>=? AND ts<?""",
        (sid, since, until)).fetchone()
    rx, tx = row["rx"], row["tx"]
    # today has no daily rollup yet, so add what the raw samples hold
    day_start = int(time.time()) // 86400 * 86400
    if until >= day_start:
        # Inclusive at the top: a sample written in the same second as the
        # query would otherwise be left out, which showed today's traffic as
        # zero right after a poll.
        r2 = con.execute(
            """SELECT COALESCE(SUM(rx_delta),0) rx, COALESCE(SUM(tx_delta),0) tx
               FROM samples WHERE server_id=? AND ts>=? AND ts<=?""",
            (sid, max(since, day_start), until)).fetchone()
        rx += r2["rx"]
        tx += r2["tx"]
    return {"rx": rx, "tx": tx, "total": rx + tx}


# ----------------------------------------------------------------- rollups
def roll_up(con, now=None):
    """
    Fold raw samples into hourly rows and hourly rows into daily ones.

    Idempotent: a bucket is recomputed from whatever detail still exists, so
    running this more often than necessary is harmless.
    """
    now = now or int(time.time())
    # raw -> hour, for every complete hour that still has raw data
    con.execute("""
        INSERT OR REPLACE INTO rollups
            (server_id,bucket,ts,cpu_pct,mem_pct,disk_pct,rx_bytes,tx_bytes,samples)
        SELECT server_id, 'hour', (ts/3600)*3600,
               AVG(cpu_pct),
               AVG(CASE WHEN mem_total>0 THEN 100.0*mem_used/mem_total END),
               AVG(CASE WHEN disk_total>0 THEN 100.0*disk_used/disk_total END),
               SUM(rx_delta), SUM(tx_delta), COUNT(*)
        FROM samples WHERE ts < ?
        GROUP BY server_id, (ts/3600)*3600
    """, ((now // 3600) * 3600,))

    # hour -> day
    con.execute("""
        INSERT OR REPLACE INTO rollups
            (server_id,bucket,ts,cpu_pct,mem_pct,disk_pct,rx_bytes,tx_bytes,samples)
        SELECT server_id, 'day', (ts/86400)*86400,
               AVG(cpu_pct), AVG(mem_pct), AVG(disk_pct),
               SUM(rx_bytes), SUM(tx_bytes), SUM(samples)
        FROM rollups WHERE bucket='hour' AND ts < ?
        GROUP BY server_id, (ts/86400)*86400
    """, ((now // 86400) * 86400,))

    con.execute("DELETE FROM samples WHERE ts < ?", (now - RAW_KEEP_HOURS * 3600,))
    con.execute("DELETE FROM rollups WHERE bucket='hour' AND ts < ?",
                (now - HOURLY_KEEP_DAYS * 86400,))
    con.commit()
