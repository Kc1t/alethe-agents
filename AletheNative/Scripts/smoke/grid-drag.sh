#!/usr/bin/env bash
# Custom grid drags with REAL mouse events (P2-19): a pane dragged onto a free slot moves there, a
# grid divider resizes its track. Launches a debug
# build on a throwaway data folder and checks workspace.json. Moves the actual pointer: do not use
# the Mac while it runs.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP=build/DerivedData/Build/Products/Debug/Alethe.app
[[ -x build/mousedrag ]] || swiftc -O -o build/mousedrag Scripts/dev/mousedrag.swift
DATA="/private/tmp/alethe-smoke-$$"
trap 'osascript -e "quit app id \"com.kc1t.alethe.mac.debug\"" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

open -n "$APP" --args -AletheDataRoot "$DATA" -AletheUITestSeed grid -AppleLanguages "(en)"
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

build/mousedrag "$PID" pane.header.three grid.slot.2.2 >/dev/null
check "dragging a pane onto a free slot moves it there" \
  'api["gridLayout"]["cells"][api["panes"][2]["id"]]["col"] == 2'

build/mousedrag "$PID" pane.divider.gridColumn.0.0 pane.header.one >/dev/null
check "dragging a grid divider resizes its column" 'api["gridLayout"]["colSizes"][0] < 0.45'

echo "grid-drag: all passed"
