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
3. **The phone's resync render path** (`server/static/app.js`) — while a
   response streams, the daemon resyncs on *every* poll, because the final
   turn's HTML grows in place. Rebuilding `#transcript` from `innerHTML` on each
   of those makes the composer unusable (a DOM teardown drops the iOS text
   selection). Patch the changed turn; do not rebuild.

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
