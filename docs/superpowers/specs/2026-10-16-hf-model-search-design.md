# Hugging Face model search for local voice models — Design

Date: 2026-10-16
Status: approved in conversation (sections 1–5); spec awaiting review.
Related: `2026-10-15-voice-models-clarity-design.md` (comparison table, detail panel, pausable
downloads). This is the follow-up that spec deferred.

## 1. What this is

Preferences → Voice → Local models gains a **"Search Hugging Face"** mode. It finds sherpa-onnx
models on Hugging Face for both uses — **text to speech** and **speech to text** — and downloads
them with the same table, detail panel and pausable downloader the built-in catalog uses.

Why: the built-in catalog has two voices (Piper Faber pt-BR, Piper Amy en-US) and six speech
recognizers. Hugging Face hosts ~250 Piper voices already converted for sherpa-onnx (about eleven in
Portuguese), Kokoro (far more natural, includes pt-BR) and many more recognizers (Whisper turbo and
large, SenseVoice, Paraformer, NeMo CTC, Dolphin).

## 2. Decisions

Made in conversation:

1. **Only models Alethe can run are listed.** Popular Hugging Face TTS models that need PyTorch
   (F5-TTS, XTTS, Chatterbox, Orpheus, original Kokoro) are hidden, not shown disabled.
2. **TTS and STT together**, in one feature.
3. **Live search with an author allowlist** (approach A). The app queries the Hugging Face API at
   runtime, only for repos by the sherpa-onnx maintainers: `csukuangfj`, `csukuangfj2`, `k2-fsa`.
   The allowlist is fixed in code.
4. **Family detector**: a repo is listed only when its name pattern **and** its file list match a
   known family (section 5). Anything else is hidden.
5. **Matcha and Canary are out**: Matcha needs a separately resolved vocoder and has few voices;
   Canary needs source/target language configuration.
6. **Speed and quality tiers for found models are estimates** from family and size, visibly marked
   as estimates. A small curated override table covers popular repos.
7. **State stays derived from disk** (as in the previous spec): an installed Hugging Face model is a
   folder with a manifest; `projects.json` only stores which model each use picked.
8. **Ranking**: likes, then downloads, then last update. Hugging Face download counters read 0 for
   most ONNX repos, so curated "recommended" overrides matter.

## 3. Non-goals

- Models outside the allowlist, gated or private repos, Hugging Face tokens.
- Streaming (online) recognizers; the app uses the offline recognizer.
- Matcha, Canary, Zipvoice, Pocket, Supertonic.
- Measuring speed or accuracy on the person's machine.
- Sharing `espeak-ng-data` between voices (each model folder is self-contained).
- Parallel downloads (still one at a time).

## 4. Architecture and data flow

New Rust module `src-tauri/src/speech_hub/`:

- `hf.rs` — Hugging Face API client (search, repo tree, small file fetch).
- `detect.rs` — pure family detector and file selection.
- `installed.rs` — reading, validating and writing on-disk manifests.
- `meta.rs` — languages, voices and estimated tiers.

Flow:

1. **Search** — `speech_hub_search({ use, query, language, sort, page })` calls
   `GET https://huggingface.co/api/models?author={a}&search={q}&full=true&sort=likes&limit=…` for each
   allowlisted author in parallel, merges, runs the detector on each result's `siblings` (no extra
   request per repo), filters by use and language, and sorts. Results are cached in memory for
   10 minutes per query. Hugging Face only matches the query against repo names, so the use and
   language filters run locally after detection; a page keeps fetching up to 3 API pages per author
   until it has 30 matches or the results run out. Each result carries: model id, repo, family, use, languages, voice count
   when known without a download, likes, downloads, last modified, license (from `cardData`), and an
   approximate size when the API provides one.
2. **Resolve** — expanding a row or pressing Download calls `speech_hub_resolve(repo)`:
   `GET /api/models/{repo}` for the commit SHA, then `GET /api/models/{repo}/tree/{sha}?recursive=true`
   for exact file sizes and LFS SHA-256s. The detector selects only the files the family needs
   (section 5). For Piper it also fetches the `*.onnx.json` (~5 KB) for language, quality and
   speakers. The result is cached for the session.
3. **Download** — the existing `speech_download_model` accepts an `hf:` id. It writes a pending
   manifest, then runs the existing `download_files` (pausable, resumes `.part`, emits
   `speech://download-progress`). `ModelFile` becomes owned (`String` fields) so dynamic entries fit.
   Files are saved under canonical names where the engine expects them (as the catalog already does
   for Zipformer). LFS files are checked by SHA-256; non-LFS files by exact size.
4. **Manifest** — `speech-models/hf--{author}--{repo}/alethe-model.json`:
   `{ version, id, repo, commit, family, use, layout, files: [{ name, path, size, sha256? }],
   meta: { label, languages, voices, quality, license, lastModified } , complete }`.
   A paused download keeps `complete: false`, so after a restart the model reads as "Paused · X of
   Y MB" from `disk_state`, like catalog models.
5. **Listing** — `speech_list_models` and `speech_model_states` return the static catalog plus every
   valid manifest. Manifests are re-validated on every read (section 9); invalid ones are skipped and
   logged.
6. **Engine** — the STT `Layout` enum gains `SenseVoice`, `Paraformer`, `NemoCtc`, `Dolphin` and
   becomes serializable (owned strings); a new `TtsLayout { Vits { model }, Kokoro, Kitten }` drives
   `tts_local`. `build_recognizer` and the TTS engine build their config from the layout of the
   catalog entry or the manifest. Catalog entries are unchanged; Faber and Amy keep their GitHub
   tar.bz2 downloads.

Model id for a Hugging Face model: `hf:{author}/{repo}`. Preferences store it the same way they
store catalog ids. Delete, cancel and pause commands accept it.

## 5. Family detector

A repo is detected only when the **repo name pattern** and the **required files** both match.
Excluded by name: `streaming`, `online`, `-apk`, `wheels`, `test`, audio tagging, diarization,
denoiser, punctuation, speaker id.

| Family | Use | Repo name | Files downloaded (int8 preferred) | sherpa config |
|---|---|---|---|---|
| Piper / VITS | TTS | `vits-piper-*`, `vits-*` | `*.onnx`, `*.onnx.json` (when present), `tokens.txt`, `espeak-ng-data/**` | `vits` |
| Kokoro | TTS | `kokoro-*` | `model*.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/**`, `lexicon-*.txt`, `dict/**`, `*.fst` | `kokoro` |
| Kitten | TTS | `kitten-*` | `model*.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/**` | `kitten` |
| Transducer | STT | `*zipformer*`, `*parakeet*`, `*nemo-transducer*`, `*conformer*` (not CTC) | `encoder*`, `decoder*`, `joiner*`, `tokens.txt` | `transducer` (`nemo_transducer` for NeMo) |
| Whisper | STT | `*whisper-*` | `{x}-encoder.int8.onnx`, `{x}-decoder.int8.onnx`, `{x}-tokens.txt` | `whisper` |
| Moonshine | STT | `*moonshine*` | `preprocess.onnx`, `encode*.onnx`, `uncached_decode*.onnx`, `cached_decode*.onnx`, `tokens.txt` | `moonshine` |
| SenseVoice | STT | `*sense-voice*` | `model.int8.onnx` (or `model.onnx`), `tokens.txt` | `sense_voice` |
| Paraformer | STT | `*paraformer*` | `model.int8.onnx` (or `model.onnx`), `tokens.txt` | `paraformer` |
| NeMo CTC | STT | `*nemo-ctc*` | `model.int8.onnx` (or `model.onnx`), `tokens.txt` | `nemo_ctc` |
| Dolphin | STT | `*dolphin*` | `model.int8.onnx` (or `model.onnx`), `tokens.txt` | `dolphin` |

Rules:

- When an int8 and a full-precision variant both exist, only the int8 is downloaded. When only
  full precision exists, it is used. External `.weights` files of a skipped variant are skipped too.
- `test_wavs/`, `README*`, `MODEL_CARD`, `LICENSE`, scripts (`*.py`, `*.sh`), `.gitattributes`,
  `config.yaml` and other files the family does not need are never downloaded.
- Transducer files with epoch names (`encoder-epoch-99-avg-1.int8.onnx`) are saved as
  `encoder.int8.onnx` etc., matching what `build_recognizer` reads. Whisper keeps its prefix in the
  layout.
- The detector is a pure function `detect(repo: &str, files: &[RepoFile]) -> Option<Detected>`,
  tested against real Hugging Face API JSON fixtures in `src-tauri/src/speech_hub/testdata/`.

## 6. Metadata, tiers and voices

Languages (real data when it exists):

- Piper: `language.code` from `*.onnx.json` (falls back to the `xx_YY` token in the repo name).
- Kokoro and Kitten: static table per known version (Kokoro v1.0: en-US, en-GB, es, fr, hi, it, ja,
  pt-BR, zh; v1.1: zh, en; v0.19: en; Kitten: en). An unknown version shows "—".
- STT: language tokens in the repo name (`zh-en-ja-ko-yue`, `en`, `pt`, `ru`, …), `multi-lang` reads
  as "Multiple"; Whisper (non-`.en`) reads as 99 languages. No hint → "—".

Estimated tiers (`speed`/`quality`, 3 = best), shown with an "≈" marker and the tooltip "Estimated
from the model family and size" instead of "Based on the model's published benchmarks":

- TTS: Piper x_low/low 3/1, medium 3/2, high 2/2 · Kokoro 2/3 · Kitten nano 3/1, mini 3/2.
- STT: Whisper tiny/base 3/1, small 2/2, medium 1/2, turbo 2/3, large 1/3 · Moonshine tiny 3/1,
  base 3/2 · SenseVoice 3/2 · Paraformer 3/2 · NeMo CTC small 3/1, medium 3/2, large 2/2 ·
  Zipformer 3/2 · Parakeet 2/3 · Dolphin base 3/2, small 2/2.
- Unmatched size → "—".

Curated overrides: `src/lib/voice/modelInfo.ts` accepts entries keyed by `hf:` ids (summary, details,
tiers, recommended). These replace the estimates and drop the "≈" marker. Initial overrides: Kokoro
multi-lang v1.0, Piper pt_BR cadu/jeff/faber, Whisper turbo, SenseVoice 2024-07-17.

Texts: one summary and one details string per family through `t()` (en, pt-BR, zh-CN), e.g. "Piper
voice: light and fast, runs on any CPU."

Voices:

- Piper multi-speaker: `speaker_id_map` from `*.onnx.json`.
- Kokoro and Kitten: static speaker name table per known version (for example `pf_dora`, `pm_alex`
  are Portuguese). Names are grouped by the language their prefix encodes.
- The table shows a **Voices** column (count). A ready multi-speaker model gets a voice picker in its
  detail panel and in the Narration card. The choice goes to the existing `voice` field of the TTS
  choice; `tts_local::synthesize` takes a speaker id. A missing or out-of-range voice falls back to
  speaker 0.

## 7. User interface

All strings through `t()` in en, pt-BR and zh-CN. Tokens only, no gradients, one `.module.css` per
component.

```
← Accounts and models / Local models
[ Installed | Search Hugging Face ]            [Speech → text | Text → speech | All]

[ pt, kokoro, whisper…           ]  Language: [Any ▾]   Sort: [Most liked ▾]
Models converted to run offline on this computer. Estimates are marked ≈.

TEXT → SPEECH
Model                 Languages   Speed  Quality  Voices  Size     ♥   Status
Kokoro multi-lang v1  9 (incl PT) ≈●●○  ≈●●●     53      ≈330 MB  3   Not downloaded  [Download]
Piper · cadu (pt-BR)  PT (BR)     ≈●●●  ≈●●○     1       ≈63 MB   0   Downloaded      [Remove]
SPEECH → TEXT
Whisper turbo         99          ≈●●○  ≈●●●     —       ≈1.0 GB  1   ▇▇▁ 41% · 6 MB/s [Pause]
```

- **Installed** is today's table: catalog plus downloaded Hugging Face models, mixed within each
  section. Hugging Face models carry a "Hugging Face" badge.
- **Search Hugging Face**: query field with 400 ms debounce and a 2-character minimum; an empty
  query lists the most liked models for the selected use. Language filter (the app's language list)
  and sort (most liked / recently updated). "Load more" pages 30 results at a time.
- Size shows "≈" until the model is resolved; expanding the row resolves it and shows the exact
  size of the files that will be downloaded.
- Detail panel for a Hugging Face model: family summary and details, languages, voices (picker when
  ready), "N files · X MB to download", license, author, last updated, short commit, "Open on
  Hugging Face", and the same "Use for …" buttons as catalog models.
- States: loading (placeholder rows), no results, Hugging Face unreachable / offline with "Try
  again", rate limited (HTTP 429) with its own message. Installed models keep working in every case.
- Each usage tab's "Compare models" action gains a "More models" link that opens the search mode
  filtered to that tab's use.

New frontend pieces (names indicative): `HubSearchView.tsx`, `useHubSearch.ts`, `hubMeta.ts`
(family texts, estimate marker, Kokoro/Kitten speaker tables), `VoicePicker.tsx`; Tauri wrappers in
`src/lib/tauri/speech.ts`; types in `src/lib/types.ts`.

## 8. Error handling

- Search or resolve failure: translated message by kind (offline, unreachable, rate limited,
  unexpected response); retry button; no effect on installed models.
- Download failure or checksum mismatch: same handling as catalog downloads (error state, Try
  again, partial files kept for resume unless the checksum failed).
- A repo changes after resolve: the commit is pinned, so downloads stay consistent; a 404 on a
  pinned file fails the download with "model no longer available".
- sherpa fails to load a downloaded model: the model state shows "incompatible model" with Remove.
- Removing a model in use: the existing fallback (`clearLocalModelUses`) applies.

## 9. Security

- All network access is in Rust; the webview CSP is unchanged. Requests go only to `huggingface.co`;
  redirects are followed only to Hugging Face CDN hosts (`cdn-lfs*.hf.co`, `*.xethub.hf.co`,
  `cas-bridge.xethub.hf.co`), checked against a fixed list.
- Author allowlist fixed in code; not configurable from the UI.
- Repo ids and file paths validated: `[A-Za-z0-9._-]` segments, no `..`, no absolute paths, no
  backslashes. The final path must stay inside the model folder (same rule as `extract_tar_bz2`).
- Commit pinned at resolve. LFS files verified by SHA-256; non-LFS files by exact size and capped at
  5 MB each. A model larger than 4 GB is not offered.
- Manifests read from disk are re-validated (known family, safe paths, files present) before any
  sherpa config is built; an invalid manifest hides the model.
- No Hugging Face token; public, non-gated repos only.

## 10. Testing

Rust:

- Detector: one real fixture per family, plus rejections (streaming repo, unknown family, missing
  required file, full-precision-only model over the size cap, path traversal in a file name, author
  outside the allowlist).
- File selection: int8 preferred, skipped `.weights`, canonical renames.
- Manifest: round trip, re-validation, pending manifest reads as paused.
- Config building per layout (STT and TTS) from a manifest.
- Tier and language derivation.
- Redirect host check.

Frontend (vitest):

- Search mode: debounce, minimum length, loading / empty / error / 429 states, load more.
- "≈" size replaced by the exact size after resolve; estimate marker vs curated override.
- Voice picker writes the `voice` field; fallback when the voice is gone.
- Installed tab mixes catalog and Hugging Face models; badge shown.

Manual:

- Download Kokoro multi-lang v1.0 and Piper pt_BR cadu; narrate in Portuguese with a chosen voice.
- Download Whisper turbo and SenseVoice; dictate.
- Pause, quit the app, reopen, resume, cancel.
- Disconnect the network: search shows the offline state, installed models still work.

## 11. Documentation

- `docs/CHANGELOG.md` `[Unreleased]`: Hugging Face model search for local voices and speech
  recognition; voice picker for multi-voice models.
- `docs/FEATURES.md` and `docs/VOICE.md`: the search mode, supported families, allowlist and
  verification rules.
