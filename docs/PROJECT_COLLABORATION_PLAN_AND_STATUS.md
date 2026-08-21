# Project Collaboration — Product Plan and Implementation Status

## Purpose

This document consolidates the owner's original product plan, the work completed in the current development branch, and the work that remains before Alethe has production-ready cross-device project collaboration. It is a status and planning record, not a statement that every listed capability is already available.

The approved product decisions are:

- Google is the only account identity provider for the first release.
- Project data should use a direct peer-to-peer connection whenever possible.
- A rendezvous service may help authenticated devices discover each other and negotiate a connection.
- A relay may be used when a direct connection is impossible, but it must handle only end-to-end encrypted data.
- Receiving an invitation or discovering another device must never download project data automatically.
- Work should be delivered in reviewable phase commits, followed by final documentation and pull-request validation.

## Original product plan

The plan began with problems observed during real use on Linux, Windows, Desktop, and Web. The intended result is one stable Alethe architecture rather than independent features that behave differently on each client.

### Application stability and platform integration

- Diagnose blank startup states and the Web client taking several minutes to attach.
- Make Desktop and Web use the same active Core and project/terminal state.
- Preserve terminal usability with many panes and extreme repeated resizing.
- Prevent Linux TUI overlap, clipped content, corrupted escape sequences, and resize-related agent crashes without imposing fixed row limits or reducing the terminal font scale.
- Recover safely after long idle periods, high RAM consumption, cache eviction, renderer loss, and interrupted writes.
- Correct Linux application, task-switcher, terminal-agent, and notification icons.
- Normalize native notifications across Windows, Linux, and macOS and retain an in-app fallback.
- Reduce duplicated frontend, transport, state, and dialog logic.

### Identity, devices, and security

- Replace prototype account actions with real Google authentication.
- Use the system browser, safe redirects, PKCE, verified account metadata, and protected credential storage.
- Identify each computer cryptographically and expose device trust, verification, activity, and revocation.
- Never treat a display name, project path, invitation code, or same Google account as automatic authorization.
- Encrypt project traffic end to end and ensure that signaling or relay infrastructure cannot read it.
- Add bounded buffers, caches, parsers, queues, retries, and audit records without leaking secrets.

### Project sharing and synchronization

- Let an owner invite a specific account or device to a specific project.
- Provide separate read, export/copy, write, upload, delete, invite, and administration permissions, including folder scopes.
- Provide an invitation center comparable to modern collaboration applications.
- Let recipients accept, refuse, defer, or dismiss an invitation.
- Require recipients to choose the local destination and synchronization mode before any download.
- Discover other PCs connected to the same Google account while still requiring project approval.
- Synchronize directly between peers when possible and use an encrypted relay only as fallback.
- Stage and verify incoming content before atomically publishing it into the live project.
- Detect conflicts, preserve recoverable versions, and provide explicit resolution controls.

### Collaboration

- Synchronize project tasks with public and restricted visibility.
- Add direct messages, groups, project channels, categories, threads, mentions, and notifications.
- Share images, files, commands, tests, code excerpts, and structured bug reports safely.
- Keep chat membership, task visibility, and project-file permissions as separate authorization domains.

## Work completed in the current branch

### Desktop/Web and terminal reliability

- The Web launcher now attaches to the existing authenticated Core instead of starting an unrelated frontend/backend state.
- Desktop and Web route contracts and terminal-grid convergence received automated coverage.
- Web bootstrap states are bounded and report failures instead of remaining indefinitely blank.
- Linux terminal resize handling was changed to preserve a stable logical grid, avoid resize bursts, and keep the original font scale with multiple panes.
- Terminal output buffering now preserves ANSI/UTF boundaries and bounds queued writes to reduce corruption under memory pressure and long idle periods.
- Linux icon packaging, task switching, notifications, and visible notification fallback were corrected.
- Shared transport, sidebar, terminal rendering, project actions, and creation-state implementations replaced several duplicated paths.

Relevant branch history includes `def45a3`, `07622b6`, `a6a1011`, `5fc7591`, `68f5663`, `dc64b32`, `824c9f7`, `07e9def`, and the earlier refactoring commits.

### Security contracts and local persistence

- A versioned project-sync threat model and deny-by-default TypeScript contracts were added.
- Permission implication and path-scope authorization logic has unit coverage.
- Device Ed25519 keys are generated locally; private keys are stored through the operating-system credential store.
- The local security document persists verified account metadata, device public identity, invitations, grants, and bounded audit events using atomic writes.
- Invitation bearer values use cryptographic randomness; only their hashes are persisted.
- Invitation redemption checks state, expiry, recipient account, optional recipient device, replay, and bounded failure lockout.
- Sanitized security snapshots are available through Tauri and the authenticated local Web API without returning bearer secrets or device private keys.
- The synchronization sidebar renders real persisted account/device/invitation/grant state and no longer presents prototype encryption or backup claims as active security.

Relevant commits: `81fa2af`, `cd5a474`, `970564f`, `babe7cb`, `b5f7406`, `e4c6095`, `5f7a19f`, and `a8a3e23`.

### Google identity

- Google login uses the system browser and a random loopback callback.
- The flow uses Authorization Code with PKCE S256, callback-state verification, backend token exchange, verified UserInfo, and credential-store persistence.
- Google configuration can be entered in the app as a validated public Desktop OAuth client ID without placing a client secret in the application.
- Both the synchronization sidebar and Account preferences use the same Google configuration and login implementation.
- Login controls now expose progress, configuration, connected state, and errors instead of remaining permanently disabled.

Relevant commits: `a971d8a`, `d7c3b96`, and `e14b1c1`.

### Planning and documentation already present

- Recipient-controlled storage, device sharing, permissions, shared tasks, and project chat requirements were added to the existing security and implementation plans.
- The current implementation intentionally leaves invitation and transfer buttons disabled when the corresponding secure runtime capability is unavailable.

Relevant commits: `0ebcc9d`, `dd2d6a2`, and `b4dfea9`.

## Current status summary

| Area | Status | Important limitation |
| --- | --- | --- |
| Desktop/Web shared Core | Implemented and tested | Broader collaboration state is not yet synchronized between separate physical PCs |
| Linux terminal resize resilience | Implemented with automated coverage | Additional long-running cross-compositor soak testing remains |
| Google Desktop OAuth | Implemented | A valid Google Desktop OAuth client ID is still required |
| Device key vault | Implemented locally, including approve/reject/rename/revoke/remove | Cross-device presence/discovery, key rotation, and all-devices-lost recovery remain |
| Invitation security primitives | Implemented locally and unit-tested, now exposed via Tauri commands and Web routes with a sidebar UI | No cross-PC delivery yet (Phase 3); redeem only works within one local install |
| Project grants and permission contracts | Issue/list/revoke implemented and tested | Not yet enforced by a real project-content transport; folder scopes not exposed in the UI |
| Rendezvous and relay | Not implemented | Required for reliable cross-network discovery and fallback transport |
| Project file transfer | Not implemented | No manifest, chunks, staging, verification, or atomic publication yet |
| Recipient destination workflow | Planned only | No project should download until this exists |
| Shared tasks | Planned only | No remote collaboration runtime yet |
| Project chat | Planned only | No channel/message/attachment protocol yet |
| Collaboration notifications | Partially available as generic infrastructure | Invitation/chat/task actions and cross-platform E2E coverage remain |

## Exhaustive status checklist

Legend:

- `[x]` implemented in the current branch.
- `[~]` partially implemented or implemented but still requiring broader validation.
- `[ ]` not implemented.

### Startup, packaging, icons, and notifications

- `[x]` Diagnose and correct the blank Web startup caused by attaching to the wrong or unavailable Core.
- `[x]` Make the Web launcher reuse an already running authenticated Core instead of waiting for another backend.
- `[x]` Add bounded loading, retry, unavailable, and error states during Web bootstrap.
- `[x]` Correct the Linux application icon used by bundles and task switching.
- `[x]` Restore bundled Antigravity icon assets in supported terminal surfaces.
- `[x]` Await native notification delivery and show an in-app fallback when delivery fails.
- `[~]` Validate application and agent icons across AppImage, DEB, RPM, X11, Wayland, GNOME, KDE, and different task switchers.
- `[~]` Validate notification action buttons, formatting, grouping, sounds, and icons across Windows, Linux, and macOS.
- `[ ]` Add automated packaging assertions that every release artifact contains all required icon resolutions and desktop metadata.
- `[ ]` Add release smoke tests that install, open, notify, update, and uninstall every supported package format.

### Terminal rendering, resizing, memory, and recovery

- `[x]` Remove fixed terminal row limits that reduced multi-pane capacity.
- `[x]` Preserve the original terminal font scale when panes become narrow.
- `[x]` Keep Linux agent PTYs on a stable logical grid during local pane compression.
- `[x]` Reduce Linux resize bursts and crash-prone repeated `SIGWINCH` delivery.
- `[x]` Add a horizontal viewport for compressed terminal content instead of overlaying adjacent panes.
- `[x]` Preserve ANSI sequence and Unicode boundaries while draining buffered terminal writes.
- `[x]` Bound pending terminal writes and recover the renderer after memory-pressure texture loss.
- `[x]` Retry transient Web terminal resolver/Core failures before reporting an agent as missing.
- `[~]` Verify OpenCode, Antigravity, Codex, Claude, shells, and full-screen TUIs under extreme repeated resizing on Linux.
- `[~]` Verify Desktop/Web divider convergence with three, four, five, and more simultaneous terminals.
- `[ ]` Add multi-hour idle/active soak tests under low, medium, and extreme RAM pressure.
- `[ ]` Simulate renderer/GPU process loss, system suspend/resume, display hotplug, DPI changes, and compositor restart.
- `[ ]` Add deterministic recovery when a terminal process survives but its renderer or WebSocket consumer restarts.
- `[ ]` Add corruption detection and repair for persisted terminal scrollback and partial final records.
- `[ ]` Bound every terminal cache, write queue, replay buffer, and WebSocket subscriber independently.
- `[ ]` Add backpressure metrics and user-visible diagnostics for dropped, delayed, or resynchronized output.
- `[ ]` Resolve existing platform-conditional Rust warnings without hiding incomplete runtime wiring.
- `[ ]` Remove or reintegrate the duplicated `pressure_level` implementation in the resource supervisor.

### Desktop, Web, NPM launcher, and mobile access

- `[x]` Use one transport abstraction for Tauri IPC and authenticated local Web HTTP/WebSocket access.
- `[x]` Share Core project/profile revision events between Desktop and Web clients.
- `[x]` Validate real terminal-grid convergence in the existing Desktop/Web test harness.
- `[~]` Consolidate remaining Desktop-only and Web-only call sites that still bypass the shared API layer.
- `[ ]` Define the supported NPM launcher contract, package name, version compatibility, update behavior, and failure messages.
- `[ ]` Add automated tests proving that newly added Desktop features either work on Web or expose an explicit unsupported capability.
- `[ ]` Measure and enforce cold-start, warm-start, first-project, first-terminal, and reconnect performance budgets.
- `[ ]` Split oversized frontend bundles and lazy-load heavy Markdown, Mermaid, visualization, and terminal dependencies.
- `[ ]` Add Web memory/leak profiling for long sessions, repeated project switches, terminal recreation, and hidden tabs.
- `[ ]` Add crash isolation so one Web pane, terminal parser, agent integration, or plugin failure cannot unmount the entire Web app.
- `[ ]` Define mobile-browser support boundaries and a responsive interaction model for project access, tasks, chat, and approvals.
- `[ ]` Prevent mobile or remote Web access from exposing local paths, shell capabilities, or unrestricted Core routes.
- `[ ]` Add authenticated remote-session expiry, device revocation, origin checks, CSRF protection, and secure cookie/token handling for non-loopback deployment.
- `[ ]` Add browser compatibility tests for Chrome, Edge, Firefox, Safari, Android, and iOS where supported.

### Duplication and maintainability

- `[x]` Share terminal/sub-tab creation state and runtime-profile fields.
- `[x]` Share group-tree rendering and cycle-safe descendant traversal.
- `[x]` Consolidate substantial sidebar state, actions, drag handling, terminal rendering, and transport logic.
- `[~]` Complete an application-wide duplication inventory after the recent refactors.
- `[ ]` Remove remaining duplicate account/Google controls by extracting one reusable stateful component.
- `[ ]` Remove duplicated permission, invitation, capability, and error mappings between Rust and TypeScript or generate them from one schema.
- `[ ]` Consolidate repeated loading/error/empty-state behavior across Desktop and Web.
- `[ ]` Add architectural boundary tests that prevent new direct IPC/Web forks from bypassing shared APIs.
- `[ ]` Reduce inline preference styling and move touched UI into scoped CSS modules and design tokens.
- `[ ]` Translate remaining touched Portuguese source comments and internal errors to English as files are modified.
- `[ ]` Keep Graphify current once its executable is available in the development environment.

### Google identity and account lifecycle

- `[x]` Replace the fake Google action with a real system-browser OAuth flow.
- `[x]` Use Authorization Code with PKCE S256, random state, random loopback port, backend exchange, and verified UserInfo.
- `[x]` Store OAuth credentials in the operating-system credential store rather than plaintext application data.
- `[x]` Mask the email stored in the public local security snapshot.
- `[x]` Allow a public Desktop OAuth client ID to be configured in the app without a client secret.
- `[x]` Connect both the synchronization sidebar and Account preferences to the same OAuth operations.
- `[ ]` Provision the official production Google Cloud project, consent screen, branding, scopes, test users, and Desktop client IDs.
- `[ ]` Define how official client IDs are injected into signed release builds without requiring ordinary users to configure development credentials.
- `[ ]` Validate the returned OpenID identity according to the final production token-validation architecture, including issuer, audience, expiry, and nonce where applicable.
- `[ ]` Implement access-token refresh, expiry tracking, revocation, transient network retry, and invalid-grant recovery.
- `[ ]` Implement explicit account disconnect, account switch, data export, and account deletion UX.
- `[ ]` Add reauthentication for high-risk operations such as admin grants, destructive revocation, and recovery changes.
- `[ ]` Synchronize account/device identity across physical PCs through authenticated remote infrastructure.
- `[ ]` Add Google OAuth E2E tests using an isolated test project or a documented manual test procedure where automation is prohibited.

### Device identity, trust, discovery, and recovery

- `[x]` Generate an Ed25519 key pair for a locally registered device.
- `[x]` Keep private device material in the operating-system credential store.
- `[x]` Persist public identity, fingerprint, trust state, timestamps, and audit metadata.
- `[x]` Define and implement secure first-device bootstrap after Google verification: the first device for an account is trusted automatically because no trusted peer exists to approve it.
- `[x]` Add an explicit approval ceremony for every additional device: it registers `Pending` and requires `approve`/`reject` from an already-trusted device of the same account.
- `[~]` Display device name, fingerprint, and verification state in the sidebar (this device plus other locally known devices). Platform, network state, and grant listing per device are not yet shown.
- `[x]` Add rename, approve, reject, revoke, and remove controls (Tauri commands and equivalent authenticated Web routes on one shared core implementation, plus sidebar UI). Sign-out remains the existing account-level disconnect only.
- `[x]` Invalidate a device's outstanding grants and pending invitations addressed to it immediately on revocation, and delete its private key from the credential store.
- `[ ]` Detect cloned or rolled-back device state and require recovery.
- `[ ]` Define key rotation and migration without silently preserving compromised keys.
- `[ ]` Define recovery when all trusted devices or credential-store entries are lost.
- `[ ]` Discover devices using the same Google account without granting automatic project access.
- `[ ]` Add owner-approved available-project metadata for same-account devices without exposing paths or manifests.
- `[ ]` Test device lifecycle across two or more real machines and across offline/reconnect cycles.

Note: today's device list is local to each install — cross-device visibility and remote approval require the rendezvous/discovery work in Phase 3 and are not yet implemented. The approve/reject/revoke/remove operations above are real and tested, but only operate on whatever device records exist in the local security document.

### Invitations, access center, and permissions

- `[x]` Define versioned invitation, grant, permission, device, account, and path-scope contracts.
- `[x]` Generate random invitation bearer tokens and persist only their hashes.
- `[x]` Enforce expiry, single use, recipient account, optional recipient device, replay resistance, and bounded failure lockout in local primitives.
- `[x]` Normalize permission dependencies and deny unknown or invalid scopes.
- `[~]` Expose issue, list, inspect, redeem, and revoke operations through Tauri and authenticated Web routes (`sync_issue_invitation`, `sync_revoke_invitation`, `sync_redeem_invitation`, `sync_revoke_grant`, plus the existing read-only snapshot). Explicit refuse/defer as distinct recipient actions and proactive expiry transitions are not implemented; expiry is still enforced only at redemption time.
- `[~]` Implement outgoing and redeemed/active views in the sidebar (from the local snapshot). Incoming, same-account request, and hidden views require cross-device delivery (Phase 3) and are not implemented; there is no view of invitations addressed to this account that were issued on another install.
- `[~]` Implement a link representation of the invitation credential (`alethe-invite://` URL carrying the invitation ID and bearer token). QR code rendering and a distinct human-readable short code are not implemented.
- `[ ]` Add recipient lookup without revealing whether arbitrary Google accounts exist.
- `[x]` Add permission presets (view only / reviewer / collaborator) and always display the expanded effective permission list next to the selected preset.
- `[x]` Permissions are enforced as separate backend values (`read`/`export`/`write`/`upload`/`delete`/`invite`/`admin`); the UI currently exposes them only through presets, not individual toggles.
- `[ ]` Add allow/deny folder scopes with deny precedence and traversal-safe normalization in the UI (the backend contract already supports `pathScopes`; the sidebar always issues an empty scope for now).
- `[x]` Require stronger confirmation before issuing an invitation with `write`, `delete`, `invite`, or `admin` permissions (a second explicit click).
- `[x]` Add active-grant inspection (list) and immediate revocation (`revoke_grant_at`, callable by any trusted device on the issuing account). Expiry adjustment and narrowing an existing grant are not implemented.
- `[ ]` Notify all affected devices when invitation or grant state changes — there is no cross-device delivery yet, so nothing to notify.
- `[x]` Ensure a stale UI or cached permission never authorizes a backend operation (every operation re-checks device trust and account ownership server-side; unit-tested).
- `[x]` Remove the disabled "Invite Friend" placeholder now that local issuance is real; it stays disabled until the local device is trusted and a project is active.
- `[ ]` Add concurrency tests for simultaneous acceptance, revocation, expiry, and replay.

Note: as with devices, invitations and grants are local to each install today. Issuing, revoking, and redeeming all operate on the local security document; there is still no real delivery of an invitation from one physical machine to another (that is Phase 3's rendezvous work). Redemption today only works if both the issuer and the recipient act against the same local document — useful for local testing of the state machine, not yet a cross-device feature.

### Rendezvous, relay, and network presence

- `[ ]` Select the deployable rendezvous and relay technology and record it in an ADR.
- `[ ]` Define versioned registration, authenticated presence, signaling, invitation notification, and connection-candidate messages.
- `[ ]` Authenticate every signaling message with current account/device state.
- `[ ]` Store only opaque identifiers, public device data, delivery state, abuse counters, and minimum routing metadata.
- `[ ]` Prevent the service from receiving OAuth tokens, private keys, paths, filenames, project content, task content, or chat plaintext.
- `[ ]` Add offline queues with bounded retention and deletion semantics.
- `[ ]` Add heartbeat, reconnect, jittered backoff, duplicate suppression, ordering, and clock-skew handling.
- `[ ]` Add per-account/device/IP quotas, rate limits, payload limits, and abuse controls.
- `[ ]` Add direct connection negotiation across common NAT and firewall configurations.
- `[ ]` Add encrypted relay fallback when direct connectivity fails.
- `[ ]` Define server deployment, TLS, secrets, database, backups, upgrades, rollback, observability, alerts, and incident response.
- `[ ]` Define privacy disclosure for IP address, connection timing, ciphertext size, and retention.
- `[ ]` Add multi-region or explicit single-region behavior and document latency/availability expectations.
- `[ ]` Test LAN, different home networks, carrier NAT, corporate firewall, IPv4, IPv6, offline recipient, relay-only, and reconnect scenarios.

### End-to-end encrypted transport

- `[ ]` Mutually authenticate device keys before exchanging project metadata.
- `[ ]` Derive ephemeral per-session keys with forward secrecy.
- `[ ]` Bind every encrypted frame to protocol version, account, device, project, grant, stream, sequence, and content type.
- `[ ]` Prevent replay, cross-project substitution, downgrade, confused-deputy, truncation, and reordering attacks.
- `[ ]` Add bounded framing, parsing, decompression, queues, streams, and concurrent transfers.
- `[ ]` Add keepalive, cancellation, timeout, retry, resume, backpressure, bandwidth control, and progress reporting.
- `[ ]` Rotate session keys and terminate sessions on revocation or authorization changes.
- `[ ]` Ensure relay operators and packet captures cannot recover plaintext.
- `[ ]` Add protocol compatibility negotiation that fails closed on unsupported versions.
- `[ ]` Fuzz transport parsers and run interoperability tests across Desktop and standalone Core builds.

### Recipient-controlled destination and subscription

- `[ ]` Separate remote project grants from local subscriptions.
- `[ ]` Implement offered, configuring, awaiting-confirmation, staging, verifying, active, paused, declined, revoked, and error states.
- `[ ]` Let recipients accept, refuse, defer, dismiss, and later reopen an offer.
- `[ ]` Require an explicit local destination before any project-content request.
- `[ ]` Support create managed copy, attach existing copy, and download snapshot when authorized.
- `[ ]` Support manual, receive-after-setup, and bidirectional modes with manual as the safe default.
- `[ ]` Display effective permissions, excluded content, expected size, direction, deletion behavior, and conflict policy before confirmation.
- `[ ]` Validate destination containment, traversal, symlinks, case sensitivity, path length, free space, filesystem permissions, and collisions.
- `[ ]` Compare an attached existing copy before allowing synchronization.
- `[ ]` Guarantee that invitation delivery, inbox viewing, acceptance, discovery, or grant creation performs zero destination writes.
- `[ ]` Persist subscription choices independently per recipient device.

### Project manifests, files, staging, and integrity

- `[ ]` Define deterministic, signed, versioned project manifests using normalized relative paths.
- `[ ]` Define default inclusion/exclusion rules for source, `.git`, dependencies, build outputs, environment files, credentials, agent transcripts, plans, backups, and hidden metadata.
- `[ ]` Provide an explicit folder-selection interface and show security-sensitive exclusions.
- `[ ]` Reject unsafe symlinks, special files, devices, sockets, traversal, absolute paths, and unsupported metadata.
- `[ ]` Chunk large files with bounded sizes and content hashes.
- `[ ]` Deduplicate chunks without leaking cross-account content equality to untrusted infrastructure.
- `[ ]` Stage all received content outside the live tree.
- `[ ]` Verify signatures, grant, manifest, hashes, sizes, counts, quotas, and destination again before publication.
- `[ ]` Publish verified content atomically and retain a recoverable previous version.
- `[ ]` Add pause, resume, cancel, cleanup, retry, and crash recovery at every transfer boundary.
- `[ ]` Add disk-space reservation and safe behavior when space disappears during transfer.
- `[ ]` Prevent cache eviction from deleting the only recoverable copy.
- `[ ]` Encrypt sensitive local staging and cached metadata where required.
- `[ ]` Add backup creation, integrity verification, retention, restore, and documented immutability semantics before re-enabling vault claims.

### Continuous synchronization and conflicts

- `[ ]` Track stable project/file revisions rather than relying only on modification timestamps.
- `[ ]` Coalesce filesystem events and handle rename, delete, case-only rename, permissions, offline edits, and watcher overflow.
- `[ ]` Reauthorize every file operation against the current grant and path scopes.
- `[ ]` Define upload/download/delete propagation independently.
- `[ ]` Add deterministic conflict records instead of last-writer-wins overwrites.
- `[ ]` Provide keep local, keep remote, keep both, and safe text-merge actions.
- `[ ]` Preserve conflict inputs and audit the selected resolution.
- `[ ]` Add pause per project and peer, rescan, repair, rollback, and restore controls.
- `[ ]` Handle long offline intervals, history compaction, divergent manifests, and deleted peers.
- `[ ]` Keep Desktop and Web progress, divider state, subscriptions, conflicts, and recovery status convergent.
- `[ ]` Add large-project, many-small-files, binary-file, rename-storm, and interruption soak tests.

### Shared tasks

- `[ ]` Define versioned project task, comment, assignment, label, due-date, status, and revision models.
- `[ ]` Support project-public and explicitly restricted/private tasks.
- `[ ]` Authorize task listing, counts, search, notifications, mutation, export, and deletion separately.
- `[ ]` Add offline task edits with deterministic merge or explicit conflicts.
- `[ ]` Add task history, audit, retention, restore, and deletion behavior.
- `[ ]` Keep task synchronization independent from project-file transfer state.
- `[ ]` Add Desktop, Web, and mobile-responsive task interfaces.
- `[ ]` Test that unauthorized users cannot infer private task existence through metadata.

### Programmer-focused chat

- `[ ]` Define versioned direct-message, project-channel, private-group, category, thread, mention, reaction, and read-state models.
- `[ ]` Keep chat membership separate from project-file grants and task visibility.
- `[ ]` Add images, files, code blocks, command blocks, test results, logs, and structured bug reports.
- `[ ]` Add safe terminal selection sharing without automatic command execution.
- `[ ]` Add attachment size/type limits, scanning, metadata stripping, safe preview, retention, and deletion.
- `[ ]` Encrypt messages and attachments end to end across rendezvous/relay infrastructure.
- `[ ]` Add offline delivery, ordering, deduplication, editing, deletion, retention, and device revocation behavior.
- `[ ]` Prevent removed members from obtaining new message or attachment keys.
- `[ ]` Add search without leaking private-channel content.
- `[ ]` Add Desktop, Web, and mobile-responsive chat interfaces and accessibility coverage.

### Notifications and access center

- `[ ]` Build one access center for invitations, device approvals, same-account requests, grants, revocations, conflicts, transfer failures, tasks, and chat mentions.
- `[ ]` Keep security actions visually and logically distinct from ordinary collaboration notifications.
- `[ ]` Add read/unread, dismiss, defer, retry, filter, search, grouping, and deep links.
- `[ ]` Revalidate authorization and expiry when a notification action is clicked.
- `[ ]` Prevent notification previews from exposing secrets, full paths, private task details, or private message content.
- `[ ]` Add consistent native icons, formatting, action handling, and in-app fallback on Windows, Linux, and macOS.
- `[ ]` Synchronize notification state across a user's devices without allowing one stale device to repeat an action.

### Security, privacy, abuse resistance, and recovery

- `[x]` Add the initial project-sync threat model and security invariants.
- `[ ]` Extend the threat model to the final rendezvous, relay, transport, manifest, subscription, task, chat, notification, and backup designs.
- `[ ]` Add backend authorization to every operation; never trust UI roles or cached capability state.
- `[ ]` Add quotas, rate limits, bounded parsers, cancellation, backpressure, and timeouts at every untrusted boundary.
- `[ ]` Add secret-redaction tests for logs, diagnostics, errors, crash reports, snapshots, URLs, clipboard content, and notifications.
- `[ ]` Add key rotation, compromised-device response, credential deletion, account export, project export, and deletion completion semantics.
- `[ ]` Add append-only privacy-conscious audit events for security decisions without content or secrets.
- `[ ]` Add dependency, license, supply-chain, update, release-signing, and rollback reviews.
- `[ ]` Add server backup/restore drills and client recovery drills.
- `[ ]` Perform an independent security review before enabling production synchronization.

### Automated and manual testing

- `[x]` Add initial frontend contract/authorization tests and Rust security persistence/invitation tests.
- `[x]` Add Desktop/Web shared-Core and terminal-grid convergence coverage.
- `[ ]` Add Rust tests for every device, invitation, grant, transport, manifest, staging, conflict, task, chat, and recovery transition.
- `[ ]` Add TypeScript tests for every capability gate, view model, permission presentation, form, and error/retry state.
- `[ ]` Add IPC/HTTP equivalence contract tests for every collaboration operation.
- `[ ]` Add WebdriverIO flows using real clicks for Google state, device approval, invite creation, acceptance, destination selection, transfer, conflict, task, chat, and revocation.
- `[ ]` Add multi-process tests using isolated profiles and at least two independent Core instances.
- `[ ]` Add direct-P2P, relay-only, offline, reconnect, revoked-mid-transfer, corrupted-chunk, and crash-recovery integration tests.
- `[ ]` Add fuzz/property tests for paths, scopes, invitation payloads, transport frames, manifests, archives, messages, and attachments.
- `[ ]` Add leak, performance, stress, and soak tests for Web and Desktop.
- `[ ]` Run the manual matrix on Windows, macOS, Linux X11, Linux Wayland, multiple DPI scales, multiple GPUs, and supported browsers.
- `[ ]` Record test commands, environment, screenshots, failures, and results in the final implementation report.

### Documentation, release, and pull request

- `[x]` Maintain the threat model, ADR direction, implementation plan, changelog, and this consolidated status document.
- `[ ]` Add final protocol, schemas, API, deployment, operations, privacy, recovery, migration, and user documentation.
- `[ ]` Document the official Google Cloud setup and production credential injection process.
- `[ ]` Document rendezvous/relay deployment and data-retention behavior.
- `[ ]` Document recipient setup, permissions, conflicts, recovery, tasks, chat, and device revocation for users.
- `[ ]` Keep capability labels accurate so prototypes never claim production encryption, immutable backups, or real remote transfer.
- `[ ]` Create phase commits as implementation resumes and a final documentation/status commit after all release gates pass.
- `[ ]` Push the completed branch to GitHub only after validation.
- `[ ]` Update pull request #153 with the final architecture, implementation summary, migrations, tests, risks, and limitations.
- `[ ]` Add a Portuguese pull-request comment summarizing what was completed and which manual tests the owner should perform.

## Remaining implementation plan

The following phases describe work that is still pending. None of these sections should be interpreted as an available production capability until its acceptance criteria and release tests pass.

## Architecture terms

### Rendezvous

The rendezvous service is a meeting point for devices. It records minimal online-presence metadata, authenticates device announcements, and exchanges connection candidates. It must not receive OAuth tokens, private keys, local paths, filenames, or plaintext project content.

### Relay

A relay is a fallback data path used when NAT or a firewall prevents a direct peer-to-peer connection. Payloads must be encrypted on the sending device and decrypted only on the receiving device. The relay may observe connection timing and ciphertext size but must not be able to read project data.

### Grant and subscription

A project grant authorizes a specific account or device to request specific operations. A local subscription records whether the recipient chose to use that grant, where the project should be stored, and how synchronization should run. Creating a grant must not create a directory or transfer content.

## Phase 1 — Trusted devices and account recovery

- `[x]` Define the secure bootstrap rule for the first device after verified Google authentication: automatic trust, since no other trusted device exists yet.
- `[x]` Add explicit approval for additional devices (`approve_device_at`/`reject_device_at`). Fingerprint and creation time are shown; platform and last activity are not yet tracked per device.
- `[x]` Add device rename, revoke, and remove operations (`rename_device_at`, `revoke_device_at`, `remove_device_at`).
- `[x]` Invalidate grants and pending invitations bound to a revoked device.
- `[ ]` Define recovery behavior when all trusted devices are lost.
- `[x]` Prevent silent account switching while device keys or grants remain (pre-existing `account_switch_requires_disconnect` behavior, unchanged).
- `[x]` Add Desktop (Tauri) and Web (`/api/sync/security/devices/*`) routes backed by the same `sync_security.rs` operations.

Acceptance criteria:

- `[x]` A new (non-first) device cannot access project metadata before approval — enforced by `approve_device_at`/`issue_invitation` requiring `Trusted`, with a regression test.
- `[x]` Revocation blocks subsequent requests from that device by invalidating its grants and pending invitations — tested. Live transport sessions do not exist yet (Phase 4), so there is nothing further to close today.
- `[x]` Private device keys never appear in frontend state, logs, diagnostics, or project files — unchanged from the existing credential-store-only design; the new commands never return key material.

Remaining for this area: cloned/rolled-back device detection, key rotation, all-devices-lost recovery, same-account discovery, and cross-machine approval (the last two require Phase 3 rendezvous).

## Phase 2 — Invitations and project permissions

- `[x]` Expose backend operations to issue, revoke, and redeem invitations (`sync_issue_invitation`, `sync_revoke_invitation`, `sync_redeem_invitation`) plus grant revocation (`sync_revoke_grant`), as Tauri commands and equivalent `/api/sync/security/invitations/*` and `/api/sync/security/grants/*` Web routes on one shared core implementation. Listing/inspecting reuses the existing security snapshot. Explicit expiry transitions are not implemented.
- `[~]` Add outgoing and active-grant views to the sidebar access center. Incoming/same-account/hidden views require Phase 3 delivery.
- `[~]` Represent an invitation as an `alethe-invite://` link carrying the invitation ID and bearer token, shown once at issuance with copy-to-clipboard. QR code and a distinct short code are not implemented.
- `[x]` Bind every invitation to a project, issuer device, recipient account, optional recipient device, permissions, path scopes, protocol version (implicit schema version), and expiry — unchanged from the existing local primitives.
- `[x]` Add permission presets (view only / reviewer / collaborator) while always showing the expanded permission list next to the selection.
- `[x]` Support `read`, `export`, `write`, `upload`, `delete`, `invite`, and `admin` as separate backend-enforced permissions (pre-existing; now reachable from the UI through presets).
- `[x]` Require stronger confirmation (a second explicit click) for invitations carrying `write`, `delete`, `invite`, or `admin`.
- `[x]` Add grant inspection (list) and immediate revocation, callable by any trusted device on the account that issued the underlying invitation.
- `[x]` Keep bearer secrets out of persisted invitation records and audit events — unchanged; only the hash is ever persisted, and the plaintext token is returned exactly once at issuance.

Acceptance criteria:

- `[x]` Tokens are random, short-lived, single-use, audience-bound, and replay-resistant — unchanged, pre-existing behavior, still covered by tests.
- `[x]` Wrong-recipient and wrong-device failures do not reveal which check failed — unchanged (`invitation_unavailable` for every redemption failure mode).
- `[x]` Viewing or accepting an invitation performs zero project-content reads and zero destination writes — redemption only creates a `GrantRecord` (authorization state); no filesystem access happens anywhere in this phase.

Remaining for this area: cross-PC invitation delivery (Phase 3), recipient lookup without account enumeration, folder scope UI, QR/short-code representations, grant expiry adjustment, and affected-device notifications.

## Phase 3 — Rendezvous, presence, and remote invitation delivery

- Define a versioned signaling protocol for device registration, presence, connection offers, and invitation notifications.
- Authenticate every signaling message with account and device identity.
- Store only the minimum metadata required for delivery and abuse prevention.
- Add reconnect, backoff, offline queues, expiry, rate limiting, and bounded message sizes.
- Discover devices connected to the same Google account without granting project access automatically.
- Add an owner-approved catalog of available projects using opaque project identifiers.
- Deliver invitations across different PCs and synchronize their lifecycle atomically.
- Document deployment, retention, deletion, observability, and incident-response requirements.

Acceptance criteria:

- A malicious or compromised signaling service cannot read project content or impersonate a device.
- Same-account discovery does not bypass project grants.
- Offline delivery cannot revive expired or revoked invitations.

## Phase 4 — Encrypted peer transport and relay fallback

- Select and document the transport stack for direct and relayed connections.
- Authenticate both device keys during channel establishment.
- Derive per-session encryption keys with forward secrecy.
- Bind encrypted frames to protocol version, project, grant, sender, recipient, stream, sequence, and content type.
- Reject replayed, reordered beyond policy, cross-project, and oversized frames.
- Add direct-connection negotiation and encrypted relay fallback.
- Add keepalive, reconnection, cancellation, backpressure, bandwidth limits, and transfer progress.
- Never expose OAuth tokens as transport credentials.

Acceptance criteria:

- Packet captures and relay logs contain no plaintext project data.
- Revoking a device or grant terminates or invalidates the related transport session.
- Interrupted transfers resume without duplicating or corrupting committed content.

## Phase 5 — Recipient-controlled project setup

- Model local subscription states explicitly: offered, configuring, awaiting confirmation, staging, verifying, active, paused, declined, revoked, and error.
- Let the recipient choose create managed copy, attach existing copy, or download snapshot when permitted.
- Require an explicit destination and validate containment, symlinks, permissions, free space, path length, and collisions.
- Let the recipient choose manual, receive-after-setup, or bidirectional synchronization.
- Show excluded folders, expected size, permissions, direction, and destructive behavior before confirmation.
- Keep the grant available when a recipient defers or dismisses setup.

Acceptance criteria:

- No directory is created until the recipient confirms the destination and mode.
- A project cannot escape its selected destination through traversal or symlinks.
- Unsupported modes are visibly disabled with a precise reason.

## Phase 6 — Manifest, staging, integrity, and atomic publication

- Define a deterministic, versioned project manifest with normalized relative paths and content hashes.
- Exclude secrets, credentials, heavy generated directories, device files, sockets, and unsafe symlinks by default.
- Split large files into bounded, content-addressed chunks.
- Stage incoming data outside the live project tree.
- Verify manifest signatures, authorization, hashes, sizes, counts, and disk quotas before publication.
- Publish verified snapshots atomically and preserve a recoverable previous state.
- Add pause, resume, cancel, cleanup, and crash-recovery behavior.
- Bound memory, cache, queue, scrollback, and pending-write usage under pressure.

Acceptance criteria:

- A crash at every transfer boundary leaves either the previous valid tree or the new verified tree, never a mixed tree.
- Corrupt, truncated, substituted, or unauthorized chunks never reach the live project.
- Cache eviction cannot delete the only recoverable version of user data.

## Phase 7 — Continuous synchronization and conflicts

- Track local and remote revisions without relying only on timestamps.
- Coalesce file-system events and handle rename, delete, case-only changes, permissions, and offline edits.
- Enforce the current grant on every requested operation and path.
- Add explicit conflict records instead of silently overwriting concurrent changes.
- Provide keep local, keep remote, keep both, and supported text-merge actions.
- Add project pause, peer pause, rescan, repair, and restore controls.
- Keep Desktop and Web views consistent without allowing the Web client to bypass Core authorization.

Acceptance criteria:

- Concurrent edits are reproducible and never resolved by silent data loss.
- Revoked permissions take effect before the next mutation is applied.
- Repeated resize, reconnect, memory pressure, and long-idle sessions do not corrupt terminal or sync state.

## Phase 8 — Shared tasks

- Add project-scoped task identities, revisions, authorship, assignment, due dates, labels, and completion state.
- Support project-public tasks and restricted tasks with explicit membership.
- Authorize every read and mutation against the current project grant.
- Define offline edits, conflict handling, deletion, retention, and audit behavior.
- Synchronize tasks independently from project-file transfer so a paused file transfer does not corrupt task state.

Acceptance criteria:

- Private tasks are never disclosed through counts, notifications, search, or exports to unauthorized users.
- Offline concurrent edits produce a deterministic merge or an explicit conflict.

## Phase 9 — Programmer-focused chat

- Add direct messages, project channels, private groups, categories, threads, mentions, reactions, and read state.
- Support images, files, test results, bug reports, code snippets, and command blocks.
- Provide a safe terminal selection/share action without automatically executing received commands.
- Scan and bound attachments, strip unsafe metadata where appropriate, and prevent executable preview behavior.
- Encrypt message content and attachments end to end when traversing rendezvous or relay infrastructure.
- Separate chat membership from project-file permissions.

Acceptance criteria:

- Receiving a command never executes it.
- Removed members cannot fetch new messages or attachment keys.
- Categories organize channels but do not grant access.

## Phase 10 — Notifications and access center

- Add one access center for invitations, device approvals, project requests, grants, revocations, conflicts, transfer failures, tasks, and chat mentions.
- Keep security notifications distinct from collaboration notifications.
- Provide read/unread, dismiss, defer, retry, and deep-link behavior.
- Normalize notification formatting and icons across Windows, macOS, Linux, and Web.
- Add visible in-app fallback when native notification delivery fails.
- Avoid placing secrets, full local paths, or private message content in operating-system notifications.

Acceptance criteria:

- Notification actions revalidate current authorization before changing state.
- A stale notification cannot accept an expired invitation or resume a revoked transfer.

## Phase 11 — Security, abuse resistance, and operations

- Complete the threat model for signaling, relay, transport, storage, chat, tasks, and recovery.
- Add rate limits, quotas, bounded parsers, cancellation, backpressure, and lockouts at every untrusted boundary.
- Add key rotation, credential deletion, account export, device recovery, and project-access deletion flows.
- Add privacy-preserving audit events without content, tokens, local paths, or encryption keys.
- Add structured diagnostics with secret redaction.
- Define server metrics, alerts, backups, upgrades, rollback, retention, and incident response.
- Perform dependency, supply-chain, and release-signing reviews.

Acceptance criteria:

- Security logs can explain an authorization decision without exposing sensitive content.
- Fuzzed and oversized protocol input cannot crash the Desktop app or standalone server.
- Account and project deletion have documented, testable completion semantics.

## Phase 12 — Test and release program

Required automated coverage:

- Rust unit tests for identity, device trust, invitation lifecycle, grants, authorization, paths, manifests, chunks, staging, atomic publication, conflicts, and recovery.
- TypeScript tests for view models, capability gates, permission presentation, recipient state, notification state, and error recovery.
- Contract tests proving Desktop IPC and Web HTTP routes return equivalent results.
- Multi-process integration tests for direct P2P, relay fallback, reconnect, offline invitation delivery, revocation, and interrupted transfer recovery.
- WebdriverIO tests using real clicks and typing for Google account state, device approval, invite creation, acceptance, destination selection, transfer progress, conflict resolution, tasks, chat, and revocation.
- Security tests for replay, wrong audience, confused deputy, path traversal, symlink escape, oversized payloads, malformed frames, token leakage, and unauthorized cached data.
- Long-running soak tests with multiple terminals, transfers, Web clients, memory pressure, repeated resizing, idle/resume cycles, and network interruption.
- Cross-platform validation on supported Windows, Linux X11, Linux Wayland, and macOS configurations.

Release gates:

- No known critical or high-severity authorization or data-integrity defect.
- No plaintext OAuth token, device private key, invitation bearer token, project content, or private chat payload in logs or relay storage.
- All supported clients enforce the same protocol version and fail closed on unknown fields or capabilities.
- Recovery drills demonstrate restoration after process crash, network loss, corrupt staging data, and revoked peers.
- User-facing documentation clearly distinguishes available, experimental, and unavailable capabilities.

## Planned delivery order

1. Trusted devices and recovery.
2. Invitations, permissions, and access center.
3. Rendezvous and remote delivery.
4. Authenticated P2P transport and relay fallback.
5. Recipient destination and subscription workflow.
6. Manifest, staging, verification, and atomic publication.
7. Continuous synchronization and conflict recovery.
8. Shared tasks.
9. Programmer-focused chat.
10. Notifications and access center integration.
11. Security hardening and operations.
12. Full validation, release documentation, final commit, push, and pull-request update.

## Pull-request completion record

When implementation resumes and all release gates are satisfied, the final pull-request update must include:

- Phase-by-phase commit references.
- Implemented protocol and schema versions.
- Automated test commands and results.
- Manual test matrix with platform, compositor, network topology, and outcome.
- Remaining known limitations and explicit non-goals.
- Security review summary and unresolved risk acceptance, if any.
- Upgrade, rollback, data migration, and recovery instructions.
- A Portuguese summary comment on pull request #153.

## Continuation handoff

### Repository state at this handoff

- Repository: `Kc1t/alethe-agents`.
- Pull request: `#153`.
- Development branch: `feat/mesh-sync-p2p-vault`.
- Last implementation commit before this document: `e14b1c1` (`fix: connect and resize Google account controls`).
- Handoff date: 2026-08-21.
- This handoff intentionally contains documentation only. No partial phase implementation should remain in the working tree after it is committed.

### Decisions that must be preserved

- Google-only identity for the first collaboration release.
- No email/password account system in the current scope.
- Direct P2P is preferred for project content.
- Rendezvous is used for authenticated discovery and signaling, not plaintext project storage.
- Relay is a connectivity fallback and may forward only end-to-end encrypted payloads.
- Same-account device discovery never grants project access automatically.
- Invitations never trigger automatic download.
- The recipient must choose the destination, transfer mode, and final confirmation before content transfer.
- Backend authorization is authoritative; frontend capability state is never sufficient authorization.
- Features remain visibly unavailable until the secure runtime path and tests are real.
- Implementation resumes in phase order and uses reviewable commits.

### Authoritative documents to read before resuming

1. This document: `docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`.
2. `docs/security/PROJECT_SYNC_THREAT_MODEL.md`.
3. `docs/adr/ADR-0001-project-sync-security-and-transport.md`.
4. `docs/superpowers/plans/2026-08-20-secure-project-sync-and-linux-integration.md`.
5. `docs/DIAGNOSTICO_MATURIDADE_TECNICA.md` for duplication and performance context.
6. `AGENTS.md` and `CONTRIBUTING.md` for repository rules and validation commands.

If a statement conflicts, the stricter security invariant wins. This consolidated document records current product decisions; the threat model remains authoritative for security requirements.

### Primary implementation files

- `src-tauri/src/sync_security.rs`: local security document, device records, invitation/grant primitives, audit events, validation, and credential-store device keys.
- `src-tauri/src/sync_mesh.rs`: Google OAuth, folder scanning, project isolation, and backup prototype operations.
- `src-tauri/src/server_main/sync_security_routes.rs`: current read-only Web security snapshot route.
- `src-tauri/src/lib.rs`: Tauri command registration.
- `src/lib/sync/contracts.ts`: frontend protocol, capability, identity, invitation, grant, and permission contracts.
- `src/lib/sync/authorization.ts`: frontend deny-by-default authorization model and permission presets.
- `src/lib/api/syncSecurity.ts`: Desktop/Web sanitized security snapshot client.
- `src/lib/api/mesh.ts`: Google and current mesh-related frontend API calls.
- `src/components/ProjectSidebar/MeshSidebarView.tsx`: current account/device/access/project-sync sidebar.
- `src/components/modals/preferences/AccountPage.tsx`: second Google account entry point.
- `src-tauri/src/server_main/mod.rs`: authenticated local Core, middleware, and route assembly.
- `e2e/specs/web-sync.spec.ts`: existing Desktop/Web convergence reference.

### Exact next implementation step

Phases 1 and 2 have been implemented in this branch.

**Phase 1** (trusted devices and account recovery): first-device auto-trust, additional-device `Pending`/approval, `approve_device_at`/`reject_device_at`/`rename_device_at`/`revoke_device_at`/`remove_device_at` in `src-tauri/src/sync_security.rs` with unit tests, matching Tauri commands and `/api/sync/security/devices/*` Web routes, frontend API functions in `src/lib/api/syncSecurity.ts`, and device-management controls in `MeshSidebarView.tsx`. Cloned/rolled-back device detection, key rotation, and all-devices-lost recovery remain open within this same phase area but were not blocking.

**Phase 2** (invitations and project permissions): `issue_invitation`/`redeem_invitation` (pre-existing) plus new `revoke_invitation_at`/`revoke_grant_at` in `sync_security.rs` with unit tests, matching Tauri commands (`sync_issue_invitation`, `sync_revoke_invitation`, `sync_redeem_invitation`, `sync_revoke_grant`) and `/api/sync/security/invitations/*` + `/api/sync/security/grants/*` Web routes, an `alethe-invite://` link representation (`src/lib/sync/invitationLink.ts`), and a working invite/redeem/revoke UI in `MeshSidebarView.tsx` gated on real device-trust state. QR codes, a distinct short code, recipient lookup, folder-scope UI, and — most importantly — actual cross-PC delivery of an invitation remain open; today issuing and redeeming both operate on the same local security document, which is enough to exercise and test the state machine but is not yet a working cross-device feature.

Resume with **Phase 3 — Rendezvous, presence, and remote invitation delivery** next, not with chat, tasks, project transfer, or UI polish:

1. Select and record the rendezvous/relay technology in an ADR (this is currently an open decision — see "Open security decisions" in the threat model).
2. Define a versioned signaling protocol for device registration, authenticated presence, connection offers, and invitation notifications.
3. Authenticate every signaling message against current account/device state; the service must never receive OAuth tokens, private keys, paths, filenames, project content, task content, or chat plaintext.
4. Add reconnect, backoff, offline queues, expiry, rate limiting, and bounded message sizes.
5. Implement same-Google-account device discovery without granting automatic project access, plus an owner-approved catalog of available projects using opaque identifiers.
6. Wire actual cross-PC delivery of the invitations built in Phase 2, so an invitation issued on one machine reaches the intended recipient's device on another.
7. Update `[Unreleased]` in `docs/CHANGELOG.md`.
8. Run focused tests, full Rust tests, frontend tests, lint, format check, and production build.
9. Commit Phase 3 separately before starting transport/relay work (Phase 4).

### Required validation commands while resuming

Run commands from the repository root. Keep the active development app/server running and use the isolated E2E target when a rebuilt desktop binary is required.

```bash
npx eslint <touched TypeScript/TSX files>
npx prettier --check <touched frontend/docs files>
npx tsc --noEmit
npm test
CARGO_TARGET_DIR=target-e2e npm run test:rust
npm run build
git diff --check
```

Run the relevant E2E suites after implementing real cross-client behavior:

```bash
npm run test:e2e:build
npm run test:e2e
npm run test:e2e:sync:build
npm run test:e2e:sync
```

Do not run E2E mutations against the owner's real application profile. Use the isolation rules in `.agents/skills/testing-app/SKILL.md`.

### Known warnings and environment limitations

- Linux compilation currently reports unused variables in the Windows-only PTY priority implementation because the inner logic is removed by `#[cfg(windows)]`; fix this with platform-specific function bodies rather than hiding the parameters.
- `pressure_level` in `resources.rs` is currently test-only/duplicated relative to the runtime calculation and requires consolidation.
- Invitation constants and helpers can appear as dead code in non-test builds because the real runtime commands/routes are not connected yet.
- `graphify update .` could not be executed in the current environment because the `graphify` executable was unavailable. Run it after implementation when the tool is installed.
- A live Google OAuth login requires an official or development Google Desktop OAuth client ID. Never add a client secret to the desktop application.
- Existing Vite builds warn about mixed static/dynamic imports and large chunks; these are recorded in the Web optimization backlog and are not build failures.

### Scope control for the next agent or PC

- Do not mark P2P, relay, encryption, immutable backup, invitation delivery, tasks, or chat as available based only on types, UI, or local tests.
- Do not reuse the GitHub Gist settings-backup modal for account identity or project sharing.
- Do not send local paths, manifests, OAuth data, invitation bearer values, private keys, chat content, or task content to rendezvous infrastructure.
- Do not create or choose a recipient destination on the sender's behalf.
- Do not make a second implementation path for Web; use the same Core operations as Tauri.
- Do not solve Linux terminal compression with fixed rows, forced font shrinking, or a terminal-count limit.
- Do not suppress warnings when they indicate an unfinished platform or runtime connection.
- Do not push, tag, release, or update the pull request until authorized for that delivery point and required tests are complete.

### How to verify the handoff before changing code

```bash
git switch feat/mesh-sync-p2p-vault
git pull --ff-only
git status --short
git log --oneline -15
```

The working tree should be clean. Confirm that the latest documentation commit contains this file and that `e14b1c1` remains in its ancestry. Then begin with the Phase 1 sequence above.
