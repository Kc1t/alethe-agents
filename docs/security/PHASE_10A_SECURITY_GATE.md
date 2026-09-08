# Phase 10A Security Gate — Evidence Ledger

Status: **in progress**. Maps the Phase 10A requirements from
`docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md` (§ Phase 10A) and
`docs/adr/ADR-0002-optional-cloudflare-rendezvous.md` (items 1–3 of "Planned Phase 10
implementation") to implementation and test evidence. This phase implements only the
provider-independent activation gate and settings/state machine — no Cloudflare-specific code
exists anywhere in this codebase. `resolve_capabilities_at` (Phase 3) is unchanged; nothing in this
phase makes `projectTransfer`/`sharedTasks`/`projectChat` available, since no real provider exists
yet to actually connect to (that is Phase 10B).

| # | Requirement | Implementation | Authoritative test | Status | Unresolved risk |
| --- | --- | --- | --- | --- | --- |
| 10A.1 | Collaboration is an optional component; local-only users make no rendezvous connection | `ServiceMode::LocalOnly` is the default for every new install (`ServiceSettings::local_only`); `resolve_activation_state` returns `Disabled` whenever `mode == LocalOnly`, and no code path in `sync_activation.rs` performs any network I/O — there is no network-capable code in this module at all, only local file persistence | `local_only_never_attempts_a_connection` | Done | True by construction: this module contains zero networking code, so "never connects" holds unconditionally, not just under test |
| 10A.2 | Operator-managed default endpoint requires no Cloudflare account/token/domain/certificate from the user | `ServiceMode::AletheManaged` takes no `custom_endpoint` (`set_mode_at` only accepts one for `AdvancedCustom`) — selecting it requires no endpoint string, credential, or configuration field from the user at all | `enabling_with_identity_and_no_connection_attempt_yet_is_ready` (enables `AletheManaged` with `custom_endpoint: None`) | Done | The actual operator-managed endpoint address does not exist yet (no Phase 10B deployment) — this phase proves the *mode selection* requires nothing from the user, not that a real managed connection succeeds |
| 10A.3 | A separated advanced mode accepts a compatible custom rendezvous endpoint | `ServiceMode::AdvancedCustom` + `validate_endpoint_at`, gated behind an `EndpointValidator` trait; enabling is refused (`ActivationError::InvalidEndpoint`) until validation has succeeded for the exact currently-configured endpoint | `advanced_mode_requires_a_validated_custom_endpoint_before_enabling`, `changing_endpoint_clears_the_previous_validation` | Done | No real validator exists yet (scheme/TLS/protocol/health checks against a live endpoint are Phase 10B territory); the trait and refusal-until-validated behavior are proven against a test double only |
| 10A.4 | Capability states: disabled, identity required, ready, connecting, online, retrying, direct only, needs attention | `ActivationState` enum with all eight variants; `resolve_activation_state` is a pure function computing the state from settings + identity + `LiveConnectionStatus` | `full_lifecycle_via_a_scripted_provider_status` exercises `Connecting`/`Online`/`Retrying`/`DirectOnly`/`NeedsAttention`; `enabling_without_verified_identity_is_identity_required` and `local_only_never_attempts_a_connection` cover the remaining two | Done | `LiveConnectionStatus` is always supplied by the caller — there is no live provider loop that produces it yet, so `Connecting`/`Online`/`Retrying`/`DirectOnly` are proven reachable in principle but never actually reached during real operation (`sync_resolve_activation_state`'s Tauri/Web handlers always pass `NoAttemptYet`, documented explicitly at the call site) |
| 10A.5 | Activate contextually (share, open invitation, enable discovery, open a collaboration feature) — never connect proactively | `ActivationTrigger` enum (exhaustive, including a `LocalOnlyAction` variant used only to prove the negative case) + `should_offer_activation`, which is `true` only when the trigger requires rendezvous and the service is not already enabled | `contextual_activation_is_never_offered_for_local_only_actions_or_once_enabled` | Done | `should_offer_activation` is a pure decision function; no UI wires it to an actual prompt yet (no UI this phase — see non-goal below) |
| 10A.6 | Persist only non-secret provider preferences locally | `ServiceSettings` has exactly seven fields, all non-secret (mode, enabled flag, endpoint strings, protocol range, timestamp) — no token/credential/private-key field exists on the struct | `only_non_secret_settings_fields_exist_on_the_persisted_struct` (exhaustive destructure; adding an eighth field without updating this test fails to compile) | Done | The exhaustive-destructure technique catches an added field, but does not itself judge whether a *newly added* field is secret — that judgment still requires a human reviewer at the time such a field is proposed; recorded so this isn't oversold as an automatic secret-detector |
| 10A.7 | Validate TLS, endpoint identity, protocol compatibility, and health before reporting ready | `EndpointValidator` trait, called by `validate_endpoint_at`; a failed validation never sets `validated_endpoint`, so `enable_service_at` for `AdvancedCustom` stays refused | `failed_validation_never_silently_falls_back_to_ready` | `[~]` The trait's *shape* and *refusal-on-failure* behavior are proven; no implementation exists yet that performs real TLS/protocol/health checks (Phase 10B) | The test double (`AcceptingValidator`) only checks a URL prefix — nowhere near a real TLS/protocol/health check; this is deliberately a stand-in, not a claim of real validation |
| 10A.8 | Keep local projects, agents, terminals, local device security, and out-of-band invitation links available when the component is disabled/unavailable | True by construction — `sync_activation.rs` is a new, self-contained module; nothing in Phases 1–9 was modified to depend on it, so every existing local feature is provably unaffected by this module's presence | N/A — no existing test needed to change; the full regression suite (`cargo test --lib`) passing unchanged is the evidence | Done | — |

## Phase 10A proof checklist

- `[x]` `LocalOnly` never attempts a connection — `local_only_never_attempts_a_connection`.
- `[x]` The managed mode requires no Cloudflare account/token/domain/certificate from the user —
  true by construction (`AletheManaged` accepts no endpoint or credential parameter at all).
- `[x]` An unvalidated advanced/custom endpoint can never be enabled —
  `advanced_mode_requires_a_validated_custom_endpoint_before_enabling`,
  `failed_validation_never_silently_falls_back_to_ready`.
- `[x]` Changing the endpoint invalidates any prior validation — `changing_endpoint_clears_the_previous_validation`.
- `[x]` All eight capability states are representable and reachable given the right inputs —
  `full_lifecycle_via_a_scripted_provider_status` plus the identity/local-only tests.
- `[x]` Activation is only ever offered for a feature that actually needs rendezvous, and never
  once already enabled — `contextual_activation_is_never_offered_for_local_only_actions_or_once_enabled`.
- `[x]` Only non-secret fields are ever persisted — `only_non_secret_settings_fields_exist_on_the_persisted_struct`.
- `[ ]` Real TLS/endpoint-identity/protocol/health validation against a live endpoint — not
  attempted this phase; the validator is a trait with a test double only, honestly recorded as
  Phase 10B scope, not partially claimed here.

## Desktop/Web parity

| Operation | Tauri command | Web route |
| --- | --- | --- |
| Get current settings | `sync_get_activation_settings` | `GET /api/sync/activation` |
| Set mode / custom endpoint | `sync_set_activation_mode` | `POST /api/sync/activation/mode` |
| Enable service | `sync_enable_activation` | `POST /api/sync/activation/enable` |
| Disable service | `sync_disable_activation` | `POST /api/sync/activation/disable` |
| Resolve current activation state | `sync_resolve_activation_state` | `GET /api/sync/activation/state` |

`validate_endpoint_at` is a Core function with full test coverage but is **not** exposed as a Tauri
command or Web route this phase: it takes an `EndpointValidator` implementation as an argument, and
no real implementation exists yet to wire behind a command — exposing it today could only ever call
a test double, which would be misleading to a real caller. This will be connected once Phase 10B
provides a real validator.

## Deliberate non-goal: no UI, no live provider, no Cloudflare code this phase

Consistent with every phase since Phase 5: no UI is added (nothing here changes what a user sees),
and no network code exists anywhere in this module. `resolve_capabilities_at` (Phase 3) is
unchanged. This phase proves the settings persistence, mode/endpoint validation gating, and the
full eight-state activation state machine against local test fixtures and scripted provider status
inputs — exactly the "mechanism proven, live wiring deferred" pattern used in every phase since
Phase 4.

## Fail-closed confirmation

- `enable_service_at` refuses to enable `AdvancedCustom` mode without a prior successful
  `validate_endpoint_at` call against the exact currently-configured endpoint.
- `set_mode_at` always clears `enabled` and `validated_endpoint` on any mode/endpoint change — a
  stale validated/enabled state can never survive a configuration change.
- `resolve_activation_state` returns `Disabled` for `LocalOnly` regardless of any other input
  (identity, live status) — there is no combination of inputs that produces a non-`Disabled` state
  while `mode == LocalOnly`.

## Reviewer trace

Every row above names the exact file and test function; running `cargo test --lib sync_activation`
reproduces all Phase 10A evidence in this document.
