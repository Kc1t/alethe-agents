# ADR-008: Typed plugin access to core voice services

Status: Accepted

## Context

Plugin API 3 exposes typed terminal operations through `createPluginTerminals`
(`src/lib/plugins/terminals.ts:60`), while `createContext` wires plugin services to the manifest's
capability check and deactivation subscriptions (`src/lib/plugins/host.ts:103`). Voice credentials
belong to the core. `read_key_async` reads them on a blocking worker
(`src-tauri/src/voice_providers/keys.rs:163`).

## Decision

Add `createPluginVoice` (`src/lib/plugins/voice.ts:6`) using the same factory inputs and subscription
ownership. Separate microphone/transcription, speech playback, and HUD/shortcut access with
`voice.listen`, `voice.speak`, and `voice.hud`. Keep provider discovery and opening Voice preferences
available without an additional capability. Expose only boolean key availability through
`voice_provider_key_status` (`src-tauri/src/voice_providers/keys.rs:207`). Construct command arguments
explicitly so extra JavaScript properties cannot inject keys into typed calls.

Keep API 3 and require feature detection on earlier API 3 apps. Preserve the existing catalog command
shape and compose it with key status in the facade rather than changing existing catalog consumers.

## Alternatives rejected

- Raw `context.invoke` alone leaves plugins duplicating command contracts and credential handling.
- Exposing a key setter or raw-key cloud transcription contradicts core ownership of credentials.
- Testing provider credentials to discover availability would introduce network requests and conflate
  a missing credential with a provider outage.
- Increasing the API version would exceed this additive change's agreed scope.

## Consequences

The facade carries typed command results and event payloads. Pending event registration is cleaned
up on deactivation; registration errors enter the Audit Center. Shared microphone, playback, HUD,
and shortcut ownership still requires coordination between plugins. Key availability checks may
trigger an OS keychain access prompt and propagate keychain failures.

The published-plugin compatibility audit is unverified: this environment blocked GitHub API calls
and read-only clones. The four requested raw key/server write restrictions remain deferred until
that prerequisite can be checked; `agent_voice_set_key` remains explicitly invokable.
