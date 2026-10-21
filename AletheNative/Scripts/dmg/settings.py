# dmgbuild settings for the Alethe installer window. Driven by Scripts/make-dmg.sh, which passes
# -D app=<path to Alethe.app>.
#
# The window background is a solid color, not a picture: Finder on macOS 26 does not draw picture backgrounds
# (a PNG, a multi-resolution TIFF and an AppleScript-set picture all left the window at the default dark gray,
# while a color renders), so any artwork would be invisible. A light color keeps the black icon labels readable.
import os.path

app = defines["app"]  # noqa: F821 (injected by dmgbuild)

format = "ULFO"
filesystem = "APFS"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents/Resources/AppIcon.icns")
background = "#f5f5f7"

# Frame size: a 640x400 content area plus the 28pt title bar.
window_rect = ((200, 160), (640, 428))
default_view = "icon-view"
show_toolbar = False
show_sidebar = False
show_status_bar = False
show_tab_view = False
show_pathbar = False
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
icon_size = 128
text_size = 13
icon_locations = {
    os.path.basename(app): (180, 190),
    "Applications": (460, 190),
}
