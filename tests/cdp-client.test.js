// Run: node --test "tests/*.test.js"

const test = require('node:test');
const assert = require('node:assert');

const { listClaudeSessions, findTarget, pickUniquePair, makeSend } = require('../client/cdp-client.js');

function withFetch(t, payload, { status = 200 } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  });
  return calls;
}

// A real /json/list entry, trimmed to the fields the code reads. The URL
// shape (and the id= param carrying the session id) is what the whole
// addressing scheme depends on.
function webviewTarget(sessionId, { purpose = null, id = 'TARGET' } = {}) {
  const base =
    `vscode-webview://host/index.html?id=${sessionId}&parentId=1` +
    `&extensionId=Anthropic.claude-code&platform=electron`;
  return { type: 'iframe', id, url: purpose ? `${base}&purpose=${purpose}` : base, title: '' };
}

test('listClaudeSessions: extracts the session id from the url', async (t) => {
  const calls = withFetch(t, [webviewTarget('abc-123', { id: 'T1' })]);
  const out = await listClaudeSessions(9222);
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['abc-123']);
  assert.strictEqual(out[0].targetId, 'T1');
  assert.match(calls[0], /127\.0\.0\.1:9222\/json\/list$/);
});

test('listClaudeSessions: excludes the sidebar view (purpose=webviewView)', async (t) => {
  withFetch(t, [
    webviewTarget('chat-1'),
    webviewTarget('sidebar-1', { purpose: 'webviewView' }),
    webviewTarget('chat-2'),
  ]);
  const out = await listClaudeSessions(9222);
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['chat-1', 'chat-2']);
});

test('listClaudeSessions: ignores non-iframe targets and other extensions', async (t) => {
  withFetch(t, [
    { type: 'page', id: 'P', url: 'vscode-file://vscode-app/workbench.html', title: 'VS Code' },
    { type: 'worker', id: 'W', url: '', title: '' },
    { type: 'iframe', id: 'X', url: 'vscode-webview://h/i.html?id=z&extensionId=Some.other', title: '' },
    webviewTarget('chat-1'),
  ]);
  const out = await listClaudeSessions(9222);
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['chat-1']);
});

test('listClaudeSessions: falls back to the target id when no id= param exists', async (t) => {
  withFetch(t, [
    { type: 'iframe', id: 'FALLBACK', url: 'vscode-webview://h/i.html?extensionId=Anthropic.claude-code', title: '' },
  ]);
  const out = await listClaudeSessions(9222);
  assert.deepStrictEqual(out.map((s) => s.sessionId), ['FALLBACK']);
});

test('listClaudeSessions: an empty target list is empty, not an error', async (t) => {
  withFetch(t, []);
  assert.deepStrictEqual(await listClaudeSessions(9222), []);
});

test('listClaudeSessions: a non-200 from the CDP endpoint throws', async (t) => {
  withFetch(t, [], { status: 500 });
  await assert.rejects(() => listClaudeSessions(9222), /HTTP 500/);
});

test('findTarget: matches on a url substring', async (t) => {
  withFetch(t, [webviewTarget('aaa'), webviewTarget('bbb', { id: 'T-BBB' })]);
  const hit = await findTarget(9222, 'bbb');
  assert.strictEqual(hit.id, 'T-BBB');
});

test('findTarget: no match names the substring it looked for', async (t) => {
  withFetch(t, [webviewTarget('aaa')]);
  await assert.rejects(() => findTarget(9222, 'nope'), /No target matched "nope"/);
});

// --- pickUniquePair: one conversation named, or none ----------------------
// data-initial-session is only written on a webview's first mount, so VS
// Code restoring tabs leaves nothing in the webview carrying the session
// id. The tab still has the label, and the selected tab and the visible
// webview are the same conversation — but only when there is exactly one
// of each.

const KNOWN = ['wv-1', 'wv-2'];

test('pickUniquePair: one selected tab and one visible webview pair up', () => {
  assert.deepStrictEqual(
    pickUniquePair({ selected: ['EKP-63451'], visible: ['wv-1'] }, KNOWN),
    { webviewId: 'wv-1', title: 'EKP-63451' },
  );
});

test('pickUniquePair: split editor groups teach nothing', () => {
  // Several tabs selected and several webviews visible. Pairing across
  // them is guessing, and a misnamed session is worse than an unnamed one.
  assert.strictEqual(
    pickUniquePair({ selected: ['EKP-1', 'EKP-2'], visible: ['wv-1', 'wv-2'] }, KNOWN),
    null,
  );
});

test('pickUniquePair: two tabs but one webview is still ambiguous', () => {
  assert.strictEqual(pickUniquePair({ selected: ['a', 'b'], visible: ['wv-1'] }, KNOWN), null);
});

test('pickUniquePair: two visible webviews but one tab is still ambiguous', () => {
  assert.strictEqual(pickUniquePair({ selected: ['a'], visible: ['wv-1', 'wv-2'] }, KNOWN), null);
});

test('pickUniquePair: overlays we do not track are ignored, not counted', () => {
  // The Claude Code sidebar is a webview overlay too, and a visible one
  // would otherwise make every observation look ambiguous.
  assert.deepStrictEqual(
    pickUniquePair({ selected: ['EKP-63451'], visible: ['sidebar-x', 'wv-1'] }, KNOWN),
    { webviewId: 'wv-1', title: 'EKP-63451' },
  );
});

test('pickUniquePair: nothing on screen is null, not a throw', () => {
  assert.strictEqual(pickUniquePair({}, KNOWN), null);
  assert.strictEqual(pickUniquePair({ selected: [], visible: [] }, KNOWN), null);
});

// --- a request in flight when the debug socket dies ----------------------

// Bounded, and returns the rejection rather than asserting on it. The
// defect here is a promise that never settles, so awaiting it plainly
// signals by hanging until the runner's timeout — which reads as a stuck
// suite rather than a failed assertion, and takes the whole file down
// with it.
async function settle(promise) {
  const out = await Promise.race([
    promise.then((v) => new Error(`resolved with ${JSON.stringify(v)} instead of rejecting`), (e) => e),
    new Promise((r) => setTimeout(() => r(new Error('never settled')), 60)),
  ]);
  return out;
}

function fakeSocket() {
  const listeners = new Map();
  return {
    sent: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    send(data) {
      this.sent.push(data);
    },
    fire(type, ev) {
      for (const fn of [...(listeners.get(type) || [])]) fn(ev);
    },
    count(type) {
      return (listeners.get(type) || new Set()).size;
    },
  };
}

test('send: a request outstanding when the socket closes is rejected, not abandoned', async () => {
  // A reply is the only thing that used to settle a send. VS Code quitting
  // mid-poll produces no reply and no rejection, so the await never
  // returns — and nothing downstream survives that. SessionWatcher._tick
  // reschedules after its own catch, which it never reaches, so the
  // phone's live view freezes with no error and re-subscribing is a no-op
  // because the wedged watcher is still registered. A session held by
  // SessionQueue.runLong stays busy for the life of the daemon.
  const ws = fakeSocket();
  const send = makeSend(ws);
  const pending = send('Runtime.evaluate', { expression: '1' });
  ws.fire('close', {});
  assert.match((await settle(pending)).message, /socket closed with requests in flight/);
});

test('send: an errored socket settles everything in flight', async () => {
  const ws = fakeSocket();
  const send = makeSend(ws);
  const a = send('A');
  const b = send('B');
  ws.fire('error', {});
  assert.match((await settle(a)).message, /errored with requests in flight/);
  assert.match((await settle(b)).message, /errored with requests in flight/);
});

test('send: a reply still resolves, and leaves no listener behind', async () => {
  const ws = fakeSocket();
  const send = makeSend(ws);
  const before = ws.count('message');
  const p = send('Runtime.evaluate', { expression: '1' });
  const { id } = JSON.parse(ws.sent[0]);
  ws.fire('message', { data: JSON.stringify({ id, result: { value: 7 } }) });
  assert.deepStrictEqual(await p, { value: 7 });
  // A per-request listener that outlives its reply accumulates one entry
  // per poll, forever, on a socket that polls every 1.5s.
  assert.strictEqual(ws.count('message'), before);
});

test('send: sending on an already-dead socket rejects instead of hanging', async () => {
  // The throw is synchronous and lands before any close event a listener
  // would see.
  const ws = fakeSocket();
  const send = makeSend(ws);
  ws.send = () => {
    throw new Error('WebSocket is not open');
  };
  assert.match((await settle(send('Runtime.evaluate', {}))).message, /not open/);
  assert.strictEqual(ws.count('message'), 0, 'and does not leak its listener');
});

test('send: a socket that stays open and never answers still rejects', async () => {
  // The other half of the same silence. Closing covers the socket dying;
  // this covers the target wedging with the connection intact, which
  // produces an identical symptom — a poll loop that never reschedules
  // and a session busy for the life of the daemon.
  const ws = fakeSocket();
  const send = makeSend(ws, 30);
  assert.match((await settle(send('Runtime.evaluate', {}))).message, /did not answer within 30ms/);
});

test('send: a reply cancels its own deadline', async () => {
  // A timer left running past the reply fires into a deleted entry. It
  // must not reject a promise that already resolved, nor keep the process
  // awake between polls.
  const ws = fakeSocket();
  const send = makeSend(ws, 20);
  const p = send('Runtime.evaluate', {});
  const { id } = JSON.parse(ws.sent[0]);
  ws.fire('message', { data: JSON.stringify({ id, result: { value: 1 } }) });
  assert.deepStrictEqual(await p, { value: 1 });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(ws.count('message'), 0, 'no listener outlives the reply');
});
