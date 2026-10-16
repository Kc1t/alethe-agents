//! Which sherpa-onnx family a Hugging Face repo holds, and which of its files that family needs.
//! Pure: works on a repo name and its file list, so it is tested without the network.

use serde::{Deserialize, Serialize};

use crate::speech_layout::SttLayout;
use crate::tts_local::TtsLayout;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Family {
    Vits,
    Kokoro,
    Kitten,
    Transducer,
    NemoTransducer,
    Whisper,
    Moonshine,
    SenseVoice,
    Paraformer,
    NemoCtc,
    Dolphin,
}

impl Family {
    pub fn is_tts(self) -> bool {
        matches!(self, Self::Vits | Self::Kokoro | Self::Kitten)
    }

    /// `tts` or `stt`, the `capability` the frontend already reads.
    pub fn use_name(self) -> &'static str {
        if self.is_tts() {
            "tts"
        } else {
            "stt"
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    /// Relative to the repo root, `/`-separated.
    pub path: String,
    pub size: u64,
    /// SHA-256 of a file stored in LFS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Git blob SHA-1 of a file stored in the repo itself (never set for LFS files).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_sha1: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HubLayout {
    Stt(SttLayout),
    Tts(TtsLayout),
}

impl HubLayout {
    pub fn files(&self) -> Vec<&str> {
        match self {
            Self::Stt(layout) => layout.files(),
            Self::Tts(layout) => layout.files(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub family: Family,
    pub layout: HubLayout,
    /// Only the files the family needs, in download order.
    pub files: Vec<RepoFile>,
}

/// Words marking a repo as something other than an offline recognizer or a voice we support.
const EXCLUDED: &[&str] = &[
    "streaming",
    "online",
    "apk",
    "wheel",
    "tagging",
    "diariz",
    "denois",
    "punct",
    "speaker",
    "kws",
    "keyword",
    "vad",
    "spleeter",
    "matcha",
    "canary",
];

/// Matched as a whole word of the repo name, so `latest` stays in.
const EXCLUDED_WORDS: &[&str] = &["test", "tests"];

pub fn family_of(repo_name: &str) -> Option<Family> {
    let name = repo_name.to_ascii_lowercase();
    if EXCLUDED.iter().any(|word| name.contains(word))
        || name
            .split(['-', '_', '.'])
            .any(|word| EXCLUDED_WORDS.contains(&word))
    {
        return None;
    }
    let family = if name.starts_with("vits-") {
        Family::Vits
    } else if name.starts_with("kokoro-") {
        Family::Kokoro
    } else if name.starts_with("kitten-") {
        Family::Kitten
    } else if name.contains("whisper") {
        Family::Whisper
    } else if name.contains("moonshine") {
        Family::Moonshine
    } else if name.contains("sense-voice") {
        Family::SenseVoice
    } else if name.contains("paraformer") {
        Family::Paraformer
    } else if name.contains("dolphin") {
        Family::Dolphin
    } else if name.contains("ctc") {
        // Zipformer, Wenet and other CTC models are not wired up.
        if name.contains("nemo") || name.contains("parakeet") {
            Family::NemoCtc
        } else {
            return None;
        }
    } else if name.contains("parakeet") || name.contains("nemo") {
        Family::NemoTransducer
    } else if name.contains("zipformer")
        || name.contains("conformer")
        || name.contains("transducer")
    {
        Family::Transducer
    } else {
        return None;
    };
    Some(family)
}

/// Relative, `/`-separated, at most 8 segments of `[A-Za-z0-9._+!-]`; never `.` or `..`, a name
/// ending in `.` or a Windows device name (`con`, `nul.txt`, `com1`…).
pub fn safe_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    !path.is_empty()
        && segments.len() <= 8
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && !segment.ends_with(['.', ' '])
                && !windows_reserved(segment)
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | '!'))
        })
}

/// Device names Windows will not create a file under, with or without an extension.
fn windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix)
            .is_some_and(|n| matches!(n.as_bytes(), [b'1'..=b'9']))
    };
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

/// int8 first, then unmarked, then fp16/fp32 variants.
fn precision_rank(path: &str) -> u8 {
    let lower = path.to_ascii_lowercase();
    if lower.contains(".int8.") || lower.contains("-int8") {
        0
    } else if lower.contains("fp16") || lower.contains("fp32") {
        2
    } else {
        1
    }
}

fn top_level(files: &[RepoFile]) -> impl Iterator<Item = &RepoFile> {
    files.iter().filter(|file| !file.path.contains('/'))
}

fn named<'a>(files: &'a [RepoFile], name: &str) -> Option<&'a RepoFile> {
    files.iter().find(|file| file.path == name)
}

/// Rule FSTs in the order sherpa's examples pass them: phone, date, number, then the rest.
fn fst_rank(path: &str) -> u8 {
    if path.starts_with("phone") {
        0
    } else if path.starts_with("date") {
        1
    } else if path.starts_with("number") {
        2
    } else {
        3
    }
}

#[derive(Default)]
struct Pick {
    files: Vec<RepoFile>,
}

impl Pick {
    fn add(&mut self, file: &RepoFile) -> String {
        if !self.files.iter().any(|f| f.path == file.path) {
            self.files.push(file.clone());
        }
        file.path.clone()
    }

    /// The best `.onnx` at the top level whose name starts with `prefix`, plus its external
    /// `.weights` when it has one.
    fn model(&mut self, files: &[RepoFile], prefix: &str) -> Option<String> {
        let best = top_level(files)
            .filter(|f| f.path.starts_with(prefix) && f.path.ends_with(".onnx"))
            .min_by_key(|f| (precision_rank(&f.path), f.path.len()))?;
        if !safe_path(&best.path) {
            return None;
        }
        let path = self.add(best);
        if let Some(weights) = path
            .strip_suffix(".onnx")
            .and_then(|stem| named(files, &format!("{stem}.weights")))
        {
            self.add(weights);
        }
        Some(path)
    }

    fn required(&mut self, files: &[RepoFile], name: &str) -> Option<String> {
        named(files, name)
            .filter(|f| safe_path(&f.path))
            .map(|f| self.add(f))
    }

    /// Every safe file under `dir/`; `false` when there is none. Unsafe names (a space in an
    /// espeak voice variant) are optional data and are skipped.
    fn dir(&mut self, files: &[RepoFile], dir: &str) -> bool {
        let prefix = format!("{dir}/");
        let mut any = false;
        for file in files
            .iter()
            .filter(|f| f.path.starts_with(&prefix) && safe_path(&f.path))
        {
            self.add(file);
            any = true;
        }
        any
    }

    fn rule_fsts(&mut self, files: &[RepoFile]) -> Vec<String> {
        let mut fsts: Vec<&RepoFile> = top_level(files)
            .filter(|f| f.path.ends_with(".fst") && safe_path(&f.path))
            .collect();
        fsts.sort_by(|a, b| (fst_rank(&a.path), &a.path).cmp(&(fst_rank(&b.path), &b.path)));
        fsts.into_iter().map(|f| self.add(f)).collect()
    }
}

/// The family and the exact files to download, or `None` when the repo does not match a family
/// we can run.
pub fn plan(repo_name: &str, files: &[RepoFile]) -> Option<Planned> {
    let family = family_of(repo_name)?;
    let mut pick = Pick::default();
    let layout = match family {
        Family::Vits => {
            let model = pick.model(files, "")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if let Some(config) = named(files, &format!("{model}.json")) {
                pick.add(config);
            }
            let lexicon = pick.required(files, "lexicon.txt");
            let data_dir = pick.dir(files, "espeak-ng-data");
            if lexicon.is_none() && !data_dir {
                return None;
            }
            let dict_dir = pick.dir(files, "dict");
            let rule_fsts = pick.rule_fsts(files);
            HubLayout::Tts(TtsLayout::Vits {
                model,
                tokens,
                lexicon,
                data_dir,
                dict_dir,
                rule_fsts,
            })
        }
        Family::Kokoro => {
            let model = pick.model(files, "model")?;
            let voices = pick.required(files, "voices.bin")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if !pick.dir(files, "espeak-ng-data") {
                return None;
            }
            let has_us = named(files, "lexicon-us-en.txt").is_some();
            let mut lexicon_files: Vec<&RepoFile> = top_level(files)
                .filter(|f| {
                    f.path.starts_with("lexicon-") && f.path.ends_with(".txt") && safe_path(&f.path)
                })
                .filter(|f| !(has_us && f.path == "lexicon-gb-en.txt"))
                .collect();
            lexicon_files.sort_by(|a, b| a.path.cmp(&b.path));
            let lexicons = lexicon_files.into_iter().map(|f| pick.add(f)).collect();
            let dict_dir = pick.dir(files, "dict");
            let rule_fsts = pick.rule_fsts(files);
            HubLayout::Tts(TtsLayout::Kokoro {
                model,
                voices,
                tokens,
                lexicons,
                dict_dir,
                rule_fsts,
            })
        }
        Family::Kitten => {
            let model = pick.model(files, "model")?;
            let voices = pick.required(files, "voices.bin")?;
            let tokens = pick.required(files, "tokens.txt")?;
            if !pick.dir(files, "espeak-ng-data") {
                return None;
            }
            HubLayout::Tts(TtsLayout::Kitten {
                model,
                voices,
                tokens,
            })
        }
        Family::Transducer | Family::NemoTransducer => {
            let encoder = pick.model(files, "encoder")?;
            let decoder = pick.model(files, "decoder")?;
            let joiner = pick.model(files, "joiner")?;
            let tokens = pick.required(files, "tokens.txt")?;
            let model_type = if family == Family::NemoTransducer {
                "nemo_transducer"
            } else {
                "transducer"
            };
            HubLayout::Stt(SttLayout::Transducer {
                model_type: model_type.into(),
                encoder,
                decoder,
                joiner,
                tokens,
            })
        }
        Family::Whisper => {
            let first = top_level(files)
                .filter(|f| f.path.ends_with(".onnx") && f.path.contains("-encoder"))
                .min_by_key(|f| (precision_rank(&f.path), f.path.len()))?;
            let prefix = first.path.split("-encoder").next()?.to_string();
            let encoder = pick.model(files, &format!("{prefix}-encoder"))?;
            let decoder = pick.model(files, &format!("{prefix}-decoder"))?;
            let tokens = pick.required(files, &format!("{prefix}-tokens.txt"))?;
            HubLayout::Stt(SttLayout::Whisper {
                encoder,
                decoder,
                tokens,
            })
        }
        Family::Moonshine => {
            let preprocessor = pick.model(files, "preprocess")?;
            let encoder = pick.model(files, "encode")?;
            let uncached_decoder = pick.model(files, "uncached_decode")?;
            let cached_decoder = pick.model(files, "cached_decode")?;
            let tokens = pick.required(files, "tokens.txt")?;
            HubLayout::Stt(SttLayout::Moonshine {
                preprocessor,
                encoder,
                uncached_decoder,
                cached_decoder,
                tokens,
            })
        }
        Family::SenseVoice | Family::Paraformer | Family::NemoCtc | Family::Dolphin => {
            let model = pick.model(files, "model")?;
            let tokens = pick.required(files, "tokens.txt")?;
            HubLayout::Stt(match family {
                Family::SenseVoice => SttLayout::SenseVoice { model, tokens },
                Family::Paraformer => SttLayout::Paraformer { model, tokens },
                Family::NemoCtc => SttLayout::NemoCtc { model, tokens },
                _ => SttLayout::Dolphin { model, tokens },
            })
        }
    };
    Some(Planned {
        family,
        layout,
        files: pick.files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech_layout::SttLayout;
    use crate::tts_local::TtsLayout;

    fn files(paths: &[&str]) -> Vec<RepoFile> {
        paths
            .iter()
            .map(|path| RepoFile {
                path: (*path).into(),
                size: 1,
                sha256: None,
                git_sha1: Some("0".repeat(40)),
            })
            .collect()
    }

    fn paths(planned: &Planned) -> Vec<&str> {
        planned.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn family_comes_from_the_repo_name() {
        let cases = [
            ("vits-piper-pt_BR-faber-medium", Some(Family::Vits)),
            ("vits-melo-tts-zh_en", Some(Family::Vits)),
            ("kokoro-multi-lang-v1_0", Some(Family::Kokoro)),
            ("kitten-nano-en-v0_2-fp16", Some(Family::Kitten)),
            ("sherpa-onnx-whisper-turbo", Some(Family::Whisper)),
            (
                "sherpa-onnx-moonshine-base-en-int8",
                Some(Family::Moonshine),
            ),
            (
                "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
                Some(Family::SenseVoice),
            ),
            (
                "sherpa-onnx-paraformer-zh-2023-09-14",
                Some(Family::Paraformer),
            ),
            (
                "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
                Some(Family::Dolphin),
            ),
            (
                "sherpa-onnx-nemo-ctc-en-conformer-small",
                Some(Family::NemoCtc),
            ),
            (
                "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
                Some(Family::NemoTransducer),
            ),
            (
                "sherpa-onnx-zipformer-small-en-2023-06-26",
                Some(Family::Transducer),
            ),
            ("sherpa-onnx-streaming-zipformer-en-2023-06-26", None),
            ("matcha-icefall-en_US-ljspeech", None),
            ("sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8", None),
            ("sherpa-onnx-zipformer-ctc-small-2024-10-07", None),
            ("sherpa-onnx-apk", None),
            ("icefall-asr-librispeech", None),
        ];
        for (name, expected) in cases {
            assert_eq!(family_of(name), expected, "{name}");
        }
    }

    #[test]
    fn piper_takes_model_config_tokens_and_espeak_data_only() {
        let repo = files(&[
            ".gitattributes",
            "MODEL_CARD",
            "pt_BR-faber-medium.onnx",
            "pt_BR-faber-medium.onnx.json",
            "tokens.txt",
            "vits-piper.py",
            "espeak-ng-data/pt_dict",
            "espeak-ng-data/lang/roa/pt-BR",
            "espeak-ng-data/voices/!v/Alex",
        ]);
        let planned = plan("vits-piper-pt_BR-faber-medium", &repo).unwrap();
        assert_eq!(planned.family, Family::Vits);
        assert_eq!(
            paths(&planned),
            vec![
                "pt_BR-faber-medium.onnx",
                "tokens.txt",
                "pt_BR-faber-medium.onnx.json",
                "espeak-ng-data/pt_dict",
                "espeak-ng-data/lang/roa/pt-BR",
                "espeak-ng-data/voices/!v/Alex",
            ]
        );
        assert_eq!(
            planned.layout,
            HubLayout::Tts(TtsLayout::piper("pt_BR-faber-medium.onnx"))
        );
    }

    #[test]
    fn unsafe_optional_files_are_skipped() {
        let repo = files(&[
            "a.onnx",
            "tokens.txt",
            "espeak-ng-data/en_dict",
            "espeak-ng-data/voices/!v/Mr serious",
            "espeak-ng-data/../x",
        ]);
        let planned = plan("vits-piper-en_US-a-low", &repo).unwrap();
        assert_eq!(
            paths(&planned),
            vec!["a.onnx", "tokens.txt", "espeak-ng-data/en_dict"]
        );
    }

    #[test]
    fn unsafe_required_file_rejects_the_repo() {
        let repo = files(&["a b.onnx", "tokens.txt", "espeak-ng-data/en_dict"]);
        assert_eq!(plan("vits-piper-en_US-a-low", &repo), None);
    }

    #[test]
    fn vits_without_espeak_needs_a_lexicon() {
        assert_eq!(
            plan("vits-zh-aishell3", &files(&["model.onnx", "tokens.txt"])),
            None
        );
        let planned = plan(
            "vits-melo-tts-zh_en",
            &files(&[
                "model.int8.onnx",
                "model.onnx",
                "tokens.txt",
                "lexicon.txt",
                "date.fst",
                "phone.fst",
                "number.fst",
                "new_heteronym.fst",
            ]),
        )
        .unwrap();
        let HubLayout::Tts(TtsLayout::Vits {
            model,
            lexicon,
            data_dir,
            rule_fsts,
            ..
        }) = planned.layout
        else {
            panic!("vits")
        };
        assert_eq!(model, "model.int8.onnx");
        assert_eq!(lexicon.as_deref(), Some("lexicon.txt"));
        assert!(!data_dir);
        assert_eq!(
            rule_fsts,
            vec!["phone.fst", "date.fst", "number.fst", "new_heteronym.fst"]
        );
    }

    #[test]
    fn kokoro_takes_us_english_and_chinese_lexicons_dict_and_fsts() {
        let repo = files(&[
            "LICENSE",
            "README.md",
            "model.onnx",
            "voices.bin",
            "tokens.txt",
            "lexicon-gb-en.txt",
            "lexicon-us-en.txt",
            "lexicon-zh.txt",
            "date-zh.fst",
            "number-zh.fst",
            "phone-zh.fst",
            "dict/jieba.dict.utf8",
            "espeak-ng-data/en_dict",
        ]);
        let planned = plan("kokoro-multi-lang-v1_0", &repo).unwrap();
        let HubLayout::Tts(TtsLayout::Kokoro {
            lexicons,
            dict_dir,
            rule_fsts,
            ..
        }) = &planned.layout
        else {
            panic!("kokoro")
        };
        assert_eq!(
            lexicons,
            &vec![
                "lexicon-us-en.txt".to_string(),
                "lexicon-zh.txt".to_string()
            ]
        );
        assert!(dict_dir);
        assert_eq!(
            rule_fsts,
            &vec![
                "phone-zh.fst".to_string(),
                "date-zh.fst".to_string(),
                "number-zh.fst".to_string()
            ]
        );
        assert!(!paths(&planned).contains(&"lexicon-gb-en.txt"));
        assert!(!paths(&planned).contains(&"LICENSE"));
    }

    #[test]
    fn kokoro_without_voices_is_rejected() {
        assert_eq!(
            plan(
                "kokoro-en-v0_19",
                &files(&["model.onnx", "tokens.txt", "espeak-ng-data/en_dict"])
            ),
            None
        );
    }

    #[test]
    fn kitten_uses_its_fp16_model() {
        let planned = plan(
            "kitten-nano-en-v0_2-fp16",
            &files(&[
                "model.fp16.onnx",
                "voices.bin",
                "tokens.txt",
                "espeak-ng-data/en_dict",
            ]),
        )
        .unwrap();
        assert_eq!(
            planned.layout,
            HubLayout::Tts(TtsLayout::Kitten {
                model: "model.fp16.onnx".into(),
                voices: "voices.bin".into(),
                tokens: "tokens.txt".into()
            })
        );
    }

    #[test]
    fn whisper_prefers_int8_and_skips_full_precision_weights() {
        let repo = files(&[
            "turbo-decoder.int8.onnx",
            "turbo-decoder.onnx",
            "turbo-encoder.int8.onnx",
            "turbo-encoder.onnx",
            "turbo-encoder.weights",
            "turbo-tokens.txt",
            "test_wavs/0.wav",
        ]);
        let planned = plan("sherpa-onnx-whisper-turbo", &repo).unwrap();
        assert_eq!(
            paths(&planned),
            vec![
                "turbo-encoder.int8.onnx",
                "turbo-decoder.int8.onnx",
                "turbo-tokens.txt"
            ]
        );
        assert_eq!(
            planned.layout,
            HubLayout::Stt(SttLayout::Whisper {
                encoder: "turbo-encoder.int8.onnx".into(),
                decoder: "turbo-decoder.int8.onnx".into(),
                tokens: "turbo-tokens.txt".into()
            })
        );
    }

    #[test]
    fn full_precision_only_brings_its_external_weights() {
        let repo = files(&[
            "large-v3-encoder.onnx",
            "large-v3-encoder.weights",
            "large-v3-decoder.onnx",
            "large-v3-tokens.txt",
        ]);
        let planned = plan("sherpa-onnx-whisper-large-v3", &repo).unwrap();
        assert_eq!(
            paths(&planned),
            vec![
                "large-v3-encoder.onnx",
                "large-v3-encoder.weights",
                "large-v3-decoder.onnx",
                "large-v3-tokens.txt"
            ]
        );
    }

    #[test]
    fn transducers_keep_their_epoch_file_names() {
        let repo = files(&[
            "decoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "encoder-epoch-99-avg-1.int8.onnx",
            "encoder-epoch-99-avg-1.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "tokens.txt",
            "README.md",
        ]);
        let planned = plan("sherpa-onnx-zipformer-small-en-2023-06-26", &repo).unwrap();
        let HubLayout::Stt(SttLayout::Transducer {
            model_type,
            encoder,
            joiner,
            ..
        }) = planned.layout
        else {
            panic!("transducer")
        };
        assert_eq!(model_type, "transducer");
        assert_eq!(encoder, "encoder-epoch-99-avg-1.int8.onnx");
        assert_eq!(joiner, "joiner-epoch-99-avg-1.int8.onnx");
        let parakeet = plan(
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
            &files(&[
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt",
            ]),
        )
        .unwrap();
        let HubLayout::Stt(SttLayout::Transducer { model_type, .. }) = parakeet.layout else {
            panic!("transducer")
        };
        assert_eq!(model_type, "nemo_transducer");
    }

    #[test]
    fn single_model_recognizers_take_model_and_tokens() {
        let repo = files(&[
            "LICENSE",
            "model.int8.onnx",
            "model.onnx",
            "tokens.txt",
            "test_wavs/en.wav",
        ]);
        for (name, expected) in [
            (
                "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
                SttLayout::SenseVoice {
                    model: "model.int8.onnx".into(),
                    tokens: "tokens.txt".into(),
                },
            ),
            (
                "sherpa-onnx-paraformer-zh-2023-09-14",
                SttLayout::Paraformer {
                    model: "model.int8.onnx".into(),
                    tokens: "tokens.txt".into(),
                },
            ),
            (
                "sherpa-onnx-nemo-ctc-en-conformer-small",
                SttLayout::NemoCtc {
                    model: "model.int8.onnx".into(),
                    tokens: "tokens.txt".into(),
                },
            ),
            (
                "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
                SttLayout::Dolphin {
                    model: "model.int8.onnx".into(),
                    tokens: "tokens.txt".into(),
                },
            ),
        ] {
            let planned = plan(name, &repo).unwrap();
            assert_eq!(planned.layout, HubLayout::Stt(expected), "{name}");
            assert_eq!(
                paths(&planned),
                vec!["model.int8.onnx", "tokens.txt"],
                "{name}"
            );
        }
    }

    #[test]
    fn moonshine_needs_its_four_parts() {
        let all = [
            "preprocess.onnx",
            "encode.int8.onnx",
            "uncached_decode.int8.onnx",
            "cached_decode.int8.onnx",
            "tokens.txt",
        ];
        let planned = plan("sherpa-onnx-moonshine-base-en-int8", &files(&all)).unwrap();
        let HubLayout::Stt(SttLayout::Moonshine {
            cached_decoder,
            uncached_decoder,
            ..
        }) = planned.layout
        else {
            panic!("moonshine")
        };
        assert_eq!(cached_decoder, "cached_decode.int8.onnx");
        assert_eq!(uncached_decoder, "uncached_decode.int8.onnx");
        assert_eq!(
            plan(
                "sherpa-onnx-moonshine-base-en-int8",
                &files(&[
                    "preprocess.onnx",
                    "encode.int8.onnx",
                    "merged_decode.onnx",
                    "tokens.txt"
                ])
            ),
            None
        );
    }

    #[test]
    fn safe_paths_are_plain_relative_segments() {
        assert!(safe_path("espeak-ng-data/voices/!v/Alex"));
        assert!(safe_path("tokens.txt"));
        for bad in [
            "",
            "/etc/passwd",
            "a/../b",
            "./a",
            "a//b",
            "a\\b",
            "a b",
            "C:x",
            "a/b/c/d/e/f/g/h/i",
            "con",
            "NUL.txt",
            "a/com1.bin",
            "Lpt9",
            "aux.tar.gz",
            "x.",
            "dir./a",
        ] {
            assert!(!safe_path(bad), "{bad}");
        }
        for good in ["console.txt", "com10.bin", "lpt0", "auxiliary/nul-x", "a.b"] {
            assert!(safe_path(good), "{good}");
        }
    }

    #[test]
    fn test_is_excluded_as_a_word_only() {
        assert_eq!(
            family_of("sherpa-onnx-whisper-large-v3-latest"),
            Some(Family::Whisper)
        );
        assert_eq!(family_of("sherpa-onnx-whisper-test"), None);
        assert_eq!(family_of("vits-piper-en_US-test_voice"), None);
        assert_eq!(family_of("sherpa-onnx-whisper-tiny.test"), None);
    }
}
