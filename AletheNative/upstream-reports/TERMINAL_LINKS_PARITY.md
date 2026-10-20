# Terminal links and project image review (tl)

## Implemented

- Reference: `origin/main:src/components/XTermView/terminalLinks.ts`. The link-start,
  bare-domain and extension-boundary regexes are copied verbatim. Native detection retains UTF-16
  ranges, punctuation trimming, escaped spaces, file classification, home/cwd resolution and
  logical-line joining. `DetectedTerminalLinkTests` ports the web test scenarios into Swift Testing.
- Reference: `origin/main:src/components/XTermView/index.tsx` and `XTermView.module.css`.
  Ordinary clicks open actions through `WebMenuHost`; the existing macOS direct-open/modifier
  routing remains behind its original interface path. The terminal menu has a 272-point width,
  39-point header, 27-point close button, 34-point normal rows, 15-point symbols, 12-point text,
  9-point icon gaps, 5-point content padding and 2-point row spacing. Metrics scale these values.
  The panel uses the web modal/border/hover theme tokens and is bounded to the window.
- The shared menu host accepts custom chrome without changing existing menu presentations.
  Outside-click dismissal, Escape, arrow/Return navigation and menu hover run through that host.
  Terminal pointer handling stops while any web menu is presented.
- Actions match the reference's file-kind branches: grid, URL/video viewer, Markdown fullscreen
  preview and right-sidebar docs, external app/browser, Finder and copying the resolved target.
  URL grid opening is disabled when the browser feature is disabled.
- Reference: `origin/main:src-tauri/src/filesystem.rs`, `find_relative_path_inner`: resolve in cwd
  first, otherwise select the newest file across linked and managed worktrees. A first path
  component matching a worktree's directory name is also supported. Late lookups update only the
  same still-open presentation, and cannot reopen a dismissed menu.
- Ghostty's published `Config.zig` marks custom `link` configuration unavailable:
  <https://github.com/ghostty-org/ghostty/blob/main/src/config/Config.zig>.
  The host therefore uses visible-screen detection. Web configuration disables `link-url` and
  `link-osc8` to prevent Ghostty's competing pointer behavior and colors; both config keys were
  confirmed in the vendored binary. macOS configuration retains the renderer defaults.

## Existing project/group images

The requested image functionality already exists in this worktree; it was not rewritten:
`ImageInputField`, `ProjectImageInput`, project/group editor bindings, `SidebarCoverImage`,
Home recent-project images, the `iconUrl` model fields and `ProjectImageTests`.

Compared against `origin/main:src/components/modals/ImageInput.tsx`, its shared
`controls.module.css`, `NormalProjectNode.tsx`, `NormalGroupNode.tsx`, `GroupNode.tsx`,
`NormalProjectSidebar.module.css`, `src/lib/types.ts` and `src/stores/projectsStore.ts`:

- Web field name is `iconUrl` on both projects and groups.
- Web accepts image MIME types, permits at most 2 MiB, and stores original bytes as a data URL.
  It does not resize or compress uploads. The existing native helper follows those rules.
- The existing image field uses the web's 44-point preview, 10-point radius, 18-point initial,
  6-point control gap and 14-point upload/remove symbols. Normal project thumbnails use the
  web's 16-point cover frame and small radius, with folder fallback.
- Native file drops and clipboard import extend the web's file chooser/URL input.
- No separate Change image context-menu action exists in these reference row components.
  Existing editors expose the image field for both create and edit.

## Validation and remaining review

- Passed `python3 AletheNative/Scripts/check-strings.py` and `git diff --check`.
- A static comparison verified all three copied detector regexes equal the `origin/main` source.
- Added detector, resolution, logical-range, newest/named-worktree and interface-config tests.
  No Swift build, unit-test binary or UI harness was run, per the sandbox restriction. The reviewer
  must build and run `DetectedTerminalLinkTests`, `TerminalAppearanceTests` and existing
  `ProjectImageTests`, then check pointer/menu behavior in both interface styles at several zooms.
- The wrapper exposes visible row text and exact renderer cell sizes, but not soft-wrap flags or
  per-cell Unicode widths. The integration infers wrapping from full-width rows and approximates
  wide-character widths. A hard newline exactly at the right edge can be mistaken for a wrap;
  unusual graphemes can offset a hit. The pure logical-line algorithm accepts explicit wrap flags,
  ready for a future wrapper API. This prevents claiming complete 1:1 rendering parity today.
- Detection follows printed text. OSC 8 labels whose targets are hidden behind non-path/non-URL
  text are not actionable in the web profile. The macOS profile retains OSC 8 handling.
- Fullscreen preview uses the existing native preview presenter. Pixel-level preview parity and
  Clean-style menu animation still require visual review; the shared host's existing animation is
  retained.
- No ai-memory skill or writable memory connector was available in this session. This report
  records the implementation decisions, limits and reviewer next steps in the existing report folder.
- Changes are unstaged. No commit, push, server restart or app restart was performed.
