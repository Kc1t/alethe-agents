# Phase 12 Gate — Security, Abuse Resistance, Privacy, and Operations

## Status

Repository hardening slice implemented; external security and operational drills remain pending.

## Implemented controls

- Provider parsers reject unknown fields, invalid UTF-8/JSON, unsupported versions, oversized
  frames/ciphertext, invalid identifiers, and excessive TTLs before storage.
- Account, device, socket, frame, byte, mailbox, delivery-batch, discovery, authentication, and
  HMACed-IP limits are independent.
- Client outgoing/event queues are bounded and reconnect uses capped exponential backoff.
- TLS is required outside explicit debug loopback; custom endpoints cannot contain credentials,
  query strings, or fragments and must pass `/v1/info` protocol validation before activation.
- Local-only remains the default. Provider failures never select an unknown fallback.
- The ESLint scan now excludes generated target directories and agent worktrees, removing the
  ambiguous multiple-tsconfig failure that previously prevented meaningful lint results.
- Worker/operator credentials remain outside source and the client bundle.

## Operational requirements before production

The operator must approve and execute the following:

1. Create distinct staging and production Cloudflare environments and least-privilege deployment
   identities.
2. Configure `ABUSE_HASH_KEY`, alert thresholds, request/storage budgets, sampling, retention, and
   deletion schedules.
3. Record Worker/Durable Object version, schema tag, endpoint, rollback artifact, state-export
   procedure, and compatible-provider migration procedure for every deployment.
4. Run quota/suspension/outage drills and confirm only rendezvous-backed capabilities degrade.
5. Run account/device/project deletion and credential-removal drills, including backups and stale
   offline devices.
6. Perform dependency, license, vulnerability, signing, SBOM, and secret-scanning review.
7. Obtain targeted external review of cryptography, opaque routing, filesystem publication, group
   membership/key rotation, provider boundary, and recovery.

Cloudflare Free is not a durability promise. Production approval requires a paid-plan contingency
and an export/migration path even if observed traffic remains inside free quotas.
