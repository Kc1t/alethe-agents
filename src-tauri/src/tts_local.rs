//! Local voices through sherpa-onnx (Piper/VITS, Kokoro, Kitten). Loading a voice reads 60–330 MB,
//! so the last one stays cached.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKittenModelConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig,
};

/// File names are relative to the voice folder; `espeak-ng-data/` and `dict/` are folders there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum TtsLayout {
    Vits { model: String, tokens: String, lexicon: Option<String>, data_dir: bool, dict_dir: bool, rule_fsts: Vec<String> },
    Kokoro { model: String, voices: String, tokens: String, lexicons: Vec<String>, dict_dir: bool, rule_fsts: Vec<String> },
    Kitten { model: String, voices: String, tokens: String },
}

impl TtsLayout {
    /// A Piper voice as the sherpa-onnx release archives ship it.
    pub fn piper(model_file: &str) -> Self {
        Self::Vits {
            model: model_file.into(),
            tokens: "tokens.txt".into(),
            lexicon: None,
            data_dir: true,
            dict_dir: false,
            rule_fsts: Vec::new(),
        }
    }

    /// Every single file the engine opens (folders not included).
    pub fn files(&self) -> Vec<&str> {
        let mut files: Vec<&str> = Vec::new();
        match self {
            Self::Vits { model, tokens, lexicon, rule_fsts, .. } => {
                files.extend([model.as_str(), tokens.as_str()]);
                files.extend(lexicon.as_deref());
                files.extend(rule_fsts.iter().map(String::as_str));
            }
            Self::Kokoro { model, voices, tokens, lexicons, rule_fsts, .. } => {
                files.extend([model.as_str(), voices.as_str(), tokens.as_str()]);
                files.extend(lexicons.iter().map(String::as_str));
                files.extend(rule_fsts.iter().map(String::as_str));
            }
            Self::Kitten { model, voices, tokens } => files.extend([model.as_str(), voices.as_str(), tokens.as_str()]),
        }
        files
    }
}

/// A loaded voice and the Kokoro `lang` it was loaded with.
type LoadedVoice = (Option<String>, Arc<OfflineTts>);

/// The last voice loaded, keyed by its folder and `lang`.
static CACHE: Mutex<Option<(PathBuf, LoadedVoice)>> = Mutex::new(None);

/// Kokoro's `lang` for a speaker's language tag; `None` (Kokoro's own default) for Chinese,
/// Japanese and anything not listed.
pub(crate) fn kokoro_lang(language: &str) -> Option<&'static str> {
    match language {
        "en-US" => Some("en-us"),
        "en-GB" => Some("en-gb"),
        "es" => Some("es"),
        "fr" => Some("fr-fr"),
        "hi" => Some("hi"),
        "it" => Some("it"),
        "pt-BR" => Some("pt-br"),
        _ => None,
    }
}

/// `lang` only reaches Kokoro; Piper/VITS and Kitten ignore it.
pub(crate) fn tts_config(dir: &Path, layout: &TtsLayout, lang: Option<&str>) -> OfflineTtsConfig {
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let joined = |names: &[String]| {
        (!names.is_empty()).then(|| {
            names
                .iter()
                .map(|name| dir.join(name).to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(",")
        })
    };
    let mut model = OfflineTtsModelConfig { num_threads: 2, ..Default::default() };
    let mut rule_fsts = None;
    match layout {
        // The default noise and length scales are the ones Piper voices are tuned for.
        TtsLayout::Vits { model: file, tokens, lexicon, data_dir, dict_dir, rule_fsts: fsts } => {
            model.vits = OfflineTtsVitsModelConfig {
                model: path(file),
                tokens: path(tokens),
                lexicon: lexicon.as_deref().and_then(path),
                data_dir: if *data_dir { path("espeak-ng-data") } else { None },
                dict_dir: if *dict_dir { path("dict") } else { None },
                ..Default::default()
            };
            rule_fsts = joined(fsts);
        }
        TtsLayout::Kokoro { model: file, voices, tokens, lexicons, dict_dir, rule_fsts: fsts } => {
            model.kokoro = OfflineTtsKokoroModelConfig {
                model: path(file),
                voices: path(voices),
                tokens: path(tokens),
                data_dir: path("espeak-ng-data"),
                dict_dir: if *dict_dir { path("dict") } else { None },
                lexicon: joined(lexicons),
                lang: lang.map(str::to_string),
                ..Default::default()
            };
            rule_fsts = joined(fsts);
        }
        TtsLayout::Kitten { model: file, voices, tokens } => {
            model.kitten = OfflineTtsKittenModelConfig {
                model: path(file),
                voices: path(voices),
                tokens: path(tokens),
                data_dir: path("espeak-ng-data"),
                ..Default::default()
            };
        }
    }
    OfflineTtsConfig { model, rule_fsts, max_num_sentences: 1, ..Default::default() }
}

fn cached<'a, T>(
    slot: &'a Option<(PathBuf, (Option<String>, T))>,
    dir: &Path,
    lang: Option<&str>,
) -> Option<&'a T> {
    slot.as_ref()
        .filter(|(cached, (cached_lang, _))| cached == dir && cached_lang.as_deref() == lang)
        .map(|(_, (_, value))| value)
}

fn engine(dir: &Path, layout: &TtsLayout, lang: Option<&str>) -> Result<Arc<OfflineTts>, String> {
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tts) = cached(&slot, dir, lang) {
        return Ok(Arc::clone(tts));
    }
    let tts = Arc::new(
        OfflineTts::create(&tts_config(dir, layout, lang))
            .ok_or_else(|| "failed to load the voice model".to_string())?,
    );
    *slot = Some((
        dir.to_path_buf(),
        (lang.map(str::to_string), Arc::clone(&tts)),
    ));
    Ok(tts)
}

/// Clears `slot` when it caches `dir` (also used for the speech recognizer cache).
pub(crate) fn forget_in<T>(slot: &mut Option<(PathBuf, T)>, dir: &Path) {
    if slot.as_ref().is_some_and(|(cached, _)| cached == dir) {
        *slot = None;
    }
}

/// Drops the cached voice loaded from `dir`, so its files are closed before the folder is deleted
/// (Windows refuses to delete open files). An utterance already synthesizing keeps its own handle.
pub fn forget(dir: &Path) {
    forget_in(&mut CACHE.lock().unwrap_or_else(|e| e.into_inner()), dir);
}

/// Text sherpa can take: its C string conversion panics on an interior NUL.
fn speakable(text: &str) -> String {
    text.replace('\0', "")
}

fn speed(rate: f32) -> f32 {
    if rate.is_finite() {
        rate.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

/// A saved speaker the model does not have (another model, a removed voice) speaks as speaker 0.
fn speaker(sid: i32, available: i32) -> i32 {
    if sid >= 0 && sid < available { sid } else { 0 }
}

/// Speakers the model reports (1 for a single-voice model). Loads the voice; call on a worker.
pub fn num_speakers(dir: &Path, layout: &TtsLayout) -> Result<i32, String> {
    Ok(engine(dir, layout, None)?.num_speakers())
}

/// Samples and their rate. Blocks for the length of the synthesis; call on a worker thread.
pub fn synthesize(
    dir: &Path,
    layout: &TtsLayout,
    text: &str,
    rate: f32,
    sid: i32,
    lang: Option<&str>,
) -> Result<(Vec<f32>, u32), String> {
    let tts = engine(dir, layout, lang)?;
    let config = GenerationConfig {
        speed: speed(rate),
        sid: speaker(sid, tts.num_speakers()),
        ..Default::default()
    };
    let audio = tts
        .generate_with_config(&speakable(text), &config, None::<fn(&[f32], f32) -> bool>)
        .ok_or_else(|| "voice synthesis failed".to_string())?;
    let sample_rate = u32::try_from(audio.sample_rate())
        .ok()
        .filter(|rate| *rate > 0)
        .ok_or_else(|| "voice synthesis reported no sample rate".to_string())?;
    Ok((audio.samples().to_vec(), sample_rate))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{
        cached, forget_in, kokoro_lang, speakable, speaker, speed, synthesize, tts_config,
        TtsLayout,
    };

    #[test]
    fn forgetting_a_voice_drops_only_that_cached_dir() {
        let mut slot = Some((PathBuf::from("/voices/a"), ()));
        forget_in(&mut slot, Path::new("/voices/b"));
        assert!(slot.is_some(), "another voice stays cached");
        forget_in(&mut slot, Path::new("/voices/a"));
        assert!(slot.is_none());
    }

    #[test]
    fn the_rate_is_clamped_to_what_piper_handles() {
        assert_eq!(speed(1.0), 1.0);
        assert_eq!(speed(0.1), 0.5);
        assert_eq!(speed(5.0), 2.0);
        assert_eq!(speed(f32::NAN), 1.0);
    }

    #[test]
    fn interior_nuls_are_dropped_before_synthesis() {
        assert_eq!(speakable("a\0b"), "ab");
    }

    #[test]
    fn a_missing_voice_is_an_error_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("alethe-no-voice-{}", std::process::id()));
        assert!(synthesize(&dir, &TtsLayout::piper("missing.onnx"), "oi", 1.0, 0, None).is_err());
    }

    #[test]
    fn out_of_range_speaker_falls_back_to_zero() {
        assert_eq!(speaker(3, 8), 3);
        assert_eq!(speaker(8, 8), 0);
        assert_eq!(speaker(-1, 8), 0);
        assert_eq!(speaker(2, 0), 0, "a model reporting no speakers uses speaker 0");
    }

    #[test]
    fn piper_reads_its_model_tokens_and_espeak_data() {
        let config = tts_config(
            Path::new("/v"),
            &TtsLayout::piper("pt_BR-faber-medium.onnx"),
            None,
        );
        let vits = &config.model.vits;
        assert!(vits.model.as_deref().unwrap().ends_with("pt_BR-faber-medium.onnx"));
        assert!(vits.tokens.as_deref().unwrap().ends_with("tokens.txt"));
        assert!(vits.data_dir.as_deref().unwrap().ends_with("espeak-ng-data"));
        assert!(vits.lexicon.is_none() && vits.dict_dir.is_none() && config.rule_fsts.is_none());
    }

    #[test]
    fn kokoro_joins_lexicons_and_rule_fsts_in_order() {
        let layout = TtsLayout::Kokoro {
            model: "model.onnx".into(),
            voices: "voices.bin".into(),
            tokens: "tokens.txt".into(),
            lexicons: vec!["lexicon-us-en.txt".into(), "lexicon-zh.txt".into()],
            dict_dir: true,
            rule_fsts: vec!["phone-zh.fst".into(), "date-zh.fst".into()],
        };
        let config = tts_config(Path::new("/k"), &layout, None);
        let kokoro = &config.model.kokoro;
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            kokoro.lexicon.as_deref(),
            Some(format!("/k{sep}lexicon-us-en.txt,/k{sep}lexicon-zh.txt").as_str())
        );
        assert!(kokoro.voices.as_deref().unwrap().ends_with("voices.bin"));
        assert!(kokoro.dict_dir.as_deref().unwrap().ends_with("dict"));
        assert_eq!(
            config.rule_fsts.as_deref(),
            Some(format!("/k{sep}phone-zh.fst,/k{sep}date-zh.fst").as_str())
        );
    }

    #[test]
    fn kokoro_speaker_languages_map_to_kokoro_lang_codes() {
        for (language, lang) in [
            ("en-US", Some("en-us")),
            ("en-GB", Some("en-gb")),
            ("es", Some("es")),
            ("fr", Some("fr-fr")),
            ("hi", Some("hi")),
            ("it", Some("it")),
            ("pt-BR", Some("pt-br")),
            ("zh", None),
            ("ja", None),
            ("", None),
            ("de", None),
        ] {
            assert_eq!(kokoro_lang(language), lang, "{language}");
        }
    }

    #[test]
    fn kokoro_gets_the_lang_and_other_families_ignore_it() {
        let kokoro = TtsLayout::Kokoro {
            model: "model.onnx".into(),
            voices: "voices.bin".into(),
            tokens: "tokens.txt".into(),
            lexicons: Vec::new(),
            dict_dir: false,
            rule_fsts: Vec::new(),
        };
        let config = tts_config(Path::new("/k"), &kokoro, Some("pt-br"));
        assert_eq!(config.model.kokoro.lang.as_deref(), Some("pt-br"));
        assert!(tts_config(Path::new("/k"), &kokoro, None)
            .model
            .kokoro
            .lang
            .is_none());
        let piper = tts_config(Path::new("/v"), &TtsLayout::piper("a.onnx"), Some("pt-br"));
        assert!(piper.model.kokoro.lang.is_none());
    }

    #[test]
    fn the_cached_engine_matches_its_dir_and_lang() {
        let slot = Some((PathBuf::from("/k"), (Some("pt-br".to_string()), 7)));
        assert_eq!(cached(&slot, Path::new("/k"), Some("pt-br")), Some(&7));
        assert_eq!(cached(&slot, Path::new("/k"), Some("es")), None);
        assert_eq!(cached(&slot, Path::new("/k"), None), None);
        assert_eq!(cached(&slot, Path::new("/v"), Some("pt-br")), None);
        let mut slot = slot;
        forget_in(&mut slot, Path::new("/k"));
        assert!(
            slot.is_none(),
            "forgetting a dir drops it whatever its lang"
        );
    }

    #[test]
    fn tts_layouts_round_trip_through_json() {
        let layout = TtsLayout::Kitten { model: "model.fp16.onnx".into(), voices: "voices.bin".into(), tokens: "tokens.txt".into() };
        let json = serde_json::to_string(&layout).unwrap();
        assert!(json.starts_with(r#"{"kind":"kitten""#), "{json}");
        assert_eq!(serde_json::from_str::<TtsLayout>(&json).unwrap(), layout);
    }
}
