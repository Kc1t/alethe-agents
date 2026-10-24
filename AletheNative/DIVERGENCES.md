# Mac divergences from the Windows/Linux app

The Windows/Linux app, [Kc1t/alethe-agents](https://github.com/Kc1t/alethe-agents), is the **baseline** this Mac
app follows (last reviewed commit: [`UPSTREAM_BASELINE`](UPSTREAM_BASELINE)). The goal is 1:1 parity, so every place
where the Mac app **has something the baseline does not**, or **behaves differently on purpose**, is listed here.
A difference that is not listed is a gap in our process: register it, or make the Mac app match the baseline.

This file does not track what is missing. Features not ported yet and "Won't port" decisions live in the parity
matrix (`docs/MAC_NATIVE_V2_PLAN.md` §8); unreviewed upstream changes are triaged through §9
(`Scripts/upstream-watch.py`).

## The rule

Add or update a row **in the same commit** that introduces, changes or removes a divergence:

1. Take the next free `MD-nnn` id and fill every column of the table below (`Since` is the date as `YYYY-MM-DD`;
   `pre-registry` marks what existed before this file did).
2. Tag the matching bullet in [`CHANGELOG.md`](CHANGELOG.md) `[Mac-only]` (the Mac gains something) or
   `[Mac-different]` (a baseline feature works differently) and cite the id, e.g. `[Mac-only] … (MD-004)`.
3. A persisted-shape addition (kind `Data`) must be optional, additive, ignored by the baseline's import and
   export, and covered by a round-trip test. Never change the meaning of a field the baseline already writes.
4. Never diverge silently from baseline behavior, even to improve it. If it is not obviously a Mac idiom, get the
   owner's OK first, then register it.
5. `Scripts/check-divergences.py` (run by `Scripts/test.sh`) checks the table, the paths it cites and the changelog
   cross references. It cannot know that a divergence exists, so reviewers must ask: *does this give the Mac
   something the baseline lacks, or make it behave differently?*

When the baseline later gains the feature, set the row to `Converged` and delete Mac code that became redundant.
When the Mac feature should reach Windows/Linux, set `Propose to web` and build it in the other repository, never
here.

## Vocabulary

**Kind**

| Kind | Meaning |
|---|---|
| `Mac-only` | A feature, setting, shortcut, menu, screen or capability the baseline does not have. |
| `Behavior` | The same feature works differently on purpose: another rule, default, order, confirmation, limit or wording. |
| `Data` | The persisted shape (`workspace.json`, preferences, files) has a field or meaning the baseline's `projects.json` lacks. |
| `Platform` | A user-visible difference forced by macOS or the native stack (system dictation, Keychain, shortcut remaps...). |

**Disposition** (the label, optionally followed by ` — a short reason`)

| Disposition | Meaning |
|---|---|
| `Keep` | Intentional and expected to stay Mac-specific. |
| `Propose to web` | A Mac improvement the baseline could adopt; to be built in the other repository. |
| `Revisit` | Probably should converge with the baseline; decide before the next release. |
| `Converged` | The baseline now behaves the same way; the Mac-specific code can go. |
| `Retired` | The divergence no longer exists. |

## Registry

| ID | Area | Kind | What differs | Baseline (web) | Mac | Data / compat | Code | Since | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| MD-001 | Interface | Mac-only | Two interface styles | One look: the web UI | `InterfaceStyle` offers `web` (default, 1:1 with the baseline) and `mac` (native chrome), chosen in Settings › Appearance | A preference only; the baseline never reads it | `Packages/AletheKit/Sources/AletheDesign/VisualStyle.swift`, `Alethe/Settings/AppearanceSettings.swift` | pre-registry | Keep — a Mac idiom the owner wants alongside the web look |
| MD-002 | Terminal | Platform | Selection highlight is softer | Per-theme `selectionBackground`, translucent (for example `#3b82f666`, about 40% alpha) drawn over the text | Ghostty only takes opaque colors, so the selection is blended over the background with its alpha capped at 0.3 | none | `Packages/AletheKit/Sources/AletheTerminal/TerminalAppearance.swift` | 2026-10-19 | Keep — Ghostty cannot draw a translucent selection |
| MD-003 | Sidebar | Behavior | Reorder from anywhere inside a group's area | A project goes before or after a project row; a group dragged over any row of another group nests at the end; groups reorder only on headers; nothing is a target below the last row | Insertion zones: a group dragged over a project row becomes a child of that row's group at that position; a group header has before / into / after zones; the margin between two groups means "before the next one"; below the last row means the end of the top level; a nested group's header also has a "before" zone for projects | Needs MD-004 to keep a sub-group between projects | `Packages/AletheKit/Sources/AletheModel/SidebarWebDropRules.swift`, `Alethe/Sidebar/SidebarPointerDrag.swift`, `Alethe/Sidebar/SidebarWebDragDrop.swift` | 2026-10-20 | Propose to web — reordering from anywhere in an area is a general usability gain |
| MD-004 | Sidebar | Data | A sub-group can sit between the projects of its parent | A group always shows its child groups first, then its projects | Optional `ProjectGroup.childOrder` (tokens `g:<id>` / `p:<id>`) keeps the mixed order; `WorkspaceDocument.place` and `sidebarChildren` maintain it | Optional and omitted when the order is the default; the baseline's import and export ignore it and fall back to groups-first; builds without it ignore the key | `Packages/AletheKit/Sources/AletheModel/SidebarChildOrder.swift`, `Packages/AletheKit/Sources/AletheModel/WorkspaceDocument.swift` | 2026-10-20 | Propose to web — needed to persist the mixed order of MD-003 |
| MD-005 | Sidebar | Behavior | Terminal rows count as their project when dropping | Only the project row is a drop target; the terminals under it are dead space | The terminal and pane rows under a project belong to it: dropping on them means "after that project", and the insertion line is drawn under the last one | none | `Alethe/Sidebar/SidebarWebDragDrop.swift`, `Packages/AletheKit/Sources/AletheModel/SidebarWebDropRules.swift` | 2026-10-20 | Propose to web — the dead space under a project hurts reordering |
| MD-006 | Data | Data | Native profiles are a separate data format and location, requiring import rather than direct interchange. | Versioned `projects.json` contains projects and preferences. | `workspace.json` plus `preferences.json` under Application Support/com.kc1t.alethe.mac/profiles; native schema and field names. | Import boundary: the baseline's `projects.json` is imported, never shared; no shared-file round trip is promised | `Packages/AletheKit/Sources/AletheModel/WorkspaceDocument.swift`, `Packages/AletheKit/Sources/AletheModel/PreferencesDocument.swift` | pre-registry | Keep — explicit import boundary; do not imply shared-file round trips. |
| MD-007 | Terminal | Platform | Search is always case-insensitive. | Search exposes a case toggle. | Ghostty matching has no case-sensitive option. | none | `Packages/AletheKit/Sources/AletheTerminal/TerminalSearch.swift` | pre-registry | Revisit — preserve the web search contract when renderer support permits. |
| MD-008 | Grid | Data | Active named grid belongs to the project rather than each saved tab view. | Workspace snapshots retain active-grid selection per plan. | `Project.activeGridID`; `WorkspaceSnapshot` contains no active-grid map. | Native only: `Project.activeGridID`; the saved tab views (`WorkspaceSnapshot`) hold no grid selection | `Packages/AletheKit/Sources/AletheModel/WorkspaceDocument.swift`, `Packages/AletheKit/Sources/AletheModel/WorkspaceNavigation.swift` | pre-registry | Revisit — switching workspace tabs can restore a different view than expected. |
| MD-009 | Resources | Mac-only | Users can hibernate idle terminals even without memory pressure. | Manual and smart-LRU pressure policies per plan. | Additional `idle` mode with separate hidden-agent and shell time limits. | none | `Packages/AletheKit/Sources/AletheModel/ResourcePolicy.swift` | pre-registry | Propose to web — useful opt-in resource policy. |
| MD-010 | Agents | Behavior | Empty model discovery does not offer stale fixed fallback IDs. | Hardcoded fallback models, including retired IDs in the plan baseline. | CLI listings plus Claude aliases; arbitrary model ID can be typed. | none | `Packages/AletheKit/Sources/AletheAgents/ModelDiscovery.swift` | pre-registry | Propose to web — avoid suggesting unusable model IDs. |
| MD-011 | Handoff | Data | Handoff capsules remain readable after completion. | Completion removes capsule directory (`src-tauri/src/handoff.rs`). | Capsules pruned after seven days. | Retention rule only (capsules pruned after seven days); no schema change | `Packages/AletheKit/Sources/AletheAgents/Handoff.swift` | pre-registry | Propose to web — destination agent may need to reread its capsule. |
| MD-012 | Dictation | Platform | Speech recognition and model management are supplied by macOS. | Parakeet/Whisper catalog and web provider settings. | SpeechAnalyzer/SpeechTranscriber assets, on-device languages, OS-managed model removal; native shortcut ⌥⌘E avoids Fn-Fn and Dock chords. | none | `Alethe/Dictation/DictationSettings.swift` | pre-registry | Keep — OS speech engine and asset lifecycle; document supported languages. |
| MD-013 | Browser | Platform | Shared Playwright browser opens outside the embedded pane. | Shared browser appears in a CDP pane. | Separate browser window unless shared-headless setting is enabled. | none | `Packages/AletheKit/Sources/AletheModel/PreferencesDocument.swift` | pre-registry | Keep — the embedded pane is a WKWebView, so the shared browser needs its own window |
| MD-014 | Onboarding | Behavior | Import appears immediately after the name step. | Baseline onboarding ordering differs; exact current sequence not checked. | Conditional Tauri import before appearance, agents, features and MCP. | none | `Packages/AletheKit/Sources/AletheModel/Onboarding.swift` | pre-registry | Keep — imported choices populate later steps. |
| MD-015 | Onboarding | Behavior | Welcome back is conditional on an update or prolonged absence. | `WelcomeModal`; plan says not the same every-launch behavior. | Shown after version change or at least seven days away; saves last launch/version. | none | `Packages/AletheKit/Sources/AletheModel/Onboarding.swift` | pre-registry | Propose to web — reduce repetitive interruptions. |
| MD-016 | Remote | Behavior | Remote transcript text is redacted before sharing. | Transcript snapshot does not redact text per plan; handoff redaction is separate. | `transcriptSnapshot` applies secret redaction to returned events. | none | `Packages/AletheKit/Sources/AletheAgents/Handoff.swift` | pre-registry | Propose to web — reduce accidental secret exposure on phones. |
| MD-017 | Remote | Behavior | Unsupported transcript agents return an empty snapshot. | Errors for unsupported agents per plan. | Empty session/messages response. | none | `Packages/AletheKit/Sources/AletheAgents/Handoff.swift` | pre-registry | Revisit — distinguish unsupported agents from empty conversations. |
| MD-018 | Remote | Behavior | WebSocket output subscriptions enforce per-terminal sharing. | Subscription path does not check sharing per plan. | Refuses unshared terminal IDs before reading scrollback or subscribing. | none | `Packages/AletheKit/Sources/AletheRemote/RemoteTransport.swift` | pre-registry | Propose to web — enforce the user's sharing boundary consistently. |
| MD-019 | Dictation | Data | Voice preferences are local and excluded from exported profile preferences. | Dictation options belong to web preferences. | `dictation.enabled`, hold, microphone and language in UserDefaults; native interface keeps its prior defaults. | Stored in UserDefaults, not in `preferences.json`; excluded from profile export and sync | `Alethe/Dictation/DictationSettings.swift` | pre-registry | Revisit — users may expect voice settings to follow profile backup/sync. |
| MD-020 | Voice | Behavior | Jev executes confirmed registry commands rather than free-form cloud plans. | Cloud planner infers project/agent actions and prompts. | Normalized exact localized command-title matching; ambiguous/unavailable commands blocked; rechecks before Run. | none | `Alethe/Dictation/JevController.swift` | pre-registry | Revisit — intentional local subset needs clearly bounded product wording. |
| MD-021 | Data | Data | Workspace snapshots identify projects rather than exact pane lists. | Web snapshot has pane-ID selections per report. | `openProjectIDs`, container weights and focused/isolated pane IDs; snapshot follows project content. | Native `WorkspaceSnapshot` shape (open project ids, container weights, focused and isolated pane ids); not interchangeable with the baseline's | `Packages/AletheKit/Sources/AletheModel/WorkspaceNavigation.swift` | pre-registry | Revisit — saved workspace views need equivalent restoration semantics. |

| MD-022 | Select controls | Platform | Raw HTML select options use the application's themed listbox in the web interface. | Plugin filters, marketplace sort, custom-agent accent/icon and worker shortcut rules use raw `<select>` elements whose opened options are rendered by the browser engine. | Keep the raw trigger's CSS values and existing choices, but open the same window-clamped, themed listbox as `Dropdown`; the macOS interface keeps its existing system controls. | Presentation only; no new fields or changes to saved values, option order or bindings. | `Alethe/Editors/WebDropdown.swift`, `Alethe/Editors/WebDropdown+Select.swift`, `Alethe/Editors/WebDropdown+Window.swift`, `Alethe/RightSidebar/PluginsWebPanel.swift`, `Alethe/Settings/CustomAgents.swift`, `Alethe/Settings/MultiagentWorkerSettings.swift` | 2026-10-21 | Keep — explicitly requested by the owner for consistent web-interface choices on macOS. |
| MD-023 | Memory panel | Mac-only | The RAM pill counts the AI terminals that are running, and the memory panel has an AI terminals tab with each session's processes, listening ports and kill buttons. | The title-bar pill shows only the memory total and the modal has no per-session process list or kill control. | Pill reads "N, a bar, X MB" (just the memory with no agent running). The new tab lists every running agent with its footprint, the processes it started with their footprint and TCP ports in the LISTEN state, and buttons to kill a session (same tree kill as a double ⌃C, the tab shows the restart overlay) or one child, each after a confirmation. | Presentation and process control only; nothing is saved. Reads libproc and `KERN_PROCARGS2` for the user's own processes. | `Alethe/Terminals/AIProcessList.swift`, `Alethe/Terminals/ResourceMonitor.swift`, `Alethe/Shell/WebTitleBarMemory.swift`, `Alethe/Terminals/MemoryIndicator.swift`, `Packages/AletheKit/Sources/AletheTerminal/ProcessInspector.swift` | 2026-10-22 | Keep — requested by the owner to see and stop what the agents keep running. |

## Backlog: candidates not yet confirmed in code

[`upstream-reports/DIVERGENCES_SEED.md`](upstream-reports/DIVERGENCES_SEED.md) lists 56 candidate divergences found by
reading the plan and the parity reports. The 16 confirmed in the Swift sources (and the interface style, which is
MD-001) are registered above as MD-006…MD-021. The other 39 come **only from the plan's notes**, several written
against older baselines, so they are a queue to verify, not facts: confirm the Mac behavior in the code and the
baseline behavior in its source, then promote the row here with the next free id (and fill the Code column). The same
file ends with the notes that were left out on purpose, and the items that need an owner decision.
