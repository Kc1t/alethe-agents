# Project Collaboration Implementation Blueprint — Phases 3–13

## Purpose

This blueprint explains how Alethe intends to implement every remaining collaboration phase. It complements `docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`, the security threat model, and the ADRs. The status document remains authoritative for what is already implemented; this blueprint describes proposed work and must never be cited as proof that a runtime capability exists.

Cloudflare is deliberately late. Phases 3 through 9 build and test the security, peer transport, project replication, tasks, and chat systems without a production rendezvous provider. Phase 10 adds optional provider configuration and implements Cloudflare as one adapter for an already-defined protocol.

## Current implementation baseline

Existing code that future phases must extend rather than replace:

- `src-tauri/src/sync_security.rs`: local verified account, device identity/trust, invitation/grant state, credential-store device keys, audit records, and sanitized snapshots.
- `src-tauri/src/sync_mesh.rs`: local Google OAuth flow and older folder/isolation/backup operations. Do not treat its historical mesh naming as evidence of a network mesh.
- `src-tauri/src/server_main/sync_security_routes.rs`: authenticated local Web routes for the same security operations exposed through Tauri.
- `src/lib/sync/contracts.ts`: frontend security/capability contracts with fail-closed parsing.
- `src/lib/sync/authorization.ts`: frontend mirror used for contract tests and presentation; backend authorization remains authoritative.
- `src/lib/api/syncSecurity.ts` and `src/lib/api/mesh.ts`: shared Desktop/Web clients.
- `src/components/ProjectSidebar/MeshSidebarView.tsx`: current local account, device, invitation, and grant UI.

Planned module names below are architectural targets, not existing files. Before creating one, inspect current module boundaries and avoid duplicating a newer equivalent.

## Cross-phase construction rules

### One Core and one domain implementation

Every operation belongs to the Rust Core first. Tauri commands and authenticated local Web routes call the same domain functions. The frontend never owns authorization, filesystem mutation, cryptographic key material, provider credentials, or durable collaboration truth.

For each new operation:

1. Define the Rust request, response, state transition, and stable error code.
2. Implement one Core function that accepts explicit dependencies and can be unit-tested without Tauri or Axum.
3. Expose a thin Tauri command.
4. Expose an equivalent authenticated Web route.
5. Add one frontend API function selecting IPC or Web transport.
6. Add capability-gated UI using localized strings.
7. Add a parity test proving both adapters invoke the same contract.

### Version every durable and network boundary

Version separately:

- security document;
- device key binding;
- invitation and grant;
- signed control envelope;
- encrypted peer frame;
- project subscription;
- manifest;
- chunk/staging journal;
- synchronization operation;
- task record and task operation;
- chat/group/message record;
- provider handshake and capability response.

Unknown required fields, unsupported versions, malformed data, or future incompatible versions fail closed. Migrations must be deterministic, atomic, restart-safe, and covered by fixtures from every prior version.

### Persist before acknowledging

Any operation whose loss would violate authorization, ordering, or user expectations must be durably and atomically recorded before success is returned. This includes invitation issuance/revocation/redemption, device revocation, accepted subscriptions, committed manifests, synchronization revisions, task mutations, message acceptance, offline-queue enqueue, and provider delivery acknowledgement.

### Separate four independent concerns

Do not collapse these states:

1. Identity: which locally verified Google account is active.
2. Device trust: whether this device key is approved for the account.
3. Project authorization: which grant permits which operations and scopes.
4. Connectivity: whether a peer or provider happens to be reachable.

A connected peer is not authorized. A trusted device is not authorized for every project. Same-account discovery does not reveal projects. An invitation is not a destination or a download instruction.

### Planned backend boundaries

The expected direction, subject to review against the repository at implementation time, is:

- `sync_security.rs`: account, device, invitation, grant, and authorization roots.
- proposed `sync_protocol.rs`: canonical versions, envelopes, message taxonomy, deterministic encoding, and validation.
- proposed `sync_crypto.rs`: device key bindings, key agreement, session derivation, AEAD, signatures, and test vectors.
- proposed `sync_transport.rs`: peer session interface, framing, streams, backpressure, cancellation, and adapters.
- proposed `sync_subscription.rs`: recipient-controlled local project subscription state.
- proposed `sync_manifest.rs`: normalized manifests, exclusions, hashes, chunks, and verification.
- proposed `sync_staging.rs`: journals, staging, recovery, and atomic publication.
- proposed `sync_engine.rs`: revision log, watcher ingestion, operation application, conflict records, and recovery.
- proposed `sync_tasks.rs`: collaboration-task domain, permissions, operations, and merge behavior. It must remain distinct from the existing local agent scheduler.
- proposed `sync_chat.rs`: conversations, membership, messages, group keys, attachments, and read state.
- proposed `sync_provider.rs`: provider-independent rendezvous interface and connection state machine.
- proposed `sync_notifications.rs`: collaboration/access-center notification projection and actions.

Do not create one oversized `sync.rs` or continue adding unrelated network/data-plane responsibilities to `sync_mesh.rs`.

## Phase 3 — Security readiness and provider-independent protocol

### Goal

Produce the cryptographic and authorization foundation that every later phase consumes. No production provider is contacted.

### Step 3.1 — Freeze the security vocabulary

Create one canonical specification for:

- opaque `AccountRouteId`;
- `DeviceId` and device-key generation;
- opaque `ProjectSyncId` unrelated to local names or paths;
- `InvitationId`, `GrantId`, `SessionId`, `MessageId`, and revision identifiers;
- permissions and implication rules;
- trust, invitation, grant, and revocation states;
- stable safe error codes.

Generate or parity-test Rust and TypeScript representations. Remove semantic duplicates only after fixtures prove compatibility.

### Step 3.2 — Complete local Google verification

Extend the current backend OAuth flow to verify the final production identity contract: issuer, audience, expiry, issued-at policy, nonce, callback state, exact redirect, refresh, revocation, invalid grant, and account switching. Tokens remain only in the OS credential boundary.

Output to collaboration code is a minimal local verified-account claim containing only what the Core needs. Never pass provider tokens into a generic sync message.

### Step 3.3 — Finalize device keys

Keep Ed25519 for identity signatures. Select a reviewed key-agreement strategy in a dedicated ADR, normally a separate X25519 key pair or reviewed binding. Sign the agreement public key with the device identity key and version the binding.

Implement creation, lookup, corruption handling, rotation, retirement, revocation, cloned-state detection, rollback detection, and all-devices-lost recovery. Never silently regenerate a missing key while preserving the old device identity.

### Step 3.4 — Define canonical signed envelopes

The planned envelope contains:

- protocol and schema version;
- message type;
- opaque sender account route and device ID;
- opaque recipient route when applicable;
- random message ID;
- issued and expiry time;
- sender generation and optional sequence/replay window;
- bounded encrypted or public payload;
- signing-key identifier;
- signature over deterministic canonical bytes.

Implement strict decoding with byte limits before allocation. Publish cross-language positive and negative vectors.

### Step 3.5 — Resolve account routing without Google tokens

Write and accept a dedicated ADR before implementation. The design must prove or safely bootstrap entitlement to an opaque account route without sending any Google access token, refresh token, authorization code, or ID token to a rendezvous provider.

Cover first device, additional-device approval, route guessing, enumeration, account switch, device revocation, route rotation, and all-devices-lost recovery. If this cannot be solved under the threat model, automatic same-account discovery remains unavailable.

### Step 3.6 — Harden local state transitions

Add atomic/concurrency tests for redeem/redeem, redeem/revoke, redeem/expiry, device revocation during redemption, grant revocation during session setup, duplicate delivery, stale acknowledgement, process interruption, credential-store failure, and audit sanitization.

### Step 3.7 — Build the capability authority

Create a backend capability resolver that derives each capability from real identity, device trust, protocol, key, authorization, transport, subscription, and provider state. The frontend consumes sanitized results and reason codes. It cannot promote a capability.

### Phase 3 failure behavior

- Missing/invalid identity: identity-dependent capabilities unavailable; local Alethe continues.
- Missing/corrupt key: affected device enters recovery; never impersonate a new key as the old device.
- Unknown envelope/version/signature: reject without detailed oracle-like errors.
- Account-routing proof unresolved: same-account discovery and provider delivery remain unavailable.

### Phase 3 proof

- Rust and TypeScript vectors match.
- Negative signature/version/replay/expiry tests pass.
- Concurrency state-machine tests pass.
- Forbidden sentinel values never appear in logs, errors, snapshots, or serialized provider fixtures.
- A security gate artifact maps every threat control to code and tests.

## Phase 4 — Encrypted provider-independent peer transport

### Goal

Create authenticated direct peer sessions without Cloudflare. Discovery and relay are interfaces, not embedded provider APIs.

### Step 4.1 — Select the transport stack

Write an ADR comparing reviewed QUIC/P2P libraries, Windows support, NAT traversal, browser compatibility, relay options, maintenance, and auditability. Iroh/QUIC may be evaluated, but it is not accepted merely because it is convenient.

### Step 4.2 — Define transport interfaces

Separate:

- `CandidateSource`: yields bounded candidate sets from manual input, LAN, fixtures, or later rendezvous.
- `PeerConnector`: establishes a byte transport to a candidate.
- `AuthenticatedSession`: performs device authentication, key agreement, version negotiation, and grant checks.
- `RelayAdapter`: optional encrypted byte forwarding; no project semantics.
- `PeerStream`: bounded typed streams with cancellation, progress, and backpressure.

Phase 4 ships loopback, controlled fixture, manual candidate, and opt-in LAN adapters. It does not ship a Cloudflare adapter.

### Step 4.3 — Establish sessions

Handshake sequence:

1. Exchange protocol ranges and random challenges.
2. Exchange versioned public device/key bindings.
3. Verify trusted device identity and revocation generation.
4. Run the reviewed ephemeral key agreement.
5. Derive directional session keys and transcript binding.
6. Authenticate the requested project/grant before project metadata.
7. Establish bounded logical streams.

### Step 4.4 — Frame and flow control

Each encrypted frame binds project, grant, sender, recipient, session, stream, sequence, content type, flags, and ciphertext length. Limit frames, streams, queued bytes, retransmission, decompression, and concurrent transfers independently.

### Step 4.5 — Reconnection and revocation

Persist only safe resume metadata. A resumed session rechecks device/grant generation and protocol compatibility. Revocation closes matching streams and invalidates resume tickets.

### Phase 4 proof

- Loopback and two-process tests authenticate distinct devices.
- Manual/LAN sessions transfer bounded random data under interruption and reconnect.
- Replay, reorder, downgrade, cross-project, oversize, cancellation, and backpressure tests pass.
- Packet captures and relay fixtures contain no plaintext.
- No test depends on Cloudflare or a public relay.

## Phase 5 — Recipient-controlled project setup

### Goal

Turn an accepted grant into a local subscription only after explicit recipient decisions.

### Step 5.1 — Persist subscription state

Create a versioned per-device subscription record with project ID, grant ID, selected destination reference, mode, effective scopes, exclusion-policy version, remote manifest revision, local state, timestamps, and recoverable error code. Local paths never enter peer or provider messages.

State machine:

`offered -> configuring -> awaiting_confirmation -> staging -> verifying -> active`

Side states: `deferred`, `declined`, `paused`, `revoked`, `error`, and `removing`.

### Step 5.2 — Destination validation

The Core validates canonical containment, traversal, symlinks/junctions, case rules, path length, permissions, collisions, free space, filesystem features, existing files, and whether the directory belongs to another subscription.

### Step 5.3 — Mode selection

Support only modes whose later runtime exists. Planned modes are manual snapshot, receive-after-confirmation, and bidirectional. Present effective permissions, expected bytes, exclusions, delete behavior, and conflict policy before confirmation.

### Step 5.4 — No-write guarantee

Invitation delivery, viewing, acceptance, defer, decline, and destination browsing perform zero project-content writes. The first staging directory is created only after final confirmation.

### Phase 5 proof

- Tests cover every state transition and restart.
- Unsafe destinations fail without partial directories.
- Existing unrelated directories are never overwritten.
- Desktop and Web show the same subscription state, while only the authorized Core performs filesystem operations.

## Phase 6 — Manifests, chunks, staging, and atomic publication

### Goal

Transfer a verified project snapshot without exposing unsafe paths or publishing partial content.

### Step 6.1 — Manifest specification

Define normalized relative-path encoding, file type, logical size, content hash, executable/permission policy, optional chunk list, exclusion-policy version, project revision, author device, and signature. Reject absolute paths, traversal, device paths, sockets, unsupported links, duplicate normalized paths, case collisions, and impossible sizes.

### Step 6.2 — Exclusion policy

Default-deny credentials and private Alethe data. Define reviewed categories for environment files, credential stores, agent transcripts, terminal scrollback, `.git`, dependencies, build output, caches, backups, hidden metadata, and user overrides. The UI shows exclusions without sending local names to a provider.

### Step 6.3 — Chunking and verification

Select bounded chunk sizes and cryptographic hashes. Verify count, total bytes, per-chunk hash, reconstructed file hash, manifest signature, current grant, destination, disk reservation, and quota. Avoid cross-account deduplication that leaks content equality.

### Step 6.4 — Staging journal

Persist a journal containing expected manifest, received chunks, verification state, reserved space, temporary locations, publication intent, and cleanup status. Every update is atomic and restart-safe.

### Step 6.5 — Atomic publication

Build a complete verified tree outside the live destination, fsync where required, preserve the recoverable prior tree, atomically switch publication, then clean old staging according to retention. Never mix old and new trees.

### Phase 6 proof

- Property/fuzz tests reject unsafe manifests and paths.
- Corrupt, duplicate, missing, truncated, substituted, or oversized chunks never publish.
- Crash injection at every journal/publication boundary yields either the previous valid tree or the new verified tree.
- Low-disk and disappearing-space scenarios remain recoverable.

## Phase 7 — Continuous synchronization and conflicts

### Goal

Maintain authorized replicas without silent data loss.

### Step 7.1 — Revision and operation model

Define stable project revisions and signed operations for create, update, rename, delete, metadata change, and conflict resolution. Do not use modification time as sole truth.

### Step 7.2 — Watcher ingestion

Coalesce noisy filesystem events, detect watcher overflow, rescan deterministically, normalize case-only rename, handle editor temporary files, and exclude staging/internal paths. Bound debounce queues and memory.

### Step 7.3 — Authorization at application time

Recheck device, grant, permission, scope, subscription mode, base revision, path safety, and revocation for every operation immediately before mutation. Authorization captured when queued is insufficient.

### Step 7.4 — Conflict records

When histories diverge, persist both inputs and a conflict record. Provide keep local, keep remote, keep both, and reviewed text merge. Never use silent last-writer-wins for project files.

### Step 7.5 — Recovery controls

Add pause per project/peer, cancel, resume, rescan, repair from manifest, rollback to preserved revision, restore, peer removal, and long-offline reconciliation.

### Phase 7 proof

- Two-process deterministic tests cover simultaneous edits, rename/delete races, case collisions, offline divergence, revocation, interruption, and watcher overflow.
- Conflict resolution is repeatable and audited.
- No unauthorized operation applies after revocation.
- Memory, queues, caches, and disk journals remain bounded in soak tests.

## Phase 8 — Shared collaboration tasks

### Goal

Add human collaboration tasks without confusing them with the existing local agent scheduler in `scheduler.rs`.

### Step 8.1 — Separate domain model

Planned records include task ID, project ID, visibility domain, membership, title/body ciphertext, author, assignees, status, labels, due date, revision, timestamps, tombstone, and audit-safe metadata. Restricted task existence must not leak through counts or errors.

### Step 8.2 — Operation model

Define signed create/update/assign/complete/reopen/comment/delete/restore operations with expected base revision and permission requirements. Use deterministic conflicts for incompatible offline edits rather than overwriting.

### Step 8.3 — Independent synchronization

Task replication uses its own logical stream and journal. Pausing file transfer must not corrupt or block task state unless the user pauses the whole collaboration session.

### Step 8.4 — UI projection

Expose project-public and restricted views, assignment, filters, due state, and conflict indicators. All strings are localized and every action is reauthorized by the Core.

### Phase 8 proof

- Restricted tasks do not leak through lists, counts, notifications, search, export, or timing-oriented error differences within policy.
- Offline concurrent operations converge or create an explicit conflict.
- Task and local scheduler identifiers/stores never collide.
- File-transfer pause and task replication are independently testable.

## Phase 9 — Chat, groups, and attachments

### Goal

Create programmer-focused communication whose server/provider never receives plaintext.

### Step 9.1 — Conversation and membership model

Define direct conversations, project channels, private groups, categories, threads, membership generations, roles, message IDs, revisions, reactions, mentions, read cursors, retention, and tombstones. Categories organize; they do not authorize.

### Step 9.2 — Key management

Evaluate a reviewed RFC 9420 MLS implementation for groups and document the decision. Direct messages also require forward secrecy and authenticated device membership. Membership removal rotates keys and prevents new content access; history rules are explicit.

### Step 9.3 — Message operations

Define encrypted create/edit/delete/react/read/mention operations with stable ordering and duplicate behavior. Offline delivery is tested through the local provider fixture until Phase 10.

### Step 9.4 — Programmer content

Support bounded code blocks, structured test results, bug reports, images, files, and command text. Received commands are inert text and never execute automatically. Attachment keys are separate, scoped, rotatable, and authorized.

### Step 9.5 — Attachment safety

Validate declared/actual type, size, decompression, filename handling at the recipient boundary, preview policy, quarantine, and destination consent. The provider later sees only opaque ciphertext envelopes and size/timing metadata.

### Phase 9 proof

- Removed members cannot decrypt new messages or attachment keys.
- Duplicate/offline/reordered messages behave deterministically.
- Commands never execute on receipt, preview, copy, or notification action.
- Fuzz tests cover message/attachment envelopes.
- All behavior passes through controlled provider-independent fixtures.

## Phase 10A — Optional provider activation and configuration

### Goal

Add truthful optional service configuration only after the collaboration engine works without Cloudflare.

### Step 10A.1 — Provider interface

The proposed `sync_provider.rs` exposes provider-neutral operations: inspect compatibility, connect, authenticate device, publish presence, enqueue encrypted envelope, acknowledge delivery, exchange connection candidates, publish revocation generation, close, and report sanitized status.

No domain module imports Cloudflare SDK types. Provider errors become stable Alethe codes such as disabled, identity required, incompatible, rate limited, quota exhausted, unavailable, TLS rejected, and retry later.

### Step 10A.2 — Persist non-secret settings

Store only mode (`local_only`, `alethe_managed`, `custom`), enabled flag, validated endpoint reference, last compatible protocol, and safe UI preferences. Never persist Cloudflare API tokens in Alethe settings.

### Step 10A.3 — Activation state machine

`disabled -> identity_required -> ready -> connecting -> online`

Transient failure enters `retrying`; incompatible/security/provider failures enter `needs_attention`; a surviving authenticated P2P session may expose `direct_only`.

### Step 10A.4 — Contextual UX

Prompt only when the user requests automatic remote invitation delivery, same-account discovery, remote presence, or a new cross-network session. Explain provider-visible metadata. Offer the Alethe-managed endpoint by default and custom endpoint only under advanced settings.

### Step 10A.5 — Capability integration

Derive remote delivery/presence/candidate capabilities from real authenticated provider state. Provider configuration alone is not connection. Provider failure never disables local Alethe or widens authorization.

### Phase 10A proof

- Local-only default makes zero provider connection attempts.
- Activation/cancellation/custom endpoint/provider switching are tested.
- No silent fallback occurs.
- Desktop/Web consume the same Core state.
- Provider failure preserves Phases 3–9 functionality that does not require new remote routing.

## Phase 10B — Cloudflare rendezvous adapter

### Goal

Implement Cloudflare Workers and SQLite-backed Durable Objects as the reference adapter for the existing protocol.

### Step 10B.1 — Isolated service package

Create a dedicated service package after confirming workspace conventions. It contains the Worker entry point, Durable Object class, Wrangler configuration, schema declarations, local/staging tests, and deployment documentation. Operator credentials never enter the desktop bundle.

### Step 10B.2 — Partitioning and records

Partition by reviewed opaque account route. Persist only public device metadata, attached socket metadata, encrypted mailbox envelopes, acknowledgement/idempotency state, replay windows, revocation generation, bounded abuse counters, and cleanup cursors. Every table has TTL/count/byte limits.

### Step 10B.3 — Hibernatable WebSocket

Each enabled device opens one logical WebSocket, not one per project/group/message. Use challenge-response device authentication and Durable Object WebSocket Hibernation. Native ping/pong or auto-response handles liveness; avoid frequent JSON heartbeat traffic.

### Step 10B.4 — Invitation routing

The sender Core creates and encrypts the invitation envelope. The service atomically enqueues ciphertext with expiry/idempotency, delivers it when the recipient connects, and records acknowledgement without learning the bearer or project data. Revocation/expiry wins over queued delivery.

### Step 10B.5 — Presence and candidates

Presence is advisory and generation-based. Candidate envelopes are bounded, encrypted where required, short-lived, and never authorization. The client tries valid existing/manual/LAN routes before requesting refreshed provider candidates.

### Step 10B.6 — Abuse, quota, and failure

Limit upgrades, authentication failures, sockets, frames, bytes, mailbox depth, fan-out, candidates, writes, reads, and error size by account/device/IP. IP is a secondary abuse signal, never identity. Quota exhaustion fails closed and never triggers an unknown fallback.

### Step 10B.7 — Operations

Document staging/production separation, retention, deletion, schema migration, rollback, sanitized metrics, alerts, incident response, Cloudflare suspension, paid-plan budget, state export, and compatible provider replacement.

### Phase 10B proof

- Real staging tests cover online/offline invite, expiry, revocation, duplicate delivery, reconnect, changed IP/NAT, version mismatch, quota exhaustion, provider outage, and custom-provider compatibility.
- Stored/logged/metric data passes forbidden-sentinel tests.
- Removing the adapter leaves local Alethe and provider-independent collaboration intact.
- No production deployment occurs without explicit authorization.

## Phase 11 — Notifications and access center

### Implementation

Project domain events into one local access-center store with separate security and collaboration categories. Use opaque action handles that revalidate current state in the Core when clicked. Support unread, dismiss, defer, retry, and deep links. Native notifications contain minimal localized text; private content, bearer values, and full paths remain in-app only after authorization.

### Proof

- Stale actions cannot accept expired invitations, restore revoked access, or resume unauthorized transfers.
- Native delivery failure produces an in-app fallback.
- Windows, Linux, macOS, Desktop, and Web formatting/action behavior is tested where supported.

## Phase 12 — Security, abuse resistance, privacy, and operations

### Implementation

Re-run the threat model against the completed system. Add independent bounds for every parser, buffer, queue, cache, stream, attachment, mailbox, account, device, project, and IP signal. Complete key rotation, credential deletion, account export/deletion, device recovery, project-access deletion, audit retention, provider migration, relay policy, backup restore, incident response, and operator access control.

Run dependency/license/vulnerability review and targeted external security review for cryptography, account routing, provider boundaries, manifests, filesystem publication, MLS/group membership, and recovery.

### Proof

- Abuse tests cannot exhaust unbounded memory/disk/CPU or bypass authorization.
- Privacy inventory matches real captures and persisted state.
- Recovery drills and provider migration complete without plaintext exposure or silent grant expansion.

## Phase 13 — Test and release program

### Test pyramid

1. Pure Rust state-machine and parser tests.
2. TypeScript contract/parser/capability tests.
3. Rust/TypeScript shared vectors.
4. Persistence migration and crash-injection tests.
5. IPC/HTTP parity tests.
6. Two-process peer transport and sync tests.
7. Local provider-fixture tests.
8. Cloudflare staging integration tests.
9. Desktop/Web isolated E2E tests using real UI actions.
10. Multi-machine/network/firewall/NAT/IPv4/IPv6/reconnect tests.
11. Performance, memory, disk, queue, and long-idle soak tests.
12. Security, fuzz, property, abuse, and forbidden-data tests.

### Release gates

- Capabilities are derived from the running backend and compatible protocol.
- No placeholder or fabricated success remains.
- Production Google and Cloudflare configurations are injected without client secrets.
- Retention, deletion, privacy disclosure, incident response, support, migration, rollback, and paid infrastructure budget are approved.
- Installer smoke tests pass on supported platforms.
- No known critical/high security issue remains unresolved.
- Documentation and Graphify match the shipped implementation.

## Per-phase delivery template

For every phase:

1. Re-read the authoritative plan, threat model, ADRs, this blueprint, and repository rules.
2. Query Graphify and inspect the current worktree before editing.
3. Write or update the phase ADR/spec and enumerate explicit non-goals.
4. Implement Core domain logic and pure tests first.
5. Add persistence and migration tests.
6. Add Tauri/Web adapters and parity tests.
7. Add frontend API and truthful capability-gated UI.
8. Add localized English and pt-BR strings.
9. Update `[Unreleased]` and phase status.
10. Run focused validation, then all required layers from the testing skill.
11. Run `graphify update .` after code changes.
12. Inspect the final diff, preserve unrelated user work, and stop without committing unless explicitly authorized.

The next implementation phase is Phase 3. Cloudflare work begins only in Phase 10.
