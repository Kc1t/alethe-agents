//! Live OpenRouter model list, so the speech picker follows what OpenRouter currently offers.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::http::{send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest};
use super::{keys, CloudProvider};

const TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModel {
    pub id: String,
    pub label: String,
    pub capability: &'static str,
    /// The model's `supported_voices`; empty when OpenRouter lists none.
    pub voices: Vec<String>,
}

type CacheEntry = (&'static str, Instant, Vec<LiveModel>);
static CACHE: Mutex<Vec<CacheEntry>> = Mutex::new(Vec::new());

pub fn modality(kind: &str) -> Option<&'static str> {
    match kind {
        "stt" => Some("transcription"),
        "tts" => Some("speech"),
        _ => None,
    }
}

/// Caches a kind's list for the TTL. An empty list is never cached, so the next open retries.
fn remember(cache: &mut Vec<CacheEntry>, capability: &'static str, models: &[LiveModel]) {
    if models.is_empty() {
        return;
    }
    cache.retain(|(k, _, _)| *k != capability);
    cache.push((capability, Instant::now(), models.to_vec()));
}

pub fn parse_models(body: &[u8], capability: &'static str) -> Result<Vec<LiveModel>, CloudError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let data = value["data"]
        .as_array()
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    Ok(data
        .iter()
        .filter_map(|model| {
            let id = model["id"].as_str()?.to_string();
            let voices = model["supported_voices"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|voice| voice.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let label = model["name"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            Some(LiveModel {
                id,
                label,
                capability,
                voices,
            })
        })
        .collect())
}

/// The voices of `model` in `cache`, whatever its kind or age; `None` when the model is unknown.
fn voices_in(cache: &[CacheEntry], model: &str) -> Option<Vec<String>> {
    cache
        .iter()
        .flat_map(|(_, _, models)| models)
        .find(|entry| entry.id == model)
        .map(|entry| entry.voices.clone())
}

/// The cached voices of a live model, for Rust-side defaults. Never fetches.
pub fn cached_voices(model: &str) -> Option<Vec<String>> {
    voices_in(&CACHE.lock().unwrap_or_else(|e| e.into_inner()), model)
}

/// Seeds the shared cache with TTS models and their voices.
#[cfg(test)]
pub fn cache_for_test(models: &[(&str, &[&str])]) {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    for (id, voices) in models {
        cache.push((
            "tts",
            Instant::now(),
            vec![LiveModel {
                id: id.to_string(),
                label: id.to_string(),
                capability: "tts",
                voices: voices.iter().map(|voice| voice.to_string()).collect(),
            }],
        ));
    }
}

#[tauri::command]
pub async fn voice_openrouter_models(
    app: AppHandle,
    kind: String,
) -> Result<Vec<LiveModel>, String> {
    live_models(&app, &kind).await
}

/// The live list of a kind (`stt` or `tts`), from the cache while fresh. The list is public, so
/// the key is sent only when one is saved.
pub async fn live_models(app: &AppHandle, kind: &str) -> Result<Vec<LiveModel>, String> {
    let modality = modality(kind).ok_or_else(|| "voice_openrouter_bad_kind".to_string())?;
    let capability: &'static str = if kind == "tts" { "tts" } else { "stt" };
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, _, models)) = cache
            .iter()
            .find(|(k, at, _)| *k == capability && at.elapsed() < TTL)
        {
            return Ok(models.clone());
        }
    }
    let mut headers = vec![("X-Title", "Alethe".to_string())];
    if let Some(key) = keys::read_key(app, CloudProvider::Openrouter)? {
        headers.push(("Authorization", format!("Bearer {key}")));
    }
    let request = HttpRequest {
        method: HttpMethod::Get,
        url: format!("https://openrouter.ai/api/v1/models?output_modalities={modality}"),
        headers,
        body: HttpBody::Empty,
        audio: false,
    };
    let body = send(request, Duration::from_secs(15))
        .await
        .map_err(|e| e.to_string())?;
    let models = parse_models(&body, capability).map_err(|e| e.to_string())?;
    remember(
        &mut CACHE.lock().unwrap_or_else(|e| e.into_inner()),
        capability,
        &models,
    );
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_to_openrouter_modalities() {
        assert_eq!(modality("stt"), Some("transcription"));
        assert_eq!(modality("tts"), Some("speech"));
        assert_eq!(modality("../models"), None);
    }

    #[test]
    fn model_lists_are_parsed() {
        let body = br#"{"data":[{"id":"openai/whisper-1","name":"OpenAI: Whisper"},{"id":"x/y"}]}"#;
        let models = parse_models(body, "stt").unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].label, "OpenAI: Whisper");
        assert_eq!(models[1].label, "x/y", "falls back to the id");
        assert!(parse_models(b"{}", "stt").is_err());
    }

    #[test]
    fn live_tts_lists_every_speech_model_with_its_voices() {
        let body = br#"{"data":[
            {"id":"google/gemini-3.8-flash-tts","supported_voices":["Zephyr","Puck"]},
            {"id":"hexgrad/kokoro-82m","supported_voices":["af_bella","pf_dora"]},
            {"id":"x/no-voices"},
            {"id":"x/odd-voices","supported_voices":["ok",3,null]}
        ]}"#;
        let models = parse_models(body, "tts").unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "google/gemini-3.8-flash-tts",
                "hexgrad/kokoro-82m",
                "x/no-voices",
                "x/odd-voices"
            ]
        );
        assert_eq!(models[0].voices, vec!["Zephyr", "Puck"]);
        assert_eq!(models[1].voices, vec!["af_bella", "pf_dora"]);
        assert!(models[2].voices.is_empty(), "missing list reads as empty");
        assert_eq!(models[3].voices, vec!["ok"], "non-strings are skipped");
        let stt = br#"{"data":[{"id":"openai/whisper-1"}]}"#;
        assert_eq!(parse_models(stt, "stt").unwrap().len(), 1);
    }

    #[test]
    fn live_models_serialize_their_voices_in_camel_case() {
        let model = LiveModel {
            id: "hexgrad/kokoro-82m".into(),
            label: "Kokoro".into(),
            capability: "tts",
            voices: vec!["pf_dora".into()],
        };
        let value = serde_json::to_value(&model).unwrap();
        assert_eq!(value["voices"][0], "pf_dora");
        assert_eq!(value["capability"], "tts");
    }

    #[test]
    fn cached_voices_are_found_by_model_in_any_kind() {
        let model = |id: &str, voices: &[&str]| LiveModel {
            id: id.into(),
            label: id.into(),
            capability: "tts",
            voices: voices.iter().map(|v| v.to_string()).collect(),
        };
        let mut cache = Vec::new();
        remember(
            &mut cache,
            "stt",
            &[LiveModel {
                capability: "stt",
                ..model("openai/whisper-1", &[])
            }],
        );
        remember(
            &mut cache,
            "tts",
            &[model("hexgrad/kokoro-82m", &["af_bella", "pf_dora"])],
        );
        assert_eq!(
            voices_in(&cache, "hexgrad/kokoro-82m"),
            Some(vec!["af_bella".to_string(), "pf_dora".to_string()])
        );
        assert_eq!(voices_in(&cache, "openai/whisper-1"), Some(Vec::new()));
        assert_eq!(voices_in(&cache, "unknown/model"), None);
    }

    #[test]
    fn an_empty_list_is_never_cached() {
        let mut cache = Vec::new();
        remember(&mut cache, "tts", &[]);
        assert!(cache.is_empty());
        let model = LiveModel {
            id: "google/x-tts".into(),
            label: "X".into(),
            capability: "tts",
            voices: Vec::new(),
        };
        remember(&mut cache, "tts", &[model.clone()]);
        remember(&mut cache, "tts", &[model]);
        assert_eq!(cache.len(), 1, "one entry per kind");
    }
}
