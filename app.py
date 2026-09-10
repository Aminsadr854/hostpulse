"""
hostpulse - a small monitoring panel for servers you already have SSH to.

No agent is installed on the machines being watched. A server is added from the
panel with a password or a private key, and from then on it is read once a
minute over SSH: processor, memory, disk, and how many bytes its interfaces
moved. The traffic figures are what most of this exists for - what a machine
used today, this week, this month - because that is the number that decides a
bill and the one a provider's own panel is usually least willing to show.

Everything lives in one process and one SQLite file.
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time

from aiohttp import web

import collector
import crypto
import db

log = logging.getLogger("hostpulse")

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
SESSION_COOKIE = "hostpulse"
SESSION_HOURS = 24 * 14


# ------------------------------------------------------------------- auth
def hash_password(password: str, salt: bytes = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_b64, dk_b64 = stored.split("$", 1)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except Exception:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return hmac.compare_digest(dk, expected)


def _sign(con, payload: str) -> str:
    key = db.get_setting(con, "session_key")
    if not key:
        key = secrets.token_hex(32)
        db.set_setting(con, "session_key", key)
    return hmac.new(key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_session(con) -> str:
    payload = str(int(time.time()))
    return payload + "." + _sign(con, payload)


def valid_session(con, cookie: str) -> bool:
    if not cookie or "." not in cookie:
        return False
    payload, sig = cookie.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(con, payload)):
        return False
    try:
        return time.time() - int(payload) < SESSION_HOURS * 3600
    except ValueError:
        return False


@web.middleware
async def auth_middleware(request, handler):
    open_paths = ("/login", "/static", "/health", "/setup")
    if request.path.startswith(open_paths):
        return await handler(request)
    if not valid_session(request.app["con"], request.cookies.get(SESSION_COOKIE, "")):
        if request.path.startswith("/api/"):
            return web.json_response({"error": "unauthorised"}, status=401)
        raise web.HTTPFound("/login")
    return await handler(request)


# ------------------------------------------------------------------ pages
def page(name):
    with open(os.path.join(HERE, "templates", name), encoding="utf-8") as f:
        return f.read()


async def index(request):
    return web.Response(text=page("index.html"), content_type="text/html")


async def login_page(request):
    con = request.app["con"]
    if not db.get_setting(con, "admin_hash"):
        raise web.HTTPFound("/setup")
    return web.Response(text=page("login.html"), content_type="text/html")


async def setup_page(request):
    con = request.app["con"]
    if db.get_setting(con, "admin_hash"):
        raise web.HTTPFound("/login")
    return web.Response(text=page("setup.html"), content_type="text/html")


async def do_setup(request):
    con = request.app["con"]
    if db.get_setting(con, "admin_hash"):
        return web.json_response({"error": "already configured"}, status=400)
    body = await request.json()
    pw = (body.get("password") or "").strip()
    if len(pw) < 8:
        return web.json_response({"error": "رمز باید حداقل ۸ نویسه باشد"}, status=400)
    db.set_setting(con, "admin_hash", hash_password(pw))
    r = web.json_response({"ok": True})
    r.set_cookie(SESSION_COOKIE, make_session(con), httponly=True,
                 samesite="Lax", max_age=SESSION_HOURS * 3600)
    return r


async def do_login(request):
    con = request.app["con"]
    body = await request.json()
    stored = db.get_setting(con, "admin_hash")
    # A short, fixed delay on failure: enough that guessing over a network is
    # pointless, small enough that a typo is not annoying.
    if not stored or not verify_password(body.get("password") or "", stored):
        await asyncio.sleep(1.5)
        return web.json_response({"error": "رمز اشتباه است"}, status=401)
    r = web.json_response({"ok": True})
    r.set_cookie(SESSION_COOKIE, make_session(con), httponly=True,
                 samesite="Lax", max_age=SESSION_HOURS * 3600)
    return r


async def do_logout(request):
    r = web.HTTPFound("/login")
    r.del_cookie(SESSION_COOKIE)
    return r


# -------------------------------------------------------------------- api
def _summary(con, s):
    last = db.latest(con, s["id"])
    now = int(time.time())
    day = now // 86400 * 86400
    online = bool(s["last_ok"] and now - s["last_ok"] < 180)
    out = {
        **s,
        "online": online,
        "cpu_pct": last["cpu_pct"] if last else None,
        "mem_pct": (100.0 * last["mem_used"] / last["mem_total"])
        if last and last.get("mem_total") else None,
        "disk_pct": (100.0 * last["disk_used"] / last["disk_total"])
        if last and last.get("disk_total") else None,
        "mem_total": last.get("mem_total") if last else None,
        "disk_total": last.get("disk_total") if last else None,
        "load1": last.get("load1") if last else None,
        "uptime": last.get("uptime") if last else None,
        # bytes per second over the last minute, which is what "bandwidth"
        # means to someone looking at a live panel
        "rx_rate": (last["rx_delta"] / collector.POLL_SECONDS)
        if last and last.get("rx_delta") is not None else None,
        "tx_rate": (last["tx_delta"] / collector.POLL_SECONDS)
        if last and last.get("tx_delta") is not None else None,
        "today": db.traffic_total(con, s["id"], day),
        "week": db.traffic_total(con, s["id"], now - 7 * 86400),
        "month": db.traffic_total(con, s["id"], now - 30 * 86400),
    }
    return out


async def api_servers(request):
    con = request.app["con"]
    servers = [_summary(con, s) for s in db.list_servers(con)]
    groups = db.list_groups(con)
    # Totals per group are the reason to have groups at all: "what did the
    # credit-billed machines cost this month" is a question about a set, and
    # adding the cards up by eye is not an answer.
    for g in groups:
        mine = [s for s in servers if s.get("group_id") == g["id"]]
        g["count"] = len(mine)
        g["online"] = sum(1 for s in mine if s["online"])
        for span in ("today", "week", "month"):
            g[span] = sum(s[span]["total"] for s in mine)
        g["rx_rate"] = sum(s["rx_rate"] or 0 for s in mine)
        g["tx_rate"] = sum(s["tx_rate"] or 0 for s in mine)
    return web.json_response(
        {"servers": servers, "groups": groups,
         "poll_seconds": collector.POLL_SECONDS})


async def api_groups_add(request):
    con = request.app["con"]
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "نام گروه لازم است"}, status=400)
    return web.json_response({"ok": True, "id": db.add_group(con, name)})


async def api_group_edit(request):
    con = request.app["con"]
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "نام گروه لازم است"}, status=400)
    db.rename_group(con, int(request.match_info["gid"]), name)
    return web.json_response({"ok": True})


async def api_group_delete(request):
    con = request.app["con"]
    db.delete_group(con, int(request.match_info["gid"]))
    return web.json_response({"ok": True})


async def api_layout(request):
    """The whole arrangement after a drag: which group each server is in, and
    the order of both."""
    con = request.app["con"]
    body = await request.json()
    db.save_layout(con, body.get("groups"), body.get("servers"))
    return web.json_response({"ok": True})


async def api_server(request):
    con = request.app["con"]
    sid = int(request.match_info["sid"])
    s = db.get_server(con, sid)
    if not s:
        return web.json_response({"error": "not found"}, status=404)
    rng = request.query.get("range", "24h")
    now = int(time.time())
    if rng == "24h":
        since, bucket = now - 86400, None
    elif rng == "7d":
        since, bucket = now - 7 * 86400, "hour"
    else:
        since, bucket = now - 30 * 86400, "day"
    return web.json_response({
        "server": _summary(con, s),
        "range": rng,
        "points": db.series(con, sid, since, bucket),
    })


def _credential_fields(body):
    auth = body.get("auth") or "password"
    if auth not in ("password", "key"):
        raise ValueError("auth must be 'password' or 'key'")
    secret = body.get("secret") or ""
    if not secret.strip():
        raise ValueError("رمز یا کلید خصوصی لازم است")
    out = {"auth": auth, "secret": crypto.encrypt(secret)}
    ph = body.get("passphrase")
    out["passphrase"] = crypto.encrypt(ph) if ph else None
    return out


async def api_add(request):
    con = request.app["con"]
    body = await request.json()
    for f in ("name", "host"):
        if not (body.get(f) or "").strip():
            return web.json_response({"error": f"{f} لازم است"}, status=400)
    try:
        fields = _credential_fields(body)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    sid = db.add_server(
        con, name=body["name"].strip(), host=body["host"].strip(),
        port=body.get("port") or 22, username=(body.get("username") or "root").strip(),
        **fields)
    return web.json_response({"ok": True, "id": sid})


async def api_edit(request):
    con = request.app["con"]
    sid = int(request.match_info["sid"])
    body = await request.json()
    fields = {k: body[k] for k in ("name", "host", "port", "username", "enabled")
              if k in body}
    if body.get("secret"):
        try:
            fields.update(_credential_fields(body))
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
    db.update_server(con, sid, **fields)
    return web.json_response({"ok": True})


async def api_delete(request):
    con = request.app["con"]
    db.delete_server(con, int(request.match_info["sid"]))
    return web.json_response({"ok": True})


async def api_test(request):
    """
    Try the credentials without saving anything.

    Worth its own endpoint: the alternative is saving a server that silently
    never connects, and then wondering why its card stays grey.
    """
    body = await request.json()
    try:
        fields = _credential_fields(body)
    except ValueError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=400)
    trial = {"host": (body.get("host") or "").strip(),
             "port": body.get("port") or 22,
             "username": (body.get("username") or "root").strip(), **fields}
    try:
        reading = await collector.probe_once(trial)
    except Exception as e:
        return web.json_response({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
    return web.json_response({
        "ok": True,
        "hostname": reading.get("hostname"),
        "cores": reading.get("cores"),
        "mem_total": reading.get("mem_total"),
        "disk_total": reading.get("disk_total"),
    })


async def api_poll_now(request):
    con = request.app["con"]
    sid = int(request.match_info["sid"])
    s = db.get_server(con, sid, include_secrets=True)
    if not s:
        return web.json_response({"error": "not found"}, status=404)
    ok = await collector.poll_server(con, s)
    return web.json_response({"ok": ok, "server": _summary(con, db.get_server(con, sid))})


async def health(request):
    return web.json_response({"ok": True, "ts": int(time.time())})


# ------------------------------------------------------------------- boot
async def start_collector(app):
    app["collector"] = asyncio.create_task(collector.run_forever())


async def stop_collector(app):
    app["collector"].cancel()
    try:
        await app["collector"]
    except asyncio.CancelledError:
        pass


def build_app():
    app = web.Application(middlewares=[auth_middleware])
    app["con"] = db.connect()
    app.router.add_get("/", index)
    app.router.add_get("/login", login_page)
    app.router.add_post("/login", do_login)
    app.router.add_get("/setup", setup_page)
    app.router.add_post("/setup", do_setup)
    app.router.add_get("/logout", do_logout)
    app.router.add_get("/health", health)
    app.router.add_get("/api/servers", api_servers)
    app.router.add_get("/api/servers/{sid}", api_server)
    app.router.add_post("/api/servers", api_add)
    app.router.add_post("/api/servers/{sid}", api_edit)
    app.router.add_post("/api/servers/{sid}/delete", api_delete)
    app.router.add_post("/api/servers/{sid}/poll", api_poll_now)
    app.router.add_post("/api/test", api_test)
    app.router.add_post("/api/groups", api_groups_add)
    app.router.add_post("/api/groups/{gid}", api_group_edit)
    app.router.add_post("/api/groups/{gid}/delete", api_group_delete)
    app.router.add_post("/api/layout", api_layout)
    app.router.add_static("/static/", STATIC)
    app.on_startup.append(start_collector)
    app.on_cleanup.append(stop_collector)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    host = os.environ.get("HOSTPULSE_BIND", "127.0.0.1")
    port = int(os.environ.get("HOSTPULSE_PORT", "8899"))
    log.info("hostpulse listening on %s:%s", host, port)
    web.run_app(build_app(), host=host, port=port, print=None)
