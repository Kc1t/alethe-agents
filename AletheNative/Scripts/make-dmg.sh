#!/usr/bin/env bash
# Builds the Release app and packages it in the branded installer DMG.
# Usage: Scripts/make-dmg.sh [--skip-build]
# Output: build/Alethe-macOS-universal.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

[ "${1:-}" = "--skip-build" ] || Scripts/build.sh Release

VENV=build/dmg-venv
if [ ! -x "$VENV/bin/dmgbuild" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q dmgbuild pillow
fi

APP="build/DerivedData/Build/Products/Release/Alethe.app"
OUT="build/Alethe-macOS-universal.dmg"
rm -f "$OUT"
"$VENV/bin/dmgbuild" -s Scripts/dmg/settings.py -D app="$APP" "Alethe" "$OUT" >/dev/null
echo "Built: $(pwd)/$OUT"
shasum -a 256 "$OUT"
