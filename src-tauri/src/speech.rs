//! On-device speech-to-text (sherpa-onnx / Parakeet TDT).
//!
//! Models live under `{app_data}/speech-models/{id}/`. Microphone capture uses
//! native cpal (not WebKit getUserMedia) so AppImage/PipeWire still sees devices.

use std::fs::{self, File};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sherpa_onnx::OfflineRecognizer;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::paths::app_data_dir;
use crate::speech_capture::{self, CaptureSession, CapturedAudio, SpeechInputDevice};
use crate::speech_download::{self, ActiveDownload, DownloadFlags, WriteOutcome};
use crate::speech_layout::SttLayout;
use crate::speech_vad::{VadMonitor, VadStatus};
use crate::voice_providers::http::{CloudError, CloudErrorKind};
use crate::voice_providers::CloudProvider;

pub(crate) const SAMPLE_RATE: i32 = 16_000;

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
    /// `catalog` or `huggingface`.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<crate::speech_hub::HubModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelState {
    pub id: String,
    /// `ready`, `downloading`, `paused`, `not-downloaded`, or a native engine status.
    pub status: String,
    pub progress: Option<f64>,
    pub error: Option<String>,
    /// Bytes on disk (finished files plus `.part` sizes); `None` for the native engine.
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    model_id: String,
    downloaded: u64,
    total: u64,
    fraction: f64,
    /// `downloading`, `verifying` while the SHA-256 of a finished file is checked, `unpacking`
    /// while a voice archive is installed, or `paused` once a pause has landed.
    phase: &'static str,
    file: String,
    /// 1-based position of `file` among the model's files.
    file_index: usize,
    file_count: usize,
}

/// A chunk arrives every few KB; one event per chunk floods the webview with tens of thousands of
/// IPC messages for a 650 MB model and slows the download itself.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// Longest wait for the next bytes of a model download before it fails (and can be resumed).
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);

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

/// A `.part` as long as the file it stands for (a pause on the last chunk) needs no request:
/// it goes straight to verification.
fn part_is_complete(part_len: Option<u64>, expected: u64) -> bool {
    expected > 0 && part_len == Some(expected)
}

/// A resumed request continues the `.part` only when the server honored the `Range` header.
fn should_append(offset: u64, status: reqwest::StatusCode) -> bool {
    offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT
}

struct ModelFile {
    name: &'static str,
    url: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

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

fn hub_download_files(
    repo: &str,
    commit: &str,
    files: &[crate::speech_hub::detect::RepoFile],
) -> Result<Vec<DownloadFile>, String> {
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
    let len = fs::metadata(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?
        .len();
    let mut file = File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {len}\0").as_bytes());
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
            Layout::Whisper {
                encoder,
                decoder,
                tokens,
            } => SttLayout::Whisper {
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

const VAD_DIR: &str = "silero-vad";
const VAD_FILE: ModelFile = ModelFile {
    name: "silero_vad.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    size_bytes: 643_854,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

pub struct SpeechState {
    /// Serializes downloads so two prefs clicks don't race the same folder.
    download_lock: AsyncMutex<()>,
    /// Stop flag of the active download, read by pause and cancel.
    downloads: DownloadFlags,
    /// Active native mic capture (stream lives on a dedicated thread).
    capture: Mutex<Option<CaptureSession>>,
    /// Loading the encoder costs hundreds of megabytes of disk read per utterance.
    recognizer: Mutex<Option<(PathBuf, Arc<OfflineRecognizer>)>>,
    vad: Mutex<Option<VadMonitor>>,
}

impl Default for SpeechState {
    fn default() -> Self {
        Self {
            download_lock: AsyncMutex::new(()),
            downloads: DownloadFlags::default(),
            capture: Mutex::new(None),
            recognizer: Mutex::new(None),
            vad: Mutex::new(None),
        }
    }
}

impl SpeechState {
    fn recognizer_for(
        &self,
        dir: &Path,
        layout: &SttLayout,
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
    let root = models_root(app)?;
    if installed::repo_of(id).is_some() {
        return installed::dir_name(id)
            .map(|name| root.join(name))
            .ok_or_else(|| format!("Unknown speech model: {id}"));
    }
    Ok(root.join(id))
}

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
        return installed::dir_name(id)
            .map(|_| ReadyCheck::Hub)
            .ok_or_else(|| format!("Unknown speech model: {id}"));
    }
    if let Some(entry) = find_tts_entry(id) {
        return Ok(ReadyCheck::Tts(entry));
    }
    find_entry(id).map(ReadyCheck::Stt)
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

/// What a downloaded Hugging Face model that sherpa cannot load reports.
const HUB_INCOMPATIBLE: &str = "This model cannot run in Alethe. Remove it in Preferences → Voice.";

/// A Hugging Face model that fails to load reads as incompatible; a catalog model keeps the
/// engine's own error.
fn load_error(model_id: &str, error: String) -> String {
    if installed::repo_of(model_id).is_some() {
        HUB_INCOMPATIBLE.to_string()
    } else {
        error
    }
}

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
            Some(HubLayout::Tts(_)) => Err(format!(
                "'{model_id}' is a voice, not a speech recognition model."
            )),
            None => Err(not_downloaded(model_id)),
        };
    }
    let entry = find_entry(model_id)?;
    if !model_ready(&dir, entry) {
        return Err(not_downloaded(model_id));
    }
    Ok((dir, SttLayout::from(entry.layout)))
}

/// The unpacked folder of a downloaded voice and how to load it, or why it cannot speak yet.
pub(crate) fn local_tts_model(
    app: &AppHandle,
    id: &str,
) -> Result<(PathBuf, crate::tts_local::TtsLayout), String> {
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
/// single-voice model or a voice that is not downloaded. Only a voice whose speakers are not
/// named is loaded (on a worker), to count them.
pub(crate) async fn local_tts_voices(
    app: &AppHandle,
    id: &str,
) -> Vec<crate::speech_hub::meta::HubVoice> {
    let Ok((dir, layout)) = local_tts_model(app, id) else {
        return Vec::new();
    };
    let meta = ready_manifest(&dir).map(|m| m.meta).unwrap_or_default();
    if let Some(voices) = crate::speech_hub::meta::known_voices(&meta) {
        return voices;
    }
    let reported =
        tokio::task::spawn_blocking(move || crate::tts_local::num_speakers(&dir, &layout))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(1);
    crate::speech_hub::meta::voice_list(&[], reported)
}

/// The language tag of speaker `sid` of a downloaded Hugging Face voice, when its manifest
/// names it; `None` for a catalog voice or an unknown speaker.
pub(crate) fn local_tts_language(app: &AppHandle, id: &str, sid: i32) -> Option<String> {
    installed::repo_of(id)?;
    let manifest = ready_manifest(&model_dir(app, id).ok()?)?;
    crate::speech_hub::meta::speaker_language(&manifest.meta, sid).map(str::to_string)
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
            source: "catalog".to_string(),
            hub: None,
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
        source: "catalog".to_string(),
        hub: None,
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
                source: "catalog".to_string(),
                hub: None,
            },
        );
    }
    list
}

fn hub_manifest_view(manifest: &HubManifest) -> SpeechModelManifest {
    SpeechModelManifest {
        id: manifest.id.clone(),
        label: manifest.meta.label.clone(),
        description: String::new(),
        language: manifest.meta.languages.join(","),
        sample_rate: if manifest.family.is_tts() {
            0
        } else {
            SAMPLE_RATE as u32
        },
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
        list.extend(
            installed::list(&root)
                .iter()
                .map(|(_, manifest)| hub_manifest_view(manifest)),
        );
    }
    list
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
    state: State<'_, SpeechState>,
    locale: Option<String>,
) -> Result<Vec<SpeechModelState>, String> {
    let root = models_root(&app)?;
    let mut states: Vec<SpeechModelState> = CATALOG
        .iter()
        .map(|entry| {
            let dir = root.join(entry.id);
            let files: Vec<(&str, u64)> = entry
                .files
                .iter()
                .map(|file| (file.name, file.size_bytes))
                .collect();
            let disk = speech_download::disk_state(&dir, &files, model_ready(&dir, entry));
            disk_model_state(&state.downloads, entry.id, disk, entry_size_bytes(entry))
        })
        .collect();
    states.extend(TTS_CATALOG.iter().map(|entry| {
        let dir = root.join(entry.id);
        let archive = [(entry.archive.name, entry.archive.size_bytes)];
        let disk = speech_download::disk_state(&dir, &archive, tts_ready(&dir, entry));
        disk_model_state(&state.downloads, entry.id, disk, entry.archive.size_bytes)
    }));
    states.extend(installed::list(&root).into_iter().map(|(dir, manifest)| {
        let files: Vec<(&str, u64)> = manifest
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.size))
            .collect();
        let disk = speech_download::disk_state(&dir, &files, installed::is_ready(&dir, &manifest));
        disk_model_state(&state.downloads, &manifest.id, disk, manifest.total_bytes())
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
                downloaded_bytes: None,
                total_bytes: None,
            },
        );
    }
    Ok(states)
}

/// The state of a downloadable model: what is on disk, or `downloading` while its download runs.
fn disk_model_state(
    downloads: &DownloadFlags,
    id: &str,
    disk: speech_download::DiskState,
    total: u64,
) -> SpeechModelState {
    let status = if downloads.is_active(id) {
        "downloading"
    } else {
        disk.status
    };
    SpeechModelState {
        id: id.to_string(),
        status: status.to_string(),
        progress: None,
        error: None,
        downloaded_bytes: Some(disk.downloaded_bytes),
        total_bytes: Some(total),
    }
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
        downloaded_bytes: None,
        total_bytes: None,
    })
}

#[tauri::command]
pub async fn speech_download_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    hub: State<'_, crate::speech_hub::HubState>,
    model_id: String,
    locale: Option<String>,
) -> Result<SpeechModelState, String> {
    if model_id == APPLE_MODEL_ID {
        return install_native_locale(&app, model_id, locale).await;
    }
    if installed::repo_of(&model_id).is_some() {
        return download_hub_model(&app, &state, &hub, &model_id).await;
    }
    let tts_entry = find_tts_entry(&model_id);
    let stt_entry = match tts_entry {
        Some(_) => None,
        None => Some(find_entry(&model_id)?),
    };
    let stop = state.downloads.start(&model_id)?;
    // Clears the flag on every exit: done, paused, failed, or the command future dropped.
    let _active = ActiveDownload::new(&state.downloads, &model_id);
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(&app, &model_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    let client = download_client()?;
    let total_bytes = match (tts_entry, stt_entry) {
        (Some(entry), _) => entry.archive.size_bytes,
        (None, Some(entry)) => entry_size_bytes(entry),
        (None, None) => 0,
    };
    if let Some(entry) = tts_entry {
        if !tts_ready(&dir, entry) {
            let files = [DownloadFile::from(&entry.archive)];
            download_files(&app, &client, &model_id, &dir, &files, &stop).await?;
            // The stop flag is no longer read: a pause or cancel waits for the unpack to finish.
            let _ = app.emit(
                "speech://download-progress",
                DownloadProgressEvent {
                    model_id: model_id.clone(),
                    downloaded: total_bytes,
                    total: total_bytes,
                    fraction: 1.0,
                    phase: "unpacking",
                    file: entry.archive.name.to_string(),
                    file_index: 1,
                    file_count: 1,
                },
            );
            let unpack_dir = dir.clone();
            tokio::task::spawn_blocking(move || install_tts_archive(&unpack_dir, entry))
                .await
                .map_err(|e| format!("unpack worker join: {e}"))??;
        }
    } else if let Some(entry) = stt_entry {
        let files: Vec<DownloadFile> = entry.files.iter().map(DownloadFile::from).collect();
        download_files(&app, &client, &model_id, &dir, &files, &stop).await?;
    }
    Ok(SpeechModelState {
        id: model_id.clone(),
        status: "ready".into(),
        progress: Some(1.0),
        error: None,
        downloaded_bytes: Some(total_bytes),
        total_bytes: Some(total_bytes),
    })
}

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
        installed::write(
            &dir,
            &HubManifest {
                complete: false,
                ..manifest.clone()
            },
        )?;
        let files = hub_download_files(&manifest.repo, &manifest.commit, &manifest.files)?;
        let client = crate::speech_hub::hf::client()?;
        if let Err(error) = download_files(app, &client, model_id, &dir, &files, &stop).await {
            return Err(match hub_file_error(&error) {
                Some(code) if code == crate::speech_hub::hf::UNKNOWN_REPO => {
                    // The pinned commit is gone: drop the folder and the cached resolve so a new
                    // download starts from the repo as it is now.
                    let _ = fs::remove_dir_all(&dir);
                    hub.forget(&manifest.repo);
                    code.to_string()
                }
                Some(code) => code.to_string(),
                None => error,
            });
        }
        installed::write(
            &dir,
            &HubManifest {
                complete: true,
                ..manifest.clone()
            },
        )?;
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

/// Asks the active download of `model_id` to stop after its current chunk; `false` when idle.
#[tauri::command]
pub fn speech_pause_download(state: State<'_, SpeechState>, model_id: String) -> bool {
    state.downloads.stop(&model_id)
}

/// Stops the download of `model_id` and, when the model is not ready, deletes its folder so it
/// reads as `not-downloaded`. A ready model is untouched. Only that model's own download is
/// waited for (through a verify or unpack phase too); another model's download is not.
#[tauri::command]
pub async fn speech_cancel_download(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<(), String> {
    let check = ready_check(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    speech_download::cancel_download(
        &state.downloads,
        &state.download_lock,
        &model_id,
        &dir,
        move |dir| check.is_ready(dir),
    )
    .await
    .map_err(|e| format!("cancel download: {e}"))
}

/// The error of a file request the server refused.
fn http_failure(name: &str, status: reqwest::StatusCode) -> String {
    format!("download {name} failed: HTTP {status}")
}

/// The Hugging Face code for a refused file request: a missing file means the pinned commit is
/// gone, too many requests is a rate limit. `None` keeps the error as it is.
fn hub_file_error(error: &str) -> Option<&'static str> {
    let status = error.split_once(" failed: HTTP ")?.1;
    match status.split(' ').next()? {
        "404" => Some(crate::speech_hub::hf::UNKNOWN_REPO),
        "429" => Some(crate::speech_hub::hf::RATE_LIMITED),
        _ => None,
    }
}

/// Downloads `files` into `dir`, resuming `.part` files and checking each SHA-256.
async fn download_files(
    app: &AppHandle,
    client: &reqwest::Client,
    model_id: &str,
    dir: &Path,
    files: &[DownloadFile],
    stop: &AtomicBool,
) -> Result<(), String> {
    let total: u64 = files.iter().map(|f| f.size_bytes).sum();
    let file_count = files.len();
    let mut downloaded_total = 0u64;
    let mut throttle = ProgressThrottle::default();
    let emit = |phase: &'static str, file: &DownloadFile, index: usize, overall: u64| {
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
                file: file.name.clone(),
                file_index: index + 1,
                file_count,
            },
        );
    };

    for (index, file) in files.iter().enumerate() {
        let dest = dir.join(&file.name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        if dest.is_file() {
            if file.size_bytes >= QUIET_VERIFY_BYTES {
                emit("verifying", file, index, downloaded_total);
            }
            match verify(&dest, &file.check) {
                Ok(true) => {
                    downloaded_total += file.size_bytes;
                    continue;
                }
                _ => {
                    let _ = fs::remove_file(&dest);
                }
            }
        }

        let tmp = dir.join(format!("{}.part", file.name));
        let part_len = fs::metadata(&tmp).ok().map(|m| m.len());
        let file_got = if part_is_complete(part_len, file.size_bytes) {
            file.size_bytes
        } else {
            // An interrupted download keeps its `.part`; continue it instead of starting over.
            let offset = resume_offset(part_len, file.size_bytes);
            let mut request = client.get(&file.url);
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
                return Err(http_failure(&file.name, response.status()));
            }
            let resumed = should_append(offset, response.status());

            let mut out = if resumed {
                fs::OpenOptions::new().append(true).open(&tmp)
            } else {
                File::create(&tmp)
            }
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
            let start = if resumed { offset } else { 0 };
            emit("downloading", file, index, downloaded_total + start);
            // Only this loop reads `stop`; verification and the rename below always run to the end.
            let outcome =
                speech_download::write_stream(response.bytes_stream(), &mut out, stop, |got| {
                    if throttle.ready(Instant::now(), false) {
                        emit("downloading", file, index, downloaded_total + start + got);
                    }
                })
                .await
                .map_err(|e| format!("{e} ({})", file.name))?;
            drop(out);
            match outcome {
                WriteOutcome::Done(got) => start + got,
                WriteOutcome::Paused(got) => {
                    emit("paused", file, index, downloaded_total + start + got);
                    return Err(speech_download::PAUSED.into());
                }
            }
        };

        if file.size_bytes >= QUIET_VERIFY_BYTES || throttle.ready(Instant::now(), false) {
            // Hashing the 650 MB encoder takes seconds; say so instead of sitting at 100%.
            emit("verifying", file, index, downloaded_total + file_got);
        }
        if !verify(&tmp, &file.check)? {
            let _ = fs::remove_file(&tmp);
            return Err(format!("checksum mismatch for {}", file.name));
        }
        fs::rename(&tmp, &dest).map_err(|e| format!("finalize {}: {e}", file.name))?;
        downloaded_total += file.size_bytes;
    }
    Ok(())
}

#[tauri::command]
pub fn speech_delete_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<(), String> {
    if model_id == APPLE_MODEL_ID {
        return Err("The Apple engine has nothing to delete.".to_string());
    }
    ready_check(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    crate::tts_local::forget(&dir);
    // The cached recognizer holds the model's files open (Windows refuses to delete them).
    crate::tts_local::forget_in(
        &mut state.recognizer.lock().unwrap_or_else(|e| e.into_inner()),
        &dir,
    );
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("delete model: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn speech_start_capture(
    app: AppHandle,
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
    let monitor = vad_model_path(&app)
        .ok()
        .filter(|path| path.is_file())
        .and_then(|path| VadMonitor::new(&path).ok());
    if let Ok(mut vad) = state.vad.lock() {
        *vad = monitor;
    }
    Ok(())
}

fn vad_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(models_root(app)?.join(VAD_DIR).join(VAD_FILE.name))
}

#[tauri::command]
pub async fn speech_prepare_vad(app: AppHandle) -> Result<bool, String> {
    let path = vad_model_path(&app)?;
    if path.is_file() {
        return Ok(true);
    }
    let dir = models_root(&app)?.join(VAD_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("create vad dir: {e}"))?;
    let files = [DownloadFile::from(&VAD_FILE)];
    let client = download_client()?;
    download_files(
        &app,
        &client,
        VAD_DIR,
        &dir,
        &files,
        &AtomicBool::new(false),
    )
    .await?;
    Ok(true)
}

#[tauri::command]
pub fn speech_vad_status(state: State<'_, SpeechState>) -> Option<VadStatus> {
    let capture = state.capture.lock().ok()?;
    let capture = capture.as_ref()?;
    let mut vad = state.vad.lock().ok()?;
    Some(vad.as_mut()?.poll(capture))
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

pub(crate) fn stop_capture(state: &SpeechState) -> Result<CapturedAudio, String> {
    let mut slot = state
        .capture
        .lock()
        .map_err(|_| "speech capture lock poisoned".to_string())?;
    let capture = slot
        .take()
        .ok_or_else(|| "Dictation is not recording".to_string())?;
    if let Ok(mut vad) = state.vad.lock() {
        *vad = None;
    }
    capture.stop()
}

fn decode_threads() -> i32 {
    let cores = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2);
    cores.saturating_sub(1).clamp(2, 8) as i32
}

pub(crate) const HOTWORDS: &[&str] = &[
    "CODEX",
    "CLAUDE",
    "CLAUDE CODE",
    "COPILOT",
    "CURSOR",
    "OPENCODE",
    "TERMINAL",
    "TERMINALS",
    "OPEN TWO TERMINALS",
    "OPEN THREE TERMINALS",
    "OPEN UP TWO TERMINALS",
    "OPEN UP THREE TERMINALS",
    "AGENT",
    "AGENTS",
    "TERMINAL ONE",
    "TERMINAL TWO",
    "TERMINAL THREE",
    "AGENT ONE",
    "AGENT TWO",
    "AGENT THREE",
    "FIRST TERMINAL",
    "SECOND TERMINAL",
    "THIRD TERMINAL",
    "SHELL",
    "IN THE SHELL",
    "SPIN UP",
    "GIT STATUS",
    "RUN THE BUILD",
    "SEND IT",
    "THANKS JEV",
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
    let body = HOTWORDS.join(
        "
",
    );
    fs::write(&path, body).map_err(|e| format!("write hotwords: {e}"))?;
    Ok(path)
}

fn build_recognizer(dir: &Path, layout: &SttLayout) -> Result<OfflineRecognizer, String> {
    let mut config =
        crate::speech_layout::recognizer_config(dir, layout, decode_threads(), SAMPLE_RATE)?;
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

const TRIM_THRESHOLD: f32 = 0.012;
const TRIM_PAD_SAMPLES: usize = (SAMPLE_RATE as usize) / 10;

pub(crate) fn trim_silence(samples: &[f32]) -> &[f32] {
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
    Sherpa(String),
}

/// Apple Speech when ready for a locale, else the first downloaded sherpa model.
fn pick_fallback(
    apple_locale_ready: Option<String>,
    ready_sherpa: &[String],
) -> Option<FallbackStt> {
    if let Some(locale) = apple_locale_ready {
        return Some(FallbackStt::Apple(locale));
    }
    ready_sherpa
        .first()
        .map(|id| FallbackStt::Sherpa(id.clone()))
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
    match pick_fallback(apple_ready, &ready)? {
        FallbackStt::Apple(locale) => transcriber_for(app, state, APPLE_MODEL_ID, Some(&locale))
            .ok()
            .map(|t| (t, APPLE_MODEL_ID.to_string())),
        FallbackStt::Sherpa(id) => transcriber_for(app, state, &id, None).ok().map(|t| (t, id)),
    }
}

enum Engine {
    Local,
    Apple { locale: String },
}

fn engine_for(
    model_id: &str,
    locale: Option<&str>,
    apple_available: bool,
) -> Result<Engine, String> {
    if model_id != APPLE_MODEL_ID {
        if installed::repo_of(model_id).is_none() {
            find_entry(model_id)?;
        }
        return Ok(Engine::Local);
    }
    if !apple_available {
        return Err(APPLE_UNAVAILABLE.to_string());
    }
    match locale.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Ok(Engine::Apple {
            locale: id.to_string(),
        }),
        None => Err("Choose the native recognition language in Preferences → Voice.".to_string()),
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
        Engine::Local => {
            let (dir, layout) = local_stt(app, model_id)?;
            Ok(Box::new(SherpaTranscriber {
                recognizer: state
                    .recognizer_for(&dir, &layout)
                    .map_err(|e| load_error(model_id, e))?,
                whisper: layout.is_whisper(),
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
        return Ok(crate::voice_providers::keys::read_key_async(&app, cloud)
            .await?
            .is_some());
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
    if installed::repo_of(&model_id).is_none() {
        find_entry(&model_id)?;
    }
    match local_stt(&app, &model_id) {
        Ok((dir, layout)) => {
            state
                .recognizer_for(&dir, &layout)
                .map_err(|e| load_error(&model_id, e))?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// The error a recording too short to transcribe ends with (usually a quick tap of the shortcut);
/// the frontend matches it to show a hint instead of a failure.
pub const SPEECH_TOO_SHORT: &str = "speech_too_short";

fn check_recording_length(samples: usize) -> Result<(), String> {
    if samples < (SAMPLE_RATE as usize) / 6 {
        return Err(SPEECH_TOO_SHORT.to_string());
    }
    Ok(())
}

pub(crate) fn validate_capture(audio: &CapturedAudio) -> Result<(), String> {
    check_recording_length(audio.samples.len())?;
    if audio.peak < 0.005 {
        return Err(
            "No audio captured. Check the microphone and that PipeWire/PulseAudio can see it."
                .into(),
        );
    }
    Ok(())
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
    validate_capture(&audio)?;
    let Some(cloud) = SttProvider::infer(provider, &model_id).cloud() else {
        let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
        return transcribe_on_worker(transcriber, audio.samples, audio.sample_rate).await;
    };
    let trimmed = trim_silence(&audio.samples).to_vec();
    // A keychain failure is a cloud failure like any other: the local fallback still runs.
    let error = match crate::voice_providers::keys::read_key_async(&app, cloud).await {
        Err(_) => CloudError::of(CloudErrorKind::Other),
        Ok(Some(key)) => {
            match transcribe_cloud(cloud, &model_id, &key, &trimmed, audio.sample_rate).await {
                Ok(text) => return Ok(text),
                Err(error) => error,
            }
        }
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

/// OpenRouter's chat audio models answer through chat completions; every other cloud model
/// through its provider's transcription endpoint.
async fn transcribe_cloud(
    cloud: CloudProvider,
    model_id: &str,
    key: &str,
    samples: &[f32],
    sample_rate: u32,
) -> Result<String, CloudError> {
    if cloud == CloudProvider::Openrouter && crate::speech_cloud::is_chat_audio_model(model_id) {
        return crate::speech_cloud::transcribe_with_chat_model(
            key,
            model_id,
            samples,
            sample_rate,
        )
        .await
        .map_err(|message| {
            eprintln!("[speech] OpenRouter chat transcription failed: {message}");
            CloudError::of(CloudErrorKind::Other)
        });
    }
    crate::voice_providers::stt_cloud::transcribe(cloud, model_id, key, samples, sample_rate).await
}

/// Decodes a sliding tail window so a spoken send phrase is never split across chunks.
#[tauri::command]
pub async fn speech_transcribe_partial(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
    locale: Option<String>,
) -> Result<String, String> {
    let transcriber = transcriber_for(&app, &state, &model_id, locale.as_deref())?;
    let samples = {
        let slot = state
            .capture
            .lock()
            .map_err(|_| "speech capture lock poisoned".to_string())?;
        let session = slot
            .as_ref()
            .ok_or_else(|| "Dictation is not recording".to_string())?;
        session.snapshot()
    };
    let window = partial_window(&samples).to_vec();
    if window.len() < (SAMPLE_RATE as usize) / 4 {
        return Ok(String::new());
    }
    transcribe_on_worker(transcriber, window, SAMPLE_RATE as u32).await
}

const PARTIAL_WINDOW_SECONDS: usize = 3;

fn partial_window(samples: &[f32]) -> &[f32] {
    let window = SAMPLE_RATE as usize * PARTIAL_WINDOW_SECONDS;
    &samples[samples.len().saturating_sub(window)..]
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
                assert!(
                    file.url.starts_with("https://huggingface.co/"),
                    "{}",
                    file.url
                );
                assert!(
                    !file.url.contains("/resolve/main/"),
                    "unpinned revision: {}",
                    file.url
                );
                assert_eq!(file.sha256.len(), 64, "{}", file.name);
                assert!(file.size_bytes > 0);
            }
        }
    }

    #[test]
    fn whisper_and_moonshine_entries_ship_the_files_their_layout_reads() {
        let whisper = find_entry("whisper-small-int8").unwrap();
        let Layout::Whisper {
            encoder,
            decoder,
            tokens,
        } = whisper.layout
        else {
            panic!("whisper layout")
        };
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
    fn git_blob_sha1_matches_git() {
        let path = std::env::temp_dir().join(format!("alethe-blob-{}", std::process::id()));
        std::fs::write(&path, b"hello\n").unwrap();
        // `printf 'hello\n' | git hash-object --stdin`
        assert_eq!(
            git_blob_sha1(&path).unwrap(),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
        assert!(verify(
            &path,
            &Check::GitSha1("ce013625030ba8dba906f756967f9e9ca394464a".into())
        )
        .unwrap());
        assert!(!verify(&path, &Check::Sha256("0".repeat(64))).unwrap());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn hub_files_become_download_files_with_their_checks() {
        let files = vec![
            crate::speech_hub::detect::RepoFile {
                path: "a.onnx".into(),
                size: 5,
                sha256: Some("f".repeat(64)),
                git_sha1: None,
            },
            crate::speech_hub::detect::RepoFile {
                path: "espeak-ng-data/x".into(),
                size: 2,
                sha256: None,
                git_sha1: Some("e".repeat(40)),
            },
        ];
        let out = hub_download_files("csukuangfj/r", &"c".repeat(40), &files).unwrap();
        assert_eq!(
            out[0].url,
            format!(
                "https://huggingface.co/csukuangfj/r/resolve/{}/a.onnx",
                "c".repeat(40)
            )
        );
        assert!(matches!(&out[0].check, Check::Sha256(h) if h == &"f".repeat(64)));
        assert!(matches!(&out[1].check, Check::GitSha1(h) if h == &"e".repeat(40)));
        assert_eq!(out[1].name, "espeak-ng-data/x");
        let unchecked = vec![crate::speech_hub::detect::RepoFile {
            path: "b".into(),
            size: 1,
            sha256: None,
            git_sha1: None,
        }];
        assert!(hub_download_files("csukuangfj/r", &"c".repeat(40), &unchecked).is_err());
    }

    #[test]
    fn hub_ids_are_known_models() {
        assert!(matches!(
            ready_check("hf:csukuangfj/x"),
            Ok(ReadyCheck::Hub)
        ));
        assert!(ready_check("hf:someone/x").is_err());
        assert!(matches!(
            ready_check("piper-en-us-amy-low"),
            Ok(ReadyCheck::Tts(_))
        ));
        assert!(matches!(
            ready_check("whisper-base-int8"),
            Ok(ReadyCheck::Stt(_))
        ));
        assert!(ready_check("nope").is_err());
    }

    #[test]
    fn tts_manifests_are_listed_as_text_to_speech() {
        let list = catalog_manifests(false);
        let tts: Vec<_> = list.iter().filter(|m| m.capability == "tts").collect();
        assert_eq!(tts.len(), TTS_CATALOG.len());
        assert!(tts.iter().all(|m| m.kind == "download" && m.size_bytes > 0));
    }

    #[test]
    fn fallback_order_prefers_apple_with_a_ready_locale() {
        let picked = pick_fallback(
            Some("pt-BR".into()),
            &["parakeet-tdt-0.6b-v3-int8".to_string()],
        );
        assert!(matches!(picked, Some(FallbackStt::Apple(locale)) if locale == "pt-BR"));
    }

    #[test]
    fn fallback_order_uses_the_first_ready_sherpa_model() {
        let picked = pick_fallback(
            None,
            &[
                "zipformer-small-en-int8".to_string(),
                "parakeet-tdt-0.6b-v3-int8".to_string(),
            ],
        );
        assert!(matches!(picked, Some(FallbackStt::Sherpa(id)) if id == "zipformer-small-en-int8"));
    }

    #[test]
    fn fallback_order_is_empty_without_local_engines() {
        assert!(pick_fallback(None, &[]).is_none());
    }

    #[test]
    fn provider_defaults_from_the_model_id_for_old_callers() {
        assert_eq!(SttProvider::infer(None, "apple-speech"), SttProvider::Apple);
        assert_eq!(
            SttProvider::infer(None, "parakeet-tdt-0.6b-v3-int8"),
            SttProvider::Local
        );
        assert_eq!(
            SttProvider::infer(Some(SttProvider::Gemini), "x"),
            SttProvider::Gemini
        );
    }

    #[test]
    fn catalog_recommends_exactly_one_downloadable_model() {
        // Which model is recommended is a product choice that changes with the catalogue; the
        // preferences list only needs exactly one of them marked, and every entry to have files.
        let list = catalog_manifests(false);
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
        assert!(matches!(
            engine_for("parakeet-tdt-0.6b-v3-int8", None, true),
            Ok(Engine::Local)
        ));
        assert!(matches!(
            engine_for("hf:csukuangfj/x", None, true),
            Ok(Engine::Local)
        ));
        assert!(engine_for("nope", None, true).is_err());
    }

    #[test]
    fn the_native_engine_needs_the_bridge_and_a_locale() {
        assert!(engine_for(APPLE_MODEL_ID, Some("pt-BR"), false).is_err());
        assert!(engine_for(APPLE_MODEL_ID, None, true).is_err());
        assert!(engine_for(APPLE_MODEL_ID, Some("  "), true).is_err());
        match engine_for(APPLE_MODEL_ID, Some("pt-BR"), true).unwrap() {
            Engine::Apple { locale } => assert_eq!(locale, "pt-BR"),
            Engine::Local => panic!("expected apple"),
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
    fn resume_without_partial_content_restarts_the_file() {
        // offset > 0 but the server answered 200: the part file must be truncated, not appended to.
        assert!(!should_append(100, reqwest::StatusCode::OK));
        assert!(should_append(100, reqwest::StatusCode::PARTIAL_CONTENT));
        assert!(!should_append(0, reqwest::StatusCode::PARTIAL_CONTENT));
    }

    #[test]
    fn only_a_partial_file_shorter_than_expected_is_resumed() {
        assert_eq!(resume_offset(None, 100), 0);
        assert_eq!(resume_offset(Some(0), 100), 0);
        assert_eq!(resume_offset(Some(40), 100), 40);
        assert_eq!(resume_offset(Some(100), 100), 0);
        assert_eq!(resume_offset(Some(140), 100), 0);
    }

    #[test]
    fn a_recording_too_short_to_transcribe_is_reported_by_its_code() {
        let sixth = (SAMPLE_RATE as usize) / 6;
        assert_eq!(check_recording_length(0), Err(SPEECH_TOO_SHORT.to_string()));
        assert_eq!(
            check_recording_length(sixth - 1),
            Err(SPEECH_TOO_SHORT.to_string())
        );
        assert_eq!(check_recording_length(sixth), Ok(()));
        assert_eq!(SPEECH_TOO_SHORT, "speech_too_short");
    }

    #[test]
    fn a_partial_file_of_full_length_is_verified_without_a_request() {
        // A pause on the last chunk leaves a complete `.part`; it must not restart from zero.
        assert!(part_is_complete(Some(100), 100));
        assert!(!part_is_complete(Some(40), 100));
        assert!(!part_is_complete(Some(140), 100));
        assert!(!part_is_complete(None, 100));
        assert!(!part_is_complete(Some(0), 0));
    }

    #[test]
    fn hub_file_failures_map_to_hub_codes() {
        let gone = http_failure("model.onnx", reqwest::StatusCode::NOT_FOUND);
        assert_eq!(
            hub_file_error(&gone),
            Some(crate::speech_hub::hf::UNKNOWN_REPO)
        );
        let limited = http_failure("model.onnx", reqwest::StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            hub_file_error(&limited),
            Some(crate::speech_hub::hf::RATE_LIMITED)
        );
        let other = http_failure("model.onnx", reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(hub_file_error(&other), None);
        assert_eq!(hub_file_error("checksum mismatch for 404.bin"), None);
        assert_eq!(hub_file_error("download a: connection reset"), None);
    }

    #[test]
    fn a_hub_model_that_will_not_load_says_so_in_words() {
        let sherpa = "failed to create OfflineRecognizer".to_string();
        assert_eq!(
            load_error("hf:csukuangfj/sherpa-onnx-whisper-turbo", sherpa.clone()),
            HUB_INCOMPATIBLE
        );
        assert_eq!(
            HUB_INCOMPATIBLE,
            "This model cannot run in Alethe. Remove it in Preferences → Voice."
        );
        assert_eq!(load_error("whisper-base-int8", sherpa.clone()), sherpa);
    }
}
