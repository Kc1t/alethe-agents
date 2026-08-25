# ADR-0002: Optional Cloudflare Rendezvous Service

- Status: Accepted for Phase 10 implementation after Phases 3–9; production deployment pending
- Date: 2026-08-21
- **Amended 2026-08-25**: the "Alethe collaboration" (operator-managed shared endpoint) mode
  described below was never implemented and is now explicitly dropped, in favor of a
  personal-Cloudflare-Worker-only model — see "Amendment: no operator-managed endpoint" near the
  end of this document. Read the rest of this ADR as historical context for why Cloudflare was
  chosen as the reference provider at all; do not implement the "Alethe collaboration" mode or its
  `alethe_managed` UI option.

## Context

Alethe needs a deployable control plane so devices on different networks can discover one another, deliver invitations, exchange connection candidates, and recover after network changes. This service must remain outside the project-content data path and must satisfy the constraints in `docs/security/PROJECT_SYNC_THREAT_MODEL.md`.

Cloudflare is an infrastructure choice for the Alethe service operator. It must not become an account, credential, or setup requirement for every Alethe user. Alethe must also remain a complete local workspace when online collaboration is disabled or unavailable.

## Decision

1. **Use Cloudflare Workers with SQLite-backed Durable Objects as the reference rendezvous provider for Phase 10.** The Worker terminates the public HTTPS/WebSocket endpoint. Account-scoped Durable Objects coordinate presence, invitation envelopes, connection signaling, expiry, and abuse limits.
2. **Make online collaboration an optional Alethe component.** It is disabled by default for users who only need local projects, terminals, agents, local security state, or GitHub settings backup. Enabling it is required only for remote discovery, automatic cross-device invitation delivery, connection negotiation, and other network collaboration features.
3. **Provide an operator-managed default.** Signed Alethe releases may contain an official rendezvous endpoint. Ordinary users opt in inside Alethe and do not create a Cloudflare account, install Wrangler, provide a Cloudflare API token, choose a domain, or deploy a Worker.
4. **Keep a provider boundary.** An advanced setting may accept a compatible self-hosted rendezvous endpoint. Cloudflare-specific deployment details stay on the server side; the client consumes the versioned Alethe rendezvous protocol. There is no silent fallback to an unknown public provider.
5. **Keep the control and data planes separate.** Cloudflare carries device registration, signed presence, encrypted invitation notifications, revocations, and connection candidates. Project files, live project synchronization, tasks, and chat use authenticated peer transport whenever available. A future relay may forward only end-to-end encrypted payloads and requires its own decision and production gate.
6. **Use one long-lived control connection per enabled device.** The connection uses a hibernatable WebSocket and remains mostly idle. It is not created once per project, contact, group, file, or chat message. Native WebSocket liveness and event-driven presence replace frequent application heartbeat messages.
7. **Never ship service credentials in the client.** Cloudflare deployment credentials remain with the Alethe operator or self-hosting administrator. The client authenticates protocol messages with its device identity. OAuth tokens, Google credentials, device private keys, local paths, filenames, project content, task content, and chat plaintext are forbidden at the rendezvous boundary.
8. **Fail closed and preserve local operation.** Missing configuration, an incompatible protocol, exhausted provider quota, suspension, or an unavailable endpoint disables only the capabilities that require rendezvous. It must not block local projects, terminals, agents, local invitation records, or already-established authorized peer sessions.

## Mandatory prerequisite

No production rendezvous connection may be implemented or enabled before the Phase 3 security-readiness gate and the provider-independent collaboration work in Phases 4 through 9 pass. Local protocol types, provider interfaces, manual/LAN bootstrapping, and test doubles may be prepared earlier, but Cloudflare-specific runtime code must remain absent or disconnected and provider-backed capabilities must report unavailable.

The gate requires reviewed Google identity validation, device-key lifecycle, a separate authenticated key-agreement design, signed and replay-resistant control envelopes, fail-closed authorization/capability contracts, local invitation/grant hardening, sanitized logging, and a reviewed opaque account-routing proof that sends no Google token to the provider. Phases 4 through 9 must then prove that peer transport, recipient setup, content integrity, synchronization, tasks, and chat remain provider-independent before the Cloudflare adapter is introduced.

## Planned Phase 10 implementation

The complete step-by-step design is in `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md`. The Cloudflare-specific slice is intended to be implemented as follows:

1. Add a provider-independent Core interface for compatibility discovery, connection, signed device authentication, presence, encrypted-envelope enqueue/delivery/acknowledgement, connection-candidate exchange, revocation generation, closure, and sanitized status.
2. Implement local-only, Alethe-managed, and advanced custom-provider settings. Persist only the selected mode, enabled state, validated endpoint reference, compatible protocol range, and safe presentation preferences.
3. Add the fail-closed connection state machine: disabled, identity required, ready, connecting, online, retrying, direct only, and needs attention. Configuration or health alone never means authenticated online status.
4. Create a dedicated Cloudflare service package containing the Worker edge entry point, SQLite-backed Durable Object, declarative bindings/exports, schema, local/staging tests, and deployment/rollback documentation.
5. Partition coordination state by the reviewed opaque account route. Store only bounded public device metadata, hibernatable socket metadata, encrypted mailboxes, acknowledgement/idempotency records, replay windows, revocation generation, abuse counters, and cleanup cursors.
6. Establish one hibernatable WebSocket per enabled device. Authenticate with a random challenge signed by the device identity and bind the socket to account route, device ID, key generation, protocol version, and connection generation.
7. Route invitation ciphertext atomically: persist enqueue/idempotency before acknowledging the sender, deliver only before expiry and while authorization/revocation generations permit, and make delivery acknowledgement idempotent.
8. Exchange bounded short-lived presence and connection-candidate envelopes. Presence is advisory; candidates are connectivity hints; neither grants project access.
9. Enforce independent account/device/connection/IP limits for upgrades, authentication failures, sockets, messages, bytes, mailbox depth, candidate updates, replay entries, storage reads/writes, and error size. IP remains an abuse signal, never identity.
10. Validate with a real staging deployment before production: online/offline invitation, expiry, revocation, duplicates, reconnect, changed network, incompatible version, outage, quota exhaustion, custom-provider compatibility, forbidden-data capture, migration, and rollback.

Cloudflare SDK types, bindings, storage APIs, and error shapes must remain inside the adapter/service. Security, invitation, synchronization, task, chat, and P2P modules consume only Alethe domain contracts.

## User modes

| Mode | Cloudflare account required from the user | Network behavior | Available scope |
| --- | --- | --- | --- |
| Local only | No | No rendezvous connection | Local workspace, agents, terminals, local security state, and local backup features |
| Alethe collaboration | No | Connects to the official endpoint after explicit opt-in | Remote discovery, automatic invitation delivery, presence, and P2P negotiation when their runtime phases are available |
| Custom rendezvous | Only if the user chooses to operate that infrastructure | Connects only to the configured compatible endpoint | Same protocol capabilities as the official service, subject to compatibility and operator policy |

## Intelligent activation and connection model

The client exposes a capability state machine rather than a generic connected switch:

`disabled -> identity_required -> ready -> connecting -> online`

Transient failures move `online` or `connecting` to `retrying`. A provider or protocol failure moves the service to `needs_attention`. An existing authenticated peer session may continue in `direct_only` while rendezvous is unavailable.

Activation rules:

- Do not connect while collaboration is disabled.
- Offer activation when the user first shares a project, opens a remote invitation, enables cross-device discovery, or opens a collaboration feature that needs rendezvous.
- Explain the metadata visible to the provider before opt-in.
- Use the official endpoint automatically unless the user deliberately selects the advanced custom-provider mode.
- Validate endpoint scheme, TLS, protocol version, health, and server identity before marking the service ready.
- Retry transient failures with bounded exponential backoff and jitter.
- Try an existing authenticated peer session and safe cached connection information before requesting refreshed connection candidates.
- Keep security-sensitive actions such as revocation dependent on current authorization, even when a stale peer connection survives temporarily.

## Invitation delivery flow

1. The sender enables Alethe collaboration and signs in with the locally handled Google identity flow.
2. The client connects to the configured rendezvous endpoint and registers an opaque device identifier, its public key, protocol version, and signed proof of device possession.
3. The sender creates the existing project-scoped invitation. The bearer secret remains end-to-end protected and is never logged or stored in plaintext by the rendezvous service.
4. The rendezvous service routes an encrypted invitation envelope to the intended opaque account/device mailbox. If the recipient is offline, it retains the envelope only until its bounded expiry.
5. A recipient with collaboration enabled receives the envelope automatically. A recipient without collaboration enabled may open the out-of-band `alethe-invite://` link and is prompted to enable the service before remote delivery or connection negotiation.
6. Accepting the invitation creates authorization state only. It does not create a destination directory or transfer project content.
7. After acceptance, rendezvous exchanges current connection candidates. The devices then use the already-defined provider-independent authenticated peer channel from Phase 4.

The method used to bind an opaque account-routing identifier to a locally verified Google account without sending any Google token to the service remains a security implementation gate. Automatic same-account discovery must not ship until that proof and its account-enumeration resistance pass review.

## Capability gating

| Capability | Requires collaboration service | Behavior without it |
| --- | --- | --- |
| Local projects, agents, terminals, and settings | No | Fully available |
| Local device key and local trust records | No | Fully available |
| Create or inspect a local invitation link | No | Available as an out-of-band credential flow |
| Automatic remote invitation delivery | Yes | Disabled with an activation action |
| Same-account remote device discovery | Yes | Disabled |
| Presence and refreshed connection candidates | Yes | Disabled |
| Start a new cross-network peer session | Normally yes | Existing known direct/LAN routes may still succeed |
| Continue an established peer session | No | Continues while authorization and connectivity remain valid |
| Immediate remote revocation notification | Yes | Marked degraded; peers must reauthorize according to protocol policy |
| Offline invitation queue | Yes | Unavailable; out-of-band link remains possible |

## Consequences

- The Alethe operator owns one Cloudflare deployment for the official service; users do not share its administrative credentials.
- Cloudflare Free is suitable for development and initial use but is a quota, not a permanence guarantee. Production requires monitoring, a paid-plan budget, exportable state, and a documented migration or self-hosting path.
- Provider outages degrade online collaboration rather than the local application.
- Keeping the provider interface versioned prevents Cloudflare APIs from leaking into project authorization or peer-transport code.
- The application must describe a state as connected only after a real compatible service handshake; configuration alone is not connectivity.

## Amendment: no operator-managed endpoint (2026-08-25)

The "Alethe collaboration" mode above (decision point 3, the "operator-managed default") is
dropped before ever being production-implemented. Alethe does not, and will not, run a shared
rendezvous endpoint that every user connects through by default. The reason is the same
metadata-exposure boundary this ADR already protects (decision point 7: "never ship service
credentials in the client"), taken one step further — a single Alethe-operated Worker, even one
that never sees plaintext content, would still be a single vantage point able to observe device
presence and connection metadata **across every user of the app**, not just the people any one
user has actually invited. That is a materially different, larger exposure than the model this
amendment replaces it with.

Instead, each user who wants online collaboration deploys and owns a personal Cloudflare Worker,
via the guided flow (`CloudflareGuidedDeploy` in Preferences → Account, backed by
`sync_cloudflare_deploy.rs`; `wrangler login`'s OAuth token stays in the user's own local Wrangler
config, never seen by Alethe). Two shapes of traffic now exist, corresponding to the two arrows
below:

```
usuario -----> cloudflare (pessoal) --------> acha amigo -------> p2p
usuario -------> p2p -------> amigo
```

- **Discovery/signaling** (finding a friend, exchanging invitations, delivering connection
  candidates) goes through the user's own personal Worker — it only ever relays metadata for
  people that specific user has actually invited or been invited by, never anyone else's traffic.
- **Once a direct P2P (or relay-fallback) session is established**, further messages between the
  two known peers no longer depend on discovery at all — the Worker's only remaining job for that
  pair is relaying opaque, already end-to-end-encrypted envelopes when a direct P2P path isn't
  available (see `sync_p2p_bridge.rs`'s `P2pSessionRegistry`, `chat_message` envelope kind).

Consequences of this amendment:

- `CollaborationServiceMode` keeps its `AletheManaged`/`alethe_managed` variant in the backend
  enum and persisted-settings schema (`sync_activation.rs`) purely for backward-compatible
  deserialization of any settings file that predates this amendment — no new code path ever
  selects or offers it. The Settings UI (`CollaborationSettings.tsx`) only ever offers `Local
  only` and `advanced_custom` (relabeled "My own Cloudflare Worker" — no longer an "advanced
  users only" option, since the guided deploy makes it the only real online mode).
  `docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`'s references to an "operator-managed" default
  are stale for the same reason and should be read historically, not as current architecture.
- Two users can only discover each other through Cloudflare at all if they already share
  established trust: a project grant, or a chat contact (`ChatContactRecord`,
  `sync_security.rs`) added via the mutual pairing-code exchange. There is no cross-account
  discovery of strangers through any Worker, personal or otherwise.
- If B is already connected (project- or chat-trusted) to both A and C, A does not need to
  separately discover C from scratch — this is the basis for the still-pending, explicitly
  opt-in/beta multi-hop P2P mesh relay design (see the approved plan referenced in
  `docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md`), which forwards only opaque already-encrypted
  bytes through already-trusted intermediate sessions, never through any Worker at all.

## Rejected alternatives

- Requiring every user to create and configure a Cloudflare account: unacceptable setup burden and unnecessary exposure of infrastructure credentials.
- Sending every project message or file through the Worker: violates the control/data-plane boundary and creates avoidable privacy and quota costs.
- Connecting every installation automatically on startup without consent: violates the optional-component and metadata-disclosure requirements.
- Treating an endpoint string or successful HTTP request as authorization: does not authenticate a device, account, project, or grant.
- Making Cloudflare the only protocol implementation: creates unnecessary provider lock-in and removes the recovery path required for a long-lived collaboration architecture.
