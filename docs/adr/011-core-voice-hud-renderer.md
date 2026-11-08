# ADR-011: The core renders the floating voice HUD

Status: accepted

## Context

The backend opens the voice HUD with the same entry page as the main window. Mounting the app
shell there would activate a second plugin host and risk writes to the main window's workspace.
Conversation behavior is moving to an external plugin, while the shared native HUD remains core.

## Decision

Route the voice-hud window to the PR #336 renderer before mounting React, and mark its projects
store read-only. Retain the presentation view and only the helpers it imports. Keep conversation
controllers in plugins. Read the profile once for theme definitions, then apply language and
appearance from published HUD state. Document the existing JSON state/action codec for publishers.

## Alternatives rejected

- Mounting the app shell in every window creates competing plugin hosts and workspace writers.
- Shipping the entire conversation controller in core duplicates behavior owned by plugins.
- Rendering plugin code in the HUD requires a second plugin lifecycle for a shared core resource.

## Consequences

The HUD preserves the PR's picker, permission controls, narration highlighting, spectrum, and drag
behavior. The plugin publishes complete state and handles actions, including dismiss and restart.
The core translates its own labels; publishers supply translated text for plugin notices. The
existing backend relay and persisted workspace format do not change.

## Source references

- `VoiceHud`: [src/components/VoiceHud/index.tsx:29](../../src/components/VoiceHud/index.tsx#L29).
- Window routing: [src/main.tsx:63](../../src/main.tsx#L63).
- `setProjectsReadOnly`: [src/stores/projectsStore.ts:378](../../src/stores/projectsStore.ts#L378).
- `decodeHudState`: [src/lib/voice/hudState.ts:95](../../src/lib/voice/hudState.ts#L95).
