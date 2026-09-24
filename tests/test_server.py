"""Run: python3 -m unittest discover -s tests -v   (from remote/)

Lives outside server/ on purpose: the daemon's deploy-watch rsyncs server/
to the VPS on every change, and tests have no business shipping there or
restarting production on every edit.
"""
import asyncio
import itertools
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

    def test_resync_without_overlap_replaces_what_the_tail_describes(self):
        # A tail with no alignment means every turn it describes has
        # changed. It still describes the last len(incoming) turns of the
        # live DOM, so it belongs there — appending would show both the
        # stale and the current copy.
        st = self.make(["old1", "old2"])
        st.apply_resync(["new1", "new2"])
        self.assertEqual(st.turns, ["new1", "new2"])

    def test_resync_without_overlap_keeps_history_the_tail_cannot_reach(self):
        st = self.make(["keep1", "keep2", "old"])
        st.apply_resync(["new"])
        self.assertEqual(
            st.turns,
            ["keep1", "keep2", "new"],
            "a one-turn tail rewrites one turn, never the history behind it",
        )

    def test_a_streaming_first_exchange_does_not_accumulate_snapshots(self):
        # A new session's first exchange is a single turn that grows as the
        # reply streams. incoming[0] is therefore the turn being edited and
        # never matches what is stored; appending on that basis showed the
        # same reply once per poll tick.
        st = self.make()
        for snapshot in ["<t>partial</t>", "<t>partly done</t>", "<t>complete</t>"]:
            st.apply_resync([snapshot])
        self.assertEqual(st.turns, ["<t>complete</t>"])

    def test_resync_onto_empty_history_seeds_it(self):
        st = self.make()
        st.apply_resync(["a", "b"])
        self.assertEqual(st.turns, ["a", "b"])

    def test_resync_uses_the_latest_overlap_when_a_turn_repeats(self):
        st = self.make(["dup", "x", "dup", "y"])
        st.apply_resync(["dup", "z"])
        self.assertEqual(st.turns, ["dup", "x", "dup", "z"], "splices at the last match")

    def test_resync_tie_break_prefers_the_later_of_two_equal_overlaps(self):
        """The case above does not reach the tie-break: `earliest` leaves
        only one candidate position, so the bound satisfies it and
        `run >= best_run` does no work. Here two positions score the same
        run and the earlier one deletes a stored turn — F2.1's direction."""
        st = self.make(["A", "A"])
        st.apply_resync(["A", "B"])
        self.assertEqual(st.turns, ["A", "A", "B"], "the later overlap keeps both stored turns")

    def test_resync_tie_break_over_every_repeat_pattern(self):
        """The smallest case above is one of many. Enumerated, because the
        brute-force invariants nearby cannot see this: preferring the
        earlier position loses a turn by replacement, so the result is
        still the right length and still ends with the tail."""
        alphabet = "AB"
        disagreements = 0
        for stored_len in range(1, 5):
            for tail_len in range(1, 4):
                for stored in itertools.product(alphabet, repeat=stored_len):
                    for tail in itertools.product(alphabet, repeat=tail_len):
                        st = self.make(list(stored))
                        st.apply_resync(list(tail))
                        # The invariant the tie-break exists to keep: a
                        # resync never shortens the stored history.
                        self.assertGreaterEqual(
                            len(st.turns), stored_len,
                            f"stored={stored} tail={tail} lost a turn",
                        )
                        self.assertEqual(
                            st.turns[-len(tail):], list(tail),
                            f"stored={stored} tail={tail} does not end with the tail",
                        )
                        if len(st.turns) > stored_len:
                            disagreements += 1
        self.assertGreater(disagreements, 0, "the enumeration must reach the growing case")

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

    def test_a_short_resync_never_splices_away_stored_turns(self):
        # A tail of N turns can only account for N stored turns. Scoring a
        # match further back than that deletes a block the phone was
        # showing: [A,B,A,B,C] with the DOM virtualized down to [B,A]
        # matches at index 1 for two turns and at index 3 for one, and
        # taking index 1 drops the last two turns entirely.
        st = self.make(["A", "B", "A", "B", "C"])
        st.apply_resync(["B", "A"])
        self.assertEqual(st.turns, ["A", "B", "A", "B", "A"])

    def test_resync_never_shortens_stored_history(self):
        # The invariant behind the bound above, over the alphabet that
        # maximises identical turns.
        import itertools

        for sl in range(6):
            for il in range(1, 5):
                for stored in itertools.product("AB", repeat=sl):
                    for incoming in itertools.product("AB", repeat=il):
                        st = self.make(list(stored))
                        st.apply_resync(list(incoming))
                        self.assertGreaterEqual(
                            len(st.turns), len(stored),
                            f"{stored} + {incoming} lost a visible block -> {st.turns}",
                        )
                        self.assertEqual(
                            st.turns[-il:], list(incoming),
                            f"{stored} + {incoming} -> {st.turns} does not end at what was sent",
                        )

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



class MinimalStreamingTailTests(IsolatedState):
    """The daemon sends only the changed final turn while a reply streams.
    The server has to place a one-turn tail correctly with no content
    overlap to guide it — the length bound is what makes that work."""

    def make(self, turns):
        st = server.SessionState("s1")
        st.turns = list(turns)
        return st

    def test_a_one_turn_tail_replaces_only_the_last_turn(self):
        st = self.make(["A", "B", "C-partial"])
        st.apply_resync(["C-complete"])
        self.assertEqual(st.turns, ["A", "B", "C-complete"])

    def test_repeated_one_turn_tails_do_not_accumulate(self):
        st = self.make(["A", "B"])
        for snapshot in ["c1", "c2", "c3"]:
            st.apply_resync([snapshot])
        self.assertEqual(st.turns, ["A", "c3"], "each tick replaces, never appends")

    def test_a_one_turn_tail_matching_an_older_turn_still_lands_last(self):
        # The reason the daemon restricts the shortcut to one turn: the
        # scan range is a single slot, so an accidental match further back
        # cannot be chosen.
        st = self.make(["dup", "x", "y"])
        st.apply_resync(["dup"])
        self.assertEqual(st.turns, ["dup", "x", "dup"])


class CdpStateTests(AioHTTPTestCase, IsolatedState):
    """An empty session list has three different causes and the phone has
    to tell them apart: the laptop is unreachable, VS Code is not running,
    or VS Code is running with no Claude Code tabs."""

    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)
        server.client_ws = None
        server.client_authed = False
        self.addCleanup(lambda: setattr(server, "client_ws", None))
        self.addCleanup(lambda: setattr(server, "client_authed", False))

    async def daemon_answering(self, payload):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(ws.receive_json(), timeout=5)

        async def reply():
            req = await asyncio.wait_for(ws.receive_json(), timeout=5)
            await ws.send_json({"type": "sessions_result", "reqId": req["reqId"], **payload})

        return ws, asyncio.create_task(reply())

    async def test_no_daemon_is_reported_as_no_daemon(self):
        resp = await self.client.get("/api/sessions", headers=AUTH_HEADER)
        self.assertEqual(resp.status, 503)
        body = await resp.json()
        self.assertEqual(body["cdp"], "no-daemon")

    async def test_daemon_up_but_vscode_down_says_so(self):
        ws, task = await self.daemon_answering(
            {"sessions": [], "cdp": "unreachable", "cdpError": "ECONNREFUSED 127.0.0.1:9222"}
        )
        resp = await self.client.get("/api/sessions", headers=AUTH_HEADER)
        await task
        self.assertEqual(resp.status, 200, "the laptop is fine; this is not a server error")
        body = await resp.json()
        self.assertEqual(body["cdp"], "unreachable")
        self.assertIn("9222", body["cdpError"])
        self.assertEqual(body["sessions"], [])
        await ws.close()

    async def test_vscode_up_with_no_tabs_is_an_ordinary_empty_list(self):
        ws, task = await self.daemon_answering({"sessions": [], "cdp": "ok"})
        resp = await self.client.get("/api/sessions", headers=AUTH_HEADER)
        await task
        body = await resp.json()
        self.assertEqual(body["cdp"], "ok")
        self.assertEqual(body["sessions"], [])
        await ws.close()


class PingTests(AioHTTPTestCase, IsolatedState):
    """The daemon's own liveness probe. Protocol-level ping/pong is handled
    below its WebSocket API and never reaches its code, so a black-holed
    connection needs an answer the daemon can observe."""

    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)
        server.client_ws = None
        server.client_authed = False
        self.addCleanup(lambda: setattr(server, "client_ws", None))
        self.addCleanup(lambda: setattr(server, "client_authed", False))

    async def test_ping_is_answered_with_pong(self):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "hello", "token": TOKEN})
        self.assertEqual((await asyncio.wait_for(ws.receive_json(), timeout=5))["type"], "auth_ok")
        await ws.send_json({"type": "ping"})
        reply = await asyncio.wait_for(ws.receive_json(), timeout=5)
        self.assertEqual(reply, {"type": "pong"})
        await ws.close()

    async def test_ping_before_hello_is_ignored_like_any_other_traffic(self):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "ping"})
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(ws.receive_json(), timeout=0.3)
        await ws.close()


class PhonePingTests(AioHTTPTestCase, IsolatedState):
    """The phone needs the same liveness answer the daemon does: iOS
    suspends a backgrounded tab and the socket comes back reporting OPEN
    for a connection that is gone, which is why the first message after an
    idle period used to fail and the second one worked."""

    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)

    async def test_phone_ping_is_answered_with_pong(self):
        ws = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(ws.receive_json(), timeout=5)  # initial
        await ws.send_json({"type": "ping"})
        self.assertEqual(
            await asyncio.wait_for(ws.receive_json(), timeout=5), {"type": "pong"}
        )
        await ws.close()

    async def test_a_ping_does_not_disturb_the_session(self):
        st = server.get_session("s1")
        st.turns = ["<p>a</p>"]
        ws = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(ws.receive_json(), timeout=5)
        await ws.send_json({"type": "ping"})
        await asyncio.wait_for(ws.receive_json(), timeout=5)
        self.assertEqual(server.sessions["s1"].turns, ["<p>a</p>"])
        await ws.close()


class ActionRouteTests(AioHTTPTestCase, IsolatedState):
    """The phone-initiated actions: new session, list MCP, reconnect MCP.
    Each is a request/reply over the one daemon socket, routed by reqId
    the same way the session list is."""

    async def get_application(self):
        return server.make_app()

    def setUp(self):
        IsolatedState.setUp(self)
        AioHTTPTestCase.setUp(self)
        server.client_ws = None
        server.client_authed = False
        self.addCleanup(lambda: setattr(server, "client_ws", None))
        self.addCleanup(lambda: setattr(server, "client_authed", False))

    async def daemon_that_answers(self, reply):
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(ws.receive_json(), timeout=5)
        seen = {}

        async def responder():
            req = await asyncio.wait_for(ws.receive_json(), timeout=5)
            seen.update(req)
            await ws.send_json({"type": "action_result", "reqId": req["reqId"], **reply})

        return ws, asyncio.create_task(responder()), seen

    async def test_new_session_forwards_the_prompt_and_returns_the_answer(self):
        ws, task, seen = await self.daemon_that_answers({"ok": True, "sessionId": "new-1"})
        resp = await self.client.post(
            "/api/new-session", json={"text": "hello there"}, headers=AUTH_HEADER
        )
        await task
        self.assertEqual(seen["type"], "new_session")
        self.assertEqual(seen["text"], "hello there")
        body = await resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["sessionId"], "new-1")
        await ws.close()

    async def test_a_slow_daemon_is_not_reported_as_an_absent_one(self):
        """`str(asyncio.TimeoutError())` is the empty string, so a timeout
        reached the phone with no reason and rendered as "Laptop not
        connected" — which sends the author to check the wrong thing."""
        self.assertEqual(str(asyncio.TimeoutError()), "")
        slow = server.describe_daemon_failure(asyncio.TimeoutError())
        absent = server.describe_daemon_failure(RuntimeError("daemon not connected"))
        self.assertIn("did not answer", slow)
        self.assertNotEqual(slow, absent)
        # And an exception that carries nothing still says something.
        self.assertTrue(server.describe_daemon_failure(RuntimeError()))

    async def test_the_sessions_route_uses_the_description_not_str(self):
        """Proving the helper is right proves nothing about the route that
        was rendering the empty string. Patched rather than waited out: the
        real path is a five-second timeout."""
        original = server.request_list_sessions

        async def times_out(*a, **kw):
            raise asyncio.TimeoutError()

        server.request_list_sessions = times_out
        self.addCleanup(lambda: setattr(server, "request_list_sessions", original))
        resp = await self.client.get("/api/sessions", headers=AUTH_HEADER)
        self.assertEqual(resp.status, 503)
        body = await resp.json()
        self.assertIn("did not answer", body["error"])

    async def test_the_action_route_uses_the_description_not_str(self):
        original = server.request_action

        async def times_out(*a, **kw):
            raise asyncio.TimeoutError()

        server.request_action = times_out
        self.addCleanup(lambda: setattr(server, "request_action", original))
        resp = await self.client.post("/api/mcp", json={}, headers=AUTH_HEADER)
        self.assertEqual(resp.status, 503)
        body = await resp.json()
        self.assertIn("did not answer", body["error"])

    async def test_submit_ack_goes_to_the_tab_that_submitted(self):
        """submit_ack carries nothing to correlate on. Broadcast, it makes a
        second tab clear its own pending send, report "send failed" and hand
        the text back — so the author sends the same message twice."""
        daemon = await self.client.ws_connect("/ws/client")
        await daemon.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(daemon.receive_json(), timeout=5)

        a = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(a.receive_json(), timeout=5)  # initial
        b = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(b.receive_json(), timeout=5)

        await b.send_json({"type": "submit", "text": "from b"})
        # Drain the daemon's view of it so ordering is unambiguous.
        while True:
            frame = await asyncio.wait_for(daemon.receive_json(), timeout=5)
            if frame.get("type") == "submit":
                break
        await daemon.send_json(
            {"type": "submit_ack", "sessionId": "s1", "ok": False, "error": "busy"}
        )

        got = await asyncio.wait_for(b.receive_json(), timeout=5)
        self.assertEqual(got["type"], "submit_ack")
        self.assertFalse(got["ok"])
        # A must not have been told anything about a message it did not send.
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(a.receive_json(), timeout=0.3)
        await a.close()
        await b.close()
        await daemon.close()

    async def test_the_daemons_error_and_recovery_frames_reach_the_phone(self):
        """The phone proving it renders these says nothing about the server
        forwarding them, and they are the frames whose only purpose is to
        reach a person: the once-per-outage attach failure, the DOM-mismatch
        warning, and the recovery that retracts them."""
        daemon = await self.client.ws_connect("/ws/client")
        await daemon.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(daemon.receive_json(), timeout=5)

        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial

        await daemon.send_json(
            {"type": "error", "sessionId": "s1", "message": 'No target matched "x"'}
        )
        got = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(got["type"], "error")
        self.assertEqual(got["message"], 'No target matched "x"')

        await daemon.send_json({"type": "recovered", "sessionId": "s1"})
        got = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(got["type"], "recovered")

        # And a frame for a session nobody is watching is not an error.
        await daemon.send_json({"type": "error", "sessionId": "nobody", "message": "x"})
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(phone.receive_json(), timeout=0.3)
        await phone.close()
        await daemon.close()

    async def test_the_phone_is_told_when_the_laptop_goes_away(self):
        """The phone's own liveness ping only proves the VPS is up. Without
        this frame the transcript simply stops moving and nothing says why."""
        daemon = await self.client.ws_connect("/ws/client")
        await daemon.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(daemon.receive_json(), timeout=5)

        phone = await self.client.ws_connect("/ws/phone/s1", headers=AUTH_HEADER)
        await asyncio.wait_for(phone.receive_json(), timeout=5)  # initial

        await daemon.close()
        frame = await asyncio.wait_for(phone.receive_json(), timeout=5)
        self.assertEqual(frame["type"], "laptop")
        self.assertFalse(frame["connected"])

        # And when it comes back.
        again = await self.client.ws_connect("/ws/client")
        await again.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(again.receive_json(), timeout=5)
        while True:
            frame = await asyncio.wait_for(phone.receive_json(), timeout=5)
            if frame.get("type") == "laptop":
                break
        self.assertTrue(frame["connected"])
        await phone.close()
        await again.close()

    async def test_two_actions_in_flight_each_get_their_own_answer(self):
        """reqId is what routes a reply, and with one request outstanding
        any pop at all looks correct. Replying out of order is the only
        arrangement that tells the difference."""
        ws = await self.client.ws_connect("/ws/client")
        await ws.send_json({"type": "hello", "token": TOKEN})
        await asyncio.wait_for(ws.receive_json(), timeout=5)

        first = asyncio.create_task(
            self.client.post("/api/new-session", json={"text": "one"}, headers=AUTH_HEADER)
        )
        req_one = await asyncio.wait_for(ws.receive_json(), timeout=5)
        second = asyncio.create_task(
            self.client.post("/api/new-session", json={"text": "two"}, headers=AUTH_HEADER)
        )
        req_two = await asyncio.wait_for(ws.receive_json(), timeout=5)

        self.assertEqual(req_one["text"], "one")
        self.assertEqual(req_two["text"], "two")
        self.assertNotEqual(req_one["reqId"], req_two["reqId"])

        # Reverse order: the second request is answered first.
        await ws.send_json(
            {"type": "action_result", "reqId": req_two["reqId"], "ok": True, "sessionId": "for-two"}
        )
        await ws.send_json(
            {"type": "action_result", "reqId": req_one["reqId"], "ok": True, "sessionId": "for-one"}
        )

        body_one = await (await asyncio.wait_for(first, timeout=5)).json()
        body_two = await (await asyncio.wait_for(second, timeout=5)).json()
        self.assertEqual(body_one["sessionId"], "for-one")
        self.assertEqual(body_two["sessionId"], "for-two")
        await ws.close()

    async def test_a_failed_action_is_200_with_the_reason(self):
        # The laptop answered; what it said is the useful part. A 5xx here
        # would read as the VPS being broken.
        ws, task, _ = await self.daemon_that_answers(
            {"ok": False, "error": "the Claude Code panel is not open"}
        )
        resp = await self.client.post("/api/new-session", json={"text": "x"}, headers=AUTH_HEADER)
        await task
        self.assertEqual(resp.status, 200)
        body = await resp.json()
        self.assertFalse(body["ok"])
        self.assertIn("panel", body["error"])
        await ws.close()

    async def test_reconnect_carries_the_server_name(self):
        ws, task, seen = await self.daemon_that_answers({"ok": True, "status": "reconnected"})
        await self.client.post(
            "/api/mcp/reconnect", json={"serverName": "jira-ghe"}, headers=AUTH_HEADER
        )
        await task
        self.assertEqual(seen["type"], "reconnect_mcp")
        self.assertEqual(seen["serverName"], "jira-ghe")
        await ws.close()

    async def test_list_mcp_returns_the_servers(self):
        ws, task, _ = await self.daemon_that_answers(
            {"ok": True, "servers": [{"name": "jira-ghe", "status": "Failed"}]}
        )
        resp = await self.client.post("/api/mcp", json={}, headers=AUTH_HEADER)
        await task
        body = await resp.json()
        self.assertEqual(body["servers"], [{"name": "jira-ghe", "status": "Failed"}])
        await ws.close()

    async def test_no_daemon_is_503_not_a_hang(self):
        resp = await self.client.post("/api/mcp", json={}, headers=AUTH_HEADER)
        self.assertEqual(resp.status, 503)
        self.assertFalse((await resp.json())["ok"])

    async def test_actions_require_auth(self):
        for path in ("/api/new-session", "/api/mcp", "/api/mcp/reconnect"):
            with self.subTest(path=path):
                resp = await self.client.post(path, json={}, allow_redirects=False)
                self.assertEqual(resp.status, 302)

if __name__ == "__main__":
    unittest.main()
