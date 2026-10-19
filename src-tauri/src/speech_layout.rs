//! Which files a local recognizer reads and how sherpa-onnx is configured for them. Shared by
//! the built-in catalog and models downloaded from Hugging Face.

use std::path::Path;

use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    OfflineDolphinModelConfig, OfflineMoonshineModelConfig, OfflineNemoEncDecCtcModelConfig,
    OfflineParaformerModelConfig, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};

/// File names are relative to the model folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SttLayout {
    Transducer {
        model_type: String,
        encoder: String,
        decoder: String,
        joiner: String,
        tokens: String,
    },
    Whisper {
        encoder: String,
        decoder: String,
        tokens: String,
    },
    Moonshine {
        preprocessor: String,
        encoder: String,
        uncached_decoder: String,
        cached_decoder: String,
        tokens: String,
    },
    SenseVoice {
        model: String,
        tokens: String,
    },
    Paraformer {
        model: String,
        tokens: String,
    },
    NemoCtc {
        model: String,
        tokens: String,
    },
    Dolphin {
        model: String,
        tokens: String,
    },
}

impl SttLayout {
    /// Whisper decodes 28-second windows; the others take the whole utterance.
    pub fn is_whisper(&self) -> bool {
        matches!(self, Self::Whisper { .. })
    }

    /// Every file the recognizer opens.
    pub fn files(&self) -> Vec<&str> {
        match self {
            Self::Transducer {
                encoder,
                decoder,
                joiner,
                tokens,
                ..
            } => vec![encoder, decoder, joiner, tokens],
            Self::Whisper {
                encoder,
                decoder,
                tokens,
            } => vec![encoder, decoder, tokens],
            Self::Moonshine {
                preprocessor,
                encoder,
                uncached_decoder,
                cached_decoder,
                tokens,
            } => {
                vec![
                    preprocessor,
                    encoder,
                    uncached_decoder,
                    cached_decoder,
                    tokens,
                ]
            }
            Self::SenseVoice { model, tokens }
            | Self::Paraformer { model, tokens }
            | Self::NemoCtc { model, tokens }
            | Self::Dolphin { model, tokens } => vec![model, tokens],
        }
        .into_iter()
        .map(String::as_str)
        .collect()
    }
}

/// The recognizer config for `layout`; fails when a file it names is missing.
pub fn recognizer_config(
    dir: &Path,
    layout: &SttLayout,
    threads: i32,
    sample_rate: i32,
) -> Result<OfflineRecognizerConfig, String> {
    let path = |name: &str| -> Result<String, String> {
        let full = dir.join(name);
        if !full.is_file() {
            return Err(format!("missing model file: {}", full.display()));
        }
        Ok(full.to_string_lossy().into_owned())
    };
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = threads;
    config.feat_config.sample_rate = sample_rate;
    let tokens = match layout {
        SttLayout::Transducer {
            model_type,
            encoder,
            decoder,
            joiner,
            tokens,
        } => {
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                joiner: Some(path(joiner)?),
            };
            config.model_config.model_type = Some(model_type.clone());
            tokens
        }
        SttLayout::Whisper {
            encoder,
            decoder,
            tokens,
        } => {
            config.model_config.whisper = OfflineWhisperModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                // Empty language = detect it per utterance.
                language: Some(String::new()),
                task: Some("transcribe".into()),
                tail_paddings: -1,
                ..Default::default()
            };
            tokens
        }
        SttLayout::Moonshine {
            preprocessor,
            encoder,
            uncached_decoder,
            cached_decoder,
            tokens,
        } => {
            config.model_config.moonshine = OfflineMoonshineModelConfig {
                preprocessor: Some(path(preprocessor)?),
                encoder: Some(path(encoder)?),
                uncached_decoder: Some(path(uncached_decoder)?),
                cached_decoder: Some(path(cached_decoder)?),
                merged_decoder: None,
            };
            tokens
        }
        SttLayout::SenseVoice { model, tokens } => {
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: Some(path(model)?),
                language: Some("auto".into()),
                use_itn: true,
            };
            tokens
        }
        SttLayout::Paraformer { model, tokens } => {
            config.model_config.paraformer = OfflineParaformerModelConfig {
                model: Some(path(model)?),
            };
            tokens
        }
        SttLayout::NemoCtc { model, tokens } => {
            config.model_config.nemo_ctc = OfflineNemoEncDecCtcModelConfig {
                model: Some(path(model)?),
            };
            tokens
        }
        SttLayout::Dolphin { model, tokens } => {
            config.model_config.dolphin = OfflineDolphinModelConfig {
                model: Some(path(model)?),
            };
            tokens
        }
    };
    config.model_config.tokens = Some(path(tokens)?);
    Ok(config)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{recognizer_config, SttLayout};

    fn dir_with(files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "alethe-layout-{}-{}",
            std::process::id(),
            files.join("_").replace(['.', '/'], "")
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for file in files {
            fs::write(dir.join(file), b"x").unwrap();
        }
        dir
    }

    #[test]
    fn sense_voice_detects_the_language_and_adds_punctuation() {
        let dir = dir_with(&["model.int8.onnx", "tokens.txt"]);
        let layout = SttLayout::SenseVoice {
            model: "model.int8.onnx".into(),
            tokens: "tokens.txt".into(),
        };
        let config = recognizer_config(&dir, &layout, 2, 16_000).unwrap();
        assert!(config
            .model_config
            .sense_voice
            .model
            .unwrap()
            .ends_with("model.int8.onnx"));
        assert_eq!(
            config.model_config.sense_voice.language.as_deref(),
            Some("auto")
        );
        assert!(config.model_config.sense_voice.use_itn);
        assert!(config.model_config.tokens.unwrap().ends_with("tokens.txt"));
    }

    #[test]
    fn transducer_uses_the_named_files_and_model_type() {
        let names = [
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "tokens.txt",
        ];
        let dir = dir_with(&names);
        let layout = SttLayout::Transducer {
            model_type: "transducer".into(),
            encoder: names[0].into(),
            decoder: names[1].into(),
            joiner: names[2].into(),
            tokens: names[3].into(),
        };
        let config = recognizer_config(&dir, &layout, 2, 16_000).unwrap();
        assert!(config
            .model_config
            .transducer
            .encoder
            .unwrap()
            .ends_with(names[0]));
        assert_eq!(
            config.model_config.model_type.as_deref(),
            Some("transducer")
        );
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let dir = dir_with(&["tokens.txt"]);
        let layout = SttLayout::Paraformer {
            model: "model.int8.onnx".into(),
            tokens: "tokens.txt".into(),
        };
        assert!(recognizer_config(&dir, &layout, 2, 16_000)
            .unwrap_err()
            .contains("missing model file"));
    }

    #[test]
    fn whisper_is_flagged_for_windowed_decoding() {
        let layout = SttLayout::Whisper {
            encoder: "a".into(),
            decoder: "b".into(),
            tokens: "c".into(),
        };
        assert!(layout.is_whisper());
        assert_eq!(layout.files(), vec!["a", "b", "c"]);
    }

    #[test]
    fn layouts_round_trip_through_json() {
        let layout = SttLayout::NemoCtc {
            model: "model.int8.onnx".into(),
            tokens: "tokens.txt".into(),
        };
        let json = serde_json::to_string(&layout).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"nemo-ctc","model":"model.int8.onnx","tokens":"tokens.txt"}"#
        );
        assert_eq!(serde_json::from_str::<SttLayout>(&json).unwrap(), layout);
    }
}
