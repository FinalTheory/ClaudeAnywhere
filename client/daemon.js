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
//   {type:"sessions_result", reqId, sessions:[{sessionId, title, preview, running}]}
//   {type:"state", sessionId, running}
//   {type:"append", sessionId, turns}   // extend what the VPS has
//   {type:"resync", sessionId, turns}   // capped tail; VPS splices by content overlap
//   {type:"submit_ack", sessionId, ok, error?}
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
  return {
    running: btn ? btn.getAttribute('aria-label') === 'Stop' : null,
    turns,
    // Verified empirically to be null/non-conversation-specific for this
    // extension's webviews — kept in case a future build changes that, but
    // don't rely on it; see inspect-tabs.js for the fallback approach.
    title: document.title || null
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
  document.execCommand('insertText', false, text);
  return { ok: true };
})(${JSON.stringify(text)})
`;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// How many trailing turns a forced/fallback resync carries — the server
// reconciles this against its own stored history by content overlap, so
// this only needs to be "enough to find the overlap point", not the whole
// conversation. 50 is a generous margin over how many turns typically
// change/appear between poll ticks.
const MAX_RESYNC_TURNS = 50;

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
  // Turn count went backward, or an earlier turn's content changed (VS Code
  // virtualized something out, or genuinely edited history) — not
  // expressible as a clean append, fall back to resync.
  return { kind: 'resync', turns: turns.slice(-MAX_RESYNC_TURNS) };
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
    this.lastTitle = null;
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
    await this.attach();
    this._scheduleNext(0);
  }

  _scheduleNext(delay) {
    if (this.closed) return;
    this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (this.closed) return;
    try {
      const result = await cdp.evaluate(this.client, POLL_EXPR, this.picked.contextId);
      if (result.title) this.lastTitle = result.title;
      if (result.running !== null && result.running !== this.lastRunning) {
        this.lastRunning = result.running;
        this.onEvent({ type: 'state', sessionId: this.sessionId, running: result.running });
      }
      const turns = result.turns;
      const diff = diffTurns(this.lastTurns, turns, this.forceResyncNext);
      if (diff.kind !== 'none') {
        this.onEvent({ type: diff.kind, sessionId: this.sessionId, turns: diff.turns });
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
      } catch (reattachErr) {
        this.onEvent({ type: 'error', sessionId: this.sessionId, message: reattachErr.message });
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
  }

  connect() {
    const gen = ++this.generation;
    console.error(`Connecting to ${VPS_WS_URL} ...`);
    this.ws = new WebSocket(VPS_WS_URL);
    this.ws.addEventListener('open', () => {
      console.error('Connected — authenticating...');
      this.reconnectDelay = 1000;
      this._send({ type: 'hello', token: AUTH_TOKEN });
    });
    this.ws.addEventListener('message', (ev) => this._handleMessage(ev.data));
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

    if (msg.type === 'auth_ok') {
      console.error('Authenticated. Waiting for commands.');
      return;
    }

    if (msg.type === 'list_sessions') {
      const sessions = await this._listSessions();
      this._send({ type: 'sessions_result', reqId: msg.reqId, sessions });
      return;
    }

    if (msg.type === 'subscribe') {
      if (this.watchers.has(msg.sessionId)) return;
      const watcher = new SessionWatcher(msg.sessionId, (event) => this._send(event));
      this.watchers.set(msg.sessionId, watcher);
      try {
        await watcher.start();
        console.error(`Subscribed: ${msg.sessionId}`);
      } catch (err) {
        this._send({ type: 'error', sessionId: msg.sessionId, message: err.message });
        this.watchers.delete(msg.sessionId);
      }
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

  async _listSessions() {
    const targets = await cdp.listClaudeSessions(CDP_PORT);
    const sessions = [];
    for (const t of targets) {
      const existing = this.watchers.get(t.sessionId);
      if (existing) {
        sessions.push({
          sessionId: t.sessionId,
          title: existing.lastTitle,
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
        let title = null;
        if (picked) {
          const result = await cdp.evaluate(client, POLL_EXPR, picked.contextId);
          preview = stripTags(result.turns.join('')).slice(-150);
          running = result.running;
          title = result.title;
        }
        sessions.push({ sessionId: t.sessionId, title, preview, running });
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
    return sessions;
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

function watchForWake(daemon) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > WAKE_GAP_MS) {
      daemon.forceReconnect(`Host was suspended for ~${Math.round(gap / 1000)}s`);
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
  fs.watch(DEPLOY_WATCH_DIR, { recursive: true }, () => {
    clearTimeout(deployTimer);
    deployTimer = setTimeout(deploySync, DEPLOY_DEBOUNCE_MS);
  });
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
  watchForWake(daemon);
  if (DEPLOY_TARGET) startDeployWatch();
}

module.exports = {
  watchForWake,
  WAKE_PROBE_MS,
  WAKE_GAP_MS,
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
