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

## Key rotation, account export, and project-access deletion (`sync_security.rs`)

Three previously-pending Phase 12 items are now implemented, tested, and exposed through Tauri
commands and equivalent authenticated Web routes:

- **`rotate_device_keys_at`** — rotates a trusted device's Ed25519 identity key and X25519
  agreement key together, keeping the same `device_id`. Old key material is overwritten in the
  credential store, never left retrievable alongside the new keys. Rejects an untrusted or unknown
  device (`actor_device_not_trusted` / `actor_device_unknown`). Tested: both key pairs actually
  change, the new binding verifies, the credential store holds only the new secret afterward.
  **Scope note**: this rotates local key material only — nothing here notifies any other device
  that cached the old public key, because no live peer-notification channel exists yet (the same
  "mechanism proven, live wiring deferred" limitation as every prior phase's transport-adjacent
  work). A caller integrating this into a live product flow would need to pair it with a
  `sync_rendezvous` broadcast once that exists.
- **`export_account_data_at`** — produces a redacted, JSON-serializable snapshot of the local
  account's collaboration state (account info, device fingerprints/trust/timestamps, invitation
  summaries, grants) for a user to review or archive before deleting their account. Never includes
  raw public-key bytes, invitation bearer tokens, or token hashes — tested by asserting none of
  those values appear anywhere in the serialized export.
- **`delete_project_access_at`** — revokes every still-active grant and pending invitation for one
  project in a single call, instead of requiring the caller to revoke each individually. Only a
  trusted device on the project's issuing account may call it (same ownership check as
  `revoke_grant_at`). Already-redeemed invitations correctly keep their historical `Redeemed`
  state rather than being retroactively marked `Revoked` — only the resulting grant is revoked.
  Idempotent: calling it again on an already-cleared project returns `0`, not an error. Tested for
  the correct-project-only scope, the redeemed-vs-pending distinction, an unknown-actor rejection,
  and a project with no access at all (safe no-op, not a silent bypass).

Explicitly not built this phase: **device recovery** (regaining account access after losing every
trusted device) and standalone **credential deletion** as a narrower operation than the full
`disconnect_identity_at` — both remain open scope decisions requiring product input on what
"recovery" should mean without a self-hosted identity provider to fall back on, which the account
export above only partially substitutes for (it lets a user *archive* their state, not recover
access to it).

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
