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
  // Children are counted, not rendered. The transcript's branch selection
  // turns on `transcriptEl.children.length` and on scrollHeight vs
  // clientHeight, and a shim whose children never grow answers every
  // branch the same way — which silently makes assertions about
  // applyResyncWindow vacuous. Counting is cheap and enough to tell the
  // branches apart; nothing here pretends to parse HTML, and no test
  // should assert on what the markup became.
  const mkEl = (id) => {
    const el = {
      id,
      style: {},
      dataset: {},
      children: [],
      value: '',
      disabled: false,
      hidden: false,
      textContent: '',
      scrollTop: 0,
      // Derived from the child count, so "does the content overflow" —
      // which is what fillViewport branches on — answers differently for
      // an empty and a populated transcript. clientHeight defaults to 0,
      // an element that was never laid out: any content then counts as
      // overflowing, so fillViewport stops rather than paging the whole
      // history into every test that renders a frame. A test that wants
      // the auto-fill behaviour raises clientHeight itself.
      clientHeight: 0,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      append() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      setAttribute() {}, getAttribute: () => null,
      querySelector: () => mkEl('q'), querySelectorAll: () => [], closest: () => null,
      appendChild(child) {
        const kid = child || mkEl('child');
        kid.parent = el;
        el.children.push(kid);
      },
      // One child per fragment: every caller passes an array joined with
      // '', and the count is what the branch logic reads.
      insertAdjacentHTML(where, html) {
        const made = String(html).split('<div').length - 1 || 1;
        for (let i = 0; i < made; i += 1) {
          const kid = mkEl('child');
          kid.parent = el;
          if (where === 'afterbegin') el.children.unshift(kid);
          else el.children.push(kid);
        }
      },
      // Detaches from its parent. A no-op here deadlocks the suffix
      // splice, whose loop removes lastElementChild until the count
      // drops — the shim has to make the count actually drop.
      remove() {
        if (!el.parent) return;
        const at = el.parent.children.indexOf(el);
        if (at !== -1) el.parent.children.splice(at, 1);
      },
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
      get: () => html,
      set(v) {
        html = String(v);
        el.children = [];
        const made = html ? html.split('<div').length - 1 || 1 : 0;
        for (let i = 0; i < made; i += 1) el.children.push(mkEl('child'));
      },
    });
    Object.defineProperty(el, 'childElementCount', { get: () => el.children.length });
    Object.defineProperty(el, 'scrollHeight', { get: () => el.children.length * 50 });
    Object.defineProperty(el, 'lastElementChild', {
      get: () => el.children[el.children.length - 1] || null,
    });
    return el;
  };
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
  // Driven, not just loaded. Most getElementById calls happen at module
  // load and a bare load catches those; the ones inside openSession and
  // backBtn.onclick run only when the author taps, and a typo there
  // throws mid-gesture and does nothing, silently.
  const { missing } = loadPhone(`
    openSession('A', 'alpha');
    backBtn.onclick();
    openSession('B', 'beta');
    renderMcp({ ok: false, error: 'x', candidates: [{ sessionId: 'A', title: 'alpha' }] });
    renderMcp({ ok: true, servers: [{ name: 'github', status: 'Connected' }] });
    showListNotice('h', 'd', 'raw');
  `);
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

test('phone: a successful send retracts the failure before it', () => {
  // Making notes outrank the live state was correct and incomplete:
  // nothing in the system cleared a note on the event that contradicts
  // it, so a send refused by the busy guard and then retried
  // successfully still read "send failed".
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    submitText('m1');
    sock.onmessage({ data: JSON.stringify({ type: 'submit_ack', ok: false, error: 'busy' }) });
    const failed = statusNote;
    submitText('m2');
    sock.onmessage({ data: JSON.stringify({ type: 'submit_ack', ok: true }) });
    return { failed, after: statusNote };
  `);
  assert.match(out.failed, /send failed/);
  assert.strictEqual(out.after, null);
});

test('phone: the daemon reattaching retracts the outage notice', () => {
  // The outage is reported once. If running and turns are unchanged
  // across the reattach, no other frame follows, so without its
  // counterpart the notice is the last word on the matter.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    sock.onmessage({ data: JSON.stringify({ type: 'error', message: 'No target matched' }) });
    const during = statusNote;
    sock.onmessage({ data: JSON.stringify({ type: 'recovered' }) });
    return { during, after: statusNote };
  `);
  assert.match(out.during, /No target matched/);
  assert.strictEqual(out.after, null);
});

test('phone: a note never hides Running/Idle', () => {
  // They shared one slot, so a note that nothing retracted also hid the
  // only indicator of what the laptop is doing.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    sock.onmessage({ data: JSON.stringify({ type: 'error', message: 'selector mismatch' }) });
    sock.onmessage({ data: JSON.stringify({ type: 'state', running: true }) });
    return { status: statusEl.textContent, note: noticeEl.textContent };
  `);
  assert.strictEqual(out.status, 'Running...');
  assert.strictEqual(out.note, 'selector mismatch');
});

test('phone: a history request in flight does not disable the next conversation', () => {
  // loadingMore is global. Left set by the conversation being left, the
  // new one's fillViewport bails on its first pass — and if its window
  // does not overflow, no scroll event ever fires and its older history
  // is unreachable with nothing said.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    loadingMore = true;
    openSession('B', 'beta');
    return { loadingMore };
  `);
  assert.strictEqual(out.loadingMore, false);
});

test('phone: the redial scheduled by a dead socket does not close a healthy one', async () => {
  // Round 13 guarded every socket callback and not the timer one of them
  // schedules. Between the schedule and its firing, foregrounding the tab
  // dials its own socket; unguarded, this closes that healthy one and
  // starts over — a second transcript rebuild that discards the history
  // the author had paged in.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const dead = ws;
    dead.onclose();              // schedules a redial for this session
    openSession('A', 'alpha');   // the tab comes back and dials its own
    const healthy = ws;
    return (async () => {
      await new Promise((r) => setTimeout(r, 700));
      return { replaced: ws !== healthy };
    })();
  `);
  const got = await out;
  assert.strictEqual(got.replaced, false, 'the orphaned timer must not dial over a live socket');
});

test('phone: a reconnect to the same session does not duplicate what is on screen', () => {
  // The earlier version of this navigated to a *different* session, so
  // `sessionId !== currentSessionId` answered on its own and the
  // generation half of the guard was never exercised. The reconnect the
  // guard actually protects is to the same session — the backoff loop and
  // the visibilitychange dial both do that.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const first = ws;
    first.onmessage({ data: JSON.stringify({ type: 'initial', turns: ['<div>one</div>'], startIndex: 0, running: false }) });
    const before = renderedTurns.length;
    connectPhoneWs('A');                      // same session, new socket
    first.onmessage({ data: JSON.stringify({ type: 'append', turns: ['<div>one</div>'] }) });
    return { before, after: renderedTurns.length };
  `);
  assert.strictEqual(out.before, 1);
  assert.strictEqual(out.after, 1, 'a frame from the replaced socket must not append again');
});

test('phone: applyResyncWindow patches a growing turn instead of rebuilding', () => {
  // AGENTS.md names this as risk #4: rebuilding #transcript on every
  // resync is what made the composer unusable while a reply streams. The
  // shim counts children, which is what the branch turns on, so a
  // short-circuit to the full-rebuild path is observable here.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    ws.onmessage({ data: JSON.stringify({ type: 'initial', turns: ['<div>a</div>', '<div>b</div>'], startIndex: 0, running: true }) });
    const kept = transcriptEl.children[0];
    ws.onmessage({ data: JSON.stringify({ type: 'resync', turns: ['<div>a</div>', '<div>b+more</div>'], startIndex: 0 }) });
    return { same: transcriptEl.children[0] === kept, count: transcriptEl.children.length, last: renderedTurns[1] };
  `);
  assert.strictEqual(out.count, 2);
  assert.strictEqual(out.last, '<div>b+more</div>', 'the grown turn is taken');
  assert.strictEqual(out.same, true, 'the untouched turn is the same node, not a reparse');
});

test('phone: a failing history page neither ends pagination nor passes unnoticed', () => {
  // loadOlder was never called by any test. Three separate guards live in
  // it, and all three could be deleted with the suite green.
  const { out } = loadPhone(`
    return (async () => {
      openSession('A', 'alpha');
      ws.onmessage({ data: JSON.stringify({ type: 'initial', turns: ['<div>a</div>'], startIndex: 5, running: false }) });
      fetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'bad gateway' }) });
      await loadOlder();
      return { hasMore, note: statusNote, loading: loadingMore };
    })();
  `);
  return out.then((got) => {
    assert.strictEqual(got.hasMore, true, 'an error body must not end pagination');
    assert.match(got.note, /Could not load older messages/);
    assert.strictEqual(got.loading, false, 'and the in-flight flag is released');
  });
});

test('phone: a history page that answers after the window moved is discarded', () => {
  // F4.1. A resync can reset the window while the request is in flight;
  // applying the answer then prepends turns that do not meet the ones on
  // screen and sets hasMore from a stale answer.
  const { out } = loadPhone(`
    return (async () => {
      openSession('A', 'alpha');
      ws.onmessage({ data: JSON.stringify({ type: 'initial', turns: ['<div>a</div>'], startIndex: 5, running: false }) });
      fetch = async () => {
        loadedStartIndex = 9;   // the window moved under the request
        return { ok: true, status: 200, json: async () => ({ turns: ['<div>old</div>'], start_index: 4, has_more: false }) };
      };
      await loadOlder();
      return { start: loadedStartIndex, hasMore, rendered: renderedTurns.length };
    })();
  `);
  return out.then((got) => {
    assert.strictEqual(got.start, 9, 'the moved cursor stands');
    assert.strictEqual(got.hasMore, true, 'and hasMore is not taken from the stale answer');
    assert.strictEqual(got.rendered, 1, 'nothing was prepended');
  });
});

test('phone: a stale socket queues the message rather than sending into nothing', () => {
  // The whole reconnect apparatus was untested. socketLooksAlive trusting
  // readyState is the defect that made "the first message after every
  // idle period fails" — readyState stays OPEN on a suspended tab.
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    lastInboundAt = Date.now() - 120000;   // long past STALE_AFTER_MS
    promptInput.value = 'hello';
    sendForm.onsubmit({ preventDefault() {} });
    return { alive: socketLooksAlive(), queued: queuedSends.length, to: queuedSends[0] && queuedSends[0].sessionId, note: statusNote, pending: pendingSends.length };
  `);
  assert.strictEqual(out.alive, false, 'an OPEN but silent socket is not alive');
  assert.strictEqual(out.queued, 1);
  assert.strictEqual(out.to, 'A', 'and it is queued against the conversation it was typed into');
  assert.match(out.note, /Reconnecting/);
  assert.strictEqual(out.pending, 0, 'nothing was sent, so nothing is awaiting an ack');
});

test('phone: a failure ack does not clobber a message already being composed', () => {
  const { out } = loadPhone(`
    openSession('A', 'alpha');
    const sock = ws;
    submitText('m1');
    promptInput.value = 'something new';
    sock.onmessage({ data: JSON.stringify({ type: 'submit_ack', ok: false, error: 'busy' }) });
    return { composer: promptInput.value };
  `);
  assert.strictEqual(out.composer, 'something new', 'the restore only fills an empty box');
});
