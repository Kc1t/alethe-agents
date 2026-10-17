# Settings interface parity

The web-only Settings presentation reads the source from `origin/main`; it does not replace the
native macOS Settings path. Existing preference bindings and accessibility identifiers are retained.

Sources:
- `src/components/modals/PreferencesModal.tsx` and `PreferencesModal.module.css`: sidebar and
  header dimensions, navigation typography, section spacing, option rows and theme swatches.
- `src/components/modals/preferences/AppearancePage.tsx`: visual-style previews, selected theme
  treatment, app icons and zoom controls.
- `src/components/modals/preferences/TerminalPage.tsx`: agent identity and CLI path rows.
- `src/components/modals/preferences/IntegrationsPage.tsx`, `AccountPage.tsx`, `FeaturesPage.tsx`,
  `AboutPage.tsx` and `PluginsPage.module.css`: existing section grouping and compact typography.
- `src/components/modals/TopbarSettingsModal.tsx` and its stylesheet: toolbar options reference.

Implementation notes:
- `Components+Settings.swift` keeps native Forms and intrinsic sizing in macOS mode; web mode uses
  independently scrolling content and compact rows. Fixed dimensions pass through Metrics.
- The web shell uses the 184-point sidebar at the narrow breakpoint and 226 points otherwise.
- Theme and app-icon grids adapt to available space; CLI actions have a vertical fallback.
- The native data model has additional settings categories. These remain accessible rather than
  being dropped to match the web navigation inventory.

Known differences requiring follow-up:
- This is a presentation pass over existing native functionality, not complete feature parity.
  Web account-photo editing, terminal-theme overrides, opacity and configurable shortcut recording
  are not implemented by this change. Shortcuts currently lists the native terminal and zoom keys.
- About displays the installed bundle version. Web update download/install controls have no native
  updater implementation to bind to and are omitted.
- System checkbox and menu internals remain platform-rendered. Appearance language and interface
  selectors use the existing AletheSelect control.
- Full settings-content search, motion-choice previews and exact web category
  ordering remain different from the reference. Search currently filters navigation titles.
- Rendered parity at 800×500 and zoom 0.8–1.5 has not been verified. Build and UI validation must
  run outside the nested sandbox. This work should not be treated as verified pixel parity.

Validation: `python3 AletheNative/Scripts/check-strings.py` and `git diff --check` pass. No build,
app restart, commit, staging or push was performed. No ai-memory skill or service was available;
these notes preserve the outcome and remaining review work in the repository.

Reviewer compilation follow-up: `SettingsView.nativeBody` now explicitly returns its `TabView`.
The local `@Bindable` declaration makes this a multi-statement getter without an implicit return;
the explicit return resolves the reported opaque return type inference error without changing UI
behavior. The strings gate and whitespace validation pass. No build was attempted, as requested;
external compilation remains pending. No ai-memory skill or service is available in this session,
so this note records the fix and remaining validation. No commit was made because repository Git
metadata is read-only in this sandbox.
