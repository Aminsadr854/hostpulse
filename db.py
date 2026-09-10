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
CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0
);

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
    last_error  TEXT,
    group_id    INTEGER,
    position    INTEGER NOT NULL DEFAULT 0
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
    _migrate(con)
    return con


def _migrate(con):
    """Add columns a database made by an earlier version has never seen.

    CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it was, so a
    panel that has been collecting for weeks would otherwise start throwing on
    the first query that mentions a new column."""
    have = {r["name"] for r in con.execute("PRAGMA table_info(servers)")}
    for column, ddl in (("group_id", "INTEGER"),
                        ("position", "INTEGER NOT NULL DEFAULT 0")):
        if column not in have:
            con.execute(f"ALTER TABLE servers ADD COLUMN {column} {ddl}")
    con.commit()


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
        ("id,name,host,port,username,auth,enabled,created_at,last_ok,last_error,"
         "group_id,position")
    # The operator's arrangement first, and only then the name - a list that
    # reorders itself after every rename is not an arrangement.
    return [dict(r) for r in con.execute(
        f"SELECT {cols} FROM servers ORDER BY position, name COLLATE NOCASE")]


def get_server(con, sid, include_secrets=False):
    cols = "*" if include_secrets else \
        ("id,name,host,port,username,auth,enabled,created_at,last_ok,last_error,"
         "group_id,position")
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
    # group_id is the one field whose None is a value rather than an omission:
    # "no group" has to be storable, or a server can be filed but never unfiled.
    nullable = ("group_id",)
    for k in ("name", "host", "port", "username", "auth", "secret",
              "passphrase", "enabled", "group_id", "position"):
        if k in f and (f[k] is not None or k in nullable):
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


# ------------------------------------------------------------------ groups
def list_groups(con):
    return [dict(r) for r in con.execute(
        "SELECT * FROM groups ORDER BY position, id")]


def add_group(con, name):
    pos = con.execute("SELECT COALESCE(MAX(position),0)+1 p FROM groups").fetchone()["p"]
    cur = con.execute("INSERT INTO groups (name, position) VALUES (?,?)",
                      (name.strip()[:60], pos))
    con.commit()
    return cur.lastrowid


def rename_group(con, gid, name):
    con.execute("UPDATE groups SET name=? WHERE id=?", (name.strip()[:60], gid))
    con.commit()


def delete_group(con, gid):
    # The servers outlive the group; they simply become ungrouped. Deleting a
    # label should never be a way to lose a machine.
    con.execute("UPDATE servers SET group_id=NULL WHERE group_id=?", (gid,))
    con.execute("DELETE FROM groups WHERE id=?", (gid,))
    con.commit()


def save_layout(con, groups, servers):
    """Persist an arrangement in one go: group order, and each server's group
    and place within it."""
    for pos, gid in enumerate(groups or []):
        con.execute("UPDATE groups SET position=? WHERE id=?", (pos, int(gid)))
    for pos, item in enumerate(servers or []):
        gid = item.get("group_id")
        con.execute("UPDATE servers SET group_id=?, position=? WHERE id=?",
                    (int(gid) if gid else None, pos, int(item["id"])))
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


def latest_rate(con, sid, stale_after=210):
    """
    Bytes per second, from the gap between the last two samples.

    Dividing by the nominal poll interval is only right when the poll happened
    on time. A retry, a restart, or a manual poll makes the real gap anything
    from seconds to minutes, and the reported rate is wrong by that ratio.

    A reading older than a few minutes is not a current rate at all - it is the
    last thing a machine said before it went quiet - so it returns nothing
    rather than keeping a dead server's traffic on the board for ever.
    """
    rows = con.execute(
        """SELECT ts, rx_delta, tx_delta FROM samples
           WHERE server_id=? ORDER BY ts DESC LIMIT 2""", (sid,)).fetchall()
    if len(rows) < 2:
        return None, None
    now, before = rows[0], rows[1]
    if time.time() - now["ts"] > stale_after:
        return None, None
    gap = now["ts"] - before["ts"]
    if gap <= 0:
        return None, None
    return (now["rx_delta"] or 0) / gap, (now["tx_delta"] or 0) / gap


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
