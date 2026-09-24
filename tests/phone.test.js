// The phone SPA, driven in a DOM shim.
//
// AGENTS.md used to say `server/static/` could not be covered without a
// browser dependency. A browser is still out of scope, but the part worth
// covering is not rendering — it is the state machine: a dozen
// module-level variables mutated from socket callbacks, timers, gestures
// and the navigation between the list and a conversation. Round 12 and
// round 13 found five defects there, all of the same shape, and this shim
// is sixty lines of plain Node.
//
// What it is allowed to assert: that the module evaluates, that every
// element it reaches for exists in index.html, and that a transition
// leaves the right variables describing the right conversation. What it
// deliberately does not assert: anything about layout, scrolling or how
// HTML lands on screen — that is what "judged by use" still means.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.join(__dirname, '..', 'server', 'static');

function loadPhone(epilogue = '') {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  const mkEl = (id) => ({
    id,
    style: {},
    dataset: {},
    children: [],
    childElementCount: 0,
    value: '',
    disabled: false,
    hidden: false,
    innerHTML: '',
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild() {}, append() {}, insertAdjacentHTML() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => mkEl('q'), querySelectorAll: () => [], closest: () => null,
  });
  const cache = new Map();
  let lastWs = null;
  const sandbox = {
    document: {
      getElementById(id) {
        if (!ids.has(id)) missing.push(id);
        if (!cache.has(id)) cache.set(id, mkEl(id));
        return cache.get(id);
      },
      createElement: () => mkEl('created'),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      visibilityState: 'visible',
    },
    window: { addEventListener() {} },
    location: { protocol: 'https:', host: 'x', href: '' },
    WebSocket: Object.assign(
      function () {
        lastWs = mkEl('ws');
        lastWs.readyState = 1;
        lastWs.close = () => {};
        lastWs.send = () => {};
        return lastWs;
      },
      { OPEN: 1 }
    ),
    fetch: async () => ({ ok: true, redirected: false, status: 200, json: async () => ({ sessions: [] }) }),
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    Event: function () {},
    Date,
    JSON,
    Array,
    console,
  };
  const src = fs.readFileSync(path.join(STATIC, 'app.js'), 'utf8');
  const names = Object.keys(sandbox);
  const fn = new Function(...names, `${src}\n${epilogue}`);
  const out = fn(...names.map((n) => sandbox[n]));
  return { missing, out };
}

test('phone: it evaluates, and every element it reaches for is in index.html', () => {
  const { missing } = loadPhone();
  assert.deepStrictEqual([...new Set(missing)], [], 'getElementById against ids index.html does not have');
});

test('phone: an ack answers the oldest unanswered send, not the newest', () => {
  // One slot cannot describe two sends. With one, an ack for the first
  // clears the second's timer, shows the first's error, and hands back the
  // second message — the one that actually went.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    sock.onmessage({ data: JSON.stringify({ type: 'submit_ack', ok: false, error: 'busy' }) });
    submitText('m1');
    submitText('m2');
    const before = pendingSends.length;
    sock.onmessage({ data: JSON.stringify({ type: 'submit_ack', ok: true }) });
    return { before, after: pendingSends.length, left: pendingSends[0] && pendingSends[0].text };
  `);
  assert.strictEqual(out.before, 2);
  assert.strictEqual(out.after, 1, 'exactly one send is answered');
  assert.strictEqual(out.left, 'm2', 'and it is the older one that was answered');
});

test('phone: a state frame does not erase a note the author needs to read', () => {
  // The daemon emits its DOM-mismatch warning and a state frame in the
  // same tick — on a fresh watcher lastRunning is null, so one always
  // follows. Without stickiness the warning shows for less than a frame.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    sock.onmessage({ data: JSON.stringify({ type: 'error', message: 'selector mismatch' }) });
    sock.onmessage({ data: JSON.stringify({ type: 'state', running: true }) });
    const afterState = statusNote;
    sock.onmessage({ data: JSON.stringify({ type: 'laptop', connected: false }) });
    const disconnected = statusNote;
    sock.onmessage({ data: JSON.stringify({ type: 'laptop', connected: true }) });
    return { afterState, disconnected, reconnected: statusNote };
  `);
  assert.strictEqual(out.afterState, 'selector mismatch');
  assert.match(out.disconnected, /Laptop disconnected/);
  assert.strictEqual(out.reconnected, null, 'and the laptop coming back clears it');
});

test('phone: nothing in flight survives a navigation to another conversation', () => {
  // A send timer fires five seconds later and injects the old prompt into
  // the new composer; a queued message goes out whenever that session is
  // next opened, hours later.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    submitText('m1');
    queuedSends.push({ sessionId: 'A', text: 'queued-for-A' });
    openSession('B', 'beta');
    return { pending: pendingSends.length, queued: queuedSends.length, session: currentSessionId };
  `);
  assert.strictEqual(out.pending, 0);
  assert.strictEqual(out.queued, 0);
  assert.strictEqual(out.session, 'B');
});

test('phone: a frame from the socket we navigated away from is discarded', () => {
  // close() does not discard frames already in flight, and `append` and
  // `resync` carry no sessionId — the socket's identity is the only
  // evidence of which conversation a frame describes.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sockA = ws;
    openSession('B', 'beta');
    sockA.onmessage({ data: JSON.stringify({ type: 'append', turns: ['<div>from A</div>'] }) });
    return { rendered: renderedTurns.length };
  `);
  assert.strictEqual(out.rendered, 0, "A's turn must not land in B's transcript");
});

test('phone: a session list that is not the expected shape says so', () => {
  // A 200 whose body lacks `sessions` used to throw inside an async
  // function nobody awaits, after the list had already been emptied — a
  // blank, silent screen.
  const { out } = loadPhone(`
    return (async () => {
      const said = [];
      showListNotice = (heading) => { said.push(heading); };
      // The module calls loadSessionList on load; let that settle before
      // recording, or its notice is attributed to the first case here.
      await new Promise((r) => setTimeout(r, 0));
      said.length = 0;
      fetch = async () => ({ ok: true, redirected: false, status: 200, json: async () => ({}) });
      await loadSessionList();
      const malformed = said.slice();
      said.length = 0;
      fetch = async () => { throw new Error('connection refused'); };
      await loadSessionList();
      const unreachable = said.slice();
      said.length = 0;
      fetch = async () => ({ ok: true, redirected: true, status: 200, json: async () => ({}) });
      await loadSessionList();
      return { malformed, unreachable, signedOut: said.slice() };
    })();
  `);
  return out.then((got) => {
    assert.deepStrictEqual(got.malformed, ['Unexpected answer from the server']);
    assert.deepStrictEqual(got.unreachable, ['Could not reach the server']);
    assert.deepStrictEqual(got.signedOut, ['Signed out'], 'an expired cookie is named, not a blank screen');
  });
});
