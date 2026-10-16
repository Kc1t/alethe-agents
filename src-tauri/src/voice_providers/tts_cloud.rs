//! Cloud text-to-speech: request building and reply decoding for each provider, plus the text
//! splitting that keeps every request under the providers' input limits.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use super::http::{
    auth_headers, safe_path_id, send, CloudError, CloudErrorKind, HttpBody, HttpMethod, HttpRequest,
};
use super::{openrouter, CloudProvider};
use crate::audio_out::pcm16le_to_f32;

/// Under every provider's single-request limit (OpenAI 4096, ElevenLabs 5000).
pub const MAX_TTS_CHARS: usize = 4000;
/// OpenAI, ElevenLabs and Gemini return 16-bit mono PCM at 24 kHz when asked for PCM. OpenRouter
/// is asked for MP3 instead (its PCM rate is model-dependent) and plays at the decoded rate.
pub const CLOUD_PCM_RATE: u32 = 24_000;
const TIMEOUT: Duration = Duration::from_secs(30);
const ELEVENLABS_SPEED: (f32, f32) = (0.7, 1.2);

/// Byte ranges of the sentences in `text`. `.`, `!` and `?` end a sentence only before whitespace
/// or the end of the text, so file names, versions and domains stay whole; a newline always does.
fn sentence_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        let ends = match ch {
            '\n' => true,
            '.' | '!' | '?' => chars.peek().is_none_or(|(_, next)| next.is_whitespace()),
            _ => false,
        };
        if ends {
            let end = index + ch.len_utf8();
            out.push((start, end));
            start = end;
        }
    }
    if start < text.len() {
        out.push((start, text.len()));
    }
    out
}

/// Byte ranges of the words in `range`, each with the whitespace before it.
fn word_ranges(text: &str, (start, end): (usize, usize)) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = start;
    let mut in_word = false;
    for (offset, ch) in text[start..end].char_indices() {
        if ch.is_whitespace() {
            if in_word {
                out.push((from, start + offset));
                from = start + offset;
                in_word = false;
            }
        } else {
            in_word = true;
        }
    }
    if from < end {
        out.push((from, end));
    }
    out
}

/// Cuts `range` into pieces of at most `max` non-blank characters, on character boundaries.
fn char_ranges(text: &str, (start, end): (usize, usize), max: usize) -> Vec<(usize, usize)> {
    let lead = text[start..end].len() - text[start..end].trim_start().len();
    let mut out = Vec::new();
    let mut from = start;
    let mut count = 0;
    for (offset, _) in text[start + lead..end].char_indices() {
        if count == max {
            let at = start + lead + offset;
            out.push((from, at));
            from = at;
            count = 0;
        }
        count += 1;
    }
    if from < end {
        out.push((from, end));
    }
    out
}

fn fits(text: &str, (start, end): (usize, usize), max: usize) -> bool {
    text[start..end].trim().chars().count() <= max
}

/// The chunks of `split_for_tts_spans` alone.
#[cfg(test)]
pub fn split_for_tts(text: &str, max_chars: usize) -> Vec<String> {
    split_for_tts_spans(text, max_chars)
        .into_iter()
        .map(|(_, chunk)| chunk)
        .collect()
}

/// Splits at sentence ends, packing sentences up to `max_chars` characters. Chunks are slices of
/// the original text (only their ends are trimmed), so no character is dropped or rewritten; a
/// sentence over the limit is cut between words, and a word over the limit between characters.
/// Each chunk comes with where it starts in `text`, in characters (code points), so the player can
/// tell which words of the text it is speaking.
pub fn split_for_tts_spans(text: &str, max_chars: usize) -> Vec<(usize, String)> {
    let max = max_chars.max(1);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let char_start = |byte: usize| text[..byte].chars().count();
    if trimmed.chars().count() <= max {
        let lead = text.len() - text.trim_start().len();
        return vec![(char_start(lead), trimmed.to_string())];
    }
    let mut units = Vec::new();
    for sentence in sentence_ranges(text) {
        if fits(text, sentence, max) {
            units.push(sentence);
            continue;
        }
        for word in word_ranges(text, sentence) {
            if fits(text, word, max) {
                units.push(word);
            } else {
                units.extend(char_ranges(text, word, max));
            }
        }
    }
    let mut chunks = Vec::new();
    let mut push = |range: (usize, usize)| {
        let slice = &text[range.0..range.1];
        let chunk = slice.trim();
        if !chunk.is_empty() {
            let lead = slice.len() - slice.trim_start().len();
            chunks.push((char_start(range.0 + lead), chunk.to_string()));
        }
    };
    let mut current: Option<(usize, usize)> = None;
    for (start, end) in units {
        match current {
            Some((from, _)) if fits(text, (from, end), max) => current = Some((from, end)),
            _ => {
                if let Some(range) = current.take() {
                    push(range);
                }
                if !text[start..end].trim().is_empty() {
                    current = Some((start, end));
                }
            }
        }
    }
    if let Some(range) = current {
        push(range);
    }
    chunks
}

/// Decoded speech, mono, at the rate it was produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// A voice of the ElevenLabs account; `language` comes from its labels and may be empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountVoice {
    pub id: String,
    pub name: String,
    pub language: String,
}

/// The voice used when none is chosen. ElevenLabs voices belong to the account, so the caller
/// must pick one; OpenRouter voices belong to each model, so it is the model's first known voice,
/// or none at all (the provider's own default) when the model's voices are not known.
fn default_voice(provider: CloudProvider, model: &str) -> Option<String> {
    match provider {
        CloudProvider::Openai => Some("alloy".to_string()),
        CloudProvider::Gemini => Some("Kore".to_string()),
        CloudProvider::Openrouter => openrouter::cached_voices(model)?.into_iter().next(),
        CloudProvider::Elevenlabs => None,
    }
}

pub fn speech_request(
    provider: CloudProvider,
    model: &str,
    voice: Option<&str>,
    key: &str,
    text: &str,
    rate: f32,
) -> Result<HttpRequest, CloudError> {
    let voice = voice
        .map(str::to_string)
        .or_else(|| default_voice(provider, model));
    let (url, body) = match provider {
        CloudProvider::Openai => (
            "https://api.openai.com/v1/audio/speech".to_string(),
            json!({
                "model": model,
                "input": text,
                "voice": voice.ok_or_else(|| CloudError::of(CloudErrorKind::Other))?,
                "response_format": "pcm",
                "speed": rate.clamp(0.25, 4.0),
            }),
        ),
        CloudProvider::Openrouter => {
            let mut body = json!({
                "model": model,
                "input": text,
                "response_format": format,
                "speed": rate.clamp(0.25, 4.0),
            });
            if let Some(voice) = voice {
                body["voice"] = json!(voice);
            }
            (
                "https://openrouter.ai/api/v1/audio/speech".to_string(),
                body,
            )
        }
        CloudProvider::Elevenlabs => {
            let voice = voice.ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
            (
                format!(
                    "https://api.elevenlabs.io/v1/text-to-speech/{}?output_format=pcm_24000",
                    safe_path_id(&voice)?
                ),
                json!({
                    "text": text,
                    "model_id": model,
                    "voice_settings": { "speed": rate.clamp(ELEVENLABS_SPEED.0, ELEVENLABS_SPEED.1) },
                }),
            )
        }
        CloudProvider::Gemini => (
            format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                safe_path_id(model)?
            ),
            json!({
                "contents": [{ "parts": [{ "text": text }] }],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } }
                }
            }),
        ),
    };
    Ok(HttpRequest {
        method: HttpMethod::Post,
        url,
        headers: auth_headers(provider, key),
        body: HttpBody::Json(body),
        audio: false,
    })
}

/// Decodes an MP3 reply to mono samples at the stream's own rate. Frames are averaged across
/// channels; a corrupt frame is skipped, anything else that fails is an error.
fn decode_mp3(body: &[u8]) -> Result<Pcm, CloudError> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::errors::Error;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let invalid = || CloudError::of(CloudErrorKind::Other);
    let source = MediaSourceStream::new(
        Box::new(std::io::Cursor::new(body.to_vec())),
        Default::default(),
    );
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| invalid())?
        .format;
    let track = format.default_track().ok_or_else(invalid)?;
    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| invalid())?;
    let mut samples = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(_) => return Err(invalid()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(Error::DecodeError(_)) => continue,
            Err(_) => return Err(invalid()),
        };
        let spec = *decoded.spec();
        sample_rate = Some(spec.rate);
        let channels = spec.channels.count().max(1);
        let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        samples.extend(
            buffer
                .samples()
                .chunks(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
    }
    match sample_rate {
        Some(sample_rate) if sample_rate > 0 && !samples.is_empty() => Ok(Pcm {
            samples,
            sample_rate,
        }),
        _ => Err(invalid()),
    }
}

pub fn parse_speech(provider: CloudProvider, body: &[u8]) -> Result<Pcm, CloudError> {
    let pcm = |samples| Pcm {
        samples,
        sample_rate: CLOUD_PCM_RATE,
    };
    match provider {
        CloudProvider::Openrouter => return decode_mp3(body),
        CloudProvider::Openai | CloudProvider::Elevenlabs => return Ok(pcm(pcm16le_to_f32(body))),
        CloudProvider::Gemini => {}
    }
    let value: Value =
        serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let data = value["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
        .as_str()
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    Ok(pcm(pcm16le_to_f32(&bytes)))
}

/// The rate to declare to the player for audio decoded at `sample_rate`. Native speed when the
/// provider has one; the remainder is applied by playing the audio faster or slower.
pub fn playback_rate(provider: CloudProvider, rate: f32, sample_rate: u32) -> u32 {
    let residual = match provider {
        CloudProvider::Openai | CloudProvider::Openrouter => 1.0,
        CloudProvider::Elevenlabs => rate / rate.clamp(ELEVENLABS_SPEED.0, ELEVENLABS_SPEED.1),
        CloudProvider::Gemini => rate,
    };
    (sample_rate as f32 * residual).round() as u32
}

/// The voices of the ElevenLabs account the key belongs to.
pub fn voices_request(key: &str) -> HttpRequest {
    HttpRequest {
        method: HttpMethod::Get,
        url: "https://api.elevenlabs.io/v1/voices".to_string(),
        headers: auth_headers(CloudProvider::Elevenlabs, key),
        body: HttpBody::Empty,
        audio: false,
    }
}

pub fn parse_voices(body: &[u8]) -> Result<Vec<AccountVoice>, CloudError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| CloudError::of(CloudErrorKind::Other))?;
    let voices = value["voices"]
        .as_array()
        .ok_or_else(|| CloudError::of(CloudErrorKind::Other))?;
    Ok(voices
        .iter()
        .filter_map(|voice| {
            let labels = &voice["labels"];
            let label = |name: &str| labels[name].as_str().filter(|value| !value.is_empty());
            let language = label("language")
                .or_else(|| label("accent"))
                .unwrap_or_default()
                .to_string();
            Some(AccountVoice {
                id: voice["voice_id"].as_str()?.to_string(),
                name: voice["name"].as_str()?.to_string(),
                language,
            })
        })
        .collect())
}

pub async fn fetch_voices(key: &str) -> Result<Vec<AccountVoice>, CloudError> {
    parse_voices(&send(voices_request(key), TIMEOUT).await?)
}

pub async fn synthesize(
    provider: CloudProvider,
    model: &str,
    voice: Option<&str>,
    key: &str,
    text: &str,
    rate: f32,
) -> Result<Pcm, CloudError> {
    let request = speech_request(provider, model, voice, key, text, rate)?;
    parse_speech(provider, &send(request, TIMEOUT).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_providers::http::HttpBody;

    #[test]
    fn split_for_tts_keeps_short_text_whole() {
        assert_eq!(split_for_tts("Olá. Tudo bem?", 100), vec!["Olá. Tudo bem?"]);
        assert!(split_for_tts("   ", 100).is_empty());
    }

    #[test]
    fn split_for_tts_groups_sentences_under_the_limit() {
        let chunks = split_for_tts("One two. Three four. Five six.", 18);
        assert_eq!(chunks, vec!["One two.", "Three four.", "Five six."]);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 18));
        assert_eq!(chunks.join(" "), "One two. Three four. Five six.");
        assert_eq!(
            split_for_tts("One two. Three four.", 40),
            vec!["One two. Three four."]
        );
    }

    #[test]
    fn split_for_tts_cuts_a_long_sentence_at_spaces_without_losing_words() {
        let text = "palavra ".repeat(50);
        let chunks = split_for_tts(&text, 40);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 40));
        let words: Vec<&str> = chunks.iter().flat_map(|c| c.split_whitespace()).collect();
        assert_eq!(words.len(), 50);
    }

    #[test]
    fn speech_requests_ask_for_pcm_except_openrouter_mp3() {
        let openai = speech_request(
            CloudProvider::Openai,
            "gpt-4o-mini-tts",
            Some("nova"),
            "k",
            "hi",
            1.5,
        )
        .unwrap();
        assert_eq!(openai.url, "https://api.openai.com/v1/audio/speech");
        let HttpBody::Json(body) = openai.body else {
            panic!("json")
        };
        assert_eq!(body["response_format"], "pcm");
        assert_eq!(body["voice"], "nova");
        assert_eq!(body["speed"], 1.5);

        let eleven = speech_request(
            CloudProvider::Elevenlabs,
            "eleven_flash_v2_5",
            Some("v1"),
            "k",
            "hi",
            1.0,
        )
        .unwrap();
        assert_eq!(
            eleven.url,
            "https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=pcm_24000"
        );
        assert!(speech_request(CloudProvider::Elevenlabs, "m", None, "k", "hi", 1.0).is_err());

        let gemini = speech_request(
            CloudProvider::Gemini,
            "gemini-2.5-flash-preview-tts",
            None,
            "k",
            "hi",
            1.0,
        )
        .unwrap();
        let HttpBody::Json(body) = gemini.body else {
            panic!("json")
        };
        assert_eq!(body["generationConfig"]["responseModalities"][0], "AUDIO");
        assert_eq!(
            body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]
                ["voiceName"],
            "Kore"
        );

        let router = speech_request(
            CloudProvider::Openrouter,
            "openai/gpt-4o-mini-tts-2025-12-15",
            Some("alloy"),
            "k",
            "hi",
            1.0,
        )
        .unwrap();
        assert_eq!(router.url, "https://openrouter.ai/api/v1/audio/speech");
        let HttpBody::Json(body) = router.body else {
            panic!("json")
        };
        // OpenRouter's PCM rate is model-dependent and undocumented, so it is asked for MP3.
        assert_eq!(body["response_format"], "mp3");
        assert_eq!(body["voice"], "alloy");
        assert_eq!(body["input"], "hi");
    }

    fn request_voice(provider: CloudProvider, model: &str) -> Option<String> {
        let request = speech_request(provider, model, None, "k", "hi", 1.0).unwrap();
        let HttpBody::Json(body) = request.body else {
            panic!("json")
        };
        body["voice"]
            .as_str()
            .or(
                body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]
                    ["voiceName"]
                    .as_str(),
            )
            .map(str::to_string)
    }

    #[test]
    fn an_unset_voice_defaults_to_a_voice_from_the_provider_catalog() {
        assert_eq!(
            request_voice(CloudProvider::Openai, "m").as_deref(),
            Some("alloy")
        );
        assert_eq!(
            request_voice(CloudProvider::Gemini, "m").as_deref(),
            Some("Kore")
        );
        for provider in [CloudProvider::Openai, CloudProvider::Gemini] {
            let voice = request_voice(provider, "m").unwrap();
            assert!(
                crate::voice_providers::catalog::provider_catalog(provider)
                    .voices
                    .iter()
                    .any(|entry| entry.id == voice),
                "{provider:?} default voice {voice} is not in its catalog"
            );
        }
    }

    #[test]
    fn an_unset_openrouter_voice_follows_the_model_voices_or_is_left_out() {
        crate::voice_providers::openrouter::cache_for_test(&[
            ("test/voiced-tts", &["pf_dora", "pm_alex"]),
            ("test/voiceless-tts", &[]),
        ]);
        assert_eq!(
            request_voice(CloudProvider::Openrouter, "test/voiced-tts").as_deref(),
            Some("pf_dora")
        );
        // Unknown or voiceless model: the provider picks its own default, never a Gemini voice.
        assert_eq!(
            request_voice(CloudProvider::Openrouter, "test/voiceless-tts"),
            None
        );
        assert_eq!(
            request_voice(CloudProvider::Openrouter, "test/unknown-tts"),
            None
        );
        let explicit = speech_request(
            CloudProvider::Openrouter,
            "test/voiced-tts",
            Some("pm_alex"),
            "k",
            "hi",
            1.0,
        )
        .unwrap();
        let HttpBody::Json(body) = explicit.body else {
            panic!("json")
        };
        assert_eq!(body["voice"], "pm_alex");
    }

    #[test]
    fn split_for_tts_keeps_dotted_tokens_and_original_text() {
        assert_eq!(split_for_tts("main.rs v1.2", 4000), vec!["main.rs v1.2"]);
        let sentence = "Edit main.rs and bump to v1.2.3 at example.com.";
        assert_eq!(split_for_tts(sentence, 4000), vec![sentence]);
        assert_eq!(
            split_for_tts("Edit main.rs now. Bump v1.2.3 at example.com.", 20),
            vec!["Edit main.rs now.", "Bump v1.2.3 at", "example.com."]
        );
        assert_eq!(
            split_for_tts("One  two. Three.", 10),
            vec!["One  two.", "Three."],
            "spacing inside a chunk is kept"
        );
    }

    #[test]
    fn split_for_tts_cuts_an_oversized_word_without_losing_chars() {
        let word = "a".repeat(25);
        let chunks = split_for_tts(&format!("Say {word} now."), 10);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 10));
        let joined: String = chunks
            .concat()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert_eq!(joined, format!("Say{word}now."));

        let multibyte = "çã".repeat(5);
        let chunks = split_for_tts(&multibyte, 5);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 5));
        assert_eq!(chunks.concat(), multibyte);
    }

    #[test]
    fn split_for_tts_with_a_zero_limit_terminates() {
        let chunks = split_for_tts("ab cd", 0);
        assert_eq!(chunks.concat(), "abcd");
        assert!(chunks.iter().all(|chunk| chunk.chars().count() == 1));
    }

    #[test]
    fn ids_in_url_paths_are_validated() {
        for bad in ["a/b", "../x", "..", "v 1", "v?x=1", "v#x", "", "ü"] {
            assert!(
                speech_request(CloudProvider::Elevenlabs, "m", Some(bad), "k", "hi", 1.0).is_err(),
                "voice {bad:?}"
            );
            assert!(
                speech_request(CloudProvider::Gemini, bad, None, "k", "hi", 1.0).is_err(),
                "model {bad:?}"
            );
        }
        assert!(speech_request(
            CloudProvider::Elevenlabs,
            "m",
            Some("21m00Tcm4TlvDq8ikWAM"),
            "k",
            "hi",
            1.0
        )
        .is_ok());
        assert!(speech_request(
            CloudProvider::Gemini,
            "gemini-2.5-flash-preview-tts",
            None,
            "k",
            "hi",
            1.0
        )
        .is_ok());
        // Body-only ids are not path ids.
        assert!(speech_request(
            CloudProvider::Openrouter,
            "google/gemini-3.8-flash-tts",
            None,
            "k",
            "hi",
            1.0
        )
        .is_ok());
    }

    #[test]
    fn replies_decode_to_samples() {
        let raw = [0x00, 0x00, 0xff, 0x7f];
        let openai = parse_speech(CloudProvider::Openai, &raw, None).unwrap();
        assert_eq!(openai.samples.len(), 2);
        assert_eq!(openai.sample_rate, CLOUD_PCM_RATE);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let gemini = format!(
            r#"{{"candidates":[{{"content":{{"parts":[{{"inlineData":{{"mimeType":"audio/L16;rate=24000","data":"{encoded}"}}}}]}}}}]}}"#
        );
        let gemini = parse_speech(CloudProvider::Gemini, gemini.as_bytes(), None).unwrap();
        assert_eq!(gemini.samples.len(), 2);
        assert_eq!(gemini.sample_rate, CLOUD_PCM_RATE);
        assert!(parse_speech(CloudProvider::Gemini, b"{}", None).is_err());
    }

    /// 0.25 s of a 440 Hz tone, stereo, 22.05 kHz, 32 kbps (ffmpeg + libmp3lame, no tags).
    const TONE_MP3: &[u8] = include_bytes!("testdata/tone.mp3");

    #[test]
    fn openrouter_mp3_replies_decode_to_mono_at_their_own_rate() {
        let pcm = parse_speech(CloudProvider::Openrouter, TONE_MP3, None).unwrap();
        assert_eq!(pcm.sample_rate, 22_050);
        // Stereo frames are downmixed: about 0.25 s of mono samples (plus encoder padding).
        assert!(
            (5_000..=8_000).contains(&pcm.samples.len()),
            "{} samples",
            pcm.samples.len()
        );
        assert!(pcm.samples.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        assert!(
            pcm.samples.iter().any(|s| s.abs() > 0.05),
            "the tone (peak about -21 dBFS) is not silence"
        );
    }

    #[test]
    fn undecodable_openrouter_replies_are_errors() {
        for body in [&b""[..], b"not audio", br#"{"error":"x"}"#] {
            let error = parse_speech(CloudProvider::Openrouter, body, None).unwrap_err();
            assert_eq!(error.kind, CloudErrorKind::Other, "{body:?}");
        }
    }

    #[test]
    fn speed_is_native_where_supported_and_resampled_elsewhere() {
        assert_eq!(
            playback_rate(CloudProvider::Openai, "m", 1.5, 24_000),
            24_000
        );
        assert_eq!(
            playback_rate(CloudProvider::Gemini, "m", 1.5, 24_000),
            36_000
        );
        assert_eq!(
            playback_rate(CloudProvider::Elevenlabs, "m", 1.0, 24_000),
            24_000
        );
        assert_eq!(
            playback_rate(CloudProvider::Elevenlabs, "m", 1.5, 24_000),
            30_000,
            "1.2 native x 1.25 resample"
        );
        // Gemini behind OpenRouter ignores `speed`: the player makes up for it.
        assert_eq!(
            playback_rate(
                CloudProvider::Openrouter,
                "google/gemini-3.8-flash-lite-tts",
                1.5,
                24_000
            ),
            36_000
        );
        // OpenRouter speaks at native speed; the decoded MP3 plays at its own rate.
        assert_eq!(
            playback_rate(CloudProvider::Openrouter, "m", 1.5, 22_050),
            22_050
        );
        assert_eq!(
            playback_rate(CloudProvider::Openrouter, "m", 1.0, 44_100),
            44_100
        );
    }

    #[test]
    fn elevenlabs_voices_are_read_from_the_account() {
        let body = br#"{"voices":[
            {"voice_id":"a1","name":"Ana","labels":{"language":"pt","accent":"brazilian"}},
            {"voice_id":"b2","name":"Bruno","labels":{"accent":"american","gender":"male"}},
            {"voice_id":"c3","name":"Caio"},
            {"voice_id":"d4"}
        ]}"#;
        let voice = |id: &str, name: &str, language: &str| AccountVoice {
            id: id.into(),
            name: name.into(),
            language: language.into(),
        };
        assert_eq!(
            parse_voices(body).unwrap(),
            vec![
                voice("a1", "Ana", "pt"),
                voice("b2", "Bruno", "american"),
                voice("c3", "Caio", ""),
            ]
        );
        assert_eq!(
            voices_request("k").url,
            "https://api.elevenlabs.io/v1/voices"
        );
    }
}
