# Project images and native performance audit

Reference: `origin/main` (`f09c597`), inspected with `git show`, without checkout.
This is a static failure-point audit, not a runtime profile or measured speedup claim.
Changes remain unstaged. No build, test binary, app restart, commit or push was run.

## Cover behavior and web references

The starting branch already had the image field, editor wiring, optional `iconUrl` model fields,
Tauri import support, sidebar/Home/tab images, localized errors and encode/decode tests. This
change improves that implementation rather than adding a second image schema or editor.

- `src/components/modals/ImageInput.tsx`: `image/*`, maximum 2 × 1024 × 1024 bytes, original
  bytes stored as a base64 data URL, arbitrary URL text input, preview and remove controls.
  The web does **not** downscale or compress uploads. Native persistence still retains original
  bytes; only transient display pixels are downsampled. `ProjectImageInput.fileDataURL` reads
  at most the limit plus one byte off the main actor and catches oversized/growing files.
- `NewProjectModal.tsx`, `EditProjectModal.tsx`, `GroupFields.tsx` pass their `iconUrl` values
  to ImageInput. The existing native new/edit project/group wiring is retained, including
  web fields under `.web` and Form/LabeledContent under `.mac`.
- `ImageInput.tsx` and `modals/controls.module.css` provide the existing 44-point preview,
  10-point radius, 18-point bold initial, 6-point action gap, 14-point action symbols,
  36-point bordered icon buttons and 10-point hint. No visible layout was changed here.
- `NormalProjectNode.tsx` / `NormalProjectSidebar.module.css`: 16-point project image,
  small-radius clipping, `object-fit: cover`. `ProjectNode.tsx` / `ProjectSidebar.module.css`:
  15-point project image. `HomeView/index.tsx` / `HomeView.module.css`: 34-point recent-project
  image. Existing bounded fill frames, clipping, theme colors and fallback icons are retained.
- `src/lib/types.ts`, `projectsStore.ts`, `projectsStore.projectSlices.ts` and
  `projectsStore.migrations.ts`: optional project/group field is exactly `iconUrl`.
  Existing round-trip, missing/null field and import tests remain; no model/schema changes.
- `ProjectSidebar/sidebarMenus.tsx` has Edit project/group, but no separate Change image action.
  No extra context action was invented. The inspected `NormalGroupNode.tsx` and `GroupNode.tsx`
  render text group tags without images; existing native web group images are retained to honor
  the explicit group-cover request. Existing tab images are also retained.

The new actor cache shares simultaneous identical requests, keys thumbnails by a SHA-256 source digest and pixel
size, and uses a 128-entry / 16 MB NSCache cost budget. ImageIO decodes thumbnails off the main
actor; an AppKit bitmap context handles vector fallback. URL typing waits 150 ms before starting
requests, and cancelled view/import tasks cannot publish stale results. Originals are untouched.
New cache and tests live in separate task files; Components.swift and the string catalog were
not changed. Existing dotted image keys already contain English and pt-BR translations.

Known image differences: thumbnails use the first GIF frame rather than browser animation;
SVG/WebP rendering depends on macOS ImageIO/AppKit support, with the existing fallback on failure.
The shared HTTP loader retains URLSession's full-response buffering; remote URL input has no web
2 MB limit. Concurrent requests with different pixel sizes can still download the same URL.
Cache budgets are NSCache eviction targets, not process-wide memory limits. Native `.mac` layout,
metrics and control branches are unchanged; shared loading/persistence optimizations serve both.

## Findings, impact and disposition

Paths below are relative to `AletheNative/`; line numbers refer to the final implementation.

| Finding / location | Impact | Fix or reason left |
| --- | --- | --- |
| `Alethe/Sidebar/SidebarCoverImage.swift:34`, `Packages/AletheKit/Sources/AletheDesign/Components+ProjectCoverCache.swift:23` | Repeated main-actor base64/decode work and full-resolution images for tiny rows/cards/tabs. | Fixed: background actor, display-size ImageIO thumbnails, coalesced identical loads and bounded shared cache. |
| `Alethe/Editors/ImageInputField.swift:106`, `Packages/AletheKit/Sources/AletheModel/ProjectImageInput.swift:21` | File reads and base64 encoding stall editing; selected files can grow after size inspection. | Fixed: cancellable publication, detached file/encoding work and bounded file read with byte validation. |
| `Alethe/Terminals/AgentLogo.swift:49` | Every web logo body/menu pass rasterizes the same asset again. | Fixed: main-actor 128-entry raster cache keyed by asset, template flag and point size; same rendering. |
| `Alethe/Terminals/ResourceMonitor.swift:63` | Every five seconds, process enumeration and per-descendant footprint syscalls run on the main actor; pressure events can repeat the work. | Fixed: one detached sampling pass at a time; apply current workspace/policy on the main actor and skip newly spawned unsampled processes. Priority changes remain on the main actor. |
| `Alethe/Terminals/ResourceMonitor.swift:128` | `lastUsed` retains IDs for closed terminals indefinitely. | Fixed: retain running terminal IDs only. |
| `Packages/AletheKit/Sources/AletheFoundation/DocumentStore.swift:86` | Startup decodes JSON to a generic object, re-encodes the entire object, then decodes the model even without migration. | Fixed: decode unchanged documents from original bytes; only migrated objects are re-encoded. Generic version inspection remains. |
| `Packages/AletheKit/Sources/AletheFoundation/DocumentStore.swift:131` | Failed saves drop the pending snapshot and advance the write sequence before disk success, preventing same-revision retries. | Fixed: retain failed pending snapshots; advance sequence and clear pending only after successful writes. No automatic retry loop or extra steady-state writes. |
| `Packages/AletheKit/Sources/AletheTerminal/ScrollbackFile.swift:93` | Restore/compaction read entire files before keeping 4 MB; unexpectedly large legacy files allocate large buffers. | Fixed: seek and read only the bounded tail. Public synchronous restore remains synchronous. |
| `Packages/AletheKit/Sources/AletheTerminal/ScrollbackFile.swift:40` | Pending disk batch grows with terminal throughput until the 250 ms timer fires. | Fixed: flush at the configured cap as well as the timer, preserving byte order and avoiding extra timer scheduling on threshold flushes. The DispatchQueue backlog itself is not bounded. |
| `Alethe/Terminals/TerminalRegistry.swift:102` | Activity timer keeps firing after the final watched terminal closes. | Fixed: invalidate and release it when watches become empty; next watch recreates it. Live background agents still receive completion ticks. |
| `Alethe/Home/HomeBackdrop.swift:32`, `Alethe/Home/HomeNowPlaying.swift:78,115` | 20/30 Hz decorative timelines keep ticking in an inactive scene. | Fixed: pause schedules when scenePhase is not active; active-scene drawing and Reduce Motion behavior stay intact. |
| `Packages/AletheKit/Sources/AletheModel/DocumentModel.swift:90`, `Alethe/Workspace/WorkspaceView.swift:72` | Whole-document observation can invalidate the pane host and sidebar on unrelated document edits. | Left: DocumentModel already drops no-op updates. Splitting observation safely needs presentation snapshots and UI profiling across undo, grids and workspace compositions; no speculative observable/schema rewrite. Existing row IDs are stable model IDs. |
| `Packages/AletheKit/Sources/AletheFiles/FileTree.swift:86,104`, `Alethe/RightSidebar/FilesView.swift:431` | Directory enumeration runs synchronously on the main actor, including watcher refresh of expanded folders. | Left: async listing needs expansion/filter revision guards and edit-operation ordering tests; the current API is synchronous and observable. Lazy expansion and event coalescing already limit scope. |
| `Alethe/Git/GitControlModel.swift:81`, `Packages/AletheKit/Sources/AletheGit/GitWatcher.swift:64` | Manual and watcher refreshes can overlap and repeat branch/status work. | Left: repository work already runs in an actor, FSEvents debounce is 300 ms, and event buffers keep only the newest signal. Replacing refresh semantics needs mutation-vs-refresh ordering tests. |
| `Alethe/Terminals/UsageMonitor.swift:22,44` | Repeated credential discovery every 15 seconds. | Left: discovery is detached, shown providers only; usage fetches are gated to five minutes and duplicate provider fetches are suppressed. Pausing would change background reset-notification behavior. |
| `Alethe/Home/HomeBackdrop.swift:102`, `Alethe/Home/HomeView.swift:233` | Backdrop resize resampling and profile-avatar decode still occur on the main actor. | Left: backdrop resampling is task-keyed by size/scale, not per animation frame; avatar path is separate from covers. Further caching should follow measured resize/header costs. |
| `Packages/AletheKit/Sources/AletheTerminal/PTYProcess.swift:174,248,279` | EAGAIN writes can spin on the read queue; continuous output can monopolize drain; deinit sends SIGHUP without a dedicated reap guarantee. | Left: a lossless writable-source/backpressure and child-lifetime redesign needs real PTY stress and exit tests. Existing 64 KiB reads, process exit source, waitpid, escalation and scrollback caps are retained. |
| `Vendor/GhosttyKit/Sources/GhosttyTerminal/Surface/TerminalSurfaceCoordinator.swift:211,425`, `InMemory/InMemoryTerminalSurfaceAccess.swift:30` | Hidden-pane rendering/timer and pre-attachment output growth risks. | Already protected: visibility/active-app display-link gating, idle release and 1 MB pending output cap. Do not stop mailbox draining solely because a pane is occluded: that can block PTY feed. Vendor code unchanged. |
| `Packages/AletheKit/Sources/AletheOrchestrator/Queue/PromptQueue.swift:25,74` | Persistent user queue can grow without an item cap. | Left: queued work is user-owned data; silently pruning it changes behavior. Snapshot streams already use bufferingNewest(1). Capacity policy needs a separate product decision. |
| `Packages/AletheKit/Sources/AletheFoundation/Diagnostics/Diagnostics.swift:43` | Synchronous rotating-log writes under the diagnostics lock can block an error-reporting caller. | Left: recent events are capped at 300 and files rotate, but moving writes needs flush/export/quit ordering tests. No unbounded recent-event list found. |
| `Alethe/App/AppEnvironment.swift:199` | Startup orchestration waits for services/documents. | Already partially parallel: independent document loads use async let; disk maintenance and several scans are detached. Removed redundant document re-encode above; no unmeasured service-order rewrite. |

## Validation and reviewer checks

- `python3 AletheNative/Scripts/check-strings.py`: passed.
- `git diff --check`: passed before handoff; rerun after final doc edit.
- Added Swift Testing cases for thumbnail size/aspect, cache reuse, invalid-image fallback,
  local image bytes/type/size validation, retrying failed saves at the same revision,
  retrying pending snapshots, oversized scrollback restore/compaction and ordered bursts.
  Existing web image JSON/import round-trip tests remain. Swift tests were not executed.
- Reviewer must compile with Swift 6 outside the nested sandbox, run package tests, then exercise
  project/group choose/drop/paste/URL/remove, stale import cancellation, PNG/JPEG/WebP/GIF/SVG,
  zoom/display-scale changes, both interface modes, inactive Home, resource-pressure checks,
  rapid terminal close/reopen, large terminal output and read-only/unwritable persistence.
- No claimed runtime measurements: inspect Instruments main-thread stalls and allocations before
  deciding on remaining Observation, directory, PTY and logging changes.

## Memory handoff

No ai-memory skill, connector or executable is available. The repository graphify-query skill was
read, but no graphify executable or graphify-out/graph.json exists in this checkout; graph queries
and updates could not run. This versioned handoff records decisions, changes, limits and next
checks without claiming an external memory or graph update. No new documentation directory,
web changelog edit or MAC_NATIVE_V2_PLAN.md edit was made.
