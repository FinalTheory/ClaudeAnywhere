// Minimal CDP JSON-RPC client over the native WebSocket global (Node >= 22).
// Shared by read-transcript.js and send-prompt.js.

async function findTarget(port, match) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP endpoint returned HTTP ${res.status}`);
  const targets = await res.json();
  const hit = targets.find(
    (t) => (t.title && t.title.includes(match)) || (t.url && t.url.includes(match))
  );
  if (!hit) {
    throw new Error(
      `No target matched "${match}". Run list-targets.js ${port} to see available targets.`
    );
  }
  return hit;
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (ev) => reject(new Error('WebSocket connect failed')));
  });

  let nextId = 1;
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Runtime.enable');
  return { ws, send };
}

async function evaluate(client, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId !== undefined) params.contextId = contextId;
  const result = await client.send('Runtime.evaluate', params);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate threw');
  }
  return result.result.value;
}

// VS Code webviews nest real content behind bootstrap iframes (e.g.
// fake.html) that don't show up as separate CDP targets in /json/list —
// they're same-process child frames, not out-of-process. Walk the frame
// tree of the *attached* target instead of relying on the target list.
function flattenFrames(node, parentId, out) {
  out.push({ id: node.frame.id, url: node.frame.url, parentId: parentId || null });
  for (const child of node.childFrames || []) {
    flattenFrames(child, node.frame.id, out);
  }
  return out;
}

async function getFrames(client) {
  await client.send('Page.enable');
  const { frameTree } = await client.send('Page.getFrameTree');
  return flattenFrames(frameTree, null, []);
}

// Gives a fresh execution context scoped to a specific frame, regardless of
// same-origin restrictions — needed because Runtime.evaluate with no
// contextId only ever runs in the main frame's context.
async function isolatedWorldContext(client, frameId) {
  const { executionContextId } = await client.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'cdp-spike',
    grantUniversalAccess: true,
  });
  return executionContextId;
}

const CONTENT_PROBE_EXPR = `
(function() {
  if (!document.body) return { innerTextLen: -1, chatLike: 0 };
  return {
    innerTextLen: document.body.innerText.length,
    // Semantic markers, not CSS-module names: a frame with transcript
    // messages or a composer is the chat, whatever it is styled as.
    chatLike:
      document.querySelectorAll('[data-transcript-message]').length +
      document.querySelectorAll('[role="textbox"], [contenteditable="true"]').length
  };
})()
`;

// Scores every frame by how much visible text its body has and returns the
// richest one (with its isolated-world contextId ready to reuse). Frames
// that error out (detached, cross-origin-restricted) are skipped, not fatal.
async function pickContentFrame(client, frames) {
  let best = null;
  for (const frame of frames) {
    let contextId;
    try {
      contextId = await isolatedWorldContext(client, frame.id);
      const info = await evaluate(client, CONTENT_PROBE_EXPR, contextId);
      if (info.innerTextLen <= 0) continue;
      // Most visible text is a decent heuristic and was enough in
      // practice, but on its own it picks any text-heavy frame an upgrade
      // introduces — a release note, a sign-in overlay, a bootstrap shell
      // — and the daemon then polls valid JavaScript against the wrong
      // document, reporting no turns rather than an error. A frame that
      // actually contains the transcript always outranks one that merely
      // has more words in it.
      const better =
        !best ||
        (info.chatLike > 0 && best.chatLike === 0) ||
        (info.chatLike > 0 === best.chatLike > 0 && info.innerTextLen > best.innerTextLen);
      if (better) {
        best = { frame, contextId, innerTextLen: info.innerTextLen, chatLike: info.chatLike };
      }
    } catch (err) {
      // skip — frame not evaluable, not necessarily an error worth surfacing
    }
  }
  return best;
}

// All open Claude Code webviews at once — proven in practice to persist
// regardless of which VS Code tab is currently focused (retainContextWhenHidden
// behavior confirmed empirically, see chat history). sessionId is the `id=`
// query param VS Code assigns per webview instance, stable for that tab's
// lifetime; it's what the daemon uses to address a specific session.
async function listClaudeSessions(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP endpoint returned HTTP ${res.status}`);
  const targets = await res.json();
  return targets
    .filter(
      (t) =>
        t.type === 'iframe' &&
        t.url &&
        t.url.includes('extensionId=Anthropic.claude-code') &&
        // The session-picker/sidebar view is the same extension in a
        // different VS Code webview *purpose* (a view, not an editor tab) —
        // this is VS Code's own metadata for that distinction, cheaper and
        // more reliable than the innerHTML footer-text check daemon.js also
        // does (kept as a second check there, since this URL param has only
        // been observed on one build so far and isn't confirmed universal).
        !t.url.includes('purpose=webviewView')
    )
    .map((t) => {
      const sessionId = (t.url.match(/[?&]id=([^&]+)/) || [])[1] || t.id;
      return { sessionId, targetId: t.id, url: t.url };
    });
}

// Claude Code's sidebar (the session picker, purpose=webviewView) lists
// every session as `id="sessions-list-row-<uuid>"` with the name in a
// `sessionName_*` child. That uuid is Claude's own session id — the same
// one an editor webview carries as `data-initial-session` — so the two
// together name a conversation without touching any VS Code internals.
//
// The VS Code route was tried first and abandoned: the editor tab does
// carry the label, but keyed by a panel uuid that appears nowhere else in
// the workbench DOM, and pairing tabs to webviews by document order is
// wrong — measured once with the active tab first in order and its webview
// third. Only the active pair is identifiable there, so it could name one
// conversation at a time.
const SESSION_NAMES_EXPR = `
(function () {
  const out = {};
  for (const row of document.querySelectorAll('[id^="sessions-list-row-"]')) {
    const name = row.querySelector('[class*="sessionName"]');
    const text = name && name.textContent.trim();
    if (text) out[row.id.replace('sessions-list-row-', '')] = text.slice(0, 80);
  }
  return out;
})()
`;

// uuid -> conversation name, or {} when the sidebar isn't open. Never
// throws: a missing name costs a nicer label, and is not worth failing the
// session list over.
async function readSessionNames(port) {
  let client;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return {};
    const targets = await res.json();
    const sidebar = targets.find(
      (t) =>
        t.type === 'iframe' &&
        t.url &&
        t.url.includes('extensionId=Anthropic.claude-code') &&
        t.url.includes('purpose=webviewView')
    );
    if (!sidebar) return {};
    client = await connect(sidebar);
    const frames = await getFrames(client);
    const picked = await pickContentFrame(client, frames);
    if (!picked) return {};
    return (await evaluate(client, SESSION_NAMES_EXPR, picked.contextId)) || {};
  } catch (err) {
    return {};
  } finally {
    try {
      client && client.ws.close();
    } catch (e) {
      // already gone
    }
  }
}

// The workbench's own view of "which conversation is on screen right now".
//
// data-initial-session is only written when a webview first mounts with a
// session to open; VS Code restoring tabs after a restart does not write
// it, and then nothing inside the webview carries the session id at all.
// The editor tab still has the label though, so this reads the one pair
// that can be established without guessing: the selected tab and the
// visible webview are the same conversation.
//
// It refuses to answer unless there is exactly one of each. Split editor
// groups mean several selected tabs and several visible webviews, and
// pairing across them is the mislabelling this whole approach exists to
// avoid — an unnamed session is merely ugly, a misnamed one is wrong.
//
// Positional pairing was considered and refuted: measured on a live
// window the selected tab was first in tab order while its webview was
// third in overlay order.
const ACTIVE_PAIR_EXPR = `
(function () {
  const selected = [...document.querySelectorAll('.tab[aria-selected="true"]')]
    .map((t) => (t.getAttribute('aria-label') || t.innerText || '').trim())
    .filter(Boolean);
  const visible = [...document.querySelectorAll('[class*="webview-overlay"]')]
    .filter((o) => o.id && getComputedStyle(o).visibility === 'visible')
    .map((o) => o.id);
  return { selected, visible };
})()
`;

// The judgment, separated from the CDP plumbing so it can be tested
// without a browser: exactly one selected tab and exactly one visible
// webview we track, or nothing.
function pickUniquePair({ selected, visible }, knownIds) {
  const tabs = (selected || []).filter(Boolean);
  const ours = (visible || []).filter((id) => knownIds.includes(id));
  if (tabs.length !== 1 || ours.length !== 1) return null;
  return { webviewId: ours[0], title: tabs[0] };
}

// -> { webviewId, title } for the conversation currently on screen, or
// null. Never throws; a missing pair costs a nicer label.
async function readActiveWebviewTitle(port, knownIds) {
  let client;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) return null;
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) return null;
    client = await connect(page);
    const frames = await getFrames(client);
    const picked = await pickContentFrame(client, frames);
    if (!picked) return null;
    const seen = await evaluate(client, ACTIVE_PAIR_EXPR, picked.contextId);
    return pickUniquePair(seen || {}, knownIds);
  } catch (err) {
    return null;
  } finally {
    try {
      client && client.ws.close();
    } catch (e) {
      // already gone
    }
  }
}

module.exports = {
  pickUniquePair,
  readActiveWebviewTitle,
  readSessionNames,
  findTarget,
  connect,
  evaluate,
  getFrames,
  isolatedWorldContext,
  pickContentFrame,
  listClaudeSessions,
};
