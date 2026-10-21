#!/usr/bin/env bash
# Copies the installed (production) app's data to the Debug build's own folder, so the Debug app opens with your
# real projects. Debug runs as com.kc1t.alethe.mac.debug and never touches the production folder; this copy is
# one way and only happens when the Debug folder does not exist yet (or with --force, which replaces it).
# Quit both apps first. Keychain secrets are not copied: re-enter them in the Debug app if you need them.
set -euo pipefail
BASE="$HOME/Library/Application Support"
SRC="$BASE/com.kc1t.alethe.mac"
DST="$BASE/com.kc1t.alethe.mac.debug"
[ -d "$SRC" ] || { echo "no production data at $SRC"; exit 1; }
pgrep -x Alethe >/dev/null && { echo "quit Alethe (both builds) first"; exit 1; }
if [ -d "$DST" ]; then
  [ "${1:-}" = "--force" ] || { echo "$DST already exists (use --force to replace it)"; exit 1; }
  rm -rf "$DST"
fi
cp -R "$SRC" "$DST"
rm -rf "$DST/logs"
echo "copied $SRC -> $DST"
