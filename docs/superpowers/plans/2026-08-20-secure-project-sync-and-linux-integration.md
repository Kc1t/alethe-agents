# Secure Project Sync, Identity, UI, and Linux Integration Plan

> Status: planning only. The current synchronization UI must remain experimental until the security gates in this plan pass.

**Goal:** Replace the current synchronization prototype with a testable, least-privilege system for authenticating users, inviting trusted devices or collaborators, synchronizing selected project content between computers, recovering safely from conflicts, and integrating correctly with Linux desktop environments.

**Architecture direction:** Keep Alethe local-first. Separate identity, device trust, invitation authorization, transport security, synchronization policy, and backup/recovery into explicit domains. Do not infer trust from a display name, email address, project name, path, or possession of a long-lived bearer token.

**Primary user journeys:**

1. Connect an account through a real external browser authorization flow.
2. Register and name the current device without exposing a reusable secret in the UI.
3. Select a project and explicitly choose which paths may leave the machine.
4. Invite a specific account or device with a short-lived, single-use invitation.
5. Review the recipient, project, permissions, exclusions, and destination before accepting.
6. Synchronize incrementally with visible progress, conflict handling, audit history, and recovery.
7. Revoke a device, collaborator, invitation, or project grant without affecting unrelated projects.

---

## 1. Verified baseline and release blockers

The following observations are based on the current implementation and must be treated as blockers, not completed features:

- `src-tauri/src/sync_mesh.rs` returns a hard-coded Google user and stores `google_auth.json`; it does not perform OAuth, validate an ID token, maintain a server session, rotate credentials, or bind identity to a device.
- `src/components/ProjectSidebar/MeshSidebarView.tsx` displays a hard-coded device ID and claims `mTLS 1.3`, `Delta Sync 128KB`, and hidden `.alethe` protection without a matching protocol implementation.
- The **Invite Friend** action opens the existing `SyncModal`, which manages GitHub Gist synchronization. There is no collaborator invitation lifecycle or project-scoped authorization model.
- The **Google / Email** entry points also open that same GitHub Gist token modal. Account authentication, settings backup, project synchronization, and invitations are therefore routed into an unrelated legacy screen.
- `ProjectFolderTreeModal` keeps selected paths only in React component state. The selection is not persisted as a sync manifest and does not constrain data transfer.
- Browser-mode fallbacks in `src/lib/api/mesh.ts` return sample folder data, a fake authenticated user, and fake backup metadata. Production UI must never present fallback samples as real state.
- `create_project_archive_backup` writes metadata text rather than a project snapshot. Its hash uses `DefaultHasher`, not SHA-256, and the resulting file is mutable and deletable; it must not be described as WORM or immutable.
- The current purge authorization compares a user-provided project name. That is a UX confirmation, not an authorization boundary.
- Existing sync E2E coverage validates shared terminal-grid behavior. It does not validate project file synchronization, identity, invitations, encryption, conflicts, revocation, or backup restoration.
- The new UI contains visible strings outside i18n and contains assertions of security properties that are not derived from backend capabilities.
- Linux runtime icon assignment exists, but Wayland compositors generally resolve Alt+Tab/task-switcher identity through the window `app_id` and an installed `.desktop` entry. A runtime pixel icon alone cannot guarantee the development-build result shown in the supplied screenshot.
- Notification delivery currently sends only `title` and `body`, caches a denied permission result for the process lifetime, and has no platform contract tests for permission, icon, urgency, click behavior, or desktop-environment formatting.

### Immediate containment before feature development

- [ ] Put project sync, invitations, Google sign-in, and vault actions behind one explicit experimental capability flag.
- [ ] Replace unsupported security claims with an honest **Prototype / unavailable** state derived from backend capabilities.
- [ ] Remove fake identities, fixed device IDs, sample files, fake backup counts, and fake successful responses from production runtime paths.
- [ ] Prevent any invitation or synchronization action until the real identity and authorization layers are available.
- [ ] Add a security note to the UI explaining that GitHub settings sync is a separate feature and is not project-folder collaboration.
- [ ] Rename and route the current `SyncModal` as **GitHub settings backup** only. It must no longer receive account-login, project-sharing, or invitation actions.
- [ ] Add regression tests proving that unavailable capabilities cannot be presented as connected, encrypted, immutable, or synchronized.

**Containment acceptance gate:** No user can mistake a local prototype state for an authenticated account, trusted device, active encrypted channel, real backup, or completed synchronization.

---

## 2. Threat model and security specification

Create `docs/security/PROJECT_SYNC_THREAT_MODEL.md` before implementing network behavior.

- [ ] Define assets: source code, `.env` files, credentials, Git metadata, agent transcripts, plans, backups, account identity, device private keys, invitations, and audit records.
- [ ] Define trust boundaries: desktop WebView, Tauri IPC, local core, local filesystem, external identity provider, relay/discovery service, peer transport, and recipient machine.
- [ ] Model attackers: malicious invite sender/recipient, stolen invite link, compromised device, local unprivileged process, hostile project files/symlinks, relay operator, network attacker, replay attacker, and confused user.
- [ ] Document privacy behavior: what metadata a relay can observe, retention, telemetry, and whether filenames or project names leave the device.
- [ ] Specify security invariants and map each invariant to automated tests.
- [ ] Perform a structured review using STRIDE or an equivalent method and record unresolved risks.

Mandatory invariants:

- A project grant authorizes exactly one project identity and an explicit permission set.
- An invitation is random, short-lived, single-use, revocable, audience-bound, and replay-resistant.
- A device has its own cryptographic identity; account login does not silently trust every device.
- Secrets never enter `projects.json`, logs, URLs, clipboard diagnostics, frontend stores, or plaintext profile JSON.
- Every path is canonicalized server-side and must remain beneath the authorized project root after symlink resolution.
- `.git`, `.alethe`, secret files, sockets, device files, and platform-sensitive paths use deny-by-default policy unless explicitly supported.
- Deletion never propagates silently on first contact, after a long offline period, or after manifest divergence.
- Revocation prevents new sessions and causes bounded key/session rotation.
- Encryption claims are only shown after cryptographic verification, not inferred from a UI mode.

---

## 3. Real account identity and secure local credential storage

### Authentication entry point and callback routing

- [ ] Add a dedicated account/authentication route and modal. The account page and sidebar **Connect Google / Email** actions must open this surface, never the GitHub Gist backup modal.
- [ ] Keep three products visibly and technically separate: **Account and devices**, **Project sync and sharing**, and **GitHub settings backup**.
- [ ] Start authorization in the system browser using OAuth 2.1 Authorization Code with PKCE. Do not embed the provider login form, collect a Google password, or imitate a provider sign-in screen inside the WebView.
- [ ] Implement one reviewed callback mechanism: an ephemeral loopback listener bound to loopback only, or an OS deep link/custom URI registered by the packaged app. Record the choice in an architecture decision record.
- [ ] Bind the callback to the initiating profile, device, attempt ID, state, nonce, PKCE verifier, redirect URI, and a short expiration. Reject unsolicited, duplicate, stale, wrong-profile, and wrong-port callbacks.
- [ ] Show explicit frontend states for opening the browser, waiting for authorization, cancelled, denied, expired, callback received, token validation, connected, and failed.
- [ ] Ensure application restart, a second app instance, or two simultaneous login attempts cannot attach a callback to the wrong profile.
- [ ] Keep provider error parameters and authorization codes out of app logs, analytics, toast history, browser history where avoidable, and persistent frontend state.

### Backend domains

- [ ] Replace the Google prototype functions in `sync_mesh.rs` with a dedicated identity module such as `src-tauri/src/sync_identity.rs`.
- [ ] Use OAuth 2.1 Authorization Code with PKCE through the system browser; bind callback state and nonce to a single login attempt.
- [ ] Validate issuer, audience, signature, expiration, nonce, and email-verification claims using the provider's supported flow.
- [ ] Store refresh/access credentials only through the existing OS credential-store abstraction (`keyring`), with account/profile/device namespace separation.
- [ ] Persist only non-sensitive session metadata in the profile data directory using atomic writes and restrictive permissions.
- [ ] Implement expiration, refresh, logout, provider revocation, corrupted-store recovery, clock-skew handling, and offline status.
- [ ] Never bundle a confidential OAuth client secret in the desktop application. If the provider requires one, introduce a minimal backend exchange service with documented ownership and threat boundaries.

### Encryption of user data on the computer

- [ ] Classify local data before encrypting it: provider credentials, device private keys, invitation secrets, project grants, sync metadata, audit metadata, project contents, transfer staging, and backups have different access and recovery needs.
- [ ] Keep credentials and private keys in the platform credential store. Do not move them into a custom encrypted JSON file merely to claim encryption.
- [ ] For sensitive structured data that must remain on disk, use envelope encryption with a random per-profile data-encryption key protected by the OS credential store.
- [ ] Use a reviewed authenticated-encryption primitive/library (for example AES-256-GCM or XChaCha20-Poly1305) with unique nonces, format versioning, associated data binding profile/device/project identity, and explicit key rotation. Never design a custom cipher or derive keys directly from email, device ID, project name, or a hard-coded application secret.
- [ ] Use atomic encrypted writes and authenticate before parsing. A modified, truncated, swapped-profile, or replayed ciphertext must fail closed without replacing the last valid state.
- [ ] Define lock/unlock and recovery behavior when the OS credential store is unavailable, reset, or moved to another machine. Never silently create a new key and make existing encrypted data unrecoverable.
- [ ] Encrypt temporary transfer/staging files when they may contain project content, remove them after verified commit, and recover safely after a crash.
- [ ] Make backup encryption explicit and opt-in where recovery-key ownership is clear. Document that losing the only recovery key makes encrypted backups unrecoverable.
- [ ] Treat full project-at-rest encryption as a separate product decision: Alethe cannot truthfully claim the working tree is encrypted while editors, Git, agents, and shells require plaintext files. Prefer OS full-disk encryption guidance for the active working tree, while encrypting credentials, protocol state, transfer staging, and backup artifacts under Alethe's control.

### Device identity

- [ ] Generate a per-installation asymmetric device keypair in the OS credential store.
- [ ] Derive the displayed device fingerprint from the public key; never use a hard-coded or user-selected identifier as proof of identity.
- [ ] Require explicit account confirmation when registering a new device and show device name, platform, first/last seen, fingerprint, and revocation state.
- [ ] Support key rotation and safe recovery without silently inheriting another profile's trust.

### Same-account device discovery

- [ ] After login, register each installation as a separate device under the account; the provider account proves account membership, while the device key proves which computer is connecting.
- [ ] Discover online and previously registered devices belonging to the same account through minimal relay metadata. Never publish local paths, project contents, account tokens, or device private keys during discovery.
- [ ] Treat same-account discovery as an invitation shortcut, not blanket authorization. A newly discovered computer may request a project, but the source device must explicitly approve the project, permissions, manifest, and destination operation unless a prior device-scoped grant already exists.
- [ ] Show the source computer, destination computer, public-key fingerprint, platform, last seen time, and revocation state before establishing trust.
- [ ] Allow an owner to mark a device as trusted for selected projects and bounded permission presets. Do not silently expose every project merely because two installations use the same Google account.
- [ ] On the receiving computer, require an explicit destination directory, disk-space review, exclusion review, and final confirmation before downloading. Default to a new empty folder and refuse to overwrite an unrelated directory.
- [ ] Support an owner-only **available projects** catalog containing opaque project IDs and user-approved display metadata. Project paths and file manifests remain hidden until the receiving device has a project grant.
- [ ] Handle offline devices, duplicate machine names, reinstalled devices, cloned profiles, account switching, and revoked devices without merging their identities.

### Tests

- [ ] Rust unit tests for state/nonce/PKCE validation, claim validation, expiration, refresh rotation, corrupted storage, logout, and cross-profile isolation.
- [ ] Contract tests with a local fake OIDC provider; no live Google dependency in CI.
- [ ] Negative tests for wrong issuer/audience, reused state, replayed callback, expired code, invalid signature, and swapped profile/device.
- [ ] Callback-routing tests for simultaneous attempts, forged deep links, loopback requests from non-loopback origins, port reuse, duplicate delivery, restart during login, and callback/profile confusion.
- [ ] Encryption tests using known vectors plus nonce uniqueness, tamper detection, wrong-profile associated data, ciphertext swapping, truncated writes, key rotation, credential-store loss, and crash recovery.
- [ ] E2E test the visible login, cancellation, denial, reconnect, logout, and expired-session flows through real UI actions.

**Identity acceptance gate:** A hard-coded identity or local JSON edit can no longer create an authenticated state, and secrets are absent from files and logs.

**Local-data protection gate:** Sensitive Alethe-owned state is unreadable without its OS-protected key, tampering is detected before parsing, and recovery behavior is documented and tested. The UI does not falsely describe the active plaintext project working tree as encrypted.

---

## 4. Invitation and authorization protocol

- [ ] Introduce typed models for `AccountId`, `DeviceId`, `ProjectId`, `InvitationId`, `GrantId`, permissions, expiry, and revocation.
- [ ] Make project identity stable and random; do not derive authorization from project name or filesystem path.
- [ ] Generate invitations server-side with at least 128 bits of cryptographic randomness and store only a hash of the bearer secret.
- [ ] Bind each invitation to issuer, intended recipient when known, project, permission set, expiry, maximum uses, and protocol version.
- [ ] Display a review screen before acceptance: sender identity/fingerprint, project name, destination, included/excluded paths, requested permissions, and risk warnings.
- [ ] Require reauthentication or device confirmation for sensitive actions such as granting write/delete access or revoking the final trusted device.
- [ ] Add rate limits, failed-attempt throttling, audit events, generic error responses, and constant-time token comparison.
- [ ] Provide list/revoke/expire flows for pending invitations and active grants.
- [ ] Keep discovery/relay metadata minimal; never embed account tokens, local paths, or project contents in invitation URLs.

### Connection codes, links, and QR flow

- [ ] Offer a QR code, shareable link, and human-readable short code as representations of the same server-issued invitation. The short code is not a Device ID and cannot be reused as a permanent password.
- [ ] Put only an invitation identifier, protocol version, relay/discovery locator, and random single-use bearer secret in the encoded payload. Never include account tokens, local IP assumptions, project paths, or device private keys.
- [ ] Use at least 128 bits of cryptographic randomness for the underlying secret. A short human code must be backed by an online rate-limited exchange and enough entropy for its validity window; it must not be validated through unrestricted offline guessing.
- [ ] Expire codes quickly, store only their hashes, consume them atomically, bind them to the intended account when known, and invalidate them after acceptance, rejection, revocation, or permission changes.
- [ ] Resolve connectivity through an authenticated rendezvous service with direct peer connectivity when available and an end-to-end-encrypted relay fallback when NAT/firewalls prevent it. Google login provides identity only; it is not the P2P transport.
- [ ] Allow LAN discovery only as an explicit optimization. A LAN advertisement cannot grant access and must still complete device authentication and project authorization.

### Invitation and access center

- [ ] Add a global notification/inbox center with tabs for incoming invitations, outgoing invitations, same-account device requests, active grants, revoked/expired items, and security events.
- [ ] Display unread counts in the sidebar/title bar and deliver an OS notification without leaking project names on a locked screen unless the user explicitly enables detailed notifications.
- [ ] Every incoming card shows verified sender account, device fingerprint, project display name, requested permissions, expiry, manifest summary, estimated size, and risk warnings.
- [ ] Accept, reject, block sender, report suspicious request, and inspect details from the inbox. Acceptance always opens the destination and permission review; it never begins transfer immediately.
- [ ] Keep invitation state synchronized across the recipient's registered devices while ensuring that acceptance is atomic and only one device consumes a single-device invitation.
- [ ] Provide outgoing status for delivered, viewed, accepted, rejected, expired, and revoked without exposing recipient activity beyond the documented privacy policy.

### Permission model

- `read`: receive project data without publishing local changes.
- `export`: save or copy received files outside the managed replica. This implies `read`; a client cannot truthfully copy content it is forbidden to read.
- `write`: publish new or modified files. Collaborative editing normally requires `read + write` so the editor has a valid base revision.
- `upload`: contribute new files to a controlled inbox without reading the existing project; this is the safe write-only/drop-box capability and does not permit overwriting arbitrary paths.
- `delete`: propagate deletions only when explicitly granted.
- `invite`: invite another collaborator; off by default.
- `admin`: change grants or project policy; never implied by write access.

Permission invariants and presets:

- [ ] Enforce permission dependencies server-side: `export` requires `read`; ordinary `write` requires `read`; `delete`, `invite`, and `admin` are independent high-risk grants and remain off unless explicitly selected.
- [ ] Provide understandable presets backed by explicit bits: **View only** (`read`), **View and copy** (`read + export`), **Collaborate** (`read + write`), **Upload only** (`upload`), and **Full project control** (`read + export + write + delete + invite + admin`).
- [ ] Show the expanded permission list before grant and acceptance. Preset labels never replace the versioned permission payload.
- [ ] Allow permissions to be scoped to selected manifest paths and operations. A collaborator may edit `src/**` while only reading `docs/**`, but deny rules and secret exclusions always take precedence.
- [ ] Compare local profile, remote account, remote device, project role, effective permissions, path scopes, expiry, and last verified session in one access-inspector screen.
- [ ] Support permission narrowing immediately. Permission expansion requires a new explicit confirmation by the owner and recipient; it cannot be smuggled into a routine sync response.
- [ ] Re-evaluate authorization for every manifest, chunk, deletion, export, invite, and administrative request instead of trusting a permission cached only in the frontend.

### Tests

- [ ] Unit/property tests for token entropy, expiry boundaries, single-use behavior, permission narrowing, and revocation.
- [ ] Replay, enumeration, privilege-escalation, confused-deputy, and cross-project authorization tests.
- [ ] E2E flows for invite, reject, expire, accept, duplicate acceptance, revoke, and offline recipient.

**Invitation acceptance gate:** Possession of a stale/replayed invitation or knowledge of a device/project name cannot grant access.

---

## 5. Synchronization engine and filesystem safety

Create separate modules for manifest policy, scanning, transfer planning, transport, conflict handling, and recovery. UI components must consume typed state rather than implement sync logic.

- [ ] Persist a versioned per-project sync manifest using normalized relative paths and explicit include/exclude rules.
- [ ] Default-deny secrets and heavy/generated paths. Detect `.env*`, private keys, credential files, `.git`, `.alethe`, dependency/build trees, sockets, FIFOs, symlinks, and platform device paths.
- [ ] Canonicalize roots and entries in Rust. Reject path traversal, absolute paths, alternate separators, case-folding collisions, Windows reserved names, and links escaping the root.
- [ ] Use content-addressed chunks with a real cryptographic digest such as SHA-256 or BLAKE3; verify every received chunk before commit.
- [ ] Transfer into a staging directory, fsync as appropriate, validate the full manifest, then apply atomically. Never overwrite the live project while a transfer is incomplete.
- [ ] Define bounded chunk sizes, concurrency, disk-space checks, maximum file/project sizes, cancellation, retry, resume, and backpressure.
- [ ] Encrypt authenticated peer sessions with a reviewed protocol/library. If mTLS is selected, implement certificate issuance, pinning, rotation, revocation, and mutual verification before displaying “mTLS”.
- [ ] Add end-to-end payload encryption so a discovery/relay service cannot read project contents. Bind ciphertext to project, sender device, recipient/grant, manifest version, chunk identity, and protocol version; reject replay and cross-project substitution.
- [ ] Define conflict semantics using version vectors or another documented model. Never use timestamps alone as the authority.
- [ ] Preserve both versions on conflict and expose a clear resolution UI. High-risk deletions require a recovery checkpoint.
- [ ] Protect against sync loops and distinguish local, remote, ignored, conflicted, pending-delete, and recovered states.
- [ ] Add an append-only, privacy-conscious audit log for grants and sync decisions without recording file content or secrets.

### Receiving and saving a shared project

- [ ] Separate the remote **project grant** from the recipient's local **subscription**. A grant means the account/device may request authorized data; it never means that a destination exists or that downloading has started.
- [ ] Model the recipient lifecycle explicitly: `offered`, `granted_unsubscribed`, `configuring`, `awaiting_confirmation`, `staging`, `verifying`, `active`, `paused`, `declined`, `revoked`, and `error`. Only the recipient can move a grant from `granted_unsubscribed` into local configuration.
- [ ] Guarantee that receiving a grant, invitation, same-account project advertisement, push notification, or online-presence event performs zero project filesystem writes and transfers zero project-content bytes.
- [ ] Present a receive wizard with source identity, project identity, branch/revision summary, manifest paths, exclusions, estimated transfer size, effective permissions, and destination requirements.
- [ ] Let the recipient choose **Create managed copy**, **Attach existing copy**, or **Download snapshot** only when the grant permits the corresponding operation. Disable unsupported choices with an explanation.
- [ ] Let the recipient browse or type an explicit destination and show the final normalized path before confirmation. Persist that path only in the recipient's local profile; never reveal it to the sender or relay.
- [ ] Validate the destination server-side for existence policy, writability, free space, filesystem type, path length, reserved names, symlinks, case sensitivity, and overlap with another managed project.
- [ ] Require the recipient to choose the initial transfer mode (`manual download`, `receive automatically after setup`, or `bidirectional after setup`) and show which choices the grant permits. Default to manual when no prior local preference exists.
- [ ] For a managed copy, create a new destination directory, persist its opaque project identity and grant, stage the initial transfer outside the live tree, verify it, then atomically publish it.
- [ ] Attaching an existing copy requires a dry-run comparison with same/different/missing files, case collisions, local-only files, conflicts, and deletion candidates. Never infer equivalence from the folder or project name.
- [ ] Show a final transfer plan before applying changes and require separate confirmation for overwrite or deletion impact. Preserve local-only and conflicting files in a recovery area by default.
- [ ] Allow the recipient to decline, defer, or dismiss a project without revoking the owner's grant. A dismissed grant remains available in the access center unless the recipient hides it or the owner revokes it.
- [ ] Cancellation before final confirmation removes temporary metadata and staging artifacts without creating a project entry. Cancellation during transfer preserves only resumable encrypted staging data according to the documented retention policy.
- [ ] After connection, expose per-project controls for direction (`receive`, `publish`, `bidirectional`), automatic/manual sync, pause, bandwidth, exclusions, conflict policy, and disconnect while keeping the last local copy.
- [ ] Make project availability explicit on each trusted device. An owner chooses which projects are advertised to another same-account device; the destination chooses which advertised projects to save locally.

Recipient-consent tests:

- [ ] Assert zero destination directories, project entries, manifests, chunks, and content requests after grant creation, notification delivery, inbox viewing, or device discovery.
- [ ] Assert that destination selection does not transfer content before final confirmation and that a forged frontend state cannot skip backend destination validation.
- [ ] Test decline, defer, dismiss, cancel before transfer, cancel during staging, resume, destination permission loss, destination removal, and choosing a different destination after failure.
- [ ] Test two recipient devices under one account choosing different destinations and sync modes without leaking or overwriting each other's local subscription state.

### Two-machine test matrix

- [ ] New empty destination; destination with unrelated files; destination with same project at older/newer/divergent states.
- [ ] Simultaneous edits, rename/edit, delete/edit, case-only rename, executable-bit change, large binary, Unicode filename, long path, and symlink escape.
- [ ] Network loss at every transfer phase, retry after process crash, low disk, permission denied, read-only destination, corrupted chunk, and malicious manifest.
- [ ] Windows↔Windows, Windows↔Linux, Linux↔Linux, macOS↔Windows, with path/case differences explicitly asserted.

**Sync acceptance gate:** A property/integration test suite demonstrates that interrupted or hostile input cannot escape the project root, silently lose the only copy, or report success before atomic commit.

---

## 6. Backup and recovery redesign

- [ ] Rename the current prototype so it does not claim snapshot, SHA-256, immutable, or WORM behavior.
- [ ] Define whether backups are local restore points, remote replicas, or compliance-grade immutable storage. Do not use “WORM” unless the storage actually enforces retention against the application/user account.
- [ ] Build real archives from the approved manifest, with versioned metadata, cryptographic hashes, project identity, source device, and creation time.
- [ ] Write archives atomically and verify them before exposing success.
- [ ] Add list, inspect, verify, restore-preview, restore-to-new-folder, retention, and deletion authorization APIs.
- [ ] Never trust a project name typed into the UI as authorization. Require an authenticated, authorized action and a separate UX confirmation.
- [ ] Test archive traversal, symlink attacks, corruption, partial writes, concurrent backup, low disk, retention, and restore without overwriting the only valid copy.

**Recovery acceptance gate:** Restore tests reproduce the expected project tree byte-for-byte and reject modified or malicious archives.

---

## 7. New synchronization interface restructuring

### Information architecture

Replace the current mixed prototype with a state-driven flow:

1. **Overview:** capability status, account, this device, trusted devices, active project sync state, last verified sync, and actionable errors.
2. **Project sharing:** collaborators/devices, permissions, pending invitations, revoke controls, and audit events.
3. **Folders and exclusions:** persisted manifest, default exclusions, secret warnings, estimated size, and change preview.
4. **Conflicts and activity:** queued transfers, conflicts, deletions, retries, and history.
5. **Backups and recovery:** verified restore points and restore workflow, clearly separated from live sync.
6. **Invitations:** incoming/outgoing requests, same-account device requests, unread status, acceptance review, expiry, and revocation.
7. **Devices and access:** account devices, collaborator profiles, fingerprints, effective project permissions, path scopes, and security history.

### UI rules

- [ ] Drive every badge and security label from a backend capability/session response.
- [ ] Give account sign-in its own page/modal and progress states. Keep GitHub personal-access-token backup in a separately named settings-backup surface.
- [ ] Route **Invite** to the project-sharing flow only after account and device trust prerequisites pass; never route it to GitHub token entry.
- [ ] Use clear states: unavailable, setup required, connecting, verifying, ready, syncing, paused, offline, conflict, revoked, and error.
- [ ] Never treat a missing translation as a reason to fall back to hard-coded Portuguese text. Add all visible strings to `en.ts` and `pt-BR.ts`.
- [ ] Replace inline layout styles with component CSS Modules and existing theme tokens.
- [ ] Use accessible labels, focus order, keyboard operation, busy states, reduced motion, and screen-reader announcements.
- [ ] Keep destructive operations visually and semantically distinct, with confirmation based on impact.
- [ ] Show the exact selected project and destination before sync/restore; never infer silently from the first project in the store.
- [ ] Do not show placeholder device IDs, counts, files, users, security protocols, or success states.

### Component and state tests

- [ ] Test every backend state mapping to the expected view and permitted actions.
- [ ] Test loading/error/retry/offline/revoked/conflict/empty states.
- [ ] Test manifest selection persistence and ensure heavy/secret paths are not selected by default.
- [ ] Test that UI labels never claim encryption, immutable backup, or completed sync without verified backend evidence.
- [ ] Test modal focus trapping, Escape behavior, keyboard navigation, disabled actions, and translated strings.

**UI acceptance gate:** A user study script with at least five representative tasks can be completed without explaining internal terms, and automated E2E tests reproduce those tasks using real clicks and typing.

---

## 8. Linux application identity and notifications

### Alt+Tab/task-switcher icon

- [ ] Verify the packaged `.deb`, AppImage, and any RPM output contain a correctly named icon and `.desktop` file with matching `Name`, `Icon`, `Exec`, and desktop identifier.
- [ ] Verify runtime window `app_id`/WM class matches the packaged desktop filename for both release and `com.kc1t.alethe.dev` development identities.
- [ ] Add a development-only installer script or documented command that installs an Alethe Dev icon and `.desktop` entry under `~/.local/share`, without overwriting the release entry. Removal must be explicit and safe.
- [ ] Keep `window.set_icon` as an X11-compatible fallback, but do not treat it as the Wayland solution.
- [ ] Test KDE Plasma/Wayland (the supplied screenshot), GNOME/Wayland, and at least one X11 session. Validate Alt+Tab, taskbar/dock, launcher, and multi-window grouping.
- [ ] Add a packaging smoke test that parses the generated `.desktop` file and verifies referenced icon files exist at installed paths.

### Notifications

- [ ] Introduce a notification service with typed category, title, body, icon identity, urgency, deduplication key, and optional safe navigation target.
- [ ] Request permission from a deliberate user action or settings flow, not for the first background event.
- [ ] Do not cache denied or unavailable permission forever; model `unknown`, `granted`, `denied`, and `unsupported` explicitly and recheck after settings changes.
- [ ] Sanitize content and enforce length limits so terminal output, paths, secrets, or control characters cannot leak into OS notifications.
- [ ] Define foreground/background behavior and always retain an in-app history entry when OS delivery fails.
- [ ] On Linux, verify D-Bus portal/notification-server behavior, app name/icon association, urgency, multiline formatting, duplicate suppression, and behavior when no daemon is present.
- [ ] Add a Preferences diagnostic action that sends a localized test notification and reports permission/delivery state without pretending OS display is guaranteed.
- [ ] Test Windows, macOS, KDE/Wayland, GNOME/Wayland, and X11 manually before release; capture desktop environment and notification-server versions in the release checklist.

**Linux acceptance gate:** Packaged Linux builds show the Alethe icon in launcher/task switcher and deliver a correctly attributed test notification on the supported KDE and GNOME matrix. Development limitations are documented separately from packaged behavior.

---

## 9. Desktop Tauri 2 and Web parity, shared Core, and startup performance

### Verified baseline

- `npm run web` currently starts both `npm run web:server` and Vite. `web:server` always runs `cargo run --bin alethe-server`, even when the Desktop Tauri process already owns a compatible embedded Alethe Core.
- Both the embedded and standalone Core bind the fixed address `127.0.0.1:1423`. Starting the Web command while Desktop is open can therefore spend time compiling/linking a second Rust binary only to encounter an ownership/port conflict.
- Vite on `1424` becomes reachable before the backend is ready. The browser receives the frontend shell but backend-dependent hydration can leave the visible page blank instead of displaying a bounded connection state.
- The frontend API layer contains many per-function `isTauriEnv()` branches. A new Tauri command can work on Desktop while its HTTP/WebSocket route, serialization contract, event, or Web fallback remains absent.
- Existing missing Web routes return HTTP `501` at runtime. This makes parity reactive and manual rather than enforced at build/test time.
- Existing `web-sync.spec.ts` primarily observes the Desktop WebView and invokes Tauri commands. It does not prove that an independent browser client rendered the same state or that mutations originated by both clients converge.

### One Core authority and attach-first Web launcher

- [ ] Treat the Alethe Core as the single source of truth for every domain shared by Desktop and Web. Tauri is a native shell/client, not a second persistence authority.
- [ ] Replace the unconditional Web launcher with an **attach-first** bootstrap:
  1. Probe `127.0.0.1:1423/api/health` with a short bounded timeout.
  2. Verify service name, API version, application identifier, data-root identity, protocol capabilities, and instance identity.
  3. Reuse the already-running embedded Core when all identities match.
  4. Start the standalone Core only when no compatible authority exists.
  5. Fail immediately with an actionable diagnostic when the port belongs to an incompatible Core; never wait through repeated compilation/probing or silently attach to another profile/data root.
- [ ] Split Web scripts into explicit operations such as `web`, `web:ui`, `web:core`, and `web:diagnose`, while keeping `npm run web` as the safe attach-or-start entry point.
- [ ] Prevent two launchers from racing to start a Core by using an instance/port ownership handshake rather than timing assumptions.
- [ ] Reuse Cargo artifacts intentionally and avoid rebuilding the backend when only frontend code changed or a compatible Core is already running.
- [ ] Print concise startup milestones with elapsed time: Core discovered, identity verified, session issued, event stream connected, bootstrap loaded, React interactive.
- [ ] Make shutdown ownership explicit: a Web UI attached to the Desktop Core must not stop it; a launcher-created standalone Core may stop only when its owning launcher exits and no persistence operation is in flight.

### Fast and honest frontend bootstrap

- [ ] Render a minimal localized application shell immediately, before backend hydration.
- [ ] Replace the blank page with explicit bounded states: **Connecting to Alethe Core**, **Starting local Core**, **Core identity mismatch**, **Core unavailable**, **API incompatible**, and **Retry**.
- [ ] Add a startup state machine with one deadline and controlled backoff. Do not stack independent per-feature retries that can accumulate into minutes.
- [ ] Fetch one versioned bootstrap document containing profile, projects revision/content, capabilities, session metadata, and initial synchronization cursor instead of issuing an uncontrolled waterfall of domain requests.
- [ ] Defer terminals, usage polling, Git probes, Graphify, MCP health, media, and other expensive noncritical work until the first usable screen is interactive.
- [ ] Cancel obsolete startup requests after Core restart, profile switch, browser reload, or a newer bootstrap generation.
- [ ] Preserve a last-known safe read-only view during a transient reconnect, clearly marked offline, rather than clearing the UI to white.

### API and event parity by construction

- [ ] Create one versioned Core service contract for request/response types, error codes, capabilities, and event schemas. Generate or share TypeScript/Rust types where practical.
- [ ] For shared domains, make both Desktop and Web call the same HTTP/WebSocket Core client. Reserve Tauri IPC for genuinely native window/dialog/OS integrations.
- [ ] Remove sample/mock success fallbacks from runtime API modules. Unsupported operations must return a typed capability error and disable the corresponding UI action.
- [ ] Add a contract registry test that fails when a shared frontend operation lacks a backend route, when a route has no frontend client, or when serialization names diverge.
- [ ] Add API-version negotiation. A newer frontend must display an upgrade/incompatibility message instead of repeatedly calling missing routes.
- [ ] Define authoritative revision/cursor semantics for profiles, projects, layouts, terminals, todos, agents, sync state, and preferences.
- [ ] Apply mutations with idempotency keys and compare-and-swap revisions. Broadcast committed results through one ordered event stream.
- [ ] On sequence gaps or reconnects, request an authoritative snapshot and rebase optimistic UI state; never assume best-effort events are complete.
- [ ] Ensure Desktop and Web cannot both become write authorities or overwrite each other through stale local Zustand persistence.

### Real two-client synchronization coverage

- [ ] Extend the E2E harness to control two distinct clients simultaneously: the Desktop WebView and an independent browser at `localhost:1424`.
- [ ] Assert initial state equality and capture independent DOM/state evidence from each client.
- [ ] Mutate every shared domain from Desktop and assert Web convergence, then mutate from Web and assert Desktop convergence.
- [ ] Cover simultaneous writes, stale revisions, Core restart, dropped WebSocket events, reconnect, profile switch, tab suspension, browser reload, and Desktop close while standalone Core remains/does not remain according to ownership.
- [ ] Test that a Desktop-only capability is visibly unavailable in Web and cannot accidentally invoke Tauri globals.
- [ ] Add a parity matrix listing each feature as Core-shared, Desktop-native, Web-specific, or intentionally unsupported, with an automated owner/test for every row.

### Startup performance budgets

- [ ] Instrument timestamps with the browser Performance API and matching Core spans. Store no user content in performance events.
- [ ] Add cold-start and warm-attach benchmarks on the CI/reference machine and real Windows/Linux release machines.
- [ ] Warm Web attach while Desktop Core is running: backend identity verified within 500 ms and usable UI within 2 seconds at the 95th percentile.
- [ ] Warm standalone restart with compiled artifacts: usable UI within 3 seconds at p95.
- [ ] Cold standalone build is reported separately as a development compilation task and must never be represented as application startup time.
- [ ] No startup/reconnect path may remain blank for more than one animation frame after HTML/CSS load; a progress/error shell must always be visible.
- [ ] Fail performance regression tests when request waterfalls, retries, or initialization tasks exceed the agreed budget.

**Web parity acceptance gate:** With Desktop already running, `npm run web` attaches to the matching Core without compiling or launching another backend, renders a usable browser client within the warm-start budget, and passes bidirectional two-client convergence tests for every shared domain.

---

## 10. Linux terminal resilience and transactional multi-client layout

### Verified baseline from the reported failures

- The supplied crash capture contains Bun's native `panic(main thread)`/segmentation-fault report inside OpenCode. This is a real process crash, not merely an xterm rendering exception.
- The visible escape-sequence dump and overlapping/cropped TUI content show that process grid size, local xterm grid, canvas metrics, and panel geometry can diverge during or after resize.
- `useXtermSession.ts` already contains settle timers, cooldowns, focus-based ownership, observer scaling, redraw workarounds, Bun crash detection, and automatic restart. These mitigations are not governed by one resize transaction or generation.
- `SyncedPanelGroup.tsx` contains the intended remote divider synchronization, but the active workspace layouts use `PersistentPanelGroup` instead. The visual divider can therefore stay local while the shared PTY resize event changes terminal grids in both clients.
- The current Web sync E2E changes PTY rows/columns directly and then reads the Desktop debug hook. It does not drag a real divider, inspect divider geometry in both clients, validate both independent canvases, or assert that OpenCode stayed alive.

### Consolidate panel layout state

- [ ] Replace the duplicate `PersistentPanelGroup`/unused `SyncedPanelGroup` paths with one production component that supports persistence and multi-client synchronization.
- [ ] Give every panel group and panel a stable domain ID that is identical in Desktop and Web and independent of React render order.
- [ ] Store layout percentages in a dedicated versioned Core resource rather than relying only on browser-local `react-resizable-panels` persistence or a broad preferences document.
- [ ] Publish ordered layout events containing profile, workspace/tab, group ID, panel IDs, percentages, revision, origin client, and transaction ID.
- [ ] Apply a remote divider layout imperatively before processing the corresponding terminal-grid change. Reject stale revisions and suppress only the exact originating transaction, not every change during an arbitrary time window.
- [ ] Preserve proportional divider positions across different viewport sizes while keeping minimum-size constraints deterministic on both clients.
- [ ] On incompatible viewport constraints, report a typed constrained-layout state and compute a documented normalized layout; never move terminal grids without moving the visible divider.

### One transactional resize coordinator

- [ ] Extract resize logic from `useXtermSession.ts` into a tested coordinator/state machine with explicit phases: `dragging`, `layoutCommitted`, `geometryMeasured`, `gridProposed`, `ptyCommitted`, `acknowledged`, `redrawn`, and `failed`.
- [ ] During pointer drag, update local panel geometry and local preview only. Do not send SIGWINCH for intermediate positions.
- [ ] On pointer release, commit one layout transaction, wait for stable measured geometry, compute each affected grid once, and send a single batched resize command for the transaction.
- [ ] Add monotonic resize generations per PTY. Backend acknowledgements and broadcasts must include generation and transaction ID so clients discard late/out-of-order resizes.
- [ ] Make the Core the authority for the committed PTY grid. A client may propose a grid but cannot overwrite a newer committed generation because it gained focus or observed a delayed rectangle.
- [ ] Apply remote layout first, then adapt the local renderer to the acknowledged canonical grid. Do not let a remote `ResizeObserver` callback reclaim ownership.
- [ ] Coalesce window resize, zoom/DPI change, panel drag, sidebar movement, fullscreen, tab activation, and remote layout into the same coordinator.
- [ ] Add bounded recovery: if geometry never stabilizes or the PTY does not acknowledge, retain the last valid grid, show a diagnostic state, and allow an explicit retry without flooding SIGWINCH.

### OpenCode/Bun crash containment

- [ ] Record a privacy-safe resize trace around every OpenCode crash: timestamps, transaction/generation, cols/rows, panel pixels, DPR, font metrics, visibility/focus, provider/runtime versions, and last resize acknowledgement. Do not record terminal contents or crash-report URLs.
- [ ] Reproduce against a pinned matrix of OpenCode, Bun, and opentui versions to determine whether a supported upgrade removes the crash.
- [ ] Introduce provider-specific resize capabilities instead of scattered `command === 'opencode'` checks: minimum interval, startup stabilization, redraw method, maximum resize rate, and whether live drag is supported.
- [ ] For OpenCode on affected Linux versions, use the strict policy: no SIGWINCH during drag, one resize after release, and no redraw nudge until that generation is acknowledged.
- [ ] Distinguish process crash, PTY exit, renderer exception, and lost stream. Automatic restart must preserve the session only when safe, be rate-limited, explain what happened, and never loop indefinitely.
- [ ] Preserve the Bun crash artifact/version metadata needed for an upstream report while redacting paths, prompts, tokens, and terminal content.
- [ ] Add a compatibility fallback that offers a stable non-TUI mode when the installed OpenCode/Bun combination is known to crash under resize.

### xterm geometry, font, and redraw correctness on Linux

- [ ] Measure and log the resolved font family, loaded font status, cell width/height, canvas backing size, CSS size, devicePixelRatio, zoom, cols, and rows as one geometry snapshot.
- [ ] Do not mount or fit xterm until the bundled mono font is loaded and its metrics are stable. Invalidate the correct xterm metric cache after font, DPI, zoom, renderer, or visibility changes.
- [ ] Test fractional scaling and common KDE/GNOME scale factors. Round CSS pixels and canvas backing pixels consistently to prevent clipped rightmost/bottom glyphs.
- [ ] Ensure the canvas/container uses `min-width: 0`, `min-height: 0`, bounded overflow, and no stale transforms inherited from panel animation.
- [ ] After an acknowledged resize, request at most one provider-appropriate redraw and compare the renderer's grid with the Core's grid before declaring success.
- [ ] Add ANSI/TUI replay fixtures for OpenCode, Antigravity, ordinary shells, and Alacritty-like dense content. Validate escape parsing, alternate-screen transitions, wide/combining glyphs, Nerd Font symbols, and cursor placement.
- [ ] Add screenshot/pixel-diff checks for clipping, overlap, stale columns, visible raw escape sequences, and black/empty regions after resize.

### Real Linux and two-client stress tests

- [ ] Add an E2E scenario that opens Desktop and a separate Web browser, creates two real terminal panes, and drags the actual divider in each client using pointer actions.
- [ ] Assert both divider coordinates/percentages, both panel bounding boxes, both local xterm rows/cols, the Core PTY grid, and the process liveness after every committed transaction.
- [ ] Run alternating Desktop/Web drags, rapid direction changes, window maximize/restore, Alt+Tab, sidebar resize, browser zoom, OS fractional scale, tab background/foreground, and reconnect.
- [ ] Keep OpenCode producing real TUI output during the stress run. Detect Bun crash text and unexpected process exit as immediate failures rather than auto-restarting and passing the test.
- [ ] Run at least 100 committed resize cycles and a 15-minute soak with zero crash, zero stale divider, zero out-of-order generation, and zero canvas/grid mismatch.
- [ ] Execute the matrix on KDE Plasma Wayland, GNOME Wayland, and X11 with packaged and development builds. Record GPU/WebKitGTK/OpenCode/Bun versions in artifacts.
- [ ] Capture screenshots and resize traces automatically at the first mismatch so failures remain diagnosable.

### Linux icon evidence linkage

- [ ] Treat both supplied icon captures as failing acceptance evidence: Alt+Tab and the taskbar/dock must resolve the Alethe identity, not the generic `W`/WebKit window icon.
- [ ] Validate icon grouping while multiple Alethe windows, the Web browser, and the development build are open; a correct in-window/runtime PNG alone is insufficient.
- [ ] Add the taskbar/dock result to the Linux packaging matrix already defined in Section 8.

**Terminal/layout acceptance gate:** On the supported Linux matrix, a real divider drag moves the corresponding divider in Desktop and Web, all clients converge on the same committed layout revision and PTY grid generation, dense TUIs redraw without clipping/overlap/raw escape output, and OpenCode survives the stress/soak budget without an automatic restart masking failure.

---

## 11. Terminal cache, buffer, and memory-pressure integrity

### Verified baseline and integrity risks

- The frontend caps queued terminal writes at 2 MB. When exceeded, it clears the queue and requests a reconnect-style resync, but the discarded byte range is not tracked as an explicit sequence gap with a completed recovery acknowledgement.
- A failed `terminal.write()` also clears the remaining queue after output has already been removed from it. Recovery is asynchronous and can race with new stream data, visibility changes, resize/redraw, and another resync.
- Pending write-drain promises are not modeled as part of an abortable recovery transaction, creating a risk of callers waiting indefinitely after a queue purge or renderer teardown.
- Backend scrollback uses a fixed 4 MB in-memory tail and an append-only raw `.bin` file. Writer/compaction errors are often ignored, compacted replacement is not transactional, and there is no file header, checksum, segment sequence, or corruption detection.
- Raw tail truncation can discard the terminal state needed to reconstruct a full-screen TUI. ANSI reset alignment reduces the risk but cannot guarantee a valid checkpoint when no complete reset exists in the retained window.
- Memory supervision measures processes, but visual queues, xterm buffers, canvas atlases, hidden mounted React trees, replay strings, WebSocket buffers, and scrollback writer backlog do not share one global memory budget.
- Mounted hidden panes are treated as protected resources. Long-running workspaces can therefore retain many xterm instances/canvas caches during Windows or Linux memory pressure.

### Define non-negotiable integrity invariants

- [ ] Every PTY output byte accepted by the Core belongs to one monotonic stream epoch and sequence range.
- [ ] A client renderer is either complete through an acknowledged sequence or explicitly marked as having a gap; it must never silently continue after unknown missing bytes.
- [ ] Queue overflow, renderer failure, reconnect, compaction, and memory reclamation may reduce retained history but cannot produce a falsely “healthy” partially parsed terminal.
- [ ] No recovery may mix bytes from different PTY IDs, profiles, process generations, stream epochs, or pre/post-restart sessions.
- [ ] Durable scrollback must be either the previous valid generation or the new valid generation after a crash; never a partially compacted replacement.
- [ ] Resource pressure may detach/render less, but must not terminate active work or delete the only recoverable terminal state without an explicit policy and user-visible event.

### Versioned and verified scrollback journal

- [ ] Replace raw unframed scrollback persistence with a versioned segmented journal containing magic/version, profile/PTY identity, process generation, stream epoch, start/end sequence, payload length, and checksum.
- [ ] Validate segment length, checksum, identity, sequence continuity, and maximum size before allocating or replaying.
- [ ] Write append/compaction errors to structured diagnostics and propagate a degraded-durability state; never discard I/O errors silently.
- [ ] Compact through `tmp → flush/fsync → atomic rename`, retaining the last known-good generation until the replacement is verified.
- [ ] Keep sequence numbers monotonic across in-memory trimming and process lifetime. A retained tail must preserve its original start/end sequence instead of resetting cursor identity to tail length.
- [ ] Quarantine malformed journals and recover the last valid prefix/segment. Do not feed corrupted bytes into the terminal parser.
- [ ] Bound the journal writer queue and apply backpressure/coalescing. A slow disk must not create unbounded memory growth.
- [ ] Add format migration for existing `.bin` scrollbacks without deleting the original until the new journal validates.

### Complete checkpoints for TUI reconstruction

- [ ] Define a terminal checkpoint as a known parser/screen baseline plus an exact stream sequence, grid generation, rows/cols, alternate-screen state, and provider/process generation.
- [ ] Evaluate a supported xterm serialization/checkpoint mechanism versus protocol-level full redraw. Record the decision and avoid depending on arbitrary tail bytes as a complete screen.
- [ ] Retain at least the newest verified complete checkpoint plus subsequent journal segments within budget.
- [ ] For full-screen providers, request one bounded redraw only when required to establish a checkpoint; rate-limit and coordinate it with resize generations to avoid destabilizing OpenCode/Bun.
- [ ] Restore by resetting/recreating the xterm parser and renderer, loading exactly one verified checkpoint, then replaying contiguous segments after its cursor.
- [ ] If no valid checkpoint exists, show a recoverable **history unavailable / redraw required** state rather than displaying a corrupted partial TUI.

### Sequence-aware frontend buffering and backpressure

- [ ] Represent every queued chunk as `{epoch, startSequence, endSequence, payload}` and reject duplicates, overlaps, gaps, and wrong-generation data deterministically.
- [ ] Replace silent 2 MB queue clearing with a recovery state machine: pause renderer input, record the missing range, cancel/drain pending callbacks, obtain a checkpoint at or after the gap, rebuild, then acknowledge the recovered cursor.
- [ ] While recovery is in flight, capture only bounded post-checkpoint events by sequence or stop delivery through explicit flow control. Never maintain two competing resync/replay operations.
- [ ] Make `queueTerminalWriteAndWait` abortable and guarantee every waiter resolves or rejects on overflow, unmount, restart, renderer failure, or resync.
- [ ] Add high/low watermarks and credits between renderer, browser transport, Core fan-out, and journal writer. Hidden/minimized clients should stop receiving full-rate visual output before memory becomes critical.
- [ ] Coalesce activity summaries separately from lossless journal output so monitoring does not require retaining every visual chunk in the WebView.
- [ ] Detect prolonged main-thread starvation and switch to checkpoint recovery instead of allowing `requestAnimationFrame` queues to grow while minimized or under load.

### Global adaptive memory budget

- [ ] Build one resource inventory covering Rust process state, each agent tree, WebView/browser process, xterm buffers, pending write queues, replay/resync buffers, canvas atlases, hidden mounted panes, journals, WebSocket queues, images/video, and application caches.
- [ ] Allocate budgets globally and per category/PTY from the user's configured memory target and current system available/commit memory. Fixed per-terminal caps alone are insufficient.
- [ ] Add pressure levels with hysteresis and deterministic actions:
  - **Normal:** full rendering and configured scrollback.
  - **Elevated:** stop hidden full-rate rendering, reduce nonessential caches, defer expensive previews.
  - **High:** checkpoint and dispose hidden xterm/canvas renderers, shrink replay buffers, retain processes and durable journals.
  - **Critical:** block new heavy work, flush integrity-critical state, offer user-controlled suspension candidates; never silently kill visible/working agents.
  - **Recovery:** recreate renderers gradually with concurrency limits and verify cursor continuity before showing them healthy.
- [ ] Distinguish memory leak, legitimate agent memory, file cache, GPU/canvas memory, committed virtual memory, and system-wide pressure on Windows and Linux.
- [ ] Make mounted-but-hidden panes eligible for renderer disposal while preserving their PTY process and durable stream, instead of treating the whole pane as permanently protected.
- [ ] Ensure reclamation is idempotent and prioritized; repeated pressure events must not recreate/dispose the same resource in a loop.

### Renderer and cache recovery

- [ ] Dispose and recreate the CanvasAddon/xterm instance as one generation when the browser/WebView loses its backing store, reports renderer errors, resumes after long suspension, or crosses a critical pressure transition.
- [ ] Never reuse a texture atlas or metric cache across incompatible font, DPR, zoom, renderer, visibility, or terminal generations.
- [ ] Validate the rebuilt renderer against checkpoint cursor, grid generation, and a small set of terminal invariants before removing the recovery overlay.
- [ ] Keep UI state, parser state, canvas state, and PTY state separate so clearing a visual cache cannot alter persisted terminal bytes or project data.
- [ ] Add a user-visible, localized recovery indicator and diagnostic reason; corruption must not be hidden behind an apparently normal terminal.

### Project/state cache durability under pressure

- [ ] Audit all debounced Zustand/project/preferences writes so memory pressure, suspension, WebView termination, or application close cannot drop the newest acknowledged revision.
- [ ] Flush dirty state through the existing serialized/atomic persistence path before optional renderer/process reclamation.
- [ ] Bound undo/history, notifications, activity samples, image previews, Markdown/Graphify caches, and diagnostics independently; do not solve terminal pressure by allowing another cache to grow without limit.
- [ ] Add checksums/versioning to recovery files and never replace authoritative state with an empty/default document after a read/parse/allocation failure.

### Stress, fault-injection, and soak tests

- [ ] Unit-test queue overflow, writer failure, checksum mismatch, truncated segment, sequence gap/overlap, duplicate event, epoch change, aborted waiter, and concurrent resync.
- [ ] Property/fuzz-test journal parsing, ANSI/checkpoint boundaries, arbitrary chunk splits, UTF-8 splits, and corrupted length/checksum fields without unbounded allocation or panic.
- [ ] Inject slow/failing disk, delayed WebSocket, dropped events, main-thread stalls, renderer exceptions, Core restart, WebView background throttling, and process restart at every journal/compaction phase.
- [ ] Run multi-terminal output generators with deterministic sequence markers and hashes. After hide/show, minimize/restore, pressure recovery, reconnect, and compaction, verify no missing, duplicated, reordered, or cross-session markers.
- [ ] Run Windows and Linux sessions for at least 8 hours of sustained output and 24 hours idle-with-periodic-output, with repeated memory-pressure cycles and viewport/layout changes.
- [ ] Test near system commit exhaustion in an isolated environment with bounded allocation; never intentionally destabilize the user's normal machine or real profile.
- [ ] Capture RSS/private commit, WebView/GPU memory, queue sizes, journal backlog, checkpoint age, recovery count/duration, event-loop lag, and cursor continuity over time.
- [ ] Establish pass criteria: bounded memory after warm-up/recovery, zero silent gaps/duplicates, zero corrupted renderer, zero invalid authoritative write, and recovery to an interactive terminal within a defined deadline.

**Memory-integrity acceptance gate:** Under the Windows/Linux stress and soak matrix, memory remains bounded or degrades through the documented pressure states; every rendered terminal is provably contiguous through an acknowledged cursor or visibly recovering; journal and project state survive injected crashes/failures without silent loss, duplication, cross-session mixing, or corrupted UI.

---

## 12. Web platform reliability, performance, and secure mobile access

### Evidence and scope

- [ ] Treat the standalone browser client and LAN Remote Control as different products and threat boundaries. The development Web UI must never become a LAN/mobile sharing endpoint merely because Vite or the Core binds a reachable address.
- [ ] Preserve the relevant upstream findings as explicit backlog dependencies: [#137](https://github.com/Kc1t/alethe-agents/issues/137) for fail-closed LAN exposure, [#145](https://github.com/Kc1t/alethe-agents/issues/145) for privileged command boundaries, [#39](https://github.com/Kc1t/alethe-agents/issues/39) for tests omitted from CI, [#51](https://github.com/Kc1t/alethe-agents/issues/51) for real Linux validation, and historical [#9](https://github.com/Kc1t/alethe-agents/issues/9) for unbounded orphan-process memory.
- [ ] Record that issues are disabled on the configured `origin` and `fork`; reconcile against the upstream tracker and this plan until a project-owned issue intake is enabled. Do not silently assume a closed upstream issue is present in this branch: verify the patch and its regression tests locally.
- [ ] Create a reproducible Web failure inventory with browser/OS, route, feature flags, Core build/protocol, console error, network trace, memory timeline, and minimal reproduction. Convert every blank page, unhandled rejection, renderer loss, protocol mismatch, or five-minute startup into a named regression test.

### Crash containment and lifecycle correctness

- [ ] Add a top-level error boundary that preserves diagnostics and recovery controls instead of leaving a blank page, plus feature-level boundaries around terminals, diagrams, dashboards, remote control, account/sync, and other independently recoverable surfaces.
- [ ] Define a typed bootstrap state machine for discovery, authentication, capability negotiation, hydration, initial snapshot, event catch-up, ready, degraded, incompatible, and retry states. No component may infer readiness from a partially populated store.
- [ ] Cancel or generation-guard every asynchronous load, subscription, worker, timer, observer, and dynamic import during navigation, profile switch, reconnect, hot reload, and unmount. Stale completions must not mutate the active profile or client generation.
- [ ] Make reconnect resumable and idempotent through Core instance ID, profile ID, stream epoch, revision, and cursor. A browser reload, background-tab suspension, Core restart, or missed WebSocket event must trigger bounded catch-up or a clean snapshot, never mixed generations.
- [ ] Gate each route and control through the negotiated capability registry. Missing routes return a typed unsupported state; they must not produce runtime `501` surprises, invoke Tauri globals from a browser, or crash the application shell.
- [ ] Add a Web safe mode that can reopen the last workspace without heavy visualizations, GPU terminal addons, restored remote sessions, or optional integrations. Recovery must not erase projects or terminal journals.

### Web performance and resource budgets

- [ ] Capture a cold/warm performance baseline for startup, hydration, first interactive terminal, route transitions, panel drag, reconnect, and large scrollback replay in Chromium, Firefox, and WebKit-class browsers.
- [ ] Establish enforceable budgets for initial JavaScript/CSS, per-route chunks, long tasks, interaction latency, heap after stabilization, WebSocket backlog, terminal render queue, and number of mounted hidden panes. Store measurements as CI artifacts and fail on material regression.
- [ ] Split heavy routes and optional renderers with dynamic imports; defer diagrams, analytics, media, and agent-specific surfaces until visible. The initial shell, project selector, connection state, and first terminal must not wait for unrelated bundles.
- [ ] Audit Zustand subscriptions and derived data so updates select the smallest stable slice. Batch high-frequency PTY/usage events outside React and prevent a single terminal chunk from rerendering the workspace tree.
- [ ] Virtualize long project/session/history lists, cap decoded payload and replay work per frame, and yield between bounded batches. Hidden/background terminals use reduced render budgets while durable output continues in the Core journal.
- [ ] Prefer incremental cursor-based snapshots over retransmitting full scrollback or workspace state. Apply compression only after payload limits and decompression-bomb protections are defined.
- [ ] Disable or dispose GPU/canvas acceleration after context loss or pressure thresholds and fall back to a tested renderer. Tab visibility, mobile suspension, zoom, orientation, and device-pixel-ratio changes must pass through the same lifecycle coordinator.

### Secure phone and LAN access

- [ ] Replace plaintext HTTP/WebSocket LAN transport before enabling remote access beyond an explicitly acknowledged trusted-development mode. Use an audited TLS or mutually authenticated secure tunnel design; document certificate enrollment, identity verification, renewal, and downgrade rejection.
- [ ] Never put a reusable pairing/session secret in a URL, browser history, referrer, screenshot, QR analytics, or log. Use a short-lived one-time bootstrap challenge and bind the resulting session to a generated device key.
- [ ] Make remote access disabled and read-only in the backend's initial state, independent of frontend defaults. Bind both listeners atomically before reporting success; on any partial bind/configuration failure close everything, revoke provisional state, and persist disabled state.
- [ ] Require an explicit consent screen that states which network interfaces are exposed, which workspace/terminal metadata and scrollback become visible, session expiry, input policy, and revocation controls. Network changes from trusted to public require reauthorization or immediate shutdown.
- [ ] Authorize capabilities per device and project: metadata, terminal output, terminal input, filesystem mutation, command execution, sync administration, and secrets are separate permissions. Shell input and privileged mutations require a fresh local approval and cannot be inferred from read access.
- [ ] Enforce `Origin`/`Host` allowlists, anti-CSRF/replay state, strict message schemas, size/rate/concurrency limits, bounded output subscriptions, constant-time secret checks, persistent revocation, idle/absolute expiry, and redacted audit records.
- [ ] Replace or isolate the hand-written LAN HTTP/WebSocket parser behind an audited server stack and fuzz request parsing, upgrade handling, header ambiguity, chunking, malformed UTF-8, request smuggling, slow clients, and connection exhaustion.
- [ ] Apply production CSP and security headers to browser/mobile surfaces; forbid service-worker or browser-cache persistence of terminal output, tokens, project files, and authenticated API responses unless an encrypted, versioned offline design is approved.
- [ ] Provide a prominent session/device list with last activity, network, granted permissions, and one-click revocation. Revocation must terminate live sockets and invalidate resume tokens immediately.

### Browser, mobile, and adversarial verification

- [ ] Add independent-browser E2E coverage in Chromium, Firefox, and WebKit for bootstrap, every shared route, reconnect, reload, incompatibility, degraded mode, safe mode, and feature-boundary recovery.
- [ ] Run real-device Android Chrome and iOS Safari scenarios for QR/pairing, touch resizing, virtual keyboard/IME, orientation, sleep/wake, network handoff, background eviction, reconnect, and explicit revocation.
- [ ] Add adversarial LAN tests for untrusted origin, stolen/expired/replayed pairing material, revoked devices, port conflicts, partial bind, public-interface changes, oversized/slow messages, many sockets, malicious paths/commands, and compromised renderer attempts against privileged Core operations.
- [ ] Run Web load and soak tests with many terminals, high output, large scrollback, repeated route changes, Desktop plus multiple browsers, Core restart, network loss, CPU throttling, and memory pressure. Assert bounded queues/heap, cursor continuity, responsive recovery, and zero whole-app blank screen.
- [ ] Instrument privacy-preserving local diagnostics for crash boundary, Core/protocol version, route, lifecycle generation, queue/budget state, and recovery outcome. Any upload remains opt-in and strips commands, paths, terminal contents, identifiers, tokens, and file data.

**Web/mobile acceptance gate:** A supported browser reaches the documented interactive budget, survives the cross-browser stress/soak matrix without a whole-app crash, and recovers deterministically from stale events, renderer loss, suspension, and Core restart. Mobile/LAN access remains off and read-only by backend default, uses protected authenticated transport, passes the adversarial authorization matrix, and cannot expose terminal/project data or privileged commands through a stolen URL, renderer compromise, partial bind, or network change.

---

## 13. Test architecture and CI gates

### Unit and property tests

- [ ] Frontend: reducers/view models, capability mapping, manifest selection, invitation state, conflict presentation, permission UX, and notification fallback.
- [ ] Rust: identity validation, credential metadata, token hashing/expiry, authorization, path policy, manifests, chunks, conflicts, archive validation, and audit redaction.
- [ ] Add property/fuzz testing for paths, manifests, invitation parsers, archive metadata, and protocol messages.

### Integration and contract tests

- [ ] Use isolated temporary roots and in-memory/local fake services; never use the real profile or real provider accounts.
- [ ] Add two independent Alethe instances with separate device identities and data roots.
- [ ] Test the complete invite → accept → initial sync → concurrent edit → conflict → revoke lifecycle.
- [ ] Add protocol-version compatibility and downgrade-rejection tests.
- [ ] Confirm logs and persisted files contain no bearer tokens, refresh tokens, authorization codes, invitation secrets, or file contents marked secret.

### Desktop E2E and human validation

- [ ] Create dedicated WebdriverIO specs for account, devices, invitations, folder policy, conflicts, recovery, and notification settings.
- [ ] Use real UI interactions; debug hooks may only read state.
- [ ] Add exploratory usability scenarios for first-time setup, recipient acceptance, offline recovery, and revoked-device explanation.
- [ ] Run accessibility checks and keyboard-only walkthroughs in both locales.
- [ ] Run real-machine packaged tests for Windows, macOS, KDE/Wayland, GNOME/Wayland, and X11.

### Required commands per implementation slice

```text
npm run build
npm run lint
npm run format:check
npm test
npm run test:rust
cargo test --manifest-path src-tauri/Cargo.toml --test profile_sync_contract
npm run test:e2e:build
npm run test:e2e
npm run test:e2e:sync:build
npm run test:e2e:sync
```

Security-sensitive slices additionally require fuzz/property suites, dependency audit, secret scan, and a written threat-model review. A green build alone is not a security sign-off.

---

## 14. Delivery order and stop/go gates

### Phase 0 — Contain misleading prototype behavior

- Feature flag, truthful states, remove fake data/claims, add baseline regression tests.
- **Go condition:** Prototype actions cannot expose or modify project data and cannot appear production-ready.

### Phase 1 — Threat model and domain contracts

- Security document, typed IDs/states, capability API, test harnesses, protocol decision record.
- **Go condition:** Security invariants and ownership boundaries are reviewable before networking code exists.

### Phase 1A — Shared Core and Desktop/Web parity foundation

- Attach-first Web launcher, visible bootstrap state machine, shared service contracts, route-parity checks, ordered event convergence, and real two-client E2E coverage.
- **Go condition:** Web reuses a matching Desktop Core, reaches the warm-start budget, and no shared operation depends on an unpaired IPC-only implementation.

### Phase 1B — Transactional layout and Linux terminal stabilization

- Consolidated synchronized panel groups, versioned layout events, resize generations/acknowledgements, provider resize policies, geometry diagnostics, and real two-client Linux stress tests.
- **Go condition:** Divider, panel geometry, xterm grid, and PTY grid converge after real drags; the Linux OpenCode stress/soak suite reports no crash or rendering corruption.

### Phase 1C — Memory-pressure and stream-integrity foundation

- Versioned scrollback journal, complete checkpoints, sequence-aware renderer queues, transport backpressure, global adaptive budgets, deterministic renderer disposal/rebuild, and Windows/Linux fault-injection/soak coverage.
- **Go condition:** Output continuity and durable state pass corruption/failure injection; long-running Windows/Linux tests remain bounded and recover without a visually corrupted terminal.

### Phase 1D — Web reliability, performance, and mobile security foundation

- Crash boundaries and safe mode, lifecycle generations, cross-browser capability contracts, route/bundle/resource budgets, secure remote transport, backend fail-closed authorization, and real-device/adversarial LAN coverage.
- **Go condition:** Web meets its startup/interaction/resource budgets and stress suite without a blank-page failure; phone/LAN access is protected, explicit, least-privileged, revocable, and passes the hostile-network matrix.

### Phase 2 — Identity and device trust

- Dedicated login UI/routing, OAuth/PKCE callback handling, encrypted local state, credential storage, device keys, same-account discovery, available-project catalog, device management, and negative tests.
- **Go condition:** Identity and device tests pass; no secret is stored or logged outside the credential store.

### Phase 3 — Invitations and authorization

- Project grants, single-use link/QR/short-code invitations, invitation center, profile/device access inspector, permission presets and path scopes, revoke/audit flows.
- **Go condition:** Replay and cross-project escalation tests pass.

### Phase 4 — Safe sync engine

- Grant/subscription separation, recipient-consent state machine, destination validation, receive/save wizard, manifest, existing-copy comparison, path sandbox, staging, chunks, verification, atomic commit, direction controls, conflict/recovery.
- **Go condition:** Two-machine hostile/interruption matrix passes without root escape or silent data loss.

### Phase 5 — Real backup and restore

- Verified archives, retention, restore preview/new-folder recovery.
- **Go condition:** Byte-for-byte restore and malicious-archive rejection pass.

### Phase 6 — UI restructuring

- State-driven screens, i18n, accessibility, component tests, user validation script.
- **Go condition:** Representative users complete the key flows and all UI states have automated coverage.

### Phase 7 — Linux packaging and notifications

- Desktop identity, dev entry, packaged matrix, notification diagnostics and tests.
- **Go condition:** KDE/GNOME packaged acceptance matrix passes.

### Phase 8 — Security review and staged release

- Independent review, dependency/secret audit, migration and rollback plan, opt-in beta, telemetry limited to explicit consent, incident response notes.
- **Go condition:** No critical/high unresolved finding; rollback and revocation are tested before enabling by default.

---

## 15. Definition of done

- [ ] No placeholder or simulated state is reachable in production builds.
- [ ] Security labels reflect verified backend facts.
- [ ] Identity, device trust, invitations, grants, sync manifests, conflicts, backups, and notifications have explicit versioned contracts.
- [ ] Secrets are protected by the OS credential store and absent from logs/plaintext documents.
- [ ] Project data cannot escape the selected root or include denied paths through traversal, links, case tricks, or archive extraction.
- [ ] Interrupted sync and restore operations are atomic and recoverable.
- [ ] Revocation and replay protections are verified end to end.
- [ ] All visible UI is localized in English and Brazilian Portuguese and follows the design system.
- [ ] Unit, property, integration, contract, desktop E2E, two-machine, accessibility, and real-platform acceptance tests pass.
- [ ] Linux packaged builds pass icon and notification checks on KDE/Wayland and GNOME/Wayland; X11 fallback behavior is documented and tested.
- [ ] Desktop and an independent Web client use one verified Core authority, converge bidirectionally after writes/reconnects, and meet the documented warm-start performance budget.
- [ ] Shared feature parity is contract-tested; intentionally native-only capabilities are explicit and disabled cleanly in Web.
- [ ] Desktop/Web divider state, panel geometry, xterm dimensions, and PTY generations converge transactionally, including after reconnect and conflicting resize attempts.
- [ ] OpenCode and dense terminal fixtures pass the Linux resize stress/soak matrix without clipping, overlap, raw escape output, native process crash, or an automatic restart hiding a failure.
- [ ] Terminal streams use verified epochs/sequences and durable checkpointed journals; overflow, memory pressure, long idle periods, renderer loss, and reconnect cannot produce silent gaps or a falsely healthy partial screen.
- [ ] Global memory budgets cover WebView/renderers/queues/caches as well as agent processes, and Windows/Linux long-duration tests demonstrate bounded degradation and deterministic recovery.
- [ ] Web has route-level crash isolation, deterministic safe-mode recovery, lifecycle-generation guards, and cross-browser tests for every supported shared capability.
- [ ] Web startup, bundle, interaction, heap, terminal queue, reconnect, and soak budgets are measured in CI and pass on the supported browser/device matrix.
- [ ] Phone/LAN access is distinct from the development Web client, disabled and read-only by backend default, protected in transit, device-bound, least-privileged, immediately revocable, and verified against hostile-network tests.
- [ ] The changelog and user documentation describe only capabilities that are actually implemented and verified.
