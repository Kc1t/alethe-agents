#!/usr/bin/env bash
# Sidebar drag and drop with REAL mouse events (XCUITest cannot start SwiftUI drag sessions on
# macOS). Launches a debug build on a throwaway data folder, drags rows by accessibility id and
# checks workspace.json. Moves the actual pointer: do not use the Mac while it runs.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP=build/DerivedData/Build/Products/Debug/Alethe.app
[[ -x build/mousedrag ]] || swiftc -O -o build/mousedrag Scripts/dev/mousedrag.swift
DATA="/private/tmp/alethe-smoke-$$"
trap 'osascript -e "quit app id \"com.kc1t.alethe.mac.debug\"" >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT

open -n "$APP" --args -AletheDataRoot "$DATA" -AletheUITestSeed sidebar -AppleLanguages "(en)"
for _ in $(seq 1 40); do
  PID=$(pgrep -n -f "Debug/Alethe.app/Contents/MacOS/Alethe" || true)
  [[ -n "$PID" && -f "$DATA/profiles/default/workspace.json" ]] && break
  sleep 0.25
done
sleep 1

layout() {
  python3 - "$DATA/profiles/default/workspace.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
names = {p["id"]: p["name"] for p in d["projects"]}
groups = {g["name"]: [names[i] for i in g["projectIDs"]] for g in d["groups"]}
print(json.dumps({"groups": groups, "ungrouped": [names[i] for i in d["ungroupedProjectIDs"]]}, sort_keys=True))
PY
}

expect() { # <description> <expected json>
  sleep 1
  local actual; actual=$(layout)
  if [[ "$actual" == "$2" ]]; then echo "ok   $1"; else echo "FAIL $1"; echo "  expected $2"; echo "  actual   $actual"; exit 1; fi
}

build/mousedrag "$PID" sidebar.project.scratch sidebar.group.Clients >/dev/null
expect "drop on a group row moves the project inside" \
  '{"groups": {"Clients": ["client-site", "scratch"], "Work": ["alpha", "beta"]}, "ungrouped": []}'

build/mousedrag "$PID" sidebar.project.scratch sidebar.project.alpha >/dev/null
expect "drop on a project row inserts before it" \
  '{"groups": {"Clients": ["client-site"], "Work": ["scratch", "alpha", "beta"]}, "ungrouped": []}'

build/mousedrag "$PID" sidebar.project.beta sidebar.project.scratch -12 >/dev/null
expect "drop in the gap above a row inserts there" \
  '{"groups": {"Clients": ["client-site"], "Work": ["beta", "scratch", "alpha"]}, "ungrouped": []}'
echo "sidebar-drag: all passed"
