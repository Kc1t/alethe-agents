# ADR-0006: Group Key Management for Project Chat

- Status: Accepted for Phase 9's scope (local, provider-independent mechanism); revisit before any
  production cross-network chat deployment.
- Date: 2026-08-21

## Context

Phase 9 needs end-to-end encrypted group messaging: direct conversations, project channels, and
private groups, where a removed member must lose access to future content and a rendezvous/relay
provider (Phase 10B) must never see plaintext. The blueprint explicitly asks to "evaluate a
reviewed RFC 9420 MLS implementation for groups and document the decision" before enabling groups.

## Options considered

| Option | Forward secrecy | Post-compromise security | Group scalability | Implementation cost this phase |
| --- | --- | --- | --- | --- |
| RFC 9420 MLS (via `openmls` or similar) | Yes, per-message via TreeKEM ratcheting | Yes, built into the protocol | Efficient at scale (logarithmic-cost membership changes) | Large — a full MLS stack (credentials, key packages, TreeKEM, commits, welcome messages) is a substantial dependency and API surface to wire correctly, well beyond what this phase's provider-independent, local-fixture scope needs to prove |
| Per-epoch symmetric key wrapped per member (X25519 ECIES-style, reusing Phase 3's `sync_crypto` primitives) | Yes, across epochs (an old epoch's key cannot be derived from a new one) | Partial — a compromised current epoch key exposes only that epoch's messages, not future ones after the next rotation | O(members) cost per membership change (must rewrap for every remaining member) — acceptable for the small groups a "programmer-focused chat" realistically has | Small — reuses X25519 key agreement, HKDF-SHA256, and ChaCha20Poly1305 already reviewed and in use since Phase 3/4/6 |
| Single static shared group key, no rotation | No | No | Trivial | Trivial, but fails the explicit requirement that removing a member must prevent future decryption |

## Decision

1. **Use a per-epoch symmetric key, individually wrapped for each current member via X25519
   key agreement, for Phase 9.** Every conversation has a monotonically increasing `epoch` number.
   Each epoch has one random 256-bit ChaCha20Poly1305 key. That key is wrapped once per member
   using an ephemeral-X25519-to-static-X25519 ECIES-style construction (fresh ephemeral keypair,
   Diffie-Hellman against the member's existing Phase 3 `DeviceKeyBinding` X25519 public key,
   HKDF-SHA256 to derive a wrap key, ChaCha20Poly1305 to wrap the epoch key). Messages sent during
   an epoch are encrypted with that epoch's key; each member unwraps it once (using their own
   X25519 private key) and can then decrypt every message in that epoch.
2. **Every membership change advances the epoch and generates a fresh key.** Adding a member wraps
   the new epoch's key for everyone including the new member — the new member does not gain access
   to prior epochs' keys (no history access unless explicitly re-shared, which this phase does not
   implement). Removing a member wraps the new epoch's key only for the remaining members — the
   removed member never receives a wrap for it and cannot derive it from anything they already
   have, because each epoch's key is independently random.
3. **This is not MLS.** It provides forward secrecy across epochs and correctly excludes removed
   members from future epochs — the two properties this phase's tests exercise — but it does not
   provide MLS's within-epoch continuous ratcheting, efficient logarithmic-cost membership updates
   for large groups, or its formally analyzed post-compromise security guarantees. It is a
   deliberately smaller, already-reviewed-primitive construction sized to what Phase 9 actually
   needs to prove locally.
4. **Revisit before production.** Before project chat is enabled against a real cross-network
   deployment (Phase 10B and beyond), re-evaluate MLS given the group sizes and threat model that
   emerge in practice. `openmls` (or an equivalent audited RFC 9420 implementation) remains the
   recommended upgrade path if group sizes or security requirements outgrow this construction.
5. **Direct messages use the same mechanism as a two-member "group."** No separate primitive is
   needed for 1:1 conversations — a two-member conversation is simply a group with two wraps per
   epoch, which already gives forward secrecy and authenticated device membership.
6. **Attachment keys are independent from message keys.** Each attachment gets its own randomly
   generated content key, wrapped per member the same way as an epoch key, and is not derived from
   or dependent on any conversation epoch key — losing/rotating one never affects the other.

## Consequences

- Every conversation operation that changes membership costs O(members) key-wrap operations. This
  is fine for realistic project-chat group sizes; it would not scale to very large groups, which
  is exactly the scenario MLS is designed for.
- History access for a newly added member is not implemented in this phase — a new member sees
  messages only from the epoch they joined in onward. Retroactive history sharing, if wanted, is a
  separate future decision (MLS's "welcome" mechanism handles this natively; this construction
  does not).
- The provider-independent fixtures used to test this phase never involve a real provider, so
  "the provider never sees plaintext" is true by construction (nothing talks to a provider), not
  yet proven against a real Phase 10B deployment.

## Rejected alternatives

- **Full MLS now**: correct long-term direction, but adopting a full RFC 9420 stack is a
  significant scope increase disproportionate to what this phase needs to prove (local domain
  model, membership-driven key rotation, removed-member exclusion) — explicitly deferred, not
  avoided, per the "revisit before production" consequence above.
- **No rotation / static group key**: fails the phase's core requirement outright.
- **Per-message re-wrap for every member (no epoch concept)**: equivalent security to per-epoch
  wrapping for the properties this phase tests, but far more re-wrap operations for no additional
  benefit at this group size — epochs amortize the cost across all messages sent before the next
  membership change.
