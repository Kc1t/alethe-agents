//! Live OpenRouter model list, so the speech picker follows what OpenRouter currently offers.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::http::{send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest};

const TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveModel {
    pub id: String,
    pub label: String,
    pub capability: &'static str,
    /// The model's `supported_voices`; empty when OpenRouter lists none.
    pub voices: Vec<String>,
    /// OpenRouter's per-unit price (see [`format_price`]); absent when unknown or free.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<String>,
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

/// A positive price from a `pricing` field, which OpenRouter sends as a decimal string.
fn price_of(value: &Value) -> Option<f64> {
    let amount = match value {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        Value::Number(number) => number.as_f64()?,
        _ => return None,
    };
    (amount.is_finite() && amount > 0.0).then_some(amount)
}

/// `$` plus four significant digits, trailing zeros trimmed (`0.00003055…` → `$0.00003056`).
fn dollars(amount: f64) -> String {
    let decimals = (3 - amount.log10().floor() as i32).clamp(0, 12) as usize;
    let text = format!("{amount:.decimals$}");
    let text = if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.')
    } else {
        text.as_str()
    };
    format!("${text}")
}

/// Short price of a model from OpenRouter's `pricing`: the `prompt` (input) amount, plus
/// ` · <completion>` when the output is billed too. OpenRouter does not name the unit of audio
/// models (it varies between tokens, characters and seconds), so none is added here.
/// `None` when both amounts are missing or zero.
pub fn format_price(pricing: &Value) -> Option<String> {
    let prompt = price_of(&pricing["prompt"]);
    let completion = price_of(&pricing["completion"]);
    match (prompt, completion) {
        (None, None) => None,
        (Some(input), None) => Some(dollars(input)),
        (input, Some(output)) => Some(format!(
            "{} · {}",
            input.map_or_else(|| "$0".to_string(), dollars),
            dollars(output)
        )),
    }
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
                price: format_price(&model["pricing"]),
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
                price: None,
            }],
        ));
    }
}

#[tauri::command]
pub async fn voice_openrouter_models(kind: String) -> Result<Vec<LiveModel>, String> {
    live_models(&kind).await
}

/// The public model-list request for a modality. It never carries a key, so listing models never
/// touches the keychain.
fn models_request(modality: &str) -> HttpRequest {
    HttpRequest {
        method: HttpMethod::Get,
        url: format!("https://openrouter.ai/api/v1/models?output_modalities={modality}"),
        headers: vec![("X-Title", "Alethe".to_string())],
        body: HttpBody::Empty,
        audio: false,
    }
}

/// The live list of a kind (`stt` or `tts`), from the cache while fresh.
pub async fn live_models(kind: &str) -> Result<Vec<LiveModel>, String> {
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
    let body = send(models_request(modality), Duration::from_secs(15))
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
    fn the_model_list_request_carries_no_key() {
        let request = models_request("speech");
        assert_eq!(
            request.url,
            "https://openrouter.ai/api/v1/models?output_modalities=speech"
        );
        assert!(request
            .headers
            .iter()
            .all(|(name, _)| !name.eq_ignore_ascii_case("authorization")));
    }

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
            price: None,
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
            price: None,
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
    fn prices_are_none_when_missing_zero_or_unreadable() {
        use serde_json::json;
        assert_eq!(format_price(&Value::Null), None);
        assert_eq!(format_price(&json!({})), None);
        assert_eq!(
            format_price(&json!({"prompt": "0", "completion": "0"})),
            None
        );
        assert_eq!(
            format_price(&json!({"prompt": "abc", "completion": ""})),
            None
        );
        assert_eq!(format_price(&json!({"prompt": "-1"})), None);
    }

    #[test]
    fn prices_show_openrouter_per_unit_amounts_without_inventing_a_unit() {
        use serde_json::json;
        assert_eq!(
            format_price(&json!({"prompt": "0.0001", "completion": "0"})),
            Some("$0.0001".to_string())
        );
        assert_eq!(
            format_price(&json!({"prompt": "0.00000062", "completion": "0"})),
            Some("$0.00000062".to_string())
        );
        assert_eq!(
            format_price(&json!({"prompt": "0.00003055555555555", "completion": "0"})),
            Some("$0.00003056".to_string()),
            "four significant digits"
        );
        assert_eq!(
            format_price(&json!({"prompt": "0.36"})),
            Some("$0.36".to_string())
        );
        assert_eq!(
            format_price(&json!({"prompt": 0.1, "completion": 0})),
            Some("$0.1".to_string()),
            "numbers are read as well as strings"
        );
        assert_eq!(
            format_price(&json!({"prompt": "0.0000005", "completion": "0.000009"})),
            Some("$0.0000005 · $0.000009".to_string()),
            "input · output when the output is billed"
        );
        assert_eq!(
            format_price(&json!({"prompt": "0", "completion": "0.0025"})),
            Some("$0 · $0.0025".to_string()),
            "output-only billing keeps the input slot"
        );
    }

    #[test]
    fn parsed_models_carry_their_price() {
        let body = br#"{"data":[
            {"id":"openai/whisper-1","pricing":{"prompt":"0.0001","completion":"0"}},
            {"id":"fish-audio/s2.1-pro-free:free","pricing":{"prompt":"0","completion":"0"}},
            {"id":"x/no-pricing"}
        ]}"#;
        let models = parse_models(body, "stt").unwrap();
        assert_eq!(models[0].price.as_deref(), Some("$0.0001"));
        assert_eq!(models[1].price, None);
        assert_eq!(models[2].price, None);
        let value = serde_json::to_value(&models[0]).unwrap();
        assert_eq!(value["price"], "$0.0001");
        let value = serde_json::to_value(&models[2]).unwrap();
        assert!(
            value.get("price").is_none(),
            "absent price is not serialized"
        );
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
            price: None,
        };
        remember(&mut cache, "tts", &[model.clone()]);
        remember(&mut cache, "tts", &[model]);
        assert_eq!(cache.len(), 1, "one entry per kind");
    }
}
