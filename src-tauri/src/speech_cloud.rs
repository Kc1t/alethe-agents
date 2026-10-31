//! Speech-to-text through OpenRouter chat models that accept audio input. They are not
//! transcription models, so `/audio/transcriptions` does not serve them: the audio goes in a chat
//! message with an instruction to reply with the transcript only.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use crate::jev::client;
use crate::speech::{HOTWORDS, SAMPLE_RATE};

const COMPLETIONS_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS: u32 = 3;

/// The chat models offered for speech-to-text, with the label the model list shows.
pub(crate) const CHAT_AUDIO_MODELS: [(&str, &str); 2] = [
    ("openai/gpt-audio-mini", "OpenAI: GPT Audio Mini"),
    (
        "google/gemini-3.1-flash-lite",
        "Google: Gemini 3.1 Flash Lite",
    ),
];

pub(crate) fn is_chat_audio_model(model: &str) -> bool {
    CHAT_AUDIO_MODELS.iter().any(|(id, _)| *id == model)
}

fn encode_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
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

fn instruction() -> String {
    let vocabulary = HOTWORDS
        .iter()
        .map(|word| word.to_lowercase())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Transcribe this audio verbatim in the language it is spoken. Reply with the transcript only: \
         no quotes, no notes, no translation. If nothing intelligible is said, reply with an empty message. \
         Words the speaker is likely to use: {vocabulary}."
    )
}

fn build_transcription_payload(model: &str, wav: &[u8]) -> Value {
    json!({
        "model": model,
        "temperature": 0,
        "max_tokens": 300,
        "provider": { "sort": "latency" },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": instruction() },
                { "type": "input_audio", "input_audio": { "data": STANDARD.encode(wav), "format": "wav" } },
            ],
        }],
    })
}

fn read_transcript(body: &Value) -> String {
    body.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .trim_matches('"')
        .trim()
        .to_string()
}

enum AttemptError {
    Fatal(String),
    Retriable(String),
}

async fn request_transcript(api_key: &str, payload: &Value) -> Result<Value, AttemptError> {
    let response = client()
        .post(COMPLETIONS_URL)
        .bearer_auth(api_key.trim())
        .json(payload)
        .send()
        .await
        .map_err(|e| AttemptError::Retriable(format!("transcription request failed: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AttemptError::Retriable(format!("transcription reply unreadable: {e}")))?;

    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|body| {
                body.pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(200).collect());
        let message = format!("OpenRouter returned {status}: {detail}");
        return Err(if status.as_u16() == 429 || status.is_server_error() {
            AttemptError::Retriable(message)
        } else {
            AttemptError::Fatal(message)
        });
    }

    serde_json::from_str(&text)
        .map_err(|e| AttemptError::Fatal(format!("OpenRouter returned invalid json: {e}")))
}

/// Transcribes already trimmed audio, retrying rate limits and server errors.
pub(crate) async fn transcribe_with_chat_model(
    api_key: &str,
    model: &str,
    samples: &[f32],
    sample_rate: u32,
) -> Result<String, String> {
    let rate = if sample_rate == 0 {
        SAMPLE_RATE as u32
    } else {
        sample_rate
    };
    let wav = encode_wav(samples, rate);
    let payload = build_transcription_payload(model, &wav);

    let mut attempts = 0u32;
    loop {
        match request_transcript(api_key, &payload).await {
            Ok(body) => return Ok(read_transcript(&body)),
            Err(AttemptError::Fatal(message)) => return Err(message),
            Err(AttemptError::Retriable(message)) => {
                attempts += 1;
                if attempts >= MAX_ATTEMPTS {
                    return Err(format!(
                        "transcription failed after {attempts} attempts. last error: {message}"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(300 * u64::from(attempts))).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_describes_mono_16bit_pcm() {
        let wav = encode_wav(&[0.0, 1.0, -1.0], 16_000);
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(
            i16::from_le_bytes(wav[46..48].try_into().unwrap()),
            i16::MAX
        );
        assert_eq!(
            i16::from_le_bytes(wav[48..50].try_into().unwrap()),
            -i16::MAX
        );
    }

    #[test]
    fn payload_sends_audio_as_wav_input() {
        let payload = build_transcription_payload("openai/gpt-audio-mini", b"abc");
        assert_eq!(payload["model"], "openai/gpt-audio-mini");
        assert!(payload.get("reasoning").is_none());
        assert_eq!(payload["provider"]["sort"], "latency");
        let content = &payload["messages"][0]["content"];
        assert_eq!(content[0]["type"], "text");
        assert!(content[0]["text"].as_str().unwrap().contains("claude code"));
        assert_eq!(content[1]["type"], "input_audio");
        assert_eq!(content[1]["input_audio"]["format"], "wav");
        assert_eq!(content[1]["input_audio"]["data"], STANDARD.encode(b"abc"));
    }

    #[test]
    fn only_the_listed_chat_models_go_through_chat_completions() {
        assert!(is_chat_audio_model("openai/gpt-audio-mini"));
        assert!(is_chat_audio_model("google/gemini-3.1-flash-lite"));
        assert!(!is_chat_audio_model("openai/whisper-1"));
    }

    #[test]
    fn transcript_is_trimmed_and_unquoted() {
        let body =
            json!({ "choices": [{ "message": { "content": " \"open two terminals\"\n" } }] });
        assert_eq!(read_transcript(&body), "open two terminals");
        assert_eq!(read_transcript(&json!({})), "");
    }
}
