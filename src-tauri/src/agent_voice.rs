use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle,
};

use crate::secure_store::{OsSecretStore, SecretKind, SecretStore};

const TTS_URL: &str = "https://api.fish.audio/v1/tts";
const MODELS: [&str; 2] = ["s2.1-pro-free", "drama-3"];
const MAX_TEXT_CHARS: usize = 600;
const MAX_KEY_BYTES: usize = 256;
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const SAMPLE_RATE: u32 = 44_100;

fn active_profile_id(app: &AppHandle) -> Result<String, String> {
    Ok(crate::profiles::ensure_profiles_index(app)?.active_profile_id)
}

fn valid_voice_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_request(text: &str, voice_id: &str, model: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err("invalid_text".into());
    }
    if !valid_voice_id(voice_id) {
        return Err("invalid_voice_id".into());
    }
    if !MODELS.contains(&model) {
        return Err("invalid_model".into());
    }
    Ok(())
}

fn request_body(text: &str, voice_id: &str) -> serde_json::Value {
    serde_json::json!({
        "text": text,
        "reference_id": voice_id,
        "format": "pcm",
        "sample_rate": SAMPLE_RATE,
        "latency": "balanced",
    })
}

fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "fish_unauthorized".into(),
        402 => "fish_payment_required".into(),
        429 => "fish_rate_limited".into(),
        code => format!("fish_http_{code}"),
    }
}

#[tauri::command]
pub fn agent_voice_key_status(app: AppHandle) -> Result<bool, String> {
    let profile_id = active_profile_id(&app)?;
    OsSecretStore
        .get(&profile_id, SecretKind::FishAudioApiKey)
        .map(|key| key.is_some())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn agent_voice_set_key(app: AppHandle, key: String) -> Result<(), String> {
    let profile_id = active_profile_id(&app)?;
    let key = key.trim();
    if key.len() > MAX_KEY_BYTES {
        return Err("invalid_key".into());
    }
    let result = if key.is_empty() {
        OsSecretStore.delete(&profile_id, SecretKind::FishAudioApiKey)
    } else {
        OsSecretStore.set(&profile_id, SecretKind::FishAudioApiKey, key)
    };
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn agent_voice_tts(
    app: AppHandle,
    text: String,
    voice_id: String,
    model: String,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<usize, String> {
    validate_request(&text, &voice_id, &model)?;
    let profile_id = active_profile_id(&app)?;
    let key = OsSecretStore
        .get(&profile_id, SecretKind::FishAudioApiKey)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "fish_key_missing".to_string())?;

    let mut response = crate::jev::client()
        .post(TTS_URL)
        .bearer_auth(key)
        .header("model", model)
        .json(&request_body(&text, &voice_id))
        .send()
        .await
        .map_err(|_| "fish_unreachable".to_string())?;
    if !response.status().is_success() {
        return Err(http_error(response.status()));
    }
    let mut total = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "fish_stream_failed".to_string())?
    {
        total += chunk.len();
        if total > MAX_AUDIO_BYTES {
            return Err("fish_invalid_audio".into());
        }
        on_chunk
            .send(InvokeResponseBody::Raw(chunk.to_vec()))
            .map_err(|_| "fish_stream_failed".to_string())?;
    }
    if total == 0 {
        return Err("fish_invalid_audio".into());
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOICE: &str = "1d8cb595b6284ff7aa7e8fec7b93249d";

    #[test]
    fn accepts_a_well_formed_request() {
        assert!(validate_request("Done.", VOICE, "s2.1-pro-free").is_ok());
        assert!(validate_request("Done.", VOICE, "drama-3").is_ok());
    }

    #[test]
    fn rejects_malformed_requests() {
        assert_eq!(validate_request("  ", VOICE, "drama-3").unwrap_err(), "invalid_text");
        assert_eq!(
            validate_request(&"a".repeat(MAX_TEXT_CHARS + 1), VOICE, "drama-3").unwrap_err(),
            "invalid_text"
        );
        assert_eq!(validate_request("Hi", "../x", "drama-3").unwrap_err(), "invalid_voice_id");
        assert_eq!(validate_request("Hi", VOICE, "other").unwrap_err(), "invalid_model");
    }

    #[test]
    fn body_matches_the_fish_contract() {
        let body = request_body("Hi", VOICE);
        assert_eq!(body["reference_id"], VOICE);
        assert_eq!(body["format"], "pcm");
        assert_eq!(body["sample_rate"], SAMPLE_RATE);
        assert_eq!(body["latency"], "balanced");
    }

    #[test]
    fn http_errors_never_carry_response_bodies() {
        assert_eq!(http_error(reqwest::StatusCode::UNAUTHORIZED), "fish_unauthorized");
        assert_eq!(http_error(reqwest::StatusCode::BAD_GATEWAY), "fish_http_502");
    }
}
