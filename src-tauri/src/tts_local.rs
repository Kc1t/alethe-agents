//! Piper voices through sherpa-onnx. Loading a voice reads ~60 MB, so the last one stays cached.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig,
    OfflineTtsVitsModelConfig,
};

static CACHE: Mutex<Option<(PathBuf, Arc<OfflineTts>)>> = Mutex::new(None);

fn engine(dir: &Path, model_file: &str) -> Result<Arc<OfflineTts>, String> {
    let mut slot = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, tts)) = slot.as_ref() {
        if cached == dir {
            return Ok(Arc::clone(tts));
        }
    }
    let path = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            // The default noise and length scales are the ones Piper voices are tuned for.
            vits: OfflineTtsVitsModelConfig {
                model: path(model_file),
                tokens: path("tokens.txt"),
                data_dir: path("espeak-ng-data"),
                ..Default::default()
            },
            num_threads: 2,
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    };
    let tts = Arc::new(
        OfflineTts::create(&config).ok_or_else(|| "failed to load the voice model".to_string())?,
    );
    *slot = Some((dir.to_path_buf(), Arc::clone(&tts)));
    Ok(tts)
}

fn forget_in<T>(slot: &mut Option<(PathBuf, T)>, dir: &Path) {
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

/// Samples and their rate. Blocks for the length of the synthesis; call on a worker thread.
pub fn synthesize(
    dir: &Path,
    model_file: &str,
    text: &str,
    rate: f32,
) -> Result<(Vec<f32>, u32), String> {
    let tts = engine(dir, model_file)?;
    let config = GenerationConfig {
        speed: speed(rate),
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

    use super::{forget_in, speakable, speed, synthesize};

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
        assert!(synthesize(&dir, "missing.onnx", "oi", 1.0).is_err());
    }
}
