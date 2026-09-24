// Run: node --test tests/
//
// These live outside server/ on purpose: the daemon's deploy-watch rsyncs
// server/ to the VPS on every change, and test files have no business
// shipping there or triggering a production restart on every edit.

const test = require('node:test');
const assert = require('node:assert');

const cdp = require('../cdp-client.js');
const {
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
