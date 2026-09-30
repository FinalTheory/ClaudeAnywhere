# ClaudeAnywhere — the commands you actually need, so they live in one place
# instead of in a README that drifts.
#
#   make            what you can run
#   make setup      create both .env files and install dependencies
#   make vscode     (re)start VS Code with the debug port open
#   make client     run the laptop bridge
#   make server     run the relay locally
#   make check      is everything this needs actually up?
#   make test       both suites

SHELL := /bin/bash
CDP_PORT ?= 9222
UNAME := $(shell uname -s)

# VS Code has to be started with the debug port; there is no way to turn it
# on afterwards, and argv.json will not carry the flag. Its own `code`
# launcher forwards unknown flags to a *running* instance rather than
# applying them, so this invokes the binary directly.
ifeq ($(UNAME),Darwin)
VSCODE_BIN ?= /Applications/Visual Studio Code.app/Contents/MacOS/Electron
else
VSCODE_BIN ?= $(shell command -v code 2>/dev/null)
endif

.DEFAULT_GOAL := help
.PHONY: help setup vscode client server check test clean

help:
	@echo "ClaudeAnywhere"
	@echo
	@echo "  make setup     create client/.env and server/.env, install dependencies"
	@echo "  make vscode    (re)start VS Code with --remote-debugging-port=$(CDP_PORT)"
	@echo "  make client    run the laptop bridge (needs VS Code from 'make vscode')"
	@echo "  make server    run the relay on this machine"
	@echo "  make check     check the debug port, the .env files and the VPS"
	@echo "  make test      run both test suites"
	@echo
	@echo "First run:  make setup  ->  edit the two .env files  ->  make vscode  ->  make client"

setup:
	@for side in client server; do \
	  if [ -f $$side/.env ]; then \
	    echo "$$side/.env exists, leaving it alone"; \
	  else \
	    cp $$side/.env.example $$side/.env; \
	    echo "created $$side/.env"; \
	  fi; \
	done
	@echo
	@echo "Installing server dependencies..."
	@python3 -m pip install -q -r server/requirements.txt
	@echo
	@echo "Now set AUTH_TOKEN to the SAME value in both .env files."
	@echo "It is the daemon's token and the phone's password, deliberately one secret."
	@echo "Generate one with:  openssl rand -hex 32"
	@echo
	@echo "The server refuses to start on a token shorter than 16 characters,"
	@echo "because an empty one authenticates anybody."

# Quits the running instance first: the flag only applies at process start,
# so launching a second time without this silently reuses the existing
# window and the port never opens.
vscode:
	@if curl -sf --max-time 2 http://127.0.0.1:$(CDP_PORT)/json/version >/dev/null 2>&1; then \
	  echo "VS Code is already listening on $(CDP_PORT) — nothing to do."; \
	  exit 0; \
	fi
	@if [ ! -x "$(VSCODE_BIN)" ] && [ -z "$$(command -v "$(VSCODE_BIN)")" ]; then \
	  echo "Could not find VS Code at: $(VSCODE_BIN)"; \
	  echo "Set it explicitly:  make vscode VSCODE_BIN=/path/to/code"; \
	  exit 1; \
	fi
	@echo "VS Code must be fully quit for the debug port to open."
	@echo "Quit it now (Cmd+Q on macOS — closing the window is not enough), then press Enter."
	@read -r _
	@echo "Starting VS Code with --remote-debugging-port=$(CDP_PORT)..."
	@"$(VSCODE_BIN)" --remote-debugging-port=$(CDP_PORT) \
	  --disable-background-timer-throttling \
	  --disable-backgrounding-occluded-windows \
	  --disable-renderer-backgrounding >/dev/null 2>&1 &
	@echo "Open your Claude Code conversations, then run: make client"

client: client/.env
	@cd client && node --watch --env-file=.env daemon.js

server: server/.env
	@cd server && if command -v watchfiles >/dev/null 2>&1; then \
	  watchfiles 'python3 server.py' . --ignore-paths=data,__pycache__,.env; \
	else \
	  echo "(watchfiles not installed — running without auto-restart)"; \
	  python3 server.py; \
	fi

client/.env server/.env:
	@echo "$@ is missing. Run: make setup"
	@exit 1

check:
	@echo "== VS Code debug port =="
	@if curl -sf --max-time 2 http://127.0.0.1:$(CDP_PORT)/json/version >/dev/null 2>&1; then \
	  echo "  ok — listening on $(CDP_PORT)"; \
	else \
	  echo "  NOT listening on $(CDP_PORT). Run: make vscode"; \
	fi
	@echo "== configuration =="
	@for side in client server; do \
	  if [ -f $$side/.env ]; then echo "  $$side/.env present"; \
	  else echo "  $$side/.env MISSING — run: make setup"; fi; \
	done
	@if [ -f client/.env ] && [ -f server/.env ]; then \
	  c=$$(grep -E '^AUTH_TOKEN=' client/.env | cut -d= -f2-); \
	  s=$$(grep -E '^AUTH_TOKEN=' server/.env | cut -d= -f2-); \
	  if [ -z "$$c" ] || [ "$$c" != "$$s" ]; then \
	    echo "  AUTH_TOKEN DIFFERS between the two .env files — the daemon will not authenticate"; \
	  elif [ $${#c} -lt 16 ]; then \
	    echo "  AUTH_TOKEN is shorter than 16 characters — the server will refuse to start"; \
	  else \
	    echo "  AUTH_TOKEN matches on both sides"; \
	  fi; \
	fi
	@echo "== relay =="
	@url=$$(grep -E '^VPS_WS_URL=' client/.env 2>/dev/null | cut -d= -f2- | sed -e 's|^wss://|https://|' -e 's|^ws://|http://|' -e 's|/ws/client$$||'); \
	if [ -z "$$url" ]; then echo "  VPS_WS_URL not set in client/.env"; \
	elif curl -sf --max-time 5 "$$url/healthz" >/dev/null 2>&1; then echo "  ok — $$url answers /healthz"; \
	else echo "  $$url is not answering /healthz"; fi

test:
	@node --test "tests/*.test.js"
	@python3 tests/test_server.py

clean:
	@rm -f client/daemon.log
	@find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@echo "cleaned"
