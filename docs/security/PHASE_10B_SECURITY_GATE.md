# Phase 10B Security Gate — Cloudflare Rendezvous

## Status

The isolated adapter and provider-neutral client are implemented locally. The invitation-domain
bridge, staging evidence, and production authorization remain pending.

The repository now contains both sides of the versioned rendezvous boundary:

- `services/rendezvous-cloudflare/`: Worker entry point, SQLite Durable Object, hibernatable
  WebSocket, protocol parser, local tests, Wrangler configuration, and operator instructions.
- `src-tauri/src/sync_rendezvous.rs`: provider-neutral HTTPS/WebSocket client, endpoint validation,
  challenge-response authentication, bounded queues, reconnect/backoff, status, and Desktop/Web
  adapters.
- `src/components/modals/preferences/CollaborationSettings.tsx`: explicit local-only, managed, and
  custom-provider modes with the provider-visible metadata disclosed before activation.

No production deployment was performed. The managed endpoint is injected with
`ALETHE_RENDEZVOUS_ENDPOINT` at build time and fails closed when absent. Cloudflare API credentials
are never accepted by, persisted in, or bundled with the Alethe client.

## Data boundary

The provider accepts only:

- a 64-hex opaque account route;
- an opaque device ID;
- Ed25519 and X25519 public keys plus the signed binding between them;
- protocol/key/revocation/presence generations;
- encrypted invitation, candidate, or revocation envelopes;
- expiry, acknowledgement, timing, and bounded ciphertext sizes;
- an HMAC of the connecting-IP signal used only for abuse control.

Both the native client and service parser reject unknown fields. The native client reconstructs an
exact allowlisted frame before queueing any provider-bound bytes, so a future IPC or Web caller
cannot transmit an OAuth token, path, filename, project name, task body, chat plaintext, or other
content and rely on the provider to reject it afterward. The raw connecting IP is never written to
SQLite and is never identity.

## Authentication sequence

1. The client derives the opaque account route locally from the verified Google `sub`; no Google
   token or account credential leaves the client.
2. The Worker selects one account-scoped Durable Object and accepts one logical WebSocket.
3. The Durable Object sends a random, 30-second challenge.
4. The client signs a canonical binding of protocol version, account route, device ID, key
   generation, and challenge with the existing Ed25519 device key.
5. The service verifies that signature and independently verifies the Ed25519 signature binding the
   advertised X25519 public key to the same device.
6. The first observed public key is pinned. A later lower generation or unexplained key change fails
   closed. Only after these checks does the socket become authenticated.

Possession of an account route is not project authorization. Discovery returns public device
metadata only; every project operation still requires the Phase 1–9 device/grant checks.

## Storage and limits

SQLite tables are intentionally limited to public device metadata, encrypted mailbox rows,
authentication counters, and HMACed IP-abuse counters. Implemented bounds include:

- 24 KiB control frames and 16 KiB decoded ciphertext;
- 128 mailbox items and 512 KiB mailbox ciphertext per account route;
- 32 sockets per account route and two sockets per device;
- 40 upgrades per HMACed IP signal per minute;
- eight authentication failures per device per minute;
- 120 frames and 256 KiB per authenticated socket per minute;
- five-minute candidate TTL, two-minute presence TTL, and seven-day maximum invitation/revocation
  TTL;
- 32 deliveries per pull batch and 64 devices per discovery response;
- idempotent enqueue and acknowledgement by opaque message ID;
- expiry cleanup on authentication/enqueue and bounded client event/outgoing queues.

Production must configure `ABUSE_HASH_KEY` as a Wrangler secret. Local development uses a
local-only fallback solely for loopback tests.

## Evidence completed locally

- TypeScript build and protocol tests pass.
- Wrangler dry-run bundles the Worker with the expected Durable Object binding.
- Real local Worker tests completed `/v1/info`, WebSocket upgrade, random challenge, Ed25519
  authentication, X25519 binding verification, same-account device discovery, and encrypted-envelope
  delivery between two different opaque account routes.
- Rust endpoint, canonical-authentication, queue-bound, and pre-provider frame-allowlist tests pass.
- The frontend suite passes with 71 files and 445 tests. The Rust library suite passes with 386
  tests, including 124 collaboration-focused tests.
- Disabling the feature closes the provider runtime; a missing managed endpoint reports an honest
  unavailable state without affecting local Alethe.

## Required staging evidence before production

The following cannot be claimed from a local repository and remain mandatory:

1. Deploy a separate staging Worker/Durable Object namespace with operator credentials.
2. Test two real machines/accounts through different NATs and changed IPs.
3. Complete encrypted invitation creation/consumption wiring from the existing invitation domain;
   the service can route ciphertext, but the current client does not yet convert a remote delivery
   into an accepted project grant.
4. Exercise online/offline/expired/revoked/duplicate invitation delivery and reconnect.
5. Capture Worker storage, logs, metrics, and network traffic with forbidden sentinels and prove no
   forbidden field crosses the boundary.
6. Simulate quota exhaustion, suspension, incompatible protocol, schema migration, rollback, state
   export, and compatible-provider replacement.
7. Obtain an explicit owner decision for production endpoint, Cloudflare budget, retention, privacy
   disclosure, and production deployment.

Until these items pass, the official managed endpoint must remain absent from release builds and
automatic remote invitation delivery must remain unavailable.
