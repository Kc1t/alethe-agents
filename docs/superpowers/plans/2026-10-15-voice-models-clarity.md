# Voice Settings Clarity and Pausable Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Voice settings screen say what each model is for, which languages it covers, how it compares and what is in use; and let local model downloads be paused, resumed later (even after a restart) or cancelled.

**Architecture:** Human-readable model metadata moves to a translated frontend module (`modelInfo.ts`). A reusable `ModelTable` (comparison rows that expand into details) serves the Local models screen and the cloud provider pages. The Rust downloader moves into `speech_download.rs` with per-model stop flags, a testable chunk writer and disk-derived states (`paused` when `.part` files exist).

**Tech Stack:** Tauri 2, Rust (`reqwest`, `futures-util`, `tokio`), React 19 + TypeScript, Zustand, CSS Modules, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-voice-models-clarity-design.md`

## Global Constraints

- Never start, stop or restart the app or dev server; rely on HMR.
- No commits, no `git add`/`stash`/`checkout`/`reset` (owner's rule for this work). Skip every commit step; leave changes in the working tree.
- Every visible string through `t()`; keys in `src/lib/i18n/messages/en.ts`, `pt-BR.ts`, `zh-CN.ts`. Interpolation is single-brace `{param}`.
- One `.module.css` per component; colors/radii/shadows only via `src/styles/theme.css` tokens; no gradients; no vendor logos.
- English in code, comments, docs, changelog.
- Speed/accuracy tiers are curated catalog data (spec §4); size, languages, status, prices are real data; missing → "—".
- Pause is persistent and derived from disk; nothing resumes on its own; one download at a time.
- Format and lint only the files you touch (`npx prettier --write`, `npx eslint --fix`); `rustfmt` only new Rust files and lines you touch.
- `docs/CHANGELOG.md` `[Unreleased]`, `docs/FEATURES.md` and `docs/VOICE.md` are updated (Task 7).

## Review Focus

1. **App closed mid-download** → reopening Local models shows "Paused · X of Y MB" with Resume/Cancel, and Resume continues from the partial bytes. Pinned by `states_from_disk_*` (Task 2) and the remount test (Task 4).
2. **Pause clicked while verifying or unpacking** → the button is disabled; no half-hashed or half-unpacked model is left. Pinned by the actions-per-phase test (Task 4); in Rust only `write_stream` reads the stop flag (Task 2).
3. **Server ignores `Range` (HTTP 200 on resume)** → the partial is discarded and the file restarts cleanly; no duplicated bytes. Pinned by `resume_without_partial_content_restarts_the_file` (Task 2).
4. **Model selected for a use but not downloaded / paused** → the in-use summary shows a warning, not a silent broken setup. Pinned by the summary warning test (Task 5).
5. **Catalog id with no `ModelInfo` entry** (future Hugging Face models) → row renders with the Rust label, "—" tiers and its capability, no crash. Pinned by the unknown-model test (Task 4).

---

## File map

Create:
- `src/lib/voice/modelInfo.ts` (+ `.test.ts`) — curated, translated model metadata and helpers.
- `src-tauri/src/speech_download.rs` — stop flags, chunk writer, disk-derived state.
- `src/components/modals/preferences/voice/useModelDownloads.ts` (+ `.test.ts`) — download state machine for the UI.
- `src/components/modals/preferences/voice/TierDots.tsx` (+ css)
- `src/components/modals/preferences/voice/ModelTable.tsx` (+ css, test) — comparison table with expandable rows.
- `src/components/modals/preferences/voice/LocalModelsView.tsx` (+ css, test) — replaces `LocalModelList`.
- `src/components/modals/preferences/voice/VoiceInUseSummary.tsx` (+ css, test)
- `src/components/modals/preferences/voice/CloudModelsView.tsx` (+ css, test)
- `src/components/modals/preferences/voice/BuiltInProviderView.tsx` (+ css, test)

Modify: `src-tauri/src/speech.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/voice_providers/openrouter.rs`, `src/lib/tauri/speech.ts`, `src/lib/tauri/voiceProviders.ts`, `voice/VoicePage.tsx`, `voice/ProviderDetail.tsx`, `voice/ProviderGrid.tsx`, `voice/ProviderUseCard.tsx`, `voice/SttProviderChoices.tsx`, `voice/NarrationPanel.tsx`, the 3 locale files, docs. Delete: `voice/LocalModelList.tsx` (+ css, test).

---

### Task 1: Model metadata

**Files:**
- Create: `src/lib/voice/modelInfo.ts`, `src/lib/voice/modelInfo.test.ts`
- Modify: `src/lib/i18n/messages/{en,pt-BR,zh-CN}.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Tier = 1 | 2 | 3
  export type ModelUse = 'stt' | 'tts'
  export interface ModelInfo {
    id: string; use: ModelUse
    languages: string[]            // BCP-47; empty when languageCount describes a large set
    languageCount?: number
    speed?: Tier; accuracy?: Tier; recommended?: boolean
    summary: MessageKey; details: MessageKey
    voice?: { gender: 'female' | 'male' }
    sourceUrl?: string
  }
  export const MODEL_INFO: Record<string, ModelInfo>
  export function modelInfoFor(id: string): ModelInfo | null
  export function languagesLabel(info: ModelInfo | null, t: TFn, locale: string): string   // "25 (incl. Portuguese)" / "English" / "Portuguese (Brazil)" / "—"
  ```

- [ ] **Step 1: Write the failing test** — `src/lib/voice/modelInfo.test.ts`

```ts
import { describe, expect, it } from 'vitest'

import { languagesLabel, MODEL_INFO, modelInfoFor } from './modelInfo'

const BUILT_IN = [
  'parakeet-tdt-0.6b-v3-int8',
  'zipformer-gigaspeech-en-int8',
  'zipformer-small-en-int8',
  'whisper-base-int8',
  'whisper-small-int8',
  'moonshine-base-en-int8',
  'piper-pt-br-faber-medium',
  'piper-en-us-amy-low',
]
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('modelInfo', () => {
  it('covers every built-in catalog id', () => {
    for (const id of BUILT_IN) expect(MODEL_INFO[id], id).toBeDefined()
  })

  it('marks exactly one recommended model per use', () => {
    const recommended = Object.values(MODEL_INFO).filter((info) => info.recommended)
    expect(recommended.map((info) => info.use).sort()).toEqual(['stt', 'tts'])
  })

  it('returns null for unknown ids', () => {
    expect(modelInfoFor('someone/new-model')).toBeNull()
  })

  it('labels languages', () => {
    expect(languagesLabel(MODEL_INFO['zipformer-small-en-int8'], t, 'en')).toBe('English')
    expect(languagesLabel(MODEL_INFO['piper-pt-br-faber-medium'], t, 'en')).toBe(
      'Portuguese (Brazil)',
    )
    expect(languagesLabel(MODEL_INFO['whisper-base-int8'], t, 'en')).toBe(
      'prefs.voiceModelLanguagesMany:{"count":99}',
    )
    expect(languagesLabel(MODEL_INFO['parakeet-tdt-0.6b-v3-int8'], t, 'en')).toBe(
      'prefs.voiceModelLanguagesManyWith:{"count":25,"language":"Portuguese"}',
    )
    expect(languagesLabel(null, t, 'en')).toBe('—')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/voice/modelInfo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/lib/voice/modelInfo.ts`

```ts
import type { MessageKey } from '../i18n/messages/en'

export type Tier = 1 | 2 | 3
export type ModelUse = 'stt' | 'tts'

export interface ModelInfo {
  id: string
  use: ModelUse
  languages: string[]
  languageCount?: number
  speed?: Tier
  accuracy?: Tier
  recommended?: boolean
  summary: MessageKey
  details: MessageKey
  voice?: { gender: 'female' | 'male' }
  sourceUrl?: string
}

type TFn = (key: MessageKey, params?: Record<string, string | number>) => string

/** Tiers compare models of the same use, from each model's published benchmarks. */
export const MODEL_INFO: Record<string, ModelInfo> = {
  'parakeet-tdt-0.6b-v3-int8': {
    id: 'parakeet-tdt-0.6b-v3-int8', use: 'stt', languages: ['pt'], languageCount: 25,
    speed: 2, accuracy: 3, recommended: true,
    summary: 'voice.model.parakeet.summary', details: 'voice.model.parakeet.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  },
  'zipformer-gigaspeech-en-int8': {
    id: 'zipformer-gigaspeech-en-int8', use: 'stt', languages: ['en'], speed: 3, accuracy: 2,
    summary: 'voice.model.zipformerGiga.summary', details: 'voice.model.zipformerGiga.details',
  },
  'zipformer-small-en-int8': {
    id: 'zipformer-small-en-int8', use: 'stt', languages: ['en'], speed: 3, accuracy: 1,
    summary: 'voice.model.zipformerSmall.summary', details: 'voice.model.zipformerSmall.details',
  },
  'whisper-base-int8': {
    id: 'whisper-base-int8', use: 'stt', languages: [], languageCount: 99, speed: 3, accuracy: 1,
    summary: 'voice.model.whisperBase.summary', details: 'voice.model.whisperBase.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base',
  },
  'whisper-small-int8': {
    id: 'whisper-small-int8', use: 'stt', languages: [], languageCount: 99, speed: 2, accuracy: 2,
    summary: 'voice.model.whisperSmall.summary', details: 'voice.model.whisperSmall.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small',
  },
  'moonshine-base-en-int8': {
    id: 'moonshine-base-en-int8', use: 'stt', languages: ['en'], speed: 3, accuracy: 2,
    summary: 'voice.model.moonshine.summary', details: 'voice.model.moonshine.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8',
  },
  'piper-pt-br-faber-medium': {
    id: 'piper-pt-br-faber-medium', use: 'tts', languages: ['pt-BR'], speed: 3, accuracy: 2,
    recommended: true, voice: { gender: 'male' },
    summary: 'voice.model.piperFaber.summary', details: 'voice.model.piperFaber.details',
    sourceUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
  },
  'piper-en-us-amy-low': {
    id: 'piper-en-us-amy-low', use: 'tts', languages: ['en-US'], speed: 3, accuracy: 1,
    voice: { gender: 'female' },
    summary: 'voice.model.piperAmy.summary', details: 'voice.model.piperAmy.details',
    sourceUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
  },
}

export function modelInfoFor(id: string): ModelInfo | null {
  return MODEL_INFO[id] ?? null
}

function languageName(tag: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : tag
  } catch {
    return tag
  }
}

export function languagesLabel(info: ModelInfo | null, t: TFn, locale: string): string {
  if (!info) return '—'
  if (info.languageCount && info.languageCount > info.languages.length) {
    const first = info.languages[0]
    return first
      ? t('prefs.voiceModelLanguagesManyWith', {
          count: info.languageCount,
          language: languageName(first, locale),
        })
      : t('prefs.voiceModelLanguagesMany', { count: info.languageCount })
  }
  return info.languages.map((tag) => languageName(tag, locale)).join(', ') || '—'
}
```

- [ ] **Step 4: i18n keys** — add to `en.ts` and translate into `pt-BR.ts` / `zh-CN.ts`:

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceModelLanguagesMany` | {count} languages | {count} idiomas | {count} 种语言 |
| `prefs.voiceModelLanguagesManyWith` | {count} languages (incl. {language}) | {count} idiomas (inclui {language}) | {count} 种语言（含{language}） |
| `voice.model.parakeet.summary` | Best overall accuracy; detects the language by itself. | A melhor precisão geral; detecta o idioma sozinho. | 整体准确度最高；自动识别语言。 |
| `voice.model.parakeet.details` | 25 European languages with punctuation and capitals. Large download; needs a few seconds to load the first time. | 25 idiomas europeus, com pontuação e maiúsculas. Download grande; leva alguns segundos para carregar na primeira vez. | 支持 25 种欧洲语言，带标点和大小写。体积较大，首次加载需要几秒。 |
| `voice.model.zipformerGiga.summary` | Fast and accurate for English. | Rápido e preciso para inglês. | 英语识别快速准确。 |
| `voice.model.zipformerGiga.details` | English only. Good balance of size and accuracy. | Só inglês. Bom equilíbrio entre tamanho e precisão. | 仅英语。体积与准确度平衡良好。 |
| `voice.model.zipformerSmall.summary` | The smallest download, English only. | O menor download, só inglês. | 最小的下载，仅英语。 |
| `voice.model.zipformerSmall.details` | Starts instantly and uses little memory; makes more mistakes than the larger models. | Abre na hora e usa pouca memória; erra mais que os modelos maiores. | 启动快、占用内存少；错误比大型模型多。 |
| `voice.model.whisperBase.summary` | Light and fast, many languages. | Leve e rápido, muitos idiomas. | 轻量快速，支持多种语言。 |
| `voice.model.whisperBase.details` | Detects the language. Best for short phrases; less accurate on long dictation. Long recordings are processed in 28-second windows. | Detecta o idioma. Melhor para frases curtas; menos preciso em ditados longos. Gravações longas são processadas em janelas de 28 segundos. | 自动识别语言。适合短句；长时间听写准确度较低。长录音按 28 秒分段处理。 |
| `voice.model.whisperSmall.summary` | More accurate Whisper, many languages. | Whisper mais preciso, muitos idiomas. | 更准确的 Whisper，支持多种语言。 |
| `voice.model.whisperSmall.details` | Detects the language. Slower than Whisper base. Long recordings are processed in 28-second windows. | Detecta o idioma. Mais lento que o Whisper base. Gravações longas são processadas em janelas de 28 segundos. | 自动识别语言。比 Whisper base 慢。长录音按 28 秒分段处理。 |
| `voice.model.moonshine.summary` | Very fast on short English commands. | Muito rápido em comandos curtos em inglês. | 英语短指令识别非常快。 |
| `voice.model.moonshine.details` | English only. Made for short commands; less suited to long dictation. | Só inglês. Feito para comandos curtos; menos indicado para ditados longos. | 仅英语。为短指令设计，不太适合长时间听写。 |
| `voice.model.piperFaber.summary` | Brazilian Portuguese male voice, offline. | Voz masculina em português do Brasil, offline. | 巴西葡萄牙语男声，离线。 |
| `voice.model.piperFaber.details` | Natural for Portuguese replies. Other languages are read with a Portuguese accent. | Natural para respostas em português. Outros idiomas são lidos com sotaque português. | 适合葡萄牙语回复。其他语言会带葡萄牙语口音。 |
| `voice.model.piperAmy.summary` | American English female voice, offline. | Voz feminina em inglês americano, offline. | 美式英语女声，离线。 |
| `voice.model.piperAmy.details` | Clear for English replies. Low quality setting keeps it small and fast. | Clara para respostas em inglês. A qualidade baixa a deixa pequena e rápida. | 适合英语回复。低质量设置使其小巧快速。 |

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/lib/voice/modelInfo.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc shows only the 2 pre-existing `Array.at` errors.

- [ ] **Step 6: Checkpoint** — no commit (Global Constraints).

---

### Task 2: Pausable downloads in Rust

**Files:**
- Create: `src-tauri/src/speech_download.rs`
- Modify: `src-tauri/src/speech.rs` (`SpeechState` :408-424, `speech_model_states` :644-700, `speech_download_model` :764-798, `download_files` :801-…), `src-tauri/src/lib.rs` (mod list + `invoke_handler`)

**Interfaces:**
- Produces (`speech_download.rs`):
  ```rust
  pub const PAUSED: &str = "speech_download_paused";
  pub const BUSY: &str = "speech_download_busy";
  #[derive(Default)] pub struct DownloadFlags { /* Mutex<HashMap<String, Arc<AtomicBool>>> */ }
  impl DownloadFlags {
      pub fn start(&self, model_id: &str) -> Result<Arc<AtomicBool>, String>   // Err(BUSY) if any active
      pub fn finish(&self, model_id: &str)
      pub fn stop(&self, model_id: &str) -> bool                               // true if it was active
      pub fn is_active(&self, model_id: &str) -> bool
  }
  pub enum WriteOutcome { Done(u64), Paused(u64) }
  pub async fn write_stream<S, E>(stream: S, out: &mut impl std::io::Write, stop: &AtomicBool,
      on_chunk: impl FnMut(u64)) -> Result<WriteOutcome, String>
      where S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin, E: std::fmt::Display
  pub struct DiskState { pub status: &'static str, pub downloaded_bytes: u64 }   // ready|paused|not-downloaded
  pub fn disk_state(dir: &Path, files: &[(&str, u64)], ready: bool) -> DiskState
  pub fn delete_partials(dir: &Path) -> std::io::Result<()>                     // removes *.part, and dir if empty
  ```
- `SpeechModelState` gains `downloaded_bytes: Option<u64>`, `total_bytes: Option<u64>` (camelCase). `status` adds `paused` and `downloading`.
- New commands: `speech_pause_download(model_id: String)`, `speech_cancel_download(model_id: String)`.
- Progress phases add `"unpacking"` (emitted before `install_tts_archive`) and `"paused"` (emitted when a pause lands).

- [ ] **Step 1: Write the failing tests** (bottom of `speech_download.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;
    use std::sync::atomic::Ordering;

    fn chunks(parts: &[&'static [u8]]) -> impl futures_util::Stream<Item = Result<bytes::Bytes, String>> + Unpin {
        stream::iter(parts.iter().map(|p| Ok(bytes::Bytes::from_static(p))).collect::<Vec<_>>())
    }

    #[tokio::test]
    async fn pausing_mid_stream_keeps_exactly_the_bytes_received() {
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let mut seen = 0;
        let outcome = write_stream(chunks(&[b"abc", b"def", b"ghi"]), &mut out, &stop, |n| {
            seen += 1;
            if seen == 2 { stop.store(true, Ordering::SeqCst) }
            let _ = n;
        })
        .await
        .unwrap();
        assert!(matches!(outcome, WriteOutcome::Paused(6)));
        assert_eq!(out, b"abcdef");
    }

    #[tokio::test]
    async fn a_full_stream_reports_done() {
        let stop = AtomicBool::new(false);
        let mut out = Vec::new();
        let outcome = write_stream(chunks(&[b"ab", b"cd"]), &mut out, &stop, |_| {}).await.unwrap();
        assert!(matches!(outcome, WriteOutcome::Done(4)));
    }

    #[test]
    fn only_one_download_at_a_time() {
        let flags = DownloadFlags::default();
        flags.start("a").unwrap();
        assert_eq!(flags.start("b").unwrap_err(), BUSY);
        assert!(flags.stop("a"));
        flags.finish("a");
        assert!(!flags.is_active("a"));
        assert!(flags.start("b").is_ok());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("alethe-dl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn states_from_disk_report_paused_with_bytes() {
        let dir = temp_dir("paused");
        std::fs::write(dir.join("a.onnx"), vec![0u8; 10]).unwrap();
        std::fs::write(dir.join("b.onnx.part"), vec![0u8; 4]).unwrap();
        let state = disk_state(&dir, &[("a.onnx", 10), ("b.onnx", 20)], false);
        assert_eq!(state.status, "paused");
        assert_eq!(state.downloaded_bytes, 14);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn states_from_disk_report_ready_and_not_downloaded() {
        let dir = temp_dir("states");
        assert_eq!(disk_state(&dir, &[("a.onnx", 10)], false).status, "not-downloaded");
        assert_eq!(disk_state(&dir.join("missing"), &[("a.onnx", 10)], false).status, "not-downloaded");
        assert_eq!(disk_state(&dir, &[("a.onnx", 10)], true).status, "ready");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_deletes_partials_and_the_empty_folder() {
        let dir = temp_dir("cancel");
        std::fs::write(dir.join("b.onnx.part"), b"x").unwrap();
        delete_partials(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn cancel_keeps_finished_files() {
        let dir = temp_dir("keep");
        std::fs::write(dir.join("a.onnx"), b"x").unwrap();
        std::fs::write(dir.join("b.onnx.part"), b"x").unwrap();
        delete_partials(&dir).unwrap();
        assert!(dir.join("a.onnx").is_file());
        assert!(!dir.join("b.onnx.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

Add to `speech.rs` tests (Review Focus 3):

```rust
    #[test]
    fn resume_without_partial_content_restarts_the_file() {
        // offset > 0 but the server answered 200: the part file must be truncated, not appended to.
        assert!(!should_append(100, reqwest::StatusCode::OK));
        assert!(should_append(100, reqwest::StatusCode::PARTIAL_CONTENT));
        assert!(!should_append(0, reqwest::StatusCode::PARTIAL_CONTENT));
    }
```

Review Focus 2 (no pause during verify/unpack) holds by construction: only `write_stream` reads the stop flag, and verification/unpacking run after it returns. The UI side is pinned in Task 4.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test --lib speech_download` then `cargo test --lib resume_without_partial`
Expected: compile errors (module/functions missing).

- [ ] **Step 3: Implement `speech_download.rs`**

```rust
//! Pausable model downloads: one active download at a time, a stop flag per model, and states
//! derived from what is on disk so a pause survives closing the app.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;

pub const PAUSED: &str = "speech_download_paused";
pub const BUSY: &str = "speech_download_busy";

#[derive(Default)]
pub struct DownloadFlags(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl DownloadFlags {
    pub fn start(&self, model_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if !map.is_empty() {
            return Err(BUSY.to_string());
        }
        let flag = Arc::new(AtomicBool::new(false));
        map.insert(model_id.to_string(), Arc::clone(&flag));
        Ok(flag)
    }

    pub fn finish(&self, model_id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(model_id);
    }

    pub fn stop(&self, model_id: &str) -> bool {
        match self.0.lock().unwrap_or_else(|e| e.into_inner()).get(model_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn is_active(&self, model_id: &str) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).contains_key(model_id)
    }
}

pub enum WriteOutcome {
    Done(u64),
    Paused(u64),
}

/// Writes the stream to `out`, checking `stop` after every chunk. Returns the bytes written.
pub async fn write_stream<S, E>(
    mut stream: S,
    out: &mut impl Write,
    stop: &AtomicBool,
    mut on_chunk: impl FnMut(u64),
) -> Result<WriteOutcome, String>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download stream: {e}"))?;
        out.write_all(&chunk).map_err(|e| format!("write: {e}"))?;
        written += chunk.len() as u64;
        on_chunk(written);
        if stop.load(Ordering::SeqCst) {
            out.flush().map_err(|e| format!("flush: {e}"))?;
            return Ok(WriteOutcome::Paused(written));
        }
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(WriteOutcome::Done(written))
}

pub struct DiskState {
    pub status: &'static str,
    pub downloaded_bytes: u64,
}

/// `ready` when the caller says so; `paused` when any finished file or `.part` exists; else
/// `not-downloaded`. Bytes count finished files at their catalog size plus `.part` lengths.
pub fn disk_state(dir: &Path, files: &[(&str, u64)], ready: bool) -> DiskState {
    let total: u64 = files.iter().map(|(_, size)| size).sum();
    if ready {
        return DiskState { status: "ready", downloaded_bytes: total };
    }
    let mut bytes = 0u64;
    let mut any = false;
    for (name, size) in files {
        if dir.join(name).is_file() {
            bytes += size;
            any = true;
        } else if let Ok(meta) = std::fs::metadata(dir.join(format!("{name}.part"))) {
            bytes += meta.len().min(*size);
            any = true;
        }
    }
    DiskState { status: if any { "paused" } else { "not-downloaded" }, downloaded_bytes: bytes }
}

pub fn delete_partials(dir: &Path) -> std::io::Result<()> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if path.extension().is_some_and(|ext| ext == "part") {
            std::fs::remove_file(&path)?;
        }
    }
    if std::fs::read_dir(dir)?.next().is_none() {
        std::fs::remove_dir(dir)?;
    }
    Ok(())
}
```

If `bytes` is not already a direct dependency (`grep -n '^bytes' src-tauri/Cargo.toml`), use `reqwest::Bytes`-compatible `impl AsRef<[u8]>` items instead: change the bound to `Item = Result<T, E>` with `T: AsRef<[u8]>` and test with `Vec<u8>`; do not add a dependency.

- [ ] **Step 4: Wire into `speech.rs`**

- `SpeechState` gains `downloads: speech_download::DownloadFlags` (Default).
- Extract `fn should_append(offset: u64, status: reqwest::StatusCode) -> bool { offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT }` and use it where `resumed` is computed today.
- In `download_files`, take `stop: &AtomicBool`; replace the `while let Some(chunk)` loop with `write_stream(response.bytes_stream(), &mut out, stop, |got| …throttled emit("downloading", …, downloaded_total + start + got)…)`. On `Paused(_)`: `emit("paused", …)` and `return Err(speech_download::PAUSED.into())`. Verification and the final rename are unchanged and never read the flag.
- `speech_download_model`: after resolving the entry and before the lock, `let flag = state.downloads.start(&model_id)?;` and make sure `state.downloads.finish(&model_id)` runs on every exit path (a small guard struct with `Drop`, or a `scopeguard`-style closure — no new dependency). Pass `&flag` to `download_files`. Emit `"unpacking"` (with the archive file, fraction 1.0) right before `install_tts_archive`.
- `speech_model_states`: for STT entries use `disk_state(&dir, &files_as_pairs, model_ready(&dir, entry))`; for TTS entries pass `[(archive.name, archive.size_bytes)]` and `tts_ready(...)`; when `state.downloads.is_active(id)` override status to `"downloading"`. Fill `downloaded_bytes`/`total_bytes`. The command now needs `state: State<'_, SpeechState>`.
- New commands:

```rust
#[tauri::command]
pub fn speech_pause_download(state: State<'_, SpeechState>, model_id: String) -> bool {
    state.downloads.stop(&model_id)
}

#[tauri::command]
pub async fn speech_cancel_download(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<(), String> {
    state.downloads.stop(&model_id);
    // The download releases the lock once its loop has stopped (or after verify/unpack finishes).
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(&app, &model_id)?;
    speech_download::delete_partials(&dir).map_err(|e| format!("cancel download: {e}"))
}
```

- `lib.rs`: `mod speech_download;` and register `speech::speech_pause_download`, `speech::speech_cancel_download`.

- [ ] **Step 5: Run tests**

Run: `cd src-tauri && cargo test --lib speech_download`, then `cargo test --lib speech`, then `cargo clippy --lib --message-format=short 2>&1 | grep -E "speech_download.rs|src/speech.rs"` (must print nothing for lines you touched).
Expected: PASS.

- [ ] **Step 6: Checkpoint** — no commit.

---

### Task 3: Download wrappers and UI state hook

**Files:**
- Modify: `src/lib/tauri/speech.ts`
- Create: `src/components/modals/preferences/voice/useModelDownloads.ts`, `useModelDownloads.test.ts`
- Modify: `voice/useSpeechInventory.ts` (expose `refresh` already exists; no change unless needed)

**Interfaces:**
- Consumes: Task 2 commands and fields.
- Produces (`speech.ts`):
  ```ts
  export type SpeechModelState = { id: string; status: 'not-downloaded'|'downloading'|'paused'|'ready'|'error'|string;
    progress?: number|null; error?: string|null; downloadedBytes?: number|null; totalBytes?: number|null }
  // SpeechDownloadProgress.phase: 'downloading' | 'verifying' | 'unpacking' | 'paused'
  export const DOWNLOAD_PAUSED = 'speech_download_paused'
  export const DOWNLOAD_BUSY = 'speech_download_busy'
  export function speechPauseDownload(modelId: string): Promise<boolean>
  export function speechCancelDownload(modelId: string): Promise<void>
  ```
- Produces (`useModelDownloads.ts`):
  ```ts
  export type RowStatus =
    | { kind: 'not-downloaded' }
    | { kind: 'downloading'; progress: SpeechDownloadProgress | null; bytesPerSecond: number | null }
    | { kind: 'verifying' } | { kind: 'unpacking' }
    | { kind: 'paused'; downloaded: number; total: number }
    | { kind: 'ready' }
    | { kind: 'error'; message: string }
  export function useModelDownloads(): {
    statusOf: (id: string) => RowStatus
    activeId: string | null
    download: (id: string) => Promise<void>   // also resumes
    pause: (id: string) => Promise<void>
    cancel: (id: string) => Promise<void>
    remove: (id: string) => Promise<void>
    models: SpeechModelManifest[]
    refresh: () => Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing test** — `useModelDownloads.test.ts`

```ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelDownloads } from './useModelDownloads'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechDownloadModel: vi.fn(),
  speechPauseDownload: vi.fn().mockResolvedValue(true),
  speechCancelDownload: vi.fn().mockResolvedValue(undefined),
  speechDeleteModel: vi.fn().mockResolvedValue(undefined),
  onSpeechDownloadProgress: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))

let emit: (p: unknown) => void = () => undefined

describe('useModelDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauri.onSpeechDownloadProgress.mockImplementation(async (handler: (p: unknown) => void) => {
      emit = handler
      return () => undefined
    })
    tauri.speechListModels.mockResolvedValue([
      { id: 'w', label: 'W', kind: 'download', capability: 'stt', sizeBytes: 100 },
    ])
  })

  it('shows a paused download read from disk after remount', async () => {
    tauri.speechModelStates.mockResolvedValue([
      { id: 'w', status: 'paused', downloadedBytes: 40, totalBytes: 100 },
    ])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() =>
      expect(result.current.statusOf('w')).toEqual({ kind: 'paused', downloaded: 40, total: 100 }),
    )
  })

  it('treats a paused result as a state, not an error', async () => {
    tauri.speechModelStates
      .mockResolvedValueOnce([{ id: 'w', status: 'not-downloaded' }])
      .mockResolvedValue([{ id: 'w', status: 'paused', downloadedBytes: 10, totalBytes: 100 }])
    tauri.speechDownloadModel.mockRejectedValue('speech_download_paused')
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.download('w'))
    expect(result.current.statusOf('w').kind).toBe('paused')
  })

  it('reports verifying and unpacking phases from progress events', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    tauri.speechDownloadModel.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    act(() => void result.current.download('w'))
    act(() => emit({ modelId: 'w', phase: 'unpacking', downloaded: 100, total: 100, fraction: 1, file: 'a', fileIndex: 1, fileCount: 1 }))
    expect(result.current.statusOf('w').kind).toBe('unpacking')
    expect(result.current.activeId).toBe('w')
  })

  it('cancel deletes partials and refreshes', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.cancel('w'))
    expect(tauri.speechCancelDownload).toHaveBeenCalledWith('w')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/modals/preferences/voice/useModelDownloads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — wrappers in `speech.ts` (types per **Interfaces**; `invoke('speech_pause_download', { modelId })`, `invoke('speech_cancel_download', { modelId })`), and the hook:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

import { type DownloadRate, nextRate } from '../../../../lib/speech/downloadStats'
import {
  DOWNLOAD_PAUSED,
  onSpeechDownloadProgress,
  speechCancelDownload,
  speechDeleteModel,
  speechDownloadModel,
  type SpeechDownloadProgress,
  speechListModels,
  type SpeechModelManifest,
  type SpeechModelState,
  speechModelStates,
  speechPauseDownload,
} from '../../../../lib/tauri'

export type RowStatus =
  | { kind: 'not-downloaded' }
  | { kind: 'downloading'; progress: SpeechDownloadProgress | null; bytesPerSecond: number | null }
  | { kind: 'verifying' }
  | { kind: 'unpacking' }
  | { kind: 'paused'; downloaded: number; total: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

function fromState(state: SpeechModelState | undefined, size: number): RowStatus {
  switch (state?.status) {
    case 'ready':
      return { kind: 'ready' }
    case 'paused':
      return { kind: 'paused', downloaded: state.downloadedBytes ?? 0, total: state.totalBytes ?? size }
    case 'downloading':
      return { kind: 'downloading', progress: null, bytesPerSecond: null }
    default:
      return { kind: 'not-downloaded' }
  }
}

export function useModelDownloads() {
  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [progress, setProgress] = useState<SpeechDownloadProgress | null>(null)
  const [bytesPerSecond, setBytesPerSecond] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const rateRef = useRef<DownloadRate | null>(null)

  const refresh = useCallback(async () => {
    const [catalog, list] = await Promise.all([speechListModels(), speechModelStates()])
    setModels(catalog)
    setStates(Object.fromEntries(list.map((state) => [state.id, state])))
    const running = list.find((state) => state.status === 'downloading')
    setActiveId((current) => current ?? running?.id ?? null)
  }, [])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onSpeechDownloadProgress((next) => {
      setProgress(next)
      if (next.phase === 'downloading') {
        rateRef.current = nextRate(rateRef.current, { bytes: next.downloaded, at: performance.now() })
        setBytesPerSecond(rateRef.current.bytesPerSecond)
      }
    })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const settle = async (id: string, work: () => Promise<unknown>) => {
    setErrors((all) => ({ ...all, [id]: '' }))
    try {
      await work()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message !== DOWNLOAD_PAUSED) setErrors((all) => ({ ...all, [id]: message }))
    } finally {
      setActiveId((current) => (current === id ? null : current))
      setProgress(null)
      rateRef.current = null
      setBytesPerSecond(null)
      await refresh().catch(() => undefined)
    }
  }

  const statusOf = (id: string): RowStatus => {
    if (errors[id]) return { kind: 'error', message: errors[id] }
    if (activeId === id) {
      if (progress?.modelId === id && progress.phase === 'verifying') return { kind: 'verifying' }
      if (progress?.modelId === id && progress.phase === 'unpacking') return { kind: 'unpacking' }
      return { kind: 'downloading', progress: progress?.modelId === id ? progress : null, bytesPerSecond }
    }
    const model = models.find((entry) => entry.id === id)
    return fromState(states[id], model?.sizeBytes ?? 0)
  }

  return {
    models,
    refresh,
    activeId,
    statusOf,
    download: (id: string) => {
      setActiveId(id)
      return settle(id, () => speechDownloadModel(id, null))
    },
    pause: async (id: string) => {
      await speechPauseDownload(id)
    },
    cancel: (id: string) => settle(id, () => speechCancelDownload(id)),
    remove: (id: string) => settle(id, () => speechDeleteModel(id)),
  }
}
```

(Translate a raw Rust error into user text in Task 4, not here; the hook keeps the raw message.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/modals/preferences/voice/useModelDownloads.test.ts && npx tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 4: Comparison table and the Local models screen

**Files:**
- Create: `voice/TierDots.tsx` (+ `.module.css`), `voice/ModelTable.tsx` (+ `.module.css`, `.test.tsx`), `voice/LocalModelsView.tsx` (+ `.module.css`, `.test.tsx`)
- Modify: `voice/ProviderDetail.tsx` (use `LocalModelsView` for `local`), locale files
- Delete: `voice/LocalModelList.tsx`, `LocalModelList.module.css`, `LocalModelList.test.tsx` (move any still-relevant assertions into `LocalModelsView.test.tsx`)

**Interfaces:**
- Consumes: Task 1 `modelInfoFor`, `languagesLabel`, `Tier`; Task 3 `useModelDownloads`, `RowStatus`; `withSttChoice`, `withTtsChoice`; `openInBrowser`; `ModelDownloadProgress`.
- Produces:
  ```ts
  // ModelTable is presentational and shared with Task 6.
  export type TableColumn = 'languages' | 'speed' | 'accuracy' | 'size' | 'voices' | 'price' | 'status'
  export interface TableRow {
    id: string; name: string; recommended?: boolean
    cells: Partial<Record<TableColumn, ReactNode>>
    action?: ReactNode            // right-most button(s)
    details: ReactNode            // rendered when expanded
  }
  export function ModelTable(props: {
    sections: { id: string; title: string; hint: string; rows: TableRow[] }[]
    columns: TableColumn[]
    filter?: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }
    search?: { value: string; onChange: (v: string) => void; placeholder: string }
  }): JSX.Element
  export function TierDots(props: { tier?: Tier; label: string }): JSX.Element   // "—" when undefined
  export function LocalModelsView(props: { initialFilter?: 'stt' | 'tts' | 'all' }): JSX.Element
  export function usesOf(prefs: Pick<Preferences,'voiceStt'|'voiceTts'>, modelId: string): VoiceTabUse[]   // 'dictation'|'conversation'|'narration'
  ```

Layout rules (spec §5.2): a table element with a header row; each body row is a `<tr>` whose first cell holds a toggle `<button aria-expanded aria-controls>` with the name; the expanded panel is the next `<tr>` with one `<td colSpan>`. Columns collapse to a stacked layout under 640 px (CSS grid on `<tr>` via `display: grid` inside a container query or a media query on the Preferences content width — choose the one the codebase already uses; check `PreferencesModal.module.css` for `@container`/`@media`).

Status cell text (new keys, table below): Not downloaded / Downloading {percent}% · {speed} / Paused · {done} of {total} / Verifying… / Unpacking… / Downloaded / In use: {uses} / Error · {message}. Actions: Download, Pause (disabled for verifying/unpacking), Resume + Cancel, Remove; Download disabled with title `prefs.voiceDownloadBusy` when another `activeId` exists. Expanded panel: summary, details, full languages (`languagesLabel`), "Used in" + buttons `Use for Dictation` / `Use for Conversation` (stt) or `Use for Narration` (tts) — enabled only when the model is downloaded; source link (`openInBrowser`), folder (not shown in this task: show only when a cheap existing command returns the models root; otherwise omit and note it).

- [ ] **Step 1: Write failing tests** — `ModelTable.test.tsx`

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ModelTable } from './ModelTable'

afterEach(cleanup)

describe('ModelTable', () => {
  const sections = [
    {
      id: 'stt',
      title: 'Speech to text',
      hint: 'Dictation and Conversation',
      rows: [{ id: 'a', name: 'Alpha', cells: { size: '10 MB' }, details: <p>alpha details</p> }],
    },
  ]

  it('expands a row to show its details', () => {
    render(<ModelTable sections={sections} columns={['size']} />)
    const toggle = screen.getByRole('button', { name: /Alpha/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha details')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('alpha details')).toBeTruthy()
  })

  it('renders section titles as row groups', () => {
    render(<ModelTable sections={sections} columns={['size']} />)
    expect(screen.getByText('Speech to text')).toBeTruthy()
    expect(screen.getByText('Dictation and Conversation')).toBeTruthy()
  })
})
```

`LocalModelsView.test.tsx` (mock `useModelDownloads` via `vi.mock('./useModelDownloads')`, store reset with `useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })`, `useT` mocked to echo keys/params):

```tsx
it('shows tiers, languages and in-use status for a known model', ...)
  // models: parakeet (ready), prefs voiceStt.dictation = local parakeet
  // expect row text to include 'prefs.voiceModelStatusInUse' with uses dictation, tier dots labels
it('renders an unknown catalog id with dashes and its capability section', ...)   // Review Focus 5
  // model { id: 'someone/x', label: 'X', capability: 'tts', kind: 'download' } → appears under the tts section, tier cells '—'
it('shows Pause while downloading and disables it while verifying or unpacking', ...)   // Review Focus 2
it('shows Resume and Cancel for a paused model with its byte counts', ...)
it('disables Download on other rows while one model downloads', ...)
it('Use for Dictation writes only the dictation choice', ...)
it('filters sections by use', ...)
```

Write these out fully in the test file following the patterns above (each `it` builds the mocked hook return value explicitly, renders `<LocalModelsView />`, and asserts with `screen.getByRole`/`getByText`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/modals/preferences/voice/ModelTable.test.tsx src/components/modals/preferences/voice/LocalModelsView.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `TierDots`, `ModelTable`, `LocalModelsView`** per **Interfaces** and layout rules. `TierDots` renders three dots (`aria-label` = `"{label}: {tier} of 3"`, title = `prefs.voiceTierSource`), filled ones use `--accent`, empty ones `--border-strong`; undefined tier renders `—`. `LocalModelsView` builds two sections from `useModelDownloads().models` grouped by `modelInfoFor(id)?.use ?? model.capability ?? 'stt'`, columns `['languages','speed','accuracy','size','status']`, a filter (`all`/`stt`/`tts`, default `initialFilter ?? 'all'`), and the per-row action per `RowStatus`. Errors render translated: map `speech_download_busy` → `prefs.voiceDownloadBusy`, messages containing "No space left" / "os error 28" / "os error 112" → `prefs.voiceDiskFull`, else `prefs.voiceDownloadFailed`.

- [ ] **Step 4: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceSectionSttTitle` | Speech → text | Fala → texto | 语音 → 文字 |
| `prefs.voiceSectionSttHint` | Hears you in Dictation and Conversation | Ouve você no Ditado e na Conversa | 在听写和对话中识别你的语音 |
| `prefs.voiceSectionTtsTitle` | Text → speech | Texto → fala | 文字 → 语音 |
| `prefs.voiceSectionTtsHint` | Reads replies aloud in Narration | Lê as respostas em voz alta na Narração | 在旁白中朗读回复 |
| `prefs.voiceColModel` | Model | Modelo | 模型 |
| `prefs.voiceColLanguages` | Languages | Idiomas | 语言 |
| `prefs.voiceColSpeed` | Speed | Velocidade | 速度 |
| `prefs.voiceColAccuracy` | Accuracy | Precisão | 准确度 |
| `prefs.voiceColSize` | Size | Tamanho | 大小 |
| `prefs.voiceColStatus` | Status | Status | 状态 |
| `prefs.voiceColVoices` | Voices | Vozes | 语音 |
| `prefs.voiceColPrice` | Price | Preço | 价格 |
| `prefs.voiceTierSource` | Based on the model's published benchmarks | Com base nos benchmarks publicados do modelo | 基于模型公开的基准测试 |
| `prefs.voiceRecommended` | Recommended | Recomendado | 推荐 |
| `prefs.voiceFilterAllUses` | All | Todos | 全部 |
| `prefs.voiceModelStatusNotDownloaded` | Not downloaded | Não baixado | 未下载 |
| `prefs.voiceModelStatusDownloading` | Downloading {percent}% | Baixando {percent}% | 下载中 {percent}% |
| `prefs.voiceModelStatusPaused` | Paused · {done} of {total} | Pausado · {done} de {total} | 已暂停 · {done} / {total} |
| `prefs.voiceModelStatusVerifying` | Verifying… | Verificando… | 校验中… |
| `prefs.voiceModelStatusUnpacking` | Unpacking… | Descompactando… | 解压中… |
| `prefs.voiceModelStatusReady` | Downloaded | Baixado | 已下载 |
| `prefs.voiceModelStatusInUse` | In use: {uses} | Em uso: {uses} | 使用中：{uses} |
| `prefs.voiceModelStatusError` | Error · {message} | Erro · {message} | 错误 · {message} |
| `prefs.voiceActionDownload` | Download | Baixar | 下载 |
| `prefs.voiceActionPause` | Pause | Pausar | 暂停 |
| `prefs.voiceActionResume` | Resume | Continuar | 继续 |
| `prefs.voiceActionCancel` | Cancel | Cancelar | 取消 |
| `prefs.voiceActionRemove` | Remove | Remover | 删除 |
| `prefs.voiceActionTryAgain` | Try again | Tentar de novo | 重试 |
| `prefs.voiceDownloadBusy` | Another download is in progress | Outro download em andamento | 另一个下载正在进行 |
| `prefs.voiceDiskFull` | Not enough disk space | Sem espaço em disco | 磁盘空间不足 |
| `prefs.voiceDownloadFailed` | The download failed | O download falhou | 下载失败 |
| `prefs.voiceUsedIn` | Used in | Usado em | 用于 |
| `prefs.voiceUseFor` | Use for {use} | Usar no(a) {use} | 用于{use} |
| `prefs.voiceSource` | Source | Origem | 来源 |
| `prefs.voiceLocalIntro` | Run on this computer: private, offline, no key. | Rodam neste computador: privados, offline, sem chave. | 在本机运行：私密、离线、无需密钥。 |

(Uses inside `{uses}` / `{use}` reuse the existing tab labels `prefs.voiceTabDictation` / `prefs.voiceTabConversation` / `prefs.voiceTabNarration`, joined with ", ".)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/modals && npx tsc --noEmit -p .` then prettier/eslint on touched files.
Expected: PASS.

- [ ] **Step 6: Checkpoint** — no commit.

---

### Task 5: In-use summary, Compare models, card summary line, grid rename

**Files:**
- Create: `voice/VoiceInUseSummary.tsx` (+ `.module.css`, `.test.tsx`)
- Modify: `voice/VoicePage.tsx`, `voice/ProviderGrid.tsx`, `voice/ProviderUseCard.tsx` (summary line slot) or `SttProviderChoices.tsx` / `NarrationPanel.tsx` (pass the line), `voice/ProviderDetail.tsx` (accept an initial filter for `local`), locale files

**Interfaces:**
- Consumes: Task 1, Task 3 (`statusOf` for warnings), existing `cloudStatus`, `PROVIDER_META`, `voiceProviders` flags, Apple locale.
- Produces:
  ```ts
  export function VoiceInUseSummary(props: { onOpenTab: (tab: VoiceTab) => void }): JSX.Element
  export function useWarningFor(use: 'dictation'|'conversation'|'narration'): MessageKey | null
  // VoicePage: detail state becomes { id: VoiceProviderId; filter?: 'stt'|'tts'|'all' } | null
  ```

Rules:
- Summary rows: Dictation / Conversation / Narration → `<provider name> · <model or voice label>` + `local`/`cloud` marker (`prefs.voiceBadgeDevice` / `prefs.voiceBadgeCloud`). Each row is a `<button>` that calls `onOpenTab`.
- Warnings (existing texts where available): local model not `ready` → `prefs.voiceWarnNotDownloaded`; cloud flag invalid → `prefs.voiceStatusInvalid`; cloud not configured → `prefs.voiceWarnNoKey`; Apple without locale → `prefs.dictationNativeNeedsLocale`.
- Replace the header paragraph `prefs.categoryVoiceDesc` usage on the page with the summary (keep the key for the Preferences sidebar).
- Each tab gets a `Compare models` button (`prefs.voiceCompareModels`) opening `ProviderDetail` for `local` with filter `stt` (Dictation/Conversation) or `tts` (Narration).
- Selected use-card footer adds one line: `languagesLabel · Speed ●●○ · Accuracy ●●●` using `TierDots` (local models only; cloud cards unchanged).
- Providers grid title → `prefs.voiceAccountsTitle` ("Accounts and models"), description → `prefs.voiceAccountsDesc`; breadcrumb back label in `ProviderDetail` uses the new title.

- [ ] **Step 1: Write failing tests** — `VoiceInUseSummary.test.tsx`

```tsx
it('lists the provider and model for each use and opens its tab', ...)
  // prefs: dictation local parakeet, conversation apple pt-BR, narration openai nova (configured)
  // expect three buttons; clicking "Narration" row calls onOpenTab('narration')
it('warns when the chosen local model is not downloaded', ...)   // Review Focus 4
  // dictation local whisper-base, statusOf('whisper-base-int8') → paused → row shows prefs.voiceWarnNotDownloaded
it('warns when a cloud key is invalid or missing', ...)
it('warns when Apple has no language', ...)
```

Add to `VoicePage.test.tsx`: "Compare models opens Local models filtered to the tab's use" (mock `ProviderDetail` to render its props).

Write each test body in full (mock `useModelDownloads` and the store as in Task 4).

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/components/modals/preferences/voice/VoiceInUseSummary.test.tsx src/components/modals/preferences/voice/VoicePage.test.tsx` → FAIL.

- [ ] **Step 3: Implement** per **Interfaces** and rules.

- [ ] **Step 4: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceInUseTitle` | In use | Em uso | 当前使用 |
| `prefs.voiceWarnNotDownloaded` | Model not downloaded | Modelo não baixado | 模型未下载 |
| `prefs.voiceWarnNoKey` | No API key | Sem chave de API | 没有 API 密钥 |
| `prefs.voiceCompareModels` | Compare models | Comparar modelos | 比较模型 |
| `prefs.voiceAccountsTitle` | Accounts and models | Contas e modelos | 账户与模型 |
| `prefs.voiceAccountsDesc` | Set up API keys and download local models. Pick what each feature uses in the tabs above. | Configure chaves de API e baixe modelos locais. Escolha o que cada recurso usa nas abas acima. | 设置 API 密钥并下载本地模型。在上方标签页中选择各功能使用的内容。 |

- [ ] **Step 5: Run the tests** — `npx vitest run src/components/modals && npx tsc --noEmit -p .`; prettier/eslint touched files.

- [ ] **Step 6: Checkpoint** — no commit.

---

### Task 6: Cloud provider table, Apple Speech and System voice pages

**Files:**
- Modify: `src-tauri/src/voice_providers/openrouter.rs` (`LiveModel.pricing`), `src/lib/tauri/voiceProviders.ts`, `voice/ProviderDetail.tsx`
- Create: `voice/CloudModelsView.tsx` (+ css, test), `voice/BuiltInProviderView.tsx` (+ css, test)
- Modify: locale files

**Interfaces:**
- Produces (Rust): `LiveModel` gains `price: Option<String>` — a short human string built from OpenRouter `pricing` (`prompt`, `completion`, per-request/per-second fields when present), e.g. `"$0.62 / 1M chars"` or `"$0.006 / min"`; `None` when absent or zero. Pure fn `format_price(pricing: &serde_json::Value, capability: &str) -> Option<String>` with tests.
- Produces (TS): `VoiceCatalogModel.price?: string`; `CloudModelsView({ provider })`; `BuiltInProviderView({ id: 'apple' | 'system' })`.

Rules:
- `CloudModelsView` uses `ModelTable` with sections stt/tts, columns `['languages','voices','price']` (languages: "—" unless voices encode languages — then count distinct `describeVoice(...).lang`), search above 6 rows, expanded row: voices grouped by language (`sortVoicesForLocale` + `voiceOption` from `voiceLanguages.ts`), and "Use for …" buttons (disabled without a key, title `prefs.voiceWarnNoKey`). Header above the key form: status badge (`cloudStatus`), "In use for: …" (`usesOf`-style for cloud: compare provider+model) and the privacy line.
- `BuiltInProviderView('apple')`: installed locales from `speechNativeLocales()` (installed first), permission status from `speechModelStates()` Apple entry (`denied` → `prefs.dictationNativeDenied` + button `prefs.voiceOpenSystemSettings` that calls the existing open-settings helper if one exists — search `grep -rn "x-apple.systempreferences" src src-tauri/src`; if none exists, show the text only and note it).
- `BuiltInProviderView('system')`: voice count per language from `ttsVoices('system')` grouped with `describeVoice`, and a `Test` button speaking `prefs.voiceTestSentence` via `ttsSpeak` with `{ provider: 'system', model: '', voice: null, rate: 1 }`.

- [ ] **Step 1: Failing tests**
  - Rust (`openrouter.rs`): `format_price` returns `None` for missing/zero pricing and a string for a non-zero prompt price; parsing a model with `pricing` fills `price`.
  - `CloudModelsView.test.tsx`: price column shows "—" when absent; expanded OpenRouter TTS row lists voices grouped by language; Use for Narration writes provider+model.
  - `BuiltInProviderView.test.tsx`: Apple lists installed locales and the denied message; System shows counts per language and Test calls `ttsSpeak` with the system choice.

  Write each test in full following Task 4's patterns.

- [ ] **Step 2: Run to verify they fail** — `cd src-tauri && cargo test --lib openrouter`; `npx vitest run src/components/modals/preferences/voice` → FAIL.

- [ ] **Step 3: Implement** per **Interfaces** and rules; replace the plain model `<ul>` in `ProviderDetail` with `CloudModelsView`, and the `voiceDetailBuiltIn` paragraph with `BuiltInProviderView`. Keep the catalog error + Retry behaviour and its test.

- [ ] **Step 4: i18n keys**

| key | en | pt-BR | zh-CN |
|---|---|---|---|
| `prefs.voiceInUseFor` | In use for: {uses} | Em uso em: {uses} | 用于：{uses} |
| `prefs.voiceNotInUse` | Not in use | Não está em uso | 未使用 |
| `prefs.voiceAppleInstalled` | Installed languages | Idiomas instalados | 已安装的语言 |
| `prefs.voiceOpenSystemSettings` | Open System Settings | Abrir Ajustes do Sistema | 打开系统设置 |
| `prefs.voiceSystemVoicesByLanguage` | Voices by language | Vozes por idioma | 按语言分类的语音 |
| `prefs.voiceSystemTest` | Test | Testar | 试听 |

- [ ] **Step 5: Run the tests** — `cargo test --lib`, `npx vitest run`, `npx tsc --noEmit -p .`; clippy filtered; prettier/eslint touched files.

- [ ] **Step 6: Checkpoint** — no commit.

---

### Task 7: Docs and verification

**Files:** `docs/CHANGELOG.md`, `docs/FEATURES.md`, `docs/VOICE.md`

- [ ] **Step 1: Changelog** — under `[Unreleased]` → `### Added`:

```markdown
- **Clearer voice settings.** Preferences → Voice opens with what each feature uses right now and
  warns when something cannot work (model not downloaded, missing or invalid key, no Apple
  language). Local models are a comparison table — languages, speed, accuracy, size, status — whose
  rows expand into what the model is good for, its limits and "Use for …" buttons. Cloud provider
  pages list their models the same way, with voices by language and prices when the provider
  reports them.
- **Pause and resume model downloads.** A download can be paused and resumed later, even after
  closing Alethe, or cancelled to delete the partial files.
```

- [ ] **Step 2: FEATURES.md and VOICE.md** — update the voice providers / local models sections: the table, tiers ("curated from published benchmarks"), pause semantics (persistent, derived from disk, one download at a time), new commands `speech_pause_download` / `speech_cancel_download` in VOICE.md's command list.

- [ ] **Step 3: Full verification**

```bash
npx vitest run
npx tsc --noEmit -p .
cd src-tauri && cargo test --lib
cargo clippy --lib --message-format=short 2>&1 | grep -E "speech_download.rs|src/speech.rs|voice_providers/"
```

Expected: tests pass; tsc only the 2 pre-existing `Array.at` errors; clippy grep empty for touched lines.

- [ ] **Step 4: Manual pass (owner, in the running app)** — list in the report: download Whisper base, pause at ~30 %, close and reopen Preferences (paused shown), quit and relaunch the app (paused shown), resume (continues), cancel another partial (row back to Not downloaded); Piper shows "Unpacking…"; in-use summary warnings; Compare models filter; cloud page voices and prices.

- [ ] **Step 5: Checkpoint** — no commit.
