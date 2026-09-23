// Run: node --test tests/
//
// These live outside server/ on purpose: the daemon's deploy-watch rsyncs
// server/ to the VPS on every change, and test files have no business
// shipping there or triggering a production restart on every edit.

const test = require('node:test');
const assert = require('node:assert');

const cdp = require('../cdp-client.js');
const {
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

test('diffTurns: a changed last turn is a resync, never an append', () => {
  // The streaming case: the final turn grows in place as tokens arrive.
  // Appending here would leave the half-written turn sitting next to the
  // finished one on the server.
  const out = diffTurns(['a', 'b-partial'], ['a', 'b-complete'], false);
  assert.strictEqual(out.kind, 'resync');
  assert.deepStrictEqual(out.turns, ['a', 'b-complete']);
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
