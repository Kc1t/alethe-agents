//! What each server kind is asked and how its replies are read. Pure, so it is tested without a
//! server.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_OPENAI_MODEL: &str = "tts-1";
pub const MAX_VOICES: usize = 500;
pub const MAX_VOICE_LEN: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerKind {
    /// `POST /v1/audio/speech`: chatterbox-tts-api, Kokoro-FastAPI, openedai-speech, LocalAI.
    Openai,
    /// Fish Speech's own `POST /v1/tts`.
    Fish,
}

pub struct SpeechRequest {
    pub path: &'static str,
    pub body: Value,
}

pub fn speech_request(
    kind: ServerKind,
    model: Option<&str>,
    voice: Option<&str>,
    text: &str,
    rate: f32,
) -> SpeechRequest {
    match kind {
        ServerKind::Openai => {
            let mut body = json!({
                "model": model.unwrap_or(DEFAULT_OPENAI_MODEL),
                "input": text,
                "response_format": "mp3",
                "speed": rate.clamp(0.25, 4.0),
            });
            if let Some(voice) = voice {
                body["voice"] = json!(voice);
            }
            SpeechRequest {
                path: "/v1/audio/speech",
                body,
            }
        }
        ServerKind::Fish => {
            let mut body = json!({ "text": text, "format": "mp3", "normalize": true });
            if let Some(voice) = voice {
                body["reference_id"] = json!(voice);
            }
            SpeechRequest {
                path: "/v1/tts",
                body,
            }
        }
    }
}

/// Where each kind lists its voices, tried in order (servers differ).
pub fn voice_paths(kind: ServerKind) -> &'static [&'static str] {
    match kind {
        ServerKind::Openai => &["/v1/audio/voices", "/voices"],
        ServerKind::Fish => &["/v1/references/list"],
    }
}

/// Cheap GETs that prove the server is up and of this kind; the first that answers 2xx wins.
pub fn health_paths(kind: ServerKind) -> &'static [&'static str] {
    match kind {
        ServerKind::Openai => &["/v1/audio/voices", "/voices", "/v1/models"],
        ServerKind::Fish => &["/v1/health"],
    }
}

fn voice_id(item: &Value) -> Option<&str> {
    match item {
        Value::String(id) => Some(id),
        Value::Object(fields) => ["id", "voice_id", "name"]
            .iter()
            .find_map(|key| fields.get(*key)?.as_str()),
        _ => None,
    }
}

/// Voice ids from any of the known reply shapes; anything else is an empty list (the person then
/// types the voice).
pub fn parse_voices(body: &[u8]) -> Vec<String> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let items = match &value {
        Value::Array(items) => items.as_slice(),
        Value::Object(fields) => ["voices", "reference_ids"]
            .iter()
            .find_map(|key| fields.get(*key)?.as_array())
            .map_or(&[][..], Vec::as_slice),
        _ => &[],
    };
    let mut out: Vec<String> = Vec::new();
    for id in items.iter().filter_map(voice_id).map(str::trim) {
        if id.is_empty() || id.chars().count() > MAX_VOICE_LEN || out.iter().any(|seen| seen == id)
        {
            continue;
        }
        out.push(id.to_string());
        if out.len() == MAX_VOICES {
            break;
        }
    }
    out
}

/// The rate to declare to the player: OpenAI-compatible servers apply `speed` themselves (or
/// ignore it); Fish has no speed, so the player plays faster or slower.
pub fn playback_rate(kind: ServerKind, rate: f32, sample_rate: u32) -> u32 {
    match kind {
        ServerKind::Openai => sample_rate,
        ServerKind::Fish => (sample_rate as f32 * rate).round() as u32,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn openai_speech_asks_for_mp3_with_model_voice_and_speed() {
        let request = speech_request(
            ServerKind::Openai,
            Some("chatterbox"),
            Some("pt-ref"),
            "Olá",
            1.5,
        );
        assert_eq!(request.path, "/v1/audio/speech");
        assert_eq!(
            request.body,
            json!({ "model": "chatterbox", "input": "Olá", "voice": "pt-ref", "response_format": "mp3", "speed": 1.5 })
        );
    }

    #[test]
    fn openai_defaults_the_model_and_omits_a_missing_voice() {
        let request = speech_request(ServerKind::Openai, None, None, "Hi", 9.0);
        assert_eq!(
            request.body,
            json!({ "model": "tts-1", "input": "Hi", "response_format": "mp3", "speed": 4.0 })
        );
    }

    #[test]
    fn fish_speech_sends_the_reference_id_and_never_speed() {
        let request = speech_request(
            ServerKind::Fish,
            Some("ignored"),
            Some("narrador"),
            "Olá",
            1.5,
        );
        assert_eq!(request.path, "/v1/tts");
        assert_eq!(
            request.body,
            json!({ "text": "Olá", "format": "mp3", "normalize": true, "reference_id": "narrador" })
        );
        let bare = speech_request(ServerKind::Fish, None, None, "x", 1.0);
        assert!(bare.body.get("reference_id").is_none());
    }

    #[test]
    fn voices_are_read_from_each_known_shape() {
        // Kokoro-FastAPI GET /v1/audio/voices
        assert_eq!(
            parse_voices(br#"{"voices":["af_bella","pf_dora"]}"#),
            ["af_bella", "pf_dora"]
        );
        // chatterbox-tts-api GET /voices
        assert_eq!(
            parse_voices(
                br#"{"voices":[{"name":"pt-ref","language":"pt"},{"name":"en-ref"}],"count":2}"#
            ),
            ["pt-ref", "en-ref"]
        );
        // Fish Speech GET /v1/references/list
        assert_eq!(
            parse_voices(br#"{"success":true,"reference_ids":["narrador"],"message":""}"#),
            ["narrador"]
        );
        assert_eq!(
            parse_voices(br#"[{"id":"a"},{"voice_id":"b"},"c","c"," "]"#),
            ["a", "b", "c"]
        );
    }

    #[test]
    fn unknown_or_hostile_voice_replies_read_as_empty_or_capped() {
        assert!(parse_voices(b"<html>").is_empty());
        assert!(parse_voices(br#"{"data":[{"id":"tts-1"}]}"#).is_empty());
        let long = format!(r#"["{}"]"#, "x".repeat(MAX_VOICE_LEN + 1));
        assert!(parse_voices(long.as_bytes()).is_empty());
        let many: Vec<String> = (0..MAX_VOICES + 50).map(|i| format!("v{i}")).collect();
        assert_eq!(
            parse_voices(serde_json::to_string(&many).unwrap().as_bytes()).len(),
            MAX_VOICES
        );
    }

    #[test]
    fn only_fish_is_sped_up_by_the_player() {
        assert_eq!(playback_rate(ServerKind::Openai, 1.5, 24_000), 24_000);
        assert_eq!(playback_rate(ServerKind::Fish, 1.5, 44_100), 66_150);
    }

    #[test]
    fn kinds_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&ServerKind::Openai).unwrap(),
            "\"openai\""
        );
        assert_eq!(
            serde_json::from_str::<ServerKind>("\"fish\"").unwrap(),
            ServerKind::Fish
        );
    }

    #[test]
    fn wav_replies_decode() {
        let pcm = crate::voice_providers::tts_cloud::decode_audio(&tiny_wav(
            16_000,
            &[0, 8000, -8000, 0],
        ))
        .expect("wav decodes");
        assert_eq!(pcm.sample_rate, 16_000);
        assert_eq!(pcm.samples.len(), 4);
        assert!(crate::voice_providers::tts_cloud::decode_audio(b"not audio").is_err());
    }

    /// A mono 16-bit PCM WAV file.
    pub(crate) fn tiny_wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let data_len = (samples.len() * 2) as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out
    }
}
