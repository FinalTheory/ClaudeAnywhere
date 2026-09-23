// Run: node --test "tests/*.test.js"

const test = require('node:test');
const assert = require('node:assert');

const { listClaudeSessions, findTarget } = require('../cdp-client.js');

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
