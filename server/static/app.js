// Phone-side SPA shell: session list -> detail view -> live transcript.
// No framework, no build step — this is a personal tool, not a product.

const listEl = document.getElementById('session-list');
const detailEl = document.getElementById('session-detail');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');
const backBtn = document.getElementById('back-btn');
const sendForm = document.getElementById('send-form');
const promptInput = document.getElementById('prompt-input');
const sendBtn = sendForm.querySelector('button[type="submit"]');

let currentSessionId = null;
let ws = null;
// Absolute index (into the server's turns list) of the OLDEST turn
// currently loaded in the DOM — the cursor for "load more history above".
let loadedStartIndex = 0;
let hasMore = true;
// What we last optimistically-cleared from the input, in case the ack that
// comes back says it never actually sent — see the submit_ack handler.
let lastSentText = null;

async function loadSessionList() {
  listEl.innerHTML = 'Loading...';
  const res = await fetch('/api/sessions');
  const data = await res.json();
  listEl.innerHTML = '';
  if (data.error) {
    const p = document.createElement('p');
    p.textContent = `Client daemon not connected: ${data.error}`;
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = loadSessionList;
    listEl.append(p, retry);
    return;
  }
  for (const s of data.sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    const dot = document.createElement('span');
    dot.className = `dot ${s.running ? 'running' : 'idle'}`;
    // Prefer the readable title (document.title inside that session's own
    // webview) over the raw UUID — falls back to the truncated preview text
    // if the title turned out not to be conversation-specific (unverified
    // as of writing, see the comment on POLL_EXPR in daemon.js).
    const label = s.title || `${s.sessionId.slice(0, 8)} — ${s.preview || '(empty)'}`;
    div.append(dot, document.createTextNode(` ${label}`));
    div.onclick = () => openSession(s.sessionId);
    listEl.appendChild(div);
  }
}

function openSession(sessionId) {
  currentSessionId = sessionId;
  loadedStartIndex = 0;
  hasMore = true;
  transcriptEl.innerHTML = '';
  listEl.style.display = 'none';
  // Must be 'flex', not 'block': #session-detail is styled as a flex column
  // (style.css) so #transcript gets a bounded height and scrolls
  // internally. An inline style here overrides the stylesheet regardless of
  // source order (inline always wins), so setting 'block' silently broke
  // the whole flex layout — #transcript grew to fit its content instead of
  // clipping+scrolling, which is why neither auto-scroll-to-bottom nor
  // scroll-up-to-load-more ever fired: the page scrolled instead of the
  // transcript div, and nothing was listening for that.
  detailEl.style.display = 'flex';
  connectPhoneWs(sessionId);
}

// The VPS restarts on every deploy (auto-restart-on-file-change is the whole
// point of the daemon/deploy-watch loop) — that drops this socket, so
// reconnect-with-backoff isn't optional here, it's load-bearing.
function connectPhoneWs(sessionId, delay) {
  if (sessionId !== currentSessionId) return; // user navigated away meanwhile
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/phone/${sessionId}`);
  ws.onclose = () => {
    if (sessionId !== currentSessionId) return;
    const nextDelay = Math.min((delay || 500) * 2, 8000);
    setTimeout(() => connectPhoneWs(sessionId, nextDelay), delay || 500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'initial') {
      // msg.turns is an array of complete, independently-valid HTML
      // fragments (one per message) — joining them is always well-formed,
      // unlike the old byte-sliced single-string design.
      transcriptEl.innerHTML = msg.turns.join('');
      loadedStartIndex = msg.startIndex;
      hasMore = msg.startIndex > 0;
      setStatus(msg.running);
      scrollToBottom();
    } else if (msg.type === 'append') {
      // NOT `+=` — `el.innerHTML += x` is `el.innerHTML = el.innerHTML + x`,
      // which tears down and reparses EVERY existing child, not just adds
      // the new ones. That's the "looks like a refresh, screen flickers"
      // symptom — insertAdjacentHTML only touches the new nodes.
      transcriptEl.insertAdjacentHTML('beforeend', msg.turns.join(''));
      scrollToBottom();
    } else if (msg.type === 'resync') {
      // Server already truncated this to the same tail-window size as
      // `initial` (see server.py) — treat it identically: reset the
      // pagination cursor too, or scrolling up next would fetch history
      // using a cursor computed against content that no longer exists.
      transcriptEl.innerHTML = msg.turns.join('');
      loadedStartIndex = msg.startIndex;
      hasMore = msg.startIndex > 0;
      scrollToBottom();
    } else if (msg.type === 'state') {
      setStatus(msg.running);
    } else if (msg.type === 'submit_ack') {
      if (!msg.ok) {
        setStatus(null, `send failed: ${msg.error || 'unknown error'}`);
        // The input was cleared optimistically on send (see sendForm.onsubmit)
        // — a visible error alone still leaves the user retyping a message
        // that "failed" for reasons that had nothing to do with what they
        // typed. Restore it, but only into an empty box: if they've already
        // started composing something new by the time this ack arrives,
        // don't clobber that.
        if (lastSentText && !promptInput.value) {
          promptInput.value = lastSentText;
          promptInput.dispatchEvent(new Event('input')); // re-trigger auto-grow
        }
      }
      lastSentText = null;
    }
  };
}

function setStatus(running, note) {
  statusEl.textContent = note || (running ? 'Running...' : running === false ? 'Idle' : 'Unknown');
  // Only disable on a confirmed "still running" — an unknown/null state
  // (e.g. right after connecting, before the first probe result) defaults
  // to enabled so a flaky signal can't permanently lock the input.
  sendBtn.disabled = running === true;
}

function scrollToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// A scroll gesture fires this event many times before the first fetch even
// resolves — without a guard, every one of those passes the same
// loadedStartIndex (it hasn't been updated yet) and fires its own duplicate
// request, and whichever response lands last wins the cursor update
// regardless of arrival order. That's what made "keep scrolling to reach
// the very beginning" flaky: the cursor could end up set from a stale
// response, silently skipping or re-fetching a range.
let loadingMore = false;

transcriptEl.addEventListener('scroll', async () => {
  if (transcriptEl.scrollTop > 40 || !hasMore || !currentSessionId || loadingMore) return;
  loadingMore = true;
  try {
    const res = await fetch(
      `/api/session/${currentSessionId}/history?before_index=${loadedStartIndex}&limit_bytes=2048`
    );
    const data = await res.json();
    if (!data.turns || data.turns.length === 0) {
      hasMore = false;
      return;
    }
    const prevHeight = transcriptEl.scrollHeight;
    transcriptEl.insertAdjacentHTML('afterbegin', data.turns.join(''));
    loadedStartIndex = data.start_index;
    hasMore = data.has_more;
    transcriptEl.scrollTop = transcriptEl.scrollHeight - prevHeight;
  } finally {
    loadingMore = false;
  }
});

backBtn.onclick = () => {
  if (ws) ws.close();
  detailEl.style.display = 'none';
  listEl.style.display = 'block';
  currentSessionId = null;
  loadSessionList();
};

// Auto-grow with content (capped by max-height in style.css, which takes
// over with its own scrollbar past that) — a fixed single-row textarea
// would hide exactly the multi-line composing this was switched to a
// textarea for in the first place.
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${promptInput.scrollHeight}px`;
});

sendForm.onsubmit = (e) => {
  e.preventDefault();
  if (sendBtn.disabled) return; // still running — belt and suspenders alongside the disabled attribute
  const text = promptInput.value.trim();
  if (!text) return;
  // The VPS restarts on every deploy, which drops this socket for a moment
  // (see connectPhoneWs's reconnect logic). Without this check, a send
  // during that gap either throws (ws.send on a non-OPEN socket) and gets
  // silently swallowed by the browser, or the text is cleared here while
  // the underlying send never actually reaches the server — either way,
  // "looks sent" but never arrives, with no indication anything went wrong.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus(null, 'Not connected — reconnecting, try again in a moment');
    return;
  }
  lastSentText = text;
  ws.send(JSON.stringify({ type: 'submit', text }));
  promptInput.value = '';
  promptInput.style.height = 'auto';
};

loadSessionList();
