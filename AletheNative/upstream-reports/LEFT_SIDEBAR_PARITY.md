# Left sidebar remainder handoff

Source: `origin/main`, read using `git show` without checkout. Scope: `InterfaceStyle.web` only.

## Outcome and source values

- `NormalProjectSidebar.tsx` and `NormalProjectSidebar.module.css`: retain 4-point tab gaps,
  28×26 tab controls, 34-point section headers, 28-point project rows with 6-point top margins,
  28-point terminal rows, 10-point group indentation increments and section border tokens.
  Home, grid, folder and Git branch controls are present. Git opens the existing native Git
  control sheet, since there is no corresponding native sidebar panel.
- `NormalProjectNode.tsx` / `NormalProjectSidebar.module.css`: folder symbols use 20 points per
  the task's explicit override of the web's 16-point icon and 15-point lead slot. Terminal icon
  slots remain 15 points. Search is 52 points per the task's override of the CSS quick-nav sizing.
- `sidebarMenus.tsx`: archive and hide/unhide use archivebox, eye and eye.slash equivalents;
  background controls reveal hidden projects. A footer menu also exposes visibility and archive
  recovery, because native settings have no archive browser. Restoring an archive retains its
  previous group and hidden state. Archive closes its workspace presentation without deleting it.
- `UserProfile/index.tsx` / `UserProfile.module.css`: custom avatar or bundled DefaultProfile,
  circular 34-point image, 14×12 row padding, 13/11-point identity fonts; clean mode retains
  24-point images and 11/10-point fonts. Popover identity uses 36-point images (28 in clean mode).
- `SidebarUpdate.tsx` / `SidebarUpdate.module.css`: actual available native releases produce the
  13-point update icon, 7-point gap, 6×9 padding, 8-point radius and 11.5-point label. Unlike the
  web modal, clicking opens the verified GitHub release page. No automatic installation exists.
- `EmptyState/index.tsx` / `EmptyState.module.css`: retain compact inner spacing and controls;
  omit the surrounding card border/background as explicitly requested, including Explorer.
- New UI dimensions use metrics; colors use theme tokens. Existing accessibility identifiers and
  native interface branches remain. No shared Components.swift or workspace schema changes.

## Validation

- `python3 AletheNative/Scripts/check-strings.py`: passed after implementation.
- `git diff --check`: passed after implementation; rerun after documentation update.
- Reviewed native-path guards, profile scoping, archive recovery, and drag insertion/reordering
  with filtered rows. Catalog additions contain English and pt-BR translations without orphans.
- No build, app restart, UI harness, commit, staging or push. Reviewer must compile and validate
  actual rendering and interactions at multiple zoom levels outside the nested sandbox.

## Memory handoff and constraints

- No ai-memory skill or memory connector was available in this session. This versioned handoff
  records the implementation state, decisions and next checks for the reviewer.
- Local flags use `sidebar.web.hiddenProjects` and `sidebar.web.archivedProjects`, encoded as JSON
  sets of profile/project compound identifiers. Reveal state uses `sidebar.web.revealHiddenProjects`.
  Data is local UserDefaults state and is not included in project exports or profile backups.
- Custom images are stored as per-profile PNG data in `sidebar.web.avatarImages`; choose/reset
  controls live in the profile popover. The current model has no existing avatar preference.
- Release checks query the fork's releases once per sidebar lifetime. Only non-draft, stable
  releases with a DMG asset and a strictly newer three-component version qualify. Windows-only
  releases and incomparable `mac-native-v2-preview.1` tags cannot produce false update chips.
  Network failures leave the chip absent. A native preview update service remains outside scope.
- The task overrides the repo's commit/changelog workflow: changes remain unstaged and only the
  native changelog is updated. The main migration plan and web changelog are untouched.
