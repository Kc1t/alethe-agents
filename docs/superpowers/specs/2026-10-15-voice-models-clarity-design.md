# Voice settings clarity and pausable model downloads — Design

Date: 2026-10-15
Status: approved in conversation (sections 1–3); spec awaiting review.
Related: `2026-10-15-voice-providers-design.md` (the Voice page, providers, local models).
Follow-up (separate spec, later): searching and downloading sherpa-onnx models from Hugging Face.

## 1. What this is

Two changes to Preferences → Voice:

- **A. Clarity.** Every screen says what each option is for, which languages it covers, how it
  compares, and what is in use right now. The Local models screen becomes a comparison table whose
  rows expand into details. The Voice page gains an "In use" summary. Cloud provider pages use the
  same table for their models. Apple Speech and System voice pages show real status.
- **B. Pause and resume model downloads.** A download can be paused, resumed later (even after
  closing the app) or cancelled. Nothing resumes on its own.

Why: today the Local models list shows "Speech to text · 70.2 MB · Not downloaded" for every model.
It does not say where a model is used, which languages it understands, how models differ, or which
one is active, and model descriptions exist only in English inside the Rust catalog.

## 2. Decisions

Made in conversation:

1. **Local models is a comparison table**, split into two sections by use, and each row expands into
   a detail panel (layout chosen by the owner over sections-only and a card grid).
2. **Speed and accuracy are curated tiers** stored in the catalog, taken from each model's published
   benchmarks. Size, languages and status are real data. A model without tier data shows "—".
3. **Pause is persistent.** The partial download stays on disk. Closing the screen or the app keeps
   it as "Paused · X of Y MB". Only the person resumes it. Cancel deletes the partial files.
4. **Paused state is derived from the disk**, not stored in preferences.
5. **One download at a time**, as today.
6. **Hugging Face search is out of scope here**; it is the next spec and will reuse the table, the
   detail panel and the pausable downloader.

## 3. Non-goals

- Searching or adding models beyond the built-in catalog (next spec).
- Measuring speed or accuracy on the person's machine.
- Parallel downloads, bandwidth limits, scheduled downloads.
- Pausing the Apple language install (the OS does not offer it) or the verify/unpack phases.

## 4. Model metadata

The Rust catalog keeps ids, files, hashes, sizes and layouts. Everything a person reads moves to the
frontend so it can be translated.

New frontend module `src/lib/voice/modelInfo.ts`:

```ts
type Tier = 1 | 2 | 3            // 3 = best
interface ModelInfo {
  id: string                     // catalog id
  use: 'stt' | 'tts'
  languages: string[] | 'many'   // BCP-47 tags; 'many' with languageCount for large sets
  languageCount?: number
  speed?: Tier
  accuracy?: Tier
  recommended?: boolean
  summary: MessageKey            // one line: what it is good for
  details: MessageKey            // strengths and limits, 1–3 sentences
  voice?: { gender: 'female' | 'male' }   // TTS only
  sourceUrl?: string             // Hugging Face / GitHub page
}
```

Initial entries (tiers relative within the same use):

| id | use | languages | speed | accuracy | notes |
|---|---|---|---|---|---|
| parakeet-tdt-0.6b-v3-int8 | stt | 25 European languages incl. pt, en | 2 | 3 | recommended; detects language |
| zipformer-gigaspeech-en-int8 | stt | en | 3 | 2 | |
| zipformer-small-en-int8 | stt | en | 3 | 1 | smallest |
| whisper-base-int8 | stt | 99 languages | 3 | 1 | 28 s windows |
| whisper-small-int8 | stt | 99 languages | 2 | 2 | 28 s windows |
| moonshine-base-en-int8 | stt | en | 3 | 2 | short commands |
| piper-pt-br-faber-medium | tts | pt-BR | 3 | 2 | male |
| piper-en-us-amy-low | tts | en-US | 3 | 1 | female |

The Rust `description` strings stay for logs and tests but are no longer rendered. A catalog id with
no `ModelInfo` entry renders with the Rust label, "—" for tiers, and its `capability` as use.

## 5. User interface

All strings through `t()` in en, pt-BR and zh-CN. Tokens only, no gradients. One `.module.css` per
component.

### 5.1 Voice page

- **In-use summary** at the top, replacing the generic paragraph: one row per use (Dictation,
  Conversation, Narration) with the chosen provider, model or voice, and a "local" or "cloud" marker.
  A row is a button that switches to that tab.
- A row shows a warning when the use cannot work as configured: model not downloaded, key invalid
  or missing, Apple language not chosen. The warning text is the same as the card's.
- **Usage tabs** keep the Providers-style cards. The selected card's footer adds one summary line
  from `ModelInfo`: languages, speed and accuracy tiers.
- Each tab gets a **"Compare models"** action that opens the Local models table filtered to that
  tab's use.
- The Providers grid is renamed **"Accounts and models"** with the line "Set up API keys and download
  local models. Pick what each feature uses in the tabs above."

### 5.2 Local models table

```
← Accounts and models / Local models
Run on this computer: private, offline, no key.        [Speech → text | Text → speech | All]

SPEECH → TEXT · hears you in Dictation and Conversation
Model            Languages        Speed  Accuracy  Size    Status
Parakeet TDT v3★ 25 (incl. PT)    ●●○    ●●●       639 MB  ● In use: Dictation      [▾]
Whisper base     99               ●●●    ●○○       153 MB  ▇▇▇▁ 62% · 4 MB/s [Pause]
TEXT → SPEECH · reads replies aloud in Narration
Piper · Faber    Portuguese (BR)  ●●●    ●●○       64 MB   Downloaded
```

- Section headers name the use and where it applies. A segmented filter at the top shows one section
  or both.
- Tier cells are three dots with a tooltip "Based on the model's published benchmarks". Missing tier
  → "—".
- Status cell states:
  - Not downloaded
  - Downloading N% · speed · time left
  - Paused · X of Y MB
  - Verifying…
  - Unpacking… (Piper archives)
  - Downloaded
  - In use: Dictation, Conversation (any combination)
  - Error · Try again
- Row action by state: Download / Pause / Resume + Cancel / Remove. Other rows' Download is disabled
  while a download runs, with the tooltip "Another download is in progress". Pause is disabled during
  Verifying and Unpacking.
- **Expanded row**:
  - summary and details text;
  - full language list;
  - which uses it is active in, with "Use for Dictation / Conversation / Narration" buttons
    (only the uses matching its capability);
  - source link (opens in the browser);
  - folder on disk;
  - the same row actions.
- Rows are keyboard operable: the row toggle is a button with `aria-expanded`.

### 5.3 Cloud provider page

- **Header**: status badge (Connected / Invalid key / Not connected), "In use for: Narration" (or
  none) and a short privacy line.
- **Key block**: as today (Save / Test connection / Remove key).
- **Models**: the same table component, split by use. Columns: Languages, Voices (count), Price
  (only when the provider's API reports it, e.g. OpenRouter `pricing`; otherwise "—"). Search shows
  above 6 models.
- **Expanded row**: description when available, voices grouped by language (reusing
  `voiceLanguages.ts`), "Use for Narration / Dictation / Conversation".

### 5.4 Apple Speech and System voice pages

- Apple Speech: installed languages, permission state (granted / denied with an "Open System
  Settings" link), and the locale install action.
- System voice: voice count per language and a "Test" button that speaks the test sentence with the
  system voice.

## 6. Pause and resume

### 6.1 Rust (`src-tauri/src/speech.rs`)

- `SpeechState` gains `downloads: Mutex<HashMap<String, Arc<AtomicBool>>>`, one stop flag per active
  model download.
- The chunk loop (moved into a function that takes a byte stream, so it can be tested without the
  network) checks the flag after each chunk. On stop it writes what it has, flushes, closes the
  `.part`, and returns `Paused`.
- `speech_download_model` returns the error code `speech_download_paused` when paused; the frontend
  treats it as a state, not an error.
- **Resume** is `speech_download_model` again: complete files are re-verified by hash, the partial
  file continues with `Range` from its current size (existing behaviour).
- New command `speech_pause_download(modelId)`: sets the flag; no-op when idle.
- New command `speech_cancel_download(modelId)`: sets the flag, waits for the loop to stop, deletes
  every `.part` of that model (and the archive part for Piper), and removes the model folder if it
  holds nothing else.
- `speech_model_states` derives, per catalog entry:
  - `ready` when every file is present (or the TTS archive is unpacked);
  - `paused` when a `.part` exists or some but not all files exist, and no download is active;
  - `downloading` while active;
  - `not-downloaded` otherwise.
  It also returns `downloadedBytes` and `totalBytes` (complete files plus `.part` sizes).
- Progress events gain the phases `unpacking` and `paused` (frontend union updated).
- One download at a time stays enforced by the existing `download_lock`; a second request while one
  runs returns `speech_download_busy`.

### 6.2 Frontend

- `src/lib/tauri/speech.ts`: `speechPauseDownload`, `speechCancelDownload`, extended
  `SpeechModelState` (`status` adds `paused` | `downloading`, plus byte counts) and progress phases.
- The table maps state to status text and actions (§5.2). On mount it reads states, so a paused
  download shows after reopening the screen or the app.

## 7. Errors

- Network failure mid-download: the partial stays; the row shows "Error · Try again", which resumes.
- Hash mismatch after resume: the bad file is deleted (existing behaviour) and the row shows the
  error; Try again starts that file over.
- Cancel while verifying or unpacking: waits for that phase to finish, then deletes.
- Disk full: surfaced as the error text from Rust, mapped to a translated "Not enough disk space"
  when the OS error says so.

## 8. Testing

Rust:

- Pausing mid-stream leaves a `.part` whose size equals the bytes received.
- Resuming sends `Range: bytes=<part size>-` and finishes with a verified hash.
- Cancel deletes partials and the empty folder.
- State derivation from a temp folder gives `paused` with correct byte counts, `ready`,
  `not-downloaded`.
- A second download while one runs returns `speech_download_busy`.

TypeScript (vitest):

- `modelInfo` has an entry for every built-in catalog id.
- Table: tier rendering, "—" for missing tiers, filters, expanded row content, actions per state,
  "In use" from preferences, Download disabled during another download.
- Paused state shows after remount.
- In-use summary rows and their warnings; clicking switches tabs.
- Cloud page table with prices only when reported; voice grouping in the expanded row.

Docs: `docs/CHANGELOG.md` `[Unreleased]`, `docs/FEATURES.md` voice section, `docs/VOICE.md`.

## 9. Phasing

1. `modelInfo.ts` and translated strings; table component (read-only) replacing the Local models list.
2. Pause / resume / cancel in Rust and the table actions.
3. Expanded rows with "Use for …", in-use summary, "Compare models", Providers grid rename.
4. Cloud provider page table, Apple Speech and System voice pages.
5. Docs.
