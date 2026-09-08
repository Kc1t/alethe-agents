# Phase 12 — External Security Review Checklist

## Purpose

This document exists to hand to an external reviewer (a security consultant, a trusted second
developer, or a formal audit firm) so they know exactly what to look at, why it matters, and where
to find it. Self-review by the same session that wrote the code is not independent verification —
every item below needs a second, genuinely external set of eyes before the collaboration feature
ships to real users beyond local testing.

## Why these six areas specifically

Each one was chosen because it is either (a) cryptographic material where a subtle mistake is
invisible in normal testing but catastrophic under attack, or (b) a trust boundary where the
untrusted rendezvous provider could otherwise see or forge something it should never be able to.

### 1. Cryptography

| What | Where | What to check |
| --- | --- | --- |
| Canonical signed envelope encoding | `src-tauri/src/sync_protocol.rs` | Deterministic byte encoding, replay window, cross-language (Rust/TS) test vectors |
| Device key agreement | `src-tauri/src/sync_crypto.rs` | X25519 kept separate from Ed25519 identity (ADR-0003); session-key derivation uses distinct HKDF `info` per direction |
| Sealed single-shot envelopes | `src-tauri/src/sync_crypto.rs` (`seal_for_recipient`/`open_sealed`) | ECIES-style construction: fresh ephemeral key per envelope, HKDF context binding, ChaCha20Poly1305 AEAD — used for remote invitation delivery |
| Chat group key rotation | `src-tauri/src/sync_chat.rs`, `docs/adr/ADR-0006-chat-group-key-management.md` | Per-epoch key, removed-member exclusion proof, explicit non-MLS scope decision |
| Peer transport session keys | `src-tauri/src/sync_transport.rs` | Nonce direction labeling, replay/reorder rejection, backpressure |

**Ask the reviewer**: does any of this quietly reuse a nonce, leak timing information through
non-constant-time comparison, or depend on an assumption (e.g. "the server never sees plaintext")
that isn't actually enforced by the code?

### 2. Opaque account routing

| What | Where | What to check |
| --- | --- | --- |
| Route derivation | `src-tauri/src/sync_protocol.rs` (`account_route_id`) | `SHA256("alethe-account-route-v1" + account_id)` — one-way, no Google token ever reaches the provider |
| Account-enumeration resistance | Same | Can an attacker who knows a Google email guess/derive the corresponding route and probe device presence? |

### 3. Filesystem publication

| What | Where | What to check |
| --- | --- | --- |
| Content-addressed chunking | `src-tauri/src/sync_manifest.rs` | Streaming SHA-256, bounded memory |
| Staging journal + atomic publish | `src-tauri/src/sync_staging.rs` | Two-step rename swap, crash recovery, retained-backup limit; the gate document (`PHASE_6_SECURITY_GATE.md`) already names one narrow residual crash window — worth an independent look |
| Path validation | `src-tauri/src/sync_manifest.rs` | Traversal (`..`), symlink escape, Windows verbatim-prefix normalization |

### 4. Chat group membership / key rotation

Already covered under Cryptography above — called out separately because it is the one area with
an explicit, documented non-goal (`docs/adr/ADR-0006-chat-group-key-management.md`: no MLS, no
within-epoch ratcheting). A reviewer should confirm the stated trade-off is accurately described
and that nothing in the implementation silently claims a stronger guarantee than the ADR admits to.

### 5. Provider boundary

| What | Where | What to check |
| --- | --- | --- |
| Frame allowlist | `src-tauri/src/sync_rendezvous.rs` (`sanitize_outgoing_frame`) | Every outgoing field is reconstructed from an exact allowlist before queueing — nothing free-form ever reaches the provider |
| Server-side parser | `services/rendezvous-cloudflare/src/index.ts` | Mirrors the same allowlist; unknown fields rejected, not merely ignored |
| Data boundary | `docs/security/PHASE_10B_SECURITY_GATE.md` § "Data boundary" | The exhaustive list of what the provider is allowed to see |
| Discovered-key verification | `src-tauri/src/sync_invitation_bridge.rs` (`verify_discovered_device_agreement_key`) | A compromised/malicious provider returning a substituted key must be caught by the Ed25519 binding check — ask the reviewer to specifically try to construct a forged binding |

### 6. Recovery

| What | Where | What to check |
| --- | --- | --- |
| Device revocation | `src-tauri/src/sync_security.rs` (`revoke_device_at`) | Deletes both Ed25519 and X25519 secrets, invalidates bound grants |
| Key rotation | `src-tauri/src/sync_security.rs` (`rotate_device_keys_at`, Phase 12) | Old key material overwritten, never left retrievable |
| Crash recovery | `src-tauri/src/sync_staging.rs` (`recover_publication_at`) | Resumes an interrupted publish deterministically |
| **Not implemented** | — | Full account recovery after losing every trusted device — an open product decision, not a code gap (see `PHASE_12_OPERATIONS_GATE.md`) |

## What is explicitly out of scope for this review

- Cloudflare's own infrastructure security (that is Cloudflare's responsibility as the platform
  operator, not this codebase's).
- UI/UX review — this checklist is about the security-relevant Core/Worker code only.
- Anything under `docs/superpowers/` — those are planning documents, not shipped code.

## How to use this checklist

1. Share this document and repository access (read-only is sufficient) with the reviewer.
2. Point them at the six sections above in order — each links to specific files and the exact
   question worth asking about that file.
3. Cross-reference their findings against the per-phase gate documents in this same directory
   (`PHASE_3_SECURITY_GATE.md` through `PHASE_12_OPERATIONS_GATE.md`) — those already document
   known residual risks and deliberate scope limitations, so a reviewer's time is best spent on
   what *isn't* already flagged there.
4. Record findings as new entries in this file or as a follow-up document — do not silently fix
   and forget; every finding and its resolution belongs in the audit trail.

## Status

Not yet reviewed. This document was prepared to make that review possible, not to claim it has
happened.
