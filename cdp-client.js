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
  if (!document.body) return { innerTextLen: -1 };
  return { innerTextLen: document.body.innerText.length };
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
      if (info.innerTextLen > 0 && (!best || info.innerTextLen > best.innerTextLen)) {
        best = { frame, contextId, innerTextLen: info.innerTextLen };
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

module.exports = {
  findTarget,
  connect,
  evaluate,
  getFrames,
  isolatedWorldContext,
  pickContentFrame,
  listClaudeSessions,
};
