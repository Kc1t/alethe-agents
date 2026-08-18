#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Deliberately avoid the `linuxdeploy-plugin-*` prefix: linuxdeploy scans the
# cache for that pattern and would otherwise register this helper instead of
# the repository-owned wrapper.
upstream_plugin="$script_dir/alethe-gtk-upstream.sh"
appdir=''

if (($# == 1)) && [[ "$1" == '--plugin-api-version' ]]; then
  exec "$upstream_plugin" "$@"
fi

args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --appdir)
      if ((i + 1 < ${#args[@]})); then
        appdir=${args[$((i + 1))]}
      fi
      ;;
    --appdir=*)
      appdir=${args[$i]#--appdir=}
      ;;
  esac
done

if [[ -z "$appdir" ]]; then
  printf 'Alethe AppImage wrapper: missing --appdir argument\n' >&2
  exit 2
fi

"$upstream_plugin" "$@"

# Keep the Wayland client aligned with the host Mesa/EGL stack. The GTK plugin
# runs before the AppImage output plugin, so removing it here keeps it out of
# the final artifact while retaining the remaining GTK/WebKit dependencies.
rm -f -- "$appdir"/usr/lib/libwayland-client.so*
if compgen -G "$appdir/usr/lib/libwayland-client.so*" >/dev/null; then
  printf 'Alethe AppImage wrapper: failed to remove bundled Wayland client\n' >&2
  exit 1
fi
