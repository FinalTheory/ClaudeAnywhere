# Agent guide — ClaudeAnywhere

Mirrors and drives the Claude Code conversations already open in the
author's desktop VS Code, from a phone. [`README.md`](README.md) /
[`README.zh-CN.md`](README.zh-CN.md) are the user-facing half — what it
is, what you need, how to run it. Everything below is for someone
changing it.

**The two READMEs are one document in two languages.** A change to a
user-facing fact — a command, a default, a limit — belongs in both, in the
same commit. A translation that has drifted is worse than no translation,
because nothing announces it.

The Chinese one is written in Chinese rather than translated from the
English, and uses full-width punctuation throughout its prose — `，`, `：`,
`；` — including after a Latin word or a `**` that ends a Chinese clause.
Half-width punctuation stays only inside code spans, fenced blocks, link
targets and HTML attributes.

```
VS Code webview ──CDP──► client/daemon.js ──WS──► server/server.py ──WS/HTTP──► phone
   (laptop)                  (laptop)                  (VPS)                  (browser)
```

## The bar for changes here

**This is a usability tool, not a correctness-critical system.** One user, one
laptop, one VPS, all owned by the author. That is not a disclaimer, it is the
standard to apply:

- **Accept a change if it stops the phone from silently showing something
  wrong** — a duplicated block, a missing block, turns out of order, a blanked
  transcript, a message believed sent that never arrived. *Silent* and *visible*
  together is what matters; a loud failure the author sees on the next run needs
  no guard.
- **Reject correctness that costs complexity and buys nothing perceivable.** If
  the fix is "add a counter/version/sequence number and translate it in N
  places", it needs a symptom the author can see. "Technically wrong, nobody
  would notice" is a rejection, not a finding.
- **Message completeness past `MAX_SESSION_BYTES` has no value.** History older
  than the per-session cap is gone by design. Do not add machinery to preserve
  it, page around it, or keep indices stable across it.
- **Zero dependencies, both sides.** Node uses native `fetch`/`WebSocket` and
  `node:test`; the server uses aiohttp and nothing else. Do not propose adding a
  package, a build step, a linter, CI, or a headless browser.
- Explicitly ruled out, with reasons, and not open for re-litigation: HTML
  sanitization on the transcript path; separating the daemon token, the phone
  password, and the cookie key (deliberately one secret); supporting more than
  one connected daemon.

## Where the real risk is

Four places have earned scrutiny, because each has produced a visible defect:

1. **`SessionState.apply_resync`** (`server/server.py`) — reconciles the
   daemon's capped tail against stored history by content overlap, with no
   sequence numbers. Two rules interact: score candidate positions by how far
   the sequences agree, and never consider a position earlier than
   `len(turns) - len(incoming)`. Dropping either one corrupts the transcript in
   a different direction; both directions have happened. Three invariants hold
   of the reconciled result **before `_cap()` runs**, and are tested by brute
   force: it never shortens, always ends with exactly what was sent, and
   applying the same tail twice is a no-op. The cap is then free to drop whole
   turns off the front, so none of the three survive it — that is the size
   policy working, not a violation.
2. **`diffTurns` + `SessionWatcher.forceResyncNext`** (`client/daemon.js`) — a
   fresh watcher must report its first read as a `resync`, never an `append`.
   `[]` is a prefix of anything, so without the flag a restart appends a full
   snapshot onto history the server already has.
3. **What a streaming reply costs the phone.** A turn is a whole exchange:
   measured against a live session one was 98KB and the largest 284KB. At
   the 1.5s poll rate an uncoalesced resync is ~240MB/hour to the phone and
   was ~1.9GB/hour on the laptop uplink, because the tail carried every
   turn to describe growth in one. Two rules keep that down and both are
   load-bearing: `diffTurns` sends only the final turn when only the final
   turn changed, and `shouldEmitNow` coalesces resyncs to
   `RESYNC_MIN_INTERVAL_MS` while flushing at once on the first read of a
   subscription and when a reply finishes. Appends are never delayed.
4. **The phone's resync render path** (`server/static/app.js`) — while a
   response streams, the daemon resyncs on *every* poll, because the final
   turn's HTML grows in place. Rebuilding `#transcript` from `innerHTML` on each
   of those makes the composer unusable (a DOM teardown drops the iOS text
   selection). Patch the changed turn; do not rebuild.

## Staying connected

The daemon must keep trying to reach the VPS for as long as the laptop has
network, whatever 9222 is doing. The failures that matter are the silent
ones — the process alive and no longer trying — because `node --watch`
does **not** restart after a crash either: it prints "Waiting for file
changes" and sits there until someone edits a file.

- **Two things can kill a connection without saying so.** A suspend leaves
  TCP half-open, and a wifi route change can black-hole an established
  socket; in both cases `readyState` stays OPEN and no `close` fires.
  `watchConnection` covers both: a wall-clock gap past `WAKE_GAP_MS` means
  the process was frozen, and inbound silence past `DEAD_AFTER_MS` means
  the socket is dead. The server's protocol-level ping is answered below
  the WebSocket API and never reaches daemon code, which is why the
  application-level `ping`/`pong` exists.
- **`forceReconnect` abandons the socket rather than waiting for a close
  that may never come**, and the generation counter stops a socket that
  comes back to life minutes later from dialling on top of the live one.
- **CDP being down must never cost the VPS link.** Listing returns
  `cdp: "unreachable"` and the phone says VS Code is not running; a
  subscribe that cannot attach keeps its watcher and lets the poll loop
  retry, because deleting it meant the session never recovered. Attach
  failures report once per outage, not once per poll.
- **The deploy watcher is optional, development-only, and must not be able
  to take the bridge down.** It is armed solely by `DEPLOY_TARGET`, which
  ships unset: a user running this never pushes anything anywhere, and the
  daemon says which mode it is in at startup, because nothing else makes
  that visible. When it is armed, every save under `server/` is a push to a
  live host with no review step, so what it excludes is load-bearing — see
  `DEPLOY_EXCLUDES`. An `FSWatcher` with no `error` listener exits the
  process, which would cost the bridge to save the convenience.
- Anything reached from an async event listener needs a `catch`. An
  unhandled rejection there is rethrown on the next tick and is fatal.

## Scraping someone else's DOM

Everything here reads a closed-source extension's markup, so the question
for any selector is not whether it will break but **whether anyone will
notice when it does**. Silent failure is the one to design against.

- Prefer semantic markup to CSS-module names. `aria-label`, `role` and
  `data-*` are contracts the extension keeps for accessibility or for its
  own code; `turn_07S1Yg` is a build artifact whose hash and prefix can
  both move. Where an element carries both, use the semantic one — the
  collapse unit is `[aria-label="You"]`, the session title comes from
  `data-initial-session`, and the frame picker prefers a frame containing
  `[data-transcript-message]` over merely the wordiest one.
- `[class*="turn_"]` has no semantic alternative and is load-bearing, so
  it gets a tell instead: finding message blocks but no turns reports a
  DOM mismatch once per watcher rather than an empty conversation.
- **`data-initial-session` means what it says.** It is written when a
  webview first mounts with a session to open, and VS Code restoring tabs
  after a restart does not write it — measured as 0 of 6 webviews carrying
  it, in the frame holding 286 transcript messages, so the frame was right
  and the attribute was simply absent. It is exact when present and worth
  preferring, but it cannot be the only route to a title. The fallback is
  the workbench's selected tab paired with the visible webview, learned one
  conversation at a time.
- Titles are cosmetic, so the rule there is *never wrong, sometimes
  missing*: `pickUniquePair` refuses to answer unless exactly one tab is
  selected and exactly one tracked webview is visible. Split editor groups
  teach it nothing rather than a guess. One line of diagnostics
  (`titles: n/m named …`) separates the three ways this can go quiet.
- A probe that stops matching should report, not return a plausible
  nothing. `running: null` is forwarded so the phone shows Unknown;
  `execCommand` returning false fails the submit instead of acking it.
- Cosmetic selectors — hidden copy buttons, Monaco chrome, line-height
  overrides — need no defending. They fail visibly and are cheap to
  re-derive from a fresh capture.

## Layout

```
Makefile             every command anyone needs to run, so they are not
                     only described in prose that drifts
client/
  cdp-client.js      CDP transport: attach, evaluate, frame and target picking
  daemon.js          the laptop bridge; also rsyncs server/ to the VPS on save
server/
  server.py          the VPS relay
  static/            phone web UI, no build step
tests/               deliberately outside server/ — deploy-watch rsyncs
                     server/ to production on every change, so a test file
                     there would ship and restart it on every edit
```

The repo root holds no source. Anything appearing there is a CDP spike, a
probe script or a captured dump, and `.gitignore` excludes the root by
pattern rather than by name — the list of names was always one debugging
session out of date.

## Tests

```bash
make test                          # both, which is what CI would run if there were any
node --test "tests/*.test.js"      # daemon + cdp-client + phone state machine
python3 tests/test_server.py       # server: pure logic, HTTP, WS flows
```

Both run offline. `tests/phone.test.js` evaluates `server/static/app.js` in a
sixty-line DOM shim — no browser, no dependency. It covers the **state
machine** and nothing else: that the module evaluates, that every element it
reaches for exists in `index.html`, and that a transition leaves the right
module-level variables describing the right conversation. Rendering, layout
and scrolling are still judged by use, and no assertion should reach for them.

That split exists because the state machine is where the defects were. A dozen
variables are mutated from socket callbacks, timers, gestures and the
navigation between the list and a conversation, and two review rounds found
five defects there of one shape: something in flight for the conversation
being left — a queued message, a send timer, a frame from the closing socket —
acting on the conversation being opened. `close()` does not discard frames
already in flight, and `state`/`append`/`resync` carry no `sessionId`, so the
socket's own identity is the only evidence of which conversation a frame
describes: **every** socket callback needs the generation guard, not just the
ones that had it.

When you add a test, prove it can fail: reintroduce the defect, confirm the test
fails, restore. Assert the mutation target exists before writing it — a
no-op mutation leaves the suite green, which reads exactly like success.

**Commit first, then mutate, then restore with `git checkout HEAD -- <path>`
and confirm with `git diff`.** The copy to restore from has to be the
pre-mutation state, and the only way to be sure of that is for it to be a
commit. A `cp` from the working tree captures whatever damage is already
there; `git checkout --` without a committed checkpoint reverts to the
*last* commit and silently drops the uncommitted work being tested. Both
have happened here, one after the other.
A mutation run that exceeds the command timeout is moved to the
background and can be killed between editing and restoring; a later
`cp working-tree backup` then captures the damage as the baseline and
propagates it. That has happened — `if mtype == "action_result":` survived
as `if False:` across two commands, and what caught it was a `git diff`
looking for leftovers, not the restore itself.

**A test must fail, not hang, when the defect is present.** Twice now a
test has been written so the reintroduced defect leaves it awaiting
something that never arrives — a queued call behind a holder that never
releases, a promise the socket death no longer settles. Under the test
runner that reads as a stuck suite, and it takes the rest of the file
down with it, so a mutation run reports nothing rather than reporting a
catch. Where the defect's shape is "never settles", race the await
against a short timer and assert on which one won.

The suite takes about sixteen seconds, and two tests account for twelve
of them: the reconnect that is never observed to start, and the MCP panel
that never opens. Both are waiting out a real timeout in the code under
test. Neither is slow by accident, and neither can be shortened without
either making the timeout injectable — test-only machinery in production
code — or dropping the case.

**A DOM expression must be proved to parse, not just to be a valid
string.** These are built inside template literals and evaluated in a
browser, so a backslash is consumed twice: `\/` in the source reaches the
page as `/`, which turns `/^\//` into `/^//` and makes the whole
expression a syntax error at the moment it runs. `node --check` sees a
perfectly good string, and the failure surfaces as an opaque CDP
exception on someone's phone. One test evaluates every expression with
`new Function`, including the generated ones against an argument full of
quotes, backslashes and `${}`.

## What Claude Code's webview actually does

Verified by spiking against a live instance before any of this was built.
None of it is documented anywhere, and all of it would be expensive to
re-derive.

- Multiple Claude Code tabs stay attachable over CDP at once, whichever is
  focused — VS Code keeps hidden webviews' content alive.
- Cmd+Enter submits a prompt. Plain Enter does not.
- The send button's `aria-label` flips between `"Send message"` and
  `"Stop"`, and that is the busy/idle signal. `aria-busy` and
  spinner-class heuristics do **not** change between states.
- CDP push (`Runtime.addBinding` + `MutationObserver`) works, but fires on
  every DOM mutation and answers "is it finished" no better than polling
  the signal above. Not used.

## Wire protocol

Two independent links, both JSON text frames over WebSocket.

**Client daemon <-> VPS** (`/ws/client`):

Content is always an array of **turns** — complete, independently-valid HTML
fragments, one per `[class*="turn_"]` element in the captured DOM — never a
single flat HTML string. This is load-bearing: slicing/capping a flat string
by byte offset cuts through tag nesting and produces malformed fragments
(confirmed in practice once lazy-loading shipped); slicing by whole turns is
always well-formed no matter where the cut falls. See daemon.js's POLL_EXPR
comment and server.py's SessionState for the details.

```
client -> VPS:
  {type:"hello", token}
  {type:"sessions_result", reqId, sessions:[...], cdp:"ok"|"unreachable", cdpError?}
  {type:"state", sessionId, running}
  {type:"append", sessionId, turns}      # extend what VPS has
  {type:"resync", sessionId, turns}      # capped tail — VPS reconciles by
                                          # content-overlap, see apply_resync
  {type:"submit_ack", sessionId, ok, error?}
  {type:"action_result", reqId, ok, error?, ...}   # reply to a phone action
  {type:"error", sessionId, message}     # once per outage, not per poll
  {type:"recovered", sessionId}          # its counterpart: the attach came
                                          # back. Without it the outage
                                          # notice is the last word, since
                                          # an unchanged session sends
                                          # nothing else afterwards
  {type:"pong"}

VPS -> client:
  {type:"auth_ok"} / {type:"auth_failed"}
  {type:"list_sessions", reqId}
  {type:"subscribe", sessionId}          # start polling this session
  {type:"unsubscribe", sessionId}        # stop polling it
  {type:"submit", sessionId, text}
  {type:"new_session", reqId, text}         # click New session, then type
  {type:"list_mcp", reqId, sessionId?}      # open the MCP panel and read it
  {type:"reconnect_mcp", reqId, serverName, sessionId?}
  {type:"ping"}
```

`sessionId` on the two MCP frames is optional and is the phone answering a
refusal. The daemon picks the conversation in front when it can tell; when
it cannot — a split editor, or no Claude tab on screen, which is the
ordinary state when nobody is at the laptop — it refuses rather than
guessing and returns the candidates, and the phone names one.

**Phone <-> VPS** (`/ws/phone/<session_id>`, open only while that session's
detail view is on screen):

```
VPS -> phone:
  {type:"initial", turns, startIndex, running}  # tail window, sent once
  {type:"state", running}
  {type:"append", turns}
  {type:"resync", turns, startIndex}     # same tail-window cap as initial —
                                          # reset your pagination cursor to
                                          # startIndex, don't just append
  {type:"submit_ack", ok, error?}        # to the socket that submitted,
                                          # in order — broadcast, a second
                                          # tab disowns its own message
  {type:"error", message}                # forwarded from the daemon
  {type:"recovered"}                     # and its counterpart
  {type:"laptop", connected}             # the VPS lost or regained the
                                          # daemon. The phone's own ping
                                          # only proves the VPS is up
  {type:"pong"}

phone -> VPS:
  {type:"submit", text}
  {type:"ping"}                          # iOS suspends a backgrounded tab
                                          # and the socket comes back OPEN
                                          # but dead; protocol-level pings
                                          # are answered below the
                                          # WebSocket API, where page code
                                          # cannot see them
```

The last three drive Claude Code's own UI by clicking real controls,
because what they trigger has no other entry point. `mcp_reconnect` is an
Agent SDK control request carried over the anonymous socketpair between
the VS Code extension host and that session's CLI process: `claude mcp`
has no reconnect subcommand, the extension registers no MCP command, and
the IDE's own WebSocket RPC (`~/.claude/ide/<port>.lock`) exposes twelve
tools that are all editor operations. Reading the MCP list opens that
panel on the laptop, so it happens only when the phone asks, and the
panel is closed again afterwards.

`cdp` exists because an empty session list has three causes the phone has to
tell apart, and two of them used to look identical. `no-daemon` (the VPS
cannot reach the laptop at all, HTTP 503) was already distinguishable;
`unreachable` (the daemon is up, nothing answered on port 9222 — VS Code
closed, restarting, or launched without `--remote-debugging-port`) and `ok`
with an empty list (VS Code running, no Claude Code tabs) were both just
"no sessions".

`startIndex` is the absolute index (into the server's stored turns list) of
the oldest turn in that message — the cursor `/api/session/<id>/history` scroll-up
pagination uses (`before_index`, `limit_bytes` query params, returns
`{turns, has_more, start_index}`).

Subscribe/unsubscribe is refcounted by "does any phone websocket currently
have this session open" — the daemon only polls sessions someone is actually
looking at. Nobody watching = zero daemon-side polling, zero traffic on the
VPS link.

## Design notes / where the numbers are

- `INITIAL_LOAD_BYTES` (server env, default 2048) — target size (in whole
  turns, rounded up to include whichever turn crosses the threshold, via
  `tail_window()`) for the tail context a phone gets immediately on opening
  a session; scrolling up pages further back via
  `/api/session/<id>/history?before_index=&limit_bytes=`.
- `MAX_SESSION_BYTES` (server env, default 1MB) — per-session cap on
  retained turns; oldest *whole* turns dropped once the combined size
  exceeds this (never a partial turn — that would reintroduce the malformed-
  HTML problem this design exists to avoid). This is also the real ceiling
  on "scroll all the way to the top" — history older than this (or older
  than whenever the daemon started watching, whichever is more recent) is
  gone, not just unpaginated. Three review rulings (F1.2, F5.1, F12.5)
  decline work on the grounds that the defect is unreachable below this
  number, so raising it widens what they left uncovered.
- No HTML sanitization, no CSS extraction from the Claude Code webview — by
  design, this is a single-user personal tool (the CSS actually is Claude
  Code's own, copied from the installed extension — see
  `server/static/claude-webview.css` and `vscode-vars.css`). `app.js` inserts
  captured HTML via `.innerHTML =`, which as a side effect of how browsers
  parse it won't execute embedded `<script>` tags — not a deliberate
  security control, just noting it. Class names are CSS-module-hashed with a
  semantic prefix (e.g. `turn_07S1Yg`, `sendButton_gGYT1w`) — `style.css`
  matches on the prefix via `[class*="turn_"]` so it survives the hash
  suffix changing across versions; the prefix itself isn't guaranteed stable
  long-term either.
- Session identity (`sessionId`) is the VS Code webview's own `id=` query
  param — stable for that tab's lifetime, gone if the tab is closed and
  reopened (or VS Code restarts).
- One connected client daemon assumed throughout (single laptop). A second
  one connecting replaces the first's WebSocket rather than erroring.
- The phone's WebSocket reconnects with backoff on its own (`app.js`) — this
  is load-bearing, not cosmetic, because the VPS restarts on every deploy.
- **Only the VPS persists anything — that's deliberate, one copy, not two.**
  The daemon is a stateless bridge: it re-reads VS Code's live DOM on every
  restart and has no reason to remember anything across restarts, since the
  actual source of truth (VS Code) is right there. This only works because
  every fresh `SessionWatcher` forces its *first* poll result out as a
  `resync`, not a diff — without that, `''.startsWith('')` being vacuously
  true would make a fresh watcher report its first full-content read as an
  "append", and the VPS would concatenate a full duplicate snapshot onto its
  one persisted copy on every single daemon restart. Symmetrically, the VPS
  re-issues `subscribe` for every session a phone is still watching as soon
  as a daemon (re)authenticates — otherwise a daemon restart would leave
  those sessions silently unwatched until someone manually reopens them.

## What's still untested end-to-end

The suites cover the protocol, the daemon's pure logic and the phone's
state machine offline; what none of them touch is the real world. Both
stub CDP and the network, so nothing here has met a live VS Code, a real
reverse proxy, or an iOS Safari. Sixteen review rounds found no defect
involving time, size or accumulation, which most likely means the method
cannot see that class rather than that it is absent — no test runs longer
than sixteen seconds or against more than a handful of turns.

Worth a real session with the phone in hand: cookie and WebSocket
handshake interplay across the reverse proxy; behaviour over hours rather
than minutes (log growth, memory, the 30-day cookie actually expiring);
and the one-shot-attach path in `daemon.js`'s `submit` handler for a
session that is not currently subscribed.

## Conventions

- Commits follow `eviworkspace`'s: `<type>(<scope>): [skip jira] <subject>`.
  Bodies carry what the diff cannot — the rejected alternative, the non-obvious
  constraint, what verified it.
- Comments explain *why*, especially where a line looks arbitrary. Most of the
  non-obvious ones here encode an empirical finding about Claude Code's webview
  (the `aria-label` busy signal, Cmd+Enter, `purpose=webviewView`) that cannot
  be cited to any spec and would be re-derived expensively if dropped.
- Never narrate a fix's own history. State what is true now and why.
- The tunable knobs live at the top of `server/static/style.css`
  (`--app-font-scale`, `--app-line-height`, `--app-input-font-size`,
  `--collapsed-max-height`) and are the author's to set.
