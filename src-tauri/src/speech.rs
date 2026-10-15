//! On-device speech-to-text (sherpa-onnx / Parakeet TDT).
//!
//! Models live under `{app_data}/speech-models/{id}/`. Microphone capture uses
//! native cpal (not WebKit getUserMedia) so AppImage/PipeWire still sees devices.

use std::fs::{self, File};
use std::io::Write;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sherpa_onnx::{
    OfflineMoonshineModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::paths::app_data_dir;
use crate::speech_capture::{self, CaptureSession, CapturedAudio, SpeechInputDevice};
use crate::voice_providers::http::{CloudError, CloudErrorKind};
use crate::voice_providers::CloudProvider;

const SAMPLE_RATE: i32 = 16_000;

pub const APPLE_MODEL_ID: &str = "apple-speech";

const APPLE_UNAVAILABLE: &str = "Apple speech recognition is not available in this build.";
const APPLE_NOT_ALLOWED: &str = "Apple speech recognition is not allowed. Turn it on in System Settings → Privacy & Security → Speech Recognition.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelManifest {
    pub id: String,
    pub label: String,
    pub description: String,
    pub language: String,
    pub sample_rate: u32,
    pub size_bytes: u64,
    pub recommended: bool,
    /// `download` for a sherpa model, `native` for the OS engine.
    pub kind: String,
    /// `stt` or `tts`.
    pub capability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelState {
    pub id: String,
    pub status: String,
    pub progress: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    model_id: String,
    downloaded: u64,
    total: u64,
    fraction: f64,
    /// `downloading`, or `verifying` while the SHA-256 of a finished file is checked.
    phase: &'static str,
    file: String,
    /// 1-based position of `file` among the model's files.
    file_index: usize,
    file_count: usize,
}

/// A chunk arrives every few KB; one event per chunk floods the webview with tens of thousands of
/// IPC messages for a 650 MB model and slows the download itself.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Default)]
struct ProgressThrottle {
    last: Option<Instant>,
}

impl ProgressThrottle {
    fn ready(&mut self, now: Instant, force: bool) -> bool {
        let due = self
            .last
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
        if force || due {
            self.last = Some(now);
        }
        force || due
    }
}

/// Where to resume a `.part` file: only one shorter than the expected size is worth continuing.
fn resume_offset(part_len: Option<u64>, expected: u64) -> u64 {
    match part_len {
        Some(len) if len > 0 && len < expected => len,
        _ => 0,
    }
}

struct ModelFile {
    name: &'static str,
    url: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

#[derive(Clone, Copy, Debug)]
enum Layout {
    Transducer {
        model_type: &'static str,
    },
    Whisper {
        encoder: &'static str,
        decoder: &'static str,
        tokens: &'static str,
    },
    Moonshine,
}

struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    language: &'static str,
    layout: Layout,
    recommended: bool,
    files: &'static [ModelFile],
}

/// Same HuggingFace revision + hashes Orca pins for Parakeet TDT v3 int8.
const PARAKEET_V3: CatalogEntry = CatalogEntry {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT v3",
    description: "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
    language: "multilingual",
    layout: Layout::Transducer { model_type: "nemo_transducer" },
    recommended: false,
    files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/encoder.int8.onnx?download=true",
            size_bytes: 652_184_281,
            sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/decoder.int8.onnx?download=true",
            size_bytes: 11_845_275,
            sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/joiner.int8.onnx?download=true",
            size_bytes: 6_355_277,
            sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt?download=true",
            size_bytes: 93_939,
            sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        },
    ],
};

/// Zipformer small, English only: a 26 MB encoder against Parakeet's 622 MB.
const ZIPFORMER_SMALL_EN: CatalogEntry = CatalogEntry {
    id: "zipformer-small-en-int8",
    label: "Zipformer Small (English)",
    description: "English only and roughly twenty times smaller than Parakeet, for the fastest transcription on CPU.",
    language: "en",
    layout: Layout::Transducer { model_type: "transducer" },
    recommended: false,
    files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-small-en-2023-06-26/resolve/e8add5377a6cb7b629b5a0e08d6afe7a73442814/encoder-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 26_015_366,
            sha256: "3a6ac78a31cc2c60ca8c1e2e2f43c878fbbcaf051ada4900e0a42ef8ba53d375",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-small-en-2023-06-26/resolve/e8add5377a6cb7b629b5a0e08d6afe7a73442814/decoder-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 1_307_236,
            sha256: "f462ab9189ba6f9b2658774e6bf3d651913de54a3833655dc5e093e2f5e4c2b6",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-small-en-2023-06-26/resolve/e8add5377a6cb7b629b5a0e08d6afe7a73442814/joiner-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 259_335,
            sha256: "6b183b6ec656e4d3ca6b86d0aeca992dac14df80aae6b416d7c068d0ff2bd4d7",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-zipformer-small-en-2023-06-26/resolve/e8add5377a6cb7b629b5a0e08d6afe7a73442814/tokens.txt?download=true",
            size_bytes: 5_048,
            sha256: "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb",
        },
    ],
};

/// GigaSpeech: podcast and video speech rather than audiobooks, so technical words survive.
const ZIPFORMER_GIGASPEECH: CatalogEntry = CatalogEntry {
    id: "zipformer-gigaspeech-en-int8",
    label: "Zipformer GigaSpeech (English)",
    description: "English only, trained on conversational speech. Nine times smaller than Parakeet and far better than the LibriSpeech model on technical words.",
    language: "en",
    layout: Layout::Transducer { model_type: "transducer" },
    recommended: true,
    files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-gigaspeech-2023-12-12/resolve/8d79d9340119fb44fc06873321cbc10e876cd05d/encoder-epoch-30-avg-1.int8.onnx?download=true",
            size_bytes: 72_850_681,
            sha256: "60d83e92a412b137e89c369d7b99ab00effc3cfedb06bc678041cc4dc7e3d0d6",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-gigaspeech-2023-12-12/resolve/8d79d9340119fb44fc06873321cbc10e876cd05d/decoder-epoch-30-avg-1.int8.onnx?download=true",
            size_bytes: 540_688,
            sha256: "2b0580feb757696fa929922670b7126aaee609630349a1809fd5a2aee926d56e",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-gigaspeech-2023-12-12/resolve/8d79d9340119fb44fc06873321cbc10e876cd05d/joiner-epoch-30-avg-1.int8.onnx?download=true",
            size_bytes: 259_417,
            sha256: "80160e45cca71dd52f6b0a6d3d12be18126f5308b2d4ba03f001300fea377c64",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-zipformer-gigaspeech-2023-12-12/resolve/8d79d9340119fb44fc06873321cbc10e876cd05d/tokens.txt?download=true",
            size_bytes: 5_020,
            sha256: "0ef7d736bf4de3ef947292e4b119ef13f6808cd5f3aec225a843a7135ac1c2ce",
        },
    ],
};

/// Files the Moonshine layout reads; kept for the catalog consistency test.
#[cfg(test)]
const MOONSHINE_FILES: &[&str] = &[
    "preprocess.onnx",
    "encode.int8.onnx",
    "uncached_decode.int8.onnx",
    "cached_decode.int8.onnx",
    "tokens.txt",
];

/// Whisper base, multilingual with language detection. Smaller and less accurate than Parakeet.
const WHISPER_BASE: CatalogEntry = CatalogEntry {
    id: "whisper-base-int8",
    label: "Whisper base",
    description: "Multilingual with automatic language detection, including Portuguese. Fast; less accurate than Parakeet.",
    language: "multilingual",
    layout: Layout::Whisper { encoder: "base-encoder.int8.onnx", decoder: "base-decoder.int8.onnx", tokens: "base-tokens.txt" },
    recommended: false,
    files: &[
        ModelFile {
            name: "base-encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-encoder.int8.onnx?download=true",
            size_bytes: 29_120_534,
            sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
        },
        ModelFile {
            name: "base-decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-decoder.int8.onnx?download=true",
            size_bytes: 130_672_026,
            sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
        },
        ModelFile {
            name: "base-tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc/base-tokens.txt?download=true",
            size_bytes: 816_730,
            sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        },
    ],
};

const WHISPER_SMALL: CatalogEntry = CatalogEntry {
    id: "whisper-small-int8",
    label: "Whisper small",
    description: "Multilingual with automatic language detection. More accurate than Whisper base, slower.",
    language: "multilingual",
    layout: Layout::Whisper { encoder: "small-encoder.int8.onnx", decoder: "small-decoder.int8.onnx", tokens: "small-tokens.txt" },
    recommended: false,
    files: &[
        ModelFile {
            name: "small-encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-encoder.int8.onnx?download=true",
            size_bytes: 112_442_483,
            sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9",
        },
        ModelFile {
            name: "small-decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-decoder.int8.onnx?download=true",
            size_bytes: 262_226_114,
            sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee",
        },
        ModelFile {
            name: "small-tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/8f3c18b358db4d1f2fc1eae49d75cd20989e4309/small-tokens.txt?download=true",
            size_bytes: 816_730,
            sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        },
    ],
};

const MOONSHINE_BASE_EN: CatalogEntry = CatalogEntry {
    id: "moonshine-base-en-int8",
    label: "Moonshine base",
    description: "English only. Very fast on short commands.",
    language: "en",
    layout: Layout::Moonshine,
    recommended: false,
    files: &[
        ModelFile {
            name: "preprocess.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/preprocess.onnx?download=true",
            size_bytes: 14_077_290,
            sha256: "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2",
        },
        ModelFile {
            name: "encode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/encode.int8.onnx?download=true",
            size_bytes: 50_311_494,
            sha256: "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2",
        },
        ModelFile {
            name: "uncached_decode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/uncached_decode.int8.onnx?download=true",
            size_bytes: 122_120_451,
            sha256: "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987",
        },
        ModelFile {
            name: "cached_decode.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/cached_decode.int8.onnx?download=true",
            size_bytes: 99_983_837,
            sha256: "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/052b0798ad1bf046a140fdd4efcd9426530fa3f5/tokens.txt?download=true",
            size_bytes: 436_688,
            sha256: "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea",
        },
    ],
};

const CATALOG: &[CatalogEntry] = &[
    ZIPFORMER_GIGASPEECH,
    ZIPFORMER_SMALL_EN,
    PARAKEET_V3,
    WHISPER_BASE,
    WHISPER_SMALL,
    MOONSHINE_BASE_EN,
];

struct TtsCatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    language: &'static str,
    archive: ModelFile,
    /// Top folder inside the archive; stripped on unpack.
    root: &'static str,
    model_file: &'static str,
}

/// Piper output rate; listed on the manifest only, synthesis reports its own.
const PIPER_SAMPLE_RATE: u32 = 22_050;

/// Piper voices from the sherpa-onnx `tts-models` release; each ships with its espeak-ng data.
/// Kept apart from `CATALOG`, which the STT fallback and transcription read.
const TTS_CATALOG: &[TtsCatalogEntry] = &[
    TtsCatalogEntry {
        id: "piper-pt-br-faber-medium",
        label: "Piper · Faber (pt-BR)",
        description: "Brazilian Portuguese male voice. Runs offline.",
        language: "pt-BR",
        archive: ModelFile {
            name: "vits-piper-pt_BR-faber-medium.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-pt_BR-faber-medium.tar.bz2",
            size_bytes: 67_183_065,
            sha256: "7add3f923ad6bc25ca8a192805fd1a64d1b3893e4611c4a9719545a825039a83",
        },
        root: "vits-piper-pt_BR-faber-medium",
        model_file: "pt_BR-faber-medium.onnx",
    },
    TtsCatalogEntry {
        id: "piper-en-us-amy-low",
        label: "Piper · Amy (en-US)",
        description: "American English female voice. Runs offline.",
        language: "en-US",
        archive: ModelFile {
            name: "vits-piper-en_US-amy-low.tar.bz2",
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2",
            size_bytes: 67_095_344,
            sha256: "c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639",
        },
        root: "vits-piper-en_US-amy-low",
        model_file: "en_US-amy-low.onnx",
    },
];

pub struct SpeechState {
    /// Serializes downloads so two prefs clicks don't race the same folder.
    download_lock: AsyncMutex<()>,
    /// Active native mic capture (stream lives on a dedicated thread).
    capture: Mutex<Option<CaptureSession>>,
    /// Loading the encoder costs hundreds of megabytes of disk read per utterance.
    recognizer: Mutex<Option<(PathBuf, Arc<OfflineRecognizer>)>>,
}

impl Default for SpeechState {
    fn default() -> Self {
        Self {
            download_lock: AsyncMutex::new(()),
            capture: Mutex::new(None),
            recognizer: Mutex::new(None),
        }
    }
}

impl SpeechState {
    fn recognizer_for(
        &self,
        dir: &Path,
        layout: Layout,
    ) -> Result<Arc<OfflineRecognizer>, String> {
        let mut slot = self
            .recognizer
            .lock()
            .map_err(|_| "speech recognizer lock poisoned".to_string())?;
        if let Some((cached_dir, recognizer)) = slot.as_ref() {
            if cached_dir == dir {
                return Ok(Arc::clone(recognizer));
            }
        }
        let recognizer = Arc::new(build_recognizer(dir, layout)?);
        *slot = Some((dir.to_path_buf(), Arc::clone(&recognizer)));
        Ok(recognizer)
    }
}

fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("speech-models"))
}

fn model_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(models_root(app)?.join(id))
}

fn find_entry(id: &str) -> Result<&'static CatalogEntry, String> {
    CATALOG
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("Unknown speech model: {id}"))
}

fn model_ready(dir: &Path, entry: &CatalogEntry) -> bool {
    entry.files.iter().all(|file| dir.join(file.name).is_file())
}

fn entry_size_bytes(entry: &CatalogEntry) -> u64 {
    entry.files.iter().map(|f| f.size_bytes).sum()
}

fn find_tts_entry(id: &str) -> Option<&'static TtsCatalogEntry> {
    TTS_CATALOG.iter().find(|entry| entry.id == id)
}

fn tts_ready(dir: &Path, entry: &TtsCatalogEntry) -> bool {
    dir.join(entry.model_file).is_file()
        && dir.join("tokens.txt").is_file()
        && dir.join("espeak-ng-data").is_dir()
}

/// The unpacked folder of a downloaded voice and its model file, or why it cannot speak yet.
pub(crate) fn local_tts_model(
    app: &AppHandle,
    id: &str,
) -> Result<(PathBuf, &'static str), String> {
    let entry = find_tts_entry(id).ok_or_else(|| format!("Unknown voice model: {id}"))?;
    let dir = model_dir(app, id)?;
    if !tts_ready(&dir, entry) {
        return Err(format!(
            "Voice model '{id}' is not downloaded. Open Preferences → Voice."
        ));
    }
    Ok((dir, entry.model_file))
}

/// Unpacks the files under `root/` into `dest`. Links and special entries are skipped, and a path
/// that would leave `dest` fails the whole archive, so nothing is ever written outside it.
fn extract_tar_bz2(archive: &Path, dest: &Path, root: &str) -> Result<(), String> {
    use std::path::Component;
    let file = File::open(archive).map_err(|e| format!("open archive: {e}"))?;
    let mut tar = tar::Archive::new(bzip2::read::MultiBzDecoder::new(file));
    for entry in tar.entries().map_err(|e| format!("read archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read archive: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("archive path: {e}"))?
            .into_owned();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("archive contains an unsafe path".into());
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            continue;
        }
        let target = dest.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        entry
            .unpack(&target)
            .map_err(|e| format!("unpack {}: {e}", relative.display()))?;
    }
    Ok(())
}

/// Unpacks a downloaded voice next to its archive. Files land in a staging folder first, so an
/// interrupted unpack never leaves a voice that looks ready.
fn install_tts_archive(dir: &Path, entry: &TtsCatalogEntry) -> Result<(), String> {
    let archive = dir.join(entry.archive.name);
    let staging = dir.join("unpack.part");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("create {}: {e}", staging.display()))?;
    extract_tar_bz2(&archive, &staging, entry.root)?;
    let children =
        fs::read_dir(&staging).map_err(|e| format!("read {}: {e}", staging.display()))?;
    for child in children {
        let child = child.map_err(|e| format!("read {}: {e}", staging.display()))?;
        let target = dir.join(child.file_name());
        if target.is_dir() {
            let _ = fs::remove_dir_all(&target);
        } else {
            let _ = fs::remove_file(&target);
        }
        fs::rename(child.path(), &target)
            .map_err(|e| format!("finalize {}: {e}", target.display()))?;
    }
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive);
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1024 * 64];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn catalog_manifests(apple_available: bool) -> Vec<SpeechModelManifest> {
    let mut list: Vec<SpeechModelManifest> = CATALOG
        .iter()
        .map(|entry| SpeechModelManifest {
            id: entry.id.to_string(),
            label: entry.label.to_string(),
            description: entry.description.to_string(),
            language: entry.language.to_string(),
            sample_rate: SAMPLE_RATE as u32,
            size_bytes: entry_size_bytes(entry),
            recommended: entry.recommended,
            kind: "download".to_string(),
            capability: "stt".to_string(),
        })
        .collect();
    list.extend(TTS_CATALOG.iter().map(|entry| SpeechModelManifest {
        id: entry.id.to_string(),
        label: entry.label.to_string(),
        description: entry.description.to_string(),
        language: entry.language.to_string(),
        sample_rate: PIPER_SAMPLE_RATE,
        size_bytes: entry.archive.size_bytes,
        recommended: false,
        kind: "download".to_string(),
        capability: "tts".to_string(),
    }));
    if apple_available {
        list.insert(
            0,
            SpeechModelManifest {
                id: APPLE_MODEL_ID.to_string(),
                label: "Apple (native)".to_string(),
                description: "Apple's on-device speech recognition. Nothing to download; one language at a time.".to_string(),
                language: "single".to_string(),
                sample_rate: SAMPLE_RATE as u32,
                size_bytes: 0,
                recommended: false,
                kind: "native".to_string(),
                capability: "stt".to_string(),
            },
        );
    }
    list
}

#[tauri::command]
pub fn speech_list_models() -> Vec<SpeechModelManifest> {
    catalog_manifests(crate::speech_apple::bridge().is_some())
}

#[tauri::command]
pub async fn speech_native_locales() -> Result<Vec<crate::speech_apple::NativeLocale>, String> {
    let Some(bridge) = crate::speech_apple::bridge() else {
        return Ok(Vec::new());
    };
    tokio::task::spawn_blocking(move || bridge.locales())
        .await
        .map_err(|e| format!("speech worker join: {e}"))
}

#[tauri::command]
pub fn speech_list_input_devices() -> Result<Vec<SpeechInputDevice>, String> {
    speech_capture::list_input_devices()
}

#[tauri::command]
pub async fn speech_model_states(
    app: AppHandle,
    locale: Option<String>,
) -> Result<Vec<SpeechModelState>, String> {
    let root = models_root(&app)?;
    let mut states: Vec<SpeechModelState> = CATALOG
        .iter()
        .map(|entry| {
            let dir = root.join(entry.id);
            let status = if model_ready(&dir, entry) {
                "ready"
            } else {
                "not-downloaded"
            };
            SpeechModelState {
                id: entry.id.to_string(),
                status: status.to_string(),
                progress: None,
                error: None,
            }
        })
        .collect();
    states.extend(TTS_CATALOG.iter().map(|entry| {
        let status = if tts_ready(&root.join(entry.id), entry) {
            "ready"
        } else {
            "not-downloaded"
        };
        SpeechModelState {
            id: entry.id.to_string(),
            status: status.to_string(),
            progress: None,
            error: None,
        }
    }));
    if let Some(bridge) = crate::speech_apple::bridge() {
        let status = tokio::task::spawn_blocking(move || {
            crate::speech_apple::native_status(
                bridge.authorization(),
                &bridge.locales(),
                locale.as_deref(),
            )
        })
        .await
        .map_err(|e| format!("speech worker join: {e}"))?;
        states.insert(
            0,
            SpeechModelState {
                id: APPLE_MODEL_ID.to_string(),
                status: status.to_string(),
                progress: None,
                error: None,
            },
        );
    }
    Ok(states)
}

struct NativeInstallProgress;

impl NativeInstallProgress {
    fn event(model_id: &str, locale: &str, fraction: f64) -> DownloadProgressEvent {
        // The OS reports a fraction, not bytes; 1000 "units" give the bar something to fill.
        let units = 1_000u64;
        let fraction = fraction.clamp(0.0, 1.0);
        DownloadProgressEvent {
            model_id: model_id.to_string(),
            downloaded: (fraction * units as f64) as u64,
            total: units,
            fraction,
            phase: "downloading",
            file: locale.to_string(),
            file_index: 1,
            file_count: 1,
        }
    }
}

/// Installs the on-device assets of one locale, reporting the OS progress like a download.
async fn install_native_locale(
    app: &AppHandle,
    model_id: String,
    locale: Option<String>,
) -> Result<SpeechModelState, String> {
    let bridge = crate::speech_apple::bridge().ok_or_else(|| APPLE_UNAVAILABLE.to_string())?;
    let locale = locale
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Choose a language first.".to_string())?;
    let install_locale = locale.clone();
    let install = tokio::task::spawn_blocking(move || bridge.install(&install_locale));
    tokio::pin!(install);
    let started = Instant::now();
    loop {
        tokio::select! {
            result = &mut install => {
                result.map_err(|e| format!("speech worker join: {e}"))??;
                break;
            }
            _ = tokio::time::sleep(PROGRESS_INTERVAL) => {
                let fraction = bridge.install_progress(&locale).unwrap_or(0.0);
                let _ = app.emit(
                    "speech://download-progress",
                    NativeInstallProgress::event(&model_id, &locale, fraction),
                );
                if started.elapsed() > Duration::from_secs(3_600) {
                    return Err("Installing the language took too long.".to_string());
                }
            }
        }
    }
    Ok(SpeechModelState {
        id: model_id,
        status: "ready".into(),
        progress: Some(1.0),
        error: None,
    })
}

#[tauri::command]
pub async fn speech_download_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    locale: Option<String>,
) -> Result<SpeechModelState, String> {
    if model_id == APPLE_MODEL_ID {
        return install_native_locale(&app, model_id, locale).await;
    }
    let tts_entry = find_tts_entry(&model_id);
    let stt_entry = match tts_entry {
        Some(_) => None,
        None => Some(find_entry(&model_id)?),
    };
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(&app, &model_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    if let Some(entry) = tts_entry {
        if !tts_ready(&dir, entry) {
            download_files(&app, &model_id, &dir, std::slice::from_ref(&entry.archive)).await?;
            let unpack_dir = dir.clone();
            tokio::task::spawn_blocking(move || install_tts_archive(&unpack_dir, entry))
                .await
                .map_err(|e| format!("unpack worker join: {e}"))??;
        }
    } else if let Some(entry) = stt_entry {
        download_files(&app, &model_id, &dir, entry.files).await?;
    }
    Ok(SpeechModelState {
        id: model_id,
        status: "ready".into(),
        progress: Some(1.0),
        error: None,
    })
}

/// Downloads `files` into `dir`, resuming `.part` files and checking each SHA-256.
async fn download_files(
    app: &AppHandle,
    model_id: &str,
    dir: &Path,
    files: &[ModelFile],
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let total: u64 = files.iter().map(|f| f.size_bytes).sum();
    let file_count = files.len();
    let mut downloaded_total = 0u64;
    let mut throttle = ProgressThrottle::default();
    let emit = |phase: &'static str, file: &ModelFile, index: usize, overall: u64| {
        let fraction = if total == 0 {
            0.0
        } else {
            (overall as f64 / total as f64).min(1.0)
        };
        let _ = app.emit(
            "speech://download-progress",
            DownloadProgressEvent {
                model_id: model_id.to_string(),
                downloaded: overall,
                total,
                fraction,
                phase,
                file: file.name.to_string(),
                file_index: index + 1,
                file_count,
            },
        );
    };

    for (index, file) in files.iter().enumerate() {
        let dest = dir.join(file.name);
        if dest.is_file() {
            emit("verifying", file, index, downloaded_total);
            match sha256_file(&dest) {
                Ok(hash) if hash == file.sha256 => {
                    downloaded_total += file.size_bytes;
                    continue;
                }
                _ => {
                    let _ = fs::remove_file(&dest);
                }
            }
        }

        let tmp = dir.join(format!("{}.part", file.name));
        // An interrupted download keeps its `.part`; continue it instead of starting over.
        let offset = resume_offset(fs::metadata(&tmp).ok().map(|m| m.len()), file.size_bytes);
        let mut request = client.get(file.url);
        if offset > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", file.name))?;
        if !response.status().is_success() {
            if offset > 0 {
                let _ = fs::remove_file(&tmp);
            }
            return Err(format!(
                "download {} failed: HTTP {}",
                file.name,
                response.status()
            ));
        }
        let resumed = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

        let mut out = if resumed {
            fs::OpenOptions::new().append(true).open(&tmp)
        } else {
            File::create(&tmp)
        }
        .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        let mut stream = response.bytes_stream();
        let mut file_got = if resumed { offset } else { 0 };
        emit("downloading", file, index, downloaded_total + file_got);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download stream {}: {e}", file.name))?;
            out.write_all(&chunk)
                .map_err(|e| format!("write {}: {e}", file.name))?;
            file_got += chunk.len() as u64;
            if throttle.ready(Instant::now(), false) {
                emit("downloading", file, index, downloaded_total + file_got);
            }
        }
        out.flush().map_err(|e| format!("flush {}: {e}", file.name))?;
        drop(out);

        // Hashing the 650 MB encoder takes seconds; say so instead of sitting at 100%.
        emit("verifying", file, index, downloaded_total + file_got);
        let hash = sha256_file(&tmp)?;
        if hash != file.sha256 {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "checksum mismatch for {}: expected {}, got {}",
                file.name, file.sha256, hash
            ));
        }
        fs::rename(&tmp, &dest).map_err(|e| format!("finalize {}: {e}", file.name))?;
        downloaded_total += file.size_bytes;
    }
    Ok(())
}

#[tauri::command]
pub fn speech_delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    if model_id == APPLE_MODEL_ID {
        return Err("The Apple engine has nothing to delete.".to_string());
    }
    if find_tts_entry(&model_id).is_none() {
        find_entry(&model_id)?;
    }
    let dir = model_dir(&app, &model_id)?;
    crate::tts_local::forget(&dir);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("delete model: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn speech_start_capture(
    state: State<'_, SpeechState>,
    device_id: Option<String>,
) -> Result<(), String> {
    let mut slot = state
        .capture
        .lock()
        .map_err(|_| "speech capture lock poisoned".to_string())?;
    if slot.is_some() {
        return Err("Dictation is already recording".into());
    }
    *slot = Some(speech_capture::start_capture(device_id)?);
    Ok(())
}

#[tauri::command]
pub fn speech_capture_level(state: State<'_, SpeechState>) -> f32 {
    state
        .capture
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|capture| capture.level()))
        .unwrap_or(0.0)
}

#[tauri::command]
pub fn speech_stop_capture(state: State<'_, SpeechState>) -> Result<CapturedAudio, String> {
    stop_capture(&state)
}

fn stop_capture(state: &SpeechState) -> Result<CapturedAudio, String> {
    let mut slot = state
        .capture
        .lock()
        .map_err(|_| "speech capture lock poisoned".to_string())?;
    let capture = slot
        .take()
        .ok_or_else(|| "Dictation is not recording".to_string())?;
    capture.stop()
}

fn decode_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2);
    cores.saturating_sub(1).clamp(2, 8) as i32
}

const HOTWORDS: &[&str] = &[
    "CODEX",
    "CLAUDE",
    "CLAUDE CODE",
    "COPILOT",
    "CURSOR",
    "OPENCODE",
    "TERMINAL",
    "TERMINALS",
    "AGENT",
    "AGENTS",
    "SHELL",
    "IN THE SHELL",
    "SPIN UP",
    "GIT STATUS",
    "RUN THE BUILD",
    "PACKAGE JSON",
    "FRONTEND",
    "BACKEND",
];

fn is_text_vocab(path: &Path) -> bool {
    let Ok(body) = fs::read_to_string(path) else {
        return false;
    };
    body.lines()
        .filter(|line| !line.trim().is_empty())
        .all(|line| line.split_whitespace().count() == 2)
}

fn write_hotwords(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join("hotwords.txt");
    let body = HOTWORDS.join("
");
    fs::write(&path, body).map_err(|e| format!("write hotwords: {e}"))?;
    Ok(path)
}

fn build_recognizer(dir: &Path, layout: Layout) -> Result<OfflineRecognizer, String> {
    let path = |name: &str| -> Result<String, String> {
        let full = dir.join(name);
        if !full.is_file() {
            return Err(format!("missing model file: {}", full.display()));
        }
        Ok(full.to_string_lossy().into_owned())
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = decode_threads();
    config.feat_config.sample_rate = SAMPLE_RATE;
    match layout {
        Layout::Transducer { model_type } => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path("encoder.int8.onnx")?),
                decoder: Some(path("decoder.int8.onnx")?),
                joiner: Some(path("joiner.int8.onnx")?),
            };
            config.model_config.tokens = Some(path("tokens.txt")?);
            config.model_config.model_type = Some(model_type.to_string());

            // Biasing only bites on a BPE model when the vocab is handed over too, and sherpa wants the
            // text vocab, not the sentencepiece model: the binary one takes the process down.
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
        Layout::Whisper { encoder, decoder, tokens } => {
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                // Empty language = detect it per utterance.
                language: Some(String::new()),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                ..Default::default()
            };
            config.model_config.tokens = Some(path(tokens)?);
        }
        Layout::Moonshine => {
            config.model_config.moonshine = OfflineMoonshineModelConfig {
                preprocessor: Some(path("preprocess.onnx")?),
                encoder: Some(path("encode.int8.onnx")?),
                uncached_decoder: Some(path("uncached_decode.int8.onnx")?),
                cached_decoder: Some(path("cached_decode.int8.onnx")?),
                merged_decoder: None,
            };
            config.model_config.tokens = Some(path("tokens.txt")?);
        }
    }

    OfflineRecognizer::create(&config).ok_or_else(|| "failed to create OfflineRecognizer".into())
}

const TRIM_THRESHOLD: f32 = 0.012;
const TRIM_PAD_SAMPLES: usize = (SAMPLE_RATE as usize) / 10;

fn trim_silence(samples: &[f32]) -> &[f32] {
    let loud = |sample: &f32| sample.abs() > TRIM_THRESHOLD;
    let Some(first) = samples.iter().position(loud) else {
        return samples;
    };
    let last = samples.iter().rposition(loud).unwrap_or(samples.len() - 1);
    let start = first.saturating_sub(TRIM_PAD_SAMPLES);
    let end = (last + TRIM_PAD_SAMPLES).min(samples.len() - 1);
    &samples[start..=end]
}

/// Whisper decodes at most 30 s per stream and drops the rest, so longer audio goes in windows.
const WHISPER_WINDOW_SECS: usize = 28;
/// A window ends at the quietest stretch of its last seconds, so words are rarely cut.
const WHISPER_CUT_SEARCH_SECS: usize = 3;
const WHISPER_CUT_SPAN_MS: usize = 200;

/// Contiguous ranges covering `samples`, each at most `WHISPER_WINDOW_SECS` long. Every window but
/// the last ends in the middle of the quietest 200 ms within its last 3 s.
fn whisper_windows(samples: &[f32], rate: u32) -> Vec<Range<usize>> {
    let rate = rate.max(1) as usize;
    let max = WHISPER_WINDOW_SECS * rate;
    let span = (rate * WHISPER_CUT_SPAN_MS / 1000).max(1);
    let step = (span / 2).max(1);
    let mut windows = Vec::new();
    let mut start = 0;
    while samples.len() - start > max {
        let limit = start + max;
        let mut cut = limit;
        let mut quietest = f32::INFINITY;
        let mut from = limit - WHISPER_CUT_SEARCH_SECS * rate;
        while from + span <= limit {
            let energy: f32 = samples[from..from + span].iter().map(|s| s * s).sum();
            if energy < quietest {
                quietest = energy;
                cut = from + span / 2;
            }
            from += step;
        }
        windows.push(start..cut);
        start = cut;
    }
    windows.push(start..samples.len());
    windows
}

fn transcribe_samples(
    recognizer: &OfflineRecognizer,
    samples: &[f32],
    sample_rate: u32,
    whisper: bool,
) -> Result<String, String> {
    let rate = if sample_rate == 0 {
        SAMPLE_RATE
    } else {
        sample_rate as i32
    };
    let trimmed = trim_silence(samples);
    let windows: Vec<Range<usize>> = if whisper {
        whisper_windows(trimmed, rate as u32)
    } else {
        std::iter::once(0..trimmed.len()).collect()
    };
    let mut parts = Vec::with_capacity(windows.len());
    for window in windows {
        let stream = recognizer.create_stream();
        stream.accept_waveform(rate, &trimmed[window]);
        recognizer.decode(&stream);
        let result = stream
            .get_result()
            .ok_or_else(|| "empty speech result".to_string())?;
        let text = result.text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
    }
    Ok(parts.join(" "))
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SttProvider {
    Local,
    Apple,
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl SttProvider {
    /// Callers that predate providers pass only a model id.
    fn infer(provider: Option<SttProvider>, model_id: &str) -> SttProvider {
        provider.unwrap_or(if model_id == APPLE_MODEL_ID {
            Self::Apple
        } else {
            Self::Local
        })
    }

    fn cloud(self) -> Option<CloudProvider> {
        match self {
            Self::Openai => Some(CloudProvider::Openai),
            Self::Elevenlabs => Some(CloudProvider::Elevenlabs),
            Self::Gemini => Some(CloudProvider::Gemini),
            Self::Openrouter => Some(CloudProvider::Openrouter),
            Self::Local | Self::Apple => None,
        }
    }
}

#[derive(Debug)]
enum FallbackStt {
    Apple(String),
    Sherpa(&'static str),
}

/// Apple Speech when ready for a locale, else the first downloaded sherpa model.
fn pick_fallback(
    apple_locale_ready: Option<String>,
    ready_sherpa: &[&'static str],
) -> Option<FallbackStt> {
    if let Some(locale) = apple_locale_ready {
        return Some(FallbackStt::Apple(locale));
    }
    ready_sherpa.first().map(|id| FallbackStt::Sherpa(id))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FallbackEvent {
    usage: String,
    provider: &'static str,
    reason: CloudErrorKind,
    fallback: String,
}

async fn fallback_transcriber(
    app: &AppHandle,
    state: &SpeechState,
    fallback_locale: Option<String>,
) -> Option<(Box<dyn Transcriber>, String)> {
    let apple_ready = match (crate::speech_apple::bridge(), fallback_locale) {
        (Some(bridge), Some(locale)) => {
            let check = locale.clone();
            let ready = tokio::task::spawn_blocking(move || {
                crate::speech_apple::native_status(
                    bridge.authorization(),
                    &bridge.locales(),
                    Some(&check),
                ) == "ready"
            })
            .await
            .unwrap_or(false);
            ready.then_some(locale)
        }
        _ => None,
    };
    let root = models_root(app).ok()?;
    let ready: Vec<&'static str> = CATALOG
        .iter()
        .filter(|entry| model_ready(&root.join(entry.id), entry))
        .map(|entry| entry.id)
        .collect();
    match pick_fallback(apple_ready, &ready)? {
        FallbackStt::Apple(locale) => transcriber_for(app, state, APPLE_MODEL_ID, Some(&locale))
            .ok()
            .map(|t| (t, APPLE_MODEL_ID.to_string())),
        FallbackStt::Sherpa(id) => transcriber_for(app, state, id, None)
            .ok()
            .map(|t| (t, id.to_string())),
    }
}

enum Engine {
    Sherpa(&'static CatalogEntry),
    Apple { locale: String },
}

fn engine_for(
    model_id: &str,
    locale: Option<&str>,
    apple_available: bool,
) -> Result<Engine, String> {
    if model_id != APPLE_MODEL_ID {
        return find_entry(model_id).map(Engine::Sherpa);
    }
    if !apple_available {
        return Err(APPLE_UNAVAILABLE.to_string());
    }
    match locale.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Ok(Engine::Apple {
            locale: id.to_string(),
        }),
        None => Err(
            "Choose the native recognition language in Preferences → Voice."
                .to_string(),
        ),
    }
}

/// Runs on a blocking worker: both engines block for the length of the decode.
trait Transcriber: Send {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String>;
}

struct SherpaTranscriber {
    recognizer: Arc<OfflineRecognizer>,
    whisper: bool,
}

impl Transcriber for SherpaTranscriber {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        transcribe_samples(&self.recognizer, samples, sample_rate, self.whisper)
    }
}

/// Peak under which a failed Apple recognition is treated as silence.
const APPLE_SILENCE_PEAK: f32 = 0.005;

struct AppleTranscriber {
    bridge: &'static dyn crate::speech_apple::AppleBridge,
    locale: String,
}

impl Transcriber for AppleTranscriber {
    fn transcribe(&self, samples: &[f32], sample_rate: u32) -> Result<String, String> {
        if self.bridge.authorization() != crate::speech_apple::Authorization::Authorized {
            return Err(APPLE_NOT_ALLOWED.to_string());
        }
        let rate = if sample_rate == 0 {
            SAMPLE_RATE as u32
        } else {
            sample_rate
        };
        let trimmed = trim_silence(samples);
        // SFSpeechRecognizer reports "no speech" as an error where SpeechAnalyzer returns empty
        // text; make both engines agree that silence is an empty transcript.
        self.bridge
            .transcribe(trimmed, rate, &self.locale)
            .or_else(|error| {
                let peak = trimmed.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
                if peak < APPLE_SILENCE_PEAK {
                    Ok(String::new())
                } else {
                    Err(error)
                }
            })
    }
}

/// The transcriber for a model id, or why it cannot run yet.
fn transcriber_for(
    app: &AppHandle,
    state: &SpeechState,
    model_id: &str,
    locale: Option<&str>,
) -> Result<Box<dyn Transcriber>, String> {
    let bridge = crate::speech_apple::bridge();
    match engine_for(model_id, locale, bridge.is_some())? {
        Engine::Sherpa(entry) => {
            let dir = model_dir(app, model_id)?;
            if !model_ready(&dir, entry) {
                return Err(format!(
                    "Speech model '{model_id}' is not downloaded. Open Preferences → Voice and download it."
                ));
            }
            Ok(Box::new(SherpaTranscriber {
                recognizer: state.recognizer_for(&dir, entry.layout)?,
                whisper: matches!(entry.layout, Layout::Whisper { .. }),
            }))
        }
        Engine::Apple { locale } => Ok(Box::new(AppleTranscriber {
            bridge: bridge.expect("engine_for checked the bridge"),
            locale,
        })),
    }
}

async fn transcribe_on_worker(
    transcriber: Box<dyn Transcriber>,
    samples: Vec<f32>,
    sample_rate: u32,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || transcriber.transcribe(&samples, sample_rate))
        .await
        .map_err(|e| format!("speech worker join: {e}"))?
}

#[tauri::command]
pub async fn speech_prepare(
    app: AppHandle,
    state: State<'_, SpeechState>,
    provider: Option<SttProvider>,
    model_id: String,
    locale: Option<String>,
) -> Result<bool, String> {
    if let Some(cloud) = SttProvider::infer(provider, &model_id).cloud() {
        return Ok(crate::voice_providers::keys::read_key(&app, cloud)?.is_some());
    }
    if model_id == APPLE_MODEL_ID {
        let Some(bridge) = crate::speech_apple::bridge() else {
            return Ok(false);
        };
        return tokio::task::spawn_blocking(move || {
            use crate::speech_apple::{native_status, Authorization};
            if bridge.request_authorization() != Authorization::Authorized {
                return false;
            }
            native_status(
                Authorization::Authorized,
                &bridge.locales(),
                locale.as_deref(),
            ) == "ready"
        })
        .await
        .map_err(|e| format!("speech worker join: {e}"));
    }
    let entry = find_entry(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    if !model_ready(&dir, entry) {
        return Ok(false);
    }
    state.recognizer_for(&dir, entry.layout)?;
    Ok(true)
}

#[tauri::command]
pub async fn speech_stop_and_transcribe(
    app: AppHandle,
    state: State<'_, SpeechState>,
    provider: Option<SttProvider>,
    model_id: String,
    locale: Option<String>,
    fallback_locale: Option<String>,
    usage: Option<String>,
) -> Result<String, String> {
    let audio = stop_capture(&state)?;
    if audio.samples.len() < (SAMPLE_RATE as usize) / 6 {
        return Err("Recording was too short — hold a bit longer, then release.".into());
    }
    if audio.peak < 0.005 {
        return Err(
            "No audio captured. Check the microphone and that PipeWire/PulseAudio can see it."
                .into(),
        );
    }
    let Some(cloud) = SttProvider::infer(provider, &model_id).cloud() else {
        let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
        return transcribe_on_worker(transcriber, audio.samples, audio.sample_rate).await;
    };
    let trimmed = trim_silence(&audio.samples).to_vec();
    // A keychain failure is a cloud failure like any other: the local fallback still runs.
    let error = match crate::voice_providers::keys::read_key(&app, cloud) {
        Err(_) => CloudError::of(CloudErrorKind::Other),
        Ok(Some(key)) => match crate::voice_providers::stt_cloud::transcribe(
            cloud,
            &model_id,
            &key,
            &trimmed,
            audio.sample_rate,
        )
        .await
        {
            Ok(text) => return Ok(text),
            Err(error) => error,
        },
        Ok(None) => CloudError::of(CloudErrorKind::Auth),
    };
    let _ = crate::diagnostics::append_spawn_log(
        &app,
        &format!("voice stt: {} failed: {error}", cloud.id()),
    );
    let Some((transcriber, fallback)) = fallback_transcriber(&app, &state, fallback_locale).await
    else {
        return Err(error.to_string());
    };
    let _ = app.emit(
        "voice://fallback",
        FallbackEvent {
            usage: usage.unwrap_or_else(|| "dictation".into()),
            provider: cloud.id(),
            reason: error.kind,
            fallback,
        },
    );
    transcribe_on_worker(transcriber, audio.samples, audio.sample_rate).await
}

#[tauri::command]
pub async fn speech_transcribe(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    samples: Vec<f32>,
    sample_rate: u32,
    locale: Option<String>,
) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
    transcribe_on_worker(transcriber, samples, sample_rate).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_apple::{AppleBridge, Authorization, NativeLocale};

    #[test]
    fn every_download_is_pinned_and_hashed() {
        for entry in CATALOG {
            for file in entry.files {
                assert!(file.url.starts_with("https://huggingface.co/"), "{}", file.url);
                assert!(!file.url.contains("/resolve/main/"), "unpinned revision: {}", file.url);
                assert_eq!(file.sha256.len(), 64, "{}", file.name);
                assert!(file.size_bytes > 0);
            }
        }
    }

    #[test]
    fn whisper_and_moonshine_entries_ship_the_files_their_layout_reads() {
        let whisper = find_entry("whisper-small-int8").unwrap();
        let Layout::Whisper { encoder, decoder, tokens } = whisper.layout else { panic!("whisper layout") };
        let names: Vec<&str> = whisper.files.iter().map(|f| f.name).collect();
        for needed in [encoder, decoder, tokens] {
            assert!(names.contains(&needed), "{needed}");
        }
        let moonshine = find_entry("moonshine-base-en-int8").unwrap();
        assert!(matches!(moonshine.layout, Layout::Moonshine));
        let names: Vec<&str> = moonshine.files.iter().map(|f| f.name).collect();
        for needed in MOONSHINE_FILES {
            assert!(names.contains(needed), "{needed}");
        }
    }

    #[test]
    fn manifests_say_they_are_speech_to_text() {
        let list = catalog_manifests(false);
        for entry in CATALOG {
            let manifest = list.iter().find(|m| m.id == entry.id).unwrap();
            assert_eq!(manifest.capability, "stt", "{}", entry.id);
        }
    }

    #[test]
    fn piper_archives_are_pinned_releases() {
        for entry in TTS_CATALOG {
            assert!(entry.archive.url.starts_with(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
            ));
            assert_eq!(entry.archive.sha256.len(), 64);
            assert!(entry.model_file.ends_with(".onnx"));
        }
    }

    /// Writes a `.tar.bz2` holding `entries` (name, body) plus any extra headers `add` appends.
    fn write_tar_bz2(
        path: &Path,
        entries: &[(&str, &[u8])],
        add: impl FnOnce(&mut tar::Builder<bzip2::write::BzEncoder<File>>),
    ) {
        use std::io::Write as _;
        let file = File::create(path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *body).unwrap();
        }
        add(&mut builder);
        builder
            .into_inner()
            .unwrap()
            .finish()
            .unwrap()
            .flush()
            .unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("alethe-tar-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("out")).unwrap();
        root
    }

    #[test]
    fn archives_unpack_without_their_top_folder() {
        let root = scratch("unpack");
        let archive_path = root.join("voice.tar.bz2");
        write_tar_bz2(
            &archive_path,
            &[
                ("voice/model.onnx", b"m"),
                ("voice/espeak-ng-data/pt_dict", b"d"),
            ],
            |_| {},
        );
        let dest = root.join("out");
        extract_tar_bz2(&archive_path, &dest, "voice").unwrap();
        assert!(dest.join("model.onnx").is_file());
        assert!(dest.join("espeak-ng-data/pt_dict").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn archives_never_write_outside_their_destination() {
        let root = scratch("escape");
        let archive_path = root.join("voice.tar.bz2");
        write_tar_bz2(&archive_path, &[("voice/model.onnx", b"m")], |builder| {
            let mut symlink = tar::Header::new_gnu();
            symlink.set_entry_type(tar::EntryType::Symlink);
            symlink.set_size(0);
            builder
                .append_link(&mut symlink, "voice/escape", "../../outside")
                .unwrap();
            let mut hardlink = tar::Header::new_gnu();
            hardlink.set_entry_type(tar::EntryType::Link);
            hardlink.set_size(0);
            builder
                .append_link(&mut hardlink, "voice/hard", "/etc/hosts")
                .unwrap();
        });
        let dest = root.join("out");
        extract_tar_bz2(&archive_path, &dest, "voice").unwrap();
        assert!(dest.join("model.onnx").is_file());
        assert!(fs::symlink_metadata(dest.join("escape")).is_err());
        assert!(fs::symlink_metadata(dest.join("hard")).is_err());

        let parent = root.join("parent.tar.bz2");
        {
            // `append_data` refuses `..`, so the unsafe name is written into the header by hand.
            use std::io::Write as _;
            let mut header = tar::Header::new_old();
            header.as_old_mut().name[..12].copy_from_slice(b"voice/../bad");
            header.set_size(1);
            header.set_mode(0o644);
            header.set_cksum();
            let file = File::create(&parent).unwrap();
            let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            builder.append(&header, b"x".as_slice()).unwrap();
            builder
                .into_inner()
                .unwrap()
                .finish()
                .unwrap()
                .flush()
                .unwrap();
        }
        assert!(extract_tar_bz2(&parent, &root.join("out"), "voice").is_err());
        assert!(!root.join("bad").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tts_manifests_are_listed_as_text_to_speech() {
        let list = speech_list_models();
        let tts: Vec<_> = list.iter().filter(|m| m.capability == "tts").collect();
        assert_eq!(tts.len(), TTS_CATALOG.len());
        assert!(tts.iter().all(|m| m.kind == "download" && m.size_bytes > 0));
    }

    #[test]
    fn fallback_order_prefers_apple_with_a_ready_locale() {
        let picked = pick_fallback(Some("pt-BR".into()), &["parakeet-tdt-0.6b-v3-int8"]);
        assert!(matches!(picked, Some(FallbackStt::Apple(locale)) if locale == "pt-BR"));
    }

    #[test]
    fn fallback_order_uses_the_first_ready_sherpa_model() {
        let picked = pick_fallback(None, &["zipformer-small-en-int8", "parakeet-tdt-0.6b-v3-int8"]);
        assert!(matches!(picked, Some(FallbackStt::Sherpa("zipformer-small-en-int8"))));
    }

    #[test]
    fn fallback_order_is_empty_without_local_engines() {
        assert!(pick_fallback(None, &[]).is_none());
    }

    #[test]
    fn provider_defaults_from_the_model_id_for_old_callers() {
        assert_eq!(SttProvider::infer(None, "apple-speech"), SttProvider::Apple);
        assert_eq!(SttProvider::infer(None, "parakeet-tdt-0.6b-v3-int8"), SttProvider::Local);
        assert_eq!(SttProvider::infer(Some(SttProvider::Gemini), "x"), SttProvider::Gemini);
    }

    #[test]
    fn catalog_recommends_exactly_one_downloadable_model() {
        // Which model is recommended is a product choice that changes with the catalogue; the
        // preferences list only needs exactly one of them marked, and every entry to have files.
        let list = speech_list_models();
        assert_eq!(
            list.iter()
                .filter(|model| model.capability == "stt" && model.recommended)
                .count(),
            1
        );
        assert!(list
            .iter()
            .filter(|model| model.kind == "download")
            .all(|model| model.size_bytes > 0));
    }

    #[test]
    fn sherpa_ids_dispatch_to_their_catalog_entry() {
        match engine_for("parakeet-tdt-0.6b-v3-int8", None, true).unwrap() {
            Engine::Sherpa(entry) => assert_eq!(entry.id, "parakeet-tdt-0.6b-v3-int8"),
            Engine::Apple { .. } => panic!("expected sherpa"),
        }
        assert!(engine_for("nope", None, true).is_err());
    }

    #[test]
    fn the_native_engine_needs_the_bridge_and_a_locale() {
        assert!(engine_for(APPLE_MODEL_ID, Some("pt-BR"), false).is_err());
        assert!(engine_for(APPLE_MODEL_ID, None, true).is_err());
        assert!(engine_for(APPLE_MODEL_ID, Some("  "), true).is_err());
        match engine_for(APPLE_MODEL_ID, Some("pt-BR"), true).unwrap() {
            Engine::Apple { locale } => assert_eq!(locale, "pt-BR"),
            Engine::Sherpa(_) => panic!("expected apple"),
        }
    }

    #[test]
    fn the_catalog_lists_the_native_engine_only_with_the_bridge() {
        let with = catalog_manifests(true);
        let native: Vec<_> = with.iter().filter(|m| m.kind == "native").collect();
        assert_eq!(native.len(), 1);
        assert_eq!(native[0].id, APPLE_MODEL_ID);
        assert_eq!(native[0].size_bytes, 0);
        assert!(catalog_manifests(false)
            .iter()
            .all(|m| m.kind == "download"));
    }

    struct FakeBridge {
        auth: Authorization,
        result: Result<String, String>,
    }

    impl AppleBridge for FakeBridge {
        fn authorization(&self) -> Authorization {
            self.auth
        }
        fn request_authorization(&self) -> Authorization {
            self.auth
        }
        fn locales(&self) -> Vec<NativeLocale> {
            Vec::new()
        }
        fn install(&self, _locale: &str) -> Result<(), String> {
            Ok(())
        }
        fn install_progress(&self, _locale: &str) -> Option<f64> {
            None
        }
        fn transcribe(&self, _: &[f32], _: u32, _: &str) -> Result<String, String> {
            self.result.clone()
        }
    }

    fn apple(auth: Authorization, result: Result<String, String>) -> AppleTranscriber {
        AppleTranscriber {
            bridge: Box::leak(Box::new(FakeBridge { auth, result })),
            locale: "pt-BR".into(),
        }
    }

    #[test]
    fn apple_transcription_needs_permission() {
        let speech = vec![0.3f32; 1_600];
        let denied = apple(Authorization::Denied, Ok("oi".into()));
        assert_eq!(
            denied.transcribe(&speech, 16_000),
            Err(APPLE_NOT_ALLOWED.to_string())
        );
        let allowed = apple(Authorization::Authorized, Ok("oi".into()));
        assert_eq!(allowed.transcribe(&speech, 16_000), Ok("oi".to_string()));
    }

    #[test]
    fn apple_no_speech_errors_on_silence_become_empty_text() {
        let failing = apple(Authorization::Authorized, Err("No speech detected".into()));
        assert_eq!(
            failing.transcribe(&[0.001f32; 1_600], 16_000),
            Ok(String::new())
        );
        assert_eq!(
            failing.transcribe(&[0.3f32; 1_600], 16_000),
            Err("No speech detected".to_string())
        );
    }

    #[test]
    fn native_install_progress_maps_a_fraction_to_units() {
        let event = NativeInstallProgress::event(APPLE_MODEL_ID, "pt-BR", 0.25);
        assert_eq!(event.downloaded, 250);
        assert_eq!(event.total, 1_000);
        assert_eq!(event.file, "pt-BR");
        assert_eq!(
            NativeInstallProgress::event(APPLE_MODEL_ID, "pt-BR", 2.0).fraction,
            1.0
        );
    }

    #[test]
    fn progress_is_throttled_but_the_first_and_forced_updates_go_out() {
        let start = Instant::now();
        let mut throttle = ProgressThrottle::default();
        assert!(throttle.ready(start, false));
        assert!(!throttle.ready(start + Duration::from_millis(50), false));
        assert!(throttle.ready(start + Duration::from_millis(60), true));
        assert!(!throttle.ready(start + Duration::from_millis(200), false));
        assert!(throttle.ready(start + PROGRESS_INTERVAL + Duration::from_millis(60), false));
    }

    #[test]
    fn short_audio_is_one_whisper_window() {
        let samples = vec![0.1; 16_000 * 5];
        assert_eq!(whisper_windows(&samples, 16_000), vec![0..samples.len()]);
        assert_eq!(whisper_windows(&[], 16_000), vec![0..0]);
    }

    #[test]
    fn long_audio_is_cut_into_contiguous_windows_of_at_most_28_seconds() {
        let rate = 16_000;
        let samples: Vec<f32> = (0..rate * 70)
            .map(|i| if i % 2 == 0 { 0.3 } else { -0.3 })
            .collect();
        let windows = whisper_windows(&samples, rate as u32);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].start, 0);
        assert_eq!(windows.last().unwrap().end, samples.len());
        for pair in windows.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "contiguous");
        }
        assert!(windows
            .iter()
            .all(|w| w.len() <= rate * 28 && !w.is_empty()));
    }

    #[test]
    fn whisper_windows_cut_in_the_quietest_stretch() {
        let rate = 16_000;
        let mut samples: Vec<f32> = (0..rate * 40)
            .map(|i| if i % 2 == 0 { 0.3 } else { -0.3 })
            .collect();
        let quiet = rate * 26..rate * 26 + rate / 2;
        samples[quiet.clone()].fill(0.0);
        let windows = whisper_windows(&samples, rate as u32);
        assert_eq!(windows.len(), 2);
        assert!(
            quiet.contains(&windows[0].end),
            "cut at {} not in {quiet:?}",
            windows[0].end
        );
    }

    #[test]
    fn only_a_partial_file_shorter_than_expected_is_resumed() {
        assert_eq!(resume_offset(None, 100), 0);
        assert_eq!(resume_offset(Some(0), 100), 0);
        assert_eq!(resume_offset(Some(40), 100), 40);
        assert_eq!(resume_offset(Some(100), 100), 0);
        assert_eq!(resume_offset(Some(140), 100), 0);
    }
}
