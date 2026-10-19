# Terminal input parity (x1)

Reference: `origin/main` at `e684e72`, read with `git show`, without checkout. This is an
implementation and handoff record, not a claim that all requested parity is complete.

## Required integration bridge

`ImagePasteMonitor.install` now accepts a live metrics provider. Its default retains the previous
macOS behavior. The existing caller in `AppDelegate.swift` is outside x1 ownership and still calls
`install()` without metrics. Approval was requested to change that line to:

```swift
ImagePasteMonitor.install(metrics: { [weak self] in self?.environment?.metrics })
```

Until that bridge is applied, the new web keyboard/mouse routing and appearance are dormant.
Do not cast `NSApp.delegate` to the adaptor type: SwiftUI owns the application-delegate wrapper.
The provider must read live metrics, rather than capture the initial interface or zoom value.

## Behavior audit

| Web behavior / source | Native implementation and limits |
| --- | --- |
| Copy selection and clear it; interrupt without selection (`XTermView/useXtermSession.ts`) | Added `copyOrInterrupt`, using Ghostty's copy/clear-selection and Ctrl+C key path. Existing double-interrupt handling remains in the session write callback. Web input bridge pending. |
| Smart paste, newline normalization, bracketed paste (`terminalInput.ts`, `terminalPaste.ts`, `useXtermSession.ts`) | Added one clipboard resolution for Cmd/Ctrl+V, preserving files > images > text priority, PNG saving and Ghostty mode-aware paste. CRLF/LF/CR normalize to CR. Web input bridge pending. Menu-bar Paste still uses Ghostty's original responder action and does not save image-only payloads. |
| File drop (`terminalInput.ts`, `useXtermSession.ts`) | Existing file/image drop, focus and accent outline retained. POSIX shell escaping intentionally differs from Windows double quoting: it protects dollar signs, command substitutions and shell metacharacters in local filenames. |
| Right-click copies a selection, otherwise pastes (`useXtermSession.ts`) | Added the same plain-right-click shortcut. Shift+right-click additionally exposes the requested Copy, Paste, Select all, Clear, Search and Open link actions with 14-point SF Symbols. The open-link target is captured before menu tracking. Web input bridge pending. |
| Double/triple click, shift extension, select all | Mouse events and selection remain in libghostty. Cmd+A routing added. No copy-on-select is registered in the web source. Pointer selection behavior still needs interactive validation. |
| Find, next/previous, count, highlights | Existing Cmd+F/Cmd+G/Shift+Cmd+G, Enter/Shift+Enter, Escape and Ghostty highlighting retained. Web query changes now clear old counts before starting the new search. The supplied web source loads SearchAddon but never calls it or draws a find bar; there are no CSS dimensions to copy. |
| Case/regex search | Not exposed by the current Ghostty wrapper/search binding. No nonfunctional toggles were added. Full-buffer case/regex search and highlights remain unresolved. This is a renderer integration gap, not an OS limitation. |
| Multiline confirmation | The web source normalizes and writes directly without confirmation. No new modal or sheet was introduced. Ghostty's responder Paste protection remains separate; direct smart paste uses its public text API. |
| Clickable URLs/paths (`terminalLinks.ts`, `.test.ts`) | Added web-only normalization for bare deployment domains (HTTPS), localhost (HTTP), mixed-case HTTP schemes and backslash-escaped spaces. Existing cwd/home/line suffix routing retained. Ghostty still owns detection: bare/relative paths not recognized by it do not become clickable merely through normalization. Windows drive/UNC paths have no local macOS target. |
| Link actions (`XTermView/index.tsx`, `.module.css`) | Existing Shift+Cmd-click link actions retained. Native NSMenu rendering differs from the web's 272-point themed popover; no modal/sheet presentation was changed. |
| Scrollback / alternate screen (`terminalInput.ts`) | Existing Ghostty scrolling retained. Exact memory-budget row limits, Shift+wheel host-scrollback override and a scroll-to-bottom affordance remain unresolved. No such button is rendered by the inspected web XTermView. |
| Font / zoom (`terminalFont.ts`, `XTermView.module.css`) | Added 14-point font, and top/right/bottom/left host padding 4/6/2/8 through metrics. Removed internal Ghostty padding only in the web configuration. Existing macOS font/padding retained. Web input bridge pending. Font chords remain app zoom, as the web custom key handler reserves them for global handling. |
| Option, Shift+Enter, Cmd+K, IME | Ordinary key events and marked text remain with Ghostty. No Option-as-Meta override or forced Shift+Enter byte sequence was added. Cmd+K remains the existing app Find/Jump action; the existing terminal clear shortcut is Option+Cmd+K. Those requested changes conflict with current global bindings or need further renderer work. |
| Prompt history (`terminalWrite.ts`, `XTermView/index.tsx`) | Existing per-tab 50-entry/4096-unit history retained; Ctrl+Up/Down routing added without duplicating recall into the history recorder. Existing Cmd+arrow prompt-mark navigation retained. Web input bridge pending. |
| Prompt delivery | Existing bracketed-paste and OpenCode type-and-confirm policy retained; this change does not alter initial-prompt timing or session persistence. |

The listed lifecycle/session helpers and their available tests were inspected as context; their
behavior is owned by the persistence task and no model/schema changes were made. There is no
`src/lib/sessionWatch.ts` in this web ref.

## Validation and handoff memory

- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `git diff --check`: passed at validation time.
- Added Swift tests for newline normalization, real `/bin/sh` canonical-PTY line delivery, bare
  deployment/localhost links, escaped file paths, web font/padding at zoom, unchanged macOS
  appearance, and stale find progress. Swift tests/builds/UI tests were not run per sandbox rules.
- The real PTY test exercises line discipline, not Ghostty's bracketed-paste framing; that still
  needs integration validation with the renderer outside the sandbox.
- No ai-memory skill or callable memory tool is available in this session. This section records
  decisions, remaining work and validation for handoff; it does not claim the external graph is updated.
- Leave changes unstaged. No commits, pushes, app restarts, web changelog or native plan edits.
