#!/usr/bin/env bash
# Headless check against a real Tern: starts `tern serve`, opens an agent block running
# test/dev-launch.cmd (or $LAUNCH), plays the ctl commands given one per argument, then quits.
#   test/shot.sh 'type "/t-select"' 'key Enter' '!sleep 1.5' 'shot select'
# `wait N` only advances Tern's virtual clock (it returns at once): use "!sleep N" to give pi real time.
# Screenshots and layout JSON land in $OUT/serve/ (default: $TEMP/pi-tern-shots).
set -u
# Git Bash would turn "/t-select" into a Windows path before ctl sees it.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
HERE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
PORT="${PORT:-47812}"
OUT="${OUT:-${TEMP:-/tmp}/pi-tern-shots}"
mkdir -p "$OUT"
command -v cygpath >/dev/null && OUT="$(cygpath -m "$OUT")"
# Tern's panes do not inherit this shell's environment: the launcher picks the log path.
LOG="${TEMP:-/tmp}/pi-tern-dev.jsonl"
command -v cygpath >/dev/null && LOG="$(cygpath -m "$LOG")"
rm -f "$LOG"
# pi writes into the fixture config (settings changed in a test, changelog version): put it back afterwards
cp "$HERE/agent/settings.json" "$OUT/settings.json.bak"
ctl() { tern ctl --control "$PORT" "$@"; }

node "$HERE/mock-llm.mjs" >"$OUT/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; cp "$OUT/settings.json.bak" "$HERE/agent/settings.json"' EXIT
sleep 1
# a mock left over from another run would answer instead (and stall when its parent is gone)
if ! kill -0 "$MOCK" 2>/dev/null; then echo "mock-llm did not start (port 47899 busy?):"; cat "$OUT/mock.log"; exit 1; fi
tern serve --control "$PORT" --out "$OUT" >"$OUT/serve.log" 2>&1 &
for _ in $(seq 1 50); do ctl state >/dev/null 2>&1 && break; sleep 0.2; done
# The agent command must be the bare launcher path: Tern rejects anything else and silently falls
# back to its default agent (omp, with your real accounts), and the scenario would type into that.
ctl agent-command "\"$HERE/${LAUNCH:-dev-launch.cmd}\"" >/dev/null
ctl block agent >/dev/null
sleep "${BOOT:-12}"
# Only go on when the pane really runs the dev launcher: its pi writes the debug log and greets Tern.
if ! grep -q '"r":"hello"' "$LOG" 2>/dev/null; then
	echo "ABORT: the agent block is not running test/${LAUNCH:-dev-launch.cmd} (no hello in $LOG); nothing was typed"
	ctl quit >/dev/null 2>&1
	exit 1
fi
for cmd in "$@"; do
	if [[ "$cmd" == "!"* ]]; then bash -c "${cmd:1}"   # "!..." runs a local shell command
	else ctl "$cmd"; fi   # ctl parses one command line itself, quotes included
done
ctl quit >/dev/null 2>&1
echo "errors from Tern:"
grep -F '"ev":"error"' "$LOG" | head -20 || true
echo "log: $LOG"
