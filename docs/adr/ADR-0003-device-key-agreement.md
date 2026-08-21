# ADR-0003: Device Key Agreement for Encrypted Peer Sessions

- Status: Accepted
- Date: 2026-08-21

## Context

`sync_security.rs` already gives every installed device an Ed25519 keypair used to sign identity
statements (device registration, approval, revocation, invitation issuance). Ed25519 is a
signature scheme; it is not designed to be reused directly as a Diffie-Hellman key-agreement
primitive. Phase 4 (encrypted peer transport) needs devices to derive a shared symmetric secret
for authenticated encryption without a trusted third party seeing it. Phase 3 must decide and
implement the key-agreement primitive so the canonical envelope format (`sync_protocol.rs`) and
later transport code (Phase 4) have a stable, reviewed foundation.

## Decision

1. **Add a separate X25519 keypair per device**, generated alongside the existing Ed25519 identity
   key at device registration (`complete_verified_identity`). Never derive or reuse the Ed25519
   signing key as an X25519 agreement key — mixing the two roles is a known footgun (e.g. small
   subgroup and cross-protocol confusion attacks on naively "converted" keys).
2. **Bind the X25519 public key to the Ed25519 device identity with a signed statement** —
   `DeviceKeyBinding { device_id, ed25519_public_key, x25519_public_key, bound_at_ms, signature }`
   where `signature` is the Ed25519 signature over the canonical bytes of the other fields. This
   lets any party that already trusts the device's Ed25519 identity verify that a given X25519
   public key genuinely belongs to that device, without a separate certificate authority.
3. **Store the X25519 private key in the same OS credential-store entry as the Ed25519 private
   key**, keyed by `device_id`. Both keys share the device's lifecycle (created together, deleted
   together on revocation/disconnect) so there is exactly one place private material can leak from.
4. **Use `x25519-dalek` (the same Rust ecosystem as `ed25519-dalek`, both built on
   `curve25519-dalek`)** rather than a hand-rolled conversion or a second unrelated crate. This
   avoids pulling in two different curve25519 implementations and keeps the reviewed-library
   surface small.
5. **Session key derivation is HKDF-SHA256 over the raw X25519 shared secret**, with the canonical
   envelope's protocol version, both device IDs, and a session/connection identifier as context
   (`info`) input, producing directional keys (one for each send direction) so a compromised
   receive key never grants send authority. Concrete session establishment is implemented in
   Phase 4; Phase 3 only defines and tests the primitive (`derive_session_keys`).
6. **Rotation**: a device may generate a new X25519 keypair and publish a new signed binding at any
   time (e.g. suspected compromise, scheduled rotation). Older bindings remain valid for messages
   signed under them until their device revokes trust; there is no implicit expiry in Phase 3.
   Full rotation UX and forced-rotation policy is out of scope for this ADR.

## Consequences

- Every device now holds two private keys (Ed25519 identity, X25519 agreement) instead of one.
  Both are OS-credential-store-only; the security document only ever persists public material.
- The canonical envelope (`sync_protocol.rs`) can require a `signing_key_id` that always resolves
  to an Ed25519 device identity, while encryption uses the bound X25519 key — no ambiguity about
  which key does what.
- A device without keyring support cannot register (same failure mode as the existing Ed25519
  requirement) — no new failure class introduced.
- Because the binding is a small signed statement, it can be included in the same invitation/grant
  delivery path in later phases without a separate PKI service.

## Rejected alternatives

- **Convert the Ed25519 key to X25519 via birational maps**: technically possible with careful
  library support, but conflates two protocol roles under one key and is a known source of subtle
  cross-protocol attacks; rejected in favor of a clearly separate key with an explicit signed
  binding.
- **A third-party key-agreement service or PKI**: adds an operator dependency and a rendezvous
  requirement before Phase 10, which contradicts the provider-independent Phase 3–9 boundary.
- **No rotation support**: would make "suspected compromise" unrecoverable without a full device
  revoke/re-register cycle; rejected because rotation is cheap to support from the start.
