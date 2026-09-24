# Claude Code mobile remote — personal side project

Reads/controls Claude Code sessions running in your desktop VS Code from your
phone, via CDP (Chrome DevTools Protocol) attached to VS Code's own renderer.
Not affiliated with or sanctioned by Anthropic; not Anthropic's Remote
Control feature — this is a from-scratch reimplementation built because that
feature is disabled by policy in this environment.

## How it works

```
VS Code (your laptop)
  └─ Claude Code webview  ──CDP──►  client/daemon.js (your laptop)
                                          │ WebSocket
                                          ▼
                                    server/server.py (your VPS)
                                          │ WebSocket / HTTP
                                          ▼
                                    phone browser
```

Confirmed empirically (this was all spiked and verified before building the
real system — see git history / chat log if you want the how):

- Multiple Claude Code tabs stay attachable via CDP simultaneously regardless
  of which is focused — VS Code retains their webview content even hidden.
- Cmd+Enter submits a prompt; plain Enter does not.
- The send button's `aria-label` flips `"Send message"` <-> `"Stop"` — this
  is the busy/idle signal. `aria-busy` and spinner-class heuristics do **not**
  change between states and are not used.
- CDP push (`Runtime.addBinding` + `MutationObserver`) works but fires on
  every DOM mutation — much higher frequency than useful here, and doesn't
  answer "is it done running" any better than polling the signal above does.
  Not used in the real system; `verify-push.js` stays as the record of why.

## Layout

```
remote/
  cdp-client.js, list-targets.js, scan-frames.js,
  read-transcript*.js, send-prompt.js,
  detect-running-state.js, verify-push.js   manual CDP debugging tools —
                                             read the comment at the top of
                                             whichever one you need
  client/
    daemon.js          runs on your laptop — bridges CDP to the VPS, and
                        (if DEPLOY_TARGET is set) also rsyncs server/ to the
                        VPS on save
  server/
    server.py, requirements.txt
    static/            phone web UI (no build step)
```

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
  {type:"error", sessionId, message}

VPS -> client:
  {type:"auth_ok"} / {type:"auth_failed"}
  {type:"list_sessions", reqId}
  {type:"subscribe", sessionId}          # start polling this session
  {type:"unsubscribe", sessionId}        # stop polling it
  {type:"submit", sessionId, text}
```

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
  {type:"submit_ack", ok, error?}

phone -> VPS:
  {type:"submit", text}
```

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

## Tests

```bash
node --test "tests/*.test.js"      # daemon + cdp-client (no deps, no network)
python3 tests/test_server.py       # server: pure logic, HTTP, and WS flows
```

`tests/` sits outside `server/` deliberately — the daemon's deploy-watch
rsyncs `server/` to the VPS on every change, and a test file landing there
would ship to production and restart it on every edit.

Both suites run offline: the Node tests stub `fetch` and the CDP client
seam (`daemon.js` holds `cdp` as a module object rather than destructuring
it, so a test can substitute `cdp.evaluate`); the Python tests use
aiohttp's test client with a fake daemon on the other end of `/ws/client`.
Every test was checked against a mutation of the behaviour it names — see
the commit that added them.

## Running it

**VPS — must sit behind TLS.** `server.py` binds a raw HTTP/WS port with no
TLS of its own; the login password goes over that connection in plaintext.
Put Caddy or nginx in front terminating `https://`/`wss://` before exposing
this to the public internet — don't hit the raw port directly from outside.

```bash
cd server
pip install -r requirements.txt
cp .env.example .env   # edit AUTH_TOKEN at minimum
watchfiles 'python server.py' . --ignore-paths=data,__pycache__,.env
```

`watchfiles` restarts the process whenever a file under `.` changes — the
VPS-side half of the deploy loop below. `--ignore-paths=data` is not
optional: `server.py` writes a JSON file per session under `./data` on every
`append`/`state` update, and without excluding it a busy conversation would
make the process restart itself continuously.

**Laptop — one process does both the CDP bridge and (optionally) the deploy:**

```bash
cd client
cp .env.example .env   # edit VPS_WS_URL and AUTH_TOKEN at minimum
node --watch --env-file=.env daemon.js
```

`node --watch` restarts `daemon.js` on save; the reconnect-with-backoff to
the VPS already handles that the same way it'd handle a network blip. If
`DEPLOY_TARGET` is set in `.env`, the same process also watches `../server`
and rsyncs it to the VPS on every change — one `node --watch` loop, edit
anything on either side, both redeploy. Uses your own SSH key/agent, same as
running `rsync` by hand.

**Phone:** open `https://your-vps.example.com/`, enter the password (same
value as `AUTH_TOKEN`), pick a session.

## Design notes / where the numbers are

- `INITIAL_LOAD_BYTES` (server env, default 2048) — target size (in whole
  turns, rounded up to include whichever turn crosses the threshold, via
  `tail_window()`) for the tail context a phone gets immediately on opening
  a session; scrolling up pages further back via
  `/api/session/<id>/history?before_index=&limit_bytes=`.
- `MAX_SESSION_BYTES` (server env, default 5MB) — per-session cap on
  retained turns; oldest *whole* turns dropped once the combined size
  exceeds this (never a partial turn — that would reintroduce the malformed-
  HTML problem this design exists to avoid). This is also the real ceiling
  on "scroll all the way to the top" — history older than this (or older
  than whenever the daemon started watching, whichever is more recent) is
  gone, not just unpaginated.
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

Written in one pass without a live VPS or a real target to point the daemon
at. `node --check` and `python3 -m py_compile` pass; the protocol is
reasoned through but not exercised in practice. Spend a real debugging pass
on: cookie/WebSocket-handshake interplay across the reverse proxy, the
pagination offset math in `app.js`, and the one-shot-attach path in
`daemon.js`'s `submit` handler for a session that isn't currently subscribed
(never run).
