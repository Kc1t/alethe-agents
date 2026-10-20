# Sidebar sizes parity (sz)

Reference: `origin/main` at `e684e72`, inspected with `git show`, without checkout.
Scope: web interface, Clean and Normal. No builds, app restarts, staging, commits or pushes.
The later dimensions-only task takes precedence over the earlier image/model assignment:
existing image display is retained, and model/editor/image persistence work is excluded.

## Source and cascade

Paths below use these abbreviations:

- **C**: `src/components/ProjectSidebar/ProjectSidebar.module.css` (Clean).
- **N**: `src/components/ProjectSidebar/NormalProjectSidebar.module.css` (Normal).
- **A**: `AletheNative/Alethe/Sidebar/SidebarWebAppearance.swift`.
- **V**: `AletheNative/Alethe/Sidebar/SidebarView.swift`.
- **L**: `AletheNative/Alethe/Sidebar/LeftSidebar.swift`.
- **M**: `AletheNative/Alethe/Sidebar/SidebarWebMotion.swift`.
- **S**: `AletheNative/Packages/AletheKit/Sources/AletheDesign/Components+SidebarSizes.swift`.

C's final minimal-tree rules start at line 1111. Earlier project, group, terminal,
count and footer declarations are overridden property by property, rather than discarded.
The Normal overrides at C:1646 onward do **not** define the production Normal tree:
`index.tsx` selects `NormalProjectSidebar`, whose nodes import N. Consequently 34-point
project rows, 30-point uppercase groups and surfaced group cards from those C overrides
must not be applied to the NormalProjectSidebar implementation.
`src/styles/theme.css:185` defines radii 4/8/14; `src/styles/visual-clean.css:40`
overrides them to 3/4/6. Native Metrics already matches those tokens.
All numerical values below are unscaled CSS pixels / native points. At UI scale 0.9,
28 becomes 25.2, 24 becomes 21.6, 15 becomes 13.5, and 11 becomes 9.9.

## Comparison

Delta describes the pre-change discrepancy and the resulting state. “0” means source
geometry agrees; it does not assert a screenshot or AppKit runtime measurement.

| Element | Final web value and source | Native value and source | Delta / disposition |
| --- | --- | --- | --- |
| List padding | C:1202, N:137: top 4, sides 8, bottom 10; stable scrollbar gutter | A:19–20 and A:179: 4/8/10 | 0; AppKit gutter width requires runtime inspection |
| Project row | C:1336, N:157: 28 high; top margin 6; left/right padding 10/8; gap 9 | A:155–157,170; V:490 | 0 |
| Project trailing reservation | C:1481, N:325: 20 chevron plus 9 gap plus 8 right padding | A:156: 37 | 0; the 37 includes the overlaid chevron, not CSS right padding alone |
| Project font | C:1380: 12.5/400, including active; N:175,500: 12.5/400, active 500 | V:492: 12.5, Clean regular, Normal active medium | Clean active was 500, now 400 |
| Name flex and truncation | C:1380,1393; N:500: one line, flexible, ellipsis | V:494–495, A:134–135 | Removed extra Spacer after flexible project name (V:507), eliminating its minimum width and extra HStack gap |
| Project folder/cover | C:1363,1375: 15 square, token small cover radius; N:179,251: lead 15, folder/cover 16, small cover radius | V:553, A:128–132; SidebarCoverImage.swift:35–37 | Clean fallback 16 → 15; Normal lead 16 → 15 while retaining 16-point artwork |
| Project add symbol | ProjectNode.tsx:119: 12; NormalProjectNode.tsx:123: 15 | V:509–510: Clean 12, Normal 15 | Was explicitly bounded at 14 in both styles |
| Project menu symbol | ProjectNode.tsx:144: 13; NormalProjectNode.tsx:147: 14 | V:523–527 | Clean 14 → 13; Normal unchanged |
| Hover action bounds | C:1448, N:259: 20 × 20 | V:512; M:58: slot height 20 and hover width 20 | 0 for add/slot; AppKit menu intrinsic hit area needs runtime check |
| Project disclosure | ProjectNode.tsx:162: 13; NormalProjectNode.tsx:162: 15; C:1481/N:325: button 20 | A:80–86 | Clean glyph 15 → 13; button remains 20 |
| Project/terminal end slot | C:1602–1620, N:285–304: width 0 idle, 16 active, 20 hover/focus; height 20 | M:58: 0/16/20 × 20 on hover | Geometry 0; focus-within remains a known gap below |
| Working spinner | ProjectNode.tsx:124, TerminalNode.tsx:123: 13; Normal counterparts: 14 | V:518; SidebarWebTerminalStatus.swift:17; S:48 onward: 13/14 | Clean 14 → 13, drawn at target dimensions without transforms |
| Completion glyph | C:1564, N:545: mono 11/700, working color, opacity .55 | SidebarWebTerminalStatus.swift:23–25 | 0; CSS doneBadge 14 circle is unused by these terminal nodes |
| Group tag | C:1214, N:353: 24 high; margins top 22/bottom 2; padding left 10/right 6; gap 8; radius 6 | A:155–159,170–171; V:303 | 0 |
| First group margins | C:1240: first-child group 12; N:370: first root group and its descendant tags 12 | V:353; A:170 | Clean now checks sibling groups and does not inherit first-root spacing; Normal retains descendant selector behavior |
| Group type/rule | C:1214,1244; N:353,378: 11/400, tracking .04em (.44), rule 1 | V:313–314,326–329 | 0 |
| Group plus/disclosure | C:1250,1277; N:383,399: button 18, glyph 14 | V:332–334; A:80–86 | 0; group trailing reservation 32 = 6 + 18 + 8 |
| Group body | C:1300: margin-left 3 + transparent border 1 + padding-left 7; N:420: margin-left 3 + padding-left 7 | A:94,176,179,215,218: Clean increment 11, Normal 10; 1-point guide at margin-left 3 | Clean children previously 1 point too far left per nesting level; corrected |
| Guide color | C:1300/N:420: border at 55%; hovered group color mixed 45% with border | A:174–176: border at 55% | Base agrees; hover group-color mixing remains a known gap |
| Empty group | C:1318: 4 vertical/10 horizontal; N:434: 7/10; font 11 faint | A:205–209: Clean 4/10, Normal 7/10 | Clean vertical padding 7 → 4 |
| Terminal row | C:1512, N:510: 28 high, left 26/right 8, gap 9, font 12.5, md radius | A:155–159; V:608–610 | 0 |
| Agent stack | C:567,576, TerminalNode.tsx:87–105; N:557,566: 15-square slots, artwork 14, inter-icon gap 2 | V:668–671; A:126–132 | 0; icon slot minimum is explicitly 15 |
| Terminal menu symbol | TerminalNode.tsx:151, NormalTerminalNode.tsx:151: 13 | V:634 | Explicit image bound 14 → 13 |
| Tab count | C:1577/N:707: font 11 regular, line height 1, padding 4/7, radius 5, panelHover 60%, tertiary text | V:617–624 | Padding/radius/colors agree; SwiftUI font line box differs from CSS line-height 1 |
| Hover/selected rows | C:1346,1533/N:172,588: panelHover; focused terminal panelHover 82% + fg 12% | A:158–167 | Tokens/coefficients agree; SwiftUI layered opacity differs from CSS color-mix compositing |
| Collapsed/expanded | Collapse.module.css:1–16: 170ms height, 130ms opacity; chevron closed −90°/160ms | A:58–59,81–83,98–102 | Existing durations/rotation retained; List insertion is not CSS grid interpolation |
| Ungrouped section/drop | C:1323–1329: margin 0, min-height 22; N:484–492: top margin 2, min-height 24/font 10 | SidebarUngroupedDropArea in protected SidebarWebDragDrop.swift | Not edited by explicit ownership restriction; reviewer must compare these values |
| Normal Projects header | N:58,69,111: 34 high, horizontal 12, action gap 4; title 11/700/.08em; buttons 20 | V:191–237 | Geometry agrees; title uses shared section label |
| Clean header/shell | C:1153: toolbar min-height 34, gap 1, padding 4/6, buttons 24; C:1112: New agent 30, margin 4/8/0, padding 0/10, font 13/400 | L:80–126: tabs 28×26/gap 4, Search row 40; V:191: additional Projects header | Structural mismatch remains; see constraints below |
| Empty sidebar | C:178, N:147: centered wrapper padding 14; compact EmptyState 20/18 padding and gap 10 | SidebarWebControls.swift:73–115 | Geometry retained; surrounding card intentionally absent in existing port; exact centering and font line boxes need runtime check |
| Organization footer | C:1757: min-height 40, padding 4/10; switch gap 1/padding 0/no border or surface; button 24 square/radius 4 | L:206–227, S:1–44 | Clean padding 8/12/10 → 4/10/4; minimum 40; gap 2 → 1; buttons 24×22 → 24×24; removed switch chrome |
| Normal Organization footer | N:608,669,685: padding 8/12/10, gap 8, switch gap/padding 2, button 24×22 | L:195–227, S fallback to existing motion style | 0, preserved |
| Responsive footer label | N:679 and C:753: hide below window width 900 | L:196: ViewThatFits uses available sidebar width | Existing responsive mismatch; see below |
| Profile/playback footer | UserProfile CSS and SidebarNowPlaying outside project-list ownership | SidebarWebProfile.swift; SidebarNowPlaying | No changes; requires runtime visual comparison |

## Changes and review state

- Preserved native interface branches, accessibility identifiers and all protected drag/drop code.
- Changed only web geometry/type weights, style-specific symbol bounds and footer appearance.
- Added a separate design extension rather than editing Components.swift or existing shared styles.
- Spinner drawing uses the existing animation algorithm, normalized into a 13- or 14-point
  canvas. Both styles use metrics for dimensions and theme tokens for color.
- New visible strings: none. The existing English/pt-BR catalog is unchanged.

## Remaining deviations and runtime verification

This is a source-level dimensions pass, **not a claim of complete 1:1 parity**:

- Clean has a different upstream toolbar/action structure (including New agent). Existing native
  navigation/search/actions were retained to honor “do not change behavior”; replacing those
  controls needs coordinated behavior work. The table records their current size discrepancies.
- Hover affordances respond to pointer hover but not all upstream focus-within states. Hidden
  group plus buttons, menu intrinsic bounds, group guide hover color and focused-row compositing
  still require attention. No keyboard/focus behavior was changed in this dimensions pass.
- Ungrouped drop-zone dimensions live in the explicitly protected drag/drop file; the parallel
  reviewer owns the 22/24-point style distinction and Normal's 2-point top margin.
- Window-width 900px footer-label hiding currently uses available-space fitting instead. No
  window-width state or model changes were added.
- Native List supplies layout, scrollbars and disclosure insertion; compare scrollbar gutter,
  section spacing, clip behavior, long names and animation against web screenshots after build.
- SwiftUI and CSS font line boxes/color compositing can differ despite identical token sizes.
  SF Symbols intentionally substitute for Lucide artwork.
- Build and UI tests were not run: the task prohibits builds in this nested sandbox. Reviewer
  should build externally and inspect Clean/Normal at 1.0 and the owner's 0.9 UI scale, including
  nested first/non-first groups, empty groups, all status/menu states and narrow/wide windows.

Validation: `python3 AletheNative/Scripts/check-strings.py` passed; `git diff --check` passed.
No ai-memory skill or connector is available in this session. This report records decisions,
remaining gaps and next checks as the versioned memory handoff; no external memory write is claimed.
