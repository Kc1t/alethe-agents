# ADR-0004: Opaque Google-Account Routing Without Provider Tokens

- Status: Accepted for the derivation mechanism; same-account automatic discovery remains
  unavailable until Phase 10B delivers a real rendezvous connection to exercise it against.
- Date: 2026-08-21

## Context

Two devices that have both locally verified the same Google account (Phase 1's
`complete_verified_identity`, gated on a real OAuth flow in `sync_mesh.rs`) need a way to prove to
a future rendezvous service that they belong to the same account, so the service can route an
encrypted invitation envelope or a same-account device list to the right mailbox. The threat model
and the security-gate prompt are explicit: this proof must never send a Google access token,
refresh token, authorization code, or ID token to the rendezvous service, and it must resist
account enumeration (a third party querying arbitrary route IDs must not learn whether an account
exists).

This is a hard blocker for automatic same-account discovery, not a later detail: without it,
Phase 10B may still deliver an invitation to an explicit recipient (the sender already knows the
intended `recipient_account_id`/`recipient_device_id` from the local invitation record), but it
cannot offer a same-account device list.

## Decision

1. **Derive the account route deterministically and locally on every device**, from data every
   trusted device for that account already has after Phase 1 verification — the Google `sub`
   claim (a stable, opaque, high-entropy identifier assigned by Google; it is not the email
   address and is not guessable in practice) — never from data that has to be transmitted for this
   purpose:

   ```text
   AccountRouteId = hex(SHA-256("alethe-account-route-v1" || account_id))
   ```

   `account_id` here is the existing `VerifiedAccount.account_id` field (the Google `sub`) already
   stored locally after a real OAuth verification. The literal domain-separation prefix prevents
   this hash from colliding with an unrelated use of SHA-256 over the same input elsewhere in the
   protocol.

2. **The route ID is computed independently by each device — there is no bootstrap message, no
   server-issued route, and no device-to-device exchange required.** Any device that has verified
   the same Google account locally computes the same `AccountRouteId` without coordination. This
   sidesteps the chicken-and-egg problem of needing a channel (Phase 4/10) to distribute a
   server-issued route before any channel exists.

3. **Proof of entitlement to the route is the same thing that already gates every other Phase 3
   capability: a Trusted device signature.** When a device registers with the (future) rendezvous
   service, it presents its Ed25519 device identity, its `AccountRouteId`, and a signature over a
   server-issued random challenge. The service can verify the signature came from a real device
   key, but it has no way to verify the route derivation itself — it must not need to, because the
   route is defined to be a one-way function of information the service never sees.

4. **Enumeration resistance**: `AccountRouteId` is a full 256-bit SHA-256 digest of Google's opaque
   `sub`, which is itself high-entropy and not sequential or guessable. An attacker who does not
   already know a target's Google `sub` cannot enumerate valid routes by brute force. This is the
   same enumeration-resistance argument already applied to invitation bearer tokens
   (`SYNC-INV-002`), reused here for a different purpose (routing rather than authorization).

5. **First-device bootstrap**: the first device for an account computes `AccountRouteId` the same
   way as every subsequent device — there is no special case, because the derivation never depends
   on any other device or any server state.

6. **Additional-device approval**: unchanged from Phase 1 (`approve_device_at`). A newly registered
   device can independently compute the correct `AccountRouteId` as soon as it has locally verified
   the same Google account, *before* it is `Trusted`. Route knowledge alone is not authorization —
   a `Pending` device can compute the route but cannot issue invitations or register for same-account
   discovery until an already-`Trusted` device approves it (SYNC-INV-003 is unchanged and remains
   the actual authorization gate; the route is routing information, not a permission).

7. **Account switching**: `disconnect_identity_at` already refuses to accept a second Google account
   on a device that still has trusted devices/state for the first one
   (`account_switch_requires_disconnect`). Because the route is a pure function of `account_id`,
   switching accounts after an explicit disconnect naturally yields a different, unrelated
   `AccountRouteId` with no leftover binding to the old route.

8. **Device revocation**: revoking a device (`revoke_device_at`) does not change `AccountRouteId` —
   the route identifies the *account*, not any one device. What changes is which device keys the
   rendezvous service will accept a valid challenge signature from for that route; a revoked
   device's signature must be rejected by the (future) Phase 10B service the same way local
   `sync_security.rs` already rejects a revoked device's local operations.

9. **Route rotation if a route identifier leaks**: because the derivation is a pure deterministic
   function of `account_id`, the *only* way to rotate the route is to change the salt/version
   prefix (`"alethe-account-route-v1"`) for that account, which requires either a new protocol
   version or an explicit per-account rotation counter persisted locally and included in the hash
   input. This ADR reserves a rotation counter field for that purpose but does not implement
   rotation UX; a leaked-route incident response is Phase 12 (security/operations) work.

10. **All-devices-lost recovery**: unaffected by this ADR. If every device for an account is lost,
    the account has no way to prove entitlement to *anything*, including its route — this is the
    same fundamental recovery problem Phase 1 already documents as open, not a new one introduced
    here.

## Consequences

- No Google token of any kind ever needs to reach a rendezvous service for routing purposes — the
  route is computed entirely from locally-verified state.
- Automatic same-account discovery becomes implementable in Phase 10B without any new client-side
  protocol beyond "present `AccountRouteId` and a signed device challenge" — it does not require a
  new bootstrap round-trip.
- The design trades unconditional unlinkability for enumeration resistance backed by Google `sub`
  entropy: a party that already knows a specific user's Google account `sub` (which Alethe never
  reveals) could compute the same route offline. This is judged acceptable because knowing a
  target's Google `sub` already implies a much stronger information position than Alethe's own
  local data ever exposes.
- Rotation is coarse (versioned, not per-incident) until Phase 12 designs incident-response tooling
  around it.

## Rejected alternatives

- **Server-issued opaque route handed out at first registration**: requires a channel to exist
  before any channel exists (the exact chicken-and-egg problem this ADR avoids), and requires the
  server to be trusted to hand out the *same* route to every device of the same account without
  itself learning the Google identity — strictly worse than local deterministic derivation.
- **Sending a Google ID token or its `sub` claim directly to the rendezvous service and letting it
  derive the route**: explicitly forbidden by the threat model; the service must never receive any
  Google-issued credential or claim.
- **Using the raw Google `sub` as the route ID with no hashing**: technically satisfies "device
  never sends a token," but needlessly exposes a stable Google-issued identifier to the rendezvous
  service's storage/logs; hashing costs nothing and removes that exposure.
