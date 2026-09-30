# ClaudeAnywhere

Use the Claude Code conversation that is already open on your laptop — from
your phone, from anywhere.

Not a second session. Not a terminal in a browser. ClaudeAnywhere attaches to
the Claude Code window running in your own VS Code and mirrors *that*
conversation: the same history, the same context, the same running task. You
read it on your phone and you type into it, and what you send arrives in the
window you left open.

Everything runs on machines you own — your laptop, and a small relay on your
own VPS. No third-party service sits in the middle.

> Not affiliated with or endorsed by Anthropic. This is an independent
> project and is not Claude Code's own Remote Control feature.

---

## Why you might want this

- **Long tasks don't need you at the desk.** Start something, walk away,
  watch it from the bus, answer the question it asks at minute nine.
- **It is the same conversation.** Tools that drive a fresh headless session
  can't show you the one you already have open, with its context and its
  half-finished work. This can.
- **It can press buttons that have no API.** Reconnecting an MCP server, for
  example, exists only as a control in the UI — no CLI command, no extension
  command, nothing on the IDE's RPC. ClaudeAnywhere clicks the real control.
- **Self-hosted end to end.** Your laptop talks to your VPS and nothing else.
  One secret, which you generate.

## What you can do from the phone

- Read any open conversation live, including replies as they stream in.
- Send a message into it.
- See whether Claude is working or waiting for you.
- Start a new conversation with a first prompt.
- List MCP servers and reconnect one that has dropped.

## What you need

- A laptop running VS Code with the Claude Code extension.
- A small VPS with a domain and HTTPS (Caddy or nginx in front — see below).
- Node 22+ on the laptop, Python 3.11+ on the VPS.

## Setup

```bash
git clone <your-fork> claude-anywhere
cd claude-anywhere
make setup
```

That writes `client/.env` and `server/.env` and installs the server's
dependencies. Now open both files and set **the same** `AUTH_TOKEN` in each —
it is the daemon's credential and your phone's password, deliberately one
secret:

```bash
openssl rand -hex 32
```

Also set `VPS_WS_URL` in `client/.env` to your relay's WebSocket URL.

**On the VPS**, put the relay behind TLS and start it:

```bash
make server
```

`server.py` binds a plain HTTP/WebSocket port with no TLS of its own, and
your password crosses that connection in the clear. Terminate `https://` and
`wss://` in front of it with Caddy or nginx. Do not expose the raw port.

**On the laptop**, VS Code has to be started with its debug port open — there
is no way to switch it on afterwards:

```bash
make vscode     # quits VS Code, relaunches it with the port open
make client     # the bridge
```

Then open `https://your-relay.example.com/` on your phone, enter the same
`AUTH_TOKEN` as the password, and pick a conversation.

Stuck? `make check` tells you which of the three links is down — the debug
port, the two `.env` files, or the relay.

## How it works

```
VS Code on your laptop
   └── Claude Code window ──CDP──► client/daemon.js  (your laptop)
                                         │ WebSocket
                                         ▼
                                   server/server.py  (your VPS)
                                         │ WebSocket / HTTPS
                                         ▼
                                   your phone's browser
```

The daemon attaches to VS Code's own renderer over the Chrome DevTools
Protocol, reads the conversation out of the live page, and sends the parts
that changed. The relay keeps one copy of each conversation so your phone can
scroll back, and passes your messages the other way. The daemon only watches
conversations a phone currently has open — close the tab and it stops
polling entirely.

## Worth knowing before you rely on it

- **It reads a closed-source extension's page.** Claude Code is free to
  change its markup in any release, and when it does, something here breaks.
  It is built to break *loudly*: if the selectors stop matching, your phone
  says so instead of showing you an empty conversation.
- **History is capped** at 1MB per conversation (`MAX_SESSION_BYTES`), oldest
  messages dropped first. Scrolling up stops there.
- **One laptop, one user.** A second daemon connecting replaces the first.
- **A conversation is identified by its VS Code tab.** Close and reopen the
  tab, or restart VS Code, and it counts as a new one.
- **The phone cannot answer interactive prompts** that Claude Code renders as
  its own picker — you will see the question, but choosing still happens at
  the laptop.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, the wire protocol, the
standard this code is held to, and how to run the tests.

```bash
make test
```
