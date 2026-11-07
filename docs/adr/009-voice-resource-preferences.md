# ADR-009: Voice resources are managed in the core Preferences

Status: accepted

## Context

The core already owns provider secrets, custom speech servers, and local model files. The
Preferences UI needs to manage those resources without depending on plugin voice behavior.

## Decision

Expose a core Preferences page with the stable id `voice`. Port resource management components
and IPC wrappers without importing narration, conversation, dictation, HUD, shortcut, or routing
state. Keep only non-secret provider connection flags in profile preferences; API keys remain
write-only inputs to the existing Rust commands. Missing flags default to an empty map.

## Alternatives rejected

- Porting the complete voice page would bind core settings to behavior owned by external plugins.
- Giving plugins key-management UI would duplicate the core's secret ownership and setup flow.
- Adding a second backend settings format would duplicate the existing profile persistence path.

## Consequences

Plugins can open resource settings through the `voice` page id. Model removal and provider key
removal update resources without selecting replacement behavior for plugins. Connection flags
describe the last setup or test result, rather than guaranteeing that a remote service is online.
