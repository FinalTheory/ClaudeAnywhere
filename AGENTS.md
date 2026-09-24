# Agent guide — remote/

A personal tool that mirrors and drives Claude Code sessions running in the
author's desktop VS Code from a phone. Own git repo, not part of
`eviworkspace`'s. See [`README.md`](README.md) for how it works, the wire
protocol, and how to run it.

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

Three places have earned scrutiny, because each has produced a visible defect:

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
- **The deploy watcher is optional and must not be able to take the bridge
  down.** An `FSWatcher` with no `error` listener exits the process.
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
cdp-client.js            shared CDP client
list-targets.js, scan-frames.js, read-transcript*.js, send-prompt.js,
detect-running-state.js, verify-push.js
                         manual CDP debugging tools, gitignored
client/daemon.js         laptop bridge; also rsyncs server/ to the VPS on save
server/server.py         VPS relay
server/static/           phone web UI, no build step
tests/                   deliberately outside server/ — deploy-watch rsyncs
                         server/ to production on every change
```

## Tests

```bash
node --test "tests/*.test.js"      # daemon + cdp-client
python3 tests/test_server.py       # server: pure logic, HTTP, WS flows
```

Both run offline. No test covers `server/static/` — that is UI work, judged by
using it rather than by assertion, and testing it would mean a browser
dependency. **A change confined to `server/static/` does not need a review
round.**

When you add a test, prove it can fail: reintroduce the defect, confirm the test
fails, restore. Assert the mutation target exists before writing it — a
no-op mutation leaves the suite green, which reads exactly like success.

**Take the pre-mutation copy from git, not from the working tree, and
confirm the restore with `git diff` rather than trusting the copy back.**
A mutation run that exceeds the command timeout is moved to the
background and can be killed between editing and restoring; a later
`cp working-tree backup` then captures the damage as the baseline and
propagates it. That has happened — `if mtype == "action_result":` survived
as `if False:` across two commands, and what caught it was a `git diff`
looking for leftovers, not the restore itself.

**A DOM expression must be proved to parse, not just to be a valid
string.** These are built inside template literals and evaluated in a
browser, so a backslash is consumed twice: `\/` in the source reaches the
page as `/`, which turns `/^\//` into `/^//` and makes the whole
expression a syntax error at the moment it runs. `node --check` sees a
perfectly good string, and the failure surfaces as an opaque CDP
exception on someone's phone. One test evaluates every expression with
`new Function`, including the generated ones against an argument full of
quotes, backslashes and `${}`.

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
