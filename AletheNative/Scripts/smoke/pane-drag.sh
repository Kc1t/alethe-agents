#!/usr/bin/env bash
# Pane host drags with REAL mouse events (XCUITest's synthesized drags never reach AppKit's
# mouseDragged): live split resize, container resize and header drag-to-reorder. Launches a debug
# build on a throwaway data folder and checks workspace.json. Moves the actual pointer: do not use
# the Mac while it runs.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP=build/DerivedData/Build/Products/Debug/Alethe.app
[[ -x build/mousedrag ]] || swiftc -O -o build/mousedrag Scripts/dev/mousedrag.swift
DATA="/private/tmp/alethe-smoke-$$"
trap 'osascript -e "quit app id \"com.kc1t.alethe.mac.debug\"" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

open -n "$APP" --args -AletheDataRoot "$DATA" -AletheUITestSeed panes -AppleLanguages "(en)"
for _ in $(seq 1 40); do
  PID=$(pgrep -n -f "Debug/Alethe.app/Contents/MacOS/Alethe" || true)
  [[ -n "$PID" && -f "$DATA/profiles/default/workspace.json" ]] && break
  sleep 0.25
done
sleep 2

state() { # <python expression over d (document) and api (the api project)>
  python3 - "$DATA/profiles/default/workspace.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
api = next(p for p in d["projects"] if p["name"] == "api")
print(eval(sys.argv[2]))
PY
}

check() { # <description> <python condition>
  sleep 1.5
  if [[ "$(state "$2")" == "True" ]]; then echo "ok   $1"; else echo "FAIL $1"; echo "  document: $(state 'd["workspace"]')"; exit 1; fi
}

build/mousedrag "$PID" pane.divider.column.0 pane.header.one >/dev/null
check "dragging a split narrows the left column" \
  'd["workspace"]["gridWeights"][api["id"]]["columns"][0] < 0.45'

build/mousedrag "$PID" container.divider.0 container.close.web >/dev/null
check "dragging between containers widens the first" 'd["workspace"]["containerWeights"][0] > 0.6'

build/mousedrag "$PID" pane.header.one pane.header.two >/dev/null
check "dragging a header onto another pane swaps them" \
  '[t["title"] for p in api["panes"] for t in p["tabs"]] == ["two", "one", "three"]'

echo "pane-drag: all passed"
