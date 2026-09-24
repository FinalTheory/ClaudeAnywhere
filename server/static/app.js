// Phone-side SPA shell: session list -> detail view -> live transcript.
// No framework, no build step — this is a personal tool, not a product.

const listEl = document.getElementById('session-rows');
const newSessionForm = document.getElementById('new-session-form');
const newSessionInput = document.getElementById('new-session-input');
const newSessionStatus = document.getElementById('new-session-status');
const listActionsEl = document.getElementById('list-actions');
const mcpRefreshBtn = document.getElementById('mcp-refresh');
const mcpListEl = document.getElementById('mcp-list');
const detailEl = document.getElementById('session-detail');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');
const backBtn = document.getElementById('back-btn');
const sendForm = document.getElementById('send-form');
const promptInput = document.getElementById('prompt-input');
const sendBtn = sendForm.querySelector('button[type="submit"]');

let currentSessionId = null;
let ws = null;
// What's currently in the DOM, in order — the baseline a resync diffs
// against so it can patch instead of rebuild. See applyResyncWindow.
let renderedTurns = [];
// Absolute index (into the server's turns list) of the OLDEST turn
// currently loaded in the DOM — the cursor for "load more history above".
let loadedStartIndex = 0;
let hasMore = true;
// Tracks the one in-flight send, so we can tell "no ack ever arrived" (a
// silent delivery failure — see the timeout below) apart from "explicit
// failure ack", and restore the text either way.
let pendingSend = null; // { text, timeoutId }
const SUBMIT_ACK_TIMEOUT_MS = 5000;

// When the VPS last said anything on this socket. readyState is not
// evidence: iOS suspends a backgrounded tab, and the socket can come back
// reporting OPEN while the connection underneath is gone — send() then
// succeeds into nothing. The browser answers protocol-level pings below
// the WebSocket API without telling page code, so an application ping is
// the only observable.
let lastInboundAt = 0;
// Text typed while the socket was not trustworthy, sent once a fresh one
// opens. Only ever set on a path where the send provably did not happen,
// so flushing it cannot duplicate a message.
// Messages typed while the socket was stale, each tagged with the session
// it was typed into. A bare string here goes out on whichever socket opens
// next: type into one conversation, tap Back, open another, and the prompt
// lands in the second one and is acked ok. An array rather than one slot
// because two sends during a single outage otherwise overwrite each other
// with nothing said.
let queuedSends = [];
const PING_EVERY_MS = 20000;
// Older than this and the send path stops trusting the socket. Must
// exceed PING_EVERY_MS or a healthy connection would look stale between
// pongs.
const STALE_AFTER_MS = 30000;
const DEAD_AFTER_MS = 60000;

async function loadSessionList() {
  listEl.innerHTML = '<div class="list-loading">Loading…</div>';
  const res = await fetch('/api/sessions');
  const data = await res.json();
  listEl.innerHTML = '';
  // Three ways to have no sessions, and they need different answers from
  // you. An empty list used to mean all of them.
  if (data.error || data.cdp === 'no-daemon') {
    showListNotice(
      'Laptop not connected',
      'The daemon is not reachable from the VPS — it may be starting, or the laptop is offline.',
      data.error,
    );
    return;
  }
  if (data.cdp === 'unreachable') {
    showListNotice(
      'VS Code is not running',
      'The daemon is up, but nothing answered on the debug port — VS Code is closed, ' +
        'restarting, or was started without --remote-debugging-port.',
      data.cdpError,
    );
    return;
  }
  if (data.sessions.length === 0) {
    showListNotice('No conversations open', 'VS Code is running, with no Claude Code tabs.');
    return;
  }
  for (const s of data.sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';

    const dot = document.createElement('span');
    dot.className = `dot ${s.running ? 'running' : 'idle'}`;

    const text = document.createElement('div');
    text.className = 'session-item-text';
    const title = document.createElement('div');
    title.className = 'session-item-title';
    // Prefer the readable title (document.title inside that session's own
    // webview) over the raw session id — falls back to the id if the title
    // turned out not to be conversation-specific (unverified as of writing,
    // see the comment on POLL_EXPR in daemon.js).
    title.textContent = s.title || s.sessionId.slice(0, 8);
    const preview = document.createElement('div');
    preview.className = 'session-item-preview';
    preview.textContent = s.preview || '(empty)';
    text.append(title, preview);

    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = '›'; // ›

    div.append(dot, text, chevron);
    div.onclick = () => openSession(s.sessionId);
    listEl.appendChild(div);
  }
}

// --- new session ----------------------------------------------------------
// The phone does not navigate into it: the daemon clicks New session in
// Claude Code's sidebar, waits for a webview that was not there before,
// and types the prompt in. The next list refresh shows it.

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function setActionStatus(el, text, kind) {
  el.textContent = text || '';
  el.className = kind ? `action-status ${kind}` : 'action-status';
}

newSessionForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = newSessionInput.value.trim();
  if (!text) return;
  const btn = newSessionForm.querySelector('button');
  btn.disabled = true;
  // Clicking through a UI on another machine is slow — say what is
  // happening rather than looking frozen for twenty seconds.
  setActionStatus(newSessionStatus, 'Opening a new conversation…');
  try {
    const out = await postJson('/api/new-session', { text });
    if (out.ok) {
      newSessionInput.value = '';
      newSessionInput.style.height = 'auto';
      setActionStatus(newSessionStatus, 'Started — pull to refresh to see it', 'ok');
      loadSessionList();
    } else {
      setActionStatus(newSessionStatus, out.error || 'could not start a session', 'bad');
    }
  } catch (err) {
    setActionStatus(newSessionStatus, err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
};

newSessionInput.addEventListener('input', () => {
  newSessionInput.style.height = 'auto';
  newSessionInput.style.height = `${newSessionInput.scrollHeight}px`;
});

// --- MCP servers ----------------------------------------------------------
// Only on request. Reading the list means opening Claude Code's MCP panel
// on the laptop, which changes what is on screen there; doing that on
// every list load would be rude.

function renderMcp(out) {
  mcpListEl.innerHTML = '';
  // The daemon borrows the laptop composer to type "/mcp" and puts it
  // back. When it could not, it says so here — the action still worked,
  // but there is something left on the laptop screen to deal with.
  if (out.note) {
    const n = document.createElement('p');
    n.className = 'action-status bad';
    n.textContent = out.note;
    mcpListEl.appendChild(n);
  }
  if (!out.ok) {
    const p = document.createElement('p');
    p.className = 'action-status bad';
    p.textContent = out.error || 'could not read the MCP list';
    mcpListEl.appendChild(p);
    return;
  }
  if (!out.servers || !out.servers.length) {
    const p = document.createElement('p');
    p.className = 'action-status';
    p.textContent = 'No MCP servers listed.';
    mcpListEl.appendChild(p);
    return;
  }
  for (const srv of out.servers) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    const name = document.createElement('div');
    name.className = 'mcp-name';
    name.textContent = srv.name;
    const status = document.createElement('div');
    // Whatever Claude Code calls it — Connected, Failed, Needs
    // authentication. Passed through rather than remapped, so a new
    // status shows up as itself instead of as "unknown".
    status.className = `mcp-status ${/fail|error/i.test(srv.status || '') ? 'bad' : ''}`;
    status.textContent = srv.status || '';
    const btn = document.createElement('button');
    btn.textContent = 'Reconnect';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Reconnecting…';
      // Without the finally, a rejected fetch, a non-JSON proxy reply or
      // an expired-auth redirect escapes the handler and leaves the
      // button disabled on "Reconnecting…" with nothing said — the exact
      // silent stall this is meant to fix.
      try {
        const res = await postJson('/api/mcp/reconnect', { serverName: srv.name });
        if (res.ok) {
          // ok does not always mean confirmed. The daemon returns a
          // status sentence when it clicked but never saw the reconnect
          // start, and refreshing straight past it would present a
          // guess as a result.
          if (res.note || (res.status && !/^reconnected/.test(res.status))) {
            status.textContent = [res.status, res.note].filter(Boolean).join(' · ');
            status.className = 'mcp-status bad';
            return;
          }
          mcpListEl.hidden = false;
          refreshMcp();
        } else {
          // The note carries out of the failure exits too, and it is a
          // separate thing to deal with from whatever failed.
          status.textContent = [res.error || 'failed', res.note].filter(Boolean).join(' · ');
          status.className = 'mcp-status bad';
        }
      } catch (err) {
        status.textContent = err.message || 'the request did not complete';
        status.className = 'mcp-status bad';
      } finally {
        btn.textContent = 'Reconnect';
        btn.disabled = false;
      }
    };
    const text = document.createElement('div');
    text.className = 'mcp-text';
    text.append(name, status);
    row.append(text, btn);
    mcpListEl.appendChild(row);
  }
}

async function refreshMcp() {
  mcpRefreshBtn.disabled = true;
  mcpListEl.innerHTML = '<p class="action-status">Opening the MCP panel on the laptop…</p>';
  try {
    renderMcp(await postJson('/api/mcp', {}));
  } catch (err) {
    renderMcp({ ok: false, error: err.message });
  } finally {
    mcpRefreshBtn.disabled = false;
  }
}

// Tapping the header again puts the list away. It is a dozen rows on a
// phone screen, and it is only worth looking at when something is broken.
// Collapsing keeps the DOM so re-opening is instant and does not disturb
// the laptop again.
mcpRefreshBtn.onclick = () => {
  const loaded = mcpListEl.childElementCount > 0;
  if (loaded && !mcpListEl.hidden) {
    mcpListEl.hidden = true;
    return;
  }
  mcpListEl.hidden = false;
  if (!loaded) refreshMcp();
};

function showListNotice(heading, detail, raw) {
  const wrap = document.createElement('div');
  wrap.className = 'list-error';
  const h = document.createElement('p');
  h.className = 'list-notice-heading';
  h.textContent = heading;
  const p = document.createElement('p');
  p.textContent = detail;
  wrap.append(h, p);
  if (raw) {
    const pre = document.createElement('p');
    pre.className = 'list-notice-raw';
    pre.textContent = raw;
    wrap.appendChild(pre);
  }
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.onclick = loadSessionList;
  wrap.appendChild(retry);
  listEl.appendChild(wrap);
}

function openSession(sessionId) {
  currentSessionId = sessionId;
  loadedStartIndex = 0;
  hasMore = true;
  transcriptEl.innerHTML = '';
  renderedTurns = [];
  document.getElementById('session-list').style.display = 'none';
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
let wsGeneration = 0;

function connectPhoneWs(sessionId, delay) {
  if (sessionId !== currentSessionId) return; // user navigated away meanwhile
  const gen = ++wsGeneration;
  // Close the one being replaced. Its handlers are already orphaned by the
  // generation bump, but leaving it open holds a second phone socket in
  // the server's subscriber set for this session.
  if (ws) {
    try {
      ws.close();
    } catch (e) {
      // a dead socket may refuse even this
    }
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/phone/${sessionId}`);
  ws.onclose = () => {
    // A socket we have already replaced must not schedule a second dial on
    // top of the one running — the phone would end up holding two, each
    // rendering into the same transcript.
    if (gen !== wsGeneration || sessionId !== currentSessionId) return;
    const nextDelay = Math.min((delay || 500) * 2, 8000);
    setTimeout(() => connectPhoneWs(sessionId, nextDelay), delay || 500);
  };
  ws.onopen = () => {
    // Orphaned sockets must not flush the queue either: submitText writes
    // to the current `ws`, so a late open on a replaced socket would send
    // into whatever conversation is on screen now.
    if (gen !== wsGeneration || sessionId !== currentSessionId) return;
    lastInboundAt = Date.now();
    const mine = queuedSends.filter((q) => q.sessionId === sessionId);
    queuedSends = queuedSends.filter((q) => q.sessionId !== sessionId);
    for (const q of mine) submitText(q.text);
  };
  ws.onmessage = (ev) => {
    lastInboundAt = Date.now();
    const msg = JSON.parse(ev.data);
    if (msg.type === 'pong') return; // liveness only; the timestamp is the payload
    // Capture this BEFORE inserting anything — afterwards the container has
    // already grown and every position reads as "not at the bottom".
    const stick = atBottom();
    if (msg.type === 'initial') {
      // msg.turns is an array of complete, independently-valid HTML
      // fragments (one per message) — joining them is always well-formed,
      // unlike the old byte-sliced single-string design.
      renderWindow(msg.turns, msg.startIndex);
      setStatus(msg.running);
      scrollToBottom(true);
      fillViewport();
    } else if (msg.type === 'append') {
      // NOT `+=` — `el.innerHTML += x` is `el.innerHTML = el.innerHTML + x`,
      // which tears down and reparses EVERY existing child, not just adds
      // the new ones. That's the "looks like a refresh, screen flickers"
      // symptom — insertAdjacentHTML only touches the new nodes.
      transcriptEl.insertAdjacentHTML('beforeend', msg.turns.join(''));
      renderedTurns = renderedTurns.concat(msg.turns);
      applyCollapse();
      scrollToBottom(stick);
    } else if (msg.type === 'resync') {
      // The server truncates this to the same tail window `initial` gets
      // (see server.py), so it describes the newest turns, not the whole
      // conversation. applyResyncWindow decides whether that is a patch,
      // a suffix replacement, or a reset.
      applyResyncWindow(msg.turns, msg.startIndex);
      scrollToBottom(stick);
    } else if (msg.type === 'state') {
      setStatus(msg.running);
    } else if (msg.type === 'error') {
      // The daemon's own tells: the attach failure it reports once per
      // outage, and the DOM-mismatch warning whose entire purpose is to
      // reach a person. Dropped, they leave the transcript frozen on
      // "Running..." with nothing to explain it. No `state` frame follows
      // an outage, so this stays on screen until the session recovers.
      setStatus(null, msg.message);
    } else if (msg.type === 'laptop') {
      // The VPS lost or regained the daemon. The phone's own liveness ping
      // only proves the VPS is up, so nothing else distinguishes a laptop
      // asleep from a conversation that has gone quiet.
      setStatus(null, msg.connected ? null : 'Laptop disconnected — waiting for it to come back');
    } else if (msg.type === 'submit_ack') {
      if (pendingSend) clearTimeout(pendingSend.timeoutId);
      if (!msg.ok) {
        setStatus(null, `send failed: ${msg.error || 'unknown error'}`);
        // The input was cleared optimistically on send (see sendForm.onsubmit)
        // — a visible error alone still leaves the user retyping a message
        // that "failed" for reasons that had nothing to do with what they
        // typed. Restore it, but only into an empty box: if they've already
        // started composing something new by the time this ack arrives,
        // don't clobber that.
        if (pendingSend && !promptInput.value) {
          promptInput.value = pendingSend.text;
          promptInput.dispatchEvent(new Event('input')); // re-trigger auto-grow
        }
      }
      pendingSend = null;
    }
  };
}

function setStatus(running, note) {
  statusEl.textContent = note || (running ? 'Running...' : running === false ? 'Idle' : 'Unknown');
  // Not a hard disable anymore — confirmed in practice this deadlocks: the
  // send-button/aria-label flip means "busy" whenever the assistant's turn
  // isn't finished, which is ALSO true while it's blocked on a pending
  // AskUserQuestion/interactive tool call — the one case where replying is
  // exactly how you unblock it. Disabling actually prevented that reply.
  // "running" was only ever meant to stop you interrupting active
  // generation with an unrelated message — a soft visual hint (dim, still
  // clickable) serves that without locking out the one case it breaks.
  sendBtn.classList.toggle('maybe-busy', running === true);
}

// --- rendering -----------------------------------------------------------

function renderWindow(turns, startIndex) {
  transcriptEl.innerHTML = turns.join('');
  renderedTurns = turns.slice();
  loadedStartIndex = startIndex;
  hasMore = startIndex > 0;
  applyCollapse();
}

// While a response is being written, the daemon sends a `resync` on EVERY
// poll tick: the final turn's HTML grows in place, which is not a clean
// append, so diffTurns falls back to resync (see daemon.js). Rebuilding
// #transcript from innerHTML on each of those tore down and reparsed the
// whole transcript once every 1.5s. That is what made the composer
// unusable while output was streaming — a full DOM teardown in the same
// frame as a programmatic scroll drops the text selection and caret on
// iOS, so selecting or editing text was impossible until output stopped.
//
// The streaming case is narrow and worth special-casing: same window
// origin, same turn count, only the last turn's HTML differs. Patch that
// one element and leave the rest of the DOM — and the selection — alone.
// Anything else (the window slid, turns were spliced, the user has paged
// older history in) falls back to a full render, which is what a resync
// means in the general case.
function applyResyncWindow(turns, startIndex) {
  const n = transcriptEl.children.length;
  const sameWindow =
    startIndex === loadedStartIndex && turns.length === n && n === renderedTurns.length;
  if (sameWindow && turns.slice(0, -1).every((t, i) => t === renderedTurns[i])) {
    if (turns[n - 1] !== renderedTurns[n - 1]) {
      // The captured HTML carries none of the phone-local collapse
      // markers, so replacing the turn wholesale drops them and the
      // applyCollapse() below re-caps a prompt the reader just opened —
      // once every poll, for as long as the reply streams. The user's own
      // blocks do not change while the reply grows, so their positions
      // within the turn line up before and after; carry the flag across
      // by position.
      const stale = transcriptEl.children[n - 1];
      // Carry every collapse marker, not just the expanded one. `fits` and
      // the capped class are what make applyCollapse skip an element it
      // has already measured; dropping them means the surviving prompt is
      // measured again on each streaming tick, and each measurement reads
      // offsetHeight twice against a freshly parsed subtree.
      const marks = Array.from(stale.querySelectorAll('[aria-label="You"]')).map((u) => ({
        expanded: u.dataset.expanded === '1',
        fits: u.dataset.fits === '1',
        capped: u.classList.contains('turn-collapsed'),
      }));
      stale.outerHTML = turns[n - 1];
      const fresh = transcriptEl.children[n - 1].querySelectorAll('[aria-label="You"]');
      marks.forEach((m, i) => {
        const el = fresh[i];
        if (!el) return;
        if (m.expanded) el.dataset.expanded = '1';
        if (m.fits) el.dataset.fits = '1';
        if (m.capped) el.classList.add('turn-collapsed');
      });
      renderedTurns = turns.slice();
      applyCollapse();
    }
    return;
  }

  // Scrolled back. The window describes a suffix of what is on screen, so
  // replace that suffix and keep everything paged in above it. Resetting
  // to the window instead — which is what a resync used to mean — threw
  // all of it away, and since a resync lands every few seconds while a
  // reply streams, scrolling back during a live conversation was
  // impossible: the view snapped to the last turn before you could read.
  //
  // loadedStartIndex and hasMore stay put on purpose: the older turns are
  // still displayed, so the pagination cursor still describes the view.
  // Scroll position is preserved for free, because nothing above the
  // splice point moves.
  const offset = startIndex - loadedStartIndex;
  if (offset > 0 && offset < n) {
    while (transcriptEl.children.length > offset) {
      transcriptEl.lastElementChild.remove();
    }
    transcriptEl.insertAdjacentHTML('beforeend', turns.join(''));
    renderedTurns = renderedTurns.slice(0, offset).concat(turns);
    // Markers are not carried across here as they are in the fast path
    // above: the replaced suffix is the live exchange, and someone
    // scrolled back is reading the older turns, which are untouched.
    applyCollapse();
    return;
  }

  renderWindow(turns, startIndex);
}

// Your own messages are capped to --collapsed-max-height and expand on
// tap. Claude's replies are never capped — re-reading those is the point
// of the view; your own text you just wrote.
//
// The unit is a message block one level inside a turn, NOT the turn
// itself. A turn is a whole exchange — one captured turn measured 100KB
// and held the question, the thinking, the reply and eighteen tool calls
// as sibling children. At turn granularity a question and its answer are
// the same element, so either both collapse or neither does.
//
// `[aria-label="You"]` is what separates them, and it is a sturdier
// handle than the class prefix: every block carries `message_`, while the
// reply blocks are labelled "Claude", "Claude, thinking", "Claude, Bash"
// and so on. aria-label is semantic markup rather than a hashed
// CSS-module name, so it survives the version churn the class names do
// not. One sibling carries `userMessageContainer_` with no label at all —
// a system note, not something you wrote, correctly left alone.
//
// The cap itself lives in the stylesheet; nothing here duplicates it.
const COLLAPSE_UNITS = '#transcript > * > [aria-label="You"]';

function applyCollapse() {
  const units = transcriptEl.querySelectorAll(COLLAPSE_UNITS);
  for (let i = 0; i < units.length; i++) {
    const el = units[i];
    if (el.dataset.expanded === '1') continue;
    // Settled already: either capped, or measured once and found to fit.
    // Without these markers every poll re-measures every block, and each
    // measurement forces a synchronous layout.
    if (el.classList.contains('turn-collapsed') || el.dataset.fits === '1') continue;
    // Measure the height before and after the cap, and keep the cap only
    // if the element actually got shorter.
    //
    // The obvious test — scrollHeight > clientHeight once capped — is
    // wrong here, and wrong in a way that looks plausible. `overflow:
    // hidden` establishes a block formatting context, so a child's margin
    // stops collapsing through the parent and the content box grows by
    // that margin. scrollHeight then exceeds clientHeight by a few pixels
    // on nearly every block, including one-line ones, which caps blocks
    // that need no capping.
    const natural = el.offsetHeight;
    el.classList.add('turn-collapsed');
    if (el.offsetHeight >= natural) {
      el.classList.remove('turn-collapsed');
      el.dataset.fits = '1';
    }
  }
}

transcriptEl.addEventListener('click', (e) => {
  // A tap that finished a text selection is not a toggle request — without
  // this, selecting anything inside an expanded block collapses it out
  // from under the selection.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;

  const unit = e.target.closest(COLLAPSE_UNITS);
  if (!unit) return;
  if (unit.classList.contains('turn-collapsed')) {
    unit.classList.remove('turn-collapsed');
    unit.dataset.expanded = '1'; // survives applyCollapse on the next poll
  } else if (unit.dataset.expanded === '1') {
    // Only re-collapses something the user opened by hand. A block that
    // fits on its own, or the live tail that is deliberately kept open,
    // carries no `expanded` marker and so cannot be collapsed by a stray
    // tap.
    delete unit.dataset.expanded;
    unit.classList.add('turn-collapsed');
  }
});

// --- scrolling -----------------------------------------------------------

const AUTOSCROLL_SLACK_PX = 80;

function atBottom() {
  return (
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <
    AUTOSCROLL_SLACK_PX
  );
}

// Only follow new output when the view was already parked at the bottom.
// Scrolling unconditionally yanked the viewport away mid-read whenever a
// poll landed, and each programmatic scroll is another chance to drop a
// selection on iOS.
function scrollToBottom(force) {
  if (!force) return;
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

// Pagination is driven by scrolling, so a window that does not overflow
// has no way to ask for more — the scroll event never fires and the older
// turns are unreachable. The initial window is one whole turn, which is
// usually several screens but need not be.
async function fillViewport() {
  for (let guard = 0; guard < 5; guard++) {
    if (!hasMore || transcriptEl.scrollHeight > transcriptEl.clientHeight) return;
    const before = loadedStartIndex;
    await loadOlder();
    if (loadedStartIndex === before) return; // nothing moved; stop asking
  }
}

transcriptEl.addEventListener('scroll', () => {
  if (transcriptEl.scrollTop > 40) return;
  loadOlder();
});

async function loadOlder() {
  if (!hasMore || !currentSessionId || loadingMore) return;
  loadingMore = true;
  // What this page was asked for. A resync can land while the request is
  // in flight and reset the whole window to a newer tail; applying the
  // answer to that different window prepends turns that no longer meet
  // the ones on screen, drops whatever sat between them, and then sets
  // hasMore from a stale answer so the gap can never be paged back in.
  const askedFrom = loadedStartIndex;
  const askedFor = currentSessionId;
  try {
    const res = await fetch(
      `/api/session/${askedFor}/history?before_index=${askedFrom}&limit_bytes=2048`
    );
    const data = await res.json();
    if (loadedStartIndex !== askedFrom || currentSessionId !== askedFor) {
      return; // window moved under us — scrolling again asks from the new cursor
    }
    if (!data.turns || data.turns.length === 0) {
      hasMore = false;
      return;
    }
    const prevHeight = transcriptEl.scrollHeight;
    transcriptEl.insertAdjacentHTML('afterbegin', data.turns.join(''));
    renderedTurns = data.turns.concat(renderedTurns);
    applyCollapse();
    loadedStartIndex = data.start_index;
    hasMore = data.has_more;
    transcriptEl.scrollTop = transcriptEl.scrollHeight - prevHeight;
  } finally {
    loadingMore = false;
  }
}

// Coming back to a backgrounded tab. iOS suspends the page rather than
// closing it, so the socket can be dead with no close event delivered
// until much later, or the backoff can have grown to 8s of doing nothing
// while you are looking at a stale transcript. Neither is visible: the
// view just stops updating. Dial straight away instead of waiting.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !currentSessionId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectPhoneWs(currentSessionId);
    return;
  }
  // OPEN after a suspend proves nothing. Ask, and let the deadline above
  // decide — but do it now rather than up to 5s from now, because the
  // next thing to happen is usually the user sending something.
  ws.send(JSON.stringify({ type: 'ping' }));
});

backBtn.onclick = () => {
  if (ws) ws.close();
  detailEl.style.display = 'none';
  document.getElementById('session-list').style.display = 'block';
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

// Whether this socket has shown any sign of life recently enough to send
// on. OPEN alone is not enough — that is the state a suspended-then-
// resumed iOS tab reports for a connection that no longer exists.
function socketLooksAlive() {
  return ws && ws.readyState === WebSocket.OPEN && Date.now() - lastInboundAt < STALE_AFTER_MS;
}

sendForm.onsubmit = (e) => {
  e.preventDefault();
  const text = promptInput.value.trim();
  if (!text) return;
  // Come back to the tab after a while and the socket is usually stale:
  // the send lands nowhere, the ack never arrives, and the first message
  // after every idle period failed while the second worked — by then the
  // reconnect had finished. Do the reconnect first instead of spending
  // the user's message discovering it.
  if (!socketLooksAlive()) {
    queuedSends.push({ sessionId: currentSessionId, text });
    promptInput.value = '';
    promptInput.style.height = 'auto';
    setStatus(null, 'Reconnecting — your message will go as soon as it is back');
    connectPhoneWs(currentSessionId);
    return;
  }
  submitText(text);
};

// The part that assumes a working socket, so the queue can reuse it.
function submitText(text) {
  ws.send(JSON.stringify({ type: 'submit', text }));
  promptInput.value = '';
  promptInput.style.height = 'auto';
  if (pendingSend) clearTimeout(pendingSend.timeoutId); // shouldn't happen, but don't leak a timer if it does
  pendingSend = {
    text,
    timeoutId: setTimeout(() => {
      // readyState === OPEN at send time is not proof of delivery — send()
      // is fire-and-forget at the WebSocket API level, and a connection can
      // die between the call and the frame actually reaching the server
      // with no error ever surfaced to us (confirmed in practice: a message
      // vanished with zero error shown, during a window of daemon<->VPS
      // reconnect churn). A submit_ack that never arrives is exactly as
      // real a failure as one that explicitly says ok:false.
      setStatus(null, 'No response — message may not have sent, restoring it');
      if (pendingSend && !promptInput.value) {
        promptInput.value = pendingSend.text;
        promptInput.dispatchEvent(new Event('input'));
      }
      pendingSend = null;
    }, SUBMIT_ACK_TIMEOUT_MS),
  };
}

// Liveness. Ping on a cadence well under the deadline so one lost packet
// is not a dead connection, and replace the socket when the VPS has been
// silent past it. Deliberately no auto-retry of an unacknowledged send:
// a lost ack and a lost send are indistinguishable from here, and sending
// the same prompt twice is worse than saying it may not have gone.
setInterval(() => {
  if (document.visibilityState !== 'visible' || !currentSessionId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // the backoff loop owns this
  const quiet = Date.now() - lastInboundAt;
  if (quiet > DEAD_AFTER_MS) {
    connectPhoneWs(currentSessionId);
  } else if (quiet > PING_EVERY_MS) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 5000);

loadSessionList();
