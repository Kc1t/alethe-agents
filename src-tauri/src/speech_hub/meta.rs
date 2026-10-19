//! What a person reads about a Hugging Face model: label, languages, estimated tiers, voices.
//! Tiers are estimates from family and size (spec §6); curated values live in the frontend.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::detect::Family;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubVoice {
    /// sherpa speaker id.
    pub id: u32,
    pub name: String,
    /// BCP-47 tag; empty when unknown.
    pub language: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub label: String,
    pub languages: Vec<String>,
    pub language_count: Option<u32>,
    pub multilingual: bool,
    pub speed: Option<u8>,
    pub accuracy: Option<u8>,
    pub voices: Vec<HubVoice>,
    /// Speakers in the model when known without loading it; 0 when unknown.
    #[serde(default)]
    pub voice_count: u32,
}

/// The parts of a Piper `*.onnx.json` the search uses.
#[derive(Debug, Default, Deserialize)]
pub struct PiperConfig {
    #[serde(default)]
    pub language: Option<PiperLanguage>,
    #[serde(default)]
    pub audio: Option<PiperAudio>,
    #[serde(default)]
    pub num_speakers: Option<u32>,
    #[serde(default)]
    pub speaker_id_map: Option<BTreeMap<String, u32>>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PiperLanguage {
    pub code: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PiperAudio {
    pub quality: Option<String>,
}

/// Kokoro v1.0 speakers in sherpa-onnx speaker-id order (54 with `em_santa` added at 53).
const KOKORO_V1_0: &[&str] = &[
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_heart",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "ef_dora",
    "em_alex",
    "ff_siwis",
    "hf_alpha",
    "hf_beta",
    "hm_omega",
    "hm_psi",
    "if_sara",
    "im_nicola",
    "jf_alpha",
    "jf_gongitsune",
    "jf_nezumi",
    "jf_tebukuro",
    "jm_kumo",
    "pf_dora",
    "pm_alex",
    "pm_santa",
    "zf_xiaobei",
    "zf_xiaoni",
    "zf_xiaoxiao",
    "zf_xiaoyi",
    "zm_yunjian",
    "zm_yunxi",
    "zm_yunxia",
    "zm_yunyang",
    "em_santa",
];
const KOKORO_V0_19: &[&str] = &[
    "af",
    "af_bella",
    "af_nicole",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
];
const KITTEN: &[&str] = &[
    "expr-voice-2-m",
    "expr-voice-2-f",
    "expr-voice-3-m",
    "expr-voice-3-f",
    "expr-voice-4-m",
    "expr-voice-4-f",
    "expr-voice-5-m",
    "expr-voice-5-f",
];
const KOKORO_V1_0_LANGUAGES: &[&str] = &[
    "en-US", "en-GB", "es", "fr", "hi", "it", "ja", "pt-BR", "zh",
];

/// Two- and three-letter codes recognized as language tokens in repo names.
const LANGUAGE_CODES: &[&str] = &[
    "en", "zh", "ja", "ko", "yue", "pt", "es", "fr", "de", "it", "ru", "ar", "hi", "fa", "vi",
    "th", "tr", "pl", "nl", "uk", "cs", "id", "bn", "ta", "te", "sv", "fi", "da", "el", "he", "hu",
    "ro", "bg", "sk", "sl", "hr", "ca", "kk", "be", "uz", "ur", "sw",
];

fn piper_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^vits-piper-([a-z]{2,3})_([A-Za-z]{2})-(.+?)-(x_low|low|medium|high)(?:-(?:int8|fp16))?$").unwrap()
    })
}

fn trailing_date() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap())
}

fn region_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([a-z]{2,3})_([A-Z]{2})$").unwrap())
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn base_name(repo_name: &str) -> &str {
    repo_name.strip_prefix("sherpa-onnx-").unwrap_or(repo_name)
}

/// `kokoro-multi-lang-v1_0` → `Kokoro multi lang v1.0`; a trailing date is dropped.
fn humanize(repo_name: &str) -> String {
    let base = trailing_date().replace(base_name(repo_name), "");
    let words: Vec<String> = base
        .split('-')
        .filter(|word| !word.is_empty())
        .map(|word| {
            let is_version = word.len() > 1
                && word.starts_with('v')
                && word[1..].chars().all(|c| c.is_ascii_digit() || c == '_');
            if is_version {
                word.replace('_', ".")
            } else {
                word.to_string()
            }
        })
        .collect();
    capitalize(&words.join(" "))
}

/// Tokens of the name, split on `-` and `.` (`tiny.en` gives `tiny`, `en`).
fn tokens(repo_name: &str) -> Vec<String> {
    base_name(repo_name)
        .to_ascii_lowercase()
        .split(['-', '.'])
        .map(str::to_string)
        .collect()
}

fn has(repo_name: &str, word: &str) -> bool {
    tokens(repo_name)
        .iter()
        .any(|token| token == word || token.split('_').any(|part| part == word))
}

fn languages_from_name(repo_name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |tag: String| {
        if !out.contains(&tag) {
            out.push(tag);
        }
    };
    for token in base_name(repo_name).split(['-', '.']) {
        if let Some(caps) = region_tag().captures(token) {
            push(format!("{}-{}", &caps[1], &caps[2]));
            continue;
        }
        for part in token.split('_') {
            let part = part.to_ascii_lowercase();
            if LANGUAGE_CODES.contains(&part.as_str()) {
                push(part);
            }
        }
    }
    out
}

fn kokoro_language(name: &str) -> &'static str {
    match name.chars().next() {
        Some('a') => "en-US",
        Some('b') => "en-GB",
        Some('e') => "es",
        Some('f') => "fr",
        Some('h') => "hi",
        Some('i') => "it",
        Some('j') => "ja",
        Some('p') => "pt-BR",
        Some('z') => "zh",
        _ => "",
    }
}

fn kokoro_voices(names: &[&str]) -> Vec<HubVoice> {
    names
        .iter()
        .enumerate()
        .map(|(id, name)| HubVoice {
            id: id as u32,
            name: capitalize(name.split_once('_').map_or(*name, |(_, rest)| rest)),
            language: kokoro_language(name).to_string(),
        })
        .collect()
}

fn estimate(family: Family, repo_name: &str, quality: Option<&str>) -> (Option<u8>, Option<u8>) {
    let tiers = |speed: u8, accuracy: u8| (Some(speed), Some(accuracy));
    let size = |word: &str| has(repo_name, word);
    match family {
        Family::Vits => match quality {
            Some("x_low" | "low") => tiers(3, 1),
            Some("medium") => tiers(3, 2),
            Some("high") => tiers(2, 2),
            _ => (None, None),
        },
        Family::Kokoro => tiers(2, 3),
        Family::Kitten if size("nano") => tiers(3, 1),
        Family::Kitten if size("mini") => tiers(3, 2),
        Family::Whisper if size("distil") && size("large") => tiers(2, 3),
        Family::Whisper if size("tiny") || size("base") => tiers(3, 1),
        Family::Whisper if size("small") => tiers(2, 2),
        Family::Whisper if size("medium") => tiers(1, 2),
        Family::Whisper if size("turbo") => tiers(2, 3),
        Family::Whisper if repo_name.contains("large") => tiers(1, 3),
        Family::Moonshine if size("tiny") => tiers(3, 1),
        Family::Moonshine if size("base") => tiers(3, 2),
        Family::SenseVoice | Family::Paraformer => tiers(3, 2),
        Family::NemoCtc if size("small") => tiers(3, 1),
        Family::NemoCtc if size("medium") => tiers(3, 2),
        Family::NemoCtc if size("large") => tiers(2, 2),
        Family::Transducer => tiers(3, 2),
        Family::NemoTransducer => tiers(2, 3),
        Family::Dolphin if size("base") => tiers(3, 2),
        Family::Dolphin if size("small") => tiers(2, 2),
        _ => (None, None),
    }
}

pub fn describe(family: Family, repo_name: &str, piper: Option<&PiperConfig>) -> ModelMeta {
    let mut meta = ModelMeta {
        label: humanize(repo_name),
        languages: languages_from_name(repo_name),
        multilingual: repo_name.contains("multi-lang") || repo_name.contains("multilingual"),
        ..Default::default()
    };
    let mut quality = piper
        .and_then(|c| c.audio.as_ref())
        .and_then(|a| a.quality.clone());
    match family {
        Family::Vits => {
            if let Some(caps) = piper_name().captures(repo_name) {
                let tag = format!("{}-{}", &caps[1], &caps[2]);
                let level = caps[4].replace('_', "-");
                meta.label = format!("Piper · {} ({tag}, {level})", capitalize(&caps[3]));
                meta.languages = vec![tag];
                quality.get_or_insert_with(|| caps[4].to_string());
            }
            if let Some(code) = piper
                .and_then(|c| c.language.as_ref())
                .and_then(|l| l.code.as_deref())
            {
                meta.languages = vec![code.replace('_', "-")];
            }
            let language = meta.languages.first().cloned().unwrap_or_default();
            if let Some(map) = piper
                .and_then(|c| c.speaker_id_map.as_ref())
                .filter(|m| m.len() > 1)
            {
                let mut voices: Vec<HubVoice> = map
                    .iter()
                    .map(|(name, id)| HubVoice {
                        id: *id,
                        name: name.clone(),
                        language: language.clone(),
                    })
                    .collect();
                voices.sort_by_key(|voice| voice.id);
                meta.voices = voices;
            }
            meta.voice_count = piper
                .and_then(|c| c.num_speakers)
                .unwrap_or(1)
                .max(meta.voices.len() as u32);
        }
        Family::Kokoro => {
            if repo_name.contains("v1_0") {
                meta.languages = KOKORO_V1_0_LANGUAGES
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                meta.voices = kokoro_voices(KOKORO_V1_0);
            } else if repo_name.contains("v1_1") {
                meta.languages = vec!["zh".into(), "en".into()];
            } else if repo_name.contains("v0_19") {
                meta.languages = vec!["en".into()];
                meta.voices = kokoro_voices(KOKORO_V0_19);
            }
            meta.multilingual = false;
            meta.voice_count = meta.voices.len() as u32;
        }
        Family::Kitten => {
            meta.languages = vec!["en".into()];
            meta.voices = KITTEN
                .iter()
                .enumerate()
                .map(|(id, name)| HubVoice {
                    id: id as u32,
                    name: (*name).into(),
                    language: "en".into(),
                })
                .collect();
            meta.voice_count = meta.voices.len() as u32;
        }
        Family::Whisper => {
            if repo_name.ends_with(".en") || repo_name.ends_with("-en") {
                meta.languages = vec!["en".into()];
            } else {
                meta.languages.clear();
                meta.language_count = Some(99);
            }
        }
        _ => {}
    }
    let (speed, accuracy) = estimate(family, repo_name, quality.as_deref());
    meta.speed = speed;
    meta.accuracy = accuracy;
    meta
}

/// The voice list when the manifest already names the speakers; `None` when only the engine can
/// count them.
pub fn known_voices(meta: &ModelMeta) -> Option<Vec<HubVoice>> {
    (!meta.voices.is_empty()).then(|| voice_list(&meta.voices, meta.voices.len() as i32))
}

/// The language of speaker `sid`, or of speaker 0 for an id the model does not name (synthesis
/// falls back to speaker 0 too); `None` when unknown.
pub fn speaker_language(meta: &ModelMeta, sid: i32) -> Option<&str> {
    let find = |id: u32| meta.voices.iter().find(|voice| voice.id == id);
    u32::try_from(sid)
        .ok()
        .and_then(find)
        .or_else(|| find(0))
        .map(|voice| voice.language.as_str())
        .filter(|language| !language.is_empty())
}

pub fn voice_list(named: &[HubVoice], reported: i32) -> Vec<HubVoice> {
    if reported <= 1 {
        return Vec::new();
    }
    if named.len() == reported as usize {
        return named.to_vec();
    }
    (0..reported as u32)
        .map(|id| HubVoice {
            id,
            name: format!("#{}", id + 1),
            language: String::new(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn piper_label_language_and_tiers_come_from_the_name() {
        let meta = describe(Family::Vits, "vits-piper-pt_BR-faber-medium", None);
        assert_eq!(meta.label, "Piper · Faber (pt-BR, medium)");
        assert_eq!(meta.languages, vec!["pt-BR"]);
        assert_eq!((meta.speed, meta.accuracy), (Some(3), Some(2)));
        assert_eq!(meta.voice_count, 1);
        let low = describe(Family::Vits, "vits-piper-en_US-amy-x_low", None);
        assert_eq!(low.label, "Piper · Amy (en-US, x-low)");
        assert_eq!((low.speed, low.accuracy), (Some(3), Some(1)));
        let high = describe(Family::Vits, "vits-piper-pt_PT-dii-high", None);
        assert_eq!((high.speed, high.accuracy), (Some(2), Some(2)));
    }

    #[test]
    fn piper_config_overrides_language_and_lists_speakers() {
        let config: PiperConfig = serde_json::from_str(
            r#"{"language":{"code":"en_US"},"audio":{"quality":"medium"},"num_speakers":3,
                "speaker_id_map":{"p1":1,"p0":0,"p2":2}}"#,
        )
        .unwrap();
        let meta = describe(
            Family::Vits,
            "vits-piper-en_US-libritts_r-medium",
            Some(&config),
        );
        assert_eq!(meta.languages, vec!["en-US"]);
        assert_eq!(
            meta.voices
                .iter()
                .map(|v| (v.id, v.name.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "p0"), (1, "p1"), (2, "p2")]
        );
        assert_eq!(meta.voice_count, 3);
    }

    #[test]
    fn kokoro_v1_names_its_portuguese_voices() {
        let meta = describe(Family::Kokoro, "kokoro-multi-lang-v1_0", None);
        assert_eq!(meta.label, "Kokoro multi lang v1.0");
        assert!(meta.languages.contains(&"pt-BR".to_string()));
        assert_eq!(meta.voices.len(), 54);
        let dora = meta.voices.iter().find(|v| v.id == 42).unwrap();
        assert_eq!(
            (dora.name.as_str(), dora.language.as_str()),
            ("Dora", "pt-BR")
        );
        assert_eq!((meta.speed, meta.accuracy), (Some(2), Some(3)));
        let int8 = describe(Family::Kokoro, "kokoro-int8-multi-lang-v1_0", None);
        assert_eq!(int8.voices.len(), 54);
        let v11 = describe(Family::Kokoro, "kokoro-multi-lang-v1_1", None);
        assert!(v11.voices.is_empty(), "v1.1 names come from the engine");
        assert_eq!(v11.languages, vec!["zh", "en"]);
    }

    #[test]
    fn kitten_has_eight_english_voices() {
        let meta = describe(Family::Kitten, "kitten-nano-en-v0_2-fp16", None);
        assert_eq!(meta.voices.len(), 8);
        assert_eq!(meta.languages, vec!["en"]);
        assert_eq!((meta.speed, meta.accuracy), (Some(3), Some(1)));
    }

    #[test]
    fn recognizer_languages_and_tiers() {
        let whisper = describe(Family::Whisper, "sherpa-onnx-whisper-turbo", None);
        assert_eq!(whisper.language_count, Some(99));
        assert_eq!((whisper.speed, whisper.accuracy), (Some(2), Some(3)));
        let tiny_en = describe(Family::Whisper, "sherpa-onnx-whisper-tiny.en", None);
        assert_eq!(tiny_en.languages, vec!["en"]);
        assert_eq!(tiny_en.language_count, None);
        let sense = describe(
            Family::SenseVoice,
            "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
            None,
        );
        assert_eq!(sense.languages, vec!["zh", "en", "ja", "ko", "yue"]);
        assert_eq!(sense.label, "Sense voice zh en ja ko yue");
        let dolphin = describe(
            Family::Dolphin,
            "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
            None,
        );
        assert!(dolphin.multilingual);
        assert_eq!((dolphin.speed, dolphin.accuracy), (Some(3), Some(2)));
        let unknown = describe(Family::Transducer, "sherpa-onnx-conformer-xx-2023", None);
        assert!(unknown.languages.is_empty() && unknown.language_count.is_none());
    }

    #[test]
    fn engine_count_decides_the_voice_list() {
        let named = vec![
            HubVoice {
                id: 0,
                name: "a".into(),
                language: "en".into(),
            },
            HubVoice {
                id: 1,
                name: "b".into(),
                language: "en".into(),
            },
        ];
        assert_eq!(voice_list(&named, 2), named);
        assert!(
            voice_list(&named, 1).is_empty(),
            "a single voice needs no picker"
        );
        let generic = voice_list(&named, 3);
        assert_eq!(
            generic.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(),
            vec!["#1", "#2", "#3"]
        );
        assert_eq!(voice_list(&[], 2).len(), 2);
    }

    fn named(languages: &[&str]) -> ModelMeta {
        ModelMeta {
            voices: languages
                .iter()
                .enumerate()
                .map(|(id, language)| HubVoice {
                    id: id as u32,
                    name: format!("v{id}"),
                    language: (*language).into(),
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn named_voices_are_listed_without_the_engine() {
        let meta = named(&["en-US", "pt-BR"]);
        assert_eq!(known_voices(&meta), Some(meta.voices.clone()));
        assert_eq!(known_voices(&named(&["en-US"])), Some(Vec::new()));
        let unnamed = ModelMeta {
            voice_count: 4,
            ..Default::default()
        };
        assert_eq!(
            known_voices(&unnamed),
            None,
            "only the engine can count them"
        );
    }

    #[test]
    fn a_speaker_language_falls_back_to_the_first_speaker() {
        let meta = named(&["en-US", "pt-BR"]);
        assert_eq!(speaker_language(&meta, 1), Some("pt-BR"));
        assert_eq!(speaker_language(&meta, 9), Some("en-US"));
        assert_eq!(speaker_language(&meta, -1), Some("en-US"));
        assert_eq!(speaker_language(&ModelMeta::default(), 0), None);
        assert_eq!(speaker_language(&named(&[""]), 0), None);
    }
}
