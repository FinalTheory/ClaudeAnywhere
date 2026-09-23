#!/usr/bin/env python3
"""VPS relay server: bridges the phone web UI to the client daemon running on
the laptop, over one persistent WebSocket. See remote/README.md for the wire
protocol this implements (mirrors remote/client/daemon.js's comment block).

Run:
    pip install -r requirements.txt
    cp .env.example .env && edit it
    watchfiles 'python server.py' . --ignore-paths=data,__pycache__,.env

Env (via .env, loaded by python-dotenv — see .env.example):
    AUTH_TOKEN required — shared by client daemon auth AND phone login
    HOST       default 0.0.0.0
    PORT       default 8764

DATA_DIR, INITIAL_LOAD_BYTES, and MAX_SESSION_BYTES are not configurable —
hardcoded below instead of env vars. DATA_DIR needs to stay colocated with
the code for `--ignore-paths=data` above and deploy-watch's `--exclude=data`
to both keep pointing at the right thing without a second place to update if
it ever moved; the other two just never needed tuning in practice, so one
less thing to carry in .env. Change the constants directly if that changes.
"""
import asyncio
import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from aiohttp import web, WSMsgType
from dotenv import load_dotenv

load_dotenv()

START_TIME = time.time()

AUTH_TOKEN = os.environ["AUTH_TOKEN"]
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8764"))
DATA_DIR = Path(__file__).parent / "data"
INITIAL_LOAD_BYTES = 2048  # tail context (in whole turns) a phone gets on open
MAX_SESSION_BYTES = 5_000_000  # per-session cap, oldest whole turns dropped first
COOKIE_NAME = "evi_remote_auth"
COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days

DATA_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = Path(__file__).parent / "static"


# --- cookie auth --------------------------------------------------------------
# Single shared password (same value as AUTH_TOKEN, per your call — one fewer
# secret to manage). A signed, expiring cookie; no session store needed.

def _sign(expiry: int) -> str:
    mac = hmac.new(AUTH_TOKEN.encode(), f"auth:{expiry}".encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{mac}"


def _verify_cookie(value: str) -> bool:
    if not value or "." not in value:
        return False
    expiry_str, mac = value.split(".", 1)
    try:
        expiry = int(expiry_str)
    except ValueError:
        return False
    if expiry < time.time():
        return False
    expected = hmac.new(AUTH_TOKEN.encode(), f"auth:{expiry}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, expected)


# --- per-session state ----------------------------------------------------------
# `turns` is a list of complete, independently-valid HTML fragments — one per
# Claude Code message ([class*="turn_"] in the captured DOM, see daemon.js's
# POLL_EXPR comment for why. Slicing/pagination/truncation only ever happens
# at turn boundaries, never mid-string, so every response this server ever
# sends is guaranteed well-formed HTML — the earlier full_html-as-one-string
# design couldn't promise that (byte-offset slicing cuts through tags).
# Capped at MAX_SESSION_BYTES total (oldest whole turns dropped first, never
# a partial turn) instead of a chunked file log — simpler, and the only
# thing that actually matters (bounded memory/disk) falls out of it for free.

class SessionState:
    __slots__ = ("session_id", "turns", "running", "last_seen", "phone_sockets")

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.turns: list[str] = []
        self.running = None
        self.last_seen = time.time()
        self.phone_sockets: set[web.WebSocketResponse] = set()

    def path(self) -> Path:
        return DATA_DIR / f"{self.session_id}.json"

    def load(self):
        p = self.path()
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            return
        self.turns = data.get("turns", [])
        self.running = data.get("running")
        self.last_seen = data.get("last_seen", time.time())

    def save(self):
        self.path().write_text(json.dumps({
            "turns": self.turns,
            "running": self.running,
            "last_seen": self.last_seen,
        }))

    def _cap(self):
        total = sum(len(t) for t in self.turns)
        while total > MAX_SESSION_BYTES and len(self.turns) > 1:
            total -= len(self.turns.pop(0))

    def apply_append(self, new_turns: list[str]):
        self.turns.extend(new_turns)
        self._cap()
        self.last_seen = time.time()
        self.save()

    def apply_resync(self, incoming: list[str]):
        if not incoming:
            return
        # A resync only ever carries a capped tail (see MAX_RESYNC_TURNS in
        # daemon.js), never the daemon's full history — so replacing
        # self.turns outright would destroy whatever older history this
        # server already accumulated that the daemon can no longer see
        # (e.g. VS Code virtualized it out of the DOM after a restart).
        # Instead, find where the incoming tail overlaps with what's already
        # stored (search from the end backward for its first turn) and
        # splice from there; if no overlap is found, treat it as freshly
        # appended content rather than discarding prior history.
        first = incoming[0]
        overlap_at = None
        for i in range(len(self.turns) - 1, -1, -1):
            if self.turns[i] == first:
                overlap_at = i
                break
        if overlap_at is not None:
            self.turns = self.turns[:overlap_at] + incoming
        else:
            self.turns = self.turns + incoming
        self._cap()
        self.last_seen = time.time()
        self.save()

    def apply_state(self, running: bool):
        self.running = running
        self.last_seen = time.time()
        self.save()


sessions: dict[str, SessionState] = {}
for f in DATA_DIR.glob("*.json"):
    st = SessionState(f.stem)
    st.load()
    sessions[f.stem] = st


def get_session(session_id: str) -> SessionState:
    if session_id not in sessions:
        sessions[session_id] = SessionState(session_id)
    return sessions[session_id]


def tail_window(turns: list[str], max_bytes: int) -> tuple[list[str], int]:
    """The last however-many whole turns needed to cover ~max_bytes, plus
    the absolute index they start at (for pagination cursors). Always
    includes at least the final turn, even if it alone exceeds max_bytes —
    guarantees forward progress instead of returning nothing."""
    total = 0
    start = len(turns)
    for i in range(len(turns) - 1, -1, -1):
        total += len(turns[i])
        start = i
        if total >= max_bytes:
            break
    return turns[start:], start


async def broadcast(st: SessionState, payload: dict):
    dead = []
    for phone_ws in st.phone_sockets:
        try:
            await phone_ws.send_json(payload)
        except Exception:
            dead.append(phone_ws)
    for d in dead:
        st.phone_sockets.discard(d)


# --- client daemon connection ---------------------------------------------------
# Single connected daemon assumed (one laptop). A second connection replaces
# the first rather than erroring — simplest behavior for a personal tool.

client_ws: "web.WebSocketResponse | None" = None
client_authed = False
pending_requests: dict[int, asyncio.Future] = {}
_next_req_id = 0


def next_req_id() -> int:
    global _next_req_id
    _next_req_id += 1
    return _next_req_id


async def send_to_client(obj: dict) -> bool:
    if client_ws is None or client_ws.closed or not client_authed:
        return False
    await client_ws.send_json(obj)
    return True


async def ws_client_handler(request: web.Request) -> web.WebSocketResponse:
    global client_ws, client_authed
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    if client_ws is not None and not client_ws.closed:
        await client_ws.close()
    client_ws = ws
    client_authed = False

    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            continue
        try:
            data = json.loads(msg.data)
        except json.JSONDecodeError:
            continue

        mtype = data.get("type")

        if mtype == "hello":
            if hmac.compare_digest(data.get("token", ""), AUTH_TOKEN):
                client_authed = True
                await ws.send_json({"type": "auth_ok"})
                # The daemon is a fresh process (or fresh connection) with no
                # memory of what it was watching before — re-issue subscribe
                # for every session a phone is still looking at, so viewers
                # don't go silently stale after a daemon restart/reconnect.
                for st in sessions.values():
                    if st.phone_sockets:
                        await ws.send_json({"type": "subscribe", "sessionId": st.session_id})
            else:
                await ws.send_json({"type": "auth_failed"})
                await ws.close()
            continue

        if not client_authed:
            continue

        if mtype == "sessions_result":
            fut = pending_requests.pop(data.get("reqId"), None)
            if fut and not fut.done():
                fut.set_result(data.get("sessions", []))
            continue

        if mtype == "state":
            st = get_session(data["sessionId"])
            st.apply_state(data["running"])
            await broadcast(st, {"type": "state", "running": data["running"]})
            continue

        if mtype == "append":
            st = get_session(data["sessionId"])
            st.apply_append(data["turns"])
            await broadcast(st, {"type": "append", "turns": data["turns"]})
            continue

        if mtype == "resync":
            st = get_session(data["sessionId"])
            st.apply_resync(data["turns"])  # full fidelity — this is the pagination source of truth
            # Never forward the full stored history to phones: a resync used
            # to carry the daemon's ENTIRE current snapshot (hundreds of KB
            # to multiple MB for a long session — confirmed empirically at
            # 750KB), and a resync fires on every subscribe by daemon design
            # (needed to correctly reconcile after a daemon restart).
            # Forwarding it verbatim silently defeated the "load ~2KB,
            # lazy-load older history on scroll" design the instant a phone
            # (re)opened a session. Phones get the same tail window `initial`
            # would give — see tail_window().
            window_turns, start_index = tail_window(st.turns, INITIAL_LOAD_BYTES)
            await broadcast(st, {"type": "resync", "turns": window_turns, "startIndex": start_index})
            continue

        if mtype in ("submit_ack", "error"):
            st = sessions.get(data.get("sessionId", ""))
            if st:
                await broadcast(st, data)
            continue

    if client_ws is ws:
        client_ws = None
        client_authed = False
    return ws


async def request_list_sessions(timeout: float = 5.0) -> list:
    req_id = next_req_id()
    fut = asyncio.get_running_loop().create_future()
    pending_requests[req_id] = fut
    ok = await send_to_client({"type": "list_sessions", "reqId": req_id})
    if not ok:
        pending_requests.pop(req_id, None)
        raise RuntimeError("client daemon not connected")
    try:
        return await asyncio.wait_for(fut, timeout)
    finally:
        pending_requests.pop(req_id, None)


# --- HTTP routes -----------------------------------------------------------------

def _is_authed(request: web.Request) -> bool:
    # Header auth is for scripted/API debugging (curl, integration tests) —
    # direct comparison against the raw shared secret, no expiry, since it's
    # meant to be supplied fresh on every call rather than cached like the
    # phone's cookie.
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer ") and hmac.compare_digest(header[len("Bearer "):], AUTH_TOKEN):
        return True
    cookie = request.cookies.get(COOKIE_NAME, "")
    return _verify_cookie(cookie)


def require_auth(handler):
    async def wrapped(request: web.Request):
        if not _is_authed(request):
            raise web.HTTPFound("/login")
        return await handler(request)
    return wrapped


async def login_page(request: web.Request) -> web.Response:
    template = (STATIC_DIR / "login.html").read_text()
    if request.method == "POST":
        form = await request.post()
        if hmac.compare_digest(str(form.get("password", "")), AUTH_TOKEN):
            expiry = int(time.time()) + COOKIE_MAX_AGE
            resp = web.HTTPFound("/app")
            resp.set_cookie(COOKIE_NAME, _sign(expiry), max_age=COOKIE_MAX_AGE, httponly=True, samesite="Strict")
            return resp
        return web.Response(text=template.replace("{{error}}", "Wrong password"), content_type="text/html")
    return web.Response(text=template.replace("{{error}}", ""), content_type="text/html")


@require_auth
async def app_page(request: web.Request) -> web.Response:
    return web.FileResponse(STATIC_DIR / "index.html")


@require_auth
async def api_sessions(request: web.Request) -> web.Response:
    try:
        remote_sessions = await request_list_sessions()
    except (RuntimeError, asyncio.TimeoutError) as err:
        return web.json_response({"error": str(err), "sessions": []}, status=503)
    return web.json_response({"sessions": remote_sessions})


@require_auth
async def api_history(request: web.Request) -> web.Response:
    # before_index: absolute index into st.turns, exclusive — "give me
    # history strictly before this point". The phone tracks this as its own
    # scroll-up cursor, seeded from the startIndex an `initial`/`resync`
    # message carried.
    session_id = request.match_info["session_id"]
    st = sessions.get(session_id)
    if st is None:
        return web.json_response({"turns": [], "has_more": False, "start_index": 0})
    before_index = int(request.query.get("before_index", str(len(st.turns))))
    limit_bytes = int(request.query.get("limit_bytes", str(INITIAL_LOAD_BYTES)))
    candidates = st.turns[:before_index]
    window_turns, start_index = tail_window(candidates, limit_bytes)
    return web.json_response({
        "turns": window_turns,
        "has_more": start_index > 0,
        "start_index": start_index,
        "running": st.running,
    })


async def ws_phone_handler(request: web.Request) -> web.WebSocketResponse:
    if not _is_authed(request):
        raise web.HTTPForbidden()

    session_id = request.match_info["session_id"]
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    st = get_session(session_id)
    st.phone_sockets.add(ws)
    await send_to_client({"type": "subscribe", "sessionId": session_id})

    window_turns, start_index = tail_window(st.turns, INITIAL_LOAD_BYTES)
    await ws.send_json({
        "type": "initial",
        "turns": window_turns,
        "startIndex": start_index,
        "running": st.running,
    })

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "submit":
                ok = await send_to_client(
                    {"type": "submit", "sessionId": session_id, "text": data.get("text", "")}
                )
                if not ok:
                    # send_to_client returns False silently if the daemon
                    # isn't connected right now (e.g. mid-restart) — without
                    # this, that's indistinguishable from "sent fine, still
                    # processing" on the phone, since a real submit_ack only
                    # ever comes from the daemon actually handling it. This
                    # is the direct reply on the requesting phone's own
                    # socket, not a broadcast — nobody else asked.
                    await ws.send_json({
                        "type": "submit_ack",
                        "ok": False,
                        "error": "client daemon not connected — message not sent, try again",
                    })
    finally:
        st.phone_sockets.discard(ws)
        if not st.phone_sockets:
            await send_to_client({"type": "unsubscribe", "sessionId": session_id})

    return ws


async def healthz(request: web.Request) -> web.Response:
    # Deliberately unauthenticated — meant to be curl-able by a monitor
    # without needing the password, and it leaks nothing sensitive (no
    # session content, just process/connection status). uptime_seconds
    # resetting unexpectedly is exactly the signal that would have caught
    # the watchfiles restart-storm bug immediately instead of needing a
    # multi-round investigation to find it via symptoms.
    client_connected = client_ws is not None and not client_ws.closed and client_authed
    return web.json_response({
        "status": "ok",
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "client_connected": client_connected,
        "sessions_tracked": len(sessions),
        "sessions_with_viewers": sum(1 for st in sessions.values() if st.phone_sockets),
    })


@web.middleware
async def no_cache_static(request: web.Request, handler):
    # This is under active development — JS/CSS change every few minutes via
    # the auto-deploy loop, with no cache-busting filename/query hash. Mobile
    # Safari caches static assets aggressively; without this, "fixed and
    # deployed" and "the phone is still running the old file" are
    # indistinguishable from the outside. Static-only, not app.py logic.
    resp = await handler(request)
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def make_app() -> web.Application:
    app = web.Application(middlewares=[no_cache_static])
    app.router.add_get("/", lambda r: web.HTTPFound("/app"))
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/login", login_page)
    app.router.add_post("/login", login_page)
    app.router.add_get("/app", app_page)
    app.router.add_get("/api/sessions", api_sessions)
    app.router.add_get("/api/session/{session_id}/history", api_history)
    app.router.add_get("/ws/client", ws_client_handler)
    app.router.add_get("/ws/phone/{session_id}", ws_phone_handler)
    app.router.add_static("/static/", STATIC_DIR)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=HOST, port=PORT)
