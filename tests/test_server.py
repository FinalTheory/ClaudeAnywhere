"""Run: python3 -m unittest discover -s tests -v   (from remote/)

Lives outside server/ on purpose: the daemon's deploy-watch rsyncs server/
to the VPS on every change, and tests have no business shipping there or
restarting production on every edit.
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

# server.py reads AUTH_TOKEN at import and exits without it. Set it before
# the import, not in setUp.
os.environ.setdefault("AUTH_TOKEN", "test-token")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import server  # noqa: E402

from aiohttp.test_utils import AioHTTPTestCase  # noqa: E402
from aiohttp import WSMsgType  # noqa: E402

TOKEN = "test-token"
AUTH_HEADER = {"Authorization": f"Bearer {TOKEN}"}


class IsolatedState(unittest.TestCase):
    """Base: every test gets an empty session table and its own data dir,
    so nothing touches the real one next to server.py."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._orig_data_dir = server.DATA_DIR
        server.DATA_DIR = Path(self._tmp.name)
        self.addCleanup(lambda: setattr(server, "DATA_DIR", self._orig_data_dir))
        self._orig_sessions = server.sessions
        server.sessions = {}
        self.addCleanup(lambda: setattr(server, "sessions", self._orig_sessions))


# --- tail_window: every phone-facing slice goes through this -------------


class TailWindowTests(unittest.TestCase):
    def test_empty_list_returns_nothing_at_index_zero(self):
        turns, start = server.tail_window([], 100)
        self.assertEqual(turns, [])
        self.assertEqual(start, 0, "start must be a usable cursor even when empty")

    def test_stops_once_the_budget_is_covered(self):
        turns = ["a" * 10, "b" * 10, "c" * 10]
        got, start = server.tail_window(turns, 15)
        self.assertEqual(got, ["b" * 10, "c" * 10])
        self.assertEqual(start, 1)

    def test_start_index_points_at_the_first_returned_turn(self):
        turns = [f"t{i}" for i in range(10)]
        got, start = server.tail_window(turns, 5)
        self.assertEqual(turns[start:], got, "turns[start:] must reproduce the window exactly")

    def test_a_single_oversized_turn_is_still_returned(self):
        # Otherwise a long message would render as a blank session forever:
        # the cap must never win over making progress.
        turns = ["x" * 10_000]
        got, start = server.tail_window(turns, 10)
        self.assertEqual(got, turns)
        self.assertEqual(start, 0)

    def test_budget_larger_than_history_returns_everything(self):
        turns = ["a", "b"]
        got, start = server.tail_window(turns, 10_000)
        self.assertEqual(got, turns)
        self.assertEqual(start, 0)

    def test_boundary_exactly_at_budget(self):
        turns = ["12345", "67890"]
        got, start = server.tail_window(turns, 5)
        self.assertEqual(got, ["67890"], "one turn already meets the budget")
        self.assertEqual(start, 1)


# --- SessionState: the accumulation and reconciliation rules -------------


class SessionStateTests(IsolatedState):
    def make(self, turns=None):
        st = server.SessionState("s1")
        if turns:
            st.turns = list(turns)
        return st

    def test_append_extends_and_persists(self):
        st = self.make(["a"])
        st.apply_append(["b", "c"])
        self.assertEqual(st.turns, ["a", "b", "c"])
        saved = json.loads((server.DATA_DIR / "s1.json").read_text())
        self.assertEqual(saved["turns"], ["a", "b", "c"])

    def test_cap_drops_whole_turns_from_the_front(self):
        orig = server.MAX_SESSION_BYTES
        server.MAX_SESSION_BYTES = 10
        self.addCleanup(lambda: setattr(server, "MAX_SESSION_BYTES", orig))
        st = self.make()
        st.apply_append(["aaaaa", "bbbbb", "ccccc"])
        self.assertEqual(st.turns, ["bbbbb", "ccccc"], "oldest whole turn dropped")
        for t in st.turns:
            self.assertEqual(len(t), 5, "a turn is never truncated mid-string")

    def test_cap_never_empties_the_session(self):
        orig = server.MAX_SESSION_BYTES
        server.MAX_SESSION_BYTES = 1
        self.addCleanup(lambda: setattr(server, "MAX_SESSION_BYTES", orig))
        st = self.make()
        st.apply_append(["a" * 100])
        self.assertEqual(len(st.turns), 1, "the newest turn survives any cap")

    def test_resync_splices_at_the_content_overlap(self):
        # The daemon restarted and re-sent a capped tail. The overlap point
        # is what stops history the daemon can no longer see from being
        # destroyed, and stops the tail being appended as if it were new.
        st = self.make(["t1", "t2", "t3"])
        st.apply_resync(["t2", "t3-updated", "t4"])
        self.assertEqual(st.turns, ["t1", "t2", "t3-updated", "t4"])

    def test_resync_without_overlap_appends_rather_than_discarding(self):
        st = self.make(["old1", "old2"])
        st.apply_resync(["new1", "new2"])
        self.assertEqual(
            st.turns,
            ["old1", "old2", "new1", "new2"],
            "prior history is kept when no splice point can be found",
        )

    def test_resync_onto_empty_history_seeds_it(self):
        st = self.make()
        st.apply_resync(["a", "b"])
        self.assertEqual(st.turns, ["a", "b"])

    def test_resync_uses_the_latest_overlap_when_a_turn_repeats(self):
        st = self.make(["dup", "x", "dup", "y"])
        st.apply_resync(["dup", "z"])
        self.assertEqual(st.turns, ["dup", "x", "dup", "z"], "splices at the last match")

    def test_resync_with_no_turns_is_a_noop(self):
        st = self.make(["a"])
        st.apply_resync([])
        self.assertEqual(st.turns, ["a"])

    def test_identical_resync_is_idempotent(self):
        st = self.make(["a", "b"])
        st.apply_resync(["a", "b"])
        st.apply_resync(["a", "b"])
        self.assertEqual(st.turns, ["a", "b"], "re-sending the same tail must not duplicate it")

    def test_identical_resync_is_idempotent_when_a_turn_repeats(self):
        # Short messages ("ok", "测试") render to byte-identical HTML, so a
        # repeated turn is ordinary. Splicing at the first matching turn
        # instead of the best-matching run duplicates a whole block on the
        # phone every time the daemon reconnects.
        st = self.make(["A", "B", "A", "C"])
        st.apply_resync(["A", "B", "A", "C"])
        self.assertEqual(st.turns, ["A", "B", "A", "C"])

    def test_state_and_load_round_trip(self):
        st = self.make(["a"])
        st.apply_state(True)
        reloaded = server.SessionState("s1")
        reloaded.load()
        self.assertEqual(reloaded.turns, ["a"])
        self.assertIs(reloaded.running, True)

    def test_load_tolerates_a_corrupt_file(self):
        (server.DATA_DIR / "s1.json").write_text("{not json")
        st = server.SessionState("s1")
        st.load()  # must not raise
        self.assertEqual(st.turns, [])


# --- cookie auth ----------------------------------------------------------


class CookieAuthTests(unittest.TestCase):
    def test_a_fresh_cookie_verifies(self):
        self.assertTrue(server._verify_cookie(server._sign(int(time.time()) + 60)))

    def test_an_expired_cookie_does_not(self):
        self.assertFalse(server._verify_cookie(server._sign(int(time.time()) - 1)))

    def test_a_tampered_expiry_does_not_verify(self):
        value = server._sign(int(time.time()) + 60)
        _, mac = value.split(".", 1)
        forged = f"{int(time.time()) + 999999}.{mac}"
        self.assertFalse(server._verify_cookie(forged), "the mac covers the expiry")

    def test_a_tampered_mac_does_not_verify(self):
        value = server._sign(int(time.time()) + 60)
        expiry, mac = value.split(".", 1)
        self.assertFalse(server._verify_cookie(f"{expiry}.{'0' * len(mac)}"))

    def test_malformed_values_are_rejected_not_crashed(self):
        for bad in ["", "nodot", ".", "abc.def", "12x.deadbeef"]:
            with self.subTest(bad=bad):
                self.assertFalse(server._verify_cookie(bad))


# --- stale-session sweep --------------------------------------------------


class SweepTests(IsolatedState):
    def add(self, sid, age_seconds, viewers=0):
        st = server.SessionState(sid)
        st.turns = ["x"]
        st.last_seen = time.time() - age_seconds
        st.phone_sockets = {object() for _ in range(viewers)}
        st.save()
        server.sessions[sid] = st
        return st

    def test_removes_sessions_past_the_ttl(self):
        self.add("old", server.SESSION_TTL_SECONDS + 60)
        removed = server._sweep_stale_sessions()
        self.assertEqual(removed, 1)
        self.assertNotIn("old", server.sessions)
        self.assertFalse((server.DATA_DIR / "old.json").exists(), "the file goes too")

    def test_keeps_recent_sessions(self):
        self.add("fresh", 60)
        self.assertEqual(server._sweep_stale_sessions(), 0)
        self.assertIn("fresh", server.sessions)

    def test_keeps_a_stale_session_someone_is_watching(self):
        self.add("watched", server.SESSION_TTL_SECONDS + 60, viewers=1)
        self.assertEqual(server._sweep_stale_sessions(), 0)
        self.assertIn("watched", server.sessions)

    def test_boundary_just_inside_the_ttl_is_kept(self):
        self.add("edge", server.SESSION_TTL_SECONDS - 5)
        self.assertEqual(server._sweep_stale_sessions(), 0)


# --- HTTP surface ---------------------------------------------------------


class HttpTests(AioHTTPTestCase, IsolatedState):
    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)

    async def test_healthz_is_public_and_reports_state(self):
        resp = await self.client.get("/healthz")
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertEqual(body["status"], "ok")
        self.assertIn("uptime_seconds", body)
        self.assertIs(body["client_connected"], False, "no daemon attached in this test")

    async def test_root_without_auth_redirects_to_login(self):
        resp = await self.client.get("/", allow_redirects=False)
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.headers["Location"], "/login")

    async def test_root_with_bearer_serves_the_app(self):
        resp = await self.client.get("/", headers=AUTH_HEADER)
        self.assertEqual(resp.status, 200)
        self.assertIn("session-list", await resp.text())

    async def test_root_with_a_wrong_bearer_is_not_authed(self):
        resp = await self.client.get(
            "/", headers={"Authorization": "Bearer wrong"}, allow_redirects=False
        )
        self.assertEqual(resp.status, 302)

    async def test_login_with_the_right_password_sets_a_cookie(self):
        resp = await self.client.post(
            "/login", data={"password": TOKEN}, allow_redirects=False
        )
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.headers["Location"], "/", "a good password must open the app")
        self.assertIn(server.COOKIE_NAME, resp.cookies)
        cookie = resp.cookies[server.COOKIE_NAME]
        self.assertTrue(server._verify_cookie(cookie.value))
        self.assertTrue(cookie["httponly"], "the auth cookie must not be script-readable")

    async def test_login_with_a_wrong_password_sets_no_cookie(self):
        resp = await self.client.post(
            "/login", data={"password": "nope"}, allow_redirects=False
        )
        self.assertEqual(resp.status, 200)
        self.assertNotIn(server.COOKIE_NAME, resp.cookies)
        self.assertIn("Wrong password", await resp.text())

    async def test_api_sessions_without_a_daemon_is_503_not_a_hang(self):
        resp = await self.client.get("/api/sessions", headers=AUTH_HEADER)
        self.assertEqual(resp.status, 503)
        body = await resp.json()
        self.assertEqual(body["sessions"], [])
        self.assertIn("error", body)

    async def test_history_for_an_unknown_session_is_empty_not_404(self):
        resp = await self.client.get("/api/session/nope/history", headers=AUTH_HEADER)
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertEqual(body["turns"], [])
        self.assertIs(body["has_more"], False)

    async def test_history_paginates_backwards_and_terminates(self):
        st = server.get_session("s1")
        st.turns = [f"<div>turn {i}</div>" for i in range(10)]

        first = await self.client.get(
            "/api/session/s1/history?before_index=10&limit_bytes=1", headers=AUTH_HEADER
        )
        page1 = await first.json()
        self.assertEqual(page1["turns"], [st.turns[9]])
        self.assertEqual(page1["start_index"], 9)
        self.assertIs(page1["has_more"], True)

        # Walk the cursor to the very beginning; it must reach 0 and stop.
        cursor, seen, guard = page1["start_index"], list(page1["turns"]), 0
        while cursor > 0:
            guard += 1
            self.assertLess(guard, 50, "pagination is not terminating")
            resp = await self.client.get(
                f"/api/session/s1/history?before_index={cursor}&limit_bytes=1",
                headers=AUTH_HEADER,
            )
            page = await resp.json()
            self.assertTrue(page["turns"], "a non-zero cursor must yield turns")
            self.assertLess(page["start_index"], cursor, "the cursor must move")
            seen = page["turns"] + seen
            cursor = page["start_index"]
        self.assertEqual(seen, st.turns, "walking the cursor reproduces the history exactly")

    async def test_history_requires_auth(self):
        resp = await self.client.get("/api/session/s1/history", allow_redirects=False)
        self.assertEqual(resp.status, 302)

    async def test_phone_ws_requires_auth(self):
        with self.assertRaises(Exception):
            await self.client.ws_connect("/ws/phone/s1")


# --- WebSocket flows ------------------------------------------------------


class WsFlowTests(AioHTTPTestCase, IsolatedState):
    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)
        server.client_ws = None
        server.client_authed = False
        self.addCleanup(lambda: setattr(server, "client_ws", None))
        self.addCleanup(lambda: setattr(server, "client_authed", False))

    async def connect_daemon(self, token=TOKEN):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "hello", "token": token})
        reply = await asyncio.wait_for(ws.receive_json(), timeout=5)
        return ws, reply

    async def test_daemon_hello_with_the_right_token_is_accepted(self):
        ws, reply = await self.connect_daemon()
        self.assertEqual(reply["type"], "auth_ok")
        await ws.close()

    async def test_daemon_hello_with_a_wrong_token_is_rejected_and_closed(self):
        ws, reply = await self.connect_daemon(token="wrong")
        self.assertEqual(reply["type"], "auth_failed")
        msg = await asyncio.wait_for(ws.receive(), timeout=5)
        self.assertIn(msg.type, (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING))
        await ws.close()

    async def test_opening_a_phone_view_subscribes_the_daemon_and_sends_initial(self):
        daemon, _ = await self.connect_daemon()
        st = server.get_session("s1")
        st.turns = ["<div>a</div>", "<div>b</div>"]

        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        sub = await asyncio.wait_for(daemon.receive_json(), timeout=5)
        self.assertEqual(sub, {"type": "subscribe", "sessionId": "s1"})

        initial = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(initial["type"], "initial")
        self.assertEqual(initial["turns"], st.turns)
        self.assertEqual(initial["startIndex"], 0)

        await phone.close()
        unsub = await asyncio.wait_for(daemon.receive_json(), timeout=5)
        self.assertEqual(unsub, {"type": "unsubscribe", "sessionId": "s1"})
        await daemon.close()

    async def test_daemon_append_reaches_the_phone_and_the_store(self):
        daemon, _ = await self.connect_daemon()
        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial
        await asyncio.wait_for(daemon.receive_json(), timeout=5)  # subscribe

        await daemon.send_json({"type": "append", "sessionId": "s1", "turns": ["<p>new</p>"]})
        got = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(got, {"type": "append", "turns": ["<p>new</p>"]})
        self.assertEqual(server.sessions["s1"].turns, ["<p>new</p>"])
        await phone.close()
        await daemon.close()

    async def test_a_resync_reaching_the_phone_is_capped_to_the_initial_window(self):
        # The whole point of the lazy-load design: the phone must not be
        # handed the full history just because the daemon resynced.
        daemon, _ = await self.connect_daemon()
        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial
        await asyncio.wait_for(daemon.receive_json(), timeout=5)  # subscribe

        big = [f"<div>{'x' * 500} {i}</div>" for i in range(20)]
        await daemon.send_json({"type": "resync", "sessionId": "s1", "turns": big})
        got = await asyncio.wait_for(phone.receive_json(), timeout=5)

        self.assertEqual(got["type"], "resync")
        self.assertEqual(server.sessions["s1"].turns, big, "the store keeps everything")
        self.assertTrue(got["turns"], "an empty window would blank the phone's transcript")
        self.assertEqual(got["turns"][-1], big[-1], "the window must end at the newest turn")
        self.assertLess(len(got["turns"]), len(big), "the phone gets only a tail window")
        self.assertEqual(
            got["turns"], big[got["startIndex"]:], "startIndex must locate the window sent"
        )

    async def test_submit_with_no_daemon_tells_the_phone_instead_of_vanishing(self):
        # The failure that looked like "my message just disappeared":
        # send_to_client returns False silently when the daemon is gone.
        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial
        await phone.send_json({"type": "submit", "text": "hello"})
        ack = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(ack["type"], "submit_ack")
        self.assertIs(ack["ok"], False)
        self.assertIn("not connected", ack["error"])
        await phone.close()

    async def test_submit_reaches_the_daemon_when_connected(self):
        daemon, _ = await self.connect_daemon()
        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial
        await asyncio.wait_for(daemon.receive_json(), timeout=5)  # subscribe

        await phone.send_json({"type": "submit", "text": "line1\nline2"})
        got = await asyncio.wait_for(daemon.receive_json(), timeout=5)
        self.assertEqual(
            got, {"type": "submit", "sessionId": "s1", "text": "line1\nline2"}
        )
        await phone.close()
        await daemon.close()

    async def test_a_reconnecting_daemon_is_resubscribed_to_watched_sessions(self):
        # Otherwise a daemon restart leaves an open phone view silently dead.
        daemon1, _ = await self.connect_daemon()
        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial
        await asyncio.wait_for(daemon1.receive_json(), timeout=5)  # subscribe
        await daemon1.close()

        daemon2 = await self.client.ws_connect("/ws/client")
        await daemon2.send_json({"type": "hello", "token": TOKEN})
        self.assertEqual((await asyncio.wait_for(daemon2.receive_json(), timeout=5))["type"], "auth_ok")
        resub = await asyncio.wait_for(daemon2.receive_json(), timeout=5)
        self.assertEqual(resub, {"type": "subscribe", "sessionId": "s1"})
        await phone.close()
        await daemon2.close()

    async def test_daemon_traffic_before_hello_is_ignored(self):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "append", "sessionId": "s1", "turns": ["<p>x</p>"]})
        await asyncio.sleep(0.1)
        self.assertNotIn("s1", server.sessions, "unauthenticated writes must not land")
        await ws.close()


if __name__ == "__main__":
    unittest.main()
