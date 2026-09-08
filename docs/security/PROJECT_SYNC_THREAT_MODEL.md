# Project Sync Threat Model

Status: **design gate**. Project sync remains unavailable until the invariants in this document have executable enforcement and negative tests.

## Scope and security objective

Alethe is local-first. Account identity, device identity, project authorization, transport, replica storage, chat, tasks, and backup are separate security domains. Authentication never implies access to a project, and receiving an invitation never starts a download.

The objective is to let an explicitly trusted device receive an explicitly selected project manifest with the minimum granted permissions while preserving confidentiality, integrity, revocation, recovery, and recipient consent.

## Assets and data classes

| Class | Assets | Required handling |
| --- | --- | --- |
| Critical secrets | OAuth credentials, device private keys, invitation bearer secrets, profile data-encryption keys | OS credential store; never frontend state, URLs, logs, diagnostics, or project JSON |
| Sensitive content | Source files, `.env`, credentials, Git data, agent transcripts, chat attachments, transfer staging, backups | Deny by default, authenticated encryption in transit and staging, explicit manifest |
| Authorization state | Project IDs, grants, permissions, revocations, invitation hashes, device trust | Authenticated and versioned; atomic writes; auditable transitions |
| Personal data | Account identifiers, device names, avatars, presence, audit history | Minimize collection and retention; user-visible deletion and privacy controls |
| Operational metadata | Opaque project ID, ciphertext sizes, timing, relay endpoints, protocol version | Relay-visible only when necessary; never include local paths or filenames before authorization |

## Trust boundaries

1. **Rendered project content -> WebView:** all filenames, messages, terminal output, and attachments are untrusted.
2. **WebView -> Tauri IPC/local Core:** every request requires typed validation and backend authorization; frontend checks are not a boundary.
3. **Local Core -> filesystem:** paths are canonicalized after symlink resolution and constrained to the authorized root.
4. **Local Core -> credential store:** secret material crosses this boundary only in backend memory and is zeroized where supported.
5. **App -> identity provider:** authorization uses the external system browser, Authorization Code with PKCE, state, and nonce.
6. **App -> rendezvous/relay:** the service may authenticate devices and route ciphertext but is not trusted with project plaintext.
7. **Peer transport -> recipient Core:** a cryptographic device identity is authenticated before a project grant is evaluated.
8. **Recipient Core -> destination folder:** transfer requires local acceptance, an empty or verified destination, disk-space review, and an atomic commit.

## Attacker model

The design assumes hostile networks and relay operators; stolen or replayed invitation links; malicious invitation senders or recipients; compromised or cloned devices; local unprivileged processes; hostile repositories containing symlinks, special files, oversized content, or parser payloads; stale offline replicas; and confused users approving the wrong account, device, project, destination, or permission.

Full compromise of a trusted device can expose data available to that device. The containment objective is prompt revocation, bounded key rotation, project isolation, and an audit trail—not a claim that application cryptography survives arbitrary endpoint compromise.

## Mandatory invariants

Each identifier below is a release-blocking test requirement.

| ID | Invariant | Required verification |
| --- | --- | --- |
| SYNC-INV-001 | A grant names exactly one random project ID, one subject, and an explicit permission set. | Contract and authorization tests reject missing, unknown, cross-project, and implied permissions. |
| SYNC-INV-002 | Invitations are random, short-lived, single-use, revocable, audience-bound, and replay-resistant. Only a hash of the bearer secret is retained. | Concurrent redemption, expiry, revocation, wrong-audience, and replay tests. |
| SYNC-INV-003 | Every installation has a distinct asymmetric device identity; account login never silently trusts a device. The first device registered for an account is trusted automatically, because no other trusted device exists to approve it; every subsequent device starts `Pending` and requires explicit approval from an already-trusted device before it can issue invitations or receive grants. | Registration, cloned-profile, key-rotation, and revoked-device tests; first-device auto-trust and additional-device approval-required tests. |
| SYNC-INV-004 | Secrets never enter project/profile JSON, URLs, logs, telemetry, clipboard diagnostics, or frontend stores. | Repository scans plus redaction and serialization tests. |
| SYNC-INV-005 | Every file operation canonicalizes the target after symlink resolution and remains beneath the authorized root. | Traversal, symlink swap, junction, case-folding, and race tests per platform. |
| SYNC-INV-006 | `.git`, `.alethe`, secret patterns, sockets, device files, and platform-sensitive paths are excluded by default. | Manifest policy tests and hostile fixture repositories. |
| SYNC-INV-007 | First contact, long-offline recovery, and divergent manifests cannot propagate deletion automatically. | State-machine and multi-replica conflict tests. |
| SYNC-INV-008 | Revocation prevents new sessions and triggers bounded session and project-key rotation. | Active-session revocation and offline-device rejoin tests. |
| SYNC-INV-009 | Encryption is reported only after peer authentication and cryptographic verification. | Capability/UI contract tests with missing and forged evidence. |
| SYNC-INV-010 | The recipient chooses whether to accept, where to store, and when to start every first transfer. | UI and backend tests proving invitation acceptance alone performs no filesystem write. |
| SYNC-INV-011 | Protocol versions and algorithms are negotiated without downgrade; unknown or unsupported values fail closed. | Malformed, future-version, and downgrade tests. |
| SYNC-INV-012 | `export` implies `read`; collaborative `write` requires a readable base. Write-only contribution uses a separate path-confined `upload` inbox. | Permission normalization and authorization matrix tests. |

## STRIDE review

| Threat | Primary controls | Residual risk / required follow-up |
| --- | --- | --- |
| Spoofing | OIDC claim validation, PKCE, state/nonce, per-device signatures, fingerprints | Identity-provider account recovery remains provider-dependent. |
| Tampering | Authenticated encryption, signed protocol messages, revision checks, atomic writes | Files may change between scan and read; use descriptor-based traversal where supported. |
| Repudiation | Append-only, integrity-protected security events with stable actor/device/project IDs | Define retention and export/deletion policy before launch. |
| Information disclosure | Explicit manifests, exclusions, E2EE, opaque IDs, minimal relay metadata | Relay observes timing, endpoints, and ciphertext size unless padding is introduced. |
| Denial of service | Size/count quotas, backpressure, rate limits, bounded parsers, cancellable staging | An authorized peer can still consume its granted quota; expose limits and disconnect controls. |
| Elevation of privilege | Backend authorization on every operation, explicit permission implications, reauthentication for sensitive grants | Policy migrations require versioned deny-by-default behavior. |

## Privacy and metadata

The rendezvous service may learn account-scoped opaque device IDs, public device keys, online status, connection timing, IP addresses needed for routing, ciphertext sizes, and opaque invitation/project identifiers. It must not receive local paths, filenames, project contents, account tokens, private keys, or plaintext chat/task content. Retention periods, operator access, abuse handling, data export, and deletion must be documented before production deployment.

OS notifications hide project and sender details on locked screens by default. Presence and read receipts are opt-in and scoped per project.

## Fail-closed release gates

- Unknown, absent, malformed, or future capability documents evaluate to unavailable.
- A UI label cannot assert encryption, trust, immutability, backup, or synchronization from local mode alone.
- Network listeners bind only to reviewed interfaces; local browser mode remains loopback-only.
- Invitation acceptance creates authorization state only. Destination selection and transfer consent are separate operations.
- No custom cryptographic primitive or protocol is permitted. Library and algorithm choices require a separate review.

## Standards baseline

- [RFC 8252: OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252) requires an external user-agent and describes loopback redirects for desktop applications.
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700) defines current PKCE, redirect, replay, and token protections.
- [RFC 9420: Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420) is the baseline candidate for authenticated group key establishment for future project chat; selecting an implementation requires a separate review.
- [WebRTC 1.0](https://www.w3.org/TR/webrtc/) defines the browser peer-connection surface. It does not replace application authorization or the E2EE content protocol.

## Accepted rendezvous decision

Cloudflare Workers with SQLite-backed Durable Objects is the reference rendezvous provider for the first online-collaboration implementation. It is deliberately scheduled for Phase 10, after the Phase 3 security gate and the provider-independent collaboration systems in Phases 4 through 9. It is an optional control-plane component operated by Alethe or by an advanced self-hosting administrator. Ordinary users do not provide Cloudflare accounts or credentials. The provider boundary, activation model, invitation flow, and capability gating are defined in `docs/adr/ADR-0002-optional-cloudflare-rendezvous.md`.

This decision does not select a project-data relay and does not relax any data-minimization requirement in this threat model. The unresolved account-routing proof must bind an opaque identifier to locally verified Google identity without sending Google tokens to the rendezvous service.

Implementation must follow the phase-specific controls, state machines, failure behavior, and evidence requirements in `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md`. Each phase re-runs the relevant threat analysis before its capability can advance from unavailable.

## Open security decisions

Before network implementation begins, owners must review the identity backend, credential-store behavior per OS, device-signature and key-agreement libraries, encrypted state format, opaque Google-account routing proof, relay technology and retention policy, group-chat key management implementation, and recovery/key-loss UX.
