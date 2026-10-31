use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use super::http::{
    auth_headers, safe_path_id, send, CloudError, CloudErrorKind, FormPart, HttpBody, HttpMethod,
    HttpRequest,
};
use super::CloudProvider;

const TIMEOUT: Duration = Duration::from_secs(30);
const GEMINI_PROMPT: &str =
    "Transcribe this audio verbatim in its original language. Reply with the transcript only.";

/// 16-bit PCM mono WAV, the one container every provider accepts.
pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn wav_part(wav: Vec<u8>) -> FormPart {
    FormPart::File {
        name: "file",
        filename: "audio.wav",
        mime: "audio/wav",
        bytes: wav,
    }
}

pub fn transcription_request(
    provider: CloudProvider,
    model: &str,
    key: &str,
    wav: Vec<u8>,
) -> Result<HttpRequest, CloudError> {
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let (url, body) = match provider {
        CloudProvider::Openai => (
            "https://api.openai.com/v1/audio/transcriptions".to_string(),
            HttpBody::Multipart(vec![
                FormPart::Text {
                    name: "model",
                    value: model.to_string(),
                },
                FormPart::Text {
                    name: "response_format",
                    value: "json".to_string(),
                },
                wav_part(wav),
            ]),
        ),
        CloudProvider::Elevenlabs => (
            "https://api.elevenlabs.io/v1/speech-to-text".to_string(),
            HttpBody::Multipart(vec![
                FormPart::Text {
                    name: "model_id",
                    value: model.to_string(),
                },
                wav_part(wav),
            ]),
        ),
        CloudProvider::Gemini => (
            format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                safe_path_id(model)?
            ),
            HttpBody::Json(json!({
                "contents": [{ "parts": [
                    { "text": GEMINI_PROMPT },
                    { "inline_data": { "mime_type": "audio/wav", "data": encode(&wav) } }
                ]}]
            })),
        ),
        CloudProvider::Openrouter => (
            "https://openrouter.ai/api/v1/audio/transcriptions".to_string(),
            HttpBody::Json(json!({
                "model": model,
                "input_audio": { "data": encode(&wav), "format": "wav" }
            })),
        ),
    };
    Ok(HttpRequest {
        method: HttpMethod::Post,
        url,
        headers: auth_headers(provider, key),
        body,
        audio: true,
    })
}

pub fn parse_transcription(provider: CloudProvider, body: &[u8]) -> Result<String, CloudError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let text = match provider {
        CloudProvider::Gemini => {
            value["candidates"][0]["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<String>()
                })
        }
        _ => value["text"].as_str().map(str::to_string),
    };
    text.map(|text| text.trim().to_string())
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))
}

pub async fn transcribe(
    provider: CloudProvider,
    model: &str,
    key: &str,
    samples: &[f32],
    sample_rate: u32,
) -> Result<String, CloudError> {
    let request = transcription_request(provider, model, key, wav_bytes(samples, sample_rate))?;
    let body = send(request, TIMEOUT).await?;
    parse_transcription(provider, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_providers::http::{FormPart, HttpBody};

    #[test]
    fn wav_has_a_pcm16_mono_header() {
        let wav = wav_bytes(&[0.0, 1.0, -1.0], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        assert_eq!(
            u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]),
            6,
            "3 samples x 2 bytes"
        );
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -i16::MAX);
    }

    #[test]
    fn openai_and_elevenlabs_upload_multipart() {
        let openai =
            transcription_request(CloudProvider::Openai, "whisper-1", "k", vec![1, 2]).unwrap();
        assert_eq!(openai.url, "https://api.openai.com/v1/audio/transcriptions");
        let HttpBody::Multipart(parts) = openai.body else {
            panic!("multipart")
        };
        assert!(parts
            .iter()
            .any(|p| matches!(p, FormPart::Text { name: "model", value } if value == "whisper-1")));
        assert!(parts
            .iter()
            .any(|p| matches!(p, FormPart::File { name: "file", .. })));
        assert!(openai.audio);

        let eleven =
            transcription_request(CloudProvider::Elevenlabs, "scribe_v2", "k", vec![1]).unwrap();
        assert_eq!(eleven.url, "https://api.elevenlabs.io/v1/speech-to-text");
        let HttpBody::Multipart(parts) = eleven.body else {
            panic!("multipart")
        };
        assert!(parts.iter().any(
            |p| matches!(p, FormPart::Text { name: "model_id", value } if value == "scribe_v2")
        ));
    }

    #[test]
    fn gemini_and_openrouter_send_base64_json() {
        let gemini = transcription_request(
            CloudProvider::Gemini,
            "gemini-2.5-flash",
            "k",
            vec![1, 2, 3],
        )
        .unwrap();
        assert_eq!(
            gemini.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        let HttpBody::Json(body) = gemini.body else {
            panic!("json")
        };
        assert_eq!(
            body["contents"][0]["parts"][1]["inline_data"]["mime_type"],
            "audio/wav"
        );
        assert_eq!(
            body["contents"][0]["parts"][1]["inline_data"]["data"],
            "AQID"
        );

        let router = transcription_request(
            CloudProvider::Openrouter,
            "openai/whisper-1",
            "k",
            vec![1, 2, 3],
        )
        .unwrap();
        assert_eq!(
            router.url,
            "https://openrouter.ai/api/v1/audio/transcriptions"
        );
        let HttpBody::Json(body) = router.body else {
            panic!("json")
        };
        assert_eq!(body["model"], "openai/whisper-1");
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["input_audio"]["data"], "AQID");
    }

    #[test]
    fn the_gemini_model_in_the_url_path_is_validated() {
        for bad in ["a/b", "../x", "m?x=1", "m#x", ""] {
            assert!(
                transcription_request(CloudProvider::Gemini, bad, "k", vec![1]).is_err(),
                "{bad:?}"
            );
        }
        // OpenRouter ids go in the body, so their slash is fine.
        assert!(
            transcription_request(CloudProvider::Openrouter, "openai/whisper-1", "k", vec![1])
                .is_ok()
        );
    }

    #[test]
    fn replies_are_parsed_per_provider() {
        assert_eq!(
            parse_transcription(CloudProvider::Openai, br#"{"text":" oi "}"#).unwrap(),
            "oi"
        );
        assert_eq!(
            parse_transcription(CloudProvider::Elevenlabs, br#"{"text":"hello"}"#).unwrap(),
            "hello"
        );
        assert_eq!(
            parse_transcription(CloudProvider::Openrouter, br#"{"text":"x","usage":{}}"#).unwrap(),
            "x"
        );
        let gemini = br#"{"candidates":[{"content":{"parts":[{"text":"bom "},{"text":"dia"}]}}]}"#;
        assert_eq!(
            parse_transcription(CloudProvider::Gemini, gemini).unwrap(),
            "bom dia"
        );
        assert_eq!(
            parse_transcription(CloudProvider::Openai, b"not json")
                .unwrap_err()
                .kind,
            CloudErrorKind::Other
        );
    }
}
