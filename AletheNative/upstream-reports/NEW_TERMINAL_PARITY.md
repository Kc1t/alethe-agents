# New Terminal modal parity handoff

Source: `origin/main`, read with `git show`; no checkout, build, commit or push.

## Implemented

- `src/components/modals/NewTerminalModal.tsx` and `NewTerminalModal.module.css`: web-only
  500-point modal, 20-point corners, header padding 20/22/2, 17-point semibold title,
  body padding 14/20/18, field gap 14 and label gap 7, footer padding 14/22/18 and gap 10.
- `Modal.module.css`: window-local dimmed and blurred overlay, strong border, close action,
  250 ms entrance and 150 ms exit. Timing curves live in an extension of Motion, and Reduce
  Motion suppresses movement. Translation and opacity replace the CSS scale transform.
- `RowSelect.tsx` and `RowSelect.module.css`: 44-point triggers, 12-point corners, 20-point
  icon slots, bounded 17-point AgentLogo artwork, 13.5-point text, 11-point gaps, themed
  hover/selection/focus, lifted scrolling option menus, arrow/Enter/Escape/Tab handling.
- `agentPicker.module.css` was read completely. Current NewTerminalModal uses RowSelect,
  not that older list or an agent grid. It supplies no agent descriptions, install badges or
  header subtitle, so these were not invented.
- Existing launch/worktree/model/router/project/grid/prompt bindings and accessibility IDs
  remain. Native-only options are retained under Advanced. Create more retains the form;
  Command-Return submits. The mac interface retains the original form and system sheet.
- Shared AletheButtonStyle and AletheWorkspaceActionStyle are reused without modifying
  Components.swift. All new localized strings have English and Brazilian Portuguese entries.

## Validation and remaining differences

- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `swiftc -frontend -parse` for the three changed Swift files: passed (syntax only).
- `git diff --check`: passed. Builds and UI tests were not run, as instructed.
- Reviewer must compile and compare at zoom 0.8–1.5, narrow windows, light/dark themes and
  Reduce Motion. Syntax parsing does not validate SwiftUI generic types or concurrency.
- Backdrop and shadow use existing theme tokens rather than the CSS's literal RGBA colors.
  The CSS scale animation is omitted to honor the metrics-based layout requirement.
- Advanced retains native pickers, model discovery, worktree controls and router toggles.
  The web runtime-profile pills have no corresponding native launch-model binding; no inert
  control or model/schema change was introduced. Exact Advanced parity remains incomplete.
- Folder choices use real project folders and the current path; the web's recent-tab ordering
  and WSL picker are not reproduced. The Advanced path field supports direct editing.
- Clean-style-specific CSS overrides are not reproduced in this task's custom modal surfaces.
- No ai-memory skill, connector or CLI is available in this session. This handoff records
  decisions, validation limits and reviewer next steps; it does not claim an ai-memory write.
