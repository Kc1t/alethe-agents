# Git modals (m1) parity handoff

Source: `origin/main`, read with `git show`; no checkout, build, commit or push.

## Implemented within m1 ownership

- `GitModalsWebPresentation.swift` ports `Modal.tsx` / `Modal.module.css`: 15-point semibold
  title, 26-point close target, header padding 16/20/0, body padding 14/20/18, footer padding
  12/20/16 and 8-point gaps. It reuses `NewTerminalWebOverlay` and its Motion entrance/exit,
  window margins, resizing and draggable-header environment. Nested presentations use a
  preference layer so their bounds can come from the entire window rather than a sidebar.
- Merge Center uses `MergeCenterModal.tsx`, `MergeCenterModal.module.css` and
  `SidebarMergePanel.module.css`: 480-point preferred width, bounded 16-point AgentLogo, status
  tag, three-column primary actions, six-point action gaps and semantic action colors.
  Existing source/target, analysis, conflict resolution, validation, abort and cleanup logic remains.
- Branch Testing uses `BranchTestingModal.tsx` (its styles are inline) and shared modal CSS:
  560-point preferred width, 16-point section gaps, project/branch banner with 10/14 padding,
  12-point text and themed command/health inputs. Existing automated test results remain real.
- Pending Worktree Commit uses `ConfirmWorktreeCommitModal.tsx` and its module CSS: 520-point
  preferred width, real pending status from the selected worktree, bounded scrolling file list,
  20-point status column, 11-point monospace rows, description and focused message editor.
- PR review/merge use `PullRequestReview/PullRequestReviewModal.tsx` and its module CSS for
  680-point preferred width, 16-point padded cards, nine-point card corners, 16-point titles
  and 12-point metadata. Agent/model preferences, review terminal creation, recorded head SHA
  and guarded squash merge preserve the native behavior. The existing macOS PR sheets remain
  in their original source file and are selected only in the mac interface.
- Git Control uses `plugins/git-control/GitControl.tsx` / `GitControl.module.css`: compact
  48-point repository header, 30-point branch row, command editor before change groups,
  32-point group headers and 26-point file rows. Staging, unstaging, discard confirmation,
  commit/amend, branch actions, incoming/outgoing commits and history remain connected.
- Worktree cards use the real worktree rows and `SidebarMergePanel.module.css` card metrics.
  Selection, lock/unlock, fetch, commit, removal and cleanup retain their original handlers.
- Git graph create-branch/hard-reset prompts use themed modal chrome. The web `GitGraph.tsx`
  uses browser-native `window.prompt` and `window.confirm`, so no custom web modal CSS exists
  for these two prompts. Existing native alerts/dialogs remain in the mac path.
- Existing Git accessibility identifier literals are retained. New localized keys have English
  and Brazilian Portuguese values. Shared action styling lives in `Components+GitModalsM1.swift`;
  `Components.swift`, the web changelog and the native migration plan are untouched.

## Integration required outside m1 ownership

`MainWindow.swift` still routes these top-level requests through its system sheet. Install
`.gitWebModalLayer()` on the window content and route Merge Center, Worktrees, Branch Testing
and the Git Control plugin through `GitWebOverlay` in the web interface. A reviewable proposed
patch is at `/tmp/alethe-m1-host-routing.patch`; it has **not** been applied. No change to
`RightSidebar.swift` is needed by this proposal. Until integration, the new web content uses
system-sheet fallback presentation; full-window backdrop, header dragging, resizing and Motion
presentation are not active for these top-level dialogs or PR review. This is not full 1:1 parity.

## Remaining differences

- Native Merge Center is a staged repository operation, not the web's cross-project pending-card
  collection. Its source/target controls and stage actions remain; no artificial pager, review
  feedback handler or pending-card collection was added. The web's exact six-action card is not
  reproduced. This needs an agreed mapping to existing pending-worktree state.
- Native Branch Testing runs validation commands and records results. The web briefing has
  changed-file summaries and a human pass/fail feedback checklist with Start App / Send Feedback
  actions. Those data/handlers are absent from this sheet and have not been fabricated. Native
  command/health fields and Run validation are retained instead.
- Worktrees has no standalone web modal counterpart; the original source describes the web
  worktree panel. Native management controls remain inside the new modal chrome.
- Native pending commit commits the selected worktree without integrating it. The footer retains
  the native Commit action rather than falsely labeling it Commit and integrate. The message
  defaults to the existing native value; no GSD goal prefill was invented.
- Native PR summaries omit branch names, body and mergeability. Cards show available author/repo
  metadata; the existing agent/model chooser and reviewed-SHA merge confirmation remain separate
  flows rather than the web PR-list modal. The shared modal header/footer also remain rather
  than reproducing that component's bespoke 20-point header and inline card action group.
- Git Control is a web panel rather than a modal. Native history tabs/amend/remote actions remain;
  the existing native canCommit guard is retained. Flat change rows, always-visible row actions
  and system branch menus differ from the web directory tree and hover-only actions. Git history
  rows retain their native layout; only their prompts were in this task's sheet scope.
- Existing overlay behavior is reused: themed dimming replaces the web's literal RGBA scrim,
  and opacity/translation replace CSS transform scaling. No zoom scaleEffect was introduced.

## Validation and agent handoff

- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `git diff --check`: passed.
- Static source review: referenced direct theme tokens exist; existing Git accessibility
  identifier literals remain; new files introduce neither gradients nor hardcoded RGB colors.
- No build or UI harness was run, as requested. Reviewer must compile and visually validate on
  macOS 26.6, including overlay routing, keyboard focus, nested dismissal and zoom.
- No ai-memory skill or connector is available in this session. This versioned handoff records
  the implementation state and next steps; it does not claim an external memory write.
