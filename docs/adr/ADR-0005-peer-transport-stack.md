# ADR-0005: Provider-Independent Peer Transport Stack

- Status: Accepted for Phase 4 (loopback/manual/LAN scope); real internet NAT traversal and relay
  deployment remain future work gated on later phases.
- Date: 2026-08-21

## Context

Phase 4 needs authenticated, end-to-end encrypted peer sessions between two Alethe devices,
independent of any rendezvous provider (Cloudflare arrives only in Phase 10B). The Phase 3 gate
already produced the cryptographic primitives this phase consumes: Ed25519 device identity,
X25519 key agreement with a signed binding (ADR-0003), and a canonical signed envelope format
(`sync_protocol.rs`). What remains is choosing the actual byte-transport layer two devices
exchange encrypted frames over, for the scope this phase must prove: loopback, manual IP:port
candidates, and opt-in LAN — not general internet NAT traversal, which is a rendezvous/candidate-
exchange problem explicitly deferred to Phase 10B's connection-candidate signaling.

## Options considered

| Option | NAT traversal | New dependency weight | Auditability | Fit for this phase's scope |
| --- | --- | --- | --- | --- |
| Raw TCP + custom AEAD framing | None built-in (not needed for loopback/manual/LAN) | None — `tokio` already a dependency; only adds a small, well-reviewed AEAD crate | High — the whole wire format is ~150 lines we own and test, no hidden protocol machinery | Exact fit: every Phase 4 proof scenario (loopback, manual candidate, LAN) works over plain TCP |
| QUIC (`quinn`) | Built-in connection migration, some NAT resilience | Large — TLS 1.3 stack, certificate handling, UDP congestion control | Medium — correctness depends on a big external implementation we don't fully audit | Overkill for loopback/manual/LAN; its real advantages (migration, multiplexed streams, 0-RTT) matter for Phase 10B's cross-network reconnection, not this phase |
| Iroh (QUIC + built-in relay/hole-punching) | Full NAT traversal + relay | Largest — pulls in its own rendezvous/relay assumptions | Lower — an entire external P2P framework, including its own relay servers, becomes part of the trust boundary | Explicitly the kind of dependency the security-gate prompt warns against accepting "merely because convenient" — it would quietly reintroduce a rendezvous/relay provider dependency this phase must not have |
| WebRTC data channels | Built-in (ICE/STUN/TURN) | Large — ICE negotiation needs a signaling channel (rendezvous) to even begin | Medium | Needs signaling (a rendezvous service) to establish a connection at all — directly conflicts with "no test depends on Cloudflare or a public relay" |

## Decision

1. **Use raw TCP (via the existing `tokio` dependency) as the byte transport for Phase 4**, with a
   custom encrypted framing layer built directly on the Phase 3 primitives. This is the smallest
   dependency footprint that satisfies every Phase 4 proof scenario (loopback, two-process,
   manual candidate, LAN) without smuggling in a hidden rendezvous or relay dependency.
2. **Add `chacha20poly1305`** (RustCrypto ecosystem, same family as the `sha2`/`hkdf` crates
   already in use) as the AEAD primitive for frame encryption. No custom cipher construction.
3. **`sync_transport.rs` defines the interfaces** (`CandidateSource`, `PeerConnector`,
   `AuthenticatedSession`, `RelayAdapter`, `PeerStream`) so a future transport (QUIC, or a
   Cloudflare-facilitated relay in Phase 10B) can be swapped in behind the same contract without
   touching authorization, invitation, or session-establishment logic. `RelayAdapter` is defined
   as a trait only in this phase — there is no relay server to implement or test against yet, and
   implementing one now would either require a production dependency (forbidden) or a placeholder
   that could be mistaken for a real capability (also forbidden).
4. **Defer general internet NAT traversal to Phase 10B.** Candidate discovery beyond "the caller
   already knows an IP:port" (same-account discovery, STUN-style reflexive addresses, connection
   candidate exchange) requires a rendezvous service by definition and is out of scope until then.
   `CandidateSource` in this phase only implements a manual/fixed candidate list and a
   loopback/LAN fixture; it does not implement automatic discovery.
5. **One logical stream per session in Phase 4.** True multiplexed multi-stream transport (needed
   once real file transfer exists) is deferred to Phase 6, when there is an actual manifest/chunk
   protocol to multiplex. Building general multiplexing now, with nothing real to multiplex,
   would be speculative complexity ahead of the requirement that introduced it.

## Consequences

- Phase 4's encrypted session works identically whether the two devices are on the same machine
  (loopback), the same LAN, or reachable at a manually supplied address — exactly the scope this
  phase is required to prove.
- Swapping in QUIC or another transport later only requires a new `PeerConnector`/
  `AuthenticatedSession` implementation; the handshake, framing invariants, and authorization
  hooks defined here do not change.
- Real cross-network connectivity for ordinary users (most of whom are behind NAT) is not solved
  by this ADR — it is explicitly not this phase's job. Phase 10B's connection-candidate signaling
  and, if direct connectivity fails, a separately reviewed encrypted relay are required before
  Alethe can promise cross-network P2P collaboration to a general audience.

## Rejected alternatives

- **QUIC now**: its main benefits (connection migration across changing networks, built-in
  multiplexed streams) address problems this phase does not yet have (no real network-change
  scenario without rendezvous, no real multi-stream payload). Revisit when Phase 10B's
  reconnection-after-network-change requirement makes migration valuable enough to justify the
  added TLS/certificate/dependency surface.
- **Iroh**: bundles its own relay/rendezvous assumptions, which would make Phase 4 secretly
  depend on a rendezvous-like service before Phase 10B — exactly what this phase must avoid.
- **WebRTC**: requires an out-of-band signaling channel (a rendezvous service) before any
  connection can be established at all, which is incompatible with "no test depends on Cloudflare
  or a public relay."
