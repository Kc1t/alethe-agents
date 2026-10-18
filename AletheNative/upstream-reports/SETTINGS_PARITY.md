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


## Plugin marketplace follow-up (k1, 2026-10-18)

Sources read directly from `origin/main`: `PluginMarketplaceModal.tsx` and its CSS,
`preferences/PluginCatalog.tsx`, `preferences/PluginsPage.tsx` and its CSS,
`PluginsSidebar/index.tsx`, `useCatalog.ts`, `PluginMarketFilters.tsx`, `PluginDetailsModal.tsx`,
`PluginsSidebar.module.css`, `lib/pluginBrowse.ts`, `lib/pluginMarket.ts`,
`lib/tauri/plugins.ts`, `src-tauri/src/plugin_catalog.rs`, and `plugins.json`.

The web interface now has a working marketplace and Settings catalog, installed/browse scopes,
accent-insensitive search, capability intersection filters, source/state filters, name/update
sorting, inline details, refresh/retry, and a six-hour profile-local cache with a stale fallback.
The sidebar merges installed manifests and catalog entries, offers state/source/sort controls,
and opens the selected plugin detail. Installed remains usable when the catalog cannot load.
Marketplace geometry copies the 1180×760 maximum (screen minus 48 points), 196-point rail,
68-point rows, 16×18 header padding, 32-point search, 19-point detail title and 18×22 detail
padding. Sidebar retains its 44-point header, 26-point search and 10×12 cards.

`PluginWebRegistry` stores original manifest JSON in the profile's `plugins/<id>/manifest.json`.
Unknown fields, including `spec`, survive verbatim. Folder, JSON-file, pasted-manifest and ZIP
imports only register manifest data. ZIP imports stream one unambiguous manifest through the
system unzip tool without extracting archive paths or assets. Catalog packages require HTTPS,
the pinned SHA-256, and matching manifest ID/version. Built-in IDs cannot be overwritten or
uninstalled. Rescan and uninstall operate on this metadata registry, separate from `plugins.json`
and native document schemas. No downloaded code is evaluated and no host capability is granted.

Deliberate differences and outstanding visual review:

- Web JavaScript plugins cannot execute in the compiled native host. They show “Not available on
  macOS”; the package action explicitly registers metadata. Update/reinstall changes that metadata.
  Built-ins still use PluginHost enablement; ExtensionKit consent and execution remain untouched.
- Marketplace uses a SwiftUI sheet, system picker menus, and a system uninstall confirmation.
  The web uses a blurred window overlay, HTML selects and its own modal. Rendered comparison,
  including small windows and zoom, remains necessary; this is not a claim of completed pixel parity.
- Settings catalog offers search/installed scope and opens the full marketplace for capability,
  source/state and sorting filters rather than duplicating every control inline. Sidebar relevance
  scoring follows name/ID weighting, but punctuation normalization still follows native search.
- Native UI mode retains its existing Form and ExtensionKit section. No shared Components.swift,
  web changelog, native plan, app lifecycle, or model schema was changed.

Validation: strings gate, Swift frontend syntax parsing of all changed Swift files, and
`git diff --check` pass. Unit tests added for unknown-field retention/round trip, invalid IDs and
API versions, built-in protection, folder/ZIP import without executable extraction, uninstall,
and fresh-cache reads. Tests were not executed, and syntax parsing does not typecheck. The reviewer
must build/test outside the nested sandbox and exercise catalog failures, stale cache, pinned
packages, import failures, native enablement, mode switching, window sizing and zoom on macOS 26.6.
All changes are left unstaged; no build, commit, push, or app/server restart was performed.

No ai-memory skill or service is available in this session. This existing report records the
implementation decisions, limitations and next steps as the repository handoff.
