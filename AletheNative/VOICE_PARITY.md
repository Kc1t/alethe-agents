# Dictation and Jev parity (k2)

Scope: audit2 backlog items 10 and 11. The final k2 assignment supersedes the project/group image
assignment included earlier in the prompt. No sidebar cover or project/group model files changed.

## Source and implementation

Read directly from `origin/main`, without checking it out:

- `src/components/modals/preferences/VoiceDictationSection.tsx` and
  `src/components/modals/PreferencesModal.module.css`: enable, explicit Toggle/Hold, microphone,
  model status/download. Segmented controls use a 3pt inset, 110pt minimum button width, 34pt
  button height, 14pt horizontal padding, 11pt font. Microphone selection is at most 360pt wide.
- `src/components/DictationButton/index.tsx`: Cmd/Ctrl+E, hold release, Escape cancellation.
- `src/components/VoiceCommand/index.tsx` and `VoiceCommand.module.css`: Cmd/Ctrl+Shift+Space
  opens/closes the voice surface; F9 holds while open; Return confirms. The microphone orb is
  58pt with a 21pt SF Symbol, 12pt caption gap and 44pt bottom inset. Confirmation uses the
  web's 20/24pt padding, 280–420pt width and 32pt radius.
- `src/components/VoiceHistoryPanel/index.tsx` and `VoiceHistoryPanel.module.css`: 44pt header,
  15pt microphone, 14pt heading, 26pt Clear button, 10pt content inset, 8pt card gap, 10/12pt
  card padding, 13pt summary, 11pt transcript, 10pt monospaced status/time.
- `src/stores/voiceHistoryStore.ts`: session-only newest-first history capped at 50 entries.

All web rendering branches on `metrics.isWebInterface`. The old native history view is retained,
renamed `NativeVoiceHistoryPanel`; native Integrations sections and Option+Cmd+E remain available.
The existing shared Components.swift is unchanged; task-specific segments are in
`Components+Dictation.swift`. Workspace and preference JSON schemas are unchanged.

## Engine differences and remaining parity

- The existing native engine is macOS 26 `SpeechAnalyzer` / `SpeechTranscriber`, not the web's
  Parakeet/Whisper catalog. Settings list real supported language assets and download via
  `AssetInventory.assetInstallationRequest`, with actual `Progress.fractionCompleted`.
  Apple provides no model-delete API here; Settings explains that macOS manages removal.
  No fake byte sizes, unsupported provider switch or cloud API-key field is shown.
- Microphone selection resolves capture-device UIDs to Core Audio device IDs and changes only
  this engine's input unit. Missing/unplugged selection reports an error rather than silently
  using another microphone. System default remains the empty selection.
- Jev matches localized built-in/plugin Find/Jump command titles, ignoring punctuation, case and
  diacritics. Unknown or ambiguous titles are blocked; availability is checked again before Run.
  It invokes the existing registry, with no model-generated shell execution. Recorded actions mean
  the command was invoked; editor commands can still require user input.
- The cloud Jev planner's free-form project/agent inference, prompt execution, costs/confidences,
  continuous listening and VAD spectrum are not ported. The n3 follow-up adds edge breathing/scanning
  and the traveling confirmation border with the CSS timing and geometry, using solid theme colors
  and honoring reduced motion. This remains a deliberate
  native-engine subset, not full natural-language planner parity. Gradient effects also conflict
  with the repository's design rule.
- Voice history records failures, blocked matches, waiting confirmations and invoked commands.
  Clear cancels any pending confirmation; Escape blocks a pending entry. Transcripts never go to
  a text field or terminal during a Jev recording.
- Local dictation preferences use UserDefaults to avoid a workspace schema change. They are not
  exported with the web preferences. Existing native dictation continues to use interface language
  and default input rather than these web-only controls.

## Validation and handoff memory

- Passed `python3 AletheNative/Scripts/check-strings.py` (English and pt-BR, no orphan keys).
- Passed `swiftc -frontend -parse` for changed/new speech/UI sources and UI tests. Syntax parsing
  does not typecheck SDK use or prove runtime correctness.
- Passed `git diff --check`.
- Added UI coverage for disabled voice capture, denied microphone recovery, history Clear and the
  original native shortcut. Tests were authored but not executed: the owner prohibits builds in
  this nested sandbox. No app/server process was stopped or restarted.
- Reviewer must build/typecheck outside the sandbox and run DictationTests plus the hit-target
  harness, then exercise real microphones, language downloads, short/long Cmd+E holds, F9 release,
  cancellation during download/start, and command confirmation. No screenshot comparison was done.
- No ai-memory skill/provider is available in this session. This section records the outcome,
  constraints and next steps for handoff; an external ai-memory write remains unavailable.
- No commits, staging, push, web changelog or migration-plan edits.
