# Phase 4 Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 4 requirements from
`docs/superpowers/plans/2026-08-21-security-gate-and-cloudflare-rendezvous-prompt.md` (§ Phase 4)
and `docs/superpowers/plans/2026-08-21-collaboration-implementation-blueprint.md` (§ Phase 4) to
implementation and test evidence. As with the Phase 3 ledger, an item marked anything other than
"Done" is not runtime-available — `resolve_capabilities_at` remains the only source of truth for
what a running installation can do; nothing in this phase changes its output (`project_transfer`
stays `unavailable`, because Phase 4 proves the transport works, not that any product feature uses
it yet).

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Select and document the transport stack | `docs/adr/ADR-0005-peer-transport-stack.md` (raw TCP + custom AEAD framing, evaluated against QUIC/Iroh/WebRTC) | N/A (design document) | Done | Real internet NAT traversal is explicitly deferred to Phase 10B, per the ADR |
| 4.2 | Define transport interfaces (`CandidateSource`, `PeerConnector`, `AuthenticatedSession`, `RelayAdapter`, `PeerStream`) | `sync_transport.rs`: `CandidateSource`/`ManualCandidateSource`, `establish_as_initiator`/`establish_as_responder` (the `AuthenticatedSession` role), `PeerStream`. `PeerConnector` is implicit — any `Read + Write` (e.g. `TcpStream`) satisfies it; no explicit trait was needed since the handshake functions are generic over the stream type. `RelayAdapter` is declared only as an interface-shaped gap in the ADR — no relay server exists to implement or test against | N/A / `sync_transport::tests::*` | Done for `CandidateSource`/session/stream; `RelayAdapter` remains an explicit non-goal until a relay exists to build against (Phase 4/10B decision, not yet made) | No production relay decision has been made; do not read "interfaces defined" as "relay works" |
| 4.3 | Establish sessions (challenge exchange, key-binding exchange, trust check, key agreement, session-key derivation, stream establishment) | `sync_transport::perform_handshake` (via `establish_as_initiator`/`establish_as_responder`) | `sync_transport::tests::two_devices_authenticate_over_real_tcp_loopback`, `handshake_rejects_an_untrusted_device` | Done | "Authenticate the requested project/grant before project metadata" happens at `Session::open_stream`, not during the raw handshake — Phase 4 has no project metadata to protect yet, so this is authorization-ready but unexercised by real product data |
| 4.4 | Frame and flow control (bind to protocol/project/grant/sender/recipient/session/stream/sequence/content-type; bound frames/streams/queued bytes/concurrent transfers) | `sync_transport::PeerStream` (`FrameHeader`, `header_aad`, `enqueue`/`receive`, `MAX_FRAME_BYTES`, `MAX_QUEUED_FRAMES`) | `sync_transport::tests::tampered_ciphertext_and_wrong_project_are_rejected`, `oversized_frame_is_rejected_before_allocating_it`, `enqueue_enforces_backpressure_bound` | Done for a single logical stream; true multi-stream multiplexing is an explicit Phase 6 deferral per ADR-0005 | Decompression abuse is structurally impossible today (no compression is used anywhere in this module) rather than defended against — revisit if compression is ever added |
| 4.5 | Reconnection and revocation (safe resume metadata, re-check device/grant generation, revocation closes streams) | `sync_transport::ResumeTicket`, `validate_resume`, `Session::revoke`/`is_revoked` | `sync_transport::tests::resume_ticket_is_rejected_once_the_device_is_no_longer_trusted`, `revoking_a_session_blocks_opening_new_streams`, `closing_a_stream_rejects_further_send_and_receive` | Done | `ResumeTicket` validation is a pure function exercised with fixtures; no real "network drop → reconnect → resume" integration test exists yet, because Phase 4 has no product feature driving a real reconnect scenario |

## Phase 4 proof checklist (from the security-gate prompt)

- `[x]` Authenticate both device identities before exposing project metadata — `open_stream` requires a successfully authenticated `Session`; no project-scoped data exists before that.
- `[x]` Use the reviewed Phase 3 key-agreement design and forward-secret session keys — `sync_crypto::derive_session_keys` (X25519 + HKDF-SHA256), unchanged from Phase 3, consumed directly.
- `[x]` Bind frames to protocol, account, device, project, grant, stream, sequence, and content type — account is bound transitively through which session's keys are used (a session is already scoped to one authenticated account/device pair); the rest are explicit AEAD associated-data fields.
- `[x]` Reject replay, downgrade, cross-project substitution, truncation, unsafe reordering, decompression abuse, and oversized frames — see the frame/reorder/oversize tests above; downgrade is rejected at handshake via version-range overlap; truncation surfaces as `Malformed`/`Io` from the strict length-prefixed reader.
- `[x]` Separate discovery, direct transport, and relay behind explicit interfaces — `CandidateSource` vs. the handshake/session/stream types vs. the declared-but-unimplemented `RelayAdapter` gap.
- `[x]` Validate direct sessions with loopback and manual candidates — the TCP loopback test is the manual-candidate case (`127.0.0.1:<ephemeral>` is itself a manually supplied `Candidate`); LAN is the same code path with a non-loopback address, untested here only because it requires two physical hosts, not because the code path differs.
- `[x]` Do not choose Cloudflare merely to make test peers discoverable — every Phase 4 test uses only `std::net::TcpListener`/`TcpStream` on loopback.

## Desktop/Web parity

Phase 4 adds no Tauri command or Web route — `sync_transport.rs` is a pure Core module with no
product-facing operation yet. There is nothing to expose until a later phase drives an actual
peer-transport product action (e.g. Phase 6's manifest transfer).

## Fail-closed confirmation

- `resolve_capabilities_at` (Phase 3) is unchanged by this phase; `project_transfer` remains
  `unavailable` because no product code calls into `sync_transport` yet.
- A session cannot be established with an untrusted device (`handshake_rejects_an_untrusted_device`).
- A revoked session cannot open new streams (`revoking_a_session_blocks_opening_new_streams`).
- A resume ticket for a device that is no longer trusted is rejected
  (`resume_ticket_is_rejected_once_the_device_is_no_longer_trusted`).

## Reviewer trace

Every row above names the exact file and test function; running
`cargo test --lib sync_transport` reproduces all Phase 4 evidence in this document.
