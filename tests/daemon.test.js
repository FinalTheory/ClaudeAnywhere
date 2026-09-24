// Run: node --test tests/
//
// These live outside server/ on purpose: the daemon's deploy-watch rsyncs
// server/ to the VPS on every change, and test files have no business
// shipping there or triggering a production restart on every edit.

const test = require('node:test');
const assert = require('node:assert');

const cdp = require('../cdp-client.js');
const {
  openMcpPanel,
  SessionQueue,
  CLEAR_COMPOSER_EXPR,
  MENU_STATE_EXPR,
  clickByName,
  CLICK_MCP_COMMAND_EXPR,
  clickByText,
  clickServerRow,
  clickReconnectFor,
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
  Daemon,
  diffTurns,
  arraysEqual,
  stripTags,
  injectExpr,
  dispatchEnter,
  SessionWatcher,
  MAX_RESYNC_TURNS,
  CMD_MODIFIER,
  readMcpServers,
  reconnectMcpServer,
} = require('../client/daemon.js');

// --- diffTurns: the wire decision ----------------------------------------
// This is the logic whose earlier version silently duplicated an entire
// conversation into the server's one persisted copy on every daemon
// restart. Each case below is a state the poll loop actually reaches.

test('diffTurns: forced resync sends the current tail', () => {
  const out = diffTurns([], ['a', 'b'], true);
  assert.strictEqual(out.kind, 'resync');
  assert.deepStrictEqual(out.turns, ['a', 'b']);
});

test('diffTurns: forced resync is capped to MAX_RESYNC_TURNS, keeping the newest', () => {
  const turns = Array.from({ length: MAX_RESYNC_TURNS + 10 }, (_, i) => `t${i}`);
  const out = diffTurns([], turns, true);
  assert.strictEqual(out.kind, 'resync');
  assert.strictEqual(out.turns.length, MAX_RESYNC_TURNS);
  assert.strictEqual(out.turns.at(-1), `t${MAX_RESYNC_TURNS + 9}`);
  assert.strictEqual(out.turns[0], 't10', 'drops the oldest, not the newest');
});

test('diffTurns: identical turns emit nothing', () => {
  const out = diffTurns(['a', 'b'], ['a', 'b'], false);
  assert.strictEqual(out.kind, 'none');
  assert.deepStrictEqual(out.turns, []);
});

test('diffTurns: a pure suffix growth is an append of only the new turns', () => {
  const out = diffTurns(['a', 'b'], ['a', 'b', 'c'], false);
  assert.strictEqual(out.kind, 'append');
  assert.deepStrictEqual(out.turns, ['c']);
});

test('diffTurns: a changed last turn is a resync carrying only that turn', () => {
  // The streaming case: the final turn grows in place as tokens arrive.
  // Appending would leave the half-written turn next to the finished one
  // on the server; sending the whole tail would retransmit the entire
  // conversation once every poll to describe growth in one turn.
  const out = diffTurns(['a', 'b-partial'], ['a', 'b-complete'], false);
  assert.strictEqual(out.kind, 'resync');
  assert.deepStrictEqual(out.turns, ['b-complete'], 'only the turn that changed');
});

test('diffTurns: two turns changing at once still sends the generic tail', () => {
  // The narrow streaming shortcut must not swallow this: a one-turn tail
  // could not describe both changes, and a two-turn tail whose first entry
  // coincidentally matched an older turn could splice late.
  const out = diffTurns(['a', 'b', 'c'], ['a', 'B', 'C'], false);
  assert.strictEqual(out.kind, 'resync');
  assert.deepStrictEqual(out.turns, ['a', 'B', 'C']);
});

test('diffTurns: a shrinking turn list is a resync', () => {
  // VS Code virtualized older turns out of the DOM, or history was edited.
  const out = diffTurns(['a', 'b', 'c'], ['b', 'c'], false);
  assert.strictEqual(out.kind, 'resync');
  assert.deepStrictEqual(out.turns, ['b', 'c']);
});

test('diffTurns: an earlier turn changing is a resync, not an append', () => {
  const out = diffTurns(['a', 'b'], ['a-edited', 'b', 'c'], false);
  assert.strictEqual(out.kind, 'resync');
});

test('diffTurns: WITHOUT forceResync an empty baseline degenerates to append-everything', () => {
  // Pins the reason SessionWatcher sets forceResyncNext on construction:
  // [] is a prefix of anything, so a fresh watcher that skipped the flag
  // would report its whole first read as an "append" and the server would
  // concatenate it onto history it already had. This documents the trap;
  // the next test proves the constructor avoids it.
  const out = diffTurns([], ['a', 'b'], false);
  assert.strictEqual(out.kind, 'append');
  assert.deepStrictEqual(out.turns, ['a', 'b']);
});

test('SessionWatcher starts with forceResyncNext set', () => {
  const w = new SessionWatcher('sid', () => {});
  assert.strictEqual(w.forceResyncNext, true);
  assert.deepStrictEqual(w.lastTurns, []);
});

// --- _tick: the wiring, not just the pieces -------------------------------
// diffTurns being right and the constructor flag being set are both useless
// if _tick doesn't pass one to the other. Driving the real _tick is what
// makes hard-coding `false` for that argument — which restores
// duplicate-the-whole-conversation-on-every-restart — a failing test.

function tickableWatcher(t, snapshots) {
  const events = [];
  let i = 0;
  t.mock.method(cdp, 'evaluate', async () => snapshots[Math.min(i++, snapshots.length - 1)]);
  const w = new SessionWatcher('sid', (e) => events.push(e));
  w.picked = { contextId: 1 };
  w.client = { send: async () => ({}), ws: { close() {} } };
  t.after(() => w.close()); // _tick arms the next poll timer; don't leak it
  return { w, events };
}

const snap = (turns, running = false) => ({ running, turns, title: null });

test('_tick: a fresh watcher reports its first read as a resync, never an append', async (t) => {
  const { w, events } = tickableWatcher(t, [snap(['a', 'b'])]);
  await w._tick();
  const content = events.filter((e) => e.type !== 'state');
  assert.deepStrictEqual(content, [{ type: 'resync', sessionId: 'sid', turns: ['a', 'b'] }]);
  assert.strictEqual(w.forceResyncNext, false, 'the flag is consumed, not left set');
  assert.deepStrictEqual(w.lastTurns, ['a', 'b'], 'state advanced with the emitted event');
});

test('_tick: the second read is an append of only what is new', async (t) => {
  const { w, events } = tickableWatcher(t, [snap(['a']), snap(['a', 'b'])]);
  await w._tick();
  await w._tick();
  const content = events.filter((e) => e.type !== 'state');
  assert.deepStrictEqual(content.map((e) => e.type), ['resync', 'append']);
  // Full event shape, not just the turns: an event missing sessionId is
  // unroutable at the server and the phone silently goes stale.
  assert.deepStrictEqual(content[1], { type: 'append', sessionId: 'sid', turns: ['b'] });
});

test('_tick: an unchanged read emits nothing at all', async (t) => {
  const { w, events } = tickableWatcher(t, [snap(['a']), snap(['a']), snap(['a'])]);
  await w._tick();
  await w._tick();
  await w._tick();
  assert.deepStrictEqual(
    events.filter((e) => e.type !== 'state').map((e) => e.type),
    ['resync'],
    'polling an idle session must not put traffic on the wire',
  );
});

test('_tick: a running-state flip is reported once, not on every poll', async (t) => {
  const { w, events } = tickableWatcher(t, [
    snap(['a'], false),
    snap(['a'], true),
    snap(['a'], true),
  ]);
  await w._tick();
  await w._tick();
  await w._tick();
  assert.deepStrictEqual(
    events.filter((e) => e.type === 'state'),
    [
      { type: 'state', sessionId: 'sid', running: false },
      { type: 'state', sessionId: 'sid', running: true },
    ],
  );
});

// --- arraysEqual ----------------------------------------------------------

test('arraysEqual: length, order and content all matter', () => {
  assert.ok(arraysEqual([], []));
  assert.ok(arraysEqual(['a', 'b'], ['a', 'b']));
  assert.ok(!arraysEqual(['a'], ['a', 'b']));
  assert.ok(!arraysEqual(['a', 'b'], ['b', 'a']));
  assert.ok(!arraysEqual(['a'], ['A']));
});

// --- stripTags (preview text) ---------------------------------------------

test('stripTags: removes markup and collapses whitespace', () => {
  assert.strictEqual(stripTags('<div class="x">hi</div>'), 'hi');
  assert.strictEqual(stripTags('<p>a</p>\n\n  <p>b</p>'), 'a b');
  assert.strictEqual(stripTags('plain'), 'plain');
});

// --- injectExpr: escaping is the whole job --------------------------------
// The expression is handed to CDP Runtime.evaluate as JS source, so a
// quote/newline/backslash that isn't escaped is either a syntax error or,
// worse, silently different text typed into someone's editor.

function runInject(text, doc) {
  // eslint-disable-next-line no-new-func
  return new Function('document', `return (${injectExpr(text)});`)(doc);
}

test('injectExpr: round-trips text through JS source exactly', () => {
  for (const text of [
    'plain',
    'with "double" quotes',
    "with 'single' quotes",
    'with `backticks` and ${notATemplate}',
    'with\nnewlines\nembedded',
    'with \\ backslash',
    '中文 with unicode 😀',
    '</script><script>alert(1)</script>',
  ]) {
    const inserted = [];
    const doc = {
      querySelectorAll: () => [{ focus() {} }],
      execCommand: (_cmd, _ui, value) => inserted.push(value),
    };
    const result = runInject(text, doc);
    assert.deepStrictEqual(result, { ok: true }, `ok for: ${JSON.stringify(text)}`);
    assert.deepStrictEqual(inserted, [text], `exact text for: ${JSON.stringify(text)}`);
  }
});

test('injectExpr: reports failure when no input element is found', () => {
  const out = runInject('hi', { querySelectorAll: () => [] });
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /no input candidates/);
});

test('injectExpr: targets the last candidate, where a chat input sits', () => {
  const focused = [];
  const doc = {
    querySelectorAll: () => [
      { focus: () => focused.push('first') },
      { focus: () => focused.push('last') },
    ],
    execCommand: () => {},
  };
  runInject('hi', doc);
  assert.deepStrictEqual(focused, ['last']);
});

// --- dispatchEnter --------------------------------------------------------

test('dispatchEnter: keyDown carries the modifier and text, keyUp matches', async () => {
  const sent = [];
  const client = { send: async (m, p) => sent.push({ m, p }) };
  await dispatchEnter(client, CMD_MODIFIER);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every((s) => s.m === 'Input.dispatchKeyEvent'));
  assert.strictEqual(sent[0].p.type, 'keyDown');
  assert.strictEqual(sent[0].p.modifiers, CMD_MODIFIER);
  assert.strictEqual(sent[0].p.text, '\r');
  assert.strictEqual(sent[0].p.windowsVirtualKeyCode, 13);
  assert.strictEqual(sent[1].p.type, 'keyUp');
  assert.strictEqual(sent[1].p.modifiers, CMD_MODIFIER);
});

test('dispatchEnter: type is keyDown, not rawKeyDown', () => {
  // rawKeyDown suppresses the browser's default action and needs a paired
  // char event; for Enter that means the editor never sees a real press.
  // This is the difference between "submitted" and "nothing happened".
  const sent = [];
  const client = { send: async (m, p) => sent.push(p) };
  return dispatchEnter(client, 0).then(() => {
    assert.strictEqual(sent[0].type, 'keyDown');
  });
});

// --- submit(): multi-line is line-by-line + real Enter keys ---------------
// A raw '\n' inside one insertText call does not register as a line break
// in Claude Code's rich-text input; each line is inserted separately with a
// trusted plain Enter between, then Cmd+Enter submits once at the end.
// These drive the real SessionWatcher.submit through the cdp.evaluate seam.

function watcherWithFakeCdp(t, { evaluateImpl } = {}) {
  const keys = [];
  const evaluated = [];
  t.mock.method(cdp, 'evaluate', async (client, expr, contextId) => {
    evaluated.push({ expr, contextId });
    return evaluateImpl ? evaluateImpl(expr) : { ok: true };
  });
  const w = new SessionWatcher('sid', () => {});
  w.picked = { contextId: 42 };
  w.client = {
    send: async (method, params) => {
      if (method === 'Input.dispatchKeyEvent') keys.push(params);
      return {};
    },
  };
  return { w, keys, evaluated };
}

// Recover the text argument the generated expression closes over, so these
// tests assert on what would actually be typed rather than on source text.
function insertedTextOf(expr) {
  const m = expr.match(/\}\)\((.*)\)\s*$/s);
  assert.ok(m, 'injectExpr shape changed; update this extractor');
  return JSON.parse(m[1]);
}

test('submit: a single line inserts once and submits with Cmd+Enter only', async (t) => {
  const { w, keys, evaluated } = watcherWithFakeCdp(t);
  const out = await w.submit('just one line');
  assert.deepStrictEqual(out, { ok: true });
  assert.strictEqual(evaluated.length, 1);
  assert.strictEqual(insertedTextOf(evaluated[0].expr), 'just one line');
  assert.strictEqual(evaluated[0].contextId, 42, 'evaluates in the picked content frame');
  const downs = keys.filter((k) => k.type === 'keyDown');
  assert.strictEqual(downs.length, 1, 'no line-break Enter for a single line');
  assert.strictEqual(downs[0].modifiers, CMD_MODIFIER);
});

test('submit: multi-line inserts per line with a plain Enter between, Cmd+Enter last', async (t) => {
  const { w, keys, evaluated } = watcherWithFakeCdp(t);
  const out = await w.submit('line one\nline two\nline three');
  assert.deepStrictEqual(out, { ok: true });
  assert.deepStrictEqual(
    evaluated.map((e) => insertedTextOf(e.expr)),
    ['line one', 'line two', 'line three'],
    'each line inserted separately — a raw \\n in one call does not register',
  );
  const downs = keys.filter((k) => k.type === 'keyDown');
  assert.deepStrictEqual(
    downs.map((k) => k.modifiers),
    [0, 0, CMD_MODIFIER],
    'two unmodified line breaks, then exactly one submit',
  );
  assert.strictEqual(keys.filter((k) => k.type === 'keyUp').length, 3, 'every press is released');
});

test('submit: a trailing newline still submits exactly once', async (t) => {
  const { w, keys } = watcherWithFakeCdp(t);
  await w.submit('text\n');
  const downs = keys.filter((k) => k.type === 'keyDown');
  assert.deepStrictEqual(downs.map((k) => k.modifiers), [0, CMD_MODIFIER]);
});

test('submit: a failed injection aborts before any key is dispatched', async (t) => {
  const { w, keys } = watcherWithFakeCdp(t, {
    evaluateImpl: () => ({ ok: false, reason: 'no input candidates found' }),
  });
  const out = await w.submit('hello');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /no input candidates/);
  assert.strictEqual(keys.length, 0, 'nothing submitted when the text never landed');
});

test('submit: a mid-message injection failure does not submit a partial message', async (t) => {
  let calls = 0;
  const { w, keys } = watcherWithFakeCdp(t, {
    evaluateImpl: () => (++calls === 2 ? { ok: false, reason: 'gone' } : { ok: true }),
  });
  const out = await w.submit('first\nsecond\nthird');
  assert.strictEqual(out.ok, false);
  const downs = keys.filter((k) => k.type === 'keyDown');
  assert.deepStrictEqual(
    downs.map((k) => k.modifiers),
    [0],
    'only the line break already dispatched; no Cmd+Enter submit',
  );
});

// --- reconnect after a suspend -------------------------------------------
// A closed lid leaves TCP half-open: no FIN, no RST, no 'close' event, and
// readyState stays OPEN. Every reconnect path hangs off 'close', so nothing
// notices. These pin the two pieces that make waking up recover.

function fakeSocketClass(sockets) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = {};
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners[type] || []) fn(ev || {});
    }
    send() {}
    close() {
      this.closed = true;
    }
  };
}

function withFakeSockets(t) {
  const sockets = [];
  const original = global.WebSocket;
  global.WebSocket = fakeSocketClass(sockets);
  global.WebSocket.OPEN = 1;
  t.after(() => {
    global.WebSocket = original;
  });
  return sockets;
}

test('forceReconnect dials again without waiting for a close event', async (t) => {
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  assert.strictEqual(sockets.length, 1);

  d.forceReconnect('test');
  assert.strictEqual(sockets.length, 2, 'a new socket is opened immediately');
  assert.ok(sockets[0].closed, 'the abandoned socket is closed');
});

test('an abandoned socket closing later does not schedule a second reconnect', async (t) => {
  // The half-open socket can come back to life minutes later and fire
  // close. Without the generation guard that close handler dials again on
  // top of the connection already running, and the daemon ends up with two.
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  d.forceReconnect('test');
  assert.strictEqual(sockets.length, 2);

  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sockets.length, 2, 'the stale close is ignored');
});

test('forceReconnect drops the watchers, so a fresh subscribe re-resyncs', async (t) => {
  // Watchers hold CDP sockets that the suspend killed too, and their
  // lastTurns would otherwise make the next poll look like an append.
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  const w = new SessionWatcher('sid', () => {});
  w.client = { ws: { close() {} } };
  d.watchers.set('sid', w);

  d.forceReconnect('test');
  assert.strictEqual(d.watchers.size, 0);
  assert.strictEqual(w.closed, true);
});

// A hand-driven interval plus a fake clock: these pin scheduling, and
// waiting WAKE_PROBE_MS of real time per assertion would not.
function drivenWatcher(t, daemon) {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  const realSetInterval = global.setInterval;
  const ticks = [];
  global.setInterval = (fn) => {
    ticks.push(fn);
    return { unref() {} };
  };
  t.after(() => {
    Date.now = realNow;
    global.setInterval = realSetInterval;
  });
  watchConnection(daemon);
  return {
    tick: (advanceMs) => {
      clock += advanceMs;
      ticks[0]();
    },
  };
}

function fakeDaemon(quiet = 0) {
  return {
    reconnects: [],
    pings: 0,
    quiet,
    forceReconnect(reason) {
      this.reconnects.push(reason);
    },
    msSinceInbound() {
      return this.quiet;
    },
    ping() {
      this.pings++;
    },
  };
}

test('watchConnection: a suspend is a wake, ordinary ticks are not', async (t) => {
  const d = fakeDaemon();
  const { tick } = drivenWatcher(t, d);
  tick(WAKE_PROBE_MS);
  tick(WAKE_PROBE_MS);
  assert.deepStrictEqual(d.reconnects, [], 'ordinary ticks are not a wake');
  tick(WAKE_GAP_MS + 1);
  assert.strictEqual(d.reconnects.length, 1);
  assert.match(d.reconnects[0], /suspended/);
  tick(WAKE_PROBE_MS);
  assert.strictEqual(d.reconnects.length, 1, 'and it does not keep firing');
});

test('watchConnection: pings on a cadence well under the deadline', async (t) => {
  // Otherwise an ordinary lost packet would look like a dead connection.
  assert.ok(PING_EVERY_MS * 2 <= DEAD_AFTER_MS, 'two pings must fit inside the deadline');
  const d = fakeDaemon();
  const { tick } = drivenWatcher(t, d);
  for (let i = 0; i < PING_EVERY_MS / WAKE_PROBE_MS; i++) tick(WAKE_PROBE_MS);
  assert.strictEqual(d.pings, 1);
});

test('watchConnection: silence past the deadline forces a reconnect', async (t) => {
  // The wifi black-hole: readyState stays OPEN, no close ever fires, and
  // the server's protocol pong never reaches daemon code. Inbound silence
  // is the only observable.
  const d = fakeDaemon(DEAD_AFTER_MS + 1);
  const { tick } = drivenWatcher(t, d);
  tick(WAKE_PROBE_MS);
  assert.strictEqual(d.reconnects.length, 1);
  assert.match(d.reconnects[0], /No answer from the VPS/);
});

test('watchConnection: a live connection is left alone', async (t) => {
  const d = fakeDaemon(1000);
  const { tick } = drivenWatcher(t, d);
  tick(WAKE_PROBE_MS);
  tick(WAKE_PROBE_MS);
  assert.deepStrictEqual(d.reconnects, []);
});

test('watchConnection: no socket means the reconnect loop owns it, not us', async (t) => {
  // msSinceInbound returns null while dialling. Treating that as silence
  // would fight the backoff loop with a forced reconnect every 5s.
  const d = fakeDaemon(null);
  const { tick } = drivenWatcher(t, d);
  tick(WAKE_PROBE_MS);
  tick(WAKE_PROBE_MS);
  assert.deepStrictEqual(d.reconnects, []);
  assert.strictEqual(d.pings, 0, 'and nothing is sent into a socket that is not open');
});

// --- resolveTitles: naming a conversation ---------------------------------
// Editor webviews report their Claude session uuid as data-initial-session;
// the sidebar maps that uuid to the name shown on the tab. Measured on a
// real window: three of four webviews carried the attribute.

test('resolveTitles: names a session whose uuid the sidebar knows', () => {
  const titles = resolveTitles(
    new Map([['wv-1', 'uuid-a']]),
    { 'uuid-a': 'EKP-63451' },
  );
  assert.strictEqual(titles.get('wv-1'), 'EKP-63451');
});

test('resolveTitles: a webview without the attribute gets no title', () => {
  // One of four lacked it; the phone falls back to the session id.
  const titles = resolveTitles(new Map([['wv-1', null]]), { 'uuid-a': 'EKP-1' });
  assert.strictEqual(titles.get('wv-1'), null);
});

test('resolveTitles: a uuid the sidebar does not list gets no title', () => {
  // The sidebar can be closed, or the session archived out of the list.
  const titles = resolveTitles(new Map([['wv-1', 'uuid-z']]), { 'uuid-a': 'EKP-1' });
  assert.strictEqual(titles.get('wv-1'), null);
});

test('resolveTitles: a contested uuid names neither webview', () => {
  // The attribute is data-INITIAL-session. If a webview is ever reused for
  // a second conversation its value goes stale, and that shows up as two
  // webviews claiming one uuid. Naming both would put someone else's
  // conversation title on a session; no title is the safe answer.
  const titles = resolveTitles(
    new Map([['wv-1', 'uuid-a'], ['wv-2', 'uuid-a'], ['wv-3', 'uuid-b']]),
    { 'uuid-a': 'EKP-1', 'uuid-b': 'EKP-2' },
  );
  assert.strictEqual(titles.get('wv-1'), null);
  assert.strictEqual(titles.get('wv-2'), null);
  assert.strictEqual(titles.get('wv-3'), 'EKP-2', 'an uncontested neighbour is unaffected');
});

test('resolveTitles: no sidebar at all is empty titles, not a throw', () => {
  const titles = resolveTitles(new Map([['wv-1', 'uuid-a']]), {});
  assert.strictEqual(titles.get('wv-1'), null);
});

// --- coalescing: what the phone actually pays -----------------------------
// A turn measured 98KB against a real session and the largest was 284KB.
// At the 1.5s poll rate a resync per tick is ~240MB/hour to the phone,
// which is a held-up radio and a warm battery to deliver sub-second
// latency on a reply nobody reads that fast.

test('shouldEmitNow: an append always goes out at once', () => {
  assert.ok(shouldEmitNow('append', { forced: false, becameIdle: false, msSinceResync: 0 }));
});

test('shouldEmitNow: nothing to send is never sent', () => {
  assert.ok(!shouldEmitNow('none', { forced: true, becameIdle: true, msSinceResync: 1e9 }));
});

test('shouldEmitNow: a resync inside the interval is held back', () => {
  assert.ok(!shouldEmitNow('resync', { forced: false, becameIdle: false, msSinceResync: 100 }));
});

test('shouldEmitNow: a resync past the interval goes', () => {
  assert.ok(
    shouldEmitNow('resync', {
      forced: false,
      becameIdle: false,
      msSinceResync: RESYNC_MIN_INTERVAL_MS,
    }),
  );
});

test('shouldEmitNow: the first read of a subscription is never held back', () => {
  // The server needs it to reconcile; delaying it leaves the phone on
  // stale stored content for the whole interval.
  assert.ok(shouldEmitNow('resync', { forced: true, becameIdle: false, msSinceResync: 0 }));
});

test('shouldEmitNow: the reply finishing flushes immediately', () => {
  // Otherwise a session that has gone quiet sits missing its last tokens
  // for seconds, with nothing due to arrive and prompt another poll.
  assert.ok(shouldEmitNow('resync', { forced: false, becameIdle: true, msSinceResync: 0 }));
});

test('_tick: streaming ticks are coalesced, and finishing flushes at once', async (t) => {
  const { w, events } = tickableWatcher(t, [
    snap(['a-1'], true), // first read: forced resync
    snap(['a-2'], true), // still streaming, inside the interval -> held
    snap(['a-3'], true), // held
    snap(['a-4'], false), // reply finished -> flush
  ]);
  await w._tick();
  await w._tick();
  await w._tick();
  await w._tick();
  const content = events.filter((e) => e.type !== 'state');
  assert.deepStrictEqual(
    content.map((e) => e.turns[0]),
    ['a-1', 'a-4'],
    'two sends, not four, and the last one carries the finished reply',
  );
});

test('_tick: a new turn is never delayed by coalescing', async (t) => {
  const { w, events } = tickableWatcher(t, [
    snap(['a'], true),
    snap(['a', 'b'], true), // an append lands immediately despite the interval
  ]);
  await w._tick();
  await w._tick();
  const content = events.filter((e) => e.type !== 'state');
  assert.deepStrictEqual(content.map((e) => e.type), ['resync', 'append']);
  assert.deepStrictEqual(content[1].turns, ['b']);
});

test('_tick: a held-back resync leaves the baseline alone so nothing is lost', async (t) => {
  // lastTurns must not advance on a tick that sent nothing, or the next
  // send would describe a delta against content the server never saw.
  const { w } = tickableWatcher(t, [snap(['a-1'], true), snap(['a-2'], true)]);
  await w._tick();
  await w._tick();
  assert.deepStrictEqual(w.lastTurns, ['a-1'], 'baseline still what was actually sent');
});

test('_tick: the running probe going blind is reported, not ignored', async (t) => {
  // running:null means the send-button labels stopped matching. Ignoring
  // it leaves the phone showing Running or Idle forever with no hint the
  // probe broke; the phone renders null as Unknown.
  const { w, events } = tickableWatcher(t, [snap(['a'], true), { running: null, turns: ['a'], title: null }]);
  await w._tick();
  await w._tick();
  assert.deepStrictEqual(
    events.filter((e) => e.type === 'state').map((e) => e.running),
    [true, null],
  );
});

// --- surviving VS Code going away ----------------------------------------
// Quitting VS Code closes port 9222. The fetch refuses, and before this
// the rejection escaped an async event listener and killed the process:
// "TypeError: fetch failed ... ECONNREFUSED 127.0.0.1:9222".

test('_listSessions: CDP being unreachable reports no sessions, not a throw', async (t) => {
  t.mock.method(cdp, 'listClaudeSessions', async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNREFUSED', port: 9222 };
    throw err;
  });
  const d = new Daemon();
  const out = await d._listSessions();
  assert.deepStrictEqual(out.sessions, []);
  assert.strictEqual(out.cdp, 'unreachable', 'the phone must be able to say why');
  assert.match(out.cdpError, /fetch failed/);
});

test('_listSessions: recovers on the next call once VS Code is back', async (t) => {
  // No state is kept about the outage, so "retry" is just the next call.
  let up = false;
  t.mock.method(cdp, 'listClaudeSessions', async () => {
    if (!up) throw new TypeError('fetch failed');
    return [{ sessionId: 'sid', targetId: 'T', url: 'x' }];
  });
  t.mock.method(cdp, 'readSessionNames', async () => ({}));
  t.mock.method(cdp, 'findTarget', async () => ({ webSocketDebuggerUrl: 'ws://x' }));
  t.mock.method(cdp, 'connect', async () => ({ ws: { close() {} }, send: async () => ({}) }));
  t.mock.method(cdp, 'getFrames', async () => []);
  t.mock.method(cdp, 'pickContentFrame', async () => null);

  const d = new Daemon();
  assert.strictEqual((await d._listSessions()).cdp, 'unreachable');
  up = true;
  const back = await d._listSessions();
  assert.strictEqual(back.cdp, 'ok');
  assert.deepStrictEqual(back.sessions.map((s) => s.sessionId), ['sid']);
});

test('a rejecting message handler is caught instead of crashing the process', async (t) => {
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  // Reject from inside the handler rather than from a CDP call: every CDP
  // entry point is individually guarded, so a test that leans on one of
  // them passes whether or not this listener catches anything. The point
  // here is the listener itself — any future rejection, from any branch.
  d._listSessions = async () => {
    throw new Error('boom');
  };

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  sockets[0].emit('message', { data: JSON.stringify({ type: 'list_sessions', reqId: 1 }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(unhandled, [], 'nothing escapes the listener');
});

// --- learned titles: the fallback for restored webviews -------------------
// data-initial-session is written only when a webview first mounts with a
// session to open. VS Code restoring tabs after a restart does not write
// it, and then nothing in the webview carries the session id — measured
// live as "titles: 0/6 named (sidebar rows=20, webviews with a session
// uuid=0)" with the picked frame holding 286 transcript messages, so the
// frame was right and the attribute was simply gone.

function listableDaemon(t, { targets, names = {}, pair = null }) {
  t.mock.method(cdp, 'listClaudeSessions', async () => targets);
  t.mock.method(cdp, 'readSessionNames', async () => names);
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => pair);
  t.mock.method(cdp, 'findTarget', async () => ({ webSocketDebuggerUrl: 'ws://x' }));
  t.mock.method(cdp, 'connect', async () => ({ ws: { close() {} }, send: async () => ({}) }));
  t.mock.method(cdp, 'getFrames', async () => []);
  t.mock.method(cdp, 'pickContentFrame', async () => null);
  return new Daemon();
}

test('_listSessions: the active tab names its webview when the attribute is gone', async (t) => {
  const d = listableDaemon(t, {
    targets: [{ sessionId: 'wv-1', targetId: 'T1', url: 'u' }],
    pair: { webviewId: 'wv-1', title: 'EKP-63451' },
  });
  const [s] = (await d._listSessions()).sessions;
  assert.strictEqual(s.title, 'EKP-63451');
});

test('_listSessions: a learned title survives the session leaving the screen', async (t) => {
  // The whole point of caching it: you switch to another tab and the
  // first one keeps its name.
  const d = listableDaemon(t, {
    targets: [
      { sessionId: 'wv-1', targetId: 'T1', url: 'u' },
      { sessionId: 'wv-2', targetId: 'T2', url: 'u' },
    ],
    pair: { webviewId: 'wv-1', title: 'EKP-63451' },
  });
  await d._listSessions();
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => ({
    webviewId: 'wv-2',
    title: 'EKP-63466',
  }));
  const out = (await d._listSessions()).sessions;
  assert.deepStrictEqual(
    out.map((s) => s.title),
    ['EKP-63451', 'EKP-63466'],
    'both named once each has been on screen',
  );
});

test('_listSessions: an ambiguous workbench teaches nothing', async (t) => {
  // readActiveWebviewTitle returns null with split editor groups, where
  // several tabs are selected and several webviews visible. Guessing a
  // pairing there is how a session gets someone else's name.
  const d = listableDaemon(t, {
    targets: [{ sessionId: 'wv-1', targetId: 'T1', url: 'u' }],
    pair: null,
  });
  const [s] = (await d._listSessions()).sessions;
  assert.strictEqual(s.title, null);
  assert.strictEqual(d.learnedTitles.size, 0);
});

test('_listSessions: no session uuid means the sidebar is not read at all', async (t) => {
  // resolveTitles can only look a uuid up, so with none reported the
  // sidebar table is unusable — and reading it costs a CDP connect and an
  // evaluate per listing. After VS Code restores tabs, that is every
  // listing.
  let sidebarReads = 0;
  const d = listableDaemon(t, { targets: [{ sessionId: 'wv-1', targetId: 'T1', url: 'u' }] });
  t.mock.method(cdp, 'readSessionNames', async () => {
    sidebarReads++;
    return {};
  });
  await d._listSessions();
  assert.strictEqual(sidebarReads, 0);
});

test('_listSessions: a reported uuid does read the sidebar', async (t) => {
  let sidebarReads = 0;
  const d = listableDaemon(t, { targets: [{ sessionId: 'wv-1', targetId: 'T1', url: 'u' }] });
  t.mock.method(cdp, 'pickContentFrame', async () => ({ contextId: 1 }));
  t.mock.method(cdp, 'evaluate', async () => ({ turns: [], running: false, sessionUuid: 'u-1' }));
  t.mock.method(cdp, 'readSessionNames', async () => {
    sidebarReads++;
    return { 'u-1': 'EKP-63451' };
  });
  const [s] = (await d._listSessions()).sessions;
  assert.strictEqual(sidebarReads, 1);
  assert.strictEqual(s.title, 'EKP-63451');
});

test('Daemon: msSinceInbound is null until the socket is open and has spoken', async (t) => {
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  assert.strictEqual(d.msSinceInbound(), null, 'no socket at all');
  d.connect();
  sockets[0].emit('open');
  const quiet = d.msSinceInbound();
  assert.ok(quiet !== null && quiet < 1000, 'open starts the clock, not message #1');
});

test('Daemon: any inbound frame resets the liveness clock', async (t) => {
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  sockets[0].emit('open');
  d.lastInboundAt = Date.now() - 50_000;
  assert.ok(d.msSinceInbound() > 40_000);
  sockets[0].emit('message', { data: JSON.stringify({ type: 'pong' }) });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(d.msSinceInbound() < 1000, 'the pong is the answer the deadline waits for');
});

// --- subscribing while VS Code is down ------------------------------------
// Reachable on every wake: the daemon redials in ~5s and the server
// immediately re-issues subscribe for whatever the phone still has open,
// usually before VS Code's debug port is listening again.

test('subscribe with 9222 down keeps the watcher and keeps polling', async (t) => {
  const sockets = withFakeSockets(t);
  t.mock.method(cdp, 'findTarget', async () => {
    throw new TypeError('fetch failed');
  });
  const d = new Daemon();
  d.connect();
  sockets[0].emit('open');

  await d._handleMessage(JSON.stringify({ type: 'subscribe', sessionId: 'sid' }));
  const w = d.watchers.get('sid');
  assert.ok(w, 'the subscription survives a failed first attach');
  assert.ok(w.timer, 'and its poll loop is running, which is what retries the attach');
  w.close();
});

test('subscribe with 9222 down reports the failure once, not once per poll', async (t) => {
  const sent = [];
  t.mock.method(cdp, 'findTarget', async () => {
    throw new TypeError('fetch failed');
  });
  const w = new SessionWatcher('sid', (e) => sent.push(e));
  t.after(() => w.close());

  await w.start();
  await w._tick();
  await w._tick();
  assert.deepStrictEqual(
    sent.filter((e) => e.type === 'error').length,
    1,
    'an outage is one event, not one every 1.5s',
  );
});

test('a watcher that reattaches reports the next outage again', async (t) => {
  const sent = [];
  let up = false;
  t.mock.method(cdp, 'findTarget', async () => {
    if (!up) throw new TypeError('fetch failed');
    return { webSocketDebuggerUrl: 'ws://x' };
  });
  t.mock.method(cdp, 'connect', async () => ({ ws: { close() {} }, send: async () => ({}) }));
  t.mock.method(cdp, 'getFrames', async () => []);
  t.mock.method(cdp, 'pickContentFrame', async () => ({ contextId: 1 }));
  t.mock.method(cdp, 'evaluate', async () => ({ turns: [], running: false }));

  const w = new SessionWatcher('sid', (e) => sent.push(e));
  t.after(() => w.close());
  await w.start();
  assert.strictEqual(w.attachFailed, true);

  up = true;
  await w._tick(); // reattaches
  assert.strictEqual(w.attachFailed, false, 'the flag clears so a later outage is visible');
});

// --- driving Claude Code's own UI ----------------------------------------
// The expressions are strings evaluated in the webview, so they are tested
// the way injectExpr is: run them with `new Function` against a fake DOM
// and assert what they did. That covers the part with judgment in it —
// which element is chosen, and when the answer is "refuse".

function runExpr(expr, document) {
  // eslint-disable-next-line no-new-func
  return new Function('document', `return (${expr});`)(document);
}

function fakeDom(nodes) {
  // nodes: [{cls, text, disabled, children:{childCls:text}}]
  const els = nodes.map((n) => ({
    className: n.cls,
    textContent: n.text,
    disabled: !!n.disabled,
    clicked: 0,
    getAttribute(name) {
      if (name === 'aria-label') return n.label || null;
      if (name === 'title') return n.title || null;
      return null;
    },
    // A flat bag has no real containment; every element "contains" the
    // whole bag so the flat tests keep working, and the cases that turn
    // on containment build their own DOM below.
    contains: () => true,
    click() {
      this.clicked++;
    },
    querySelectorAll(sel) {
      const want = sel.match(/class\*="([^"]+)"/)[1];
      return els.filter((e) => e.className.includes(want));
    },
    querySelector(sel) {
      const want = sel.match(/class\*="([^"]+)"/)[1];
      const hit = Object.entries(n.children || {}).find(([c]) => c.includes(want));
      return hit ? { textContent: hit[1] } : null;
    },
  }));
  const find = (sel) => {
    const want = sel.match(/class\*="([^"]+)"/)[1];
    return els.filter((e) => e.className.includes(want));
  };
  // A single root every element hangs off, so the "walk up to the panel
  // that owns this title, then query inside it" logic has something to
  // walk. A flat bag of elements would pass a scoping check vacuously,
  // which is the bug that check exists to catch.
  const root = {
    className: 'root',
    parentElement: null,
    contains: () => true,
    querySelectorAll: (sel) => find(sel),
    querySelector: (sel) => find(sel)[0] || null,
  };
  for (const el of els) el.parentElement = root;
  return {
    els,
    root,
    querySelectorAll: (sel) => find(sel),
    querySelector: (sel) => find(sel)[0] || null,
  };
}

test('clickByText: clicks the one whose visible text matches exactly', () => {
  const dom = fakeDom([
    { cls: 'actionButton_IHCQeQ', text: 'Disable' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
    { cls: 'actionButton_IHCQeQ dangerButton_IHCQeQ', text: 'Remove' },
  ]);
  const out = runExpr(clickByText('actionButton_', 'Reconnect'), dom);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 1, 0], 'only Reconnect');
});

test('clickByText: a missing control reports what it saw instead of guessing', () => {
  const dom = fakeDom([{ cls: 'actionButton_IHCQeQ', text: 'Authenticate' }]);
  const out = runExpr(clickByText('actionButton_', 'Reconnect'), dom);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.seen, ['Authenticate']);
});

test('clickByText: a disabled control is not clicked', () => {
  const dom = fakeDom([{ cls: 'actionButton_IHCQeQ', text: 'Reconnect', disabled: true }]);
  const out = runExpr(clickByText('actionButton_', 'Reconnect'), dom);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(dom.els[0].clicked, 0);
});

test('clickReconnectFor: refuses when the detail view is another server', () => {
  // The whole point of verifying first. "Remove" and "Clear
  // authentication" sit in this same row, and reconnecting the wrong
  // server is not something a phone can undo.
  const dom = fakeDom([
    { cls: 'detailTitle_IHCQeQ', text: 'github' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
  ]);
  const out = runExpr(clickReconnectFor('jira-ghe'), dom);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /shows "github", not "jira-ghe"/);
  assert.strictEqual(dom.els[1].clicked, 0, 'nothing was clicked');
});

test('clickReconnectFor: clicks once the title matches', () => {
  const dom = fakeDom([
    { cls: 'detailTitle_IHCQeQ', text: 'jira-ghe' },
    { cls: 'detailActions_IHCQeQ', text: '' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
    { cls: 'actionButton_IHCQeQ dangerButton_IHCQeQ', text: 'Remove' },
  ]);
  const out = runExpr(clickReconnectFor('jira-ghe'), dom);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 0, 1, 0]);
});

test('clickReconnectFor: the hop cap is not a containment proof', () => {
  // The title sits deeper than the walk can climb, so the loop runs out
  // of hops rather than finding the panel. Reading a non-null `panel` as
  // "found it" clicks a Reconnect the title was never shown to own.
  const mkEl = (className, textContent, kids) => {
    const el = {
      className,
      textContent,
      disabled: false,
      clicked: 0,
      kids: kids || [],
      click() { this.clicked++; },
      getAttribute: () => null,
      contains(other) {
        if (other === this) return true;
        return this.kids.some((k) => k.contains(other));
      },
      querySelectorAll(sel) {
        const want = sel.match(/class\*="([^"]+)"/)[1];
        const out = [];
        const walk = (n) => {
          for (const k of n.kids) {
            if (k.className.includes(want)) out.push(k);
            walk(k);
          }
        };
        walk(this);
        return out;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    for (const k of el.kids) k.parentElement = el;
    return el;
  };
  const title = mkEl('detailTitle_IHCQeQ', 'jira-ghe');
  // Twelve wrappers: more than the eight the walk is allowed.
  let nested = title;
  for (let i = 0; i < 12; i += 1) nested = mkEl(`wrap_${i}`, '', [nested]);
  const btn = mkEl('actionButton_IHCQeQ', 'Reconnect');
  const actions = mkEl('detailActions_IHCQeQ', '', [btn]);
  const root = mkEl('root', '', [nested, actions]);
  const doc = {
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
  };
  const out = runExpr(clickReconnectFor('jira-ghe'), doc);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /gave up 8 levels above the title/);
  assert.strictEqual(btn.clicked, 0);
});

test('clickReconnectFor: refuses when there is no detail view at all', () => {
  const dom = fakeDom([{ cls: 'actionButton_IHCQeQ', text: 'Reconnect' }]);
  const out = runExpr(clickReconnectFor('jira-ghe'), dom);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(dom.els[0].clicked, 0);
});

test('clickServerRow: matches on the name child, clicks the row', () => {
  const dom = fakeDom([
    { cls: 'serverItem_IHCQeQ', text: 'github Connected', children: { serverName_: 'github' } },
    { cls: 'serverItem_IHCQeQ', text: 'jira-ghe Failed', children: { serverName_: 'jira-ghe' } },
  ]);
  const out = runExpr(clickServerRow('jira-ghe'), dom);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 1]);
});

test('clickServerRow: an unknown name lists what is there', () => {
  const dom = fakeDom([
    { cls: 'serverItem_IHCQeQ', text: 'github', children: { serverName_: 'github' } },
  ]);
  const out = runExpr(clickServerRow('nope'), dom);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.seen, ['github']);
});

test('MCP_STATE_EXPR: reads the list view', () => {
  const dom = fakeDom([
    { cls: 'serverItem_IHCQeQ', text: '', children: { serverName_: 'github', statusBadge_: 'Connected' } },
    { cls: 'serverItem_IHCQeQ', text: '', children: { serverName_: 'jira-ghe', statusBadge_: 'Failed' } },
  ]);
  const out = runExpr(MCP_STATE_EXPR, dom);
  assert.strictEqual(out.panel, 'list');
  assert.deepStrictEqual(out.rows, [
    { name: 'github', status: 'Connected' },
    { name: 'jira-ghe', status: 'Failed' },
  ]);
});

test('MCP_STATE_EXPR: a detail view outranks the rows behind it', () => {
  const dom = fakeDom([
    { cls: 'detailTitle_IHCQeQ', text: 'jira-ghe' },
    { cls: 'serverItem_IHCQeQ', text: '', children: { serverName_: 'github' } },
  ]);
  const out = runExpr(MCP_STATE_EXPR, dom);
  assert.strictEqual(out.panel, 'detail');
  assert.strictEqual(out.title, 'jira-ghe');
});

test('MCP_STATE_EXPR: no panel is "none", not an empty list', () => {
  assert.strictEqual(runExpr(MCP_STATE_EXPR, fakeDom([])).panel, 'none');
});

test('NEW_SESSION_EXPR: says the panel is closed rather than silently doing nothing', () => {
  const out = runExpr(NEW_SESSION_EXPR, fakeDom([]));
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /Claude Code panel open\?/);
});

test('NEW_SESSION_EXPR: clicks the sidebar button when it is there', () => {
  const dom = fakeDom([{ cls: 'newSessionButton_djirOA', text: 'New session' }]);
  assert.strictEqual(runExpr(NEW_SESSION_EXPR, dom).ok, true);
  assert.strictEqual(dom.els[0].clicked, 1);
});

test('clickByText: exact text, not a substring', () => {
  // "Reconnecting…" starts with "Reconnect", and the command menu can
  // hold several entries sharing a prefix. A loose match would click the
  // in-flight button or the wrong command.
  const dom = fakeDom([
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect all servers' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
  ]);
  const out = runExpr(clickByText('actionButton_', 'Reconnect'), dom);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 1], 'the exact one');
});

test('clickByText: an in-flight Reconnecting… is not mistaken for Reconnect', () => {
  const dom = fakeDom([{ cls: 'actionButton_IHCQeQ', text: 'Reconnecting…', disabled: true }]);
  const out = runExpr(clickByText('actionButton_', 'Reconnect'), dom);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(dom.els[0].clicked, 0);
});

// --- picking /mcp out of the command menu ---------------------------------
// The first attempt opened the menu with its button and looked for an item
// whose text was exactly "/mcp". It failed with "no /mcp entry", which is
// why the matching is now tolerant and a failure reports the labels.

test('CLICK_MCP_COMMAND_EXPR: matches the label however it is written', () => {
  for (const label of ['/mcp', 'mcp', '/mcp ', '/MCP']) {
    const dom = fakeDom([
      { cls: 'commandItem_G_S7FQ', text: '', children: { commandLabel_: '/clear' } },
      { cls: 'commandItem_G_S7FQ', text: '', children: { commandLabel_: label } },
    ]);
    const out = runExpr(CLICK_MCP_COMMAND_EXPR, dom);
    assert.strictEqual(out.ok, true, `label ${JSON.stringify(label)}`);
    assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 1]);
  }
});

test('CLICK_MCP_COMMAND_EXPR: ignores a longer command that merely starts with mcp', () => {
  // A loose startsWith would click the wrong command; the label is
  // compared as its first whitespace-delimited token.
  const dom = fakeDom([
    { cls: 'commandItem_G_S7FQ', text: '', children: { commandLabel_: '/mcp-debug' } },
  ]);
  const out = runExpr(CLICK_MCP_COMMAND_EXPR, dom);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(dom.els[0].clicked, 0);
});

test('CLICK_MCP_COMMAND_EXPR: a miss reports the labels it saw', () => {
  // The only way the next attempt is informed rather than another guess.
  const dom = fakeDom([
    { cls: 'commandItem_G_S7FQ', text: '', children: { commandLabel_: '/clear' } },
    { cls: 'commandItem_G_S7FQ', text: '', children: { commandLabel_: '/compact' } },
  ]);
  const out = runExpr(CLICK_MCP_COMMAND_EXPR, dom);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.seen, ['/clear', '/compact']);
});

test('CLICK_MCP_COMMAND_EXPR: takes the label child, not the whole row text', () => {
  // The row also carries a description; matching on row text would miss.
  const dom = fakeDom([
    {
      cls: 'commandItem_G_S7FQ',
      text: '/mcp Manage MCP servers and authentication',
      children: { commandLabel_: '/mcp' },
    },
  ]);
  assert.strictEqual(runExpr(CLICK_MCP_COMMAND_EXPR, dom).ok, true);
});

// --- every DOM expression must at least parse -----------------------------
// These are strings assembled inside template literals and evaluated in a
// browser, so a backslash is processed twice: `\/` in the source reaches
// the page as `/`, which turned the regex /^\// into /^// and made the
// whole expression a syntax error at the moment it ran. Nothing upstream
// catches that — `node --check` sees a valid string, and the failure
// surfaces as an unhelpful CDP exception on someone's phone.

test('every DOM expression parses as JavaScript', () => {
  const daemon = require('../client/daemon.js');
  const fixed = [
    'POLL_EXPR',
    'MCP_STATE_EXPR',
    'MENU_STATE_EXPR',
    'CLICK_MCP_COMMAND_EXPR',
    'CLEAR_COMPOSER_EXPR',
    'RECONNECT_BUSY_EXPR',
    'NEW_SESSION_EXPR',
  ];
  for (const name of fixed) {
    assert.ok(daemon[name], `${name} is exported`);
    assert.doesNotThrow(
      // eslint-disable-next-line no-new-func
      () => new Function('document', `return (${daemon[name]});`),
      `${name} does not parse`,
    );
  }
  // The generated ones, with arguments that carry characters worth
  // escaping badly.
  const nasty = 'a"b\'c\\d\ne`f${g}';
  for (const [name, expr] of [
    ['clickByText', daemon.clickByText('x_', nasty)],
    ['clickServerRow', daemon.clickServerRow(nasty)],
    ['clickReconnectFor', daemon.clickReconnectFor(nasty)],
    ['injectExpr', daemon.injectExpr(nasty)],
  ]) {
    assert.doesNotThrow(
      // eslint-disable-next-line no-new-func
      () => new Function('document', `return (${expr});`),
      `${name} does not parse`,
    );
  }
});

// --- closing the panel ----------------------------------------------------
// The first version matched the close control on textContent. It is an
// icon button, so its textContent is empty and the match never hit: every
// action left the MCP panel open on the laptop.

test('clickByName: finds a control by aria-label when it has no text', () => {
  const dom = fakeDom([{ cls: 'iconButton_YKLzCw', text: '', label: 'Close' }]);
  const out = runExpr(clickByName('iconButton_', 'Close'), dom);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(dom.els[0].clicked, 1);
});

test('clickByName: falls back to title, then to text', () => {
  const byTitle = fakeDom([{ cls: 'iconButton_x', text: '', title: 'Close' }]);
  assert.strictEqual(runExpr(clickByName('iconButton_', 'Close'), byTitle).ok, true);
  const byText = fakeDom([{ cls: 'iconButton_x', text: 'Close' }]);
  assert.strictEqual(runExpr(clickByName('iconButton_', 'Close'), byText).ok, true);
});

test('clickByName: a miss reports the names it saw', () => {
  const dom = fakeDom([{ cls: 'iconButton_x', text: '', label: 'Settings' }]);
  const out = runExpr(clickByName('iconButton_', 'Close'), dom);
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.seen, ['Settings']);
  assert.strictEqual(dom.els[0].clicked, 0);
});

test('clickByText would not have found the icon button — the reason clickByName exists', () => {
  const dom = fakeDom([{ cls: 'iconButton_YKLzCw', text: '', label: 'Close' }]);
  assert.strictEqual(runExpr(clickByText('iconButton_', 'Close'), dom).ok, false);
  assert.strictEqual(dom.els[0].clicked, 0);
});

// --- round 8: acting on the wrong thing, and calling it success ----------

test('clickServerRow: two rows with the same trimmed name are not actionable', () => {
  // The name is trimmed for display and comes back as the request, so
  // "alpha" and " alpha " arrive indistinguishable. Clicking the first
  // would reconnect whichever rendered earlier, not the one tapped.
  const dom = fakeDom([
    { cls: 'serverItem_IHCQeQ', text: '', children: { serverName_: 'alpha' } },
    { cls: 'serverItem_IHCQeQ', text: '', children: { serverName_: 'alpha' } },
  ]);
  const out = runExpr(clickServerRow('alpha'), dom);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /more than one server/);
  assert.deepStrictEqual(dom.els.map((e) => e.clicked), [0, 0]);
});

test('clickReconnectFor: refuses when several detail views are mounted', () => {
  const dom = fakeDom([
    { cls: 'detailTitle_IHCQeQ', text: 'jira-ghe' },
    { cls: 'detailTitle_IHCQeQ', text: 'github' },
    { cls: 'detailActions_IHCQeQ', text: '' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
  ]);
  const out = runExpr(clickReconnectFor('jira-ghe'), dom);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /more than one detail view/);
  assert.strictEqual(dom.els[3].clicked, 0);
});

test('clickReconnectFor: refuses when the title has no actions around it', () => {
  // Verifying a document-wide title and then clicking a document-wide
  // button checks one element and acts on another. Without a container
  // holding both, there is nothing to act on.
  const dom = fakeDom([
    { cls: 'detailTitle_IHCQeQ', text: 'jira-ghe' },
    { cls: 'actionButton_IHCQeQ', text: 'Reconnect' },
  ]);
  const out = runExpr(clickReconnectFor('jira-ghe'), dom);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(dom.els[1].clicked, 0);
});

test('CLEAR_COMPOSER_EXPR: judges the composer, not execCommand\'s answer', () => {
  // This editor returns false from selectAll and performs it anyway.
  // Trusting the return value made every MCP action fail with
  // "selectAll refused" on a flow that had been working, so what is left
  // in the composer is the only thing consulted.
  const cleared = { value: 'draft', focus() {}, innerHTML: 'draft' };
  const lying = {
    querySelectorAll: () => [cleared],
    execCommand: (cmd) => {
      if (cmd === 'delete') cleared.value = '';
      return false; // refuses on paper, works in fact
    },
  };
  assert.strictEqual(runExpr(CLEAR_COMPOSER_EXPR, lying).ok, true);

  const stuck = { value: 'still here', focus() {}, innerHTML: '' };
  const useless = { querySelectorAll: () => [stuck], execCommand: () => true };
  const out = runExpr(CLEAR_COMPOSER_EXPR, useless);
  assert.strictEqual(out.ok, false, 'text left behind is the failure, whatever was returned');
  assert.match(out.reason, /still holds text/);
});

test('MENU_STATE_EXPR: only a draft with a line break is unrestorable', () => {
  // The question is whether a plain-text round trip reproduces what is
  // there, not whether the markup looks rich. A contenteditable wraps
  // even one typed line as <p>hello</p>, so testing the HTML refused
  // every non-empty draft — including all the restorable ones.
  //
  // innerText is what makes the real distinction visible: it renders
  // <p>a</p><p>b</p> with a line break between them, where textContent
  // would have flattened it to "ab" and hidden the problem.
  const editor = (innerText, innerHTML) => ({
    querySelectorAll: (sel) => (sel.includes('commandItem_') ? [] : [{ innerText, innerHTML }]),
  });
  const textarea = (value) => ({
    querySelectorAll: (sel) => (sel.includes('commandItem_') ? [] : [{ value }]),
  });

  const oneLine = runExpr(MENU_STATE_EXPR, editor('hello', '<p>hello</p>'));
  assert.strictEqual(oneLine.draft, 'hello');
  assert.strictEqual(oneLine.structured, false, 'a single wrapped line is restorable');

  const empty = runExpr(MENU_STATE_EXPR, editor('', '<p><br></p>'));
  assert.strictEqual(empty.structured, false, 'an untouched editor is not a draft');

  assert.strictEqual(
    runExpr(MENU_STATE_EXPR, editor('a\nb', '<p>a</p><p>b</p>')).structured,
    true,
    'two paragraphs cannot survive a plain-text round trip',
  );
  assert.strictEqual(runExpr(MENU_STATE_EXPR, textarea('plain')).structured, false);
  assert.strictEqual(runExpr(MENU_STATE_EXPR, textarea('a\nb')).structured, true);
});

// --- the queue ------------------------------------------------------------

test('SessionQueue: operations on one session run one at a time', async () => {
  const q = new SessionQueue();
  const order = [];
  const slow = () =>
    q.run('s', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
    });
  const fast = () =>
    q.run('s', async () => {
      order.push('b-start');
      order.push('b-end');
    });
  await Promise.all([slow(), fast()]);
  assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'], 'no interleaving');
});

test('SessionQueue: different sessions do not block each other', async () => {
  const q = new SessionQueue();
  const order = [];
  await Promise.all([
    q.run('s1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('slow');
    }),
    q.run('s2', async () => {
      order.push('fast');
    }),
  ]);
  assert.deepStrictEqual(order, ['fast', 'slow']);
});

test('SessionQueue: a rejection does not poison the chain', async () => {
  const q = new SessionQueue();
  await assert.rejects(() => q.run('s', async () => { throw new Error('boom'); }));
  assert.strictEqual(await q.run('s', async () => 'still works'), 'still works');
});

test('submit: a failed submitting keystroke is flagged as dispatched', async (t) => {
  // keyDown may already have submitted, so the caller must not retry.
  const { w } = watcherWithFakeCdp(t);
  w.client.send = async (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.modifiers === CMD_MODIFIER) {
      throw new Error('connection lost');
    }
    return {};
  };
  const out = await w.submit('hello');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.dispatched, true, 'so newSession reports uncertainty instead of resending');
});

test('_mcpSessionId: refuses rather than picking one when the active view is ambiguous', async (t) => {
  // pickUniquePair returns null on split editor groups precisely because
  // the pairing would be a guess. Turning that into "use the first
  // target" reconnects a different session's MCP client while every
  // later check passes inside the wrong session.
  t.mock.method(cdp, 'listClaudeSessions', async () => [
    { sessionId: 'wv-1' },
    { sessionId: 'wv-2' },
  ]);
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => null);
  const out = await new Daemon()._mcpSessionId();
  assert.strictEqual(out.sessionId, undefined);
  assert.match(out.error, /cannot tell which conversation/);
  // And the refusal is answerable: without the candidates it is a dead
  // end, because the MCP controls live on the list screen and the state
  // it asks the author to fix is at the laptop they are away from.
  assert.deepStrictEqual(out.candidates.map((c) => c.sessionId), ['wv-1', 'wv-2']);
});

test('_mcpSessionId: a conversation named by the phone is used as given', async (t) => {
  t.mock.method(cdp, 'listClaudeSessions', async () => [
    { sessionId: 'wv-1' },
    { sessionId: 'wv-2' },
  ]);
  let asked = false;
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => {
    asked = true;
    return null;
  });
  const out = await new Daemon()._mcpSessionId('wv-2');
  assert.strictEqual(out.sessionId, 'wv-2');
  assert.strictEqual(asked, false, 'naming one skips the disambiguation entirely');
});

test('_mcpSessionId: a named conversation that has since closed is refused, not guessed', async (t) => {
  t.mock.method(cdp, 'listClaudeSessions', async () => [{ sessionId: 'wv-1' }]);
  const out = await new Daemon()._mcpSessionId('wv-gone');
  assert.strictEqual(out.sessionId, undefined);
  assert.match(out.error, /no longer open/);
});

test('_mcpSessionId: a single session needs no disambiguation', async (t) => {
  t.mock.method(cdp, 'listClaudeSessions', async () => [{ sessionId: 'only' }]);
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => null);
  assert.strictEqual((await new Daemon()._mcpSessionId()).sessionId, 'only');
});

test('_mcpSessionId: an unambiguous active view is used', async (t) => {
  t.mock.method(cdp, 'listClaudeSessions', async () => [
    { sessionId: 'wv-1' },
    { sessionId: 'wv-2' },
  ]);
  t.mock.method(cdp, 'readActiveWebviewTitle', async () => ({ webviewId: 'wv-2', title: 'x' }));
  assert.strictEqual((await new Daemon()._mcpSessionId()).sessionId, 'wv-2');
});

test('clickReconnectFor: a Reconnect button outside the verified panel is not clicked', () => {
  // The scoping check, with a DOM that can actually tell the difference:
  // an exact-text Reconnect in another mounted section, and the real one
  // inside the panel that owns the verified title.
  const outside = { className: 'actionButton_IHCQeQ', textContent: 'Reconnect', disabled: false, clicked: 0, click() { this.clicked++; }, getAttribute: () => null };
  const inside = { className: 'actionButton_IHCQeQ', textContent: 'Reconnect', disabled: false, clicked: 0, click() { this.clicked++; }, getAttribute: () => null };
  const sel = (nodes) => (s) => {
    const want = s.match(/class\*="([^"]+)"/)[1];
    return nodes.filter((n) => n.className.includes(want));
  };
  // The actions row holds only the button that belongs to it — which is
  // the whole point: a flat fake cannot tell a scoped query from a
  // document-wide one, so a passing scope test would mean nothing.
  const actions = {
    className: 'detailActions_IHCQeQ',
    textContent: '',
    getAttribute: () => null,
    contains: (x) => x === inside,
    querySelectorAll: (s) => sel([inside])(s),
    querySelector: (s) => sel([inside])(s)[0] || null,
  };
  const panelNodes = [actions, inside];
  const panel = {
    className: 'detailPanel_IHCQeQ',
    parentElement: null,
    contains: (x) => panelNodes.includes(x),
    querySelectorAll: (s) => sel(panelNodes)(s),
    querySelector: (s) => sel(panelNodes)(s)[0] || null,
  };
  const title = {
    className: 'detailTitle_IHCQeQ',
    textContent: 'jira-ghe',
    parentElement: panel,
    getAttribute: () => null,
    contains: (x) => x === title,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const all = [title, actions, inside, outside];
  const doc = {
    querySelectorAll: (s) => sel(all)(s),
    querySelector: (s) => sel(all)(s)[0] || null,
  };
  const out = runExpr(clickReconnectFor('jira-ghe'), doc);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(inside.clicked, 1, 'the one inside the verified panel');
  assert.strictEqual(outside.clicked, 0, 'and nothing else');
});

// --- round 9: the fixes that were not complete ---------------------------

test('SessionQueue: a long action marks the session busy, a short one does not', async () => {
  const q = new SessionQueue();
  let observedDuringLong = null;
  const long = q.runLong('s', async () => {
    observedDuringLong = q.isBusy('s');
    await new Promise((r) => setTimeout(r, 20));
  });
  await long;
  assert.strictEqual(observedDuringLong, true);
  assert.strictEqual(q.isBusy('s'), false, 'cleared when it finishes');

  await q.run('s2', async () => {
    assert.strictEqual(q.isBusy('s2'), false, 'an ordinary submit is not "busy"');
  });
});

test('SessionQueue: a second long action is refused, not queued behind the first', async () => {
  // A Set holds one entry per session however many holders it has. Two
  // overlapping long actions share it, and the first to finish clears it
  // while the second is still driving the composer — isBusy then reports
  // idle and a submit types into the middle of an MCP flow.
  const q = new SessionQueue();
  let released;
  const first = q.runLong('s', () => new Promise((r) => { released = r; }));
  // Bounded, because the defect makes the second call queue behind a
  // holder that is still running: awaiting it plainly would signal by
  // hanging until the runner's timeout, which reads like a stuck suite
  // rather than a failed assertion.
  const second = await Promise.race([
    q.runLong('s', async () => {
      throw new Error('the second action must not run');
    }),
    new Promise((r) => setTimeout(() => r({ queued: true }), 60)),
  ]);
  assert.ok(!second.queued, 'the second long action queued instead of being refused');
  assert.strictEqual(second.ok, false);
  assert.match(second.error, /already driving Claude Code/);
  assert.strictEqual(q.isBusy('s'), true, 'the refusal did not disturb the holder');

  released();
  await first;
  assert.strictEqual(q.isBusy('s'), false);
  // And the refusal must not have consumed the session's turn.
  assert.strictEqual((await q.runLong('s', async () => ({ ok: true }))).ok, true);
});

test('SessionQueue: the first long action still holds the session after a refusal', async () => {
  const q = new SessionQueue();
  let released;
  const first = q.runLong('s', () => new Promise((r) => { released = r; }));
  await Promise.race([
    q.runLong('s', async () => ({ ok: true })),
    new Promise((r) => setTimeout(r, 60)),
  ]);
  // The refused caller's finally must not have cleared the holder's flag.
  assert.strictEqual(q.isBusy('s'), true);
  released();
  await first;
});

test('SessionQueue: busy clears even when the long action throws', async () => {
  const q = new SessionQueue();
  await assert.rejects(() => q.runLong('s', async () => { throw new Error('boom'); }));
  assert.strictEqual(q.isBusy('s'), false);
});

test('MCP_STATE_EXPR: an open list with no servers is a list, not "no panel"', () => {
  // Using row count as the marker made an empty panel indistinguishable
  // from no panel, so opening one timed out and the phone was told it
  // failed to open instead of being shown its own empty state.
  const dom = fakeDom([{ cls: 'serverList_IHCQeQ', text: '' }]);
  const out = runExpr(MCP_STATE_EXPR, dom);
  assert.strictEqual(out.panel, 'list');
  assert.deepStrictEqual(out.rows, []);
});


test('clickReconnectFor: refuses a second action row even with one title', () => {
  // The shared-ancestor case, with only one title in the document so the
  // earlier multiple-titles check cannot catch it. The first version of
  // this test refused for that wrong reason and so proved nothing: the
  // walk would have reached a root holding a sibling panel's button.
  const mkEl = (className, textContent) => ({
    className,
    textContent,
    disabled: false,
    clicked: 0,
    click() { this.clicked++; },
    getAttribute: () => null,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  const title = mkEl('detailTitle_IHCQeQ', 'jira-ghe');
  const mine = mkEl('detailActions_IHCQeQ', '');
  const sibling = mkEl('detailActions_IHCQeQ', '');
  const btn = mkEl('actionButton_IHCQeQ', 'Reconnect');
  const all = [title, mine, sibling, btn];
  const sel = (s) => {
    const want = s.match(/class\*="([^"]+)"/)[1];
    return all.filter((n) => n.className.includes(want));
  };
  const doc = { querySelectorAll: sel, querySelector: (s) => sel(s)[0] || null };
  const out = runExpr(clickReconnectFor('jira-ghe'), doc);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /more than one detail action row/);
  assert.strictEqual(btn.clicked, 0);
});

test('submit is refused rather than queued behind a long action', async (t) => {
  // A reconnect can hold the session for 24s; the phone gives a submit 5s
  // before telling the author it may not have sent and handing the text
  // back. Queueing means the daemon types it long after the phone
  // disowned it, so the author has the text back and it was also sent.
  const sockets = withFakeSockets(t);
  const d = new Daemon();
  d.connect();
  sockets[0].emit('open');
  const sent = [];
  d._send = (m) => sent.push(m);

  // A bounded hold, not an open one: with the guard removed the submit
  // must fail an assertion, not hang the suite. A test that only hangs
  // when the code is wrong is a bad signal — it reads as infrastructure
  // trouble rather than a caught defect.
  const long = d.queue.runLong('sid', () => new Promise((r) => setTimeout(r, 60)));
  assert.strictEqual(d.queue.isBusy('sid'), true, 'busy the moment the long action is started');

  const w = new SessionWatcher('sid', () => {});
  let typed = false;
  w.submit = async () => { typed = true; return { ok: true }; };
  d.watchers.set('sid', w);

  await d._handleMessage(JSON.stringify({ type: 'submit', sessionId: 'sid', text: 'hi' }));
  assert.strictEqual(typed, false, 'nothing was typed');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].ok, false);
  assert.match(sent[0].error, /busy/);
  await long;
  assert.strictEqual(typed, false, 'and still not typed once the long action finished');
  w.close();
});

test('newSession: two new conversations at once refuses to type into either', async (t) => {
  // Recorded as fixed after round 8 and never actually written. The code
  // still took the first id absent from the snapshot, so anything else
  // opening a Claude webview inside the window received the prompt.
  t.mock.method(cdp, 'listClaudeSessions', async () => {
    return calls++ === 0
      ? [{ sessionId: 'old' }]
      : [{ sessionId: 'old' }, { sessionId: 'new-a' }, { sessionId: 'new-b' }];
  });
  let calls = 0;
  t.mock.method(cdp, 'withSidebar', async () => ({ ok: true }));
  const submits = [];
  t.mock.method(cdp, 'findTarget', async () => {
    submits.push('attached');
    throw new Error('should never get here');
  });

  const out = await new Daemon().newSession('hello');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /new conversations appeared at once/);
  assert.deepStrictEqual(submits, [], 'nothing was typed into anything');
});

test('newSession: a candidate that arrives alone still has to survive a poll', async (t) => {
  // The staggered race, which the same-snapshot check cannot see. An
  // unrelated webview mounts first and is briefly the only candidate;
  // typing into it on that first sighting puts the phone's prompt into
  // someone else's conversation, silently.
  const snapshots = [
    [{ sessionId: 'old' }],
    [{ sessionId: 'old' }, { sessionId: 'unrelated' }],
    [{ sessionId: 'old' }, { sessionId: 'unrelated' }, { sessionId: 'intended' }],
  ];
  let calls = 0;
  t.mock.method(cdp, 'listClaudeSessions', async () =>
    snapshots[Math.min(calls++, snapshots.length - 1)]
  );
  t.mock.method(cdp, 'withSidebar', async () => ({ ok: true }));
  const d = new Daemon();
  let typedInto = null;
  d._typeIntoNewSession = async (id) => {
    typedInto = id;
    return { ok: true, sessionId: id };
  };
  const out = await d.newSession('hello');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /2 new conversations appeared at once/);
  assert.strictEqual(typedInto, null, 'nothing was typed anywhere');
});

test('newSession: a candidate that disappears again is not used', async (t) => {
  // A webview that mounts and closes inside the wait is not the session
  // the New session click produced.
  const snapshots = [
    [{ sessionId: 'old' }],
    [{ sessionId: 'old' }, { sessionId: 'flicker' }],
    [{ sessionId: 'old' }],
    [{ sessionId: 'old' }, { sessionId: 'real' }],
    [{ sessionId: 'old' }, { sessionId: 'real' }],
  ];
  let calls = 0;
  t.mock.method(cdp, 'listClaudeSessions', async () =>
    snapshots[Math.min(calls++, snapshots.length - 1)]
  );
  t.mock.method(cdp, 'withSidebar', async () => ({ ok: true }));
  const d = new Daemon();
  d._typeIntoNewSession = async (id) => ({ ok: true, sessionId: id });
  const out = await d.newSession('hello');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.sessionId, 'real');
});

test('newSession: exactly one new conversation is used', async (t) => {
  let calls = 0;
  t.mock.method(cdp, 'listClaudeSessions', async () =>
    calls++ === 0 ? [{ sessionId: 'old' }] : [{ sessionId: 'old' }, { sessionId: 'fresh' }]
  );
  t.mock.method(cdp, 'withSidebar', async () => ({ ok: true }));
  const d = new Daemon();
  d._typeIntoNewSession = async (id) => ({ ok: true, sessionId: id });
  const out = await d.newSession('hello');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.sessionId, 'fresh');
});

// A fake `run` that walks the same states the real flow does: no panel,
// then a command menu once /mcp is typed, then a list once the entry is
// clicked. A fake that reports the panel already open would take the
// early return and prove nothing.
function fakeMcpRun({
  draft = '',
  clearFails = false,
  restoreFails = false,
  injectIgnored = false,
  rowClickFails = false,
  servers = [],
  reconnectPolls = 2,
}) {
  let opened = false;
  // The composer is modelled, not scripted. Scripting each call's answer
  // means a test can assert "the restore reported ok" while the modelled
  // editor holds "/mcphello" — the defect the restore path exists to
  // prevent — and stay green. clearFails: 'restore' fails only the
  // cleanup clear, since a failing first clear aborts before anything has
  // been typed and never reaches the interesting path.
  let composer = draft;
  // Distinct from `opened`, which gates the command menu: the panel is
  // opened once and closed again on the way out, and a fake that never
  // closes spends the close timeout on every call.
  let panelOpen = false;
  let detail = null;
  let busyLeft = 0;
  // Every expression has to be told apart by something it alone contains,
  // and the obvious substrings overlap: MCP_STATE and RECONNECT_BUSY both
  // mention statusBadge_, MCP_STATE and clickServerRow both mention
  // serverItem_. Matching on the wrong one silently answers the wrong
  // question — an earlier version of this fake made clickServerRow
  // unreachable that way, and the test that depended on it asserted
  // against the string "undefined" without noticing.
  return async (expr) => {
    if (expr.includes('commandItem_') && expr.includes('draft')) {
      return { items: opened ? [] : ['/mcp'], draft: composer, structured: false };
    }
    if (expr.includes('detailActions_')) {
      if (!detail) return { ok: false, reason: 'no detail view' };
      busyLeft = reconnectPolls;
      return { ok: true };
    }
    if (expr.includes('actionButton_')) {
      const busy = busyLeft > 0;
      if (busy) busyLeft -= 1;
      const row = servers.find((r) => r.name === detail);
      return { busy, title: detail, status: row ? row.status : null };
    }
    if (expr.includes('serverItem_') && expr.includes('.click()')) {
      if (rowClickFails || !servers.some((r) => r.name === expr.match(/wanted = "([^"]*)"/)[1])) {
        return { ok: false, reason: 'no server called that', seen: servers.map((r) => r.name) };
      }
      detail = expr.match(/wanted = "([^"]*)"/)[1];
      return { ok: true };
    }
    if (expr.includes('serverItem_')) {
      if (!panelOpen) return { panel: 'none', title: null, rows: [], menuOpen: false };
      if (detail) {
        const row = servers.find((r) => r.name === detail);
        return { panel: 'detail', title: detail, status: row ? row.status : null, rows: [], menuOpen: false };
      }
      return { panel: 'list', title: null, rows: servers, menuOpen: false };
    }
    if (expr.includes('iconButton_') || expr.includes("'close'")) {
      panelOpen = false;
      return { ok: true };
    }
    if (expr.includes('commandLabel_')) {
      opened = true;
      panelOpen = true;
      return { ok: true };
    }
    // insertText first: injectExpr contains both insertText and
    // execCommand, so checking execCommand first makes every injection
    // look like a clear.
    if (expr.includes('insertText')) {
      if (restoreFails) return { ok: false, reason: 'no input candidates found' };
      if (!injectIgnored) {
        const arg = expr.match(/\}\)\(([\s\S]*)\)\s*$/)[1];
        composer += JSON.parse(arg);
      }
      return { ok: true };
    }
    if (expr.includes('selectAll')) {
      const fails = clearFails === 'restore' ? opened : clearFails;
      if (fails) return { ok: false, reason: 'composer vanished' };
      composer = '';
      return { ok: true };
    }
    return { ok: true };
  };
}

test('openMcpPanel: leaving /mcp behind is a note, not a failed action', async () => {
  // Failing the whole action because the composer could not be tidied is
  // what broke this feature once: the editor answers false from
  // selectAll and performs it anyway, so an over-strict cleanup check
  // turned every MCP action into "could not clear /mcp".
  const out = await openMcpPanel(fakeMcpRun({ draft: '', clearFails: true }));
  assert.strictEqual(out.ok, true, 'the panel opened, which is what was asked for');
  assert.match(out.note, /^note:/);
  assert.match(out.note, /may be left in the laptop composer/);
});

test('openMcpPanel: a draft that did not come back does fail the action', async () => {
  const out = await openMcpPanel(fakeMcpRun({ draft: 'half a sentence', restoreFails: true }));
  assert.strictEqual(out.ok, false, 'losing what someone was typing is not a note');
  assert.match(out.error, /draft was not put back/);
});

test('openMcpPanel: a draft is never typed on top of a composer that would not clear', async () => {
  // insertText inserts at the caret. With "/mcp" still sitting there the
  // restored draft becomes "/mcphello" — a mangled draft reported as a
  // restored one. There is nothing safe to type, so it is reported lost.
  const out = await openMcpPanel(fakeMcpRun({ draft: 'hello', clearFails: 'restore' }));
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /draft was not put back/);
  assert.match(out.error, /would not clear/);
});

test('openMcpPanel: insertText answering ok is not the draft being back', async () => {
  // The readback is the check. execCommand has already been observed to
  // answer for an edit the editor did not make.
  const out = await openMcpPanel(fakeMcpRun({ draft: 'hello', injectIgnored: true }));
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /holds ""/);
  assert.match(out.error, /instead of your draft "hello"/);
});

test('openMcpPanel: a draft that survives the round trip is not reported', async () => {
  const out = await openMcpPanel(fakeMcpRun({ draft: 'hello' }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.note, null);
});

test('readMcpServers and reconnectMcpServer carry the note out to the phone', async () => {
  // A note openMcpPanel produced and its caller dropped is the same as
  // never having detected it. The panel-level test cannot see this,
  // because it calls openMcpPanel directly.
  const list = await readMcpServers(fakeMcpRun({ draft: '', clearFails: true }));
  assert.strictEqual(list.ok, true);
  assert.match(list.note, /may be left in the laptop composer/);

  // Its failure exits have to carry it too: that is where the author is
  // most likely to go looking at the laptop, and the untidy composer is
  // part of what they will find.
  const recon = await reconnectMcpServer(
    fakeMcpRun({ draft: '', clearFails: true, rowClickFails: true }),
    'nope',
  );
  assert.strictEqual(recon.ok, false);
  assert.match(recon.note, /may be left in the laptop composer/);
  // Named, because a fake branch the expression never reaches answers
  // the wrong question and the assertion above still passes: this test
  // read the literal string "undefined" as its error once.
  assert.match(recon.error, /no server called that/);
});

test('reconnectMcpServer: the whole path, from the list to a settled reconnect', async () => {
  // The only end-to-end cover for the path that actually clicks Reconnect
  // on the laptop. Everything else exercises a refusal.
  const run = fakeMcpRun({ servers: [{ name: 'github', status: 'Connected' }] });
  const out = await reconnectMcpServer(run, 'github');
  assert.strictEqual(out.ok, true);
  assert.match(out.status, /^reconnected/);
  assert.strictEqual(out.note, undefined, 'a clean run carries nothing to report');
});

test('reconnectMcpServer: a reconnect that never starts says so rather than claiming success', async () => {
  // busy is never observed, so the click cannot be confirmed to have done
  // anything. Saying "reconnected" here is the lie this guards.
  const run = fakeMcpRun({ servers: [{ name: 'github', status: 'Connected' }], reconnectPolls: 0 });
  const out = await reconnectMcpServer(run, 'github');
  assert.strictEqual(out.ok, true);
  assert.match(out.status, /never saw it start/);
});

test('reconnectMcpServer: an unknown name lists the ones that are there', async () => {
  const run = fakeMcpRun({ servers: [{ name: 'github', status: 'Connected' }] });
  const out = await reconnectMcpServer(run, 'jira-ghe');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /github/);
});

test('openMcpPanel: the note survives the panel failing to open', async () => {
  // The exit that drops it is the one where the author most needs it:
  // nothing opened, so nothing else explains why their next message goes
  // out as "/mcp…". submit() inserts at the caret without clearing.
  const run = fakeMcpRun({ draft: '', clearFails: true });
  const orig = run;
  // The command menu is clicked, so cleanup runs, but the panel never
  // mounts.
  const out = await openMcpPanel(async (expr) =>
    expr.includes('serverItem_') && !expr.includes('.click()')
      ? { panel: 'none', title: null, rows: [], menuOpen: false }
      : orig(expr)
  );
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /did not open/);
  assert.match(out.note, /may be left in the laptop composer/);
});

test('readMcpServers: the rows reach the phone', async () => {
  const run = fakeMcpRun({
    servers: [{ name: 'github', status: 'Connected' }, { name: 'jira-ghe', status: 'Failed' }],
  });
  const out = await readMcpServers(run);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.servers.map((r) => r.name), ['github', 'jira-ghe']);
});

test('openMcpPanel: a clean run carries no note', async () => {
  const out = await openMcpPanel(fakeMcpRun({ draft: 'hello' }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.note, null);
});
