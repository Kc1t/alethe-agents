# Execution Prompt — Security Gate and Optional Cloudflare Rendezvous

Use the following prompt to resume Alethe project collaboration work. It is intentionally strict and detailed. Treat the repository state and authoritative documents as the source of truth; never claim a capability based only on a type, mock, UI control, configuration value, or successful health request.

---

You are implementing the remaining provider-independent collaboration systems and the later optional Cloudflare adapter in `C:\alethe-agents`.

## Primary objective

Deliver the work in this exact architectural order, with a separate reviewed delivery for each phase:

1. Phase 3: pass the security-readiness gate and define the provider-independent control protocol.
2. Phase 4: implement encrypted peer transport behind provider-independent discovery and relay interfaces, using loopback, LAN, manual candidates, and controlled fixtures.
3. Phase 5: implement recipient-controlled project setup.
4. Phase 6: implement manifests, staging, integrity verification, and atomic publication.
5. Phase 7: implement continuous synchronization, conflicts, interruption recovery, and reauthorization.
6. Phase 8: implement the shared-task domain and authorization model.
7. Phase 9: implement the chat domain, group authorization, content encryption, attachment safety, and offline behavior.
8. Phase 10A: implement optional collaboration-service configuration, contextual activation, connection state, and capability gating.
9. Phase 10B: implement the Cloudflare adapter for the already-tested rendezvous protocol, including remote invitation delivery, presence, and connection signaling.

The next action is Phase 3 only. Do not jump from the security gate directly to Cloudflare. Cloudflare-specific client runtime code, Worker deployment, and provider-backed capabilities are forbidden until Phases 3 through 9 pass their acceptance criteria. Stop after Phase 10B; notifications, operational hardening, release validation, and any production deployment remain separate reviewed work.

## Required orientation before any edit

1. Read completely:
   - `AGENTS.md`.
   - `docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`.
   - `docs/security/PROJECT_SYNC_THREAT_MODEL.md`.
   - `docs/adr/ADR-0001-project-sync-security-and-transport.md`.
   - `docs/adr/ADR-0002-optional-cloudflare-rendezvous.md`.
   - `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md`.
   - `.agents/skills/testing-app/SKILL.md`.
2. Use Graphify first because `graphify-out/graph.json` exists. Query identity, device security, invitations, capabilities, Desktop/Web transport, settings, and server runtime before browsing broad source files.
3. Inspect `git status --short`. Preserve all user changes. Do not modify or normalize unrelated files, especially an already modified `src-tauri/Cargo.toml`, until its exact existing diff and ownership are understood.
4. Do not stop or restart the active Tauri/Vite development processes. Use HMR for frontend changes. Use isolated test targets for rebuilt desktop binaries.
5. Do not commit, push, tag, release, deploy production infrastructure, or modify the pull request without explicit owner authorization at that moment.
6. Write all versioned code, comments, logs, documentation, changelog entries, test names, and UI source strings in English. Put translated visible text in both `en.ts` and `pt-BR.ts`.

## Non-negotiable privacy boundary

The rendezvous service may observe only what routing and abuse prevention require:

- opaque account-routing identifiers;
- opaque device identifiers;
- device public keys and public-key fingerprints;
- protocol and capability versions;
- online/offline state;
- source IP addresses visible at the network boundary;
- connection timing;
- ciphertext sizes;
- opaque message/invitation identifiers;
- bounded expiry, delivery, and abuse-control metadata.

It must never receive, persist, log, trace, or expose:

- Google OAuth access tokens, refresh tokens, authorization codes, ID tokens, cookies, client secrets, or other Google credentials;
- device private keys or unwrapped session keys;
- invitation bearer secrets in plaintext server storage or logs;
- local absolute or relative paths;
- filenames, directory names, project names, workspace names, repository names, or manifests;
- project-file content;
- task or chat plaintext;
- command, terminal, agent transcript, or shell content;
- recipient destination paths;
- credential-store values;
- raw account email addresses if an opaque route is sufficient.

If any proposed design requires a forbidden field, stop. Do not weaken the threat model. Record the blocker and propose a design that keeps the field local.

## Architectural boundary

- Cloudflare Workers plus SQLite-backed Durable Objects is the reference Phase 10 rendezvous provider.
- Cloudflare is the control plane, not the project-data plane.
- The Alethe operator owns the official Cloudflare deployment. Ordinary users do not create Cloudflare accounts or supply Cloudflare API tokens.
- Online collaboration is optional. Local projects, agents, terminals, settings, local device identity, and local invitation records must remain functional without it.
- The client communicates through a provider-independent, versioned Alethe rendezvous interface. An advanced user may configure a compatible endpoint, but Cloudflare APIs must not leak into authorization, invitation, or peer-transport domain code.
- One enabled device maintains at most one logical rendezvous control connection. Do not create a service connection per project, friend, group, file, task, or chat message.
- Existing authenticated peer sessions may continue during a rendezvous outage when authorization policy permits. Starting or repairing cross-network sessions may require rendezvous again.
- An encrypted relay is a separate Phase 4 decision. Do not send project content through the Worker as a shortcut.

## Phase 3 — Security readiness and provider-independent protocol

Do not contact a production rendezvous endpoint during this phase. Test doubles and local loopback fixtures are allowed.

### 3.1 Establish an auditable gate artifact

Create one versioned checklist or machine-readable test summary that maps every gate item to:

- implementation location;
- authoritative test;
- current status;
- unresolved risk;
- reviewer evidence.

The gate must be deny-by-default. An omitted or unknown item is a failure, not a warning.

### 3.2 Complete Google identity validation locally

- Verify issuer, audience, expiry, issued-at constraints, nonce, callback state, and exact redirect behavior according to the final Desktop OAuth design.
- Implement bounded token refresh and invalid-grant recovery.
- Keep every Google token in the backend credential boundary.
- Never expose a Google token to frontend state, logs, rendezvous frames, URLs, crash reports, or public snapshots.
- Separate “Google account verified locally” from “device trusted,” “project authorized,” and “rendezvous connected.” None implies another.
- Add negative tests for wrong issuer, wrong audience, expired token, nonce mismatch, state mismatch, callback replay, refresh failure, revoked credentials, and malformed provider responses.

### 3.3 Harden device identity and key lifecycle

- Preserve Ed25519 as the existing device identity/signature key unless a reviewed ADR explicitly changes it.
- Select a reviewed key-agreement/encryption strategy, normally a separate X25519 key or a reviewed conversion/binding mechanism. Never use an Ed25519 signing key directly as an ad hoc encryption key.
- Bind every agreement/encryption public key to the Ed25519 device identity with a signed, versioned statement.
- Define creation, persistence, fingerprinting, approval, rotation, retirement, revocation, cloned-state detection, rollback detection, and all-devices-lost recovery.
- Ensure private material stays in the operating-system credential store and is deleted or retired according to the revocation design.
- Add tests for missing keys, corrupted keys, duplicated device documents, rotated keys, stale public bindings, revoked devices, and credential-store failures.

### 3.4 Define canonical signed control envelopes

Create a provider-independent protocol specification and matching Rust/TypeScript contracts containing at least:

- protocol version;
- message type and schema version;
- opaque sender account route;
- sender device ID;
- intended opaque recipient account/device route when applicable;
- random unique message ID;
- issued-at and expires-at timestamps;
- sequence or replay-window data where required;
- payload encoding and strict byte limit;
- signing-key identifier;
- signature over deterministic canonical bytes.

Define deterministic serialization and publish shared test vectors. Rust and TypeScript must accept and reject the same vectors. Reject unknown required fields, incompatible versions, invalid canonical encoding, invalid signatures, oversize frames, expired frames, unreasonable future timestamps, duplicate IDs, and forbidden message transitions.

### 3.5 Specify replay, ordering, and clock behavior

- Bound replay caches by account/device, time, and count.
- Define duplicate acknowledgement behavior so retries are idempotent.
- Define which messages require ordering and which are independent.
- Do not trust client clocks without bounded skew rules.
- Ensure an offline queue cannot revive an expired or revoked invitation.
- Ensure a stale presence or connection offer cannot replace a newer generation.
- Add deterministic concurrency and restart tests.

### 3.6 Harden invitation and grant transitions

Extend the existing local Phase 2 state machine rather than creating a second server-specific invitation model.

Test at minimum:

- simultaneous redeem/redeem;
- redeem/revoke races;
- redeem/expiry races;
- device revocation during redemption;
- grant revocation during connection establishment;
- process interruption before and after durable state publication;
- duplicate remote delivery;
- stale acknowledgement;
- wrong account and wrong device without account enumeration;
- bearer replay and bounded failure lockout;
- audit events that contain no bearer secret.

Remote delivery must transport the existing authorization object or a strictly versioned envelope around it. It must not silently change permission semantics.

### 3.7 Resolve opaque Google-account routing

This is a hard blocker, not a later detail.

Design and document how two devices that locally verified the same Google account derive or obtain a common opaque routing identity without sending a Google access token, refresh token, authorization code, or ID token to the rendezvous service.

The design must address:

- proof that a device is entitled to claim the route;
- first-device bootstrap;
- additional-device approval;
- account enumeration;
- route guessing and spam;
- account switching;
- device revocation;
- all-devices-lost recovery;
- rotation if a route identifier leaks;
- separation between account discovery and project authorization.

Write a dedicated ADR. Include threat analysis and test vectors. Do not implement automatic same-account discovery until the ADR is accepted.

### 3.8 Sanitize every observable surface

Review logs, metrics, traces, errors, analytics, public snapshots, serialized state, test snapshots, support bundles, and crash reports.

- Use event categories and opaque IDs instead of payload dumps.
- Truncate and classify errors before exposing them to the frontend.
- Never log complete signed envelopes if they may contain invitation ciphertext or bearer material.
- Add automated assertions that serialize representative failures and search for forbidden sentinel values.
- Document exactly what the operator can observe.

### 3.9 Security gate acceptance

Phase 3 passes only when:

- every required test is green;
- the account-routing ADR is accepted;
- the key-agreement ADR is accepted;
- cross-language envelope vectors match;
- replay, expiry, revocation, and concurrency tests pass;
- a forbidden-data leakage test passes;
- Desktop IPC and authenticated Web routes expose equivalent safe operations;
- unsupported and missing capabilities fail closed;
- a reviewer can trace each threat-model control to code and tests.

If any item fails, stop before Phase 4 and report the exact blocker.

## Phases 4–9 — Provider-independent collaboration systems

Cloudflare must not be introduced during these phases. Every system must be testable through local deterministic fixtures, loopback, LAN, manual connection candidates, or another controlled provider-independent harness. A test rendezvous adapter may exist only as an in-memory or local fixture implementing the public protocol contract; it must not become a hidden production provider.

### Phase 4 — Encrypted peer transport

- Authenticate both device identities before exposing project metadata.
- Use the reviewed Phase 3 key-agreement design and forward-secret session keys.
- Bind frames to protocol, account, device, project, grant, stream, sequence, and content type.
- Reject replay, downgrade, cross-project substitution, truncation, unsafe reordering, decompression abuse, and oversized frames.
- Separate discovery, direct transport, and relay behind explicit interfaces.
- Validate direct sessions with loopback, LAN, manual candidates, IPv4/IPv6 fixtures, reconnect, interruption, revocation, and backpressure.
- Do not choose Cloudflare merely to make test peers discoverable.

Phase 4 passes only when encrypted peers can authenticate, exchange bounded test data, reconnect, and terminate on revocation without any production rendezvous provider.

### Phase 5 — Recipient-controlled setup

- Preserve invitation acceptance as authorization only.
- Require the recipient to select and confirm destination, mode, permissions, expected size, exclusions, and destructive behavior.
- Validate containment, traversal, symlinks, collisions, free space, filesystem permissions, path length, and existing-copy comparison.
- Keep offered, configuring, deferred, declined, staging, verifying, active, paused, revoked, and error states explicit.

Phase 5 passes only when no destination write happens before explicit recipient confirmation and every unsafe destination fails closed.

### Phase 6 — Manifests, staging, and atomic publication

- Define deterministic signed manifests using normalized relative paths only.
- Exclude secrets, credentials, generated directories, sockets, devices, unsafe links, and private Alethe metadata by default.
- Chunk and hash content with bounded memory and queue use.
- Stage outside the live tree, verify authorization/signature/hash/size/count/quota, and publish atomically.
- Preserve a recoverable prior version and test crashes at every publication boundary.

Phase 6 passes only when corrupt, substituted, partial, unauthorized, or unsafe content never reaches the live project.

### Phase 7 — Synchronization, conflicts, and recovery

- Track stable revisions rather than modification timestamps alone.
- Reauthorize every operation against current grants and scopes.
- Handle rename, delete, offline edit, watcher overflow, case changes, permissions, pause, resume, cancellation, and long interruptions.
- Record conflicts explicitly; never silently overwrite concurrent edits.
- Test keep local, keep remote, keep both, safe merge, repair, rollback, and restore.

Phase 7 passes only when interruption, reconnection, concurrent edits, and revocation cannot produce silent data loss or unauthorized mutation.

### Phase 8 — Shared tasks

- Define task identity, revision, authorship, assignment, visibility, membership, labels, due dates, comments if included, deletion, retention, and audit behavior.
- Keep restricted tasks invisible through lists, counts, notifications, search, export, and error behavior.
- Define deterministic offline conflict behavior independently of project-file transfer.

Phase 8 passes only when authorization and offline/concurrent behavior are complete over the provider-independent transport and fixtures.

### Phase 9 — Chat, groups, and attachments

- Define direct messages, project channels, private groups, categories, threads, membership, mentions, reactions, read state, retention, and deletion.
- Keep chat membership separate from project-file permissions.
- Select and review group key management before enabling groups.
- Encrypt content and attachment keys end to end.
- Bound and inspect attachments safely without server plaintext; receiving commands must never execute them.
- Define offline ordering, duplicate delivery, conflict, membership removal, key rotation, and history access.

Phase 9 passes only when chat and group authorization, encryption, offline behavior, and attachment safety work through controlled provider-independent fixtures. Passing Phase 9 does not make Cloudflare available; it only clears the final prerequisite for Phase 10.

## Phase 10A — Optional provider configuration and activation

Begin only after Phases 3 through 9 pass and their evidence is recorded.

### 10A.1 Domain model

Define provider-independent types for:

- provider mode: `local_only`, `alethe_managed`, `custom`;
- activation: `disabled`, `enabled`;
- connection state: `disabled`, `identity_required`, `ready`, `connecting`, `online`, `retrying`, `direct_only`, `needs_attention`;
- capability reasons with stable machine codes and localized descriptions;
- sanitized provider status containing no credential or sensitive endpoint detail beyond what the user configured.

Do not put Cloudflare API tokens or deployment credentials in Alethe preferences. Persist only non-secret choices such as enabled state, provider mode, and validated custom endpoint.

### 10A.2 Intelligent activation behavior

- Default to local-only with no rendezvous connection.
- Offer opt-in when the user first tries automatic remote invitation delivery, same-account discovery, remote presence, or new cross-network connection negotiation.
- Do not prompt during unrelated local work.
- Explain that Alethe’s operator provides the default service and that the user does not need a Cloudflare account.
- Explain visible metadata: opaque identifiers, public keys, online state, IP visible to the network edge, timing, and ciphertext size.
- Allow cancellation without damaging the local invitation or project.
- When a user opens an out-of-band invitation link while disabled, preserve the link safely, offer activation, and continue only after real service readiness.

### 10A.3 Official and custom provider modes

- The official endpoint comes from signed release configuration or another reviewed immutable/signed mechanism.
- A custom endpoint is an advanced option, never a first-run requirement.
- Require `wss://` in production. Permit loopback development exceptions only behind explicit development configuration.
- Validate endpoint syntax, TLS, server identity, supported protocol range, maximum frame size, privacy policy identifier, and health before reporting `ready` or `online`.
- Never silently fall back from a custom endpoint to the official service or from the official service to a public third party.
- Changing providers must close the old control session, clear provider-scoped replay/presence caches, and require a fresh authenticated handshake without deleting local grants.

### 10A.4 Capability resolver

Derive UI availability from real backend state:

- local invitation-link creation may remain available without rendezvous;
- automatic remote invitation delivery requires verified local identity, trusted device, enabled provider, compatible service, and an online authenticated control session;
- same-account discovery requires the accepted account-routing proof;
- new P2P negotiation requires current authorization plus either a safe known route or rendezvous signaling;
- project transfer, shared tasks, and chat are exposed only if their earlier phases have real passing runtime capabilities; Phase 10 must not fabricate or broaden them;
- immediate revocation delivery reports degraded when rendezvous is unavailable.

The backend is authoritative. The frontend may present reasons but cannot grant capability by changing local preferences.

### 10A.5 UI requirements

- Use the existing settings and Mesh surfaces; do not create duplicate account/provider logic.
- Follow CSS Modules and tokens from `src/styles/theme.css`; no gradients, hardcoded colors, or inline styling in touched UI.
- Add every visible string to `src/lib/i18n/messages/en.ts` and `pt-BR.ts`.
- Clearly distinguish “configured,” “connecting,” and “online.”
- Show a precise action for disabled, identity-required, retrying, incompatible, quota-exhausted, and provider-unavailable states.
- Do not label Cloudflare as a user account integration. Label it as the Alethe collaboration service; show infrastructure/provider details only in advanced settings.
- Keep security actions visually separate from normal collaboration notifications.

### 10A.6 Phase 10A tests

Add tests for:

- default local-only state and zero connection attempt;
- contextual activation triggers and cancellation;
- official endpoint selection;
- custom endpoint validation;
- no silent provider fallback;
- persisted non-secret settings and migration/backfill;
- capability resolution across all state combinations;
- provider failure preserving local functionality;
- accurate localized status and accessibility behavior;
- Desktop/Web parity through the shared Core API.

Do not mark Phase 10A complete from UI tests alone. The backend state machine and capability resolver must be tested directly.

## Phase 10B — Cloudflare rendezvous and remote invitations

Begin only after Phase 10A passes.

### 10B.1 Service layout and deployment isolation

Add the rendezvous service in a clearly isolated repository location selected after inspecting existing workspace conventions. Prefer a dedicated service package rather than embedding Cloudflare-specific code in the desktop frontend.

The service must include:

- Worker entry point for HTTPS/WebSocket upgrade and bounded health/version discovery;
- SQLite-backed Durable Object class for account-scoped coordination;
- declarative Durable Object export/binding configuration;
- separate local, staging, and production environments;
- explicit compatibility date and pinned dependencies;
- deployment documentation that never places operator credentials in the desktop repository or application bundle.

Do not deploy production without explicit owner authorization.

### 10B.2 Durable Object partitioning and storage

Use an opaque account route or another reviewed shard key. Never use raw email, project name, or path.

Define bounded records for:

- registered public devices and trust generation;
- attached WebSocket sessions and resume metadata;
- encrypted mailbox envelopes;
- delivery acknowledgements and idempotency;
- replay windows;
- revocation generation;
- abuse counters;
- expiry and cleanup cursors.

Every record must have a retention rule. Enforce maximum devices, sockets, queued envelopes, envelope bytes, TTL, writes, and reads per account/device/IP. Cleanup must be resumable and bounded; do not scan unbounded tables during a request.

### 10B.3 WebSocket lifecycle

- One client-to-service WebSocket per enabled Alethe device.
- Use Durable Object WebSocket Hibernation so idle users do not keep compute active.
- Use native protocol ping/pong or hibernation auto-response for liveness; do not send frequent JSON heartbeat messages.
- Authenticate through a server challenge signed by the registered device identity.
- Bind a socket to protocol version, opaque account route, device ID, public-key generation, and connection generation.
- Replace stale sessions deterministically.
- On wake or constructor restart, reconstruct only bounded session metadata.
- Apply exponential reconnect with jitter on the client and explicit retry hints from the server.

### 10B.4 Minimum protocol messages

Specify and implement only the messages required for Phase 10:

- protocol hello and compatibility result;
- random authentication challenge;
- signed device registration/authentication;
- presence generation update;
- device-list delta for authorized same-account discovery;
- encrypted invitation enqueue;
- encrypted invitation delivery;
- delivery acknowledgement;
- invitation/grant/device revocation notification;
- connection-offer/candidate envelope;
- idempotent error response with stable safe code;
- graceful session replacement and close.

Every application message uses the canonical Phase 3 envelope. Reject unknown or oversized messages before storage. Never echo attacker-controlled raw content into logs or error text.

### 10B.5 Invitation behavior

- Reuse the existing invitation/grant state machine.
- Encrypt the remote envelope for the intended recipient device or reviewed account mailbox scheme before it leaves the local Core.
- Store ciphertext only with opaque routing metadata and bounded expiry.
- Do not allow delivery after invitation expiry or revocation.
- Make enqueue and idempotency durable before acknowledging the sender.
- Make delivery acknowledgement idempotent.
- Duplicate delivery must not create a duplicate grant.
- Recipient viewing, accepting, refusing, deferring, or dismissing an invitation performs no project-content read and no destination write.
- If collaboration is disabled, the recipient may retain and later open the out-of-band link; the provider does not force activation.
- Do not reveal whether an arbitrary account exists.

### 10B.6 Presence and reconnection

- Presence is advisory, bounded, and never authorization.
- Avoid periodic application-level heartbeats when WebSocket liveness suffices.
- When peer transport later exists, retry a still-authenticated existing session and safe cached endpoints first.
- Request new candidates when network identity or NAT mapping changes, cached candidates expire, or direct recovery fails.
- A rendezvous outage must expose `direct_only` or `needs_attention`, not log the user out of local Alethe.
- Revocation freshness must have an explicit policy; do not imply immediate remote revocation while the control channel is unavailable.

### 10B.7 Abuse and quota behavior

Implement layered limits by opaque account, device, connection, and source IP without using IP as identity.

Bound at minimum:

- WebSocket upgrades;
- authentication failures;
- registrations;
- concurrent sockets;
- messages per interval;
- envelope bytes;
- queued mailbox count and bytes;
- invitation fan-out;
- candidate updates;
- replay-cache entries;
- storage writes and reads;
- error response size.

When a free-plan or provider quota is exhausted, fail closed with a safe retryable status. Never reroute through an unapproved service. Document what functionality remains local.

### 10B.8 Observability and operations

Document and test:

- sanitized metrics and structured event categories;
- retention and deletion;
- staging before production;
- schema evolution and rollback;
- provider quota dashboards and alerts;
- incident response and key/provider compromise;
- export or migration of non-secret service state;
- a paid-plan budget before public production;
- behavior if the Cloudflare account, Worker, Durable Object namespace, or `workers.dev` route is suspended or removed.

Observability must never include forbidden content. Use counts, latency histograms, safe error codes, and opaque identifiers with bounded retention.

### 10B.9 Required test matrix

Test locally and in isolated staging:

- two devices on one account;
- two accounts with a project invitation;
- recipient online and offline;
- expiry before delivery;
- revocation before and after enqueue;
- duplicate enqueue, delivery, and acknowledgement;
- wrong account/device/signature;
- replay after process and Durable Object restart;
- clock skew;
- incompatible protocol versions;
- malformed and oversized frames;
- queue and rate limits;
- Wi-Fi/network interruption and reconnect;
- changed public IP/NAT mapping;
- multiple groups without per-group service connections;
- provider outage and recovery;
- quota exhaustion;
- custom provider compatibility;
- Desktop and authenticated Web clients sharing one Core state;
- absence of forbidden sentinel values in requests, storage, logs, metrics, and errors.

Use real UI clicks for E2E actions. Keep all E2E profiles isolated from the owner’s application data and never kill the active development app.

## Documentation and change-control requirements

For every implementation slice:

- update `docs/CHANGELOG.md` under `[Unreleased]` with an objective English user-facing entry;
- update the collaboration plan’s status and limitations honestly;
- update or add ADRs when cryptography, account routing, provider behavior, retention, or relay boundaries change;
- document environment variables without committing secrets;
- document local/staging deployment and rollback;
- run `graphify update .` after code changes;
- inspect `git diff` and `git diff --check`;
- do not commit until the owner explicitly authorizes it.

## Validation sequence

Choose focused commands first, then the complete relevant layers:

```powershell
npx eslint <touched TypeScript and TSX files>
npx prettier --check <touched frontend and documentation files>
npx tsc --noEmit
npm test
npm run test:rust
npm run build
git diff --check
graphify update .
```

After real rendezvous and cross-client behavior exists, run the isolated sync/E2E build and suites described in `.agents/skills/testing-app/SKILL.md`. Do not use the owner’s real profile. Do not restart the already-running development app merely to test.

If Cloudflare service tests introduce their own test command, add it to `package.json`, document it, and include it in the required validation sequence. Pin the runtime and dependencies used by CI and deployment.

## Mandatory stop conditions

Stop and report a blocker rather than improvising if:

- the account-routing proof would require sending a Google token to Cloudflare;
- a private device or session key would leave the local Core unwrapped;
- a provider message would contain a path, filename, project name, manifest, or plaintext collaboration content;
- device authentication, replay protection, or deterministic envelope encoding is unresolved;
- an existing user change overlaps a required edit and ownership cannot be determined;
- a production deploy, domain change, paid-plan activation, secret creation, commit, push, or release is required without explicit authorization;
- tests reveal that a provider failure breaks local Alethe;
- the implementation can only make a capability appear functional by returning fabricated state.

## Definition of done

Do not report the whole objective complete unless:

- Phase 3 has documented passing security evidence;
- Phases 4 through 9 have documented passing provider-independent evidence;
- Phase 10A exposes truthful optional activation and provider states through the shared Core;
- Phase 10B delivers encrypted invitations between isolated devices through a real staging Cloudflare Worker and SQLite Durable Object;
- ordinary users require no Cloudflare account or credentials;
- disabled collaboration creates no rendezvous connection;
- provider failure leaves local functionality intact;
- forbidden-data leakage tests pass;
- capability states remain unavailable for unimplemented P2P transfer, relay, tasks, and chat;
- all required checks pass;
- documentation and Graphify are current;
- no production deployment or Git history mutation occurred without owner authorization.

At handoff, lead with what is actually working, list the exact security evidence, identify any remaining blockers, provide absolute paths to important artifacts, summarize tests run and their results, and explicitly state that no commit/deploy occurred unless the owner authorized it.

---
