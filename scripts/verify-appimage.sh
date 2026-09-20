#!/usr/bin/env bash
# Guard against the AppImage shipping its own Wayland libraries.
#
# Host Mesa can never be bundled (it is driver specific), so a bundled
# libwayland-client older than the host's makes Mesa fail on a missing symbol
# and the window comes up blank (issue #184). The whole libwayland-* family is
# rejected rather than a fixed list of sonames, so this check stays independent
# of whatever the release workflow asks linuxdeploy to exclude — a typo there
# cannot make this pass.
#
# Usage: ./scripts/verify-appimage.sh [path/to/App.AppImage]
# Without an argument it looks for a single .AppImage in the default bundle dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle/appimage"

APPIMAGE="${1:-}"

if [[ -z "$APPIMAGE" ]]; then
  mapfile -t found < <(find "$BUNDLE_DIR" -maxdepth 1 -type f -name '*.AppImage' 2>/dev/null | LC_ALL=C sort)
  if (( ${#found[@]} == 0 )); then
    echo "verify-appimage: no AppImage found in $BUNDLE_DIR (run the build first, or pass a path as argument)" >&2
    exit 1
  fi
  if (( ${#found[@]} > 1 )); then
    echo "verify-appimage: ${#found[@]} AppImages found in $BUNDLE_DIR — pass explicitly which one to verify:" >&2
    printf '  %s\n' "${found[@]}" >&2
    exit 1
  fi
  APPIMAGE="${found[0]}"
fi

if [[ ! -f "$APPIMAGE" ]]; then
  echo "verify-appimage: file not found: $APPIMAGE" >&2
  exit 1
fi

APPIMAGE="$(realpath "$APPIMAGE")"

# Release artifacts come down without the exec bit and --appimage-extract needs
# it. Guarded because chmod on a file we do not own fails even when that file is
# already executable.
if [[ ! -x "$APPIMAGE" ]]; then
  chmod +x "$APPIMAGE"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "verify-appimage: extracting $APPIMAGE..."
# --appimage-extract works without FUSE/libfuse2, but always writes squashfs-root
# into the current directory, hence the cd into the temp dir.
cd "$WORK"
"$APPIMAGE" --appimage-extract >/dev/null

if [[ ! -d squashfs-root ]]; then
  echo "verify-appimage: extraction failed — $WORK/squashfs-root does not exist" >&2
  exit 1
fi

# Whole AppDir, not just usr/lib: a library under usr/lib64 or at the root breaks it just as well.
mapfile -t offenders < <(cd squashfs-root && find . -name 'libwayland-*' | sed 's|^\./||' | LC_ALL=C sort)

if (( ${#offenders[@]} > 0 )); then
  echo "verify-appimage: FAILED — Wayland libraries inside the bundle:" >&2
  printf '  %s\n' "${offenders[@]}" >&2
  echo "verify-appimage: host Mesa, which is never bundled, loads this stale libwayland, misses wl_display_create_queue_with_name and fails EGL with EGL_BAD_PARAMETER, leaving a blank window." >&2
  exit 1
fi

echo "verify-appimage: OK — no Wayland library bundled."
# Printed so a run can be diffed against an earlier one to see what else stopped being bundled.
echo "verify-appimage: contents of squashfs-root/usr/lib:"
LC_ALL=C ls -1A squashfs-root/usr/lib 2>/dev/null | sed 's/^/  /' || echo "  (no usr/lib)"
