# Phase 3 Security Gate — Evidence Ledger

Status: **in progress**. This document maps every Phase 3 requirement from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 3)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 3) to
its implementation location, its authoritative test, and its current status. An item marked
`pending` is not implemented; do not infer runtime capability from this document alone — the
capability resolver (`resolve_capabilities_at` in `src-tauri/src/sync_security.rs`) is the only
source of truth for what a running installation can actually do.

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Canonical vocabulary (opaque IDs, states, error codes) | `sync_protocol.rs` (`SignedEnvelope`, `account_route_id`); existing `sync_security.rs` types (`DeviceId`≈`device_id: String`, `InvitationId`, `GrantId`) | `sync_protocol::tests::*`, `sync_security::tests::*` | Partial — envelope/account-route vocabulary is frozen and cross-language-vector-tested; a fully generated/shared Rust↔TS type definition (rather than hand-mirrored types) is not built | Hand-mirrored types can drift; mitigated today by explicit cross-language byte/hash vectors, not by codegen |
| 3.2 | Complete Google identity validation (issuer, audience, expiry, nonce, iat) | `sync_mesh.rs::verify_google_id_token`, wired into `start_google_sync_auth` | `sync_mesh::tests::verify_google_id_token_*` (4 tests, local RSA fixture, no live Google dependency) | Done for issuer/audience/nonce/expiry/iat/email-verified/sub-cross-check | Token **refresh** and `invalid_grant` recovery remain unimplemented — tokens are stored but never refreshed. This is a real gap, not a blocker for the invariants this gate covers, but must not be read as "OAuth is complete" |
| 3.3 | Key-agreement ADR + implementation | `docs/adr/ADR-0003-device-key-agreement.md`; `sync_crypto.rs` (`generate_bound_key_agreement`, `verify_key_binding`, `derive_session_keys`); wired into `complete_verified_identity` | `sync_crypto::tests::*`, `sync_security::tests::registration_creates_a_verifiable_agreement_key_binding_with_its_own_secret`, `revoking_a_device_deletes_both_its_identity_and_agreement_secrets` | Done for key generation, signed binding, session-key derivation, and secret-store lifecycle | Rotation is implemented as "generate a new binding," not as a full rotation *workflow* (grace period, dual-key acceptance window) — deferred, noted in the ADR as future work |
| 3.4 | Canonical signed envelopes, strict decoding, byte limits before allocation | `sync_protocol.rs` (`SignedEnvelope`, `canonical_signable_bytes`, `encode_envelope`, `decode_envelope`, `sign_envelope`, `verify_envelope`) | `sync_protocol::tests::*` — round trip, tampering, wrong key, expired/future, unsupported versions, oversized-field-before-allocation, truncated/trailing bytes, oversized envelope | Done | No concrete message-type producers exist yet (that is Phase 4+); the envelope container itself is complete and tested in isolation |
| 3.5 | Replay/ordering/clock-skew handling | `sync_protocol::ReplayWindow`; `verify_envelope`'s `max_future_skew_ms` parameter | `sync_protocol::tests::replay_window_flags_duplicates_and_stays_bounded`, expiry/future tests in the same module | Done as a reusable primitive | Not yet wired into any live message-processing loop, because none exists before Phase 4/10 |
| 3.5b | Opaque account routing without Google tokens | `docs/adr/ADR-0004-opaque-account-routing.md`; `sync_protocol::account_route_id` | `sync_protocol::tests::account_route_id_*` (determinism, non-reversibility, fixed cross-language vector) | ADR accepted; derivation implemented and tested | **Automatic same-account discovery remains unavailable** — there is no rendezvous connection to exercise this against yet (Phase 10B). This ADR resolves the *design* blocker, not the *runtime* capability |
| 3.6 | Hardened invitation/grant concurrency | Pre-existing Phase 2 state machine in `sync_security.rs`, already covered by `invitation_is_single_use_and_creates_one_bound_grant`, `invitation_failures_are_generic_rate_limited_and_fail_closed`, `revoke_invitation_blocks_future_redemption_and_requires_issuer_account`, `revoke_grant_is_idempotent_safe_and_scoped_to_the_issuing_account` | Same tests, unchanged in this phase | Done for the local state machine | "Grant revocation during connection establishment" and "duplicate remote delivery" cannot be tested yet — no live session/remote delivery exists before Phase 4/10B |
| 3.7 | Backend capability authority | `sync_security.rs` (`CapabilityState`, `SyncCapabilities`, `resolve_capabilities_at`), `sync_resolve_capabilities` Tauri command, `/api/sync/security/capabilities` Web route, `syncResolveCapabilities` frontend client (parsed through the existing fail-closed `parseProjectSyncCapabilities`) | `sync_security::tests::capabilities_are_unavailable_before_any_account_is_verified`, `capabilities_reflect_this_devices_real_trust_state_not_the_accounts` | Done | Not yet wired into any UI — `MeshSidebarView.tsx` still derives its own local gating from device-trust state directly, which is equally honest but duplicates logic that could read from this resolver in a later phase |
| 3.8 | Sanitize observable surfaces | `sync_security::tests::public_snapshot_and_error_codes_never_leak_secret_material` | Same test | Partial — covers the public snapshot, the capability response, and a representative sample of stable error codes. Does not yet cover structured logs/metrics/crash reports, because Phase 3 introduces no new logging surface beyond existing `Result<T, String>` error codes | No logging framework exists yet to audit; revisit when one is introduced |

## Desktop/Web parity for Phase 3 surfaces

Every new Phase 3 backend operation is exposed identically through Tauri and the authenticated
local Web API, calling the same Core function:

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Resolve capabilities | `sync_resolve_capabilities` | `GET /api/sync/security/capabilities` |

(Google identity validation and device key-agreement generation are not directly invoked by the
frontend — they happen inside `start_google_sync_auth` and `complete_verified_identity`, both
already Tauri-only by design since OAuth requires the system browser.)

## Fail-closed confirmation

- `resolve_capabilities_at` returns every capability as `unavailable` when no account is verified,
  and `deviceTrust`/`invitations` as `unavailable` for any device that is not `Trusted`, even if
  the account itself is verified.
- `verified_encryption` is hardcoded `false` — Phase 3 does not claim any active encrypted
  transport, because none exists yet.
- `parseProjectSyncCapabilities` (pre-existing, unchanged) rejects any malformed or unexpected
  response and falls back to the fully unavailable state, so a backend bug can only ever under-
  claim capability, never over-claim it, from the frontend's perspective.

## Reviewer trace

Every row above names the exact file and test function; running `cargo test --lib sync_` and
`npx vitest run src/lib/sync` reproduces all Phase 3 evidence in this document.
