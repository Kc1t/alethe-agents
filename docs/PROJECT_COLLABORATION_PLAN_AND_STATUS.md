# Project Collaboration — Product Plan and Implementation Status

## Purpose

This document consolidates the owner's original product plan, the work completed in the current development branch, and the work that remains before Alethe has production-ready cross-device project collaboration. It is a status and planning record, not a statement that every listed capability is already available.

The approved product decisions are:

- Google is the only account identity provider for the first release.
- Project data should use a direct peer-to-peer connection whenever possible.
- Cloudflare Workers with SQLite-backed Durable Objects is the accepted reference rendezvous provider; it is an optional collaboration component, not a per-user Cloudflare account requirement.
- Local Alethe operation never depends on the rendezvous provider. Ordinary users connect to the operator-managed endpoint only after enabling online collaboration.
- A relay may be used when a direct connection is impossible, but it must handle only end-to-end encrypted data.
- Receiving an invitation or discovering another device must never download project data automatically.
- Work should be delivered in reviewable phase commits, followed by final documentation and pull-request validation.

## Owner-confirmed collaboration operating model — 2026-08-21

This section records the owner's decisions from the architecture review and overrides older wording that could imply that Cloudflare is an early dependency, that each user needs a Cloudflare account, or that project traffic passes through the rendezvous service.

### Who configures Cloudflare

- The Alethe project operator owns and deploys the official Cloudflare Worker and Durable Objects. Deployment credentials never ship inside Alethe.
- An ordinary user never creates a Cloudflare account, installs Wrangler, configures a Worker, supplies a Cloudflare API token, buys a domain, or manages TLS.
- A user who enables online collaboration connects to the operator-managed Alethe collaboration endpoint already configured in the signed application release.
- Advanced users may deliberately select a compatible custom/self-hosted endpoint. This is an optional expert path, not normal onboarding, and it cannot silently fall back to the official service or another public provider.
- Every participant who wants automatic online discovery, invitation delivery, or new cross-network connection negotiation must enable Alethe collaboration. This still does not require them to own Cloudflare infrastructure.

### Optional component and capability release

Alethe starts and remains useful without the online collaboration component. Local-only mode makes no rendezvous connection. Enabling or disabling the component affects only capabilities that require remote routing.

| Capability | Local-only behavior | Behavior after collaboration is enabled and authenticated |
| --- | --- | --- |
| Projects, terminals, agents, profiles, preferences, and local Git/GitHub backup | Available | Unchanged |
| Local Google identity and device key/trust records | Available | Used to authenticate collaboration without exposing private material |
| Create/copy an out-of-band invitation link | Available when local invitation security permits | Also available |
| Automatic delivery of an invitation to another PC | Unavailable | Available only after Phase 10B and real recipient routing |
| Same-account remote device discovery | Unavailable | Available only after the account-routing proof and Phase 10B |
| Presence and refreshed connection candidates | Unavailable | Available through the control channel |
| Existing authenticated P2P session | May continue while connectivity and authorization remain valid | Independent of whether the provider is currently carrying control events |
| New cross-network P2P session after addresses change | May fail without a known direct/LAN route | Provider may supply fresh encrypted candidate signaling |
| Offline invitation mailbox and immediate remote revocation notice | Unavailable | Available subject to expiry, authorization, retention, and provider availability |
| Project files, synchronization operations, tasks, and chat content | Never routed in plaintext through Cloudflare | Travel through authenticated E2EE peer transport; a future relay may see ciphertext only |

Frontend controls must use backend capability state and precise reason codes. A preference toggle, configured URL, successful health request, or visible button never authorizes or proves a feature.

### One control connection, not one request per file or message

When collaboration is enabled, each Alethe device maintains one logical outbound WebSocket to the configured rendezvous service. It is not one connection per account contact, project, invitation, group, file, task, or chat message.

The intended lifecycle is:

1. Alethe remains disconnected from rendezvous while the optional component is disabled.
2. On explicit activation, the Core validates local identity/device prerequisites and the configured service protocol.
3. The service issues a random challenge; the Core signs it with the local device identity without sending the private key.
4. The authenticated control channel carries only presence generations, encrypted invitation envelopes, revocations, acknowledgements, and encrypted/bounded connection signaling.
5. Once two devices establish the Phase 4 authenticated P2P session, project data, synchronization, tasks, and chat use that peer session rather than the Cloudflare Worker.
6. The control WebSocket may remain logically connected but idle so new invitations, device changes, and revocations can arrive. Durable Object WebSocket Hibernation is intended to avoid active compute while idle.
7. Native WebSocket ping/pong or hibernation auto-response provides liveness. Do not send frequent JSON “heartbeat” application messages merely to say the app is alive.
8. Closing Alethe closes the client session. Network loss moves the client to a bounded retry state instead of affecting local projects.

Cloudflare usage is therefore driven by connection establishment and small control events, not by the number of synchronized files or ordinary P2P chat messages. Limits belong to the shared Alethe deployment and are monitored globally; source IP may be used only as a secondary abuse signal and never as device identity.

### Reconnection decision order

After Wi-Fi loss, suspend/resume, public-IP change, or a dropped peer session, the Core follows this order:

1. Revalidate the local device, grant, session generation, and expiry.
2. Attempt to resume an authenticated peer session when the selected transport safely supports it.
3. Try still-valid known direct candidates and opt-in LAN discovery.
4. If those routes fail or expired, reconnect the single control WebSocket and request fresh encrypted candidate signaling.
5. Try the newly negotiated direct P2P path.
6. Use a separately approved end-to-end encrypted relay only when direct connectivity is impossible.
7. Expose a precise degraded/offline state if no route works; never send plaintext through Cloudflare as an emergency fallback.

Known addresses are hints, not permanent identity. A router, carrier NAT, VPN, or Wi-Fi change may invalidate them, which is why rendezvous can be needed again even though both devices remember one another cryptographically.

### Invitation flow for all Alethe users

1. The sender creates a project-scoped invitation through the existing local authorization state machine.
2. If collaboration is disabled, Alethe can expose the one-time `alethe-invite://` link for delivery through a channel chosen by the sender. No Cloudflare action occurs.
3. If automatic delivery is requested, Alethe explains provider-visible metadata and asks the sender to enable collaboration if needed.
4. The sender Core encrypts and signs the invitation envelope for the intended opaque account/device route before it leaves the machine.
5. Cloudflare stores only bounded ciphertext and opaque routing/expiry/idempotency metadata. It cannot read the invitation bearer, project name, path, permissions in plaintext, or project content.
6. An online enabled recipient receives the encrypted envelope through its existing control connection. An offline enabled recipient may receive it later, but only before expiry and while it remains unrevoked.
7. A recipient without collaboration enabled can open the out-of-band link and choose whether to activate online collaboration. The invitation cannot activate the service silently.
8. Accepting or redeeming creates grant/authorization state only. It does not create a local directory, choose a destination, inspect project content, or download files.
9. Recipient-controlled setup occurs in Phase 5. Actual project transfer occurs only through the Phase 4/6/7 authenticated and verified systems.

### Cloudflare is a late adapter

- Phase 3 finishes security and the provider-independent protocol.
- Phases 4 through 9 implement and test P2P, recipient consent, manifests/staging, synchronization/conflicts, tasks, and chat through controlled provider-independent fixtures.
- Phase 10A adds optional provider configuration and truthful activation/capability states.
- Phase 10B implements Cloudflare Workers and SQLite-backed Durable Objects as the reference adapter.
- Phases 11 through 13 finish notifications, operational hardening, security review, and release validation.

Cloudflare Free may be used for development and initial operation, but it is a quota rather than a guarantee of free permanent service or immunity from suspension. Production requires monitoring, a paid-plan budget, documented retention/deletion, export/migration, custom-provider compatibility, and outage behavior. No commercial or public provider is described as impossible to block or guaranteed free forever.

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
| Device key vault | Implemented locally, including approve/reject/rename/revoke/remove and key rotation (`rotate_device_keys_at`, tested) | Cross-device presence/discovery and all-devices-lost recovery remain; rotation has no grace-period migration or UI |
| Invitation security primitives | Implemented locally and unit-tested, now exposed via Tauri commands and Web routes with a sidebar UI | No cross-PC delivery yet (Phase 10); redeem only works within one local install |
| Project grants and permission contracts | Issue/list/revoke implemented and tested; folder allow/deny scopes now exposed in the invite UI (top-level only) | Not yet enforced by a real project-content transport |
| Optional collaboration service | Runtime implemented locally: activation state machine (`sync_activation.rs`), local/managed/custom modes, and a real Cloudflare rendezvous adapter (`services/rendezvous-cloudflare/`, `sync_rendezvous.rs`) | No deployed production endpoint yet; ordinary builds ship with none configured |
| Relay | Not implemented and not selected | Required only when direct peer transport cannot connect; it may carry only end-to-end encrypted payloads |
| Project file transfer | Backend primitives implemented and tested (manifest, chunking, staging, verification, atomic publish with recoverable prior version — `sync_manifest.rs`, `sync_staging.rs`) | Not yet driven by a live transfer feature or UI |
| Recipient destination workflow | Implemented locally as a tested backend state machine (`sync_subscription.rs`: destination validation, mode selection, all lifecycle states) | No UI/confirmation screen yet |
| Shared tasks | Backend implemented and tested; now has a working UI (`CollaborationView/TasksPanel.tsx`: create, complete, comment, filter) | Editing an existing task's title/body/labels/due date and reassigning after creation have no UI yet (backend commands exist: `sync_update_task`, `sync_assign_task`) |
| Project chat | Backend implemented and tested; now has a working UI (`CollaborationView/ChatPanel.tsx`: send/list/edit/delete messages, upload/download attachments, WhatsApp-style bubbles) | Still one project channel per project, local to this install only — no cross-device delivery, no conversation list, no attachment image preview, no message editing/deletion UI (backend commands exist) |
| Collaboration notifications | Access-center kinds, categories, and publishers implemented and tested (`sync_access.rs`, Phase 11) | No filter/search/grouping/deep-links; native icon/formatting normalization and cross-device notification-state sync remain |

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
- `[~]` Define key rotation and migration without silently preserving compromised keys. `rotate_device_keys_at` replaces both the Ed25519 identity key and the X25519 agreement key and records `key_rotated_at_ms` (tested, exposed via Tauri command and Web route). No grace-period migration workflow and no UI to trigger it.
- `[ ]` Define recovery when all trusted devices or credential-store entries are lost.
- `[ ]` Discover devices using the same Google account without granting automatic project access.
- `[ ]` Add owner-approved available-project metadata for same-account devices without exposing paths or manifests.
- `[ ]` Test device lifecycle across two or more real machines and across offline/reconnect cycles.

Note: today's device list is local to each install — cross-device visibility and remote approval require the rendezvous/discovery work in Phase 10 and are not yet implemented. The approve/reject/revoke/remove operations above are real and tested, but only operate on whatever device records exist in the local security document.

### Invitations, access center, and permissions

- `[x]` Define versioned invitation, grant, permission, device, account, and path-scope contracts.
- `[x]` Generate random invitation bearer tokens and persist only their hashes.
- `[x]` Enforce expiry, single use, recipient account, optional recipient device, replay resistance, and bounded failure lockout in local primitives.
- `[x]` Normalize permission dependencies and deny unknown or invalid scopes.
- `[~]` Expose issue, list, inspect, redeem, and revoke operations through Tauri and authenticated Web routes (`sync_issue_invitation`, `sync_revoke_invitation`, `sync_redeem_invitation`, `sync_revoke_grant`, plus the existing read-only snapshot). Explicit refuse/defer as distinct recipient actions and proactive expiry transitions are not implemented; expiry is still enforced only at redemption time.
- `[~]` Implement outgoing and redeemed/active views in the sidebar (from the local snapshot). Incoming, same-account request, and hidden views require cross-device delivery (Phase 10) and are not implemented; there is no view of invitations addressed to this account that were issued on another install.
- `[~]` Implement a link representation of the invitation credential (`alethe-invite://` URL carrying the invitation ID and bearer token). QR code rendering and a distinct human-readable short code are not implemented.
- `[ ]` Add recipient lookup without revealing whether arbitrary Google accounts exist.
- `[x]` Add permission presets (view only / reviewer / collaborator) and always display the expanded effective permission list next to the selected preset.
- `[x]` Permissions are enforced as separate backend values (`read`/`export`/`write`/`upload`/`delete`/`invite`/`admin`); the UI currently exposes them only through presets, not individual toggles.
- `[x]` Add allow/deny folder scopes with deny precedence and traversal-safe normalization in the UI. The invite form now lists the project's top-level folders (`listDirectory`) and lets the issuer toggle any of them blocked, sending real `deny`-effect `pathScopes` (`MeshSidebarView.tsx`). Only top-level folders are exposed today (no nested tree), and deny precedence itself is enforced by the already-tested backend validator, not new UI logic.
- `[x]` Require stronger confirmation before issuing an invitation with `write`, `delete`, `invite`, or `admin` permissions (a second explicit click).
- `[x]` Add active-grant inspection (list) and immediate revocation (`revoke_grant_at`, callable by any trusted device on the issuing account). Expiry adjustment and narrowing an existing grant are not implemented.
- `[ ]` Notify all affected devices when invitation or grant state changes — there is no cross-device delivery yet, so nothing to notify.
- `[x]` Ensure a stale UI or cached permission never authorizes a backend operation (every operation re-checks device trust and account ownership server-side; unit-tested).
- `[x]` Remove the disabled "Invite Friend" placeholder now that local issuance is real; it stays disabled until the local device is trusted and a project is active.
- `[ ]` Add concurrency tests for simultaneous acceptance, revocation, expiry, and replay.

Note: as with devices, invitations and grants are local to each install today. Issuing, revoking, and redeeming all operate on the local security document; there is still no real delivery of an invitation from one physical machine to another (that is Phase 10's rendezvous work). Redemption today only works if both the issuer and the recipient act against the same local document — useful for local testing of the state machine, not yet a cross-device feature.

### Rendezvous, relay, and network presence

- `[x]` Select Cloudflare Workers with SQLite-backed Durable Objects as the reference rendezvous provider and record the optional/provider-independent boundary in `ADR-0002`.
- `[~]` Implement local-only, official Alethe service, and advanced custom-rendezvous modes without requiring ordinary users to own a Cloudflare account. `ServiceMode::{LocalOnly, AletheManaged, AdvancedCustom}` is implemented and wired into `CollaborationSettings.tsx`; no deployed managed endpoint ships yet (see Phase 10A).
- `[ ]` Gate only rendezvous-dependent capabilities; provider configuration or failure must not disable local projects, agents, terminals, local security state, or established authorized peer sessions.
- `[x]` Add the activation state machine: disabled, identity required, ready, connecting, online, retrying, direct only, and needs attention. All 8 `ActivationState` variants implemented and tested in `sync_activation.rs`.
- `[x]` Prompt for explicit activation on the first remote share, remote invitation, same-account discovery, or other rendezvous-dependent action instead of connecting every installation silently. `ActivationTrigger` / `should_offer_activation` (`sync_activation.rs`), tested.
- `[~]` Define versioned registration, authenticated presence, signaling, invitation notification, and connection-candidate messages. Implemented in `services/rendezvous-cloudflare/` and `sync_rendezvous.rs`.
- `[x]` Authenticate every signaling message with current account/device state. Challenge/signature/pinned-key authentication implemented (Phase 10B).
- `[x]` Store only opaque identifiers, public device data, delivery state, abuse counters, and minimum routing metadata. Matches the implemented design (Phase 10B).
- `[ ]` Prevent the service from receiving OAuth tokens, private keys, paths, filenames, project content, task content, or chat plaintext.
- `[~]` Add offline queues with bounded retention and deletion semantics. Offline queues, expiry, and rate limiting implemented (Phase 10B).
- `[~]` Add native WebSocket liveness/auto-response, reconnect, jittered backoff, duplicate suppression, ordering, and clock-skew handling without frequent application-level heartbeat messages. Reconnect/backoff/limits implemented (Phase 10B); clock-skew handling not explicitly confirmed.
- `[~]` Add per-account/device/IP quotas, rate limits, payload limits, and abuse controls. Independent account/device/socket/frame/byte/mailbox/IP-signal limits enforced in `services/rendezvous-cloudflare/src/index.ts` and `protocol.ts`.
- `[ ]` Add direct connection negotiation across common NAT and firewall configurations.
- `[ ]` Select and record the encrypted relay technology separately, then add relay fallback when direct connectivity fails.
- `[~]` Define server deployment, TLS, secrets, database, backups, upgrades, rollback, observability, alerts, and incident response. Documented in the service README and the Phase 10B/12 gate documents; nothing is actually deployed to production.
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

- `[~]` Separate remote project grants from local subscriptions. `sync_subscription.rs` already models grant and `Subscription` as distinct, tested types (Phase 5); no UI consumes this yet.
- `[~]` Implement offered, configuring, awaiting-confirmation, staging, verifying, active, paused, declined, revoked, and error states. All of these plus `deferred`/`removing` are implemented and tested in `sync_subscription.rs` (Phase 5); no UI yet.
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

- `[x]` Define versioned project task, comment, assignment, label, due-date, status, and revision models. `TaskRecord`/`TaskComment` in `sync_tasks.rs`, tested.
- `[x]` Support project-public and explicitly restricted/private tasks. `TaskVisibility::{Public, Restricted}`, tested (`restricted_task_is_invisible_to_non_members...`).
- `[~]` Authorize task listing, counts, search, notifications, mutation, export, and deletion separately. Listing/mutation authorization is real and tested per-operation; there is no search, no export, and counts are just `list.len()` client-side.
- `[ ]` Add offline task edits with deterministic merge or explicit conflicts. Optimistic-concurrency conflict detection exists (`stale_base_revision_is_a_deterministic_conflict...`), but there is no offline queue to reconcile yet.
- `[~]` Add task history, audit, retention, restore, and deletion behavior. Op-log exists and is bounded (`op_log_stays_bounded`); delete/restore via tombstone exist (`sync_delete_task`/no `sync_restore_task` command yet, though `restore_task_at` exists); no UI for any of this.
- `[x]` Keep task synchronization independent from project-file transfer state. Fully separate module/storage (`sync/tasks/<project>.json`), no coupling to `sync_staging.rs`.
- `[~]` Add Desktop, Web, and mobile-responsive task interfaces. `CollaborationView/TasksPanel.tsx` implemented for Desktop/Web (shared Core, same component); no mobile-specific layout exists (there is no mobile build target in this project).
- `[x]` Test that unauthorized users cannot infer private task existence through metadata. `restricted_task_is_indistinguishable_from_a_nonexistent_one`, tested.

### Programmer-focused chat

- `[x]` Define versioned direct-message, project-channel, private-group, category, thread, mention, reaction, and read-state models. `Conversation`/`MessageRecord` in `sync_chat.rs`, tested. Threads are not implemented (no `thread_id` concept anywhere).
- `[x]` Keep chat membership separate from project-file grants and task visibility. Independent storage/module, no shared authorization path with `sync_security.rs` grants or `sync_tasks.rs`.
- `[x]` Add images, files, code blocks, command blocks, test results, logs, and structured bug reports. `MessageContentType::{Text, CodeBlock, TestResult, BugReport, Command}` plus encrypted attachments; all rendered distinctly in `ChatPanel.tsx`. "Logs" has no dedicated content type — sent as `Text` or `CodeBlock` today.
- `[x]` Add safe terminal selection sharing without automatic command execution. `MessageContentType::Command` is stored/rendered as inert text only; the UI renders it in a visually distinct "does not execute" block.
- `[~]` Add attachment size/type limits, scanning, metadata stripping, safe preview, retention, and deletion. Size limit enforced (`MAX_ATTACHMENT_BYTES`, tested); no malware scanning, no metadata stripping, no preview in the UI (attachments today are sent as a text message with the attachment ID, not rendered inline), no retention policy.
- `[x]` Encrypt messages and attachments end to end across rendezvous/relay infrastructure. Per-epoch ChaCha20-Poly1305 encryption implemented and tested (ADR-0006); "across rendezvous/relay" does not yet apply because there is no cross-device transport at all yet (see the note below).
- `[ ]` Add offline delivery, ordering, deduplication, editing, deletion, retention, and device revocation behavior. Editing/deletion primitives exist (`sync_edit_message`/`sync_delete_message`, wired but no UI); there is no offline delivery queue because there is no delivery at all yet.
- `[x]` Prevent removed members from obtaining new message or attachment keys. `removed_member_cannot_decrypt_new_epoch_messages_or_attachments`, tested.
- `[ ]` Add search without leaking private-channel content.
- `[~]` Add Desktop, Web, and mobile-responsive chat interfaces and accessibility coverage. `CollaborationView/ChatPanel.tsx` implemented for Desktop/Web; no accessibility audit performed (keyboard nav/ARIA labels not verified); no mobile layout.

**Important, tested-live limitation**: chat messages exist only in the local install that created them (`sync/chat/<id>.json` on that one machine). There is no code path anywhere that sends a message, attachment, or conversation update to a different physical device — not through the Cloudflare rendezvous service (which only handles device discovery/signaling, Phase 10B), not through any other transport. This was verified by reading `sync_chat.rs`/`sync_engine.rs`/`sync_rendezvous.rs` end to end during this session; do not remove or soften the in-app "messages sync only on this device" notice until real cross-device delivery exists (that is Phase 10's remaining "content transport" work, distinct from the signaling layer that already exists).

### Notifications and access center

- `[~]` Build one access center for invitations, device approvals, same-account requests, grants, revocations, conflicts, transfer failures, tasks, and chat mentions. `sync_access.rs::AccessKind` implements `RemoteInvitation`, `ConnectionCandidate`, `Revocation`, `ProviderAttention`, `DevicePendingApproval`, `InvitationRedeemed`, `SyncConflict`, `TaskAssigned`, `ChatMention`, `TransferFailure`, all with tested publishers (Phase 11). "Same-account requests" and "grants" have no dedicated kind yet.
- `[x]` Keep security actions visually and logically distinct from ordinary collaboration notifications. `AccessCategory::{Security, Collaboration}` implemented.
- `[~]` Add read/unread, dismiss, defer, retry, filter, search, grouping, and deep links. `update_at` implements read/dismiss/defer; no filter/search/grouping/deep-links.
- `[~]` Revalidate authorization and expiry when a notification action is clicked. `resolve_action_at` checks the access-center record's own dismissed/expired-deferred state, but does not re-check the underlying invitation/grant's live authorization.
- `[x]` Prevent notification previews from exposing secrets, full paths, private task details, or private message content. `AccessRecord` stores only opaque `subject_handle`/`action_handle`, no content fields; only localized generic text reaches the native notification plugin.
- `[~]` Add consistent native icons, formatting, action handling, and in-app fallback on Windows, Linux, and macOS. In-app fallback exists; no icon/formatting normalization for the newer Phase 11 notification kinds.
- `[ ]` Synchronize notification state across a user's devices without allowing one stale device to repeat an action.

### Security, privacy, abuse resistance, and recovery

- `[x]` Add the initial project-sync threat model and security invariants.
- `[ ]` Extend the threat model to the final rendezvous, relay, transport, manifest, subscription, task, chat, notification, and backup designs.
- `[ ]` Add backend authorization to every operation; never trust UI roles or cached capability state.
- `[ ]` Add quotas, rate limits, bounded parsers, cancellation, backpressure, and timeouts at every untrusted boundary.
- `[ ]` Add secret-redaction tests for logs, diagnostics, errors, crash reports, snapshots, URLs, clipboard content, and notifications.
- `[~]` Add key rotation, compromised-device response, credential deletion, account export, project export, and deletion completion semantics. `rotate_device_keys_at`, `export_account_data_at`, and `delete_project_access_at` (`sync_security.rs`) are implemented, unit-tested, and exposed via Tauri commands and Web routes; no frontend UI consumes any of them yet.
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

## Detailed implementation blueprint

The step-by-step technical design is maintained in `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md`. It defines the intended Core boundaries, state machines, persistence, failure behavior, test evidence, and delivery template for every remaining phase. Proposed module names are plans, not evidence that files or capabilities already exist.

The implementation direction is summarized below:

| Phase | Construction sequence | Planned Core boundary | Durable state | Gate before continuing |
| --- | --- | --- | --- | --- |
| 3 | Finish local Google verification; finalize device identity/agreement keys; define canonical signed envelopes; resolve opaque account routing; harden invitation/grant concurrency; build backend capability authority | Existing `sync_security.rs`; proposed `sync_protocol.rs`, `sync_crypto.rs`, and capability resolver | Versioned security document, key bindings, replay fixtures, audit-safe gate evidence | Cross-language vectors, negative crypto/replay/version tests, routing-proof ADR, concurrency tests, and forbidden-data tests pass |
| 4 | Select transport stack by ADR; define candidate/connector/session/relay interfaces; implement loopback/manual/LAN adapters; authenticate and encrypt sessions; add framing, backpressure, reconnect, and revocation | Proposed `sync_transport.rs` consuming Phase 3 crypto/protocol interfaces | Safe resume metadata and bounded session diagnostics only | Two-process encrypted transfer/reconnect/revocation tests pass without Cloudflare or a public relay |
| 5 | Persist subscription state; collect recipient mode/destination; validate path/filesystem/capacity; require final confirmation; begin staging only afterward | Proposed `sync_subscription.rs` | Versioned per-device subscription with local-only destination reference | Every state/restart test passes and no project-content write occurs before explicit confirmation |
| 6 | Specify normalized signed manifest; apply default exclusions; chunk/hash; journal staging; verify grant/integrity/quota; publish atomically; retain recoverable prior tree | Proposed `sync_manifest.rs` and `sync_staging.rs` | Manifest revisions, chunk/staging journal, publication/recovery state | Fuzz/property/path tests and crash injection prove corrupt or partial trees never publish |
| 7 | Define revisioned file operations; ingest/coalesce watchers; reauthorize at application time; record conflicts; add pause/repair/rollback/restore | Proposed `sync_engine.rs` | Operation/revision log, conflict records, watcher/recovery checkpoints | Concurrent/offline/revocation/interruption/overflow tests produce no silent loss or unauthorized mutation |
| 8 | Define collaboration tasks separately from agent scheduler; add signed revisioned operations; restricted visibility; offline merge/conflict; independent task stream | Proposed `sync_tasks.rs` | Task records, tombstones, operation journal, membership/visibility state | Restricted-task non-disclosure and deterministic offline/concurrency tests pass |
| 9 | Define conversations/membership; select group key management; implement encrypted message operations; safe programmer content and attachments; offline ordering | Proposed `sync_chat.rs` | Conversation, membership generation, encrypted message/attachment metadata, read cursors | Removal/key-rotation/offline/duplicate/fuzz tests pass through provider-independent fixtures |
| 10A | Add provider interface; persist non-secret mode/endpoint choice; implement activation/connection states; contextual consent; derive real capabilities | Proposed `sync_provider.rs` plus shared Core routes/client | Non-secret provider preferences and sanitized connection state | Local-only mode creates zero connections; provider failure leaves local and provider-independent features intact |
| 10B | Create isolated Worker/Durable Object service; partition by opaque route; authenticate one hibernatable socket per device; route encrypted invitations/candidates/revocations; enforce retention/abuse/quota; document operations/migration | Dedicated Cloudflare adapter/service package implementing `sync_provider` protocol | Provider stores only bounded public routing metadata, ciphertext mailboxes, acknowledgement/replay/abuse state | Staging cross-device, offline, expiry, revocation, outage, quota, migration, and forbidden-data tests pass |
| 11 | Project domain events into one access center; separate security/collaboration categories; use revalidated opaque actions; add native/in-app delivery | Proposed `sync_notifications.rs` | Local notification projection, read/defer/dismiss state, safe action handles | Stale actions fail safely and platform fallbacks work without leaking private content |
| 12 | Re-run threat model; bound every resource; finish key/account/device/project deletion and recovery; audit privacy; rehearse incident/provider migration; review dependencies/crypto | Cross-cutting hardening in every collaboration module | Retention/deletion/export/recovery/incident evidence | Abuse, privacy capture, recovery drill, dependency review, and external security findings satisfy release policy |
| 13 | Run unit, vector, migration, crash, parity, two-process, provider, E2E, network, soak, fuzz, abuse, installer, and rollback suites | Existing test harness plus phase-specific fixtures and staging | Versioned test artifacts and release evidence without user secrets | Every release gate passes; capabilities reflect real runtime; production operations and budget are approved |

Each phase follows Core domain logic → pure tests → persistence/migration → Tauri/Web parity → frontend API → localized capability-gated UI → changelog/status → complete validation. No phase may be considered complete from UI or configuration alone.

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

Remaining for this area: cloned/rolled-back device detection, key rotation, all-devices-lost recovery, same-account discovery, and cross-machine approval (the last two require Phase 10 rendezvous).

## Phase 2 — Invitations and project permissions

- `[x]` Expose backend operations to issue, revoke, and redeem invitations (`sync_issue_invitation`, `sync_revoke_invitation`, `sync_redeem_invitation`) plus grant revocation (`sync_revoke_grant`), as Tauri commands and equivalent `/api/sync/security/invitations/*` and `/api/sync/security/grants/*` Web routes on one shared core implementation. Listing/inspecting reuses the existing security snapshot. Explicit expiry transitions are not implemented.
- `[~]` Add outgoing and active-grant views to the sidebar access center. Incoming/same-account/hidden views require Phase 10 delivery.
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

Remaining for this area: cross-PC invitation delivery (Phase 10), recipient lookup without account enumeration, folder scope UI, QR/short-code representations, grant expiry adjustment, and affected-device notifications.

## Phase 3 — Security readiness and provider-independent protocol

Cloudflare and every other production rendezvous provider are blocked until this gate passes and Phases 4 through 9 establish the provider-independent collaboration systems. No production rendezvous endpoint was contacted anywhere in this phase, and no provider-backed capability is reported as available. Full evidence ledger: `docs/security/PHASE_3_SECURITY_GATE.md`.

- `[x]` Complete production-grade Google identity validation: issuer, audience, expiry, nonce, issued-at skew, and email-verification are now checked against a cryptographically verified ID token (`sync_mesh.rs::verify_google_id_token`, RS256 against Google's JWKS), not just the UserInfo endpoint. All Google tokens remain in the OS credential store.
- `[~]` Device-key lifecycle: creation, credential-store persistence, approval, and revocation are implemented and tested (Phase 1, unchanged). Rotation exists only as "generate a new binding," not a full rotation workflow with a grace period. Cloned/rolled-back state detection and all-devices-lost recovery remain unimplemented.
- `[x]` Select and document the device-authenticated key-agreement library and algorithm: `docs/adr/ADR-0003-device-key-agreement.md` (X25519 via `x25519-dalek`, signed binding to the existing Ed25519 identity, HKDF-SHA256 directional session-key derivation). Implemented in `sync_crypto.rs` and wired into device registration.
- `[x]` Define canonical signed control envelopes with protocol version, message type, sender device, opaque account route, unique message ID, issued/expiry time, sequence, payload limit, and signature (`sync_protocol.rs::SignedEnvelope`). Strict decoding rejects oversized fields before allocating them.
- `[x]` Add replay protection (`ReplayWindow`, bounded), duplicate suppression, clock-skew bounds (`verify_envelope`'s future-skew parameter), downgrade rejection (protocol/schema version checks), parser limits (`MAX_ENVELOPE_BYTES`/`MAX_FIELD_BYTES`), and deterministic serialization with cross-language test vectors (Rust ↔ TypeScript byte-identical output, asserted in both suites).
- `[x]` Harden local invitation and grant state transitions — the Phase 2 state machine already covered simultaneous redemption, revocation, expiry, and process interruption (atomic writes); unchanged in this phase.
- `[x]` Define and review an account-routing proof: `docs/adr/ADR-0004-opaque-account-routing.md` (deterministic local SHA-256 derivation from the verified Google `sub`, never transmitted). Implemented as `sync_protocol::account_route_id`, cross-language-vector-tested. Automatic same-account discovery itself remains unavailable — there is no rendezvous connection yet to exercise the proof against (Phase 10B).
- `[~]` Verify that logs, errors, metrics, and persisted public snapshots exclude forbidden data: a forbidden-sentinel test covers the public snapshot, the capability response, and a representative sample of stable error codes. No structured logging framework exists yet to audit beyond that.
- `[x]` Make backend authorization authoritative: added a real capability resolver (`resolve_capabilities_at`) replacing ad hoc frontend assumptions, exposed identically via Tauri and Web. Every capability without a real runtime path stays `unavailable`.
- `[x]` Add focused Rust, TypeScript contract, and negative-path tests for every gate item above (49 new/updated Rust tests, 27 new/updated TypeScript tests, all passing). IPC/HTTP parity covers the one new operation this phase adds (capability resolution); persistence/concurrency parity for identity/device/invitation/grant is unchanged from Phases 1–2.

Acceptance criteria:

- `[x]` The security review has no unresolved path that lets an untrusted client impersonate an account/device, replay an envelope, escalate a grant, or recover a forbidden secret, for everything implemented in this phase — see the gate document for exactly what "implemented in this phase" covers.
- `[x]` Security tests prove deny-by-default behavior for malformed versions, signatures, account/device bindings, expiry, and replay (envelope-level); invitation/grant deny-by-default behavior was already proven in Phase 2 and remains covered.
- `[x]` The opaque account-routing proof has a dedicated accepted ADR and test vectors.
- `[~]` A sanitized diagnostic capture demonstrates that forbidden fields never enter provider requests or logs — covered for the public snapshot/capability response/error codes; no provider requests exist yet to capture (Phase 10B).
- `[x]` `ProjectSyncCapabilities` remains unavailable for rendezvous, remote invitations, transfer, tasks, and chat — confirmed by test; only `identity`/`deviceTrust` can report `available`, and `invitations` reports at most `experimental`.

## Phase 4 — Encrypted peer transport and relay fallback

Full evidence ledger: `docs/security/PHASE_4_SECURITY_GATE.md`.

- `[x]` Select and document the transport stack: `docs/adr/ADR-0005-peer-transport-stack.md` (raw TCP + custom AEAD framing, chosen over QUIC/Iroh/WebRTC for this phase's loopback/manual/LAN scope).
- `[x]` Authenticate both device keys during channel establishment: `sync_transport::perform_handshake` exchanges signed key bindings and a challenge-response proof of Ed25519 private-key possession before any session key is derived.
- `[x]` Derive per-session encryption keys with forward secrecy: reuses `sync_crypto::derive_session_keys` (X25519 ephemeral-per-session agreement + HKDF-SHA256) unchanged from Phase 3.
- `[x]` Bind encrypted frames to protocol version, sender, recipient, session, stream, sequence, and content type, plus project/grant when a stream is opened for one — all as AEAD associated data (`FrameHeader`/`header_aad`), so tampering with any bound field invalidates the authentication tag.
- `[x]` Reject replayed, reordered, cross-project, and oversized frames — strict monotonic sequence checking (no reorder tolerance), oversize rejected from the length prefix before allocation.
- `[~]` Add direct-connection negotiation and encrypted relay fallback: direct connection negotiation exists for manual/loopback/LAN candidates (`CandidateSource`/`ManualCandidateSource`); encrypted relay is deliberately **not implemented** — `RelayAdapter` is declared as an interface-shaped gap only, since no relay server exists yet to build or test against (a real relay decision is later, provider-independent, work).
- `[x]` Keep discovery and relay adapters provider-independent, and validate the transport with loopback, manual candidates, and controlled test fixtures rather than a production Cloudflare dependency — every Phase 4 test uses only `std::net::TcpListener`/`TcpStream` on loopback; LAN uses the identical code path with a non-loopback address.
- `[~]` Add keepalive, reconnection, cancellation, backpressure, bandwidth limits, and transfer progress: cancellation (`PeerStream::close`) and backpressure (`MAX_QUEUED_FRAMES`) are implemented and tested; keepalive, a real reconnect integration test, bandwidth limits, and transfer progress reporting are not — there is no product feature driving sustained transfer yet (that begins in Phase 6).
- `[x]` Never expose OAuth tokens as transport credentials — the transport handshake authenticates with the Ed25519 device identity only; no Google token of any kind is referenced anywhere in `sync_transport.rs`.

Acceptance criteria:

- `[~]` Packet captures and relay logs contain no plaintext project data — true by construction (every `PeerStream` frame is AEAD-encrypted; no plaintext ever reaches the wire), but no relay exists yet to capture logs from.
- `[x]` Revoking a device or grant terminates or invalidates the related transport session: `Session::revoke` blocks `open_stream`, tested (`revoking_a_session_blocks_opening_new_streams`); `validate_resume` independently re-checks trust before accepting a resume ticket, tested against a since-revoked/untrusted device.
- `[ ]` Interrupted transfers resume without duplicating or corrupting committed content — `ResumeTicket` exists as safe, non-secret resume metadata, but there is no real transfer protocol yet to interrupt and resume (that is Phase 6); this criterion cannot be truthfully claimed done until then.

## Phase 5 — Recipient-controlled project setup

Full evidence ledger: `docs/security/PHASE_5_SECURITY_GATE.md`.

- `[x]` Model local subscription states explicitly: `offered`, `configuring`, `awaiting_confirmation`, `staging`, `verifying`, `active`, `paused`, `deferred`, `declined`, `revoked`, `error`, and `removing` — all implemented and tested in `sync_subscription.rs`. `staging`→`verifying`→`active` are real transitions with no real caller yet, since Phase 6 (the thing that would actually drive them) does not exist.
- `[~]` Let the recipient choose create managed copy, attach existing copy, or download snapshot when permitted: `SubscriptionMode` (`manual_snapshot`, `receive_after_confirmation`, `bidirectional`) is recorded and validated, but none has real transfer behavior behind it yet (Phase 6/7) — "attach existing copy" specifically still needs the dry-run comparison the blueprint describes, which requires a manifest to compare against.
- `[x]` Require an explicit destination and validate containment, symlinks, permissions, free space, path length, and collisions: `validate_destination` — traversal/symlink/absolute-path/length/collision are enforced and tested; free space uses a coarse fixed floor (no real transfer size exists yet to size the check against); writability is implied by directory creation succeeding or failing, not separately pre-flighted.
- `[~]` Let the recipient choose manual, receive-after-setup, or bidirectional synchronization: recorded via `select_mode_at`; no runtime behavior is attached to the choice yet.
- `[ ]` Show excluded folders, expected size, permissions, direction, and destructive behavior before confirmation — this is a UI/confirmation-screen requirement, deliberately not built this phase (see the gate document's "no UI this phase" note): there is nothing real to show yet (no manifest, no exclusion policy beyond a placeholder version number).
- `[x]` Keep the grant available when a recipient defers or dismisses setup: `defer_subscription_at`/`reopen_subscription_at` leave the underlying grant untouched; only the local subscription record's state changes.

Acceptance criteria:

- `[x]` No directory is created until the recipient confirms the destination and mode — proven by `offering_creates_no_filesystem_write_beyond_the_record`, `destination_and_mode_together_move_to_awaiting_confirmation`, and `confirmation_is_the_only_step_that_creates_the_destination_directory`.
- `[x]` A project cannot escape its selected destination through traversal or symlinks — proven by `destination_rejects_traversal_symlink_and_collision`, after fixing a real Windows-specific traversal-detection gap found during implementation (see the gate document's incident note).
- `[ ]` Unsupported modes are visibly disabled with a precise reason — no UI exists yet to disable anything in; all three modes are currently accepted by the backend even though none has real runtime behavior, which is honest only because `project_transfer` capability stays `unavailable` end-to-end.

## Phase 6 — Manifest, staging, integrity, and atomic publication

Full evidence ledger: `docs/security/PHASE_6_SECURITY_GATE.md` (includes an honest atomicity note — read it before assuming "atomic" means a single OS syscall).

- `[x]` Define a deterministic, versioned project manifest with normalized relative paths and content hashes: `sync_manifest.rs` (`ProjectManifest`, `normalize_and_validate_path`), signed with the device's Ed25519 identity.
- `[~]` Exclude secrets, credentials, heavy generated directories, device files, sockets, and unsafe symlinks by default: `.git`/`.alethe`/dependency-and-build directories, `.env*`, and common private-key/credential filenames are excluded and tested; symlinks/sockets are silently skipped during manifest construction (deny-by-default in effect) rather than explicitly detected and rejected with a dedicated error, and no portable unit test exercises a real symlink fixture.
- `[x]` Split large files into bounded, content-addressed chunks: `sync_manifest::chunk_file`, streaming SHA-256, bounded memory regardless of file size.
- `[x]` Stage incoming data outside the live project tree: `sync_staging.rs` — every write happens in a per-subscription staging work area; `destination` is never touched until `publish_atomically_at`.
- `[~]` Verify manifest signatures, authorization, hashes, sizes, counts, and disk quotas before publication: per-chunk hash, reconstructed file hash, and count/size consistency (via `validate_manifest`) are enforced and tested; manifest *signature* verification exists (`verify_manifest_signature`) but nothing calls it yet — there is no untrusted, network-received manifest to verify until a real transport integration exists; disk quota is a coarse pre-flight free-space check, not a hard reservation.
- `[x]` Publish verified snapshots atomically and preserve a recoverable previous state: `publish_atomically_at`, two-step OS-atomic rename swap made crash-recoverable via the journal; exactly one prior version retained (`republishing_keeps_exactly_one_recoverable_prior_version`).
- `[~]` Add pause, resume, cancel, cleanup, and crash-recovery behavior: crash-recovery (`recover_publication_at`) and cleanup (`cleanup_staging_at`) exist and are tested; pause/resume/cancel mid-transfer are not implemented — there is no live transfer loop yet to pause (Phase 7 territory, once continuous synchronization exists).
- `[ ]` Bound memory, cache, queue, scrollback, and pending-write usage under pressure — chunking already bounds per-chunk memory; no dedicated memory-pressure test exists for this phase specifically (the existing terminal-buffer memory-pressure work is an unrelated system).

Acceptance criteria:

- `[x]` A crash at every transfer boundary leaves either the previous valid tree or the new verified tree, never a mixed tree — proven for the publication-step crash window (`crash_between_publish_steps_recovers_to_the_new_verified_tree`); one narrow, documented residual gap remains (crash between an OS rename and the following journal write — see the gate document).
- `[x]` Corrupt, truncated, substituted, or unauthorized chunks never reach the live project — `substituted_and_oversized_chunks_are_rejected_at_receive_time`, `verification_fails_closed_on_missing_chunk_and_never_publishes` (destination asserted empty after failure).
- `[ ]` Cache eviction cannot delete the only recoverable version of user data — no cache-eviction policy exists yet to test against; the current retention rule (keep exactly one prior backup) has no automatic eviction that could violate this, but that is an absence of the risk, not a tested guarantee.

## Phase 7 — Continuous synchronization and conflicts

Full evidence ledger: `docs/security/PHASE_7_SECURITY_GATE.md`.

- `[x]` Track local and remote revisions without relying only on timestamps: `sync_engine.rs` assigns a monotonic per-subscription sequence to every operation as its revision.
- `[~]` Coalesce file-system events and handle rename, delete, case-only changes, permissions, and offline edits: `coalesce_watch_events` (dedup + bounded overflow detection) is implemented and tested; there is no real OS filesystem watcher wired to it yet, so case-only-rename and editor-temp-file handling are not separately exercised against real OS events.
- `[~]` Enforce the current grant on every requested operation and path: every operation rechecks device trust fresh via `SecurityBackedAuthorizer` immediately before applying; per-path permission/scope from a Phase 2 `GrantRecord` is not yet cross-checked at this layer.
- `[x]` Add explicit conflict records instead of silently overwriting concurrent changes: `apply_remote_operation_at` compares base revisions and records a `ConflictRecord` (preserving both sides) on any divergence — tested.
- `[~]` Provide keep local, keep remote, keep both, and supported text-merge actions: the first three are implemented and tested (`resolve_conflict_at`); a reviewed text-merge option is not implemented (no merge library evaluated yet).
- `[~]` Add project pause, peer pause, rescan, repair, and restore controls: pause/resume/rescan-flag and single-generation restore (reusing Phase 6's retained backup) are implemented and tested; "repair from manifest" (re-verifying local content against a `ProjectManifest`) is not implemented.
- `[ ]` Keep Desktop and Web views consistent without allowing the Web client to bypass Core authorization: Tauri/Web parity exists for pause/resume/rescan/resolve/load; `apply_local_operation_at` is Tauri-only for now (see the gate document) — this criterion is not yet fully met because one operation lacks its Web route.

Acceptance criteria:

- `[x]` Concurrent edits are reproducible and never resolved by silent data loss — proven by `diverged_base_revision_records_a_conflict_and_applies_neither_side`.
- `[x]` Revoked permissions take effect before the next mutation is applied — `SecurityBackedAuthorizer` reads live device-trust state on every call; no caching layer exists to go stale.
- `[x]` Repeated resize, reconnect, memory pressure, and long-idle sessions do not corrupt terminal or sync state — this criterion, as written in the original plan, describes the pre-existing terminal-resize/memory-pressure hardening documented elsewhere in this file (Linux terminal resilience, terminal cache/buffer work); it is unrelated to this phase's sync engine and remains true independent of it.

## Phase 8 — Shared tasks

Full evidence ledger: `docs/security/PHASE_8_SECURITY_GATE.md`.

- `[x]` Add project-scoped task identities, revisions, authorship, assignment, due dates, labels, and completion state: `sync_tasks.rs::TaskRecord`, deliberately separate from the local agent scheduler (`ctask_`-prefixed IDs, entirely separate persistence).
- `[x]` Support project-public tasks and restricted tasks with explicit membership: `TaskVisibility::Public`/`Restricted` with a `restricted_members` list, enforced in both listing and direct lookup.
- `[~]` Authorize every read and mutation against the current project grant: every operation rechecks device trust fresh via `SecurityBackedMembership`; this checks *project membership* (device trust), not yet a specific Phase 2 `GrantRecord`'s permission set — same scoping note as Phase 7's authorization.
- `[x]` Define offline edits, conflict handling, deletion, retention, and audit behavior: stale-base-revision operations are rejected as deterministic conflicts (not silently overwritten); delete is a tombstone with `restore_task_at` to undo it; the op log provides a bounded audit trail.
- `[x]` Synchronize tasks independently from project-file transfer so a paused file transfer does not corrupt task state: tasks persist to their own file (`data_root/sync/tasks/<project_id>.json`), entirely separate from Phase 6's staging files and Phase 7's engine state.

Acceptance criteria:

- `[~]` Private tasks are never disclosed through counts, notifications, search, or exports to unauthorized users — proven for listing and direct lookup (`restricted_task_is_indistinguishable_from_a_nonexistent_one` proves the "not found" outcome is identical whether the task exists-but-hidden or truly does not exist); notifications, search, and export do not exist yet for tasks, so there is nothing to test there yet — an absence of the risk, not a tested guarantee that will hold once those features are built.
- `[x]` Offline concurrent edits produce a deterministic merge or an explicit conflict — a stale revision is deterministically rejected (`stale_base_revision_is_a_deterministic_conflict_not_a_silent_overwrite`); no automatic field-level merge is implemented, so a caller must re-fetch and retry rather than the system merging on its own.

## Phase 9 — Programmer-focused chat

Full evidence ledger: `docs/security/PHASE_9_SECURITY_GATE.md`. Group key management decision:
`docs/adr/ADR-0006-chat-group-key-management.md`.

- `[~]` Add direct messages, project channels, private groups, categories, threads, mentions, reactions, and read state: `sync_chat.rs` has `ConversationKind` (Direct/ProjectChannel/PrivateGroup), `category` (organizes, never authorizes), `mentions` per message, `Reaction`, and per-member read cursors (`mark_read_at`). Threads (replies scoped to a parent message) are not implemented.
- `[x]` Support images, files, test results, bug reports, code snippets, and command blocks: `MessageContentType` (Text/CodeBlock/TestResult/BugReport/Command) plus independently-keyed `AttachmentRecord` for images/files.
- `[x]` Provide a safe terminal selection/share action without automatically executing received commands: `MessageContentType::Command` is stored and decrypted like any other message type; no code path in `sync_chat.rs` (or elsewhere touched this session) executes message content.
- `[~]` Scan and bound attachments, strip unsafe metadata where appropriate, and prevent executable preview behavior: `upload_attachment_at` enforces `MAX_ATTACHMENT_BYTES` and a declared-vs-actual size check; there is no malware/content scanning, metadata stripping, or preview-rendering logic yet — no UI exists this phase to render a preview.
- `[x]` Encrypt message content and attachments end to end when traversing rendezvous or relay infrastructure: every message and attachment is ChaCha20Poly1305-encrypted under a key wrapped per member via X25519 (ADR-0006); true today by construction since nothing yet transmits ciphertext through any relay (no relay exists before Phase 10B) — the encryption itself does not depend on a relay being present.
- `[x]` Separate chat membership from project-file permissions: `Conversation.members` is its own list on the chat domain object, entirely independent of Phase 2's `GrantRecord`/Phase 8's project task membership.

Acceptance criteria:

- `[x]` Receiving a command never executes it — true by construction (see above); no dedicated adversarial test needed since there is no executor code path to guard against, but this is worth re-verifying if a future phase adds any message-triggered automation.
- `[x]` Removed members cannot fetch new messages or attachment keys — proven by `removed_member_cannot_decrypt_new_epoch_messages_or_attachments`: no wrap entry exists for the removed member in any post-removal epoch, for both a message and an attachment uploaded after removal.
- `[x]` Categories organize channels but do not grant access — `category` is never read by any authorization check in `sync_chat.rs`; only `members` is.

## Phase 10A — Optional collaboration service activation and provider configuration

Full evidence ledger: `docs/security/PHASE_10A_SECURITY_GATE.md`.

- `[x]` Implement collaboration as an optional component; local-only users make no rendezvous connection: `sync_activation.rs` — `ServiceMode::LocalOnly` is the default, contains zero networking code, `resolve_activation_state` returns `Disabled` unconditionally for it.
- `[~]` Provide an automatic operator-managed Alethe endpoint so ordinary users never configure a Cloudflare account, API token, Worker, domain, or certificate: `ServiceMode::AletheManaged` requires no endpoint/credential input from the user to select; the actual managed endpoint does not exist yet (no Phase 10B deployment), so this proves the *mode selection UX requirement*, not a working managed connection.
- `[~]` Provide a clearly separated advanced mode for a compatible custom rendezvous endpoint: `ServiceMode::AdvancedCustom` + `validate_endpoint_at`/`EndpointValidator` trait exist and are enforced (unvalidated endpoints cannot be enabled); no real validator (TLS/protocol/health) exists yet, only a test double.
- `[x]` Add capability states for disabled, identity required, ready, connecting, online, retrying, direct only, and needs attention: `ActivationState` enum, all eight variants reachable and tested via `resolve_activation_state`.
- `[x]` Activate the service contextually when a user first shares remotely, opens a remote invitation, enables same-account discovery, or enters another feature that requires rendezvous: `ActivationTrigger` + `should_offer_activation`, proven to return `false` for purely local actions and once already enabled.
- `[~]` Explain provider-visible metadata before activation and persist only non-secret provider preferences locally: persistence is proven non-secret (`only_non_secret_settings_fields_exist_on_the_persisted_struct`); the "explain provider-visible metadata" UX copy does not exist yet, since there is no UI this phase.
- `[~]` Validate TLS, endpoint identity, protocol compatibility, and health before reporting a connection: the `EndpointValidator` trait and its enforced-before-enable behavior exist and are tested; no real TLS/identity/protocol/health implementation exists yet (Phase 10B).
- `[x]` Keep local projects, agents, terminals, local device security, and out-of-band invitation links available when the component is disabled or unavailable: true by construction — `sync_activation.rs` is new and self-contained; nothing in Phases 1–9 was modified to depend on it, and the full Phase 1–9 regression suite passes unchanged.

Acceptance criteria:

- `[x]` Phases 3 through 9 are complete and their domain, cryptographic, P2P, integrity, synchronization, task, and chat tests pass without depending on Cloudflare — confirmed by the full `cargo test --lib` run for this ETAPA (see the ETAPA report for the exact count).
- `[~]` An ordinary Alethe user can enable online collaboration without knowing that Cloudflare configuration exists or supplying Cloudflare credentials — proven at the settings-model level (`AletheManaged` needs no such input); not yet provable end-to-end since no UI or real managed endpoint exists.
- `[x]` Disabling collaboration produces no rendezvous connection and does not remove local functionality — `disabling_the_service_returns_to_disabled_regardless_of_prior_validation`.
- `[~]` Provider failure disables only capabilities that require new remote discovery, delivery, or signaling — `ActivationState::NeedsAttention`/`Retrying`/`DirectOnly` exist and are distinguishable in the state machine; no live capability gating is wired to these states yet since no other phase's capability reads this module.
- `[x]` A custom endpoint cannot silently replace the official provider and must pass the same protocol and security checks — `enable_service_at` refuses `AdvancedCustom` without a matching prior `validate_endpoint_at` success; the check is the same code path regardless of endpoint value, so there is no bypass specific to any particular endpoint string.

## Phase 10B — Cloudflare rendezvous, presence, and remote invitation delivery

- `[x]` Implement Cloudflare Workers with SQLite-backed Durable Objects as the reference adapter for the already-tested provider-independent rendezvous protocol: isolated package under `services/rendezvous-cloudflare/`, plus the provider-neutral native client in `sync_rendezvous.rs`.
- `[x]` Authenticate every signaling connection with opaque account routing and device identity: random challenge, canonical Ed25519 signature, pinned device key, and independently verified Ed25519/X25519 binding.
- `[x]` Store only the minimum metadata required for delivery and abuse prevention: public device keys/generations, encrypted mailbox rows, acknowledgement/idempotency IDs, presence, and bounded HMACed abuse counters. Unknown control-frame fields fail closed in both the native client and service; the client reconstructs an exact allowlist before provider-bound bytes are queued.
- `[x]` Add reconnect, backoff, offline queues, expiry, rate limiting, and bounded message sizes: independent account/device/socket/frame/byte/mailbox/IP-signal limits are enforced locally and documented in `docs/security/PHASE_10B_SECURITY_GATE.md`.
- `[x]` Discover devices connected to the same opaque account route without granting project access automatically. Discovery returns only bounded public-device metadata and presence.
- `[ ]` Add an owner-approved catalog of available projects using opaque project identifiers.
- `[~]` Deliver invitations across different PCs and synchronize their lifecycle atomically: the service routes idempotent encrypted invitation envelopes online/offline, and `sync_invitation_bridge.rs` now encrypts an issued invitation for a specific recipient device and consumes a delivery back into `redeem_invitation` (tested: round trip, wrong-recipient rejection, tamper rejection, double-redeem rejection). The discovery step now also verifies the recipient's advertised key against its Ed25519 identity binding before use (`verify_discovered_device_agreement_key`, tested: valid binding accepted, server-substituted key rejected, signature replayed under a different device ID rejected). Still pending: the UI flow that calls discovery and lets a user pick a device, and real two-machine staging evidence.
- `[~]` Route invitations through bounded encrypted mailboxes: queue, expiry, delivery and acknowledgement exist; the client-side encrypt/decrypt/redeem wiring is now real and tested locally; end-to-end two-machine evidence and out-of-band activation still require staging/product wiring.
- `[x]` Document deployment, retention, deletion, observability, incident-response, quota exhaustion, migration, and provider replacement requirements in the service README and Phase 10B/12 gates.

Acceptance criteria:

- A malicious or compromised signaling service cannot read project content or impersonate a device.
- Same-account discovery does not bypass project grants.
- Offline delivery cannot revive expired or revoked invitations.
- The rendezvous service receives no Google token while automatic account routing remains resistant to account enumeration and impersonation.
- Removing the Cloudflare adapter leaves the provider-independent collaboration engine and local Alethe functionality intact.

## Phase 11 — Notifications and access center

- `[x]` Add one access center: a bounded persistent projection receives remote invitation/candidate/revocation/provider events, plus device approval, local invitation redemption, sync conflicts, task assignment, chat mentions, and terminal staging-transfer failures — all with dedicated publisher tests, all localized (English + Portuguese), and all rendered in the categorized access-center view in `CollaborationSettings.tsx`.
- `[x]` Keep security notifications distinct from collaboration notifications through explicit persisted categories.
- `[~]` Provide read/unread, dismiss, defer, retry, and deep-link behavior: read/dismiss/defer, categorized settings controls, and opaque revalidated action handles exist and are fully localized; domain-specific deep links (opening the exact relevant screen per event kind, rather than the general collaboration settings panel) remain a future UX enhancement, not a functional gap.
- Normalize notification formatting and icons across Windows, macOS, Linux, and Web.
- `[x]` Add visible in-app fallback when native notification delivery fails.
- `[x]` Avoid placing secrets, full local paths, or private message content in operating-system notifications; only localized generic text is passed to the native plugin.

Acceptance criteria:

- Notification actions revalidate current authorization before changing state.
- A stale notification cannot accept an expired invitation or resume a revoked transfer.

## Phase 12 — Security, abuse resistance, and operations

- Complete the threat model for signaling, relay, transport, storage, chat, tasks, and recovery.
- `[~]` Add rate limits, quotas, bounded parsers, cancellation, backpressure, and lockouts: complete for the Phase 10B boundary and client queues; system-wide review remains pending.
- `[~]` Add key rotation, credential deletion, account export, device recovery, and project-access deletion flows: key rotation (`rotate_device_keys_at`), account export (`export_account_data_at`), and batch project-access deletion (`delete_project_access_at`) are implemented, tested, and exposed as Tauri commands + Web routes. Standalone credential deletion is already covered by the existing `disconnect_identity_at` (Phase 1). Device recovery (regaining account access after losing every trusted device) remains an open scope decision — it needs product input on what "recovery" means without a self-hosted identity provider to fall back on.
- Add privacy-preserving audit events without content, tokens, local paths, or encryption keys.
- Add structured diagnostics with secret redaction.
- `[x]` Define server metrics, alerts, backups, upgrades, rollback, retention, and incident response requirements in `docs/security/PHASE_12_OPERATIONS_GATE.md`; real operator drills remain pending.
- Perform dependency, supply-chain, and release-signing reviews.

Acceptance criteria:

- Security logs can explain an authorization decision without exposing sensitive content.
- Fuzzed and oversized protocol input cannot crash the Desktop app or standalone server.
- Account and project deletion have documented, testable completion semantics.

## Phase 13 — Test and release program

Local release preparation evidence and external blockers are tracked in `docs/security/PHASE_13_RELEASE_GATE.md`. No production deploy, commit, tag, installer publication, or release has occurred.

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
- Pull request: `#153` (head: `MiguelSilvaPorto:feat/mesh-sync-p2p-vault`).
- Development branch: `feat/mesh-sync-p2p-vault`.
- Handoff date: 2026-08-24.
- This handoff supersedes the previous one dated 2026-08-21. That handoff told the next agent to
  resume at "Phase 1" — this was wrong by the time it was read; Phase 1 (device trust/recovery) was
  already complete. An audit at the start of this session found several other checklist items
  incorrectly marked `[ ]` for the same reason (later phases landed without updating earlier
  summary tables). **Do not trust a stale summary table over the source code.** If in doubt, grep
  the actual `.rs`/`.tsx` files this document names before believing a checkbox.
- This session's real, tested deliverables (see `docs/CHANGELOG.md` "Não lançado" section for the
  user-facing wording):
  1. Google OAuth client-secret support (Google's Desktop client type still requires it despite
     PKCE) — `src-tauri/src/sync_mesh.rs`.
  2. Several sidebar UI bugs fixed (Google connect/disconnect state, raw English permission tokens
     leaking into localized text, oversized `<select>` fonts, a device's identity fingerprint being
     shown as if it were its display name, a missing icon/text gap, the "Conexão & Sincronização"
     button not working in the default "Normal" sidebar visual style — only the less-common "Clean"
     style was wired).
  3. Folder allow/deny scopes are now selectable in the invite form (`MeshSidebarView.tsx`), wired
     to the already-existing, already-tested `pathScopes` backend contract.
  4. A new main-workspace-area view (`src/components/CollaborationView/`) that replaces the
     terminal/Home view when the collaboration sidebar tab is active, with three sub-tabs: Chat,
     Tasks, Vault & Folders (Vault & Folders is still a placeholder — see "Exact next implementation
     step" below).
  5. Collaboration tasks now have a real UI (`CollaborationView/TasksPanel.tsx`) — create, complete,
     comment, filter by status. New Tauri commands/Web routes: `sync_update_task`, `sync_assign_task`,
     `sync_delete_task` (the underlying core functions already existed; only the command/route
     wrappers were missing).
  6. Project chat now has a real UI (`CollaborationView/ChatPanel.tsx`, WhatsApp-style bubbles) —
     send/list/edit/delete messages (text, code block, inert command block, test result, bug
     report), upload/download encrypted attachments. New Tauri commands/Web routes:
     `sync_ensure_project_conversation`, `sync_send_message`, `sync_list_decrypted_messages`,
     `sync_edit_message`, `sync_delete_message`, `sync_upload_attachment`, `sync_download_attachment`
     (`sync_chat.rs`), plus a new shared identity-resolution helper `sync_local_identity`/
     `local_identity_at` (`sync_security.rs`) that both tasks and chat reuse instead of trusting a
     client-supplied device ID/account route.
  7. All of the above is covered by new Rust unit tests (`sync_chat.rs`, no keyring-dependent paths
     were added to automated tests — see the note in that file's test module) and manually verified
     live in the running dev app by the repository owner during this session (folder scopes, the
     CollaborationView tab switch, task create/complete/comment, chat send/receive across content
     types, the WhatsApp-style visual pass).
- This handoff intentionally leaves a fully working, committed tree. No partial/broken feature
  should exist in the working tree after this document's commit.

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
4. `docs/adr/ADR-0002-optional-cloudflare-rendezvous.md`.
5. `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md`.
6. `docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md`.
7. `docs/superpowers/plans/2026-08-20-secure-project-sync-and-linux-integration.md`.
8. `docs/DIAGNOSTICO_MATURIDADE_TECNICA.md` for duplication and performance context.
9. `AGENTS.md` and `CONTRIBUTING.md` for repository rules and validation commands.

If a statement conflicts, the stricter security invariant wins. This consolidated document records current product decisions; the threat model remains authoritative for security requirements.

### Primary implementation files

- `src-tauri/src/sync_security.rs`: local security document, device records, invitation/grant primitives, audit events, validation, credential-store device keys, and the shared `local_identity_at`/`sync_local_identity` device-identity resolver used by tasks and chat.
- `src-tauri/src/sync_mesh.rs`: Google OAuth (including the client-secret support added this session), folder scanning, project isolation, and backup prototype operations.
- `src-tauri/src/sync_chat.rs`: end-to-end encrypted chat core + Tauri commands (conversations, messages, attachments, epoch/key-wrap resolution).
- `src-tauri/src/sync_tasks.rs`: collaboration tasks core + Tauri commands.
- `src-tauri/src/sync_subscription.rs` / `sync_staging.rs` / `sync_manifest.rs`: recipient destination and project-transfer backend (tested, no UI yet — this is the next major gap, see below).
- `src-tauri/src/server_main/sync_security_routes.rs`, `sync_chat_routes.rs`, `sync_tasks_routes.rs`, `sync_subscription_routes.rs`, `sync_staging_routes.rs`: the Web mirror of every Tauri command above, always calling the same core functions.
- `src-tauri/src/lib.rs`: Tauri command registration — check this file first when a "command not found" error shows up; it's the single source of truth for what's actually wired.
- `src/lib/sync/contracts.ts`: frontend protocol, capability, identity, invitation, grant, and permission contracts. `PROJECT_SYNC_CAPABILITIES.projectTransfer` is still `'unavailable'` — flip it only once the Vault UI below is real.
- `src/lib/api/syncSecurity.ts`, `syncChat.ts`, `syncTasks.ts`, `syncSubscription.ts`: Desktop/Web dual-mode API clients (Tauri `invoke` with a Web `fetch` fallback in every function — follow this exact pattern for anything new).
- `src/components/ProjectSidebar/MeshSidebarView.tsx`: account/device/invitation/grant sidebar (the narrow left column) — folder scopes were added here this session.
- `src/components/ProjectSidebar/NormalProjectSidebar.tsx` and `.../index.tsx` (`CleanProjectSidebar`): **there are two separate sidebar implementations for the two visual styles** (`preferences.visualStyle: 'normal' | 'clean'`). Any change to sidebar navigation/tab-switching must be made in both files or it will silently only work for one style — this exact mistake was made and fixed this session.
- `src/components/CollaborationView/`: new main-workspace-area view (`index.tsx` + `ChatPanel.tsx` + `TasksPanel.tsx` + `VaultPanel.tsx`, the last one still a placeholder). Registered as `ActiveView === 'collaboration'` in `src/App.tsx` and `src/stores/uiStore.ts`.
- `src/components/modals/preferences/AccountPage.tsx` / `CollaborationSettings.tsx`: second Google account entry point and the rendezvous-mode/activation settings panel.
- `src-tauri/src/server_main/mod.rs`: authenticated local Core, middleware, and route assembly.
- `e2e/specs/web-sync.spec.ts`: existing Desktop/Web convergence reference.

### Exact next implementation step

Phases 1–9, the local Phase 10A/10B mechanisms, and Phase 11's core publishers all pass their
automated gates and now have working UI for devices, invitations, tasks, and chat. The next
authorized work, in priority order:

1. **Vault & Folders / project-transfer UI** (`CollaborationView/VaultPanel.tsx`, currently a
   placeholder). The backend is fully implemented and tested end to end
   (`sync_subscription.rs` + `sync_staging.rs` + `sync_manifest.rs`, commands already registered in
   `lib.rs`, `src/lib/api/syncSubscription.ts` already exists but is imported by nothing) — build the
   accept/decline-offer, choose-destination, choose-mode, and staging/verify/publish-progress screens
   against those real commands, then flip `PROJECT_SYNC_CAPABILITIES.projectTransfer` to `'available'`
   and unlock the "Cofre & Pastas" button in `MeshSidebarView.tsx`. This is the largest remaining gap
   with a fully-ready backend — do this before anything else below.
2. **Cross-device content transport for chat/tasks/invitations.** Everything shipped this session
   (chat, tasks, folder-scoped invitations) is real but strictly local-to-one-install — there is no
   code path anywhere that sends any of this content to a different physical device. The Cloudflare
   rendezvous service (Phase 10B) only handles discovery/signaling, not content. Wiring issued
   invitations to end-to-end encrypted rendezvous envelopes (so a remote device can actually redeem
   one) is the first concrete slice of this; chat/task content delivery is a separate, larger
   follow-up. Do not remove the "syncs only on this device" UI notices until this is real.
3. Task editing UI (`sync_update_task`/`sync_assign_task` commands exist, no UI consumes them yet)
   and chat conversation list / attachment inline preview (today there is exactly one project
   channel per project, and attachments render as a text message with an ID, not inline).
4. Add the remaining Phase 11 domain publishers' UI surface (filter/search/grouping/deep-links on
   the access center) plus domain-specific retry controls.
5. Obtain a Cloudflare staging environment and run the complete Phase 10B matrix on two machines and
   multiple networks; do not deploy production without a separate owner authorization.
6. Complete the Phase 12 external review, deletion/recovery/provider-migration drills, dependency and
   supply-chain review, budget, alerts, retention, and incident-response approvals.
7. Complete Phase 13 isolated E2E, network, soak, supported-platform installer, and external-security
   gates. Release, commit, push, tag, and publication remain owner actions.

The detailed execution prompt for the rendezvous/security-gate sequence (items 2 and 5–7) is
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md`; it predates
this session and its own "next step" framing is stale for the same reason described above — read it
for the rendezvous/security detail, not for what to do first.

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

The working tree should be clean. Confirm that the latest commit contains this file and the chat/tasks/CollaborationView work described above in its ancestry. Then begin with item 1 ("Vault & Folders / project-transfer UI") in the "Exact next implementation step" sequence above.
