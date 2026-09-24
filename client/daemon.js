#!/usr/bin/env node
// Client daemon: bridges local CDP (VS Code / Claude Code webviews) to a VPS
// relay server over one persistent outbound WebSocket. Zero npm dependencies
// — uses Node's native fetch/WebSocket, same as the rest of remote/. Run with
// `node --watch --env-file=.env daemon.js` (cp .env.example .env first) for
// auto-restart on save; reconnect-with-backoff on the VPS link makes that
// safe (see Daemon.connect below). `--env-file` is Node's own built-in flag
// (20.6+) — no dotenv package needed, consistent with zero npm deps here.
//
// Env vars (see .env.example):
//   VPS_WS_URL     required, e.g. wss://your-vps.example.com/ws/client
//   AUTH_TOKEN     required, shared secret — same value the VPS checks
//   CDP_PORT       default 9222
//   POLL_INTERVAL_MS  default 1500 — cadence for subscribed sessions only;
//                      unsubscribed sessions cost nothing between list calls
//   DEPLOY_TARGET     optional, e.g. user@vps.example.com:/opt/claude-remote/server
//                      — if set, also watches ../server and rsyncs it there
//                      on change, so one `node --watch` loop deploys both
//                      sides. Uses your own SSH key/agent, same as running
//                      rsync by hand — this process does nothing you
//                      couldn't do from a terminal yourself. Unset = skipped
//                      entirely, daemon runs standalone.
//   DEPLOY_WATCH_DIR  default ../server (relative to this file)
//   LOG_FILE          default daemon.log (relative to this file) — every
//                      console.error/console.log line also gets appended
//                      here with a timestamp, so logs are readable from
//                      inside the shared checkout (e.g. a devcontainer)
//                      without a terminal attached to wherever this process
//                      actually runs.
//
// Wire protocol (JSON text frames), client -> VPS. `turns` is always an
// array of complete per-message HTML fragments, never one flat string —
// see the POLL_EXPR comment for why that distinction is load-bearing.
//   {type:"hello", token}
//   {type:"sessions_result", reqId, sessions:[{sessionId, title, preview, running}],
//        cdp:"ok"|"unreachable", cdpError?}   // cdp says whether VS Code
//        // answered at all — an empty list means something different in
//        // each case, and the phone needs to say which
//   {type:"state", sessionId, running}
//   {type:"append", sessionId, turns}   // extend what the VPS has
//   {type:"resync", sessionId, turns}   // capped tail; VPS splices by content overlap
//   {type:"submit_ack", sessionId, ok, error?}
//   {type:"action_result", reqId, ok, error?, ...}  // reply to a
//        // phone-initiated new_session / list_mcp / reconnect_mcp
//   {type:"error", sessionId, message}
//
// VPS -> client:
//   {type:"auth_ok"} / {type:"auth_failed"}
//   {type:"list_sessions", reqId}
//   {type:"subscribe", sessionId}
//   {type:"unsubscribe", sessionId}
//   {type:"submit", sessionId, text}

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// Mirror console output to a file — see LOG_FILE in the header comment.
// Patches console.error/console.log globally rather than threading a logger
// through every call site; this file already treats console.error as its
// only diagnostic channel throughout, so this is a one-line hook, not a
// rewrite. Only installed when run as a program (see the bottom of this
// file): importing this module for tests must not create a log file.
const LOG_FILE = path.resolve(__dirname, process.env.LOG_FILE || 'daemon.log');
function installFileLogging() {
  for (const method of ['error', 'log']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      // Synchronous append, not a buffered WriteStream: this checkout is a
      // bind mount into a devcontainer, and a stream's internal buffering
      // combined with mount-layer caching meant log lines weren't visible on
      // the other side until well after they were "written". appendFileSync
      // forces the write syscall to actually complete before returning.
      try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
      } catch (e) {
        // never let logging itself take the process down
      }
    };
  }
}

// Held as a module object, not destructured: call sites go through `cdp.x`
// so a test can substitute one of these without the binding having been
// captured at require time. That seam is the only way submit()/attach()
// are reachable without a live Chrome.
const cdp = require('../cdp-client');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const VPS_WS_URL = process.env.VPS_WS_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);

const DEPLOY_TARGET = process.env.DEPLOY_TARGET;
const DEPLOY_WATCH_DIR = path.resolve(__dirname, process.env.DEPLOY_WATCH_DIR || '../server');
const DEPLOY_DEBOUNCE_MS = 400; // never needed tuning in practice

function requireEnv() {
  if (!VPS_WS_URL || !AUTH_TOKEN) {
    console.error('Set VPS_WS_URL and AUTH_TOKEN env vars.');
    process.exit(1);
  }
}

// One combined probe per poll tick. The send button's aria-label flip
// ("Send message" vs "Stop") is the busy/idle signal — confirmed
// empirically, see detect-running-state.js and chat history; aria-busy and
// spinner-class heuristics did NOT change between idle/busy and are not used.
//
// Content is captured as an ARRAY of complete per-turn outerHTML strings
// (each `[class*="turn_"]` element), not one flat document.body.innerHTML
// string. This is load-bearing, not stylistic: a flat string sliced by byte
// offset (for the "only load ~2KB, lazy-load the rest" design) almost always
// cuts through the middle of some tag's nesting, producing malformed
// fragments — confirmed in practice once lazy-loading actually shipped.
// Each turn_ div is a complete, independently-valid top-level unit (siblings
// under messagesContainer_, never nested inside each other), so slicing by
// whole turns is always well-formed regardless of where the cut falls.
//
// The Claude Code session-picker/sidebar view is ALSO an
// extensionId=Anthropic.claude-code webview — same extension, different UI
// mode — so it's indistinguishable from a real chat by extensionId alone.
// Excluded in cdp-client.js's listClaudeSessions() via the URL's
// purpose=webviewView param (VS Code's own, objective designation for "this
// is a view, not an editor tab"). An earlier version of this file also
// text-matched a "window.IS_SESSION_LIST_ONLY = true" debug footer in
// innerHTML as a second signal — removed after it produced a false positive
// that silently dropped a real session from the list (a genuine chat whose
// footer apparently read the same way in some state). The URL check is the
// only one relied on now; a false negative there (missing sidebar exclusion)
// is a far cheaper failure mode than a false positive hiding real
// conversations.
const POLL_EXPR = `
(function() {
  const btn = document.querySelector('button[aria-label="Send message"], button[aria-label="Stop"]');
  const turns = Array.from(document.querySelectorAll('[class*="turn_"]')).map((el) => el.outerHTML);
  // turn_ is a CSS-module name: a semantic prefix plus a build hash. If a
  // Claude Code upgrade renames the prefix this selector quietly returns
  // nothing, which is indistinguishable from an empty conversation — a new
  // session looks blank and an existing one freezes on stored content,
  // with no error anywhere. The message blocks inside a turn carry
  // data-transcript-message, which is markup rather than a build artifact,
  // so "messages exist but no turns" is a reliable tell that the turn
  // selector, not the conversation, is what went missing.
  const messageCount = document.querySelectorAll('[data-transcript-message]').length;
  return {
    running: btn ? btn.getAttribute('aria-label') === 'Stop' : null,
    turns,
    domMismatch: turns.length === 0 && messageCount > 0 ? messageCount : 0,
    // Claude's own session uuid for this conversation, the join to the
    // names in the sidebar (see readSessionNames in cdp-client.js).
    // Absent on some webviews — one of four lacked it when this was
    // measured — so it is a nicety, never load-bearing for addressing.
    sessionUuid: (function () {
      const el = document.querySelector('[data-initial-session]');
      return el ? el.getAttribute('data-initial-session') : null;
    })()
  };
})()
`;

function injectExpr(text) {
  return `
(function(text) {
  const candidates = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
  if (candidates.length === 0) return { ok: false, reason: 'no input candidates found' };
  const el = candidates[candidates.length - 1];
  el.focus();
  // execCommand returns false when the command is unsupported or refused.
  // Discarding that made submit() answer ok for text that never landed,
  // so the phone cleared the composer and reported success. It is
  // deprecated, and CDP's Input.insertText is the durable replacement —
  // untried here because it cannot be verified without a live target.
  if (!document.execCommand('insertText', false, text)) {
    return { ok: false, reason: 'execCommand(insertText) was refused by the editor' };
  }
  return { ok: true };
})(${JSON.stringify(text)})
`;
}

// --- driving Claude Code's own UI ----------------------------------------
// Everything below clicks real controls in the webview, because the thing
// they trigger has no other entry point: `mcp_reconnect` is an Agent SDK
// control request carried over the anonymous socketpair between the VS
// Code extension host and that session's CLI process, and nothing outside
// that pipe can send it — not the CLI (`claude mcp` has no reconnect), not
// the extension's command palette (no MCP command is registered), not the
// IDE's own WebSocket RPC (its twelve tools are all editor operations).
//
// Class names are CSS-module hashed, so every selector matches on the
// semantic prefix and the visible text, neither of which moves with a
// build. The rule throughout: identify, verify, then act. `dangerButton_`
// carries "Remove" and "Clear authentication" in the same row as
// "Reconnect", so a click that lands on the wrong control is far worse
// than one that does not happen.

const q = (sel) => `[class*="${sel}"]`;

// Where the MCP panel currently is, if it is anywhere.
const MCP_STATE_EXPR = `
(function () {
  const t = (el) => (el ? (el.textContent || '').trim() : null);
  const detail = document.querySelector('[class*="detailTitle_"]');
  const rows = [...document.querySelectorAll('[class*="serverItem_"]')].map((el) => ({
    name: t(el.querySelector('[class*="serverName_"]')),
    status: t(el.querySelector('[class*="statusBadge_"]')),
  })).filter((r) => r.name);
  const menuOpen = !!document.querySelector('[class*="commandItem_"]');
  if (detail) return { panel: 'detail', title: t(detail), rows, menuOpen };
  if (rows.length) return { panel: 'list', title: null, rows, menuOpen };
  return { panel: 'none', title: null, rows: [], menuOpen };
})()
`;

// Click one control, named by prefix and exact visible text. Returns what
// it found so a caller can tell "not there yet" from "clicked".
function clickByText(prefix, text) {
  return `
(function () {
  const wanted = ${JSON.stringify(text)};
  const els = [...document.querySelectorAll('[class*="${prefix}"]')];
  const hit = els.find((el) => (el.textContent || '').trim() === wanted);
  if (!hit) return { ok: false, reason: 'not found', seen: els.map((e) => (e.textContent || '').trim()).slice(0, 12) };
  if (hit.disabled) return { ok: false, reason: 'disabled' };
  hit.click();
  return { ok: true };
})()
`;
}

// Like clickByText, but for controls whose visible text is an icon. The
// panel's close button renders as a glyph with the name only in
// aria-label, so matching on textContent never found it and the panel was
// left open on the laptop after every action.
function clickByName(prefix, name) {
  return `
(function () {
  const wanted = ${JSON.stringify(name)};
  const els = [...document.querySelectorAll('[class*="${prefix}"]')];
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  const hit = els.find((el) => nameOf(el) === wanted);
  if (!hit) return { ok: false, reason: 'not found', seen: els.map(nameOf).slice(0, 12) };
  if (hit.disabled) return { ok: false, reason: 'disabled' };
  hit.click();
  return { ok: true };
})()
`;
}

// The server rows are not buttons with matching text — the name is in a
// child — so this one matches on the child's text and clicks the row.
function clickServerRow(name) {
  return `
(function () {
  const wanted = ${JSON.stringify(name)};
  const rows = [...document.querySelectorAll('[class*="serverItem_"]')];
  const hit = rows.find((el) => {
    const n = el.querySelector('[class*="serverName_"]');
    return n && (n.textContent || '').trim() === wanted;
  });
  if (!hit) return { ok: false, reason: 'no such server', seen: rows.map((el) => (el.querySelector('[class*="serverName_"]')?.textContent || '').trim()) };
  hit.click();
  return { ok: true };
})()
`;
}

// Reconnect, but only after confirming the open detail view is the server
// that was asked for. "Remove" and "Clear authentication" sit in the same
// row; acting on the wrong one is unrecoverable from a phone.
function clickReconnectFor(name) {
  return `
(function () {
  const wanted = ${JSON.stringify(name)};
  const title = document.querySelector('[class*="detailTitle_"]');
  const shown = title && (title.textContent || '').trim();
  if (shown !== wanted) return { ok: false, reason: 'detail view shows ' + JSON.stringify(shown) + ', not ' + JSON.stringify(wanted) };
  const btn = [...document.querySelectorAll('[class*="actionButton_"]')]
    .find((el) => (el.textContent || '').trim() === 'Reconnect');
  if (!btn) return { ok: false, reason: 'no Reconnect button in this detail view' };
  if (btn.disabled) return { ok: false, reason: 'already reconnecting' };
  btn.click();
  return { ok: true };
})()
`;
}

// In flight while the button reads "Reconnecting…". Settled is not proof
// the server came back — the status badge is that — but proof the request
// finished rather than hanging.
const RECONNECT_BUSY_EXPR = `
(function () {
  const b = [...document.querySelectorAll('[class*="actionButton_"]')]
    .find((el) => (el.textContent || '').trim().startsWith('Reconnect'));
  const title = document.querySelector('[class*="detailTitle_"]');
  const badge = document.querySelector('[class*="statusBadge_"]');
  return {
    busy: !!b && (b.textContent || '').trim() === 'Reconnecting…',
    status: badge ? (badge.textContent || '').trim() : null,
    title: title ? (title.textContent || '').trim() : null,
  };
})()
`;

// Claude Code's sidebar (purpose=webviewView) owns the New session button.
const NEW_SESSION_EXPR = `
(function () {
  const btn = document.querySelector('[class*="newSessionButton_"]');
  if (!btn) return { ok: false, reason: 'no New session button — is the Claude Code panel open?' };
  btn.click();
  return { ok: true };
})()
`;

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// How many trailing turns a forced/fallback resync carries — the server
// reconciles this against its own stored history by content overlap, so
// this only needs to be "enough to find the overlap point", not the whole
// conversation. 50 is a generous margin over how many turns typically
// change/appear between poll ticks.
const MAX_RESYNC_TURNS = 50;

// Content updates are coalesced to at most one per this interval while a
// reply streams. Polling stays at POLL_INTERVAL_MS because the running/idle
// probe is cheap and should stay responsive; it is the turn HTML that is
// expensive to ship.
//
// Measured against a real session: a turn is 98KB and the largest is 284KB,
// so a poll-rate resync is ~240MB/hour to the phone. That is a phone on
// cellular holding its radio up continuously, and it buys sub-second
// latency on a reply nobody reads that fast.
//
// An append is never delayed — a new turn is the visible event, and it
// carries only the new turns rather than a snapshot.
const RESYNC_MIN_INTERVAL_MS = Number(process.env.RESYNC_MIN_INTERVAL_MS || 5000);

// Whether this poll's diff goes on the wire now or waits for the next one.
// Extracted for the same reason diffTurns was: it is the part with a
// judgment in it, and it decides how much a phone spends.
function shouldEmitNow(kind, { forced, becameIdle, msSinceResync }) {
  if (kind === 'none') return false;
  if (kind === 'append') return true;
  // A resync. Send at once when it is the first read of a subscription
  // (the server needs it to reconcile), or when the reply just finished —
  // waiting there would leave the last few tokens missing for seconds on
  // a session that has gone quiet.
  return forced || becameIdle || msSinceResync >= RESYNC_MIN_INTERVAL_MS;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The whole client-side wire decision, as a pure function of (what we last
// reported, what we see now, whether this is the first read after a fresh
// subscribe). Extracted from _tick so it can be tested without CDP: this is
// the logic that, when it was wrong, silently duplicated a whole
// conversation into the server's one persisted copy on every restart.
//
// Returns { kind: 'none' | 'append' | 'resync', turns } where `turns` is
// exactly what goes on the wire — a suffix for append, a capped tail for
// resync (the server reconciles that tail by content overlap, so it doesn't
// need the daemon's full history, just enough to find the splice point).
function diffTurns(lastTurns, turns, forceResync) {
  if (forceResync) {
    return { kind: 'resync', turns: turns.slice(-MAX_RESYNC_TURNS) };
  }
  if (arraysEqual(turns, lastTurns)) {
    return { kind: 'none', turns: [] };
  }
  if (arraysEqual(turns.slice(0, lastTurns.length), lastTurns)) {
    return { kind: 'append', turns: turns.slice(lastTurns.length) };
  }
  // Streaming: same turn count, only the final turn's HTML differs as
  // tokens arrive. The generic tail below would resend up to
  // MAX_RESYNC_TURNS turns to describe a change confined to one — measured
  // at 769KB per tick against a real session, every 1.5s, which is 1.9GB
  // an hour of a laptop uplink to say that one reply grew.
  //
  // One turn is enough for the server to place it: apply_resync scans no
  // earlier than len(stored) - len(incoming), so a one-turn tail can only
  // land on the last stored turn. Restricted to "exactly the last turn
  // differs" rather than "trim any common prefix" because a shorter tail
  // whose first turn coincidentally equals some older stored turn could
  // splice late and duplicate; with one turn the scan range is a single
  // slot and that cannot happen.
  if (
    turns.length === lastTurns.length &&
    turns.length > 0 &&
    arraysEqual(turns.slice(0, -1), lastTurns.slice(0, -1))
  ) {
    return { kind: 'resync', turns: turns.slice(-1) };
  }
  // Turn count went backward, or an earlier turn's content changed (VS Code
  // virtualized something out, or genuinely edited history) — not
  // expressible as a clean append, fall back to resync.
  return { kind: 'resync', turns: turns.slice(-MAX_RESYNC_TURNS) };
}

// Turn (webview id -> Claude session uuid) plus (uuid -> name) into
// (webview id -> title). Separate from the CDP plumbing so the one rule
// with judgment in it can be tested.
//
// A uuid claimed by two webviews is dropped rather than guessed at. The
// attribute is named `data-initial-session`, so if a webview can ever be
// reused for a second conversation its value would be stale, and a stale
// value shows up exactly as two webviews claiming one uuid. A missing
// title falls back to the session id, which is ugly; a wrong title names
// someone else's conversation, which is worse.
function resolveTitles(claims, names) {
  const claimants = new Map();
  for (const [, uuid] of claims) {
    if (!uuid) continue;
    claimants.set(uuid, (claimants.get(uuid) || 0) + 1);
  }
  const titles = new Map();
  for (const [sessionId, uuid] of claims) {
    const contested = uuid && claimants.get(uuid) > 1;
    titles.set(sessionId, !uuid || contested ? null : names[uuid] || null);
  }
  return titles;
}

// Cmd+Enter submits in this UI (confirmed empirically — plain Enter does
// not). modifiers bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.
const CMD_MODIFIER = 4;

async function dispatchEnter(client, modifiers) {
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers,
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter',
    unmodifiedText: '\r',
    text: '\r',
  });
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter',
  });
}

class SessionWatcher {
  constructor(sessionId, onEvent) {
    this.sessionId = sessionId;
    this.onEvent = onEvent; // (msg) => void — msg already shaped for the wire
    this.client = null;
    this.picked = null;
    this.lastTurns = [];
    this.lastRunning = null;
    this.lastSessionUuid = null;
    this.lastResyncAt = 0;
    this.reportedMismatch = false;
    this.attachFailed = false;
    this.timer = null;
    this.closed = false;
    // Every fresh subscribe (including after a daemon process restart, which
    // resets lastTurns to []) must report the first read as a resync, not a
    // diff. [] is a "prefix" of anything, so without this flag the
    // startsWith-equivalent check below would silently mislabel a full
    // snapshot as an "append" and the server would concatenate it onto
    // whatever it already had — duplicating content into its one persisted
    // copy on every restart instead of reconciling with it. (The server
    // reconciles by content-matching overlap now, not blind concatenation —
    // see SessionState.apply_resync in server.py — but the daemon still
    // needs to say resync vs append correctly so the server knows which
    // reconciliation strategy to use.)
    this.forceResyncNext = true;
  }

  async attach() {
    const target = await cdp.findTarget(CDP_PORT, this.sessionId);
    this.client = await cdp.connect(target);
    const frames = await cdp.getFrames(this.client);
    const picked = await cdp.pickContentFrame(this.client, frames);
    if (!picked) throw new Error('no content frame found (see scan-frames.js)');
    this.picked = picked;
  }

  async start() {
    try {
      await this.attach();
    } catch (err) {
      // Do not give up on the subscription. The poll loop reattaches on
      // every failure, so the only thing a failed first attach needs is
      // for the loop to exist — deleting the watcher here meant a
      // subscribe that arrived while 9222 was down never polled again,
      // even after VS Code came back. That is reachable on every wake:
      // the daemon redials in ~5s and the server immediately re-issues
      // subscribe for whatever the phone still has open, usually before
      // VS Code's debug port is listening.
      this._reportAttachFailure(err);
    }
    this._scheduleNext(0);
  }

  // Once per outage, not once per poll: while 9222 is down this would
  // otherwise put an error on the wire every POLL_INTERVAL_MS.
  _reportAttachFailure(err) {
    if (this.attachFailed) return;
    this.attachFailed = true;
    this.onEvent({ type: 'error', sessionId: this.sessionId, message: err.message });
  }

  _scheduleNext(delay) {
    if (this.closed) return;
    this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (this.closed) return;
    try {
      const result = await cdp.evaluate(this.client, POLL_EXPR, this.picked.contextId);
      if (result.sessionUuid) this.lastSessionUuid = result.sessionUuid;
      if (result.domMismatch && !this.reportedMismatch) {
        // Once per watcher, not per poll: this fires every 1.5s otherwise.
        this.reportedMismatch = true;
        const msg =
          `transcript selector matched nothing but found ${result.domMismatch} message ` +
          'blocks — Claude Code\'s markup likely changed, see POLL_EXPR in daemon.js';
        console.error(`[${this.sessionId}] ${msg}`);
        this.onEvent({ type: 'error', sessionId: this.sessionId, message: msg });
      }
      const becameIdle = result.running === false && this.lastRunning !== false;
      if (result.running !== this.lastRunning) {
        this.lastRunning = result.running;
        this.onEvent({ type: 'state', sessionId: this.sessionId, running: result.running });
      }
      const turns = result.turns;
      const diff = diffTurns(this.lastTurns, turns, this.forceResyncNext);
      const emit = shouldEmitNow(diff.kind, {
        forced: this.forceResyncNext,
        becameIdle,
        msSinceResync: Date.now() - this.lastResyncAt,
      });
      if (emit) {
        this.onEvent({ type: diff.kind, sessionId: this.sessionId, turns: diff.turns });
        // Only a resync resets the clock. Appends are cheap and must not
        // buy a held-back snapshot extra time.
        if (diff.kind === 'resync') this.lastResyncAt = Date.now();
        this.lastTurns = turns;
        this.forceResyncNext = false;
      }
    } catch (err) {
      console.error(`[${this.sessionId}] poll error: ${err.message} — reattaching`);
      try {
        this.client && this.client.ws.close();
      } catch (e) {
        // already gone
      }
      try {
        await this.attach();
        this.attachFailed = false; // back in business; report the next outage
      } catch (reattachErr) {
        this._reportAttachFailure(reattachErr);
      }
    }
    this._scheduleNext(POLL_INTERVAL_MS);
  }

  async submit(text) {
    // Claude Code's input is a rich-text editor (contenteditable), not a
    // plain textarea — a raw '\n' character stuffed into execCommand's
    // insertText string doesn't reliably register as a new line in the
    // editor's own internal document model (same class of problem as plain
    // Enter not submitting: JS-level text/event simulation doesn't drive a
    // sophisticated editor's state, a real trusted key event does). Fix:
    // insert line by line, dispatching a real plain Enter (no modifier)
    // between lines to insert an actual line break the editor recognizes,
    // then Cmd+Enter at the end to submit.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const result = await cdp.evaluate(this.client, injectExpr(lines[i]), this.picked.contextId);
      if (!result.ok) return result;
      if (i < lines.length - 1) {
        await dispatchEnter(this.client, 0);
      }
    }
    await dispatchEnter(this.client, CMD_MODIFIER);
    return { ok: true };
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try {
      this.client && this.client.ws.close();
    } catch (e) {
      // already gone
    }
  }
}

// Best-effort label for a log line; the payload may not be JSON at all.
function msgType(raw) {
  try {
    return JSON.parse(raw).type || 'message';
  } catch (e) {
    return 'message';
  }
}

// Poll `probe` until `done` says so. The UI is React: every click is
// followed by a render nobody tells us about, so each step waits for the
// state it expects rather than sleeping a guessed interval.
async function waitFor(run, probe, done, { timeoutMs = 8000, everyMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await run(probe);
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

// What the command menu is currently offering, and what is in the
// composer. Both are needed to decide the next step, and the labels are
// what a failure has to report — guessing at them twice was already once
// too many.
const MENU_STATE_EXPR = `
(function () {
  const items = [...document.querySelectorAll('[class*="commandItem_"]')].map((el) => {
    const lab = el.querySelector('[class*="commandLabel_"]');
    return ((lab || el).textContent || '').trim();
  });
  const box = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].pop();
  return { items, draft: box ? (box.value !== undefined ? box.value : box.textContent) || '' : null };
})()
`;

// The menu entry for /mcp, however it is labelled. Matched on the label
// with a leading slash and surrounding whitespace removed, because the
// exact rendering is not something to bet on twice.
const CLICK_MCP_COMMAND_EXPR = `
(function () {
  const norm = (s) => (s || '').trim().replace(/^[/]/, '').toLowerCase();
  const items = [...document.querySelectorAll('[class*="commandItem_"]')];
  const hit = items.find((el) => {
    const lab = el.querySelector('[class*="commandLabel_"]');
    return norm(((lab || el).textContent || '').split(/[ \\t\\n]/)[0]) === 'mcp';
  });
  if (!hit) {
    return {
      ok: false,
      reason: 'no mcp entry in the command menu',
      seen: items.map((el) => ((el.querySelector('[class*="commandLabel_"]') || el).textContent || '').trim()).slice(0, 20),
    };
  }
  hit.click();
  return { ok: true };
})()
`;

// Empty the composer. Restoring a draft the phone displaced matters more
// than it sounds: the author may have been mid-sentence on the laptop.
const CLEAR_COMPOSER_EXPR = `
(function () {
  const box = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].pop();
  if (!box) return { ok: false };
  box.focus();
  document.execCommand('selectAll');
  document.execCommand('delete');
  return { ok: true };
})()
`;

// One attached webview, driven step by step. `run` evaluates an
// expression in that session's content frame.
async function openMcpPanel(run) {
  let state = await run(MCP_STATE_EXPR);
  if (state.panel !== 'none') {
    // Normally none: the panel is opened and closed within one action, and
    // measured against a live session it is gone again on the next entry.
    // Finding it already there means a previous action did not close it,
    // which leaves the author's screen where the phone put it — worth a
    // line, since nothing else would ever say so.
    console.error(`[mcp] panel was already open on entry (${state.panel}) — a previous action did not close it`);
    return { ok: true, state };
  }

  // Type "/mcp" rather than opening the menu with its button. The menu
  // filters on what is in the composer, and opening it cold lists every
  // command — which is where the first attempt failed, reporting no mcp
  // entry. This is also the path that is known to work, because it is the
  // one a person uses.
  //
  // No Enter at any point: Enter sends "/mcp" as a message instead of
  // opening the panel.
  const before = await run(MENU_STATE_EXPR);
  const draft = before.draft || '';
  if (draft) await run(CLEAR_COMPOSER_EXPR);
  await run(injectExpr('/mcp'));

  const menu = await waitFor(
    run,
    MENU_STATE_EXPR,
    (st) => st.items.some((label) => label.trim().replace(/^\//, '').toLowerCase().startsWith('mcp')),
    { timeoutMs: 5000 },
  );
  if (!menu.items.length) {
    await run(CLEAR_COMPOSER_EXPR);
    if (draft) await run(injectExpr(draft));
    return { ok: false, error: 'typing /mcp opened no command menu' };
  }

  const picked = await run(CLICK_MCP_COMMAND_EXPR);
  // Either way the composer goes back to how it was found.
  await run(CLEAR_COMPOSER_EXPR);
  if (draft) await run(injectExpr(draft));
  if (!picked.ok) {
    return {
      ok: false,
      error: `${picked.reason}${picked.seen && picked.seen.length ? ` (menu showed: ${picked.seen.join(', ')})` : ''}`,
    };
  }

  state = await waitFor(run, MCP_STATE_EXPR, (st) => st.panel !== 'none');
  if (state.panel === 'none') return { ok: false, error: 'the MCP panel did not open' };
  return { ok: true, state };
}

async function closeMcpPanel(run) {
  // Leaving the laptop parked on a panel the phone opened is its own
  // small betrayal. Best effort, never fatal — but verified, because the
  // first version matched on textContent and an icon button has none, so
  // it silently never closed anything.
  try {
    let out = await run(clickByName('iconButton_', 'Close'));
    if (!out.ok) {
      // Whatever it is called, it is the control that dismisses the panel.
      out = await run(`
(function () {
  const btn = [...document.querySelectorAll('button')].find((el) => {
    const n = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().toLowerCase();
    return n === 'close' || n === 'dismiss';
  });
  if (!btn) return { ok: false };
  btn.click();
  return { ok: true };
})()
`);
    }
    await waitFor(run, MCP_STATE_EXPR, (st) => st.panel === 'none', { timeoutMs: 3000 });
  } catch (e) {
    // the panel staying open is untidy, not a failure of the action
  }
}

async function readMcpServers(run) {
  const opened = await openMcpPanel(run);
  if (!opened.ok) return opened;
  let state = opened.state;
  if (state.panel === 'detail') {
    await run(clickByText('backButton_', '← Back to list'));
    state = await waitFor(run, MCP_STATE_EXPR, (st) => st.rows.length > 0);
  }
  await closeMcpPanel(run);
  return { ok: true, servers: state.rows };
}

async function reconnectMcpServer(run, name) {
  const opened = await openMcpPanel(run);
  if (!opened.ok) return opened;
  let state = opened.state;

  if (state.panel === 'detail' && state.title !== name) {
    await run(clickByText('backButton_', '← Back to list'));
    state = await waitFor(run, MCP_STATE_EXPR, (st) => st.rows.length > 0);
  }
  if (state.panel !== 'detail') {
    const row = await run(clickServerRow(name));
    if (!row.ok) {
      await closeMcpPanel(run);
      return { ok: false, error: `${row.reason}${row.seen ? ` (saw: ${row.seen.join(', ')})` : ''}` };
    }
    state = await waitFor(run, MCP_STATE_EXPR, (st) => st.panel === 'detail' && st.title === name);
  }

  const clicked = await run(clickReconnectFor(name));
  if (!clicked.ok) {
    await closeMcpPanel(run);
    return { ok: false, error: clicked.reason };
  }

  // The button reads "Reconnecting…" while in flight; settled is when it
  // is gone. Not proof the server came back — the status badge is — but
  // proof the request completed rather than hanging.
  await waitFor(run, RECONNECT_BUSY_EXPR, (st) => !st.busy, { timeoutMs: 20000 });
  const after = await run(MCP_STATE_EXPR);
  await closeMcpPanel(run);
  return { ok: true, status: after.title === name ? 'reconnected' : 'done' };
}

class Daemon {
  constructor() {
    this.ws = null;
    this.watchers = new Map(); // sessionId -> SessionWatcher
    this.reconnectDelay = 1000;
    // Bumped on every connect and on every forced cycle. A socket's own
    // listeners capture the generation they were installed under and do
    // nothing once it is stale, so a socket we have given up on cannot
    // schedule a second reconnect on top of the one already running.
    this.generation = 0;
    // webview id -> tab label, learned one at a time from whichever
    // conversation is on screen. Fills in as tabs are switched; lost on
    // restart, which costs a nicer label and nothing else.
    this.learnedTitles = new Map();
    // When the VPS was last heard from at all. Any inbound frame counts,
    // including the pong; see watchConnection.
    this.lastInboundAt = 0;
  }

  // ms since the VPS last said anything, or null when there is no socket
  // to have heard it on.
  msSinceInbound() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.lastInboundAt) return null;
    return Date.now() - this.lastInboundAt;
  }

  ping() {
    this._send({ type: 'ping' });
  }

  connect() {
    const gen = ++this.generation;
    console.error(`Connecting to ${VPS_WS_URL} ...`);
    this.ws = new WebSocket(VPS_WS_URL);
    this.ws.addEventListener('open', () => {
      console.error('Connected — authenticating...');
      this.reconnectDelay = 1000;
      this.lastInboundAt = Date.now(); // the deadline starts now, not at 0
      this._send({ type: 'hello', token: AUTH_TOKEN });
    });
    this.ws.addEventListener('message', (ev) => {
      // _handleMessage is async and nothing awaits its promise. An
      // unhandled rejection inside an EventTarget listener is rethrown on
      // the next tick and takes the process down — which is how quitting
      // VS Code killed the daemon: the CDP fetch refused with
      // ECONNREFUSED 127.0.0.1:9222 and the rejection escaped. Nothing
      // arriving here is worth dying for; the VPS link and the poll loops
      // both recover on their own.
      this.lastInboundAt = Date.now();
      this._handleMessage(ev.data).catch((err) => {
        console.error(`Error handling ${msgType(ev.data)}: ${err.message}`);
      });
    });
    this.ws.addEventListener('close', (ev) => {
      if (gen !== this.generation) return; // superseded; a reconnect is already in flight
      // code/reason are the actual diagnostic here — e.g. 1009 means a
      // frame exceeded a size limit somewhere in the chain, 1006 is an
      // abnormal/network-level close with no close frame, 1011 is a server
      // error. Logging none of this was the reason earlier disconnects were
      // unexplained.
      console.error(
        `Disconnected (code=${ev.code} reason=${JSON.stringify(ev.reason)} wasClean=${ev.wasClean}) — reconnecting in ${this.reconnectDelay}ms...`
      );
      for (const w of this.watchers.values()) w.close();
      this.watchers.clear();
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });
    this.ws.addEventListener('error', (ev) => {
      console.error(`WebSocket error: ${ev.message || ev}`);
      // 'close' fires right after; reconnect logic lives there.
    });
  }

  // Abandon the current socket and dial again immediately, without waiting
  // for a close event that may never come.
  forceReconnect(reason) {
    console.error(`${reason} — cycling the VPS link`);
    const stale = this.ws;
    this.generation++; // orphans stale's listeners; see connect()
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    try {
      stale && stale.close();
    } catch (e) {
      // a dead socket may refuse even this
    }
    this.reconnectDelay = 1000;
    this.connect();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  async _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'auth_failed') {
      console.error('Auth rejected by server — check AUTH_TOKEN matches on both sides. Not retrying.');
      process.exit(1);
    }

    if (msg.type === 'pong') return; // liveness only; lastInboundAt is the payload

    if (msg.type === 'auth_ok') {
      console.error('Authenticated. Waiting for commands.');
      return;
    }

    if (msg.type === 'list_sessions') {
      const result = await this._listSessions();
      this._send({ type: 'sessions_result', reqId: msg.reqId, ...result });
      return;
    }

    // Phone-initiated actions. Each answers on the same reqId the server
    // is waiting on, so a failure reaches the phone as a sentence rather
    // than a timeout.
    if (msg.type === 'new_session') {
      const result = await this.newSession(msg.text || '');
      this._send({ type: 'action_result', reqId: msg.reqId, ...result });
      return;
    }

    if (msg.type === 'list_mcp') {
      const result = await this.listMcpServers();
      this._send({ type: 'action_result', reqId: msg.reqId, ...result });
      return;
    }

    if (msg.type === 'reconnect_mcp') {
      const result = await this.reconnectMcp(msg.serverName);
      this._send({ type: 'action_result', reqId: msg.reqId, ...result });
      return;
    }

    if (msg.type === 'subscribe') {
      if (this.watchers.has(msg.sessionId)) return;
      const watcher = new SessionWatcher(msg.sessionId, (event) => this._send(event));
      this.watchers.set(msg.sessionId, watcher);
      // start() no longer throws: a failed first attach reports itself and
      // leaves the poll loop running, so the subscription survives 9222
      // being temporarily down.
      await watcher.start();
      console.error(`Subscribed: ${msg.sessionId}`);
      return;
    }

    if (msg.type === 'unsubscribe') {
      const watcher = this.watchers.get(msg.sessionId);
      if (watcher) {
        watcher.close();
        this.watchers.delete(msg.sessionId);
        console.error(`Unsubscribed: ${msg.sessionId}`);
      }
      return;
    }

    if (msg.type === 'submit') {
      const watcher = this.watchers.get(msg.sessionId);
      if (watcher) {
        const result = await watcher.submit(msg.text).catch((err) => ({ ok: false, reason: err.message }));
        this._send({
          type: 'submit_ack',
          sessionId: msg.sessionId,
          ok: !!result.ok,
          error: result.ok ? undefined : result.reason,
        });
        return;
      }
      // Not currently subscribed — one-shot attach just to submit.
      const temp = new SessionWatcher(msg.sessionId, () => {});
      try {
        await temp.attach();
        const result = await temp.submit(msg.text);
        this._send({ type: 'submit_ack', sessionId: msg.sessionId, ok: !!result.ok, error: result.reason });
      } catch (err) {
        this._send({ type: 'submit_ack', sessionId: msg.sessionId, ok: false, error: err.message });
      } finally {
        temp.close();
      }
      return;
    }
  }

  // Evaluate expressions in one session's content frame. Attaches for the
  // call and closes after, like the one-shot submit path: these run on a
  // phone tap, not on a poll.
  async _withSession(sessionId, fn) {
    let client;
    try {
      const target = await cdp.findTarget(CDP_PORT, sessionId);
      client = await cdp.connect(target);
      const frames = await cdp.getFrames(client);
      const picked = await cdp.pickContentFrame(client, frames);
      if (!picked) return { ok: false, error: 'no content frame in that session' };
      return await fn((expr) => cdp.evaluate(client, expr, picked.contextId));
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      try {
        client && client.ws.close();
      } catch (e) {
        // already gone
      }
    }
  }

  // Which session to drive for an MCP action. Connections are per-session
  // — each one is its own CLI process with its own MCP clients — so this
  // has to name one. The visible tab is the one the author is looking at
  // and so the one whose MCP state they mean.
  async _mcpSessionId() {
    const targets = await cdp.listClaudeSessions(CDP_PORT);
    if (!targets.length) return null;
    const pair = await cdp.readActiveWebviewTitle(
      CDP_PORT,
      targets.map((t) => t.sessionId)
    );
    return pair ? pair.webviewId : targets[0].sessionId;
  }

  async listMcpServers() {
    const sessionId = await this._mcpSessionId();
    if (!sessionId) return { ok: false, error: 'no Claude Code session is open' };
    const out = await this._withSession(sessionId, (run) => readMcpServers(run));
    return { ...out, sessionId };
  }

  async reconnectMcp(name) {
    const sessionId = await this._mcpSessionId();
    if (!sessionId) return { ok: false, error: 'no Claude Code session is open' };
    const out = await this._withSession(sessionId, (run) => reconnectMcpServer(run, name));
    return { ...out, sessionId };
  }

  // Click New session in the sidebar, wait for a webview id that was not
  // there before, then type into it. The phone does not navigate to it —
  // the next list refresh shows it, which is all that was asked for.
  async newSession(text) {
    let before;
    try {
      before = new Set((await cdp.listClaudeSessions(CDP_PORT)).map((t) => t.sessionId));
    } catch (err) {
      return { ok: false, error: `CDP unreachable: ${err.message}` };
    }

    const sidebar = await cdp.withSidebar(CDP_PORT, (run) => run(NEW_SESSION_EXPR));
    if (!sidebar || !sidebar.ok) {
      return { ok: false, error: sidebar ? sidebar.reason : 'the Claude Code panel is not open' };
    }

    // A new webview, not merely a new tab: id is what everything else
    // addresses by.
    const until = Date.now() + 15000;
    let fresh = null;
    while (Date.now() < until && !fresh) {
      await new Promise((r) => setTimeout(r, 400));
      let now;
      try {
        now = await cdp.listClaudeSessions(CDP_PORT);
      } catch (err) {
        continue;
      }
      fresh = now.map((t) => t.sessionId).find((id) => !before.has(id)) || null;
    }
    if (!fresh) return { ok: false, error: 'clicked New session but no new session appeared' };
    if (!text) return { ok: true, sessionId: fresh };

    // The new webview mounts before its composer does, so retry rather
    // than racing it.
    const deadline = Date.now() + 15000;
    let last = { ok: false, reason: 'never attached' };
    while (Date.now() < deadline) {
      const w = new SessionWatcher(fresh, () => {});
      try {
        await w.attach();
        last = await w.submit(text);
        if (last.ok) return { ok: true, sessionId: fresh };
      } catch (err) {
        last = { ok: false, reason: err.message };
      } finally {
        w.close();
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return { ok: false, sessionId: fresh, error: `session created, but the prompt did not land: ${last.reason}` };
  }

  async _listSessions() {
    let targets;
    try {
      targets = await cdp.listClaudeSessions(CDP_PORT);
    } catch (err) {
      // VS Code is closed, restarting, or was started without
      // --remote-debugging-port. The next /api/sessions call retries, so
      // recovery needs no state here — but an empty list on its own is
      // indistinguishable from VS Code being open with no Claude tabs,
      // and from the phone's side both of those already look like the
      // daemon being offline. Say which it is.
      console.error(`CDP unreachable on port ${CDP_PORT} (${err.message}) — reporting VS Code as down`);
      return { sessions: [], cdp: 'unreachable', cdpError: err.message };
    }
    const claims = new Map();
    const sessions = [];
    for (const t of targets) {
      const existing = this.watchers.get(t.sessionId);
      if (existing) {
        claims.set(t.sessionId, existing.lastSessionUuid);
        sessions.push({
          sessionId: t.sessionId,
          title: null, // filled in below from whichever naming route worked
          preview: existing.lastTurns.length ? stripTags(existing.lastTurns.join('')).slice(-150) : '',
          running: existing.lastRunning,
        });
        continue;
      }
      // One-shot connection for a preview — must NOT reuse an already-open
      // debugger session's connection (some CDP targets reject a second
      // simultaneous attach), hence the separate connect here.
      let client;
      try {
        const target = await cdp.findTarget(CDP_PORT, t.sessionId);
        client = await cdp.connect(target);
        const frames = await cdp.getFrames(client);
        const picked = await cdp.pickContentFrame(client, frames);
        let preview = '';
        let running = null;
        if (picked) {
          const result = await cdp.evaluate(client, POLL_EXPR, picked.contextId);
          preview = stripTags(result.turns.join('')).slice(-150);
          running = result.running;
          claims.set(t.sessionId, result.sessionUuid);
        }
        sessions.push({ sessionId: t.sessionId, title: null, preview, running });
      } catch (err) {
        sessions.push({ sessionId: t.sessionId, title: null, preview: '', running: null, error: err.message });
      } finally {
        // Without this, a throw between connect() and here (e.g.
        // pickContentFrame failing) leaked the CDP debugger connection —
        // harmless once, but this runs on every /api/sessions call.
        try {
          client && client.ws.close();
        } catch (e) {
          // already gone
        }
      }
    }
    // Exact first, learned second. Nothing else names a session.
    // The sidebar only helps if some webview told us which conversation it
    // holds, and after VS Code restores tabs none of them do. Reading it
    // anyway costs a CDP connect and an evaluate per listing to build a
    // table nothing can be looked up in.
    const names = [...claims.values()].some(Boolean)
      ? await cdp.readSessionNames(CDP_PORT)
      : {};

    // Learn the one pair the workbench can state without guessing.
    const pair = await cdp.readActiveWebviewTitle(
      CDP_PORT,
      targets.map((t) => t.sessionId)
    );
    if (pair) this.learnedTitles.set(pair.webviewId, pair.title);

    const titles = resolveTitles(claims, names);
    for (const s of sessions) {
      // data-initial-session is exact when present, so it wins; the
      // learned label covers sessions VS Code restored, where that
      // attribute is never written.
      s.title = titles.get(s.sessionId) || this.learnedTitles.get(s.sessionId) || null;
    }
    // Count what actually shipped, not what the uuid join alone produced.
    const named = sessions.filter((s) => s.title).length;
    // Only when the picture changes. Listing happens on every phone
    // refresh, and an unconditional line here buries the events worth
    // reading — subscribes, reconnects, DOM mismatches — under a
    // heartbeat that says the same thing every few seconds.
    const shape = `${named}/${sessions.length}/${Object.keys(names).length}/${this.learnedTitles.size}`;
    if (named < sessions.length && shape !== this.lastTitleShape) {
      this.lastTitleShape = shape;
      // Which of the three links broke is not guessable after the fact:
      // no sidebar rows means the Claude Code panel is closed; no session
      // uuids means the webviews are not carrying data-initial-session;
      // both present with nothing named means the two id sets disagree.
      const uuids = [...claims.values()].filter(Boolean).length;
      console.error(
        `titles: ${named}/${sessions.length} named ` +
          `(sidebar rows=${Object.keys(names).length}, webviews with a session uuid=${uuids}, ` +
          `learned from tabs=${this.learnedTitles.size})`
      );
    }
    return { sessions, cdp: 'ok' };
  }
}

// --- sleep/wake detection -------------------------------------------------
// A laptop lid closing does not close its TCP connections. They are left
// half-open: the peer never sends FIN or RST that this side can see, so no
// 'close' event fires, readyState stays OPEN, and _send writes into a black
// hole. Every reconnect path in this file hangs off 'close', so after a
// suspend the daemon looks connected and is not — which is exactly the
// "nothing reconnected after the MacBook woke" symptom.
//
// The suspend itself is observable without any platform API: a timer that
// should fire every WAKE_PROBE_MS fires far later instead, because the
// whole process was frozen. Wall-clock gap is the signal.
//
// Deliberately not a heartbeat. The server already pings at 30s and the
// WebSocket layer pongs without telling us, so ping traffic proves nothing
// at this level; and an application-level ping would still need a timeout
// to interpret its own silence, which is a second timer doing worse what
// this one does directly.
const WAKE_PROBE_MS = 5000;
const WAKE_GAP_MS = 30000; // generous: normal event-loop lag is milliseconds

// The other way a connection dies without saying so. Changing wifi can
// black-hole an established TCP connection: no FIN, no RST, readyState
// stays OPEN, and _send writes into nothing. Unlike a suspend there is no
// wall-clock gap to notice, so the wake check above cannot see it, and
// the server's protocol-level ping is answered by the WebSocket layer
// without ever reaching this code. Nothing else bounds the outage — the
// OS gives up on the socket eventually, but that is many minutes.
//
// So: say something periodically and require an answer. PING_EVERY_MS is
// well under DEAD_AFTER_MS so an ordinary lost packet does not trip it.
const PING_EVERY_MS = 20000;
const DEAD_AFTER_MS = 60000;

function watchConnection(daemon) {
  let last = Date.now();
  let lastPing = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > WAKE_GAP_MS) {
      daemon.forceReconnect(`Host was suspended for ~${Math.round(gap / 1000)}s`);
      return; // already redialling; the silence below is expected
    }
    const quiet = daemon.msSinceInbound();
    if (quiet === null) return; // not connected; the reconnect loop owns this
    if (quiet > DEAD_AFTER_MS) {
      daemon.forceReconnect(`No answer from the VPS for ${Math.round(quiet / 1000)}s`);
      return;
    }
    if (now - lastPing >= PING_EVERY_MS) {
      lastPing = now;
      daemon.ping();
    }
  }, WAKE_PROBE_MS);
  timer.unref && timer.unref(); // never hold the process open on its own
  return timer;
}

// --- optional: auto-deploy server/ to the VPS on save --------------------
// Merged in here rather than kept as a separate script so one `node --watch`
// loop restarts the daemon AND pushes server/ changes — a single "edit,
// save, both sides redeploy" loop instead of two processes to remember to
// run. No-op if DEPLOY_TARGET isn't set.

let deployTimer = null;

function deploySync() {
  // No --delete: this only ever adds/updates files on the VPS from what's
  // here locally, never removes anything there (so server.py's own
  // ./data — which doesn't exist in this source tree — is untouched
  // regardless of exclude flags). Hidden files (.env included) sync too —
  // rsync includes dotfiles by default for a directory's contents, nothing
  // extra needed for that. Still skip __pycache__: pure local build noise,
  // never wanted on the VPS.
  const cmd = `rsync -avz --exclude=__pycache__ "${DEPLOY_WATCH_DIR}/" "${DEPLOY_TARGET}/"`;
  console.error(`[deploy] ${cmd}`);
  exec(cmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`[deploy] rsync failed: ${err.message}`);
      return;
    }
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    console.error('[deploy] done');
  });
}

function startDeployWatch() {
  console.error(`[deploy] watching ${DEPLOY_WATCH_DIR} -> ${DEPLOY_TARGET}`);
  deploySync(); // push current state on start, not just on the next edit
  // An FSWatcher is an EventEmitter, so an unhandled 'error' — watch root
  // moved, replaced, unmounted, or a descriptor limit — is rethrown and
  // exits the process. Deploying is an optional convenience; the VPS
  // bridge is the point. Losing the first must not cost the second.
  try {
    const watcher = fs.watch(DEPLOY_WATCH_DIR, { recursive: true }, () => {
      clearTimeout(deployTimer);
      deployTimer = setTimeout(deploySync, DEPLOY_DEBOUNCE_MS);
    });
    watcher.on('error', (err) => {
      console.error(`[deploy] watcher stopped: ${err.message} — edits will no longer deploy`);
    });
  } catch (err) {
    console.error(`[deploy] could not watch ${DEPLOY_WATCH_DIR}: ${err.message}`);
  }
}

// Run as a program: install file logging, check env, connect, optionally
// deploy-watch. Imported as a module (tests): none of that happens, and the
// pure pieces below are what's exercised. Keeping the startup behind this
// guard is the only reason this file is testable at all — before it, a bare
// `require()` would exit the process on a missing env var.
if (require.main === module) {
  installFileLogging();
  requireEnv();
  const daemon = new Daemon();
  daemon.connect();
  watchConnection(daemon);
  if (DEPLOY_TARGET) startDeployWatch();
}

module.exports = {
  clickByName,
  CLEAR_COMPOSER_EXPR,
  RECONNECT_BUSY_EXPR,
  CLICK_MCP_COMMAND_EXPR,
  MENU_STATE_EXPR,
  openMcpPanel,
  readMcpServers,
  reconnectMcpServer,
  clickByText,
  clickServerRow,
  clickReconnectFor,
  waitFor,
  MCP_STATE_EXPR,
  NEW_SESSION_EXPR,
  shouldEmitNow,
  RESYNC_MIN_INTERVAL_MS,
  resolveTitles,
  watchConnection,
  WAKE_PROBE_MS,
  WAKE_GAP_MS,
  PING_EVERY_MS,
  DEAD_AFTER_MS,
  diffTurns,
  arraysEqual,
  stripTags,
  injectExpr,
  dispatchEnter,
  SessionWatcher,
  Daemon,
  POLL_EXPR,
  MAX_RESYNC_TURNS,
  CMD_MODIFIER,
};
