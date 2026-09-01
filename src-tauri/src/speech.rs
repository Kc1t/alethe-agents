//! On-device speech-to-text (sherpa-onnx / Parakeet TDT).
//!
//! Models live under `{app_data}/speech-models/{id}/`. Microphone capture uses
//! native cpal (not WebKit getUserMedia) so AppImage/PipeWire still sees devices.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::paths::app_data_dir;
use crate::speech_capture::{self, CapturedAudio, CaptureSession, SpeechInputDevice};

const SAMPLE_RATE: i32 = 16_000;

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
}

struct ModelFile {
    name: &'static str,
    url: &'static str,
    size_bytes: u64,
    sha256: &'static str,
}

struct CatalogEntry {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    language: &'static str,
    recommended: bool,
    files: &'static [ModelFile],
}

/// Same HuggingFace revision + hashes Orca pins for Parakeet TDT v3 int8.
const PARAKEET_V3: CatalogEntry = CatalogEntry {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT v3",
    description: "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
    language: "multilingual",
    recommended: true,
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

const CATALOG: &[CatalogEntry] = &[PARAKEET_V3];

pub struct SpeechState {
    /// Serializes downloads so two prefs clicks don't race the same folder.
    download_lock: AsyncMutex<()>,
    /// Active native mic capture (stream lives on a dedicated thread).
    capture: Mutex<Option<CaptureSession>>,
}

impl Default for SpeechState {
    fn default() -> Self {
        Self {
            download_lock: AsyncMutex::new(()),
            capture: Mutex::new(None),
        }
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

#[tauri::command]
pub fn speech_list_models() -> Vec<SpeechModelManifest> {
    CATALOG
        .iter()
        .map(|entry| SpeechModelManifest {
            id: entry.id.to_string(),
            label: entry.label.to_string(),
            description: entry.description.to_string(),
            language: entry.language.to_string(),
            sample_rate: SAMPLE_RATE as u32,
            size_bytes: entry_size_bytes(entry),
            recommended: entry.recommended,
        })
        .collect()
}

#[tauri::command]
pub fn speech_list_input_devices() -> Result<Vec<SpeechInputDevice>, String> {
    speech_capture::list_input_devices()
}

#[tauri::command]
pub fn speech_model_states(app: AppHandle) -> Result<Vec<SpeechModelState>, String> {
    let root = models_root(&app)?;
    Ok(CATALOG
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
        .collect())
}

#[tauri::command]
pub async fn speech_download_model(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<SpeechModelState, String> {
    let entry = find_entry(&model_id)?;
    let _guard = state.download_lock.lock().await;
    let dir = model_dir(&app, &model_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;

    let client = reqwest::Client::new();
    let total = entry_size_bytes(entry);
    let mut downloaded_total = 0u64;

    for file in entry.files {
        let dest = dir.join(file.name);
        if dest.is_file() {
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
        let response = client
            .get(file.url)
            .send()
            .await
            .map_err(|e| format!("download {}: {e}", file.name))?;
        if !response.status().is_success() {
            return Err(format!(
                "download {} failed: HTTP {}",
                file.name,
                response.status()
            ));
        }

        let mut out = File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let mut stream = response.bytes_stream();
        let mut file_got = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download stream {}: {e}", file.name))?;
            out.write_all(&chunk)
                .map_err(|e| format!("write {}: {e}", file.name))?;
            file_got += chunk.len() as u64;
            let overall = downloaded_total + file_got;
            let fraction = if total == 0 {
                0.0
            } else {
                (overall as f64 / total as f64).min(1.0)
            };
            let _ = app.emit(
                "speech://download-progress",
                DownloadProgressEvent {
                    model_id: model_id.clone(),
                    downloaded: overall,
                    total,
                    fraction,
                },
            );
        }
        out.flush().map_err(|e| format!("flush {}: {e}", file.name))?;
        drop(out);

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

    Ok(SpeechModelState {
        id: model_id,
        status: "ready".into(),
        progress: Some(1.0),
        error: None,
    })
}

#[tauri::command]
pub fn speech_delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let _ = find_entry(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
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
pub fn speech_stop_capture(state: State<'_, SpeechState>) -> Result<CapturedAudio, String> {
    let mut slot = state
        .capture
        .lock()
        .map_err(|_| "speech capture lock poisoned".to_string())?;
    let capture = slot
        .take()
        .ok_or_else(|| "Dictation is not recording".to_string())?;
    capture.stop()
}

fn build_recognizer(dir: &Path) -> Result<OfflineRecognizer, String> {
    let encoder = dir.join("encoder.int8.onnx");
    let decoder = dir.join("decoder.int8.onnx");
    let joiner = dir.join("joiner.int8.onnx");
    let tokens = dir.join("tokens.txt");
    for path in [&encoder, &decoder, &joiner, &tokens] {
        if !path.is_file() {
            return Err(format!("missing model file: {}", path.display()));
        }
    }

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(encoder.to_string_lossy().into_owned()),
        decoder: Some(decoder.to_string_lossy().into_owned()),
        joiner: Some(joiner.to_string_lossy().into_owned()),
    };
    config.model_config.tokens = Some(tokens.to_string_lossy().into_owned());
    config.model_config.model_type = Some("nemo_transducer".into());
    config.model_config.num_threads = 2;
    config.feat_config.sample_rate = SAMPLE_RATE;

    OfflineRecognizer::create(&config).ok_or_else(|| "failed to create OfflineRecognizer".into())
}

fn transcribe_samples(dir: &Path, samples: &[f32], sample_rate: u32) -> Result<String, String> {
    let recognizer = build_recognizer(dir)?;
    let rate = if sample_rate == 0 {
        SAMPLE_RATE
    } else {
        sample_rate as i32
    };
    let stream = recognizer.create_stream();
    stream.accept_waveform(rate, samples);
    recognizer.decode(&stream);
    let result = stream
        .get_result()
        .ok_or_else(|| "empty speech result".to_string())?;
    Ok(result.text.trim().to_string())
}

#[tauri::command]
pub async fn speech_stop_and_transcribe(
    app: AppHandle,
    state: State<'_, SpeechState>,
    model_id: String,
) -> Result<String, String> {
    let audio = speech_stop_capture(state)?;
    if audio.samples.len() < (SAMPLE_RATE as usize) / 6 {
        return Err("Recording was too short — hold a bit longer, then release.".into());
    }
    if audio.peak < 0.005 {
        return Err(
            "No audio captured. Check the microphone and that PipeWire/PulseAudio can see it."
                .into(),
        );
    }
    let entry = find_entry(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    if !model_ready(&dir, entry) {
        return Err(format!(
            "Speech model '{model_id}' is not downloaded. Open Preferences → Integrations → Voice and download it."
        ));
    }

    let samples = audio.samples;
    let sample_rate = audio.sample_rate;
    tokio::task::spawn_blocking(move || transcribe_samples(&dir, &samples, sample_rate))
        .await
        .map_err(|e| format!("speech worker join: {e}"))?
}

#[tauri::command]
pub async fn speech_transcribe(
    app: AppHandle,
    model_id: String,
    samples: Vec<f32>,
    sample_rate: u32,
) -> Result<String, String> {
    if samples.is_empty() {
        return Ok(String::new());
    }
    let entry = find_entry(&model_id)?;
    let dir = model_dir(&app, &model_id)?;
    if !model_ready(&dir, entry) {
        return Err(format!(
            "Speech model '{model_id}' is not downloaded. Open Preferences → Integrations → Voice and download it."
        ));
    }

    tokio::task::spawn_blocking(move || transcribe_samples(&dir, &samples, sample_rate))
        .await
        .map_err(|e| format!("speech worker join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_recommended_parakeet_v3() {
        let list = speech_list_models();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "parakeet-tdt-0.6b-v3-int8");
        assert!(list[0].recommended);
        assert!(list[0].size_bytes > 600_000_000);
    }
}
