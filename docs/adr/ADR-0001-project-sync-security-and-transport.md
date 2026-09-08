# ADR-0001: Project Sync Security and Transport Boundaries

- Status: Accepted for design; implementation gated
- Date: 2026-08-20

## Context

Alethe needs account login, multiple trusted computers, collaborator invitations, project replicas, shared tasks, and chat across Desktop and Web. The current prototype does not provide a real identity, authorization, invitation, or encrypted transport protocol. Treating Google login, a connection code, LAN discovery, or possession of a project path as project authorization would create unacceptable privilege escalation.

## Decision

1. **Separate identity, device trust, authorization, and transport.** OIDC identifies an account. A per-installation asymmetric key identifies a device. A versioned grant authorizes a subject to one random project identity. A transport only carries authenticated protocol messages. The first device registered for an account is trusted automatically, since no trusted peer exists yet to approve it; every additional device starts `Pending` and requires an explicit approval action from an already-trusted device of the same account. Revoking a device immediately invalidates its outstanding grants and pending invitations addressed to it.
2. **Use the system browser for OAuth.** Native authorization uses Authorization Code with PKCE (S256), state, nonce, exact redirect matching, and an ephemeral loopback callback bound to loopback. No provider form or confidential client secret is embedded in the WebView.
3. **Keep private material behind the local Core.** OAuth credentials and device private keys live in the OS credential store. Sensitive structured protocol state uses reviewed envelope encryption. The frontend receives only non-secret status and bounded action handles.
4. **Use authenticated rendezvous with direct connectivity when available and an encrypted relay fallback.** LAN discovery is opt-in optimization only. WebRTC may provide browser connectivity, but application-layer device authentication, project authorization, version negotiation, and content encryption remain mandatory on every transport.
5. **Use established cryptography only.** The content protocol will use a reviewed authenticated key agreement, signatures, and AEAD library. Chat/group key management will evaluate an RFC 9420 MLS implementation. Algorithm and library selection require a follow-up ADR and security review before code ships.
6. **Fail closed on capabilities and versions.** Unsupported, malformed, absent, or future protocol/capability versions are unavailable. The Desktop and Web clients consume the same capability contract.
7. **Make receiving explicit.** Accepting an invitation does not download data. The recipient selects a destination, reviews scope and storage, and explicitly starts the first transfer. Existing unrelated directories are never overwritten.
8. **Model write-only contribution honestly.** `export` implies `read`; normal collaborative `write` requires `read`. A separate `upload` permission may add new files to a controlled inbox without exposing or overwriting the existing tree.

## Consequences

- Same-account computers may discover one another but do not automatically expose every project.
- A short code, link, or QR payload represents the same short-lived server invitation and is never a permanent device password.
- The relay can observe routing metadata but not project plaintext; its privacy and retention policy is part of the production gate.
- Desktop and Web share domain contracts while platform adapters differ for credential storage, OAuth callback handling, and filesystem access.
- More infrastructure and state-machine tests are required before synchronization can be enabled. Until those gates pass, the truthful capability state is `unavailable`.

## Rejected alternatives

- Embedded Google login forms: violate native-app OAuth guidance and expand credential exposure.
- Account login as blanket device/project trust: cannot express revocation or least privilege.
- Permanent connection/device codes: replayable bearer credentials with poor rotation and audit properties.
- Transport encryption alone: does not protect content from a relay terminator or authorize project operations.
- Custom cryptography: creates avoidable design and implementation risk.
- Automatic download on invitation acceptance: violates recipient consent and can overwrite or exhaust local storage.
