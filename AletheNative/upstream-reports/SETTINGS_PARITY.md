# Settings interface parity

The web Settings path is selected only by `metrics.isWebInterface`. The macOS TabView and native
Forms remain independent. This is an implementation pass, not verified pixel parity.

## Web reference and destinations

References were read with `git show origin/main:<path>` without checking out or changing that ref.
All page paths below are relative to `src/components/modals/preferences/`.

| Order | Destination | Web source | Native presentation |
| --- | --- | --- | --- |
| 1 | Account | `AccountPage.tsx` | Profile name, photo, language, local-account management |
| 2 | Organization | `OrganizationPage.tsx` | Empty archived groups and live locally archived project restoration |
| 3 | Appearance | `AppearancePage.tsx` | Separate style/motion sections, themes, icons, zoom, toolbar options |
| 4 | Remote Control | `RemoteControlPage.tsx`, `RemoteControlPage.module.css` | Tutorial and existing live service, reach, pairing, security and devices |
| 5 | Features | `FeaturesPage.tsx`, `../onboarding/FeaturesStep.tsx` | Existing feature toggles/options, expanded secondary features |
| 6 | Plugins | `PluginsPage.tsx`, `PluginsPage.module.css` | Live installed plugins, unavailable marketplace and manifest installation |
| 7 | Terminal | `TerminalPage.tsx` | Resource policy, agent/CLI controls, limit notifications, permissions and start-clean setting |
| 8 | Integrations | `IntegrationsPage.tsx` | Usage sheet, CLI shim, Router9, Spotify, Discord, unavailable dictation |
| 9 | Orchestration | `OrchestrationPage.tsx`, `OrchestrationPage.module.css`, `RoutingSection.tsx` | Skill, limits, roles and routing sections; unavailable settings remain inactive |
| 10 | Multiagent | `MultiagentPage.tsx` | Live scheduler, telemetry and audit; unavailable shortcuts/rules |
| 11 | About | `AboutPage.tsx` | Installed bundle version and existing native release check/download link |

`src/components/modals/PreferencesModal.tsx` and `PreferencesModal.module.css` supply the exact
navigation order, localized labels/descriptions, 226/184-point sidebar, 16-point navigation symbols,
48-point navigation rows, 80-point header, and content/section typography. Account is the default
for the general entry point. Existing deep links map to the corresponding web destination.

## Shared presentation

- `WebSettingsView.swift` owns web navigation; native-only toolbar/resource pages no longer add
  categories to the web list. Toolbar configuration remains reachable from Appearance.
- `WebSettingsSections.swift` uses 34-point content insets (24 below the narrow breakpoint),
  28-point top inset, section dividers, 16-point headings and 11-point descriptions. Section fold
  choices persist per profile in UserDefaults, separate from document schemas. Multiagent metrics,
  traces and audit start folded, following `settingsSections.ts` and `MultiagentPage.tsx`.
- `WebScrollStyle.swift` exposes `.webScrollStyle()` and `WebScrollConfigurator.configure` for
  other app screens. It configures descendant AppKit scrollers, including nested TextEditors, for
  overlay/autohiding operation with a transparent track. `src/styles/reset.css` specifies a 10px
  scrollbar with a 2px transparent border: the visible thumb is 6 points, with muted theme ink at
  18%, 35% on hover, and 55% while pressed. AppKit still controls track geometry and fade timing.
- Existing package `Components.swift` and `Components+Settings.swift` were not edited. Native Forms
  continue through the original shared form implementation. All new strings have English and
  Brazilian Portuguese catalog entries copied from the web where applicable.

## Remaining differences and reviewer work

- This does not finish the requested 1:1 reconstruction of every page. Several existing native
  rows still have different grouping, controls and spacing, including the combined agent/CLI rows,
  resource-policy controls, motion toggle, integrations, feature controls and remote service cards.
  System checkboxes and menus retain platform rendering. Generic rows use the web option-card shell;
  some web sections instead have unboxed controls, so those sections still need individual layouts.
- Missing native document fields/services are intentionally not invented: terminal theme overrides,
  window opacity, view placement, spawn concurrency, default shell/font, custom agents, marketplace
  installation, dictation, orchestration roles/limits/routing, shortcut editing and worker rule sets
  have disabled controls or unavailable states. Those states are native explanations, not web
  screenshots. The native schema was not changed.
- Account name editing renames an existing non-default local profile on submit/leave. The default
  profile name remains disabled because it cannot be renamed through the current native API. Photo
  editing uses the existing local sidebar avatar storage; it does not create web preference fields.
  Language changes require the existing native relaunch action. The web also offers Chinese, while
  this app offers only its supported native locales.
- Organization reads existing profile-scoped local project archive flags. There is no native group
  archive state, so its group list is empty. About uses the native fork release checker and a download
  link rather than a web updater with installation progress.
- Search filters category titles; full setting-level search and jump-to-section behavior remain
  outstanding. Clean-style selection tokens and exact responsive grids need rendered review.
- Group/project covers were already implemented on this branch. This pass improves file-drop errors
  and provider selection, and adds SVG byte-preservation/removal coverage. No image schema migration
  or compression was added: web ImageInput stores original bytes with a 2 MB limit in `iconUrl`.

Validation: `python3 AletheNative/Scripts/check-strings.py`, Swift frontend syntax parsing of changed
Swift sources/tests, and `git diff --check` pass. Syntax parsing does not typecheck. No build, unit
test execution, UI harness, app restart, staging, commit or push was performed. The reviewer must
compile and run image tests plus Settings UI checks outside the nested sandbox, including macOS
26.6, interface switching, scrollbar behavior, 800×500 sizing and zoom 0.8–1.5.

No ai-memory skill or service is available in this session. This report records the decisions,
current state, limitations and next steps as the available repository handoff.
