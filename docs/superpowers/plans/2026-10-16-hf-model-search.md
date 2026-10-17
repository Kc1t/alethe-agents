# Hugging Face Model Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Preferences → Voice → Local models search Hugging Face for sherpa-onnx voices (TTS) and recognizers (STT), and download, manage and use them exactly like built-in catalog models.

**Architecture:** A new Rust module `speech_hub/` queries the Hugging Face API (allowlisted authors only), detects the sherpa family from each repo's file list, plans which files to fetch, and writes a manifest into the model folder once a download starts. `speech.rs` lists catalog models plus valid manifests, downloads Hugging Face files through the existing pausable downloader (SHA-256 for LFS files, git blob SHA-1 for the rest), and builds recognizer/TTS configs from owned layout enums (`SttLayout`, `TtsLayout`) shared by catalog and Hugging Face models. The frontend adds a search mode to the existing comparison table, reusing rows, detail panel and download actions.

**Tech Stack:** Tauri 2, Rust (`reqwest` 0.12, `serde`, `sha2`, `sha1`, `tokio`, `futures-util`, `sherpa-onnx` 1.13.6), React 19 + TypeScript, Zustand, CSS Modules, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-hf-model-search-design.md`

## Global Constraints

- Never start, stop or restart the app or dev server; rely on HMR.
- No commits, no `git add`/`stash`/`checkout`/`reset` (owner's rule). Every "commit" step below is replaced by "leave changes in the working tree".
- Every visible string through `t()`; keys in `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`. Interpolation is single-brace `{param}`.
- One `.module.css` per component; colors/radii/shadows only via `src/styles/theme.css` tokens; no gradients; no vendor logos.
- English in code, comments, docs, changelog.
- Allowlisted authors, fixed in code: `csukuangfj`, `csukuangfj2`, `k2-fsa`.
- Network hosts: requests to `huggingface.co`; redirects only to `huggingface.co`, `*.huggingface.co`, `hf.co`, `*.hf.co` over HTTPS.
- Supported families — TTS: VITS/Piper, Kokoro, Kitten. STT: Zipformer transducer, NeMo transducer (Parakeet), Whisper, Moonshine, SenseVoice, Paraformer, NeMo CTC, Dolphin. Matcha, Canary and streaming models are excluded.
- Model id of a Hugging Face model: `hf:{author}/{repo}`; folder: `speech-models/hf--{author}--{repo}/`; manifest: `alethe-model.json`.
- Limits: a model over 4 GiB is not offered; a non-LFS file over 16 MiB is not offered. (Spec §9 said 5 MB for non-LFS files; Kokoro's `dict/idf.utf8` is 6 MB and stored outside LFS, so the cap is 16 MiB and every non-LFS file is verified by its git blob SHA-1 instead of size only.)
- Estimated tiers are marked "≈" with the tooltip "Estimated from the model family and size"; curated tiers are not.
- State stays derived from disk; `projects.json` only stores which model each use picked.
- Format and lint only the files you touch (`npx prettier --write`, `npx eslint --fix`); `rustfmt` only new Rust files and the lines you touch in existing ones.
- `docs/CHANGELOG.md` `[Unreleased]`, `docs/FEATURES.md` and `docs/VOICE.md` are updated (Task 10).

Two deliberate refinements of the spec, decided while planning:
- Layouts carry the real file names, so Hugging Face files keep their repo names on disk (no canonical renames needed).
- The size column shows "…" while a result's files are being checked, then the exact size (the search API returns no sizes, so there is no "≈ size").

## Review Focus

1. **App closed during a Hugging Face download, reopened, Resume pressed** → the download continues the same commit and the same file list (no re-resolve to a newer commit mixing files). Pinned by `download_reuses_the_pending_manifest` (Task 6).
2. **Repo files with unusual names** (`espeak-ng-data/voices/!v/Mr serious`, `../x`, backslashes) → optional data files with unsafe names are skipped, a required file with an unsafe name rejects the repo, nothing is written outside the model folder. Pinned by `unsafe_optional_files_are_skipped` and `unsafe_required_file_rejects_the_repo` (Task 2) and `manifest_with_unsafe_path_is_rejected` (Task 6).
3. **A redirect to a host outside Hugging Face** → the request fails; no bytes come from an unknown host. Pinned by `only_hugging_face_hosts_are_allowed` (Task 4).
4. **Offline or rate limited (HTTP 429) while searching** → the search area shows the matching message with Try again; the Installed list keeps working. Pinned by `search_error_kinds_map_to_messages` (Task 8) and `installed_mode_works_while_search_fails` (Task 9).
5. **A narration voice that no longer exists** (model replaced, out-of-range speaker id saved) → narration uses speaker 0 instead of failing. Pinned by `out_of_range_speaker_falls_back_to_zero` (Task 1).

---

## File map

Create (Rust):
- `src-tauri/src/speech_layout.rs` — `SttLayout` and `recognizer_config`.
- `src-tauri/src/speech_hub/mod.rs` — `HubState`, `HubModelInfo`, `HubSearchResult`, commands `speech_hub_search`, `speech_hub_resolve`, `resolve`.
- `src-tauri/src/speech_hub/detect.rs` — `Family`, `RepoFile`, `HubLayout`, `Planned`, `family_of`, `plan`, `safe_path`.
- `src-tauri/src/speech_hub/meta.rs` — `ModelMeta`, `HubVoice`, `PiperConfig`, `describe`, `voice_list`.
- `src-tauri/src/speech_hub/hf.rs` — API URLs, client with redirect policy, JSON parsing, error codes.
- `src-tauri/src/speech_hub/search.rs` — `SearchQuery`, `Sort`, `terms`, `rank`.
- `src-tauri/src/speech_hub/installed.rs` — `HubManifest`, ids/folders, read/validate/write/list.
- `src-tauri/src/speech_hub/testdata/search-kokoro.json`, `model-faber.json`, `tree-faber.json`.

Create (frontend):
- `src/lib/voice/hubModels.ts` (+ `.test.ts`) — Hugging Face info → `ModelInfo`, overrides, error keys.
- `src/components/modals/preferences/voice/useHubSearch.ts` (+ `.test.ts`)
- `src/components/modals/preferences/voice/HubSearchControls.tsx` (+ `.module.css`)
- `src/components/modals/preferences/voice/HubDetails.tsx` (+ `.module.css`)
- `src/components/modals/preferences/voice/LocalVoiceSelect.tsx`

Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/src/speech.rs`, `src-tauri/src/tts_local.rs`, `src-tauri/src/tts.rs`, `src/lib/tauri/speech.ts`, `src/lib/voice/modelInfo.ts`, `voice/TierDots.tsx`, `voice/ModelTable.tsx` (+ css), `voice/LocalModelsView.tsx` (+ test), `voice/useModelDownloads.ts`, `voice/useSpeechInventory.ts`, `voice/VoicePage.tsx`, `voice/ProviderDetail.tsx`, the 3 locale files, docs.

---

### Task 1: Owned layouts for recognizers and voices

Refactor only: catalog models keep working; no Hugging Face code yet.

**Files:**
- Create: `src-tauri/src/speech_layout.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod speech_layout;` next to `mod speech;`), `src-tauri/src/speech.rs` (`build_recognizer`, `recognizer_for`, `transcriber_for`, `speech_prepare`, `local_tts_model`), `src-tauri/src/tts_local.rs`, `src-tauri/src/tts.rs` (`tts_speak`, `speak_local`)

**Interfaces:**
- Produces:
  ```rust
  // speech_layout.rs
  pub enum SttLayout { Transducer{model_type,encoder,decoder,joiner,tokens}, Whisper{encoder,decoder,tokens},
      Moonshine{preprocessor,encoder,uncached_decoder,cached_decoder,tokens}, SenseVoice{model,tokens},
      Paraformer{model,tokens}, NemoCtc{model,tokens}, Dolphin{model,tokens} }   // all fields String
  impl SttLayout { pub fn is_whisper(&self) -> bool; pub fn files(&self) -> Vec<&str> }
  pub fn recognizer_config(dir: &Path, layout: &SttLayout, threads: i32, sample_rate: i32) -> Result<OfflineRecognizerConfig, String>
  // tts_local.rs
  pub enum TtsLayout { Vits{model,tokens,lexicon:Option<String>,data_dir:bool,dict_dir:bool,rule_fsts:Vec<String>},
      Kokoro{model,voices,tokens,lexicons:Vec<String>,dict_dir:bool,rule_fsts:Vec<String>}, Kitten{model,voices,tokens} }
  impl TtsLayout { pub fn piper(model_file: &str) -> Self; pub fn files(&self) -> Vec<&str> }
  pub fn synthesize(dir: &Path, layout: &TtsLayout, text: &str, rate: f32, sid: i32) -> Result<(Vec<f32>, u32), String>
  pub fn num_speakers(dir: &Path, layout: &TtsLayout) -> Result<i32, String>
  // speech.rs
  pub(crate) fn local_tts_model(app: &AppHandle, id: &str) -> Result<(PathBuf, TtsLayout), String>
  ```

- [ ] **Step 1: Write the failing tests for `speech_layout.rs`**

Create `src-tauri/src/speech_layout.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{recognizer_config, SttLayout};

    fn dir_with(files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "alethe-layout-{}-{}",
            std::process::id(),
            files.join("_").replace(['.', '/'], "")
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for file in files {
            fs::write(dir.join(file), b"x").unwrap();
        }
        dir
    }

    #[test]
    fn sense_voice_detects_the_language_and_adds_punctuation() {
        let dir = dir_with(&["model.int8.onnx", "tokens.txt"]);
        let layout = SttLayout::SenseVoice { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() };
        let config = recognizer_config(&dir, &layout, 2, 16_000).unwrap();
        assert!(config.model_config.sense_voice.model.unwrap().ends_with("model.int8.onnx"));
        assert_eq!(config.model_config.sense_voice.language.as_deref(), Some("auto"));
        assert!(config.model_config.sense_voice.use_itn);
        assert!(config.model_config.tokens.unwrap().ends_with("tokens.txt"));
    }

    #[test]
    fn transducer_uses_the_named_files_and_model_type() {
        let names = ["encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.int8.onnx", "tokens.txt"];
        let dir = dir_with(&names);
        let layout = SttLayout::Transducer {
            model_type: "transducer".into(),
            encoder: names[0].into(),
            decoder: names[1].into(),
            joiner: names[2].into(),
            tokens: names[3].into(),
        };
        let config = recognizer_config(&dir, &layout, 2, 16_000).unwrap();
        assert!(config.model_config.transducer.encoder.unwrap().ends_with(names[0]));
        assert_eq!(config.model_config.model_type.as_deref(), Some("transducer"));
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let dir = dir_with(&["tokens.txt"]);
        let layout = SttLayout::Paraformer { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() };
        assert!(recognizer_config(&dir, &layout, 2, 16_000).unwrap_err().contains("missing model file"));
    }

    #[test]
    fn whisper_is_flagged_for_windowed_decoding() {
        let layout = SttLayout::Whisper { encoder: "a".into(), decoder: "b".into(), tokens: "c".into() };
        assert!(layout.is_whisper());
        assert_eq!(layout.files(), vec!["a", "b", "c"]);
    }

    #[test]
    fn layouts_round_trip_through_json() {
        let layout = SttLayout::NemoCtc { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() };
        let json = serde_json::to_string(&layout).unwrap();
        assert_eq!(json, r#"{"kind":"nemo-ctc","model":"model.int8.onnx","tokens":"tokens.txt"}"#);
        assert_eq!(serde_json::from_str::<SttLayout>(&json).unwrap(), layout);
    }
}
```

Add `mod speech_layout;` to `src-tauri/src/lib.rs` right after `mod speech;`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_layout`
Expected: compile error — `SttLayout` / `recognizer_config` not found.

- [ ] **Step 3: Implement `speech_layout.rs`**

Prepend above the test module:

```rust
//! Which files a local recognizer reads and how sherpa-onnx is configured for them. Shared by
//! the built-in catalog and models downloaded from Hugging Face.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    OfflineDolphinModelConfig, OfflineMoonshineModelConfig, OfflineNemoEncDecCtcModelConfig,
    OfflineParaformerModelConfig, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};

/// File names are relative to the model folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum SttLayout {
    Transducer { model_type: String, encoder: String, decoder: String, joiner: String, tokens: String },
    Whisper { encoder: String, decoder: String, tokens: String },
    Moonshine { preprocessor: String, encoder: String, uncached_decoder: String, cached_decoder: String, tokens: String },
    SenseVoice { model: String, tokens: String },
    Paraformer { model: String, tokens: String },
    NemoCtc { model: String, tokens: String },
    Dolphin { model: String, tokens: String },
}

impl SttLayout {
    /// Whisper decodes 28-second windows; the others take the whole utterance.
    pub fn is_whisper(&self) -> bool {
        matches!(self, Self::Whisper { .. })
    }

    /// Every file the recognizer opens.
    pub fn files(&self) -> Vec<&str> {
        match self {
            Self::Transducer { encoder, decoder, joiner, tokens, .. } => vec![encoder, decoder, joiner, tokens],
            Self::Whisper { encoder, decoder, tokens } => vec![encoder, decoder, tokens],
            Self::Moonshine { preprocessor, encoder, uncached_decoder, cached_decoder, tokens } => {
                vec![preprocessor, encoder, uncached_decoder, cached_decoder, tokens]
            }
            Self::SenseVoice { model, tokens }
            | Self::Paraformer { model, tokens }
            | Self::NemoCtc { model, tokens }
            | Self::Dolphin { model, tokens } => vec![model, tokens],
        }
        .into_iter()
        .map(String::as_str)
        .collect()
    }
}

/// The recognizer config for `layout`; fails when a file it names is missing.
pub fn recognizer_config(
    dir: &Path,
    layout: &SttLayout,
    threads: i32,
    sample_rate: i32,
) -> Result<OfflineRecognizerConfig, String> {
    let path = |name: &str| -> Result<String, String> {
        let full = dir.join(name);
        if !full.is_file() {
            return Err(format!("missing model file: {}", full.display()));
        }
        Ok(full.to_string_lossy().into_owned())
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = threads;
    config.feat_config.sample_rate = sample_rate;
    let tokens = match layout {
        SttLayout::Transducer { model_type, encoder, decoder, joiner, tokens } => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                joiner: Some(path(joiner)?),
            };
            config.model_config.model_type = Some(model_type.clone());
            tokens
        }
        SttLayout::Whisper { encoder, decoder, tokens } => {
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                // Empty language = detect it per utterance.
                language: Some(String::new()),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                ..Default::default()
            };
            tokens
        }
        SttLayout::Moonshine { preprocessor, encoder, uncached_decoder, cached_decoder, tokens } => {
            config.model_config.moonshine = OfflineMoonshineModelConfig {
                preprocessor: Some(path(preprocessor)?),
                encoder: Some(path(encoder)?),
                uncached_decoder: Some(path(uncached_decoder)?),
                cached_decoder: Some(path(cached_decoder)?),
                merged_decoder: None,
            };
            tokens
        }
        SttLayout::SenseVoice { model, tokens } => {
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: Some(path(model)?),
                language: Some("auto".into()),
                use_itn: true,
            };
            tokens
        }
        SttLayout::Paraformer { model, tokens } => {
            config.model_config.paraformer = OfflineParaformerModelConfig { model: Some(path(model)?) };
            tokens
        }
        SttLayout::NemoCtc { model, tokens } => {
            config.model_config.nemo_ctc = OfflineNemoEncDecCtcModelConfig { model: Some(path(model)?) };
            tokens
        }
        SttLayout::Dolphin { model, tokens } => {
            config.model_config.dolphin = OfflineDolphinModelConfig { model: Some(path(model)?) };
            tokens
        }
    };
    config.model_config.tokens = Some(path(tokens)?);
    Ok(config)
}
```

If a sherpa struct literal fails to compile because it has more fields than shown, add `..Default::default()` to it (all these structs derive `Default`).

- [ ] **Step 4: Run the layout tests**

Run: `cd src-tauri && cargo test --lib speech_layout`
Expected: 5 passed.

- [ ] **Step 5: Switch `speech.rs` to `SttLayout`**

In `src-tauri/src/speech.rs`:

1. Add `use crate::speech_layout::SttLayout;` to the imports and remove the now-unused sherpa imports (`OfflineMoonshineModelConfig`, `OfflineRecognizerConfig`, `OfflineTransducerModelConfig`, `OfflineWhisperModelConfig`) once the build tells you they are unused.
2. Below `enum Layout`, add the conversion (catalog file names stay the same):

```rust
impl From<Layout> for SttLayout {
    fn from(layout: Layout) -> Self {
        match layout {
            Layout::Transducer { model_type } => SttLayout::Transducer {
                model_type: model_type.into(),
                encoder: "encoder.int8.onnx".into(),
                decoder: "decoder.int8.onnx".into(),
                joiner: "joiner.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            },
            Layout::Whisper { encoder, decoder, tokens } => SttLayout::Whisper {
                encoder: encoder.into(),
                decoder: decoder.into(),
                tokens: tokens.into(),
            },
            Layout::Moonshine => SttLayout::Moonshine {
                preprocessor: "preprocess.onnx".into(),
                encoder: "encode.int8.onnx".into(),
                uncached_decoder: "uncached_decode.int8.onnx".into(),
                cached_decoder: "cached_decode.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            },
        }
    }
}
```

3. Replace `build_recognizer` with:

```rust
fn build_recognizer(dir: &Path, layout: &SttLayout) -> Result<OfflineRecognizer, String> {
    let mut config = crate::speech_layout::recognizer_config(dir, layout, decode_threads(), SAMPLE_RATE)?;
    // Biasing only bites on a BPE model when the vocab is handed over too, and sherpa wants the
    // text vocab, not the sentencepiece model: the binary one takes the process down.
    if let SttLayout::Transducer { model_type, .. } = layout {
        let bpe = dir.join("bpe.vocab");
        if model_type == "transducer" && is_text_vocab(&bpe) {
            if let Ok(hotwords) = write_hotwords(dir) {
                config.decoding_method = Some("modified_beam_search".into());
                config.max_active_paths = 4;
                config.hotwords_file = Some(hotwords.to_string_lossy().into_owned());
                config.hotwords_score = 3.0;
                config.model_config.modeling_unit = Some("bpe".into());
                config.model_config.bpe_vocab = Some(bpe.to_string_lossy().into_owned());
            }
        }
    }
    OfflineRecognizer::create(&config).ok_or_else(|| "failed to create OfflineRecognizer".into())
}
```

4. `SpeechState::recognizer_for(&self, dir: &Path, layout: &SttLayout)` — change the parameter type and call `build_recognizer(dir, layout)`.
5. In `transcriber_for`: `recognizer: state.recognizer_for(&dir, &SttLayout::from(entry.layout))?, whisper: matches!(entry.layout, Layout::Whisper { .. }),` (Task 7 replaces this branch).
6. In `speech_prepare`: `state.recognizer_for(&dir, &SttLayout::from(entry.layout))?;`.

- [ ] **Step 6: Write the failing tests for `tts_local.rs`**

Replace the `use super::...` line of the existing test module in `src-tauri/src/tts_local.rs` with `use super::{forget_in, speakable, speaker, speed, synthesize, tts_config, TtsLayout};`, change `a_missing_voice_is_an_error_not_a_panic` to call `synthesize(&dir, &TtsLayout::piper("missing.onnx"), "oi", 1.0, 0)`, and add:

```rust
    #[test]
    fn out_of_range_speaker_falls_back_to_zero() {
        assert_eq!(speaker(3, 8), 3);
        assert_eq!(speaker(8, 8), 0);
        assert_eq!(speaker(-1, 8), 0);
        assert_eq!(speaker(2, 0), 0, "a model reporting no speakers uses speaker 0");
    }

    #[test]
    fn piper_reads_its_model_tokens_and_espeak_data() {
        let config = tts_config(Path::new("/v"), &TtsLayout::piper("pt_BR-faber-medium.onnx"));
        let vits = &config.model.vits;
        assert!(vits.model.as_deref().unwrap().ends_with("pt_BR-faber-medium.onnx"));
        assert!(vits.tokens.as_deref().unwrap().ends_with("tokens.txt"));
        assert!(vits.data_dir.as_deref().unwrap().ends_with("espeak-ng-data"));
        assert!(vits.lexicon.is_none() && vits.dict_dir.is_none() && config.rule_fsts.is_none());
    }

    #[test]
    fn kokoro_joins_lexicons_and_rule_fsts_in_order() {
        let layout = TtsLayout::Kokoro {
            model: "model.onnx".into(),
            voices: "voices.bin".into(),
            tokens: "tokens.txt".into(),
            lexicons: vec!["lexicon-us-en.txt".into(), "lexicon-zh.txt".into()],
            dict_dir: true,
            rule_fsts: vec!["phone-zh.fst".into(), "date-zh.fst".into()],
        };
        let config = tts_config(Path::new("/k"), &layout);
        let kokoro = &config.model.kokoro;
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            kokoro.lexicon.as_deref(),
            Some(format!("/k{sep}lexicon-us-en.txt,/k{sep}lexicon-zh.txt").as_str())
        );
        assert!(kokoro.voices.as_deref().unwrap().ends_with("voices.bin"));
        assert!(kokoro.dict_dir.as_deref().unwrap().ends_with("dict"));
        assert_eq!(
            config.rule_fsts.as_deref(),
            Some(format!("/k{sep}phone-zh.fst,/k{sep}date-zh.fst").as_str())
        );
    }

    #[test]
    fn tts_layouts_round_trip_through_json() {
        let layout = TtsLayout::Kitten { model: "model.fp16.onnx".into(), voices: "voices.bin".into(), tokens: "tokens.txt".into() };
        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.starts_with(r#"{"kind":"kitten""#), "{json}");
        assert_eq!(serde_json::from_str::<TtsLayout>(&json).unwrap(), layout);
    }
```

- [ ] **Step 7: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib tts_local`
Expected: compile error — `TtsLayout`, `tts_config`, `speaker` not found.

- [ ] **Step 8: Implement `TtsLayout` in `tts_local.rs`**

Replace everything above the test module with:

```rust
//! Local voices through sherpa-onnx (Piper/VITS, Kokoro, Kitten). Loading a voice reads 60–330 MB,
//! so the last one stays cached.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKittenModelConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig,
};

/// File names are relative to the voice folder; `espeak-ng-data/` and `dict/` are folders there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TtsLayout {
    Vits { model: String, tokens: String, lexicon: Option<String>, data_dir: bool, dict_dir: bool, rule_fsts: Vec<String> },
    Kokoro { model: String, voices: String, tokens: String, lexicons: Vec<String>, dict_dir: bool, rule_fsts: Vec<String> },
    Kitten { model: String, voices: String, tokens: String },
}

impl TtsLayout {
    /// A Piper voice as the sherpa-onnx release archives ship it.
    pub fn piper(model_file: &str) -> Self {
        Self::Vits {
            model: model_file.into(),
            tokens: "tokens.txt".into(),
            lexicon: None,
            data_dir: true,
            dict_dir: false,
            rule_fsts: Vec::new(),
        }
    }

    /// Every single file the engine opens (folders not included).
    pub fn files(&self) -> Vec<&str> {
        let mut files: Vec<&str> = Vec::new();
        match self {
            Self::Vits { model, tokens, lexicon, rule_fsts, .. } => {
                files.extend([model.as_str(), tokens.as_str()]);
                files.extend(lexicon.as_deref());
                files.extend(rule_fsts.iter().map(String::as_str));
            }
            Self::Kokoro { model, voices, tokens, lexicons, rule_fsts, .. } => {
                files.extend([model.as_str(), voices.as_str(), tokens.as_str()]);
                files.extend(lexicons.iter().map(String::as_str));
                files.extend(rule_fsts.iter().map(String::as_str));
            }
            Self::Kitten { model, voices, tokens } => files.extend([model.as_str(), voices.as_str(), tokens.as_str()]),
        }
        files
    }
}

static CACHE: Mutex<Option<(PathBuf, Arc<OfflineTts>)>> = Mutex::new(None);

pub(crate) fn tts_config(dir: &Path, layout: &TtsLayout) -> OfflineTtsConfig {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let joined = |names: &[String]| {
        (!names.is_empty()).then(|| {
            names
                .iter()
                .map(|name| dir.join(name).to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(",")
        })
    };
    let mut model = OfflineTtsModelConfig { num_threads: 2, ..Default::default() };
    let mut rule_fsts = None;
    match layout {
        // The default noise and length scales are the ones Piper voices are tuned for.
        TtsLayout::Vits { model: file, tokens, lexicon, data_dir, dict_dir, rule_fsts: fsts } => {
            model.vits = OfflineTtsVitsModelConfig {
                model: path(file),
                tokens: path(tokens),
                lexicon: lexicon.as_deref().and_then(path),
                data_dir: if *data_dir { path("espeak-ng-data") } else { None },
                dict_dir: if *dict_dir { path("dict") } else { None },
                ..Default::default()
            };
            rule_fsts = joined(fsts);
        }
        TtsLayout::Kokoro { model: file, voices, tokens, lexicons, dict_dir, rule_fsts: fsts } => {
            model.kokoro = OfflineTtsKokoroModelConfig {
                model: path(file),
                voices: path(voices),
                tokens: path(tokens),
                data_dir: path("espeak-ng-data"),
                dict_dir: if *dict_dir { path("dict") } else { None },
                lexicon: joined(lexicons),
                ..Default::default()
            };
            rule_fsts = joined(fsts);
        }
        TtsLayout::Kitten { model: file, voices, tokens } => {
            model.kitten = OfflineTtsKittenModelConfig {
                model: path(file),
                voices: path(voices),
                tokens: path(tokens),
                data_dir: path("espeak-ng-data"),
                ..Default::default()
            };
        }
    }
    OfflineTtsConfig { model, rule_fsts, max_num_sentences: 1, ..Default::default() }
}

fn engine(dir: &Path, layout: &TtsLayout) -> Result<Arc<OfflineTts>, String> {
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, tts)) = slot.as_ref() {
        if cached == dir {
            return Ok(Arc::clone(tts));
        }
    }
    let tts = Arc::new(
        OfflineTts::create(&tts_config(dir, layout))
            .ok_or_else(|| "failed to load the voice model".to_string())?,
    );
    *slot = Some((dir.to_path_buf(), Arc::clone(&tts)));
    Ok(tts)
}
```

Keep `forget_in`, `forget`, `speakable`, `speed` unchanged, then add/replace:

```rust
/// A saved speaker the model does not have (another model, a removed voice) speaks as speaker 0.
fn speaker(sid: i32, available: i32) -> i32 {
    if sid >= 0 && sid < available { sid } else { 0 }
}

/// Speakers the model reports (1 for a single-voice model). Loads the voice; call on a worker.
pub fn num_speakers(dir: &Path, layout: &TtsLayout) -> Result<i32, String> {
    Ok(engine(dir, layout)?.num_speakers())
}

/// Samples and their rate. Blocks for the length of the synthesis; call on a worker thread.
pub fn synthesize(
    dir: &Path,
    layout: &TtsLayout,
    text: &str,
    rate: f32,
    sid: i32,
) -> Result<(Vec<f32>, u32), String> {
    let tts = engine(dir, layout)?;
    let config = GenerationConfig {
        speed: speed(rate),
        sid: speaker(sid, tts.num_speakers()),
        ..Default::default()
    };
    let audio = tts
        .generate_with_config(&speakable(text), &config, None::<fn(&[f32], f32) -> bool>)
        .ok_or_else(|| "voice synthesis failed".to_string())?;
    let sample_rate = u32::try_from(audio.sample_rate())
        .ok()
        .filter(|rate| *rate > 0)
        .ok_or_else(|| "voice synthesis reported no sample rate".to_string())?;
    Ok((audio.samples().to_vec(), sample_rate))
}
```

- [ ] **Step 9: Pass the layout and speaker through `speech.rs` and `tts.rs`**

In `src-tauri/src/speech.rs` change `local_tts_model`:

```rust
/// The unpacked folder of a downloaded voice and how to load it, or why it cannot speak yet.
pub(crate) fn local_tts_model(app: &AppHandle, id: &str) -> Result<(PathBuf, crate::tts_local::TtsLayout), String> {
    let entry = find_tts_entry(id).ok_or_else(|| format!("Unknown voice model: {id}"))?;
    let dir = model_dir(app, id)?;
    if !tts_ready(&dir, entry) {
        return Err(format!("Voice model '{id}' is not downloaded. Open Preferences → Voice."));
    }
    Ok((dir, crate::tts_local::TtsLayout::piper(entry.model_file)))
}
```

In `src-tauri/src/tts.rs`:
- In `tts_speak`, inside the `TtsProvider::Local` branch:
  ```rust
  if let Some(Ok((dir, layout))) = found {
      stop_all(&app).await;
      let rate = normalized_rate(rate);
      // A local voice id is the speaker number of a multi-voice model.
      let sid = voice.as_deref().and_then(|v| v.parse::<i32>().ok()).unwrap_or(0);
      tauri::async_runtime::spawn(speak_local(app, id, dir, layout, sid, rate, text));
      return Ok(id);
  }
  ```
- `speak_local(app, id, dir: std::path::PathBuf, layout: crate::tts_local::TtsLayout, sid: i32, rate: f32, text: String)`; inside the loop clone the layout next to `dir` (`let layout = layout.clone();`) and call `crate::tts_local::synthesize(&dir, &layout, &chunk, rate, sid)`.
- Update the doc comment `/// A Piper voice.` to `/// A local voice.`

- [ ] **Step 10: Run the Rust suite**

Run: `cd src-tauri && cargo test --lib speech && cargo test --lib tts`
Expected: all pass (existing speech/tts tests unchanged in behavior).
Run: `cargo clippy --lib --message-format=short 2>&1 | grep -E "speech_layout.rs|tts_local.rs|src/speech.rs|src/tts.rs"` — must print nothing for lines you touched.

- [ ] **Step 11: Leave changes in the working tree** (no commit).

---

### Task 2: Family detector

**Files:**
- Create: `src-tauri/src/speech_hub/mod.rs` (for now only `pub mod detect;`), `src-tauri/src/speech_hub/detect.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod speech_hub;` after `mod speech_layout;`)

**Interfaces:**
- Consumes: `SttLayout` (Task 1), `TtsLayout` (Task 1).
- Produces:
  ```rust
  pub enum Family { Vits, Kokoro, Kitten, Transducer, NemoTransducer, Whisper, Moonshine, SenseVoice, Paraformer, NemoCtc, Dolphin }
  impl Family { pub fn is_tts(self) -> bool; pub fn use_name(self) -> &'static str }
  pub struct RepoFile { pub path: String, pub size: u64, pub sha256: Option<String>, pub git_sha1: Option<String> }
  pub enum HubLayout { Stt(SttLayout), Tts(TtsLayout) }
  impl HubLayout { pub fn files(&self) -> Vec<&str> }
  pub struct Planned { pub family: Family, pub layout: HubLayout, pub files: Vec<RepoFile> }
  pub fn family_of(repo_name: &str) -> Option<Family>
  pub fn plan(repo_name: &str, files: &[RepoFile]) -> Option<Planned>
  pub fn safe_path(path: &str) -> bool
  ```

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/speech_hub/detect.rs` with the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_layout::SttLayout;
    use crate::tts_local::TtsLayout;

    fn files(paths: &[&str]) -> Vec<RepoFile> {
        paths
            .iter()
            .map(|path| RepoFile { path: (*path).into(), size: 1, sha256: None, git_sha1: Some("0".repeat(40)) })
            .collect()
    }

    fn paths(planned: &Planned) -> Vec<&str> {
        planned.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn family_comes_from_the_repo_name() {
        let cases = [
            ("vits-piper-pt_BR-faber-medium", Some(Family::Vits)),
            ("vits-melo-tts-zh_en", Some(Family::Vits)),
            ("kokoro-multi-lang-v1_0", Some(Family::Kokoro)),
            ("kitten-nano-en-v0_2-fp16", Some(Family::Kitten)),
            ("sherpa-onnx-whisper-turbo", Some(Family::Whisper)),
            ("sherpa-onnx-moonshine-base-en-int8", Some(Family::Moonshine)),
            ("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", Some(Family::SenseVoice)),
            ("sherpa-onnx-paraformer-zh-2023-09-14", Some(Family::Paraformer)),
            ("sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02", Some(Family::Dolphin)),
            ("sherpa-onnx-nemo-ctc-en-conformer-small", Some(Family::NemoCtc)),
            ("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", Some(Family::NemoTransducer)),
            ("sherpa-onnx-zipformer-small-en-2023-06-26", Some(Family::Transducer)),
            ("sherpa-onnx-streaming-zipformer-en-2023-06-26", None),
            ("matcha-icefall-en_US-ljspeech", None),
            ("sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8", None),
            ("sherpa-onnx-zipformer-ctc-small-2024-10-07", None),
            ("sherpa-onnx-apk", None),
            ("icefall-asr-librispeech", None),
        ];
        for (name, expected) in cases {
            assert_eq!(family_of(name), expected, "{name}");
        }
    }

    #[test]
    fn piper_takes_model_config_tokens_and_espeak_data_only() {
        let repo = files(&[
            ".gitattributes",
            "MODEL_CARD",
            "pt_BR-faber-medium.onnx",
            "pt_BR-faber-medium.onnx.json",
            "tokens.txt",
            "vits-piper.py",
            "espeak-ng-data/pt_dict",
            "espeak-ng-data/lang/roa/pt-BR",
            "espeak-ng-data/voices/!v/Alex",
        ]);
        let planned = plan("vits-piper-pt_BR-faber-medium", &repo).unwrap();
        assert_eq!(planned.family, Family::Vits);
        assert_eq!(
            paths(&planned),
            vec![
                "pt_BR-faber-medium.onnx",
                "tokens.txt",
                "pt_BR-faber-medium.onnx.json",
                "espeak-ng-data/pt_dict",
                "espeak-ng-data/lang/roa/pt-BR",
                "espeak-ng-data/voices/!v/Alex",
            ]
        );
        assert_eq!(planned.layout, HubLayout::Tts(TtsLayout::piper("pt_BR-faber-medium.onnx")));
    }

    #[test]
    fn unsafe_optional_files_are_skipped() {
        let repo = files(&["a.onnx", "tokens.txt", "espeak-ng-data/en_dict", "espeak-ng-data/voices/!v/Mr serious", "espeak-ng-data/../x"]);
        let planned = plan("vits-piper-en_US-a-low", &repo).unwrap();
        assert_eq!(paths(&planned), vec!["a.onnx", "tokens.txt", "espeak-ng-data/en_dict"]);
    }

    #[test]
    fn unsafe_required_file_rejects_the_repo() {
        let repo = files(&["a b.onnx", "tokens.txt", "espeak-ng-data/en_dict"]);
        assert_eq!(plan("vits-piper-en_US-a-low", &repo), None);
    }

    #[test]
    fn vits_without_espeak_needs_a_lexicon() {
        assert_eq!(plan("vits-zh-aishell3", &files(&["model.onnx", "tokens.txt"])), None);
        let planned = plan("vits-melo-tts-zh_en", &files(&["model.int8.onnx", "model.onnx", "tokens.txt", "lexicon.txt", "date.fst", "phone.fst", "number.fst", "new_heteronym.fst"])).unwrap();
        let HubLayout::Tts(TtsLayout::Vits { model, lexicon, data_dir, rule_fsts, .. }) = planned.layout else { panic!("vits") };
        assert_eq!(model, "model.int8.onnx");
        assert_eq!(lexicon.as_deref(), Some("lexicon.txt"));
        assert!(!data_dir);
        assert_eq!(rule_fsts, vec!["phone.fst", "date.fst", "number.fst", "new_heteronym.fst"]);
    }

    #[test]
    fn kokoro_takes_us_english_and_chinese_lexicons_dict_and_fsts() {
        let repo = files(&[
            "LICENSE", "README.md", "model.onnx", "voices.bin", "tokens.txt",
            "lexicon-gb-en.txt", "lexicon-us-en.txt", "lexicon-zh.txt",
            "date-zh.fst", "number-zh.fst", "phone-zh.fst",
            "dict/jieba.dict.utf8", "espeak-ng-data/en_dict",
        ]);
        let planned = plan("kokoro-multi-lang-v1_0", &repo).unwrap();
        let HubLayout::Tts(TtsLayout::Kokoro { lexicons, dict_dir, rule_fsts, .. }) = &planned.layout else { panic!("kokoro") };
        assert_eq!(lexicons, &vec!["lexicon-us-en.txt".to_string(), "lexicon-zh.txt".to_string()]);
        assert!(dict_dir);
        assert_eq!(rule_fsts, &vec!["phone-zh.fst".to_string(), "date-zh.fst".to_string(), "number-zh.fst".to_string()]);
        assert!(!paths(&planned).contains(&"lexicon-gb-en.txt"));
        assert!(!paths(&planned).contains(&"LICENSE"));
    }

    #[test]
    fn kokoro_without_voices_is_rejected() {
        assert_eq!(plan("kokoro-en-v0_19", &files(&["model.onnx", "tokens.txt", "espeak-ng-data/en_dict"])), None);
    }

    #[test]
    fn kitten_uses_its_fp16_model() {
        let planned = plan("kitten-nano-en-v0_2-fp16", &files(&["model.fp16.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/en_dict"])).unwrap();
        assert_eq!(planned.layout, HubLayout::Tts(TtsLayout::Kitten { model: "model.fp16.onnx".into(), voices: "voices.bin".into(), tokens: "tokens.txt".into() }));
    }

    #[test]
    fn whisper_prefers_int8_and_skips_full_precision_weights() {
        let repo = files(&["turbo-decoder.int8.onnx", "turbo-decoder.onnx", "turbo-encoder.int8.onnx", "turbo-encoder.onnx", "turbo-encoder.weights", "turbo-tokens.txt", "test_wavs/0.wav"]);
        let planned = plan("sherpa-onnx-whisper-turbo", &repo).unwrap();
        assert_eq!(paths(&planned), vec!["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt"]);
        assert_eq!(planned.layout, HubLayout::Stt(SttLayout::Whisper { encoder: "turbo-encoder.int8.onnx".into(), decoder: "turbo-decoder.int8.onnx".into(), tokens: "turbo-tokens.txt".into() }));
    }

    #[test]
    fn full_precision_only_brings_its_external_weights() {
        let repo = files(&["large-v3-encoder.onnx", "large-v3-encoder.weights", "large-v3-decoder.onnx", "large-v3-tokens.txt"]);
        let planned = plan("sherpa-onnx-whisper-large-v3", &repo).unwrap();
        assert_eq!(paths(&planned), vec!["large-v3-encoder.onnx", "large-v3-encoder.weights", "large-v3-decoder.onnx", "large-v3-tokens.txt"]);
    }

    #[test]
    fn transducers_keep_their_epoch_file_names() {
        let repo = files(&["decoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx", "encoder-epoch-99-avg-1.int8.onnx", "encoder-epoch-99-avg-1.onnx", "joiner-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.onnx", "tokens.txt", "README.md"]);
        let planned = plan("sherpa-onnx-zipformer-small-en-2023-06-26", &repo).unwrap();
        let HubLayout::Stt(SttLayout::Transducer { model_type, encoder, joiner, .. }) = planned.layout else { panic!("transducer") };
        assert_eq!(model_type, "transducer");
        assert_eq!(encoder, "encoder-epoch-99-avg-1.int8.onnx");
        assert_eq!(joiner, "joiner-epoch-99-avg-1.int8.onnx");
        let parakeet = plan("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", &files(&["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"])).unwrap();
        let HubLayout::Stt(SttLayout::Transducer { model_type, .. }) = parakeet.layout else { panic!("transducer") };
        assert_eq!(model_type, "nemo_transducer");
    }

    #[test]
    fn single_model_recognizers_take_model_and_tokens() {
        let repo = files(&["LICENSE", "model.int8.onnx", "model.onnx", "tokens.txt", "test_wavs/en.wav"]);
        for (name, expected) in [
            ("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", SttLayout::SenseVoice { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() }),
            ("sherpa-onnx-paraformer-zh-2023-09-14", SttLayout::Paraformer { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() }),
            ("sherpa-onnx-nemo-ctc-en-conformer-small", SttLayout::NemoCtc { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() }),
            ("sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02", SttLayout::Dolphin { model: "model.int8.onnx".into(), tokens: "tokens.txt".into() }),
        ] {
            let planned = plan(name, &repo).unwrap();
            assert_eq!(planned.layout, HubLayout::Stt(expected), "{name}");
            assert_eq!(paths(&planned), vec!["model.int8.onnx", "tokens.txt"], "{name}");
        }
    }

    #[test]
    fn moonshine_needs_its_four_parts() {
        let all = ["preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt"];
        let planned = plan("sherpa-onnx-moonshine-base-en-int8", &files(&all)).unwrap();
        let HubLayout::Stt(SttLayout::Moonshine { cached_decoder, uncached_decoder, .. }) = planned.layout else { panic!("moonshine") };
        assert_eq!(cached_decoder, "cached_decode.int8.onnx");
        assert_eq!(uncached_decoder, "uncached_decode.int8.onnx");
        assert_eq!(plan("sherpa-onnx-moonshine-base-en-int8", &files(&["preprocess.onnx", "encode.int8.onnx", "merged_decode.onnx", "tokens.txt"])), None);
    }

    #[test]
    fn safe_paths_are_plain_relative_segments() {
        assert!(safe_path("espeak-ng-data/voices/!v/Alex"));
        assert!(safe_path("tokens.txt"));
        for bad in ["", "/etc/passwd", "a/../b", "./a", "a//b", "a\\b", "a b", "C:x", "a/b/c/d/e/f/g/h/i"] {
            assert!(!safe_path(bad), "{bad}");
        }
    }
}
```

Create `src-tauri/src/speech_hub/mod.rs` containing `//! Local voice and speech models found on Hugging Face.\n\npub mod detect;` and add `mod speech_hub;` in `src-tauri/src/lib.rs`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_hub::detect`
Expected: compile errors — items not defined.

- [ ] **Step 3: Implement the detector**

Prepend to `detect.rs`:

```rust
//! Which sherpa-onnx family a Hugging Face repo holds, and which of its files that family needs.
//! Pure: works on a repo name and its file list, so it is tested without the network.

use serde::{Deserialize, Serialize};

use crate::speech_layout::SttLayout;
use crate::tts_local::TtsLayout;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Family {
    Vits,
    Kokoro,
    Kitten,
    Transducer,
    NemoTransducer,
    Whisper,
    Moonshine,
    SenseVoice,
    Paraformer,
    NemoCtc,
    Dolphin,
}

impl Family {
    pub fn is_tts(self) -> bool {
        matches!(self, Self::Vits | Self::Kokoro | Self::Kitten)
    }

    /// `tts` or `stt`, the `capability` the frontend already reads.
    pub fn use_name(self) -> &'static str {
        if self.is_tts() { "tts" } else { "stt" }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    /// Relative to the repo root, `/`-separated.
    pub path: String,
    pub size: u64,
    /// SHA-256 of a file stored in LFS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Git blob SHA-1 of a file stored in the repo itself (never set for LFS files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_sha1: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HubLayout {
    Stt(SttLayout),
    Tts(TtsLayout),
}

impl HubLayout {
    pub fn files(&self) -> Vec<&str> {
        match self {
            Self::Stt(layout) => layout.files(),
            Self::Tts(layout) => layout.files(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub family: Family,
    pub layout: HubLayout,
    /// Only the files the family needs, in download order.
    pub files: Vec<RepoFile>,
}

/// Words marking a repo as something other than an offline recognizer or a voice we support.
const EXCLUDED: &[&str] = &[
    "streaming", "online", "apk", "wheel", "test", "tagging", "diariz", "denois", "punct",
    "speaker", "kws", "keyword", "vad", "spleeter", "matcha", "canary",
];

pub fn family_of(repo_name: &str) -> Option<Family> {
    let name = repo_name.to_ascii_lowercase();
    if EXCLUDED.iter().any(|word| name.contains(word)) {
        return None;
    }
    let family = if name.starts_with("vits-") {
        Family::Vits
    } else if name.starts_with("kokoro-") {
        Family::Kokoro
    } else if name.starts_with("kitten-") {
        Family::Kitten
    } else if name.contains("whisper") {
        Family::Whisper
    } else if name.contains("moonshine") {
        Family::Moonshine
    } else if name.contains("sense-voice") {
        Family::SenseVoice
    } else if name.contains("paraformer") {
        Family::Paraformer
    } else if name.contains("dolphin") {
        Family::Dolphin
    } else if name.contains("ctc") {
        // Zipformer, Wenet and other CTC models are not wired up.
        if name.contains("nemo") || name.contains("parakeet") { Family::NemoCtc } else { return None }
    } else if name.contains("parakeet") || name.contains("nemo") {
        Family::NemoTransducer
    } else if name.contains("zipformer") || name.contains("conformer") || name.contains("transducer") {
        Family::Transducer
    } else {
        return None;
    };
    Some(family)
}

/// Relative, `/`-separated, at most 8 segments of `[A-Za-z0-9._+!-]`; never `.` or `..`.
pub fn safe_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    !path.is_empty()
        && segments.len() <= 8
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '!'))
        })
}

/// int8 first, then unmarked, then fp16/fp32 variants.
fn precision_rank(path: &str) -> u8 {
    let lower = path.to_ascii_lowercase();
    if lower.contains(".int8.") || lower.contains("-int8") {
        0
    } else if lower.contains("fp16") || lower.contains("fp32") {
        2
    } else {
        1
    }
}

fn top_level(files: &[RepoFile]) -> impl Iterator<Item = &RepoFile> {
    files.iter().filter(|file| !file.path.contains('/'))
}

fn named<'a>(files: &'a [RepoFile], name: &str) -> Option<&'a RepoFile> {
    files.iter().find(|file| file.path == name)
}

/// Rule FSTs in the order sherpa's examples pass them: phone, date, number, then the rest.
fn fst_rank(path: &str) -> u8 {
    if path.starts_with("phone") {
        0
    } else if path.starts_with("date") {
        1
    } else if path.starts_with("number") {
        2
    } else {
        3
    }
}

#[derive(Default)]
struct Pick {
    files: Vec<RepoFile>,
}

impl Pick {
    fn add(&mut self, file: &RepoFile) -> String {
        if !self.files.iter().any(|f| f.path == file.path) {
            self.files.push(file.clone());
        }
        file.path.clone()
    }

    /// The best `.onnx` at the top level whose name starts with `prefix`, plus its external
    /// `.weights` when it has one.
    fn model(&mut self, files: &[RepoFile], prefix: &str) -> Option<String> {
        let best = top_level(files)
            .filter(|f| f.path.starts_with(prefix) && f.path.ends_with(".onnx"))
            .min_by_key(|f| (precision_rank(&f.path), f.path.len()))?;
        if !safe_path(&best.path) {
            return None;
        }
        let path = self.add(best);
        if let Some(weights) = path.strip_suffix(".onnx").and_then(|stem| named(files, &format!("{stem}.weights"))) {
            self.add(weights);
        }
        Some(path)
    }

    fn required(&mut self, files: &[RepoFile], name: &str) -> Option<String> {
        named(files, name).filter(|f| safe_path(&f.path)).map(|f| self.add(f))
    }

    /// Every safe file under `dir/`; `false` when there is none. Unsafe names (a space in an
    /// espeak voice variant) are optional data and are skipped.
    fn dir(&mut self, files: &[RepoFile], dir: &str) -> bool {
        let prefix = format!("{dir}/");
        let mut any = false;
        for file in files.iter().filter(|f| f.path.starts_with(&prefix) && safe_path(&f.path)) {
            self.add(file);
            any = true;
        }
        any
    }

    fn rule_fsts(&mut self, files: &[RepoFile]) -> Vec<String> {
        let mut fsts: Vec<&RepoFile> = top_level(files).filter(|f| f.path.ends_with(".fst") && safe_path(&f.path)).collect();
        fsts.sort_by(|a, b| (fst_rank(&a.path), &a.path).cmp(&(fst_rank(&b.path), &b.path)));
        fsts.into_iter().map(|f| self.add(f)).collect()
    }
}

/// The family and the exact files to download, or `None` when the repo does not match a family
/// we can run.
pub fn plan(repo_name: &str, files: &[RepoFile]) -> Option<Planned> {
    let family = family_of(repo_name)?;
    let mut pick = Pick::default();
    let layout = match family {
        Family::Vits => {
            let model = pick.model(files, "")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if let Some(config) = named(files, &format!("{model}.json")) {
                pick.add(config);
            }
            let lexicon = pick.required(files, "lexicon.txt");
            let data_dir = pick.dir(files, "espeak-ng-data");
            if lexicon.is_none() && !data_dir {
                return None;
            }
            let dict_dir = pick.dir(files, "dict");
            let rule_fsts = pick.rule_fsts(files);
            HubLayout::Tts(TtsLayout::Vits { model, tokens, lexicon, data_dir, dict_dir, rule_fsts })
        }
        Family::Kokoro => {
            let model = pick.model(files, "model")?;
            let voices = pick.required(files, "voices.bin")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if !pick.dir(files, "espeak-ng-data") {
                return None;
            }
            let has_us = named(files, "lexicon-us-en.txt").is_some();
            let mut lexicon_files: Vec<&RepoFile> = top_level(files)
                .filter(|f| f.path.starts_with("lexicon-") && f.path.ends_with(".txt") && safe_path(&f.path))
                .filter(|f| !(has_us && f.path == "lexicon-gb-en.txt"))
                .collect();
            lexicon_files.sort_by(|a, b| a.path.cmp(&b.path));
            let lexicons = lexicon_files.into_iter().map(|f| pick.add(f)).collect();
            let dict_dir = pick.dir(files, "dict");
            let rule_fsts = pick.rule_fsts(files);
            HubLayout::Tts(TtsLayout::Kokoro { model, voices, tokens, lexicons, dict_dir, rule_fsts })
        }
        Family::Kitten => {
            let model = pick.model(files, "model")?;
            let voices = pick.required(files, "voices.bin")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if !pick.dir(files, "espeak-ng-data") {
                return None;
            }
            HubLayout::Tts(TtsLayout::Kitten { model, voices, tokens })
        }
        Family::Transducer | Family::NemoTransducer => {
            let encoder = pick.model(files, "encoder")?;
            let decoder = pick.model(files, "decoder")?;
            let joiner = pick.model(files, "joiner")?;
            let tokens = pick.required(files, "tokens.txt")?;
            let model_type = if family == Family::NemoTransducer { "nemo_transducer" } else { "transducer" };
            HubLayout::Stt(SttLayout::Transducer { model_type: model_type.into(), encoder, decoder, joiner, tokens })
        }
        Family::Whisper => {
            let first = top_level(files)
                .filter(|f| f.path.ends_with(".onnx") && f.path.contains("-encoder"))
                .min_by_key(|f| (precision_rank(&f.path), f.path.len()))?;
            let prefix = first.path.split("-encoder").next()?.to_string();
            let encoder = pick.model(files, &format!("{prefix}-encoder"))?;
            let decoder = pick.model(files, &format!("{prefix}-decoder"))?;
            let tokens = pick.required(files, &format!("{prefix}-tokens.txt"))?;
            HubLayout::Stt(SttLayout::Whisper { encoder, decoder, tokens })
        }
        Family::Moonshine => {
            let preprocessor = pick.model(files, "preprocess")?;
            let encoder = pick.model(files, "encode")?;
            let uncached_decoder = pick.model(files, "uncached_decode")?;
            let cached_decoder = pick.model(files, "cached_decode")?;
            let tokens = pick.required(files, "tokens.txt")?;
            HubLayout::Stt(SttLayout::Moonshine { preprocessor, encoder, uncached_decoder, cached_decoder, tokens })
        }
        Family::SenseVoice | Family::Paraformer | Family::NemoCtc | Family::Dolphin => {
            let model = pick.model(files, "model")?;
            let tokens = pick.required(files, "tokens.txt")?;
            HubLayout::Stt(match family {
                Family::SenseVoice => SttLayout::SenseVoice { model, tokens },
                Family::Paraformer => SttLayout::Paraformer { model, tokens },
                Family::NemoCtc => SttLayout::NemoCtc { model, tokens },
                _ => SttLayout::Dolphin { model, tokens },
            })
        }
    };
    Some(Planned { family, layout, files: pick.files })
}
```

Note on `pick.model(files, "encode")` for Moonshine: `starts_with("encode")` does not match `uncached_decode…`; `"cached_decode"` does not match `"uncached_decode…"` because `starts_with` anchors at the start.

- [ ] **Step 4: Run the detector tests**

Run: `cd src-tauri && cargo test --lib speech_hub::detect`
Expected: all pass. If `piper_takes_model_config_tokens_and_espeak_data_only` fails on order, the expected order is: model, tokens, `.onnx.json`, then data files in repo order.

- [ ] **Step 5: Leave changes in the working tree** (no commit).

---

### Task 3: Labels, languages, estimated tiers and voices

**Files:**
- Create: `src-tauri/src/speech_hub/meta.rs`
- Modify: `src-tauri/src/speech_hub/mod.rs` (add `pub mod meta;`)

**Interfaces:**
- Consumes: `Family` (Task 2).
- Produces:
  ```rust
  pub struct HubVoice { pub id: u32, pub name: String, pub language: String }
  pub struct ModelMeta { pub label: String, pub languages: Vec<String>, pub language_count: Option<u32>, pub multilingual: bool,
      pub speed: Option<u8>, pub accuracy: Option<u8>, pub voices: Vec<HubVoice>, pub voice_count: u32 }
  pub struct PiperConfig { pub language: Option<PiperLanguage>, pub audio: Option<PiperAudio>, pub num_speakers: Option<u32>, pub speaker_id_map: Option<BTreeMap<String, u32>> }
  pub fn describe(family: Family, repo_name: &str, piper: Option<&PiperConfig>) -> ModelMeta
  /// `voices` when it matches what the engine reports, else `#1…#n`; empty for a single voice.
  pub fn voice_list(named: &[HubVoice], reported: i32) -> Vec<HubVoice>
  ```

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/speech_hub/meta.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piper_label_language_and_tiers_come_from_the_name() {
        let meta = describe(Family::Vits, "vits-piper-pt_BR-faber-medium", None);
        assert_eq!(meta.label, "Piper · Faber (pt-BR, medium)");
        assert_eq!(meta.languages, vec!["pt-BR"]);
        assert_eq!((meta.speed, meta.accuracy), (Some(3), Some(2)));
        assert_eq!(meta.voice_count, 1);
        let low = describe(Family::Vits, "vits-piper-en_US-amy-x_low", None);
        assert_eq!(low.label, "Piper · Amy (en-US, x-low)");
        assert_eq!((low.speed, low.accuracy), (Some(3), Some(1)));
        let high = describe(Family::Vits, "vits-piper-pt_PT-dii-high", None);
        assert_eq!((high.speed, high.accuracy), (Some(2), Some(2)));
    }

    #[test]
    fn piper_config_overrides_language_and_lists_speakers() {
        let config: PiperConfig = serde_json::from_str(
            r#"{"language":{"code":"en_US"},"audio":{"quality":"medium"},"num_speakers":3,
                "speaker_id_map":{"p1":1,"p0":0,"p2":2}}"#,
        )
        .unwrap();
        let meta = describe(Family::Vits, "vits-piper-en_US-libritts_r-medium", Some(&config));
        assert_eq!(meta.languages, vec!["en-US"]);
        assert_eq!(meta.voices.iter().map(|v| (v.id, v.name.as_str())).collect::<Vec<_>>(), vec![(0, "p0"), (1, "p1"), (2, "p2")]);
        assert_eq!(meta.voice_count, 3);
    }

    #[test]
    fn kokoro_v1_names_its_portuguese_voices() {
        let meta = describe(Family::Kokoro, "kokoro-multi-lang-v1_0", None);
        assert_eq!(meta.label, "Kokoro multi lang v1.0");
        assert!(meta.languages.contains(&"pt-BR".to_string()));
        assert_eq!(meta.voices.len(), 54);
        let dora = meta.voices.iter().find(|v| v.id == 42).unwrap();
        assert_eq!((dora.name.as_str(), dora.language.as_str()), ("Dora", "pt-BR"));
        assert_eq!((meta.speed, meta.accuracy), (Some(2), Some(3)));
        let int8 = describe(Family::Kokoro, "kokoro-int8-multi-lang-v1_0", None);
        assert_eq!(int8.voices.len(), 54);
        let v11 = describe(Family::Kokoro, "kokoro-multi-lang-v1_1", None);
        assert!(v11.voices.is_empty(), "v1.1 names come from the engine");
        assert_eq!(v11.languages, vec!["zh", "en"]);
    }

    #[test]
    fn kitten_has_eight_english_voices() {
        let meta = describe(Family::Kitten, "kitten-nano-en-v0_2-fp16", None);
        assert_eq!(meta.voices.len(), 8);
        assert_eq!(meta.languages, vec!["en"]);
        assert_eq!((meta.speed, meta.accuracy), (Some(3), Some(1)));
    }

    #[test]
    fn recognizer_languages_and_tiers() {
        let whisper = describe(Family::Whisper, "sherpa-onnx-whisper-turbo", None);
        assert_eq!(whisper.language_count, Some(99));
        assert_eq!((whisper.speed, whisper.accuracy), (Some(2), Some(3)));
        let tiny_en = describe(Family::Whisper, "sherpa-onnx-whisper-tiny.en", None);
        assert_eq!(tiny_en.languages, vec!["en"]);
        assert_eq!(tiny_en.language_count, None);
        let sense = describe(Family::SenseVoice, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", None);
        assert_eq!(sense.languages, vec!["zh", "en", "ja", "ko", "yue"]);
        assert_eq!(sense.label, "Sense voice zh en ja ko yue");
        let dolphin = describe(Family::Dolphin, "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02", None);
        assert!(dolphin.multilingual);
        assert_eq!((dolphin.speed, dolphin.accuracy), (Some(3), Some(2)));
        let unknown = describe(Family::Transducer, "sherpa-onnx-conformer-xx-2023", None);
        assert!(unknown.languages.is_empty() && unknown.language_count.is_none());
    }

    #[test]
    fn engine_count_decides_the_voice_list() {
        let named = vec![HubVoice { id: 0, name: "a".into(), language: "en".into() }, HubVoice { id: 1, name: "b".into(), language: "en".into() }];
        assert_eq!(voice_list(&named, 2), named);
        assert!(voice_list(&named, 1).is_empty(), "a single voice needs no picker");
        let generic = voice_list(&named, 3);
        assert_eq!(generic.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), vec!["#1", "#2", "#3"]);
        assert_eq!(voice_list(&[], 2).len(), 2);
    }
}
```

Add `pub mod meta;` to `speech_hub/mod.rs`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_hub::meta`
Expected: compile errors.

- [ ] **Step 3: Implement `meta.rs`**

Prepend:

```rust
//! What a person reads about a Hugging Face model: label, languages, estimated tiers, voices.
//! Tiers are estimates from family and size (spec §6); curated values live in the frontend.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::detect::Family;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubVoice {
    /// sherpa speaker id.
    pub id: u32,
    pub name: String,
    /// BCP-47 tag; empty when unknown.
    pub language: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub label: String,
    pub languages: Vec<String>,
    pub language_count: Option<u32>,
    pub multilingual: bool,
    pub speed: Option<u8>,
    pub accuracy: Option<u8>,
    pub voices: Vec<HubVoice>,
    /// Speakers in the model when known without loading it; 0 when unknown.
    #[serde(default)]
    pub voice_count: u32,
}

/// The parts of a Piper `*.onnx.json` the search uses.
#[derive(Debug, Default, Deserialize)]
pub struct PiperConfig {
    #[serde(default)]
    pub language: Option<PiperLanguage>,
    #[serde(default)]
    pub audio: Option<PiperAudio>,
    #[serde(default)]
    pub num_speakers: Option<u32>,
    #[serde(default)]
    pub speaker_id_map: Option<BTreeMap<String, u32>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PiperLanguage {
    pub code: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PiperAudio {
    pub quality: Option<String>,
}

/// Kokoro v1.0 speakers in sherpa-onnx speaker-id order (54 with `em_santa` added at 53).
const KOKORO_V1_0: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova",
    "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex", "ff_siwis", "hf_alpha",
    "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi",
    "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni",
    "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang", "em_santa",
];
const KOKORO_V0_19: &[&str] = &[
    "af", "af_bella", "af_nicole", "af_sarah", "af_sky", "am_adam", "am_michael", "bf_emma",
    "bf_isabella", "bm_george", "bm_lewis",
];
const KITTEN: &[&str] = &[
    "expr-voice-2-m", "expr-voice-2-f", "expr-voice-3-m", "expr-voice-3-f", "expr-voice-4-m",
    "expr-voice-4-f", "expr-voice-5-m", "expr-voice-5-f",
];
const KOKORO_V1_0_LANGUAGES: &[&str] = &["en-US", "en-GB", "es", "fr", "hi", "it", "ja", "pt-BR", "zh"];

/// Two- and three-letter codes recognized as language tokens in repo names.
const LANGUAGE_CODES: &[&str] = &[
    "en", "zh", "ja", "ko", "yue", "pt", "es", "fr", "de", "it", "ru", "ar", "hi", "fa", "vi", "th",
    "tr", "pl", "nl", "uk", "cs", "id", "bn", "ta", "te", "sv", "fi", "da", "el", "he", "hu", "ro",
    "bg", "sk", "sl", "hr", "ca", "kk", "be", "uz", "ur", "sw",
];

fn piper_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^vits-piper-([a-z]{2,3})_([A-Za-z]{2})-(.+?)-(x_low|low|medium|high)(?:-(?:int8|fp16))?$").unwrap()
    })
}

fn trailing_date() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap())
}

fn region_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([a-z]{2,3})_([A-Z]{2})$").unwrap())
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn base_name(repo_name: &str) -> &str {
    repo_name.strip_prefix("sherpa-onnx-").unwrap_or(repo_name)
}

/// `kokoro-multi-lang-v1_0` → `Kokoro multi lang v1.0`; a trailing date is dropped.
fn humanize(repo_name: &str) -> String {
    let base = trailing_date().replace(base_name(repo_name), "");
    let words: Vec<String> = base
        .split('-')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let is_version = word.len() > 1
                && word.starts_with('v')
                && word[1..].chars().all(|c| c.is_ascii_digit() || c == '_');
            if is_version { word.replace('_', ".") } else { word.to_string() }
        })
        .collect();
    capitalize(&words.join(" "))
}

/// Tokens of the name, split on `-` and `.` (`tiny.en` gives `tiny`, `en`).
fn tokens(repo_name: &str) -> Vec<String> {
    base_name(repo_name).to_ascii_lowercase().split(['-', '.']).map(str::to_string).collect()
}

fn has(repo_name: &str, word: &str) -> bool {
    tokens(repo_name).iter().any(|token| token == word || token.split('_').any(|part| part == word))
}

fn languages_from_name(repo_name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |tag: String| {
        if !out.contains(&tag) {
            out.push(tag);
        }
    };
    for token in base_name(repo_name).split(['-', '.']) {
        if let Some(caps) = region_tag().captures(token) {
            push(format!("{}-{}", &caps[1], &caps[2]));
            continue;
        }
        for part in token.split('_') {
            let part = part.to_ascii_lowercase();
            if LANGUAGE_CODES.contains(&part.as_str()) {
                push(part);
            }
        }
    }
    out
}

fn kokoro_language(name: &str) -> &'static str {
    match name.chars().next() {
        Some('a') => "en-US",
        Some('b') => "en-GB",
        Some('e') => "es",
        Some('f') => "fr",
        Some('h') => "hi",
        Some('i') => "it",
        Some('j') => "ja",
        Some('p') => "pt-BR",
        Some('z') => "zh",
        _ => "",
    }
}

fn kokoro_voices(names: &[&str]) -> Vec<HubVoice> {
    names
        .iter()
        .enumerate()
        .map(|(id, name)| HubVoice {
            id: id as u32,
            name: capitalize(name.split_once('_').map_or(*name, |(_, rest)| rest)),
            language: kokoro_language(name).to_string(),
        })
        .collect()
}

fn estimate(family: Family, repo_name: &str, quality: Option<&str>) -> (Option<u8>, Option<u8>) {
    let tiers = |speed: u8, accuracy: u8| (Some(speed), Some(accuracy));
    let size = |word: &str| has(repo_name, word);
    match family {
        Family::Vits => match quality {
            Some("x_low" | "low") => tiers(3, 1),
            Some("medium") => tiers(3, 2),
            Some("high") => tiers(2, 2),
            _ => (None, None),
        },
        Family::Kokoro => tiers(2, 3),
        Family::Kitten if size("nano") => tiers(3, 1),
        Family::Kitten if size("mini") => tiers(3, 2),
        Family::Whisper if size("distil") && size("large") => tiers(2, 3),
        Family::Whisper if size("tiny") || size("base") => tiers(3, 1),
        Family::Whisper if size("small") => tiers(2, 2),
        Family::Whisper if size("medium") => tiers(1, 2),
        Family::Whisper if size("turbo") => tiers(2, 3),
        Family::Whisper if repo_name.contains("large") => tiers(1, 3),
        Family::Moonshine if size("tiny") => tiers(3, 1),
        Family::Moonshine if size("base") => tiers(3, 2),
        Family::SenseVoice | Family::Paraformer => tiers(3, 2),
        Family::NemoCtc if size("small") => tiers(3, 1),
        Family::NemoCtc if size("medium") => tiers(3, 2),
        Family::NemoCtc if size("large") => tiers(2, 2),
        Family::Transducer => tiers(3, 2),
        Family::NemoTransducer => tiers(2, 3),
        Family::Dolphin if size("base") => tiers(3, 2),
        Family::Dolphin if size("small") => tiers(2, 2),
        _ => (None, None),
    }
}

pub fn describe(family: Family, repo_name: &str, piper: Option<&PiperConfig>) -> ModelMeta {
    let mut meta = ModelMeta {
        label: humanize(repo_name),
        languages: languages_from_name(repo_name),
        multilingual: repo_name.contains("multi-lang") || repo_name.contains("multilingual"),
        ..Default::default()
    };
    let mut quality = piper.and_then(|c| c.audio.as_ref()).and_then(|a| a.quality.clone());
    match family {
        Family::Vits => {
            if let Some(caps) = piper_name().captures(repo_name) {
                let tag = format!("{}-{}", &caps[1], &caps[2]);
                let level = caps[4].replace('_', "-");
                meta.label = format!("Piper · {} ({tag}, {level})", capitalize(&caps[3]));
                meta.languages = vec![tag];
                quality.get_or_insert_with(|| caps[4].to_string());
            }
            if let Some(code) = piper.and_then(|c| c.language.as_ref()).and_then(|l| l.code.as_deref()) {
                meta.languages = vec![code.replace('_', "-")];
            }
            let language = meta.languages.first().cloned().unwrap_or_default();
            if let Some(map) = piper.and_then(|c| c.speaker_id_map.as_ref()).filter(|m| m.len() > 1) {
                let mut voices: Vec<HubVoice> = map
                    .iter()
                    .map(|(name, id)| HubVoice { id: *id, name: name.clone(), language: language.clone() })
                    .collect();
                voices.sort_by_key(|voice| voice.id);
                meta.voices = voices;
            }
            meta.voice_count = piper
                .and_then(|c| c.num_speakers)
                .unwrap_or(1)
                .max(meta.voices.len() as u32);
        }
        Family::Kokoro => {
            if repo_name.contains("v1_0") {
                meta.languages = KOKORO_V1_0_LANGUAGES.iter().map(|s| s.to_string()).collect();
                meta.voices = kokoro_voices(KOKORO_V1_0);
            } else if repo_name.contains("v1_1") {
                meta.languages = vec!["zh".into(), "en".into()];
            } else if repo_name.contains("v0_19") {
                meta.languages = vec!["en".into()];
                meta.voices = kokoro_voices(KOKORO_V0_19);
            }
            meta.multilingual = false;
            meta.voice_count = meta.voices.len() as u32;
        }
        Family::Kitten => {
            meta.languages = vec!["en".into()];
            meta.voices = KITTEN
                .iter()
                .enumerate()
                .map(|(id, name)| HubVoice { id: id as u32, name: (*name).into(), language: "en".into() })
                .collect();
            meta.voice_count = meta.voices.len() as u32;
        }
        Family::Whisper => {
            if repo_name.ends_with(".en") || repo_name.ends_with("-en") {
                meta.languages = vec!["en".into()];
            } else {
                meta.languages.clear();
                meta.language_count = Some(99);
            }
        }
        _ => {}
    }
    let (speed, accuracy) = estimate(family, repo_name, quality.as_deref());
    meta.speed = speed;
    meta.accuracy = accuracy;
    meta
}

pub fn voice_list(named: &[HubVoice], reported: i32) -> Vec<HubVoice> {
    if reported <= 1 {
        return Vec::new();
    }
    if named.len() == reported as usize {
        return named.to_vec();
    }
    (0..reported as u32)
        .map(|id| HubVoice { id, name: format!("#{}", id + 1), language: String::new() })
        .collect()
}
```

Note `humanize` of `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` → `Sense voice zh en ja ko yue` (the test pins it). `piper_name()` runs on the repo name as published (`pt_BR` keeps its case).

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib speech_hub::meta`
Expected: all pass.

- [ ] **Step 5: Leave changes in the working tree** (no commit).

---

### Task 4: Hugging Face client and parsing

**Files:**
- Create: `src-tauri/src/speech_hub/hf.rs`, `src-tauri/src/speech_hub/testdata/search-kokoro.json`, `testdata/model-faber.json`, `testdata/tree-faber.json`
- Modify: `src-tauri/src/speech_hub/mod.rs` (add `pub mod hf;`)

**Interfaces:**
- Consumes: `RepoFile`, `safe_path` (Task 2).
- Produces:
  ```rust
  pub const ALLOWED_AUTHORS: &[&str];
  pub const OFFLINE, RATE_LIMITED, UNAVAILABLE, BAD_RESPONSE, INCOMPATIBLE, TOO_LARGE, GATED, UNKNOWN_REPO: &str;
  pub struct SearchHit { pub repo: String, pub likes: u64, pub downloads: u64, pub last_modified: Option<String>, pub license: Option<String> }  // Clone, Serialize, Deserialize
  pub struct RepoInfo { pub hit: SearchHit, pub commit: String }
  pub fn valid_repo(repo: &str) -> bool
  pub fn valid_commit(commit: &str) -> bool
  pub fn allowed_host(host: &str) -> bool
  pub fn client() -> Result<reqwest::Client, String>
  pub fn search_url(author: &str, term: &str) -> String
  pub fn model_url(repo: &str) -> String
  pub fn tree_url(repo: &str, commit: &str) -> String
  pub fn resolve_url(repo: &str, commit: &str, path: &str) -> String
  pub fn parse_search(body: &str) -> Result<Vec<SearchHit>, String>
  pub fn parse_model(body: &str) -> Result<RepoInfo, String>
  pub fn parse_tree(body: &str) -> Result<Vec<RepoFile>, String>
  pub fn next_page(link: Option<&str>) -> Option<String>
  pub fn classify(status: u16) -> &'static str
  pub async fn get_text(client: &reqwest::Client, url: &str, max_bytes: usize) -> Result<(String, Option<String>), String>
  ```

- [ ] **Step 1: Capture the fixtures**

Run from the repo root (they are real API responses; the tree is trimmed to keep the fixture small):

```bash
mkdir -p src-tauri/src/speech_hub/testdata
curl -sg "https://huggingface.co/api/models?author=csukuangfj&search=kokoro&limit=5&sort=likes&direction=-1&expand[]=likes&expand[]=downloads&expand[]=lastModified&expand[]=cardData&expand[]=gated&expand[]=private" > src-tauri/src/speech_hub/testdata/search-kokoro.json
curl -s "https://huggingface.co/api/models/csukuangfj/vits-piper-pt_BR-faber-medium" | python3 -c "import json,sys; d=json.load(sys.stdin); d['siblings']=d['siblings'][:5]; json.dump(d,sys.stdout,indent=1)" > src-tauri/src/speech_hub/testdata/model-faber.json
curl -s "https://huggingface.co/api/models/csukuangfj/vits-piper-pt_BR-faber-medium/tree/main?recursive=true" | python3 -c "import json,sys; d=json.load(sys.stdin); keep=[e for e in d if '/' not in e['path'] or e['path'] in ('espeak-ng-data','espeak-ng-data/pt_dict','espeak-ng-data/voices/!v/Mr serious')]; json.dump(keep,sys.stdout,indent=1)" > src-tauri/src/speech_hub/testdata/tree-faber.json
```

Open each file and confirm: the search file is a JSON array containing `csukuangfj/kokoro-multi-lang-v1_0`; the model file has a 40-hex `sha`; the tree has `pt_BR-faber-medium.onnx` with an `lfs.oid`, `tokens.txt` without `lfs`, and a `"type": "directory"` entry.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/speech_hub/hf.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = include_str!("testdata/search-kokoro.json");
    const MODEL: &str = include_str!("testdata/model-faber.json");
    const TREE: &str = include_str!("testdata/tree-faber.json");

    #[test]
    fn only_allowlisted_repos_are_valid() {
        assert!(valid_repo("csukuangfj/vits-piper-pt_BR-faber-medium"));
        assert!(valid_repo("k2-fsa/sherpa-onnx-whisper-turbo"));
        for bad in ["someone/vits-piper-x", "csukuangfj", "csukuangfj/", "csukuangfj/../x", "csukuangfj/a/b", "csukuangfj/a b", "csukuangfj/.."] {
            assert!(!valid_repo(bad), "{bad}");
        }
    }

    #[test]
    fn only_hugging_face_hosts_are_allowed() {
        for host in ["huggingface.co", "cdn-lfs.huggingface.co", "us.aws.cdn.hf.co", "cas-bridge.xethub.hf.co", "hf.co"] {
            assert!(allowed_host(host), "{host}");
        }
        for host in ["evil.com", "huggingface.co.evil.com", "hf.com", "xhf.co", "github.com"] {
            assert!(!allowed_host(host), "{host}");
        }
    }

    #[test]
    fn search_results_parse_with_stats() {
        let hits = parse_search(SEARCH).unwrap();
        let kokoro = hits.iter().find(|h| h.repo == "csukuangfj/kokoro-multi-lang-v1_0").expect("kokoro v1.0 in fixture");
        assert!(kokoro.last_modified.is_some());
        assert!(hits.iter().all(|h| valid_repo(&h.repo)));
    }

    #[test]
    fn gated_private_and_foreign_results_are_dropped() {
        let body = r#"[
            {"id":"csukuangfj/a","likes":1,"downloads":0,"gated":false,"private":false},
            {"id":"csukuangfj/b","gated":"auto","private":false},
            {"id":"csukuangfj/c","gated":false,"private":true},
            {"id":"other/d","gated":false,"private":false},
            {"id":"csukuangfj/e","cardData":{"license":["apache-2.0"]}}
        ]"#;
        let hits = parse_search(body).unwrap();
        assert_eq!(hits.iter().map(|h| h.repo.as_str()).collect::<Vec<_>>(), vec!["csukuangfj/a", "csukuangfj/e"]);
        assert_eq!(hits[1].license.as_deref(), Some("apache-2.0"));
    }

    #[test]
    fn model_info_carries_the_commit() {
        let info = parse_model(MODEL).unwrap();
        assert!(valid_commit(&info.commit));
        assert_eq!(info.hit.repo, "csukuangfj/vits-piper-pt_BR-faber-medium");
        assert_eq!(parse_model(r#"{"id":"csukuangfj/a","sha":"x"}"#).unwrap_err(), BAD_RESPONSE);
        assert_eq!(parse_model(&format!(r#"{{"id":"csukuangfj/a","sha":"{}","gated":"manual"}}"#, "a".repeat(40))).unwrap_err(), GATED);
    }

    #[test]
    fn tree_entries_become_files_with_checksums() {
        let files = parse_tree(TREE).unwrap();
        let onnx = files.iter().find(|f| f.path == "pt_BR-faber-medium.onnx").unwrap();
        assert_eq!(onnx.sha256.as_deref().map(str::len), Some(64));
        assert!(onnx.git_sha1.is_none(), "an LFS file is checked by SHA-256 only");
        let tokens = files.iter().find(|f| f.path == "tokens.txt").unwrap();
        assert!(tokens.sha256.is_none());
        assert_eq!(tokens.git_sha1.as_deref().map(str::len), Some(40));
        assert!(files.iter().all(|f| f.path != "espeak-ng-data"), "directories are not files");
    }

    #[test]
    fn next_page_follows_only_hugging_face_links() {
        let link = r#"<https://huggingface.co/api/models/a/b/tree/main?cursor=xyz>; rel="next""#;
        assert_eq!(next_page(Some(link)).as_deref(), Some("https://huggingface.co/api/models/a/b/tree/main?cursor=xyz"));
        assert_eq!(next_page(Some(r#"<https://evil.com/x>; rel="next""#)), None);
        assert_eq!(next_page(Some(r#"<https://huggingface.co/x>; rel="prev""#)), None);
        assert_eq!(next_page(None), None);
    }

    #[test]
    fn statuses_map_to_error_codes() {
        assert_eq!(classify(429), RATE_LIMITED);
        assert_eq!(classify(401), GATED);
        assert_eq!(classify(404), UNKNOWN_REPO);
        assert_eq!(classify(503), UNAVAILABLE);
        assert_eq!(classify(418), BAD_RESPONSE);
    }

    #[test]
    fn urls_are_built_from_validated_parts() {
        let commit = "a".repeat(40);
        assert_eq!(
            resolve_url("csukuangfj/x", &commit, "espeak-ng-data/voices/!v/Alex"),
            format!("https://huggingface.co/csukuangfj/x/resolve/{commit}/espeak-ng-data/voices/!v/Alex")
        );
        assert!(search_url("csukuangfj", "pt br").contains("search=pt+br") || search_url("csukuangfj", "pt br").contains("search=pt%20br"));
        assert!(search_url("csukuangfj", "x").starts_with("https://huggingface.co/api/models?"));
    }
}
```

Add `pub mod hf;` to `speech_hub/mod.rs`.

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_hub::hf`
Expected: compile errors.

- [ ] **Step 4: Implement `hf.rs`**

Prepend:

```rust
//! Hugging Face API access for the model search: fixed hosts, allowlisted authors, parsed JSON.

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::detect::{safe_path, RepoFile};

/// The sherpa-onnx maintainers. Fixed here, not configurable from the UI.
pub const ALLOWED_AUTHORS: &[&str] = &["csukuangfj", "csukuangfj2", "k2-fsa"];

const BASE: &str = "https://huggingface.co";
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Error codes the frontend maps to messages.
pub const OFFLINE: &str = "hub_offline";
pub const RATE_LIMITED: &str = "hub_rate_limited";
pub const UNAVAILABLE: &str = "hub_unavailable";
pub const BAD_RESPONSE: &str = "hub_bad_response";
pub const INCOMPATIBLE: &str = "hub_incompatible";
pub const TOO_LARGE: &str = "hub_too_large";
pub const GATED: &str = "hub_gated";
pub const UNKNOWN_REPO: &str = "hub_unknown_repo";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub repo: String,
    pub likes: u64,
    pub downloads: u64,
    pub last_modified: Option<String>,
    pub license: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoInfo {
    pub hit: SearchHit,
    pub commit: String,
}

pub fn valid_repo(repo: &str) -> bool {
    let Some((author, name)) = repo.split_once('/') else {
        return false;
    };
    ALLOWED_AUTHORS.contains(&author)
        && !name.is_empty()
        && name.len() <= 96
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn allowed_host(host: &str) -> bool {
    host == "huggingface.co" || host.ends_with(".huggingface.co") || host == "hf.co" || host.ends_with(".hf.co")
}

/// HTTPS client that follows at most 5 redirects, all within Hugging Face hosts.
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .read_timeout(READ_TIMEOUT)
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Alethe/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.url().scheme() == "https"
                && attempt.url().host_str().is_some_and(allowed_host);
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if allowed {
                attempt.follow()
            } else {
                attempt.error("redirect outside Hugging Face")
            }
        }))
        .build()
        .map_err(|e| format!("hub client: {e}"))
}

pub fn search_url(author: &str, term: &str) -> String {
    let params = [
        ("author", author),
        ("search", term),
        ("limit", "500"),
        ("sort", "likes"),
        ("direction", "-1"),
        ("expand[]", "likes"),
        ("expand[]", "downloads"),
        ("expand[]", "lastModified"),
        ("expand[]", "cardData"),
        ("expand[]", "gated"),
        ("expand[]", "private"),
    ];
    reqwest::Url::parse_with_params(&format!("{BASE}/api/models"), &params)
        .map(String::from)
        .unwrap_or_default()
}

pub fn model_url(repo: &str) -> String {
    format!("{BASE}/api/models/{repo}")
}

pub fn tree_url(repo: &str, commit: &str) -> String {
    format!("{BASE}/api/models/{repo}/tree/{commit}?recursive=true")
}

/// `path` passed `safe_path`, so its characters need no escaping in a URL path.
pub fn resolve_url(repo: &str, commit: &str, path: &str) -> String {
    format!("{BASE}/{repo}/resolve/{commit}/{path}")
}

#[derive(Deserialize)]
struct ApiModel {
    id: String,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    downloads: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "cardData")]
    card_data: Option<CardData>,
    /// `false`, or `"auto"` / `"manual"` for a gated repo.
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Deserialize)]
struct CardData {
    #[serde(default)]
    license: Option<serde_json::Value>,
}

impl ApiModel {
    fn open(&self) -> bool {
        !self.private && matches!(self.gated, serde_json::Value::Null | serde_json::Value::Bool(false))
    }

    fn hit(&self) -> SearchHit {
        let license = self.card_data.as_ref().and_then(|c| c.license.as_ref()).and_then(|value| match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(list) => list.iter().find_map(|v| v.as_str().map(str::to_string)),
            _ => None,
        });
        SearchHit {
            repo: self.id.clone(),
            likes: self.likes,
            downloads: self.downloads,
            last_modified: self.last_modified.clone(),
            license,
        }
    }
}

pub fn parse_search(body: &str) -> Result<Vec<SearchHit>, String> {
    let models: Vec<ApiModel> = serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok(models.iter().filter(|m| m.open() && valid_repo(&m.id)).map(ApiModel::hit).collect())
}

pub fn parse_model(body: &str) -> Result<RepoInfo, String> {
    let model: ApiModel = serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    if !model.open() {
        return Err(GATED.into());
    }
    let commit = model.sha.clone().filter(|sha| valid_commit(sha)).ok_or_else(|| BAD_RESPONSE.to_string())?;
    if !valid_repo(&model.id) {
        return Err(UNKNOWN_REPO.into());
    }
    Ok(RepoInfo { hit: model.hit(), commit })
}

#[derive(Deserialize)]
struct TreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    lfs: Option<Lfs>,
}

#[derive(Deserialize)]
struct Lfs {
    oid: String,
}

/// Files only. An LFS file keeps its SHA-256; any other file its git blob SHA-1 (the `oid` of an
/// LFS file is the pointer's, so it is not kept). Unsafe paths stay in the list; the detector
/// decides whether they matter.
pub fn parse_tree(body: &str) -> Result<Vec<RepoFile>, String> {
    let entries: Vec<TreeEntry> = serde_json::from_str(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.kind == "file")
        .map(|entry| match entry.lfs {
            Some(lfs) => RepoFile { path: entry.path, size: entry.size, sha256: Some(lfs.oid), git_sha1: None },
            None => RepoFile { path: entry.path, size: entry.size, sha256: None, git_sha1: entry.oid },
        })
        .collect())
}

/// The `rel="next"` URL of a `Link` header, when it stays on Hugging Face.
pub fn next_page(link: Option<&str>) -> Option<String> {
    link?.split(',').find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        if !rel.contains("rel=\"next\"") {
            return None;
        }
        let url = url.trim().trim_start_matches('<').trim_end_matches('>');
        let parsed = reqwest::Url::parse(url).ok()?;
        (parsed.scheme() == "https" && parsed.host_str().is_some_and(allowed_host)).then(|| url.to_string())
    })
}

pub fn classify(status: u16) -> &'static str {
    match status {
        429 => RATE_LIMITED,
        401 | 403 => GATED,
        404 => UNKNOWN_REPO,
        500..=599 => UNAVAILABLE,
        _ => BAD_RESPONSE,
    }
}

/// The body (at most `max_bytes`) and the `Link` header of a GET.
pub async fn get_text(client: &reqwest::Client, url: &str, max_bytes: usize) -> Result<(String, Option<String>), String> {
    let response = client.get(url).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() { OFFLINE.to_string() } else { UNAVAILABLE.to_string() }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(classify(status.as_u16()).into());
    }
    let link = response
        .headers()
        .get(reqwest::header::LINK)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OFFLINE.to_string())?;
        if body.len() + chunk.len() > max_bytes {
            return Err(BAD_RESPONSE.into());
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(body).map_err(|_| BAD_RESPONSE.to_string())?;
    Ok((text, link))
}
```

`safe_path` is imported for later use by callers of this module; if the compiler warns it is unused here, remove it from the `use`.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test --lib speech_hub::hf`
Expected: all pass. If `search_results_parse_with_stats` cannot find Kokoro v1.0 (fixture captured differently), re-run the Step 1 curl.

- [ ] **Step 6: Leave changes in the working tree** (no commit).

---

### Task 5: Search, resolve and their commands

**Files:**
- Create: `src-tauri/src/speech_hub/search.rs`
- Modify: `src-tauri/src/speech_hub/mod.rs`, `src-tauri/src/lib.rs` (manage `HubState`, register commands)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  ```rust
  // search.rs
  pub enum Sort { Likes, Recent }                       // serde "likes" | "recent"
  pub struct SearchQuery { pub use_: Option<String>, pub query: String, pub language: Option<String>, pub sort: Sort, pub offset: usize }  // serde: "use", camelCase
  pub const PAGE: usize = 30;
  pub fn terms(query: &SearchQuery) -> Vec<String>
  pub struct Candidate { pub hit: SearchHit, pub family: Family, pub meta: ModelMeta }
  pub fn rank(candidates: Vec<Candidate>, query: &SearchQuery) -> (Vec<Candidate>, bool)
  // mod.rs
  pub struct HubModelInfo { repo, commit: Option<String>, family: Family, languages, language_count: Option<u32>, multilingual: bool,
      speed: Option<u8>, accuracy: Option<u8>, voice_count: Option<u32>, license: Option<String>, last_modified: Option<String>,
      likes: u64, file_count: Option<u32>, total_bytes: Option<u64> }        // Serialize camelCase
  pub struct HubSearchResult { pub id: String, pub use_: &'static str /* "use" */, pub label: String, pub hub: HubModelInfo }
  pub struct HubSearchPage { pub results: Vec<HubSearchResult>, pub has_more: bool }
  pub struct Resolved { pub info: hf::RepoInfo, pub planned: detect::Planned, pub meta: meta::ModelMeta }
  #[derive(Default)] pub struct HubState { ... }
  pub fn hub_info(hit: &SearchHit, commit: Option<&str>, family: Family, meta: &ModelMeta, files: Option<&[RepoFile]>) -> HubModelInfo
  pub fn hub_id(repo: &str) -> String                   // "hf:{repo}"
  pub async fn resolve(state: &HubState, repo: &str) -> Result<Resolved, String>
  #[tauri::command] pub async fn speech_hub_search(state: State<'_, HubState>, query: SearchQuery) -> Result<HubSearchPage, String>
  #[tauri::command] pub async fn speech_hub_resolve(state: State<'_, HubState>, repo: String) -> Result<HubSearchResult, String>
  ```

- [ ] **Step 1: Write the failing tests for `search.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_hub::meta::describe;

    fn query(use_: Option<&str>, text: &str, language: Option<&str>, sort: Sort, offset: usize) -> SearchQuery {
        SearchQuery { use_: use_.map(str::to_string), query: text.into(), language: language.map(str::to_string), sort, offset }
    }

    fn candidate(repo: &str, family: Family, likes: u64, modified: &str) -> Candidate {
        let name = repo.split_once('/').unwrap().1;
        Candidate {
            hit: SearchHit { repo: repo.into(), likes, downloads: 0, last_modified: Some(modified.into()), license: None },
            family,
            meta: describe(family, name, None),
        }
    }

    #[test]
    fn short_queries_fall_back_to_family_terms() {
        assert_eq!(terms(&query(None, "kokoro", None, Sort::Likes, 0)), vec!["kokoro"]);
        assert_eq!(terms(&query(Some("tts"), " k ", None, Sort::Likes, 0)), vec!["vits-", "kokoro", "kitten"]);
        assert_eq!(terms(&query(Some("stt"), "", None, Sort::Likes, 0)), vec!["sherpa-onnx"]);
        assert_eq!(terms(&query(None, "", None, Sort::Likes, 0)), vec!["vits-", "kokoro", "kitten", "sherpa-onnx"]);
    }

    #[test]
    fn rank_filters_by_use_and_language_and_dedups() {
        let all = vec![
            candidate("csukuangfj/vits-piper-pt_BR-faber-medium", Family::Vits, 6, "2023-11-29"),
            candidate("csukuangfj/vits-piper-en_US-amy-low", Family::Vits, 9, "2023-11-29"),
            candidate("csukuangfj/kokoro-multi-lang-v1_0", Family::Kokoro, 3, "2026-09-08"),
            candidate("csukuangfj/sherpa-onnx-whisper-turbo", Family::Whisper, 1, "2024-10-01"),
            candidate("csukuangfj/vits-piper-pt_BR-faber-medium", Family::Vits, 6, "2023-11-29"),
        ];
        let (page, more) = rank(all.clone(), &query(Some("tts"), "", Some("pt"), Sort::Likes, 0));
        assert_eq!(page.iter().map(|c| c.hit.repo.as_str()).collect::<Vec<_>>(), vec!["csukuangfj/vits-piper-pt_BR-faber-medium", "csukuangfj/kokoro-multi-lang-v1_0"]);
        assert!(!more);
        let (stt, _) = rank(all.clone(), &query(Some("stt"), "", Some("pt"), Sort::Likes, 0));
        assert_eq!(stt.len(), 1, "Whisper's 99 languages include Portuguese");
        let (recent, _) = rank(all, &query(None, "", None, Sort::Recent, 0));
        assert_eq!(recent[0].hit.repo, "csukuangfj/kokoro-multi-lang-v1_0");
    }

    #[test]
    fn rank_pages_by_thirty() {
        let many: Vec<Candidate> = (0..45)
            .map(|i| candidate(&format!("csukuangfj/vits-piper-en_US-v{i}-low"), Family::Vits, 100 - i, "2023-01-01"))
            .collect();
        let (first, more) = rank(many.clone(), &query(None, "", None, Sort::Likes, 0));
        assert_eq!((first.len(), more), (30, true));
        let (second, more) = rank(many, &query(None, "", None, Sort::Likes, 30));
        assert_eq!((second.len(), more), (15, false));
    }
}
```

Add `pub mod search;` to `mod.rs`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_hub::search`
Expected: compile errors.

- [ ] **Step 3: Implement `search.rs`**

```rust
//! Which API searches to run for a query, and how their merged results are filtered, ordered and
//! paged. Pure, so it is tested without the network.

use serde::Deserialize;

use super::detect::Family;
use super::hf::SearchHit;
use super::meta::ModelMeta;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    Likes,
    Recent,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// `stt`, `tts`, or `None` for both.
    #[serde(rename = "use")]
    pub use_: Option<String>,
    pub query: String,
    /// BCP-47 tag; matched on its primary subtag.
    pub language: Option<String>,
    pub sort: Sort,
    pub offset: usize,
}

pub const PAGE: usize = 30;
const MIN_QUERY: usize = 2;
const TTS_TERMS: &[&str] = &["vits-", "kokoro", "kitten"];
const STT_TERMS: &[&str] = &["sherpa-onnx"];

#[derive(Clone, Debug)]
pub struct Candidate {
    pub hit: SearchHit,
    pub family: Family,
    pub meta: ModelMeta,
}

/// The API matches `search` against repo names only; an empty or one-letter query lists every
/// repo of the families for the use.
pub fn terms(query: &SearchQuery) -> Vec<String> {
    let text = query.query.trim();
    if text.chars().count() >= MIN_QUERY {
        return vec![text.to_string()];
    }
    let mut out: Vec<&str> = Vec::new();
    if query.use_.as_deref() != Some("stt") {
        out.extend(TTS_TERMS);
    }
    if query.use_.as_deref() != Some("tts") {
        out.extend(STT_TERMS);
    }
    out.into_iter().map(str::to_string).collect()
}

fn primary(tag: &str) -> String {
    tag.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase()
}

/// Many languages (Whisper's 99, a multilingual model) count as covering any language.
fn speaks(meta: &ModelMeta, language: &str) -> bool {
    let wanted = primary(language);
    meta.multilingual
        || meta.language_count.is_some_and(|count| count > 3)
        || meta.languages.iter().any(|tag| primary(tag) == wanted)
}

/// The page at `query.offset` and whether more follow.
pub fn rank(candidates: Vec<Candidate>, query: &SearchQuery) -> (Vec<Candidate>, bool) {
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<Candidate> = candidates
        .into_iter()
        .filter(|c| seen.insert(c.hit.repo.clone()))
        .filter(|c| query.use_.as_deref().is_none_or(|use_| c.family.use_name() == use_))
        .filter(|c| query.language.as_deref().is_none_or(|language| speaks(&c.meta, language)))
        .collect();
    match query.sort {
        Sort::Likes => list.sort_by(|a, b| {
            (b.hit.likes, b.hit.downloads, &b.hit.last_modified).cmp(&(a.hit.likes, a.hit.downloads, &a.hit.last_modified))
        }),
        Sort::Recent => list.sort_by(|a, b| b.hit.last_modified.cmp(&a.hit.last_modified)),
    }
    let has_more = list.len() > query.offset + PAGE;
    let page = list.into_iter().skip(query.offset).take(PAGE).collect();
    (page, has_more)
}
```

- [ ] **Step 4: Run the search tests**

Run: `cd src-tauri && cargo test --lib speech_hub::search`
Expected: all pass.

- [ ] **Step 5: Implement `mod.rs` (state, wire types, commands)**

Replace `src-tauri/src/speech_hub/mod.rs` with:

```rust
//! Local voice and speech models found on Hugging Face: search, resolve (exact files of a pinned
//! commit) and manifests of installed models.

pub mod detect;
pub mod hf;
pub mod installed;
pub mod meta;
pub mod search;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use detect::{Family, Planned, RepoFile};
use hf::{RepoInfo, SearchHit};
use meta::{ModelMeta, PiperConfig};
use search::{Candidate, SearchQuery};

/// A model larger than this is not offered.
pub const MAX_MODEL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// A file outside LFS larger than this is not offered (Kokoro's largest is 6 MB).
pub const MAX_SMALL_FILE_BYTES: u64 = 16 * 1024 * 1024;
const SEARCH_TTL: Duration = Duration::from_secs(600);
/// A search page can hold 500 repos, about 100 KB.
const MAX_SEARCH_BYTES: usize = 4 * 1024 * 1024;
/// A recursive tree of a voice is about 80 KB; Kokoro's is under 200 KB.
const MAX_TREE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PIPER_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_TREE_PAGES: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubModelInfo {
    pub repo: String,
    pub commit: Option<String>,
    pub family: Family,
    pub languages: Vec<String>,
    pub language_count: Option<u32>,
    pub multilingual: bool,
    pub speed: Option<u8>,
    pub accuracy: Option<u8>,
    pub voice_count: Option<u32>,
    pub license: Option<String>,
    pub last_modified: Option<String>,
    pub likes: u64,
    pub file_count: Option<u32>,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSearchResult {
    pub id: String,
    #[serde(rename = "use")]
    pub use_: &'static str,
    pub label: String,
    pub hub: HubModelInfo,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSearchPage {
    pub results: Vec<HubSearchResult>,
    pub has_more: bool,
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub info: RepoInfo,
    pub planned: Planned,
    pub meta: ModelMeta,
}

#[derive(Default)]
pub struct HubState {
    searches: Mutex<HashMap<String, (Instant, Vec<SearchHit>)>>,
    resolved: Mutex<HashMap<String, Resolved>>,
}

pub fn hub_id(repo: &str) -> String {
    format!("hf:{repo}")
}

fn repo_name(repo: &str) -> &str {
    repo.split_once('/').map_or(repo, |(_, name)| name)
}

pub fn hub_info(
    hit: &SearchHit,
    commit: Option<&str>,
    family: Family,
    meta: &ModelMeta,
    files: Option<&[RepoFile]>,
) -> HubModelInfo {
    let voices = if !meta.voices.is_empty() { meta.voices.len() as u32 } else { meta.voice_count };
    HubModelInfo {
        repo: hit.repo.clone(),
        commit: commit.map(str::to_string),
        family,
        languages: meta.languages.clone(),
        language_count: meta.language_count,
        multilingual: meta.multilingual,
        speed: meta.speed,
        accuracy: meta.accuracy,
        voice_count: (family.is_tts() && voices > 0).then_some(voices),
        license: hit.license.clone(),
        last_modified: hit.last_modified.clone(),
        likes: hit.likes,
        file_count: files.map(|f| f.len() as u32),
        total_bytes: files.map(|f| f.iter().map(|file| file.size).sum()),
    }
}

fn result_of(resolved: &Resolved) -> HubSearchResult {
    let family = resolved.planned.family;
    HubSearchResult {
        id: hub_id(&resolved.info.hit.repo),
        use_: family.use_name(),
        label: resolved.meta.label.clone(),
        hub: hub_info(&resolved.info.hit, Some(&resolved.info.commit), family, &resolved.meta, Some(&resolved.planned.files)),
    }
}

async fn fetch_hits(state: &HubState, client: &reqwest::Client, author: &str, term: &str) -> Result<Vec<SearchHit>, String> {
    let key = format!("{author}|{term}");
    if let Some((at, hits)) = state.searches.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        if at.elapsed() < SEARCH_TTL {
            return Ok(hits.clone());
        }
    }
    let (body, _) = hf::get_text(client, &hf::search_url(author, term), MAX_SEARCH_BYTES).await?;
    let hits = hf::parse_search(&body)?;
    state
        .searches
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, (Instant::now(), hits.clone()));
    Ok(hits)
}

#[tauri::command]
pub async fn speech_hub_search(state: State<'_, HubState>, query: SearchQuery) -> Result<HubSearchPage, String> {
    let client = hf::client()?;
    let terms = search::terms(&query);
    let requests: Vec<(&str, String)> = hf::ALLOWED_AUTHORS
        .iter()
        .flat_map(|author| terms.iter().map(move |term| (*author, term.clone())))
        .collect();
    let replies = futures_util::future::join_all(
        requests.iter().map(|(author, term)| fetch_hits(&state, &client, author, term)),
    )
    .await;
    // A failure of every request is the error; a partial failure still lists what came back.
    let mut hits = Vec::new();
    let mut first_error = None;
    for reply in replies {
        match reply {
            Ok(list) => hits.extend(list),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if hits.is_empty() {
        if let Some(error) = first_error {
            return Err(error);
        }
    }
    let candidates = hits
        .into_iter()
        .filter_map(|hit| {
            let name = repo_name(&hit.repo).to_string();
            let family = detect::family_of(&name)?;
            Some(Candidate { meta: meta::describe(family, &name, None), hit, family })
        })
        .collect();
    let (page, has_more) = search::rank(candidates, &query);
    let resolved = state.resolved.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let results = page
        .into_iter()
        .map(|c| match resolved.get(&c.hit.repo) {
            Some(found) => result_of(found),
            None => HubSearchResult {
                id: hub_id(&c.hit.repo),
                use_: c.family.use_name(),
                label: c.meta.label.clone(),
                hub: hub_info(&c.hit, None, c.family, &c.meta, None),
            },
        })
        .collect();
    Ok(HubSearchPage { results, has_more })
}

async fn piper_config(client: &reqwest::Client, repo: &str, commit: &str, planned: &Planned) -> Option<PiperConfig> {
    let file = planned
        .files
        .iter()
        .find(|f| f.path.ends_with(".onnx.json") && f.size <= MAX_PIPER_CONFIG_BYTES)?;
    let (body, _) = hf::get_text(client, &hf::resolve_url(repo, commit, &file.path), MAX_PIPER_CONFIG_BYTES as usize).await.ok()?;
    serde_json::from_str(&body).ok()
}

/// The exact files of the repo's current commit, checked against the limits; cached per session.
pub async fn resolve(state: &HubState, repo: &str) -> Result<Resolved, String> {
    if !hf::valid_repo(repo) {
        return Err(hf::UNKNOWN_REPO.into());
    }
    if let Some(found) = state.resolved.lock().unwrap_or_else(|e| e.into_inner()).get(repo).cloned() {
        return Ok(found);
    }
    let client = hf::client()?;
    let (body, _) = hf::get_text(&client, &hf::model_url(repo), MAX_TREE_BYTES).await?;
    let info = hf::parse_model(&body)?;
    if info.hit.repo != repo {
        return Err(hf::UNKNOWN_REPO.into());
    }
    let mut files = Vec::new();
    let mut next = Some(hf::tree_url(repo, &info.commit));
    let mut pages = 0;
    while let Some(url) = next.take() {
        pages += 1;
        if pages > MAX_TREE_PAGES {
            return Err(hf::BAD_RESPONSE.into());
        }
        let (body, link) = hf::get_text(&client, &url, MAX_TREE_BYTES).await?;
        files.extend(hf::parse_tree(&body)?);
        next = hf::next_page(link.as_deref());
    }
    let name = repo_name(repo);
    let planned = detect::plan(name, &files).ok_or_else(|| hf::INCOMPATIBLE.to_string())?;
    let total: u64 = planned.files.iter().map(|f| f.size).sum();
    let oversized_small = planned.files.iter().any(|f| f.sha256.is_none() && f.size > MAX_SMALL_FILE_BYTES);
    if total > MAX_MODEL_BYTES || oversized_small {
        return Err(hf::TOO_LARGE.into());
    }
    if planned.files.iter().any(|f| f.sha256.is_none() && f.git_sha1.is_none()) {
        return Err(hf::BAD_RESPONSE.into());
    }
    let piper = if planned.family == Family::Vits { piper_config(&client, repo, &info.commit, &planned).await } else { None };
    let meta = meta::describe(planned.family, name, piper.as_ref());
    let resolved = Resolved { info, planned, meta };
    state
        .resolved
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(repo.to_string(), resolved.clone());
    Ok(resolved)
}

#[tauri::command]
pub async fn speech_hub_resolve(state: State<'_, HubState>, repo: String) -> Result<HubSearchResult, String> {
    resolve(&state, &repo).await.map(|resolved| result_of(&resolved))
}
```

`installed` is declared here but created in Task 6; until then create an empty `src-tauri/src/speech_hub/installed.rs` with the doc line `//! Manifests of Hugging Face models on disk.` so this compiles.

- [ ] **Step 6: Register state and commands**

In `src-tauri/src/lib.rs`: next to the existing `.manage(speech::SpeechState::default())` (search for `SpeechState::default()`), add `.manage(speech_hub::HubState::default())`; in the `invoke_handler` list after `speech::speech_native_locales,` add:

```rust
            speech_hub::speech_hub_search,
            speech_hub::speech_hub_resolve,
```

- [ ] **Step 7: Build and run the module tests**

Run: `cd src-tauri && cargo test --lib speech_hub`
Expected: all pass.
Run: `cargo clippy --lib --message-format=short 2>&1 | grep speech_hub` — must print nothing.

- [ ] **Step 8: Leave changes in the working tree** (no commit).

---

### Task 6: Manifests of installed models

**Files:**
- Modify: `src-tauri/src/speech_hub/installed.rs`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  ```rust
  pub const MANIFEST: &str = "alethe-model.json";
  pub const VERSION: u32 = 1;
  pub struct HubManifest { pub version: u32, pub id: String, pub repo: String, pub commit: String, pub family: Family,
      pub layout: HubLayout, pub files: Vec<RepoFile>, pub meta: ModelMeta, pub stats: SearchHit, pub complete: bool }
  impl HubManifest { pub fn total_bytes(&self) -> u64; pub fn info(&self) -> HubModelInfo }
  pub fn repo_of(id: &str) -> Option<&str>
  pub fn dir_name(id: &str) -> Option<String>
  pub fn from_resolved(resolved: &Resolved) -> HubManifest      // complete = false
  /// The manifest a (re)started download uses: the one on disk when present (same commit), else the resolved one.
  pub fn for_download(existing: Option<HubManifest>, resolved: impl FnOnce() -> HubManifest) -> HubManifest
  pub fn validate(manifest: &HubManifest, dir_name_on_disk: &str) -> bool
  pub fn read(dir: &Path) -> Option<HubManifest>
  pub fn write(dir: &Path, manifest: &HubManifest) -> Result<(), String>
  pub fn list(root: &Path) -> Vec<(PathBuf, HubManifest)>
  pub fn is_ready(dir: &Path, manifest: &HubManifest) -> bool
  ```

- [ ] **Step 1: Write the failing tests**

Append to `installed.rs`:

```rust
#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::speech_hub::detect::{plan, RepoFile};
    use crate::speech_hub::hf::{RepoInfo, SearchHit};
    use crate::speech_hub::meta::describe;
    use crate::speech_hub::Resolved;

    const REPO: &str = "csukuangfj/vits-piper-pt_BR-faber-medium";

    fn resolved(commit: char) -> Resolved {
        let files: Vec<RepoFile> = ["pt_BR-faber-medium.onnx", "tokens.txt", "espeak-ng-data/pt_dict"]
            .iter()
            .map(|p| RepoFile { path: (*p).into(), size: 3, sha256: None, git_sha1: Some("0".repeat(40)) })
            .collect();
        let name = "vits-piper-pt_BR-faber-medium";
        Resolved {
            info: RepoInfo { hit: SearchHit { repo: REPO.into(), likes: 6, ..Default::default() }, commit: commit.to_string().repeat(40) },
            planned: plan(name, &files).unwrap(),
            meta: describe(crate::speech_hub::detect::Family::Vits, name, None),
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-hub-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn ids_map_to_safe_folder_names() {
        assert_eq!(repo_of("hf:csukuangfj/x"), Some("csukuangfj/x"));
        assert_eq!(repo_of("piper-en-us-amy-low"), None);
        assert_eq!(dir_name("hf:csukuangfj/x").as_deref(), Some("hf--csukuangfj--x"));
        assert_eq!(dir_name("hf:someone/x"), None);
        assert_eq!(dir_name("hf:csukuangfj/../x"), None);
    }

    #[test]
    fn manifest_round_trips_and_validates() {
        let root = temp_root("roundtrip");
        let manifest = from_resolved(&resolved('a'));
        assert!(!manifest.complete);
        let dir = root.join(dir_name(&manifest.id).unwrap());
        fs::create_dir_all(&dir).unwrap();
        write(&dir, &manifest).unwrap();
        assert_eq!(read(&dir), Some(manifest.clone()));
        assert_eq!(list(&root).len(), 1);
    }

    #[test]
    fn manifest_in_the_wrong_folder_is_rejected() {
        let manifest = from_resolved(&resolved('a'));
        assert!(validate(&manifest, "hf--csukuangfj--vits-piper-pt_BR-faber-medium"));
        assert!(!validate(&manifest, "hf--csukuangfj--other"));
    }

    #[test]
    fn manifest_with_unsafe_path_is_rejected() {
        let mut manifest = from_resolved(&resolved('a'));
        manifest.files.push(RepoFile { path: "../escape".into(), size: 1, sha256: None, git_sha1: Some("0".repeat(40)) });
        assert!(!validate(&manifest, "hf--csukuangfj--vits-piper-pt_BR-faber-medium"));
        let mut missing = from_resolved(&resolved('a'));
        missing.files.retain(|f| f.path != "tokens.txt");
        assert!(!validate(&missing, "hf--csukuangfj--vits-piper-pt_BR-faber-medium"), "layout names a file not in the list");
        let mut shadow = from_resolved(&resolved('a'));
        shadow.files.push(RepoFile { path: MANIFEST.into(), size: 1, sha256: None, git_sha1: Some("0".repeat(40)) });
        assert!(!validate(&shadow, "hf--csukuangfj--vits-piper-pt_BR-faber-medium"));
    }

    #[test]
    fn readiness_needs_completion_and_every_file() {
        let root = temp_root("ready");
        let mut manifest = from_resolved(&resolved('a'));
        let dir = root.join(dir_name(&manifest.id).unwrap());
        fs::create_dir_all(dir.join("espeak-ng-data")).unwrap();
        for file in &manifest.files {
            fs::write(dir.join(&file.path), b"abc").unwrap();
        }
        assert!(!is_ready(&dir, &manifest), "a pending manifest is not ready");
        manifest.complete = true;
        assert!(is_ready(&dir, &manifest));
        fs::remove_file(dir.join("tokens.txt")).unwrap();
        assert!(!is_ready(&dir, &manifest));
    }

    #[test]
    fn download_reuses_the_pending_manifest() {
        let pending = from_resolved(&resolved('a'));
        let used = for_download(Some(pending.clone()), || from_resolved(&resolved('b')));
        assert_eq!(used.commit, "a".repeat(40), "a resumed download keeps its commit");
        let fresh = for_download(None, || from_resolved(&resolved('b')));
        assert_eq!(fresh.commit, "b".repeat(40));
    }

    #[test]
    fn unreadable_or_foreign_folders_are_skipped() {
        let root = temp_root("skip");
        fs::create_dir_all(root.join("hf--csukuangfj--broken")).unwrap();
        fs::write(root.join("hf--csukuangfj--broken").join(MANIFEST), b"{not json").unwrap();
        fs::create_dir_all(root.join("piper-en-us-amy-low")).unwrap();
        assert!(list(&root).is_empty());
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_hub::installed`
Expected: compile errors.

- [ ] **Step 3: Implement `installed.rs`**

Replace the placeholder line with (keep the test module at the end):

```rust
//! Manifests of Hugging Face models on disk. A manifest is written when a download starts
//! (`complete: false`) and completed when every file is verified, so a paused download survives
//! a restart and resumes the same commit. Every read re-validates the manifest.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::detect::{safe_path, Family, HubLayout, RepoFile};
use super::hf::{self, SearchHit};
use super::meta::ModelMeta;
use super::{hub_id, hub_info, HubModelInfo, Resolved};

pub const MANIFEST: &str = "alethe-model.json";
pub const VERSION: u32 = 1;
const DIR_PREFIX: &str = "hf--";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubManifest {
    pub version: u32,
    pub id: String,
    pub repo: String,
    pub commit: String,
    pub family: Family,
    pub layout: HubLayout,
    pub files: Vec<RepoFile>,
    pub meta: ModelMeta,
    pub stats: SearchHit,
    pub complete: bool,
}

impl HubManifest {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn info(&self) -> HubModelInfo {
        hub_info(&self.stats, Some(&self.commit), self.family, &self.meta, Some(&self.files))
    }
}

pub fn repo_of(id: &str) -> Option<&str> {
    id.strip_prefix("hf:")
}

pub fn dir_name(id: &str) -> Option<String> {
    let repo = repo_of(id).filter(|repo| hf::valid_repo(repo))?;
    Some(format!("{DIR_PREFIX}{}", repo.replace('/', "--")))
}

pub fn from_resolved(resolved: &Resolved) -> HubManifest {
    HubManifest {
        version: VERSION,
        id: hub_id(&resolved.info.hit.repo),
        repo: resolved.info.hit.repo.clone(),
        commit: resolved.info.commit.clone(),
        family: resolved.planned.family,
        layout: resolved.planned.layout.clone(),
        files: resolved.planned.files.clone(),
        meta: resolved.meta.clone(),
        stats: resolved.info.hit.clone(),
        complete: false,
    }
}

pub fn for_download(existing: Option<HubManifest>, resolved: impl FnOnce() -> HubManifest) -> HubManifest {
    existing.unwrap_or_else(resolved)
}

pub fn validate(manifest: &HubManifest, dir_name_on_disk: &str) -> bool {
    let listed = |path: &str| manifest.files.iter().any(|f| f.path == path);
    manifest.version == VERSION
        && hf::valid_repo(&manifest.repo)
        && manifest.id == hub_id(&manifest.repo)
        && dir_name(&manifest.id).as_deref() == Some(dir_name_on_disk)
        && hf::valid_commit(&manifest.commit)
        && !manifest.files.is_empty()
        && manifest.files.iter().all(|f| safe_path(&f.path) && f.path != MANIFEST && !f.path.ends_with(".part"))
        && manifest.family.is_tts() == matches!(manifest.layout, HubLayout::Tts(_))
        && manifest.layout.files().iter().all(|path| listed(path))
}

pub fn read(dir: &Path) -> Option<HubManifest> {
    let name = dir.file_name()?.to_str()?;
    let body = fs::read_to_string(dir.join(MANIFEST)).ok()?;
    let manifest: HubManifest = serde_json::from_str(&body).ok()?;
    validate(&manifest, name).then_some(manifest)
}

/// Written next to the files through a temporary name, so a crash never leaves half a manifest.
pub fn write(dir: &Path, manifest: &HubManifest) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(manifest).map_err(|e| format!("manifest: {e}"))?;
    let tmp = dir.join(format!("{MANIFEST}.tmp"));
    fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, dir.join(MANIFEST)).map_err(|e| format!("finalize manifest: {e}"))
}

/// Every valid manifest under `root`, by label.
pub fn list(root: &Path) -> Vec<(PathBuf, HubManifest)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, HubManifest)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(DIR_PREFIX)))
        .filter_map(|path| read(&path).map(|manifest| (path, manifest)))
        .collect();
    found.sort_by(|a, b| a.1.meta.label.cmp(&b.1.meta.label));
    found
}

pub fn is_ready(dir: &Path, manifest: &HubManifest) -> bool {
    manifest.complete && manifest.files.iter().all(|f| dir.join(&f.path).is_file())
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib speech_hub::installed`
Expected: all pass.

- [ ] **Step 5: Leave changes in the working tree** (no commit).

---

### Task 7: Hugging Face models in the speech and voice commands

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `sha1 = "0.10"` next to `sha2`), `src-tauri/src/speech.rs`, `src-tauri/src/tts.rs`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces (behavior):
  - `speech_list_models(app)` returns catalog models plus every valid manifest; `SpeechModelManifest` gains `source: String` (`"catalog"` | `"huggingface"`) and `hub: Option<HubModelInfo>` (omitted when `None`).
  - `speech_model_states`, `speech_download_model`, `speech_pause_download`, `speech_cancel_download`, `speech_delete_model`, `speech_prepare`, transcription and `tts_speak`/`tts_voices` accept `hf:` ids.
  - `pub(crate) fn local_tts_voices(app: &AppHandle, id: &str) -> Vec<crate::speech_hub::meta::HubVoice>` (async) used by `tts_voices`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)] mod tests` in `src-tauri/src/speech.rs`:

```rust
    #[test]
    fn git_blob_sha1_matches_git() {
        let path = std::env::temp_dir().join(format!("alethe-blob-{}", std::process::id()));
        std::fs::write(&path, b"hello\n").unwrap();
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(git_blob_sha1(&path).unwrap(), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert!(verify(&path, &Check::GitSha1("ce013625030ba8dba906f756967f9e9ca394464a".into())).unwrap());
        assert!(!verify(&path, &Check::Sha256("0".repeat(64))).unwrap());
    }

    #[test]
    fn hub_files_become_download_files_with_their_checks() {
        let files = vec![
            crate::speech_hub::detect::RepoFile { path: "a.onnx".into(), size: 5, sha256: Some("f".repeat(64)), git_sha1: None },
            crate::speech_hub::detect::RepoFile { path: "espeak-ng-data/x".into(), size: 2, sha256: None, git_sha1: Some("e".repeat(40)) },
        ];
        let out = hub_download_files("csukuangfj/r", &"c".repeat(40), &files).unwrap();
        assert_eq!(out[0].url, format!("https://huggingface.co/csukuangfj/r/resolve/{}/a.onnx", "c".repeat(40)));
        assert!(matches!(&out[0].check, Check::Sha256(h) if h == &"f".repeat(64)));
        assert!(matches!(&out[1].check, Check::GitSha1(h) if h == &"e".repeat(40)));
        assert_eq!(out[1].name, "espeak-ng-data/x");
        let unchecked = vec![crate::speech_hub::detect::RepoFile { path: "b".into(), size: 1, sha256: None, git_sha1: None }];
        assert!(hub_download_files("csukuangfj/r", &"c".repeat(40), &unchecked).is_err());
    }

    #[test]
    fn hub_ids_are_known_models() {
        assert!(matches!(ready_check("hf:csukuangfj/x"), Ok(ReadyCheck::Hub)));
        assert!(ready_check("hf:someone/x").is_err());
        assert!(matches!(ready_check("piper-en-us-amy-low"), Ok(ReadyCheck::Tts(_))));
        assert!(matches!(ready_check("whisper-base-int8"), Ok(ReadyCheck::Stt(_))));
        assert!(ready_check("nope").is_err());
    }
```

Also update the existing `pick_fallback` tests to the new signature (`&["zipformer-small-en-int8".to_string()]` instead of `&["zipformer-small-en-int8"]`, and `FallbackStt::Sherpa(id)` now holds a `String`; compare with `id == "…"`).

Add `sha1 = "0.10"` to `[dependencies]` in `src-tauri/Cargo.toml` (it is already in `Cargo.lock` at 0.10.7).

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech::tests`
Expected: compile errors (`git_blob_sha1`, `verify`, `Check`, `hub_download_files`, `ready_check`, `ReadyCheck` missing).

- [ ] **Step 3: Owned download files with two kinds of checks**

In `speech.rs`, after `struct ModelFile`, add:

```rust
/// A file to fetch: catalog files convert from `ModelFile`, Hugging Face files from a manifest.
/// `name` is relative to the model folder and may contain `/`.
struct DownloadFile {
    name: String,
    url: String,
    size_bytes: u64,
    check: Check,
}

enum Check {
    Sha256(String),
    /// Git blob SHA-1, for Hugging Face files stored outside LFS.
    GitSha1(String),
}

impl From<&ModelFile> for DownloadFile {
    fn from(file: &ModelFile) -> Self {
        Self {
            name: file.name.into(),
            url: file.url.into(),
            size_bytes: file.size_bytes,
            check: Check::Sha256(file.sha256.into()),
        }
    }
}

fn hub_download_files(repo: &str, commit: &str, files: &[crate::speech_hub::detect::RepoFile]) -> Result<Vec<DownloadFile>, String> {
    files
        .iter()
        .map(|file| {
            let check = match (&file.sha256, &file.git_sha1) {
                (Some(sha), _) => Check::Sha256(sha.clone()),
                (None, Some(sha)) => Check::GitSha1(sha.clone()),
                (None, None) => return Err(format!("no checksum for {}", file.path)),
            };
            Ok(DownloadFile {
                name: file.path.clone(),
                url: crate::speech_hub::hf::resolve_url(repo, commit, &file.path),
                size_bytes: file.size,
                check,
            })
        })
        .collect()
}

/// `git hash-object` of a file: SHA-1 over `blob {len}\0` and the content.
fn git_blob_sha1(path: &Path) -> Result<String, String> {
    use sha1::{Digest as _, Sha1};
    use std::io::Read;
    let len = fs::metadata(path).map_err(|e| format!("read {}: {e}", path.display()))?.len();
    let mut file = File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {len}\0").as_bytes());
    let mut buf = [0u8; 1024 * 64];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn verify(path: &Path, check: &Check) -> Result<bool, String> {
    Ok(match check {
        Check::Sha256(expected) => sha256_file(path)? == *expected,
        Check::GitSha1(expected) => git_blob_sha1(path)? == *expected,
    })
}

/// Below this size a file is verified without its own progress event, so a voice's ~350 small
/// espeak files do not flood the webview.
const QUIET_VERIFY_BYTES: u64 = 8 * 1024 * 1024;

fn download_client() -> Result<reqwest::Client, String> {
    // A stalled connection fails as a resumable error instead of hanging, so pause and cancel land.
    reqwest::Client::builder()
        .read_timeout(DOWNLOAD_READ_TIMEOUT)
        .build()
        .map_err(|e| format!("download client: {e}"))
}
```

Change `download_files`:
- Signature: `async fn download_files(app: &AppHandle, client: &reqwest::Client, model_id: &str, dir: &Path, files: &[DownloadFile], stop: &AtomicBool) -> Result<(), String>`; delete its own client builder (the comment moves to `download_client`).
- `emit` takes `file: &DownloadFile` and uses `file: file.name.clone()`.
- At the top of the loop body:
  ```rust
  let dest = dir.join(&file.name);
  if let Some(parent) = dest.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
  }
  ```
- Existing-file check: replace `match sha256_file(&dest) { Ok(hash) if hash == file.sha256 => …` with `match verify(&dest, &file.check) { Ok(true) => { downloaded_total += file.size_bytes; continue; } _ => { let _ = fs::remove_file(&dest); } }`, and wrap its `emit("verifying", …)` in `if file.size_bytes >= QUIET_VERIFY_BYTES`.
- `client.get(&file.url)`.
- Final check: replace the hash comparison block with:
  ```rust
  if file.size_bytes >= QUIET_VERIFY_BYTES || throttle.ready(Instant::now(), false) {
      // Hashing the 650 MB encoder takes seconds; say so instead of sitting at 100%.
      emit("verifying", file, index, downloaded_total + file_got);
  }
  if !verify(&tmp, &file.check)? {
      let _ = fs::remove_file(&tmp);
      return Err(format!("checksum mismatch for {}", file.name));
  }
  ```

Update the two catalog call sites in `speech_download_model`:
```rust
let client = download_client()?;
// TTS:
let files = [DownloadFile::from(&entry.archive)];
download_files(&app, &client, &model_id, &dir, &files, &stop).await?;
// STT:
let files: Vec<DownloadFile> = entry.files.iter().map(DownloadFile::from).collect();
download_files(&app, &client, &model_id, &dir, &files, &stop).await?;
```

- [ ] **Step 4: Known models, folders and readiness**

Add near `find_entry`:

```rust
use crate::speech_hub::detect::HubLayout;
use crate::speech_hub::installed::{self, HubManifest};

/// What kind of model an id names, to check readiness the right way.
enum ReadyCheck {
    Stt(&'static CatalogEntry),
    Tts(&'static TtsCatalogEntry),
    Hub,
}

impl ReadyCheck {
    fn is_ready(&self, dir: &Path) -> bool {
        match self {
            Self::Stt(entry) => model_ready(dir, entry),
            Self::Tts(entry) => tts_ready(dir, entry),
            Self::Hub => installed::read(dir).is_some_and(|m| installed::is_ready(dir, &m)),
        }
    }
}

fn ready_check(id: &str) -> Result<ReadyCheck, String> {
    if installed::repo_of(id).is_some() {
        return installed::dir_name(id).map(|_| ReadyCheck::Hub).ok_or_else(|| format!("Unknown speech model: {id}"));
    }
    if let Some(entry) = find_tts_entry(id) {
        return Ok(ReadyCheck::Tts(entry));
    }
    find_entry(id).map(ReadyCheck::Stt)
}
```

Replace `model_dir`:

```rust
fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let root = models_root(app)?;
    if installed::repo_of(id).is_some() {
        return installed::dir_name(id).map(|name| root.join(name)).ok_or_else(|| format!("Unknown speech model: {id}"));
    }
    Ok(root.join(id))
}
```

`speech_cancel_download` becomes:

```rust
    let check = ready_check(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    speech_download::cancel_download(&state.downloads, &state.download_lock, &model_id, &dir, move |dir| check.is_ready(dir))
        .await
        .map_err(|e| format!("cancel download: {e}"))
```

`speech_delete_model`: replace the `find_tts_entry`/`find_entry` checks with `ready_check(&model_id)?;`.

- [ ] **Step 5: Listing and states**

Extend `SpeechModelManifest`:

```rust
    /// `catalog` or `huggingface`.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<crate::speech_hub::HubModelInfo>,
```

Set `source: "catalog".to_string(), hub: None,` in the three constructors in `catalog_manifests`. Add:

```rust
fn hub_manifest_view(manifest: &HubManifest) -> SpeechModelManifest {
    SpeechModelManifest {
        id: manifest.id.clone(),
        label: manifest.meta.label.clone(),
        description: String::new(),
        language: manifest.meta.languages.join(","),
        sample_rate: if manifest.family.is_tts() { 0 } else { SAMPLE_RATE as u32 },
        size_bytes: manifest.total_bytes(),
        recommended: false,
        kind: "download".to_string(),
        capability: manifest.family.use_name().to_string(),
        source: "huggingface".to_string(),
        hub: Some(manifest.info()),
    }
}

#[tauri::command]
pub fn speech_list_models(app: AppHandle) -> Vec<SpeechModelManifest> {
    let mut list = catalog_manifests(crate::speech_apple::bridge().is_some());
    if let Ok(root) = models_root(&app) {
        list.extend(installed::list(&root).iter().map(|(_, manifest)| hub_manifest_view(manifest)));
    }
    list
}
```

In `speech_model_states`, after the `TTS_CATALOG` extension:

```rust
    states.extend(installed::list(&root).into_iter().map(|(dir, manifest)| {
        let files: Vec<(&str, u64)> = manifest.files.iter().map(|f| (f.path.as_str(), f.size)).collect();
        let disk = speech_download::disk_state(&dir, &files, installed::is_ready(&dir, &manifest));
        disk_model_state(&state.downloads, &manifest.id, disk, manifest.total_bytes())
    }));
```

- [ ] **Step 6: Download a Hugging Face model**

Add the parameter `hub: State<'_, crate::speech_hub::HubState>,` to `speech_download_model` (after `state`), and right after the Apple branch:

```rust
    if installed::repo_of(&model_id).is_some() {
        return download_hub_model(&app, &state, &hub, &model_id).await;
    }
```

Add:

```rust
/// Downloads every file of a Hugging Face model. A paused download continues the commit and file
/// list of the manifest already on disk; a new one resolves the repo first.
async fn download_hub_model(
    app: &AppHandle,
    state: &SpeechState,
    hub: &crate::speech_hub::HubState,
    model_id: &str,
) -> Result<SpeechModelState, String> {
    let stop = state.downloads.start(model_id)?;
    let _active = ActiveDownload::new(&state.downloads, model_id);
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(app, model_id)?;
    let existing = installed::read(&dir);
    let manifest = match existing {
        Some(found) => found,
        None => {
            let repo = installed::repo_of(model_id).unwrap_or_default();
            let resolved = crate::speech_hub::resolve(hub, repo).await?;
            installed::for_download(None, || installed::from_resolved(&resolved))
        }
    };
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    if !installed::is_ready(&dir, &manifest) {
        installed::write(&dir, &HubManifest { complete: false, ..manifest.clone() })?;
        let files = hub_download_files(&manifest.repo, &manifest.commit, &manifest.files)?;
        let client = crate::speech_hub::hf::client()?;
        download_files(app, &client, model_id, &dir, &files, &stop).await?;
        installed::write(&dir, &HubManifest { complete: true, ..manifest.clone() })?;
    }
    let total = manifest.total_bytes();
    Ok(SpeechModelState {
        id: model_id.to_string(),
        status: "ready".into(),
        progress: Some(1.0),
        error: None,
        downloaded_bytes: Some(total),
        total_bytes: Some(total),
    })
}
```

- [ ] **Step 7: Recognizers and voices from manifests**

Add:

```rust
fn not_downloaded(id: &str) -> String {
    format!("Speech model '{id}' is not downloaded. Open Preferences → Voice and download it.")
}

/// A downloaded Hugging Face model's manifest, or `None`.
fn ready_manifest(dir: &Path) -> Option<HubManifest> {
    installed::read(dir).filter(|m| installed::is_ready(dir, m))
}

/// The folder and recognizer layout of a downloaded local model, or why it cannot run yet.
fn local_stt(app: &AppHandle, model_id: &str) -> Result<(PathBuf, SttLayout), String> {
    let dir = model_dir(app, model_id)?;
    if installed::repo_of(model_id).is_some() {
        return match ready_manifest(&dir).map(|m| m.layout) {
            Some(HubLayout::Stt(layout)) => Ok((dir, layout)),
            Some(HubLayout::Tts(_)) => Err(format!("'{model_id}' is a voice, not a speech recognition model.")),
            None => Err(not_downloaded(model_id)),
        };
    }
    let entry = find_entry(model_id)?;
    if !model_ready(&dir, entry) {
        return Err(not_downloaded(model_id));
    }
    Ok((dir, SttLayout::from(entry.layout)))
}
```

- `enum Engine { Local, Apple { locale: String } }`; in `engine_for` replace the first line with:
  ```rust
  if model_id != APPLE_MODEL_ID {
      if installed::repo_of(model_id).is_none() {
          find_entry(model_id)?;
      }
      return Ok(Engine::Local);
  }
  ```
- In `transcriber_for`:
  ```rust
  Engine::Local => {
      let (dir, layout) = local_stt(app, model_id)?;
      Ok(Box::new(SherpaTranscriber {
          recognizer: state.recognizer_for(&dir, &layout)?,
          whisper: layout.is_whisper(),
      }))
  }
  ```
- In `speech_prepare`, replace the last block (from `let entry = find_entry(&model_id)?;`) with:
  ```rust
  if installed::repo_of(&model_id).is_none() {
      find_entry(&model_id)?;
  }
  match local_stt(&app, &model_id) {
      Ok((dir, layout)) => {
          state.recognizer_for(&dir, &layout)?;
          Ok(true)
      }
      Err(_) => Ok(false),
  }
  ```
- `FallbackStt::Sherpa(String)`; `pick_fallback(apple_locale_ready: Option<String>, ready_sherpa: &[String])` returns `ready_sherpa.first().map(|id| FallbackStt::Sherpa(id.clone()))`. In `fallback_transcriber`:
  ```rust
  let mut ready: Vec<String> = CATALOG
      .iter()
      .filter(|entry| model_ready(&root.join(entry.id), entry))
      .map(|entry| entry.id.to_string())
      .collect();
  ready.extend(
      installed::list(&root)
          .into_iter()
          .filter(|(dir, m)| !m.family.is_tts() && installed::is_ready(dir, m))
          .map(|(_, m)| m.id),
  );
  ```
  and `FallbackStt::Sherpa(id) => transcriber_for(app, state, &id, None).ok().map(|t| (t, id))`.
- `local_tts_model`:
  ```rust
  pub(crate) fn local_tts_model(app: &AppHandle, id: &str) -> Result<(PathBuf, crate::tts_local::TtsLayout), String> {
      let dir = model_dir(app, id)?;
      let missing = || format!("Voice model '{id}' is not downloaded. Open Preferences → Voice.");
      if installed::repo_of(id).is_some() {
          return match ready_manifest(&dir).map(|m| m.layout) {
              Some(HubLayout::Tts(layout)) => Ok((dir, layout)),
              _ => Err(missing()),
          };
      }
      let entry = find_tts_entry(id).ok_or_else(|| format!("Unknown voice model: {id}"))?;
      if !tts_ready(&dir, entry) {
          return Err(missing());
      }
      Ok((dir, crate::tts_local::TtsLayout::piper(entry.model_file)))
  }

  /// Speakers of a downloaded local voice, named when the model's names are known; empty for a
  /// single-voice model or a voice that is not downloaded. Loads the voice on a worker.
  pub(crate) async fn local_tts_voices(app: &AppHandle, id: &str) -> Vec<crate::speech_hub::meta::HubVoice> {
      let Ok((dir, layout)) = local_tts_model(app, id) else {
          return Vec::new();
      };
      let named = ready_manifest(&dir).map(|m| m.meta.voices).unwrap_or_default();
      let reported = tokio::task::spawn_blocking(move || crate::tts_local::num_speakers(&dir, &layout))
          .await
          .ok()
          .and_then(Result::ok)
          .unwrap_or(1);
      crate::speech_hub::meta::voice_list(&named, reported)
  }
  ```
- In `src-tauri/src/tts.rs` `tts_voices`, replace `None if provider == Some(TtsProvider::Local) => Ok(Vec::new()),` with:
  ```rust
  None if provider == Some(TtsProvider::Local) => {
      let Some(id) = model.filter(|m| !m.trim().is_empty()) else {
          return Ok(Vec::new());
      };
      Ok(crate::speech::local_tts_voices(&app, &id)
          .await
          .into_iter()
          .map(|voice| TtsVoice { id: voice.id.to_string(), name: voice.name, language: voice.language })
          .collect())
  }
  ```

- [ ] **Step 8: Run the Rust suite**

Run: `cd src-tauri && cargo test --lib`
Expected: all pass.
Run: `cargo clippy --lib --message-format=short 2>&1 | grep -E "src/speech.rs|src/tts.rs|speech_hub|tts_local"` — must print nothing for lines you touched.

- [ ] **Step 9: Manual check through the dev app (do not restart it; Rust changes rebuild through `tauri dev`)**

Wait for the app to rebuild on its own. Then in the app's devtools console:

```js
const { invoke } = window.__TAURI_INTERNALS__
await invoke('speech_hub_search', { query: { use: 'tts', query: 'pt_BR', language: null, sort: 'likes', offset: 0 } })
await invoke('speech_hub_resolve', { repo: 'csukuangfj/vits-piper-pt_BR-cadu-medium' })
```

Expected: the first returns results including `hf:csukuangfj/vits-piper-pt_BR-cadu-medium`; the second returns `hub.totalBytes` around 80 MB and `hub.fileCount` around 360. If the dev app is not running, skip this step and say so in your report.

- [ ] **Step 10: Leave changes in the working tree** (no commit).

---

### Task 8: Frontend data — wrappers, model info, search hook

**Files:**
- Modify: `src/lib/tauri/speech.ts`, `src/lib/voice/modelInfo.ts`, `src/components/modals/preferences/voice/TierDots.tsx`, `voice/useModelDownloads.ts`, `voice/useSpeechInventory.ts`, the 3 locale files
- Create: `src/lib/voice/hubModels.ts`, `src/lib/voice/hubModels.test.ts`, `voice/useHubSearch.ts`, `voice/useHubSearch.test.ts`

**Interfaces:**
- Consumes: commands from Tasks 5 and 7.
- Produces:
  ```ts
  // speech.ts
  export type HubFamily = 'vits' | 'kokoro' | 'kitten' | 'transducer' | 'nemo-transducer' | 'whisper' | 'moonshine' | 'sense-voice' | 'paraformer' | 'nemo-ctc' | 'dolphin'
  export type HubModelInfo = { repo: string; commit: string | null; family: HubFamily; languages: string[]; languageCount: number | null; multilingual: boolean; speed: number | null; accuracy: number | null; voiceCount: number | null; license: string | null; lastModified: string | null; likes: number; fileCount: number | null; totalBytes: number | null }
  SpeechModelManifest += { source?: 'catalog' | 'huggingface'; hub?: HubModelInfo }
  export type HubSearchResult = { id: string; use: 'stt' | 'tts'; label: string; hub: HubModelInfo }
  export type HubSearchQuery = { use: 'stt' | 'tts' | null; query: string; language: string | null; sort: 'likes' | 'recent'; offset: number }
  export type HubSearchPage = { results: HubSearchResult[]; hasMore: boolean }
  export function speechHubSearch(query: HubSearchQuery): Promise<HubSearchPage>
  export function speechHubResolve(repo: string): Promise<HubSearchResult>
  // modelInfo.ts
  ModelInfo += { estimated?: boolean; voiceCount?: number; multilingual?: boolean }
  export function rememberHubModels(models: { id: string; capability?: 'stt' | 'tts'; hub?: HubModelInfo | null }[]): void
  // modelInfoFor(id) now also answers for remembered hf: ids
  // hubModels.ts
  export function hubModelInfo(id: string, use: ModelUse, hub: HubModelInfo): ModelInfo
  export function hubErrorKey(message: string): MessageKey | null
  export function hubSourceUrl(repo: string): string
  // useHubSearch.ts
  export function useHubSearch(params: { use: 'stt' | 'tts' | null; query: string; language: string | null; sort: 'likes' | 'recent' }): {
    results: SpeechModelManifest[]; status: 'idle' | 'loading' | 'ready' | 'error'; error: MessageKey | null;
    hasMore: boolean; loadMore: () => void; retry: () => void; resolving: ReadonlySet<string> }
  ```

- [ ] **Step 1: i18n keys**

Add to `src/lib/i18n/messages/en.ts` near the other `prefs.voice*` keys, and the same keys with the translations below to `pt-BR.ts` and `zh-CN.ts`:

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceLocalModeInstalled` | Installed | Instalados | 已安装 |
| `prefs.voiceLocalModeSearch` | Search Hugging Face | Buscar no Hugging Face | 搜索 Hugging Face |
| `prefs.voiceHubIntro` | Models converted to run offline on this computer. Estimates are marked ≈. | Modelos convertidos para rodar offline neste computador. Estimativas marcadas com ≈. | 已转换为可在本机离线运行的模型。估计值以 ≈ 标记。 |
| `prefs.voiceHubSearchPlaceholder` | Search models (pt, kokoro, whisper…) | Buscar modelos (pt, kokoro, whisper…) | 搜索模型（pt、kokoro、whisper…） |
| `prefs.voiceHubLanguage` | Language | Idioma | 语言 |
| `prefs.voiceHubLanguageAny` | Any language | Qualquer idioma | 任意语言 |
| `prefs.voiceHubSort` | Sort | Ordenar | 排序 |
| `prefs.voiceHubSortLikes` | Most liked | Mais curtidos | 最多点赞 |
| `prefs.voiceHubSortRecent` | Recently updated | Atualizados recentemente | 最近更新 |
| `prefs.voiceHubLoadMore` | Load more | Carregar mais | 加载更多 |
| `prefs.voiceHubLoading` | Searching Hugging Face… | Buscando no Hugging Face… | 正在搜索 Hugging Face… |
| `prefs.voiceHubEmpty` | No compatible models found. | Nenhum modelo compatível encontrado. | 未找到兼容的模型。 |
| `prefs.voiceHubOffline` | Can't reach Hugging Face. Check your connection. | Não foi possível acessar o Hugging Face. Verifique sua conexão. | 无法连接 Hugging Face，请检查网络连接。 |
| `prefs.voiceHubRateLimited` | Hugging Face is limiting requests. Try again in a few minutes. | O Hugging Face está limitando requisições. Tente de novo em alguns minutos. | Hugging Face 正在限制请求，请几分钟后重试。 |
| `prefs.voiceHubFailed` | Hugging Face returned an unexpected response. | O Hugging Face retornou uma resposta inesperada. | Hugging Face 返回了意外的响应。 |
| `prefs.voiceHubIncompatible` | This model cannot run in Alethe. | Este modelo não roda no Alethe. | 此模型无法在 Alethe 中运行。 |
| `prefs.voiceHubTooLarge` | This model is too large to download here. | Este modelo é grande demais para baixar aqui. | 此模型过大，无法在此下载。 |
| `prefs.voiceHubUnavailable` | This model is no longer available. | Este modelo não está mais disponível. | 此模型已不再提供。 |
| `prefs.voiceHubBadge` | Hugging Face | Hugging Face | Hugging Face |
| `prefs.voiceHubMoreModels` | More models | Mais modelos | 更多模型 |
| `prefs.voiceColLikes` | Likes | Curtidas | 点赞 |
| `prefs.voiceTierEstimated` | Estimated from the model family and size | Estimado pela família e tamanho do modelo | 根据模型系列和大小估计 |
| `prefs.voiceHubFiles` | {count} files · {size} to download | {count} arquivos · {size} para baixar | {count} 个文件 · 需下载 {size} |
| `prefs.voiceHubResolving` | Checking files… | Verificando arquivos… | 正在检查文件… |
| `prefs.voiceHubLicense` | License | Licença | 许可证 |
| `prefs.voiceHubAuthor` | Author | Autor | 作者 |
| `prefs.voiceHubUpdated` | Updated | Atualizado | 更新于 |
| `prefs.voiceHubCommit` | Version | Versão | 版本 |
| `prefs.voiceHubUnknown` | Unknown | Desconhecida | 未知 |
| `prefs.voiceHubOpen` | Open on Hugging Face | Abrir no Hugging Face | 在 Hugging Face 上打开 |
| `prefs.voiceModelLanguagesMulti` | Multiple languages | Vários idiomas | 多种语言 |
| `voice.family.vits.summary` | Piper/VITS voice: light and fast, runs on any CPU. | Voz Piper/VITS: leve e rápida, roda em qualquer CPU. | Piper/VITS 语音：轻量快速，任何 CPU 都能运行。 |
| `voice.family.vits.details` | One voice per model in most cases. Low and medium quality voices sound synthetic; high quality voices are clearer but slower. | Na maioria dos casos, uma voz por modelo. Vozes de qualidade baixa e média soam sintéticas; as de qualidade alta são mais claras, porém mais lentas. | 大多数模型只有一个音色。低、中质量的语音听起来较机械；高质量语音更清晰但更慢。 |
| `voice.family.kokoro.summary` | Kokoro: the most natural local voices, many speakers in one model. | Kokoro: as vozes locais mais naturais, várias vozes em um modelo. | Kokoro：最自然的本地语音，一个模型包含多个音色。 |
| `voice.family.kokoro.details` | About 330 MB. Version 1.0 speaks English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese and Chinese. Slower than Piper on older CPUs. | Cerca de 330 MB. A versão 1.0 fala inglês, espanhol, francês, hindi, italiano, japonês, português do Brasil e chinês. Mais lenta que o Piper em CPUs antigas. | 约 330 MB。1.0 版支持英语、西班牙语、法语、印地语、意大利语、日语、巴西葡萄牙语和中文。在较旧的 CPU 上比 Piper 慢。 |
| `voice.family.kitten.summary` | Kitten: a tiny English voice model with eight speakers. | Kitten: modelo de voz em inglês minúsculo, com oito vozes. | Kitten：极小的英语语音模型，包含八个音色。 |
| `voice.family.kitten.details` | Very small and fast; quality is below Piper medium. | Muito pequeno e rápido; qualidade abaixo do Piper médio. | 非常小且快速；质量低于 Piper 中等质量。 |
| `voice.family.transducer.summary` | Zipformer: fast, accurate recognition for the languages it was trained on. | Zipformer: reconhecimento rápido e preciso nos idiomas em que foi treinado. | Zipformer：在其训练语言上快速、准确地识别。 |
| `voice.family.transducer.details` | Each model covers one language or a small set. Good for dictation on any CPU. | Cada modelo cobre um idioma ou poucos. Bom para ditado em qualquer CPU. | 每个模型覆盖一种或少数几种语言。适合在任何 CPU 上听写。 |
| `voice.family.nemoTransducer.summary` | NVIDIA NeMo transducer (Parakeet): high accuracy with punctuation. | Transducer NVIDIA NeMo (Parakeet): alta precisão, com pontuação. | NVIDIA NeMo Transducer（Parakeet）：高准确度，带标点。 |
| `voice.family.nemoTransducer.details` | Larger and slower than Zipformer, more accurate. Multilingual versions detect the language. | Maior e mais lento que o Zipformer, porém mais preciso. Versões multilíngues detectam o idioma. | 比 Zipformer 更大更慢，但更准确。多语言版本可自动识别语言。 |
| `voice.family.whisper.summary` | OpenAI Whisper: many languages; accuracy grows with size. | OpenAI Whisper: muitos idiomas; a precisão cresce com o tamanho. | OpenAI Whisper：支持多种语言，模型越大越准确。 |
| `voice.family.whisper.details` | Tiny and base are quick but make more mistakes; turbo and large are accurate but heavy. Audio is processed in 28-second windows. | Tiny e base são rápidos, mas erram mais; turbo e large são precisos, porém pesados. O áudio é processado em janelas de 28 segundos. | tiny 和 base 速度快但错误较多；turbo 和 large 准确但占用资源多。音频按 28 秒窗口处理。 |
| `voice.family.moonshine.summary` | Moonshine: quick English recognition for short commands. | Moonshine: reconhecimento rápido em inglês para comandos curtos. | Moonshine：快速识别英语短指令。 |
| `voice.family.moonshine.details` | Small and fast; best for short phrases. | Pequeno e rápido; melhor para frases curtas. | 小巧快速；最适合短句。 |
| `voice.family.senseVoice.summary` | SenseVoice: fast recognition for Chinese, English, Japanese, Korean and Cantonese. | SenseVoice: reconhecimento rápido para chinês, inglês, japonês, coreano e cantonês. | SenseVoice：快速识别中文、英语、日语、韩语和粤语。 |
| `voice.family.senseVoice.details` | Detects the language and adds punctuation. | Detecta o idioma e adiciona pontuação. | 自动识别语言并添加标点。 |
| `voice.family.paraformer.summary` | Paraformer: very fast recognition, mostly Chinese and English. | Paraformer: reconhecimento muito rápido, principalmente chinês e inglês. | Paraformer：识别速度很快，主要支持中文和英语。 |
| `voice.family.paraformer.details` | Very fast on CPU; check the languages before choosing it. | Muito rápido em CPU; confira os idiomas antes de escolher. | 在 CPU 上非常快；选择前请确认支持的语言。 |
| `voice.family.nemoCtc.summary` | NVIDIA NeMo CTC: simple and fast recognition. | NVIDIA NeMo CTC: reconhecimento simples e rápido. | NVIDIA NeMo CTC：简单快速的识别。 |
| `voice.family.nemoCtc.details` | Faster than transducers, usually less accurate. | Mais rápido que transducers, geralmente menos preciso. | 比 Transducer 更快，但通常准确度较低。 |
| `voice.family.dolphin.summary` | Dolphin: recognition for Eastern languages and Chinese dialects. | Dolphin: reconhecimento para idiomas orientais e dialetos chineses. | Dolphin：识别东方语言和中文方言。 |
| `voice.family.dolphin.details` | Covers about 40 Asian languages. | Cobre cerca de 40 idiomas asiáticos. | 覆盖约 40 种亚洲语言。 |

- [ ] **Step 2: Tauri wrappers**

In `src/lib/tauri/speech.ts`, extend `SpeechModelManifest` with:

```ts
  /** `huggingface` for a model downloaded from the search; absent on older backends. */
  source?: 'catalog' | 'huggingface'
  hub?: HubModelInfo
```

and add (above `speechListModels`):

```ts
export type HubFamily =
  | 'vits'
  | 'kokoro'
  | 'kitten'
  | 'transducer'
  | 'nemo-transducer'
  | 'whisper'
  | 'moonshine'
  | 'sense-voice'
  | 'paraformer'
  | 'nemo-ctc'
  | 'dolphin'

export type HubModelInfo = {
  repo: string
  /** Pinned once the repo's files were checked. */
  commit: string | null
  family: HubFamily
  languages: string[]
  languageCount: number | null
  multilingual: boolean
  /** Estimated 1–3 tiers. */
  speed: number | null
  accuracy: number | null
  voiceCount: number | null
  license: string | null
  lastModified: string | null
  likes: number
  fileCount: number | null
  totalBytes: number | null
}

export type HubSearchResult = { id: string; use: 'stt' | 'tts'; label: string; hub: HubModelInfo }
export type HubSearchQuery = {
  use: 'stt' | 'tts' | null
  query: string
  language: string | null
  sort: 'likes' | 'recent'
  offset: number
}
export type HubSearchPage = { results: HubSearchResult[]; hasMore: boolean }

/** Rejection codes of the Hugging Face commands. */
export const HUB_ERROR = {
  offline: 'hub_offline',
  rateLimited: 'hub_rate_limited',
  unavailable: 'hub_unavailable',
  badResponse: 'hub_bad_response',
  incompatible: 'hub_incompatible',
  tooLarge: 'hub_too_large',
  gated: 'hub_gated',
  unknownRepo: 'hub_unknown_repo',
} as const

export async function speechHubSearch(query: HubSearchQuery): Promise<HubSearchPage> {
  return invoke('speech_hub_search', { query })
}

/** Pins the repo's current commit and returns the exact files and size to download. */
export async function speechHubResolve(repo: string): Promise<HubSearchResult> {
  return invoke('speech_hub_resolve', { repo })
}
```

- [ ] **Step 3: Write the failing tests for `hubModels.ts`**

Create `src/lib/voice/hubModels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { HubModelInfo } from '../tauri'
import { hubErrorKey, hubModelInfo, hubSourceUrl } from './hubModels'
import { modelInfoFor, rememberHubModels } from './modelInfo'

const hub = (extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo: 'csukuangfj/vits-piper-pt_BR-cadu-medium',
  commit: null,
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: null,
  lastModified: null,
  likes: 0,
  fileCount: null,
  totalBytes: null,
  ...extra,
})

describe('hubModelInfo', () => {
  it('marks tiers as estimated and uses the family texts', () => {
    const info = hubModelInfo('hf:csukuangfj/vits-piper-pt_BR-cadu-medium', 'tts', hub())
    expect(info).toMatchObject({
      use: 'tts',
      languages: ['pt-BR'],
      speed: 3,
      accuracy: 2,
      estimated: true,
      summary: 'voice.family.vits.summary',
      details: 'voice.family.vits.details',
      sourceUrl: 'https://huggingface.co/csukuangfj/vits-piper-pt_BR-cadu-medium',
    })
  })

  it('curated overrides drop the estimate marker', () => {
    const info = hubModelInfo('hf:csukuangfj/kokoro-multi-lang-v1_0', 'tts', hub({ family: 'kokoro', repo: 'csukuangfj/kokoro-multi-lang-v1_0' }))
    expect(info.estimated).toBe(false)
    expect(info.summary).toBe('voice.family.kokoro.summary')
  })

  it('ignores tiers outside 1–3', () => {
    const info = hubModelInfo('hf:x/y', 'stt', hub({ family: 'whisper', speed: null, accuracy: 7 }))
    expect(info.speed).toBeUndefined()
    expect(info.accuracy).toBeUndefined()
  })
})

describe('rememberHubModels', () => {
  it('lets modelInfoFor answer for hf ids', () => {
    expect(modelInfoFor('hf:csukuangfj/a')).toBeNull()
    rememberHubModels([{ id: 'hf:csukuangfj/a', capability: 'stt', hub: hub({ family: 'whisper', repo: 'csukuangfj/a' }) }])
    expect(modelInfoFor('hf:csukuangfj/a')?.summary).toBe('voice.family.whisper.summary')
    expect(modelInfoFor('parakeet-tdt-0.6b-v3-int8')?.estimated).toBeUndefined()
  })
})

describe('hubErrorKey', () => {
  it('search_error_kinds_map_to_messages', () => {
    expect(hubErrorKey('hub_offline')).toBe('prefs.voiceHubOffline')
    expect(hubErrorKey('hub_rate_limited')).toBe('prefs.voiceHubRateLimited')
    expect(hubErrorKey('hub_incompatible')).toBe('prefs.voiceHubIncompatible')
    expect(hubErrorKey('hub_too_large')).toBe('prefs.voiceHubTooLarge')
    expect(hubErrorKey('hub_unknown_repo')).toBe('prefs.voiceHubUnavailable')
    expect(hubErrorKey('hub_bad_response')).toBe('prefs.voiceHubFailed')
    expect(hubErrorKey('something else')).toBeNull()
  })

  it('builds the repo page url', () => {
    expect(hubSourceUrl('k2-fsa/x')).toBe('https://huggingface.co/k2-fsa/x')
  })
})
```

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run src/lib/voice/hubModels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `hubModels.ts` and the registry**

Create `src/lib/voice/hubModels.ts`:

```ts
import type { MessageKey } from '../i18n'
import { HUB_ERROR, type HubFamily, type HubModelInfo } from '../tauri'
import type { ModelInfo, ModelUse, Tier } from './modelInfo'

const FAMILY_TEXT: Record<HubFamily, { summary: MessageKey; details: MessageKey }> = {
  vits: { summary: 'voice.family.vits.summary', details: 'voice.family.vits.details' },
  kokoro: { summary: 'voice.family.kokoro.summary', details: 'voice.family.kokoro.details' },
  kitten: { summary: 'voice.family.kitten.summary', details: 'voice.family.kitten.details' },
  transducer: { summary: 'voice.family.transducer.summary', details: 'voice.family.transducer.details' },
  'nemo-transducer': {
    summary: 'voice.family.nemoTransducer.summary',
    details: 'voice.family.nemoTransducer.details',
  },
  whisper: { summary: 'voice.family.whisper.summary', details: 'voice.family.whisper.details' },
  moonshine: { summary: 'voice.family.moonshine.summary', details: 'voice.family.moonshine.details' },
  'sense-voice': { summary: 'voice.family.senseVoice.summary', details: 'voice.family.senseVoice.details' },
  paraformer: { summary: 'voice.family.paraformer.summary', details: 'voice.family.paraformer.details' },
  'nemo-ctc': { summary: 'voice.family.nemoCtc.summary', details: 'voice.family.nemoCtc.details' },
  dolphin: { summary: 'voice.family.dolphin.summary', details: 'voice.family.dolphin.details' },
}

/** Curated tiers for popular repos (spec §6); they replace the estimates. */
const HUB_OVERRIDES: Record<string, Pick<ModelInfo, 'speed' | 'accuracy'>> = {
  'hf:csukuangfj/kokoro-multi-lang-v1_0': { speed: 2, accuracy: 3 },
  'hf:csukuangfj/vits-piper-pt_BR-cadu-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/vits-piper-pt_BR-jeff-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/vits-piper-pt_BR-faber-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/sherpa-onnx-whisper-turbo': { speed: 2, accuracy: 3 },
  'hf:csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17': { speed: 3, accuracy: 2 },
}

const tier = (value: number | null): Tier | undefined =>
  value === 1 || value === 2 || value === 3 ? value : undefined

export function hubSourceUrl(repo: string): string {
  return `https://huggingface.co/${repo}`
}

export function hubModelInfo(id: string, use: ModelUse, hub: HubModelInfo): ModelInfo {
  const override = HUB_OVERRIDES[id]
  return {
    id,
    use,
    languages: hub.languages,
    languageCount: hub.languageCount ?? undefined,
    multilingual: hub.multilingual,
    speed: override?.speed ?? tier(hub.speed),
    accuracy: override?.accuracy ?? tier(hub.accuracy),
    estimated: override === undefined,
    voiceCount: hub.voiceCount ?? undefined,
    ...FAMILY_TEXT[hub.family],
    sourceUrl: hubSourceUrl(hub.repo),
  }
}

const ERROR_KEYS: Record<string, MessageKey> = {
  [HUB_ERROR.offline]: 'prefs.voiceHubOffline',
  [HUB_ERROR.rateLimited]: 'prefs.voiceHubRateLimited',
  [HUB_ERROR.unavailable]: 'prefs.voiceHubOffline',
  [HUB_ERROR.badResponse]: 'prefs.voiceHubFailed',
  [HUB_ERROR.incompatible]: 'prefs.voiceHubIncompatible',
  [HUB_ERROR.tooLarge]: 'prefs.voiceHubTooLarge',
  [HUB_ERROR.gated]: 'prefs.voiceHubUnavailable',
  [HUB_ERROR.unknownRepo]: 'prefs.voiceHubUnavailable',
}

/** The message for a Hugging Face rejection code; `null` for anything else. */
export function hubErrorKey(message: string): MessageKey | null {
  return ERROR_KEYS[message.trim()] ?? null
}
```

In `src/lib/voice/modelInfo.ts`:
- Add to `ModelInfo`:
  ```ts
    /** Tiers estimated from family and size (Hugging Face models without a curated entry). */
    estimated?: boolean
    voiceCount?: number
    /** Covers many languages without listing them. */
    multilingual?: boolean
  ```
- Add imports `import type { HubModelInfo } from '../tauri'` and `import { hubModelInfo } from './hubModels'`.
- Replace `modelInfoFor` and add the registry:
  ```ts
  /** Info of Hugging Face models seen in the latest listing or search, by id. */
  const HUB_INFO = new Map<string, ModelInfo>()

  export function rememberHubModels(
    models: { id: string; capability?: ModelUse; hub?: HubModelInfo | null }[],
  ): void {
    for (const model of models) {
      if (model.hub) HUB_INFO.set(model.id, hubModelInfo(model.id, model.capability ?? 'stt', model.hub))
    }
  }

  export function modelInfoFor(id: string): ModelInfo | null {
    return MODEL_INFO[id] ?? HUB_INFO.get(id) ?? null
  }
  ```
- In `languagesLabel`, before the `count > LISTED_LANGUAGES` check: `if (info.multilingual && info.languages.length === 0) return t('prefs.voiceModelLanguagesMulti')`.

Call `rememberHubModels(catalog)` in `useModelDownloads.refresh` right before `setModels(catalog)`, and in `useSpeechInventory.ts` right before its `setModels(catalog)`.

- [ ] **Step 6: Estimated marker on `TierDots`**

```tsx
/** A 1–3 tier as three dots; "≈" marks an estimate; "—" when the model has no tier. */
export function TierDots({ tier, label, estimated }: { tier?: Tier; label: string; estimated?: boolean }) {
  const t = useT()
  if (!tier) return <span className={styles.none}>—</span>
  return (
    <span
      className={styles.dots}
      role="img"
      aria-label={t('prefs.voiceTierLabel', { label, tier })}
      title={t(estimated ? 'prefs.voiceTierEstimated' : 'prefs.voiceTierSource')}
    >
      {estimated ? (
        <span className={styles.estimate} aria-hidden="true">
          ≈
        </span>
      ) : null}
      {LEVELS.map((level) => (
        <span key={level} className={styles.dot} data-filled={level <= tier} />
      ))}
    </span>
  )
}
```

In `TierDots.module.css` add:

```css
.estimate {
  color: var(--fg-muted);
  margin-right: 2px;
  line-height: 1;
}
```

(If `--fg-muted` is not defined in `src/styles/theme.css`, use the muted text token the file already uses for `.none`.)

Pass `estimated={info?.estimated}` in every `TierDots` use: `LocalModelsView.tsx` (both columns) and `ModelSummaryLine.tsx` (both metrics).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/voice/hubModels.test.ts src/lib/voice/modelInfo.test.ts && npx tsc --noEmit -p .`
Expected: PASS; no type errors.

- [ ] **Step 8: Write the failing tests for `useHubSearch`**

Create `src/components/modals/preferences/voice/useHubSearch.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubModelInfo, HubSearchResult } from '../../../../lib/tauri'
import { useHubSearch } from './useHubSearch'

const tauri = vi.hoisted(() => ({
  speechHubSearch: vi.fn(),
  speechHubResolve: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))

const info = (repo: string, extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo,
  commit: null,
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: null,
  lastModified: null,
  likes: 1,
  fileCount: null,
  totalBytes: null,
  ...extra,
})
const result = (repo: string): HubSearchResult => ({ id: `hf:${repo}`, use: 'tts', label: repo, hub: info(repo) })
const params = { use: 'tts' as const, query: '', language: null, sort: 'likes' as const }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  tauri.speechHubSearch.mockResolvedValue({ results: [result('csukuangfj/a'), result('csukuangfj/b')], hasMore: true })
  tauri.speechHubResolve.mockImplementation(async (repo: string) => ({
    ...result(repo),
    hub: info(repo, { commit: 'c'.repeat(40), totalBytes: 80_000_000, fileCount: 360 }),
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useHubSearch', () => {
  it('searches after the debounce and returns manifests', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    expect(tauri.speechHubSearch).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    expect(tauri.speechHubSearch).toHaveBeenCalledWith({ ...params, offset: 0 })
    expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a', 'hf:csukuangfj/b'])
    expect(hook.current.results[0]).toMatchObject({ kind: 'download', capability: 'tts', source: 'huggingface' })
  })

  it('resolves rows in the background and fills in the size', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.results[0]?.sizeBytes).toBe(80_000_000))
    expect(hook.current.results[0].hub?.fileCount).toBe(360)
    expect(tauri.speechHubResolve).toHaveBeenCalledWith('csukuangfj/a')
  })

  it('drops a row whose repo turns out incompatible', async () => {
    tauri.speechHubResolve.mockImplementation(async (repo: string) => {
      if (repo === 'csukuangfj/b') throw 'hub_incompatible'
      return result(repo)
    })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a']))
  })

  it('a one-letter query searches like an empty one', async () => {
    renderHook(() => useHubSearch({ ...params, query: 'k' }))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(tauri.speechHubSearch).toHaveBeenCalledWith({ ...params, query: '', offset: 0 }))
  })

  it('reports the error kind and retries', async () => {
    tauri.speechHubSearch.mockRejectedValueOnce('hub_rate_limited')
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('error'))
    expect(hook.current.error).toBe('prefs.voiceHubRateLimited')
    act(() => hook.current.retry())
    await waitFor(() => expect(hook.current.status).toBe('ready'))
  })

  it('load more appends the next page', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    tauri.speechHubSearch.mockResolvedValueOnce({ results: [result('csukuangfj/c')], hasMore: false })
    act(() => hook.current.loadMore())
    await waitFor(() => expect(hook.current.results).toHaveLength(3))
    expect(tauri.speechHubSearch).toHaveBeenLastCalledWith({ ...params, offset: 2 })
    expect(hook.current.hasMore).toBe(false)
  })
})
```

- [ ] **Step 9: Run to verify they fail**

Run: `npx vitest run src/components/modals/preferences/voice/useHubSearch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 10: Implement `useHubSearch.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

import type { MessageKey } from '../../../../lib/i18n'
import {
  HUB_ERROR,
  type HubSearchResult,
  speechHubResolve,
  speechHubSearch,
  type SpeechModelManifest,
} from '../../../../lib/tauri'
import { hubErrorKey } from '../../../../lib/voice/hubModels'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'

const DEBOUNCE_MS = 400
const MIN_QUERY = 2
/** Repos checked at once; each check is 2–3 API calls. */
const RESOLVE_CONCURRENCY = 3

type Params = {
  use: 'stt' | 'tts' | null
  query: string
  language: string | null
  sort: 'likes' | 'recent'
}

export type HubSearchStatus = 'idle' | 'loading' | 'ready' | 'error'

function toManifest(result: HubSearchResult): SpeechModelManifest {
  return {
    id: result.id,
    label: result.label,
    description: '',
    language: result.hub.languages.join(','),
    sampleRate: 0,
    sizeBytes: result.hub.totalBytes ?? 0,
    recommended: false,
    kind: 'download',
    capability: result.use,
    source: 'huggingface',
    hub: result.hub,
  }
}

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * Hugging Face search for the Local models table: debounced, paged, and each result's exact files
 * checked in the background so its size shows and an incompatible repo drops out.
 */
export function useHubSearch(params: Params) {
  const query = params.query.trim().length >= MIN_QUERY ? params.query.trim() : ''
  const key = JSON.stringify({ ...params, query })
  const [results, setResults] = useState<SpeechModelManifest[]>([])
  const [status, setStatus] = useState<HubSearchStatus>('idle')
  const [error, setError] = useState<MessageKey | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [resolving, setResolving] = useState<ReadonlySet<string>>(() => new Set())
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)

  const resolveAll = useCallback((list: SpeechModelManifest[], current: number) => {
    const pending = list.filter((model) => model.hub && model.hub.commit === null)
    if (pending.length === 0) return
    setResolving((all) => new Set([...all, ...pending.map((model) => model.id)]))
    let next = 0
    const worker = async () => {
      while (next < pending.length) {
        const model = pending[next++]
        try {
          const found = await speechHubResolve(model.hub!.repo)
          if (generation.current !== current) return
          const manifest = toManifest(found)
          rememberHubModels([manifest])
          setResults((all) => all.map((entry) => (entry.id === manifest.id ? manifest : entry)))
        } catch (cause) {
          if (generation.current !== current) return
          const message = reason(cause)
          if (message === HUB_ERROR.incompatible || message === HUB_ERROR.tooLarge || message === HUB_ERROR.gated) {
            setResults((all) => all.filter((entry) => entry.id !== model.id))
          }
        } finally {
          if (generation.current === current) {
            setResolving((all) => {
              const rest = new Set(all)
              rest.delete(model.id)
              return rest
            })
          }
        }
      }
    }
    for (let i = 0; i < RESOLVE_CONCURRENCY; i++) void worker()
  }, [])

  const run = useCallback(
    async (offset: number, current: number) => {
      setStatus('loading')
      setError(null)
      try {
        const page = await speechHubSearch({ ...params, query, offset })
        if (generation.current !== current) return
        const manifests = page.results.map(toManifest)
        rememberHubModels(manifests)
        setResults((all) => (offset === 0 ? manifests : [...all, ...manifests]))
        setHasMore(page.hasMore)
        setStatus('ready')
        resolveAll(manifests, current)
      } catch (cause) {
        if (generation.current !== current) return
        setError(hubErrorKey(reason(cause)) ?? 'prefs.voiceHubFailed')
        setStatus('error')
      }
    },
    // `key` captures every param that changes the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, resolveAll],
  )

  useEffect(() => {
    const current = ++generation.current
    setResults([])
    setResolving(new Set())
    const timer = setTimeout(() => void run(0, current), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [run, attempt])

  return {
    results,
    status,
    error,
    hasMore,
    resolving,
    loadMore: () => {
      if (status === 'loading' || !hasMore) return
      void run(results.length, generation.current)
    },
    retry: () => setAttempt((n) => n + 1),
  }
}
```

- [ ] **Step 11: Run the tests**

Run: `npx vitest run src/components/modals/preferences/voice/useHubSearch.test.ts && npx tsc --noEmit -p .`
Expected: PASS. If `load more` sees offset 0 instead of 2, check that `loadMore` reads `results.length` after the first page has been set.

- [ ] **Step 12: Leave changes in the working tree** (no commit).

---

### Task 9: Search mode in Local models

**Files:**
- Modify: `voice/ModelTable.tsx` (+ `ModelTable.module.css`), `voice/LocalModelsView.tsx` (+ `LocalModelsView.module.css`, `LocalModelsView.test.tsx`), `voice/ProviderDetail.tsx`, `voice/VoicePage.tsx`
- Create: `voice/HubSearchControls.tsx` (+ `.module.css`), `voice/HubDetails.tsx` (+ `.module.css`), `voice/LocalVoiceSelect.tsx`

**Interfaces:**
- Consumes: `useHubSearch`, `hubModelInfo`/`modelInfoFor`, `TierDots estimated`, `ttsVoices('local', id)`, `withTtsChoice`.
- Produces:
  ```ts
  TableColumn += 'likes';  TableRow += { badge?: string }
  export function LocalModelsView({ initialFilter, initialMode }: { initialFilter?: Filter; initialMode?: 'installed' | 'search' })
  export function HubSearchControls(props: { language: string | null; sort: 'likes' | 'recent'; onLanguage: (v: string | null) => void; onSort: (v: 'likes' | 'recent') => void })
  export function HubDetails({ hub, resolving }: { hub: HubModelInfo; resolving: boolean })
  export function LocalVoiceSelect({ modelId }: { modelId: string })
  ProviderDetail += initialMode?: 'installed' | 'search'
  ```

- [ ] **Step 1: Write the failing tests**

In `LocalModelsView.test.tsx`: add `vi.mock('./useHubSearch')` at the top, import `{ useHubSearch }` from `'./useHubSearch'`, add `ttsVoices: vi.fn().mockResolvedValue([])` to the hoisted `tauri` object, and add a helper plus tests:

```ts
import type { HubModelInfo } from '../../../../lib/tauri'
import { useHubSearch } from './useHubSearch'

const hubInfo = (repo: string, extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo,
  commit: 'c'.repeat(40),
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: 'mit',
  lastModified: '2023-11-29T12:36:17.000Z',
  likes: 6,
  fileCount: 360,
  totalBytes: 80_000_000,
  ...extra,
})

function mockSearch(results: SpeechModelManifest[], extra: Partial<ReturnType<typeof useHubSearch>> = {}) {
  vi.mocked(useHubSearch).mockReturnValue({
    results,
    status: 'ready',
    error: null,
    hasMore: false,
    resolving: new Set(),
    loadMore: vi.fn(),
    retry: vi.fn(),
    ...extra,
  })
}

const EDRESSON = 'hf:csukuangfj/vits-piper-pt_BR-edresson-low'
const edressonManifest = manifest(EDRESSON, 'tts', {
  label: 'Piper · Edresson (pt-BR, low)',
  source: 'huggingface',
  hub: hubInfo('csukuangfj/vits-piper-pt_BR-edresson-low'),
  sizeBytes: 80_000_000,
})

describe('Hugging Face search mode', () => {
  beforeEach(() => {
    mockHook([manifest(PIPER, 'tts')], {})
    mockSearch([edressonManifest])
  })

  it('switches to search and lists results with likes and the estimate marker', () => {
    render(<LocalModelsView />)
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceLocalModeSearch' }))
    const row = rowOf('Piper · Edresson')
    expect(within(row).getByText('6')).toBeTruthy()
    // Edresson has no curated override, so both tiers carry the estimate marker.
    expect(within(row).getAllByTitle('prefs.voiceTierEstimated').length).toBe(2)
    expect(within(row).getByRole('button', { name: 'prefs.voiceActionDownload' })).toBeTruthy()
  })

  it('downloads a result through the shared download hook', () => {
    render(<LocalModelsView initialMode="search" />)
    fireEvent.click(within(rowOf('Piper · Edresson')).getByRole('button', { name: 'prefs.voiceActionDownload' }))
    expect(actions.download).toHaveBeenCalledWith(EDRESSON)
  })

  it('shows the size as pending while the files are checked', () => {
    mockSearch([{ ...edressonManifest, sizeBytes: 0, hub: hubInfo('csukuangfj/vits-piper-pt_BR-edresson-low', { commit: null, totalBytes: null }) }], {
      resolving: new Set([EDRESSON]),
    })
    render(<LocalModelsView initialMode="search" />)
    expect(within(rowOf('Piper · Edresson')).getByText('…')).toBeTruthy()
  })

  it('details show license, files and the Hugging Face link', () => {
    render(<LocalModelsView initialMode="search" />)
    fireEvent.click(screen.getByRole('button', { name: /Piper · Edresson/ }))
    expect(screen.getByText('mit')).toBeTruthy()
    expect(screen.getByText(/prefs.voiceHubFiles/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /prefs.voiceHubOpen/ }))
    expect(tauri.openInBrowser).toHaveBeenCalledWith('https://huggingface.co/csukuangfj/vits-piper-pt_BR-edresson-low')
  })

  it('installed_mode_works_while_search_fails', () => {
    mockSearch([], { status: 'error', error: 'prefs.voiceHubOffline' })
    render(<LocalModelsView initialMode="search" />)
    expect(screen.getByRole('alert').textContent).toContain('prefs.voiceHubOffline')
    fireEvent.click(screen.getByRole('button', { name: 'prefs.voiceLocalModeInstalled' }))
    expect(rowOf(PIPER)).toBeTruthy()
  })

  it('a downloaded Hugging Face model shows in Installed with a badge', () => {
    mockHook([manifest(PIPER, 'tts'), edressonManifest], { [EDRESSON]: { kind: 'ready' } })
    render(<LocalModelsView />)
    expect(within(rowOf('Piper · Edresson')).getByText('prefs.voiceHubBadge')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/modals/preferences/voice/LocalModelsView.test.tsx`
Expected: the new tests FAIL (no mode buttons, no likes column); existing tests still pass.

- [ ] **Step 3: `ModelTable` — likes column and badge**

In `ModelTable.tsx`:
- `export type TableColumn = 'languages' | 'speed' | 'accuracy' | 'size' | 'voices' | 'price' | 'likes' | 'status'`
- `COLUMN_LABEL.likes = 'prefs.voiceColLikes'`
- `TableRow` gains `/** Short tag after the name, e.g. the model's source. */ badge?: string`
- Where the row name is rendered (the toggle button's text), render after the name:
  ```tsx
  {row.badge ? <span className={styles.badge}>{row.badge}</span> : null}
  ```
In `ModelTable.module.css`:
```css
.badge {
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
```
(Use the token names `theme.css` defines for border, small radius and muted text; check the file and match what `ModelTable.module.css` already uses.)

- [ ] **Step 4: `HubSearchControls`, `HubDetails`, `LocalVoiceSelect`**

`HubSearchControls.tsx`:

```tsx
import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { languageName } from '../../../../lib/voice/modelInfo'
import { Dropdown } from '../../../ui/Dropdown'
import styles from './HubSearchControls.module.css'

/** Languages offered by the filter: the app's locales plus the ones voice models commonly cover. */
const LANGUAGES = ['pt', 'en', 'es', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru', 'hi', 'ar']

export function HubSearchControls({
  language,
  sort,
  onLanguage,
  onSort,
}: {
  language: string | null
  sort: 'likes' | 'recent'
  onLanguage: (value: string | null) => void
  onSort: (value: 'likes' | 'recent') => void
}) {
  const t = useT()
  const locale = intlLocale(getLocale())
  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span>{t('prefs.voiceHubLanguage')}</span>
        <Dropdown
          value={language ?? ''}
          ariaLabel={t('prefs.voiceHubLanguage')}
          options={[
            { value: '', label: t('prefs.voiceHubLanguageAny') },
            ...LANGUAGES.map((tag) => ({ value: tag, label: languageName(tag, locale) })),
          ]}
          onChange={(value) => onLanguage(value || null)}
        />
      </label>
      <label className={styles.field}>
        <span>{t('prefs.voiceHubSort')}</span>
        <Dropdown
          value={sort}
          ariaLabel={t('prefs.voiceHubSort')}
          options={[
            { value: 'likes', label: t('prefs.voiceHubSortLikes') },
            { value: 'recent', label: t('prefs.voiceHubSortRecent') },
          ]}
          onChange={(value) => onSort(value === 'recent' ? 'recent' : 'likes')}
        />
      </label>
    </div>
  )
}
```

Check `src/components/ui/Dropdown` for its exact props (it is used in `NarrationPanel.tsx` with `value`, `ariaLabel`, `options`, `onChange`, `searchable`) and match them.

`HubSearchControls.module.css`:
```css
.root {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 8px 0;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: 12px;
}
```

`HubDetails.tsx`:

```tsx
import { ExternalLink } from 'lucide-react'

import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { formatByteSize } from '../../../../lib/speech/downloadStats'
import { type HubModelInfo, openInBrowser } from '../../../../lib/tauri'
import { hubSourceUrl } from '../../../../lib/voice/hubModels'
import styles from './HubDetails.module.css'

/** The Hugging Face part of a model's detail panel. */
export function HubDetails({ hub, resolving }: { hub: HubModelInfo; resolving: boolean }) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const author = hub.repo.split('/')[0]
  const updated = hub.lastModified
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(hub.lastModified))
    : '—'
  const row = (label: string, value: string) => (
    <p className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span>{value}</span>
    </p>
  )
  return (
    <div className={styles.root}>
      {hub.fileCount !== null && hub.totalBytes !== null ? (
        <p className={styles.row}>
          {t('prefs.voiceHubFiles', { count: hub.fileCount, size: formatByteSize(hub.totalBytes, locale) })}
        </p>
      ) : resolving ? (
        <p className={styles.row}>{t('prefs.voiceHubResolving')}</p>
      ) : null}
      {hub.voiceCount !== null ? row(t('prefs.voiceColVoices'), String(hub.voiceCount)) : null}
      {row(t('prefs.voiceHubLicense'), hub.license ?? t('prefs.voiceHubUnknown'))}
      {row(t('prefs.voiceHubAuthor'), author)}
      {row(t('prefs.voiceHubUpdated'), updated)}
      {hub.commit ? row(t('prefs.voiceHubCommit'), hub.commit.slice(0, 7)) : null}
      <button type="button" className={styles.link} onClick={() => void openInBrowser(hubSourceUrl(hub.repo))}>
        {t('prefs.voiceHubOpen')}
        <ExternalLink size={12} aria-hidden="true" />
      </button>
    </div>
  )
}
```

`HubDetails.module.css` — copy the `.text`, `.label` and `.link` rules from `LocalModelsView.module.css` as `.row`, `.label` and `.link`, plus:
```css
.root {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
```

`LocalVoiceSelect.tsx`:

```tsx
import { useEffect, useState } from 'react'

import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { type TtsVoice, ttsVoices } from '../../../../lib/tauri'
import { voiceOption } from '../../../../lib/voice/voiceLanguages'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'

/** Picks the speaker of a downloaded multi-voice local model and uses it for narration. */
export function LocalVoiceSelect({ modelId }: { modelId: string }) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const voiceTts = useProjectsStore((s) => s.preferences.voiceTts)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [voices, setVoices] = useState<TtsVoice[]>([])

  useEffect(() => {
    let cancelled = false
    void ttsVoices('local', modelId)
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [modelId])

  if (voices.length < 2) return null
  const active = voiceTts.provider === 'local' && voiceTts.model === modelId
  return (
    <label>
      <span>{t('prefs.voiceConvVoice')}</span>
      <Dropdown
        value={active ? (voiceTts.voice ?? '') : ''}
        ariaLabel={t('prefs.voiceConvVoice')}
        searchable={voices.length > 8}
        options={voices.map((voice) => voiceOption(voice, locale, t))}
        onChange={(value) =>
          setPreferences(withTtsChoice({ voiceTts }, { provider: 'local', model: modelId, voice: value || null }))
        }
      />
    </label>
  )
}
```

Check `ttsVoices`'s signature in `src/lib/tauri/tts.ts` (`ttsVoices(provider, model?)`, as `NarrationPanel` calls it) and the `Dropdown` option type, and match them.

- [ ] **Step 5: `LocalModelsView` — modes and Hugging Face rows**

Changes in `LocalModelsView.tsx`:

1. Imports: `useHubSearch`, `HubSearchControls`, `HubDetails`, `LocalVoiceSelect`.
2. Signature and state:
   ```tsx
   type Mode = 'installed' | 'search'
   const SEARCH_COLUMNS: TableColumn[] = ['languages', 'speed', 'accuracy', 'voices', 'size', 'likes', 'status']

   export function LocalModelsView({ initialFilter, initialMode }: { initialFilter?: Filter; initialMode?: Mode }) {
     // …existing hooks…
     const [mode, setMode] = useState<Mode>(initialMode ?? 'installed')
     const [query, setQuery] = useState('')
     const [language, setLanguage] = useState<string | null>(null)
     const [sort, setSort] = useState<'likes' | 'recent'>('likes')
     const search = useHubSearch({ use: filter === 'all' ? null : filter, query, language, sort })
   ```
3. In `rowFor`:
   - `const info = modelInfoFor(model.id)` stays (the registry now answers for `hf:` ids).
   - `badge: model.source === 'huggingface' ? t('prefs.voiceHubBadge') : undefined,`
   - tier cells: `<TierDots tier={info?.speed} label={…} estimated={info?.estimated} />` (same for accuracy).
   - size cell:
     ```tsx
     size: model.hub && model.hub.totalBytes === null
       ? search.resolving.has(model.id) ? '…' : '—'
       : formatByteSize(model.sizeBytes, locale),
     ```
   - `voices: info?.voiceCount ? String(info.voiceCount) : '—',`
   - `likes: model.hub ? String(model.hub.likes) : '—',`
   - In `details`, replace the `info?.sourceUrl` link block with:
     ```tsx
     {model.hub ? (
       <HubDetails hub={model.hub} resolving={search.resolving.has(model.id)} />
     ) : info?.sourceUrl ? (
       /* existing Source link button, unchanged */
     ) : null}
     {ready && modelUse(model) === 'tts' && model.hub ? <LocalVoiceSelect modelId={model.id} /> : null}
     ```
   - Error text: in `errorKey`, first try `hubErrorKey(message)` and return it when not null.
4. Rows per mode:
   ```tsx
   const source = mode === 'search' ? search.results : downloadable
   // `rows` inside `sections` uses `source.filter(...)` instead of `downloadable.filter(...)`.
   ```
5. Render: above `ModelTable`, a two-button segmented control reusing the existing filter styles from `ModelTable` (or `controls.btn` with `aria-pressed`):
   ```tsx
   <div className={styles.modes} role="group" aria-label={t('prefs.voiceLocalModeSearch')}>
     {(['installed', 'search'] as const).map((value) => (
       <button
         key={value}
         type="button"
         className={`${controls.btn} ${controls.btnSm}`}
         aria-pressed={mode === value}
         onClick={() => setMode(value)}
       >
         {t(value === 'installed' ? 'prefs.voiceLocalModeInstalled' : 'prefs.voiceLocalModeSearch')}
       </button>
     ))}
   </div>
   {mode === 'search' ? (
     <>
       <p className={styles.intro}>{t('prefs.voiceHubIntro')}</p>
       <HubSearchControls language={language} sort={sort} onLanguage={setLanguage} onSort={setSort} />
       {search.status === 'error' && search.error ? (
         <div role="alert" className={styles.failure}>
           <p className={styles.intro}>{t(search.error)}</p>
           <button type="button" className={`${controls.btn} ${controls.btnSm}`} onClick={search.retry}>
             {t('prefs.voiceRetry')}
           </button>
         </div>
       ) : null}
     </>
   ) : null}
   ```
   `ModelTable` props by mode: `columns={mode === 'search' ? SEARCH_COLUMNS : COLUMNS}`, `search={mode === 'search' ? { value: query, onChange: setQuery, placeholder: t('prefs.voiceHubSearchPlaceholder') } : undefined}`, and
   ```tsx
   empty={
     mode === 'search'
       ? search.status === 'loading' && search.results.length === 0
         ? t('prefs.voiceHubLoading')
         : search.status === 'ready' && search.results.length === 0
           ? t('prefs.voiceHubEmpty')
           : undefined
       : models.length === 0 && !unavailable
         ? t('prefs.voiceModelsLoading')
         : undefined
   }
   ```
   Below the table, in search mode with `search.hasMore`:
   ```tsx
   <button type="button" className={controls.btn} disabled={search.status === 'loading'} onClick={search.loadMore}>
     {t('prefs.voiceHubLoadMore')}
   </button>
   ```
6. `LocalModelsView.module.css`: add
   ```css
   .modes {
     display: flex;
     gap: 6px;
     margin-bottom: 8px;
   }
   ```

- [ ] **Step 6: "More models" entry point**

`ProviderDetail.tsx`: add prop `initialMode?: 'installed' | 'search'` (doc: `/** Initial mode of the Local models screen. */`) and pass `<LocalModelsView initialFilter={filter} initialMode={initialMode} />`.

`VoicePage.tsx`: `type Detail = { id: VoiceProviderId; filter?: 'stt' | 'tts' | 'all'; mode?: 'installed' | 'search' }`; pass `initialMode={detail.mode}` to `ProviderDetail`; next to the "Compare models" button add:

```tsx
<button
  type="button"
  className={controls.btn}
  onClick={() =>
    setDetail({ id: 'local', filter: tab === 'narration' ? 'tts' : 'stt', mode: 'search' })
  }
>
  {t('prefs.voiceHubMoreModels')}
</button>
```

If `introRow` lays out only one button, wrap both buttons in a `<div className={styles.introActions}>` with `display: flex; gap: 8px;` in `VoicePage.module.css`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/modals && npx tsc --noEmit -p .`
Expected: PASS. Then `npx prettier --write` and `npx eslint --fix` on every touched frontend file.

- [ ] **Step 8: Leave changes in the working tree** (no commit).

---

### Task 10: Docs and verification

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/FEATURES.md`, `docs/VOICE.md`

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` in `docs/CHANGELOG.md`, in its "Added" list (create the subsection if missing), add:

```markdown
- Search Hugging Face from Preferences → Voice → Local models and download more offline voices (Piper, Kokoro, Kitten) and speech recognition models (Whisper, SenseVoice, Paraformer, Zipformer, Parakeet, NeMo CTC, Moonshine, Dolphin), with the same comparison table, details and pausable downloads as built-in models.
- Pick the speaker of multi-voice local models (Kokoro, Kitten, multi-speaker Piper) for narration.
```

- [ ] **Step 2: FEATURES.md and VOICE.md**

In `docs/FEATURES.md`, in the voice / local models section, add a short paragraph: what the search mode does, that only models Alethe can run are listed, that tiers marked "≈" are estimates, and where downloaded models live (`%APPDATA%/Alethe/speech-models/hf--{author}--{repo}/`).

In `docs/VOICE.md`, add a section "Hugging Face models" covering:
- Module layout (`speech_hub/{hf,detect,meta,search,installed}.rs`) and the commands `speech_hub_search` / `speech_hub_resolve`.
- The family table from spec §5 and the rule "repo name pattern and required files must both match".
- Security: author allowlist (`csukuangfj`, `csukuangfj2`, `k2-fsa`), host and redirect rules, `safe_path`, commit pinning, SHA-256 for LFS files and git blob SHA-1 for the rest, the 4 GiB / 16 MiB limits, manifest re-validation on every read.
- The manifest (`alethe-model.json`, `complete: false` while downloading) and why state stays derived from disk.
- How to review: the Rust tests under `speech_hub` and the frontend tests `hubModels.test.ts`, `useHubSearch.test.ts`, `LocalModelsView.test.tsx`.

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
cd src-tauri && cargo test --lib && cargo clippy --lib --message-format=short 2>&1 | grep -E "speech_hub|speech_layout|src/speech.rs|src/tts.rs|tts_local" ; cd ..
npm test
npm run build
```

Expected: all Rust tests pass; clippy prints nothing for the touched files; vitest passes; `npm run build` passes (it typechecks and validates i18n across the three locales).

- [ ] **Step 4: Manual verification in the running app (do not restart it)**

1. Preferences → Voice → Narration → "More models": the search opens filtered to Text → speech and lists Piper/Kokoro/Kitten results with "≈" tiers, likes and sizes filling in.
2. Language "pt": Portuguese Piper voices and Kokoro v1.0 appear. Download `Piper · Cadu (pt-BR, medium)`; pause at ~30 %, close Preferences, quit and reopen the app, open Installed: it shows "Paused · X of Y MB"; Resume finishes it.
3. Use Cadu for narration; hear a reply in Portuguese.
4. Download Kokoro multi lang v1.0; in its details pick voice "Dora · Portuguese (Brazil)"; narrate. **Verify that it is a female Brazilian Portuguese voice** — this checks the speaker-id table in `meta.rs`. If the voice is wrong, the Kokoro table order is wrong: report it instead of guessing a fix.
5. Dictation → "More models": search "whisper", download Whisper turbo (or SenseVoice to keep it small), use it for dictation, dictate a sentence.
6. Turn the network off: search shows "Can't reach Hugging Face…" with Try again; Installed still lists and runs the downloaded models.
7. Remove a Hugging Face model that is in use: the use falls back as it does for catalog models.

Report any step you could not run and why.

- [ ] **Step 5: Leave changes in the working tree** (no commit).
