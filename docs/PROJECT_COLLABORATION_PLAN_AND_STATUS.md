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

**Superseded 2026-08-25 — see ADR-0002's amendment ("no operator-managed endpoint") for the full
rationale.** The bullets below describe the original Phase 10 plan; they no longer describe what
is implemented and must not be implemented. Alethe never operates a shared rendezvous endpoint —
doing so would let a single Alethe-run service observe device presence/connection metadata across
every user of the app, not just the people any one user has actually invited, which is a strictly
larger exposure than this project accepts.

The real, current model: every user who wants online collaboration deploys and owns a personal
Cloudflare Worker through the guided flow (`CloudflareGuidedDeploy` in Preferences → Account,
`sync_cloudflare_deploy.rs`; Wrangler's own OAuth token stays in that user's local Wrangler config
— Alethe never sees or stores a Cloudflare credential). Two users can only discover each other
through Cloudflare once they already share real trust (a project grant, or a mutually-added chat
contact) — there is no discovery of strangers. `CollaborationSettings.tsx` offers exactly two
modes: `Local only` (no rendezvous at all) and the personal-Worker mode. The backend keeps the
`alethe_managed` enum variant only so a settings file saved before this amendment still
deserializes; nothing new ever writes or offers it.

<details>
<summary>Original (superseded) plan text, kept for history</summary>

- The Alethe project operator owns and deploys the official Cloudflare Worker and Durable Objects. Deployment credentials never ship inside Alethe.
- An ordinary user never creates a Cloudflare account, installs Wrangler, configures a Worker, supplies a Cloudflare API token, buys a domain, or manages TLS.
- A user who enables online collaboration connects to the operator-managed Alethe collaboration endpoint already configured in the signed application release.
- Advanced users may deliberately select a compatible custom/self-hosted endpoint. This is an optional expert path, not normal onboarding, and it cannot silently fall back to the official service or another public provider.
- Every participant who wants automatic online discovery, invitation delivery, or new cross-network connection negotiation must enable Alethe collaboration. This still does not require them to own Cloudflare infrastructure.

</details>

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


## Current status and remaining work

The phase-by-phase implementation history (what was built, when, and the detailed per-phase
blueprint) has been moved to [`docs/archive/PROJECT_COLLABORATION_HISTORY.md`](archive/PROJECT_COLLABORATION_HISTORY.md) —
it was large, almost entirely superseded by `docs/CHANGELOG.md` (which now documents every
shipped change with dates), and some of its status claims had already gone stale relative to
the code (e.g. it still described chat as "local to this install only, no cross-device
delivery" after cross-device chat delivery had shipped). For what actually exists today,
prefer `docs/CHANGELOG.md` "Unreleased"/recent versions over anything in the archive.

### Transfer performance — what is left, in order

Ranked by measured gain over risk. The comparison these come from is a reading of the Syncthing
source alongside ours; the constants named are from both codebases, not estimates.

1. **LZ4 compression per frame** (`sync_transport.rs`) — Syncthing compresses above 128 bytes and
   keeps the result only when it actually shrank (`errNotCompressible`). For source code, which is
   what Alethe moves, that is usually 2–4× for free. Best effort-to-return ratio left: one
   dependency, a per-frame decision, no protocol change.

2. **Local network discovery** (new module) — Syncthing announces itself over UDP broadcast on port
   21027 and finds a peer with no server, no NAT and no internet. Two machines on the same desk
   still talk through the rendezvous today. This removes NAT entirely for that case and drops the
   RTT from ~40 ms to ~1 ms, which multiplies directly against the send window that just landed.

3. **Adaptive block size** (`sync_manifest.rs`) — non-text content uses a fixed `CHUNK_SIZE_BYTES`
   of 4 MiB, so one lost block costs 4 MiB to resend. Syncthing targets ~2 000 blocks per file
   between 128 KiB and 16 MiB (`DesiredPerFileBlocks`). Changes the manifest shape, so it needs a
   migration.

4. **UPnP-IGD / NAT-PMP** (`sync_p2p_bridge.rs`) — ask the router for a port mapping. Last on
   purpose. It is the part Syncthing's own marketing highlights and the least important of the
   three mechanisms that make it work; what actually carries is the global discovery directory plus
   the public relay pool. Doing it before the items above would trade a slow transfer that connects
   for a slow transfer that connects more often.

Not a performance item, but open: **the E2E suite's driver**, isolated by the probe described in the
handoff below.

## Architecture terms

### Rendezvous

The rendezvous service is a meeting point for devices. It records minimal online-presence metadata, authenticates device announcements, and exchanges connection candidates. It must not receive OAuth tokens, private keys, local paths, filenames, or plaintext project content.

### Relay

A relay is a fallback data path used when NAT or a firewall prevents a direct peer-to-peer connection. Payloads must be encrypted on the sending device and decrypted only on the receiving device. The relay may observe connection timing and ciphertext size but must not be able to read project data.

### Grant and subscription

A project grant authorizes a specific account or device to request specific operations. A local subscription records whether the recipient chose to use that grant, where the project should be stored, and how synchronization should run. Creating a grant must not create a directory or transfer content.


## Continuation handoff

### Repository state at this handoff

- Repository: `Kc1t/alethe-agents`.
- Pull request: `#153` (head: `MiguelSilvaPorto:feat/mesh-sync-p2p-vault`).
- Development branch: `feat/mesh-sync-p2p-vault`, merged with `origin/main` at `3be28fe`.
- Handoff date: 2026-09-04. Supersedes the handoff dated 2026-08-24.
- The warning from that handoff still stands and is worth repeating: **do not trust a stale
  summary table over the source code.** Grep the `.rs`/`.tsx` files this document names before
  believing a checkbox.

#### What this session changed about transfer

Project sharing was unusable in two independent ways, both now fixed. The numbers below are
derived from the constants in the code, not measured over a real network; what *is* measured is
the behaviour, by the tests each commit names.

| | Before | After |
|---|---|---|
| Bytes in flight on the direct path | 1 200 | 38 400 (32 chunks) |
| Throughput at a 40 ms RTT | ~30 KB/s | ~1 MB/s |
| A 100 MB project | ~58 min | ~2 min |
| With no direct session | never transferred | falls back to the relay |

1. **`d4261c6` — a send window.** The P2P link was stop-and-wait: one 1 200-byte chunk, then a
   blocking wait for its ACK, which makes throughput a function of round-trip time rather than
   bandwidth. Now Go-Back-N with 32 chunks in flight. This is a **sender-only** change with an
   unchanged wire format, because the receiver already behaved exactly like a Go-Back-N receiver
   (in-order delivery, drop anything ahead) — so a new sender and an old one are interchangeable.

   One defect had to be repaired first: the receiver acknowledged every data packet and then
   discarded the ones it could not deliver in order. Harmless with a single chunk in flight, and
   silent data loss with a window — chunk 5 arriving before chunk 4 would have been acknowledged,
   dropped, and skipped as delivered. **An ACK now means delivered**: a packet from the future gets
   no ACK, and a duplicate of something already delivered is re-ACKed.

2. **`f7da90d` — a relay fallback for project transfer.** `sync_file_pipeline_offer_project` ended
   at `p2p_registry.send(...)?`. No direct session meant the offer simply did not happen, so behind
   a symmetric NAT sharing a project could not work at all. Chat has always had this fallback;
   transfers now do too, in `sync_file_pipeline_relay.rs`.

   The substance is fragmentation, not the fallback itself: the relay rejects any frame over
   24 KiB and a pipeline frame is far larger (a chunk subframe is 150 KiB; a `ManifestOffer` has no
   bound). The fragment size is 10 KiB because a payload inflates about 1.8× before the relay sees
   it — base64 into its own JSON, sealed, base64url again, wrapped in the enqueue frame. 12 KiB
   left only 2 KiB of the frame spare; the test that caught this models the whole chain, and an
   earlier version measured only the fragment's own JSON.

#### Other defects fixed this session

- **`6244bab`** — the correlation wrapper from the observability work took the whole UI down on
  builds where `window.__TAURI_INTERNALS__.invoke` is a read-only property. It runs at module scope,
  so the throw produced a blank window. Every failure path now degrades to "correlation is off".
- **`7100c51`** — `No conversation found with session ID`. Alethe mints Claude's session id itself
  and saved it from the *intent* to create a session rather than evidence one existed; a first
  launch that stopped at the trust prompt wrote no conversation file. `session_presence.rs` now
  checks before resuming, with a third `unknown` state so an agent whose storage cannot be read
  never has a valid id discarded.
- **`d93b65a`** — scrolling a full-screen agent was sending arrow keys into it. In the alternate
  buffer the terminal converts the wheel to cursor keys, which Claude Code reads as input.
  Diagnosed from the recorded PTY streams: Claude Code enters the alternate screen seven times in
  one session and never enables mouse tracking, while OpenCode enables it nine times.

#### CI

The four build/test checks are green. E2E (Windows) is red and **is not a regression** — it has
never passed, across the last 60 runs on any branch. `scripts/e2e-launch-probe.mjs` (`752ad63`)
now separates the two causes the WebDriver error conflates, and answered on its first run: the app
starts fine on the runner, the driver is the problem (`tauri-driver`/`msedgedriver`).

#### Gotchas on the primary Windows checkout

- **`CARGO_INCREMENTAL=0` is required to run the Rust tests here.** `rustc` crashes with
  `STATUS_STACK_BUFFER_OVERRUN` during incremental compilation — the Defender-corrupts-the-toolchain
  problem `CLAUDE.md` already documents. It looks exactly like a code error and is not one.
- **Run `prettier --check .` from the repository root.** From inside `src-tauri` it walks `target/`
  and reports thousands of files.
- **This checkout's dev port is 1594, not 1422** — it is derived from the checkout path by
  `dev-instance.mjs`, which is the whole point of that file.

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

### Known open security gap — pairing codes are replayable (documented, fix deferred)

Observed live (2026-08-27): the same pairing code was redeemed several times in a row, each time
successfully. The single-use guarantee the code was designed around is not enforced end to end.

`consume_chat_invite_token_at` does fail closed on replay, forged, and stale tokens, and its unit
tests prove that. But it is only ever reached on the **issuing** device, inside
`sync_open_chat_contact_ack`, when the `chat_contact_ack` comes back. The **redeeming** side
(`AddChatContactModal.tsx` → `sync_add_chat_contact`) commits the contact straight from the code's
contents without validating the token or consulting the issuer at all. So a pairing code is in
practice a replayable bearer credential, usable until it expires; and it does not rotate between
exports, because `current_or_new_chat_invite_token_at` deliberately returns the same live token.
What single-use actually governs is only whether the issuer reciprocally auto-adds the redeemer.

Impact is bounded but real: a chat contact is not a grant and confers no project access (guarded by
`adding_a_chat_contact_never_creates_a_grant_or_invitation`), so no code or project data is exposed.
What a code holder does get is the issuer's account route and public keys, and the ability to open a
direct conversation with them, repeatedly.

The gap survived review because the tests cover the function in isolation rather than the two-device
flow — worth remembering when adding tests for the fix.

Options considered, none implemented (owner deferred the fix; do not half-apply one):

1. **Issuer-authoritative (recommended).** The redeemer commits the contact only after the issuer
   confirms the `ack` — the issuer already consumes the token there. Closes the replay properly and
   keeps the relay stateless and ignorant of invitations, which the project's own scope rules
   require. Costs a round-trip and needs the issuer online.
2. **Relay-validated.** The Cloudflare Worker rejects envelopes bearing an already-used token. Works
   with the issuer offline, but puts invitation state on the rendezvous service, which currently
   handles discovery/signaling only.
3. **Accept and re-document.** Treat the code as "whoever holds it may add you" and correct every
   comment and UI string that still promises single use.

Until one lands, the code comments on `ChatInviteToken` and `sync_open_chat_contact_ack` carry the
same warning; do not describe pairing codes as single-use in user-facing text.

### Chat-contacts / mesh-relay plan (approved, in progress)

A separate 8-item plan (chat contacts with no project access, direct conversations, chat profile
polish, an opt-in beta P2P mesh relay, and collaborator-suggests/owner-approves) was approved and is
being implemented in priority order 3, 8, then the rest. Status as of this entry:

- **Item 3 (Direct conversation) — backend complete, UI not started.** `ChatContactRecord`
  (`sync_security.rs`, fully separate from `grants`/project authorization — confirmed by test
  `adding_a_chat_contact_never_creates_a_grant_or_invitation`), `ensure_direct_conversation_at` +
  `sync_start_direct_conversation` (`sync_chat.rs`, Desktop command + Web route
  `/api/sync/chat/conversations/start-direct` + frontend client `syncStartDirectConversation`).
  Still missing: the "add contact" pairing-code UI (item 2), the `ChatTab.tsx` conversation list
  (item 4), and profile/avatar polish in `ChatPanel.tsx` (item 5) — `ChatPanel` still only accepts a
  `projectId`, not a `conversationId`/`otherMember` pair.
- **Item 8 (collaborator suggests, owner approves) — backend complete, UI not started.**
  `AccessKind::CollaboratorSuggestion` (`sync_access.rs`), `"invite_suggestion"` envelope kind
  (`sync_rendezvous.rs` + the Cloudflare Worker's `protocol.ts`, both validated and tested),
  `owner_account_id`/`owner_agreement_public_key` threaded onto `InvitationRecord` end to end
  (issuance → bridge envelope → cross-device redemption, all `#[serde(default)]`/backward
  compatible), `find_project_owner_for_active_grant_at` (requires an active grant — proves the
  caller is a real collaborator), and `sync_prepare_collaborator_suggestion` /
  `sync_open_collaborator_suggestion` (Desktop commands + Web routes + frontend clients), sealing the
  proposal end-to-end for the owner's own device, never the collaborator's. Tests confirm a
  suggestion alone never creates a grant or invitation, and that a grant issued before this field
  existed simply can't be used to suggest (fails closed, doesn't break). Still missing: the actual
  "Suggest a collaborator" UI action, the owner-side access-center "Convidar"/"Descartar" actions
  (pre-filling only the recipient field of the existing invite form), and wiring the frontend to
  actually call `sendRendezvousFrame({ kind: 'invite_suggestion', ... })` after sealing.
- **Items 1, 2, 4, 5, 7 (doc)** — not started.
- **Item 6 (P2P mesh relay, BETA)** — not started; the largest remaining piece of that plan.

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
