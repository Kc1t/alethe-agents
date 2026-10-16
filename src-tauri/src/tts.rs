//! Speech output for voice conversation. The `tts` crate's handle is not thread-safe (it wraps an
//! `Rc`), and AVSpeechSynthesizer delivers its callbacks on the main run loop, so the engine lives
//! on the main thread and every command hops there.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::audio_out::AudioOut;
use crate::voice_providers::http::CloudErrorKind;
use crate::voice_providers::{catalog, keys, openrouter, tts_cloud, CloudProvider};
use crate::voice_servers::error::ServerErrorKind;
use crate::voice_servers::store::VoiceServer;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    id: String,
    name: String,
    language: String,
}

thread_local! {
    static ENGINE: RefCell<Option<tts::Tts>> = const { RefCell::new(None) };
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// One utterance at a time: each speak interrupts the previous one, so the callbacks report this.
static CURRENT_ID: AtomicU64 = AtomicU64::new(0);

/// Debug string of the latest utterance's id paired with our id; `UtteranceId` is only `Debug`
/// on macOS, so its Debug string is the portable key.
static LATEST: Mutex<Option<(String, u64)>> = Mutex::new(None);

/// The id to report for a callback: ours when the callback is for the latest utterance, the
/// fallback when none is tracked, and nothing for a stale (interrupted) utterance.
fn matching_id(latest: Option<&(String, u64)>, key: &str, fallback: u64) -> Option<u64> {
    match latest {
        Some((latest_key, id)) => (latest_key == key).then_some(*id),
        None => Some(fallback),
    }
}

fn callback_id(key: &str) -> Option<u64> {
    let latest = LATEST.lock().unwrap_or_else(|e| e.into_inner());
    matching_id(latest.as_ref(), key, CURRENT_ID.load(Ordering::SeqCst))
}

fn scaled_rate(normal: f32, min: f32, max: f32, multiplier: f32) -> f32 {
    (normal * multiplier).clamp(min, max)
}

fn create_engine(app: &AppHandle) -> Result<tts::Tts, String> {
    let engine = tts::Tts::default().map_err(|e| format!("tts_unavailable: {e}"))?;
    if engine.supported_features().utterance_callbacks {
        let begin = app.clone();
        let _ = engine.on_utterance_begin(Some(Box::new(move |utterance| {
            if let Some(id) = callback_id(&format!("{utterance:?}")) {
                let _ = begin.emit("tts://start", serde_json::json!({ "id": id }));
            }
        })));
        let end = app.clone();
        let _ = engine.on_utterance_end(Some(Box::new(move |utterance| {
            if let Some(id) = callback_id(&format!("{utterance:?}")) {
                let _ = end.emit("tts://end", serde_json::json!({ "id": id }));
            }
        })));
    }
    Ok(engine)
}

/// Runs `work` against the engine on the main thread and hands its result back.
async fn with_engine<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&mut tts::Tts) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = ENGINE.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_none() {
                *slot = Some(create_engine(&handle)?);
            }
            work(slot.as_mut().expect("engine just created"))
        });
        let _ = sender.send(result);
    })
    .map_err(|e| e.to_string())?;
    receiver
        .await
        .map_err(|_| "tts: the main thread dropped the request".to_string())?
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TtsProvider {
    System,
    Local,
    Server,
    Openai,
    Elevenlabs,
    Gemini,
    Openrouter,
}

impl TtsProvider {
    fn cloud(self) -> Option<CloudProvider> {
        match self {
            Self::Openai => Some(CloudProvider::Openai),
            Self::Elevenlabs => Some(CloudProvider::Elevenlabs),
            Self::Gemini => Some(CloudProvider::Gemini),
            Self::Openrouter => Some(CloudProvider::Openrouter),
            Self::System | Self::Local | Self::Server => None,
        }
    }
}

fn is_current(id: u64) -> bool {
    CURRENT_ID.load(Ordering::SeqCst) == id
}

/// Audio is queued for utterance `id`: the player path's counterpart of the system voice's begin
/// callback, so listeners can time the speech from when it is audible, not from when it was asked.
fn emit_start(app: &AppHandle, id: u64) {
    if is_current(id) {
        let _ = app.emit("tts://start", serde_json::json!({ "id": id }));
    }
}

/// The shared cloud/local player, fetched per utterance: it reopens itself after a dead stream.
fn player(app: &AppHandle) -> Result<Arc<AudioOut>, String> {
    let handle = app.clone();
    crate::audio_out::get(move |id| {
        if is_current(id) {
            let _ = handle.emit("tts://end", serde_json::json!({ "id": id }));
        }
    })
}

/// The OS voice, speaking utterance `id` (already current; a failed cloud utterance keeps its
/// id). Dropped silently when a newer utterance has taken over meanwhile.
async fn speak_system(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
    id: u64,
) -> Result<u64, String> {
    with_engine(app, move |engine| {
        if !is_current(id) {
            return Ok(id);
        }
        let features = engine.supported_features();
        if let (Some(id), true) = (voice.as_deref(), features.voice) {
            if let Some(found) = engine
                .voices()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|candidate| candidate.id() == id)
            {
                engine.set_voice(&found).map_err(|e| e.to_string())?;
            }
        }
        if let (Some(multiplier), true) = (rate, features.rate) {
            let next = scaled_rate(
                engine.normal_rate(),
                engine.min_rate(),
                engine.max_rate(),
                multiplier,
            );
            engine.set_rate(next).map_err(|e| e.to_string())?;
        }
        let utterance = engine.speak(text, true).map_err(|e| e.to_string())?;
        *LATEST.lock().unwrap_or_else(|e| e.into_inner()) =
            utterance.map(|utterance| (format!("{utterance:?}"), id));
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn tts_speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
    provider: Option<TtsProvider>,
    model: Option<String>,
    server: Option<String>,
) -> Result<u64, String> {
    // The new id becomes current before anything is stopped or awaited, so a stale utterance can
    // never report or resume over it.
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    CURRENT_ID.store(id, Ordering::SeqCst);
    let provider = provider.unwrap_or(TtsProvider::System);
    if provider == TtsProvider::Local {
        let found = model
            .as_deref()
            .map(|model_id| crate::speech::local_tts_model(&app, model_id));
        if let Some(Ok((dir, model_file))) = found {
            stop_all(&app).await;
            let rate = normalized_rate(rate);
            // A local voice id is the speaker number of a multi-voice model.
            let sid = voice
                .as_deref()
                .and_then(|v| v.parse::<i32>().ok())
                .unwrap_or(0);
            let model_id = model.as_deref().unwrap_or_default();
            let local = LocalVoice {
                dir,
                layout,
                sid,
                lang: crate::speech::local_tts_language(&app, model_id, sid)
                    .and_then(|tag| crate::tts_local::kokoro_lang(&tag)),
                hub: crate::speech_hub::installed::repo_of(model_id).is_some(),
            };
            tauri::async_runtime::spawn(speak_local(app, id, local, rate, text));
            return Ok(id);
        }
        // A missing local voice falls back to the system voice below, never to the cloud.
    }
    if provider == TtsProvider::Server {
        stop_all(&app).await;
        let rate = normalized_rate(rate);
        let server = server.unwrap_or_default();
        tauri::async_runtime::spawn(speak_server(app, id, server, voice, rate, text));
        return Ok(id);
    }
    let Some(cloud) = provider.cloud() else {
        // A cloud or local utterance may still be draining its queued audio.
        crate::audio_out::stop_if_running();
        return speak_system(app, text, voice, rate, id).await;
    };
    stop_all(&app).await;
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| catalog::default_model(cloud, "tts").map(str::to_string))
        .unwrap_or_default();
    let rate = normalized_rate(rate);
    tauri::async_runtime::spawn(speak_cloud(app, id, cloud, model, voice, rate, text));
    Ok(id)
}

fn normalized_rate(rate: Option<f32>) -> f32 {
    rate.filter(|r| r.is_finite() && *r > 0.0).unwrap_or(1.0)
}

/// Local chunks stay short so the first sentence plays while the rest is synthesized.
const LOCAL_CHUNK_CHARS: usize = 400;
const _: () = assert!(LOCAL_CHUNK_CHARS < tts_cloud::MAX_TTS_CHARS);

/// A downloaded local voice and how to speak with it.
struct LocalVoice {
    dir: std::path::PathBuf,
    layout: crate::tts_local::TtsLayout,
    sid: i32,
    /// Kokoro's language for the speaker, when the manifest names it.
    lang: Option<&'static str>,
    /// A Hugging Face model: a failure is logged as one.
    hub: bool,
}

/// What spawn.log records when a local voice fails before any audio plays.
fn local_failure_log(hub: bool) -> &'static str {
    if hub {
        "voice tts: local hub model failed to load"
    } else {
        "voice tts: local failed"
    }
}

/// A local voice. Any failure before audio plays hands the whole text to the system voice under
/// the same id; it never reaches for a cloud provider.
async fn speak_local(app: AppHandle, id: u64, local: LocalVoice, rate: f32, text: String) {
    let LocalVoice {
        dir,
        layout,
        sid,
        lang,
        hub,
    } = local;
    let Ok(out) = player(&app) else {
        let _ = speak_system(app, text, None, Some(rate), id).await;
        return;
    };
    if !is_current(id) {
        return;
    }
    out.begin(id);
    for (index, chunk) in tts_cloud::split_for_tts(&text, LOCAL_CHUNK_CHARS)
        .into_iter()
        .enumerate()
    {
        if !is_current(id) {
            return;
        }
        let dir = dir.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::tts_local::synthesize(&dir, model_file, &chunk, rate)
        })
        .await;
        match result {
            Ok(Ok((samples, sample_rate))) => {
                out.push(id, &samples, sample_rate);
                if index == 0 {
                    emit_start(&app, id);
                }
            }
            // Nothing played yet: the system voice speaks the whole text instead.
            _ if index == 0 => {
                let _ = crate::diagnostics::append_spawn_log(&app, local_failure_log(hub));
                let _ = speak_system(app, text, None, Some(rate), id).await;
                return;
            }
            // Mid-utterance: stop where we are rather than restart from the top.
            _ => break,
        }
    }
    out.close(id);
}

/// Reports a cloud failure and, when nothing has played yet, speaks the whole text with the
/// system voice under the same id. Logs carry the provider id and error class only.
async fn fall_back(
    app: AppHandle,
    id: u64,
    cloud: CloudProvider,
    kind: CloudErrorKind,
    text: String,
    rate: f32,
) {
    // Stopped or superseded meanwhile: nothing to report or speak.
    if !is_current(id) {
        return;
    }
    let _ = crate::diagnostics::append_spawn_log(
        &app,
        &format!("voice tts: {} failed: {kind:?}", cloud.id()),
    );
    let _ = app.emit(
        "voice://fallback",
        serde_json::json!({ "usage": "narration", "provider": cloud.id(), "reason": kind, "fallback": "system" }),
    );
    let _ = speak_system(app, text, None, Some(rate), id).await;
}

async fn speak_cloud(
    app: AppHandle,
    id: u64,
    cloud: CloudProvider,
    model: String,
    voice: Option<String>,
    rate: f32,
    text: String,
) {
    let key = match keys::read_key(&app, cloud) {
        Ok(Some(key)) => key,
        Ok(None) => return fall_back(app, id, cloud, CloudErrorKind::Auth, text, rate).await,
        Err(_) => return fall_back(app, id, cloud, CloudErrorKind::Other, text, rate).await,
    };
    let voice = match (cloud, voice) {
        (CloudProvider::Elevenlabs, None) => match tts_cloud::fetch_voices(&key).await {
            Ok(list) => list.into_iter().next().map(|voice| voice.id),
            Err(error) => return fall_back(app, id, cloud, error.kind, text, rate).await,
        },
        (_, voice) => voice,
    };
    let out = match player(&app) {
        Ok(out) => out,
        Err(_) => return fall_back(app, id, cloud, CloudErrorKind::Other, text, rate).await,
    };
    if !is_current(id) {
        return;
    }
    out.begin(id);
    for (index, chunk) in tts_cloud::split_for_tts(&text, tts_cloud::MAX_TTS_CHARS)
        .into_iter()
        .enumerate()
    {
        if !is_current(id) {
            return;
        }
        match tts_cloud::synthesize(cloud, &model, voice.as_deref(), &key, &chunk, rate).await {
            Ok(pcm) => {
                let playback = tts_cloud::playback_rate(cloud, rate, pcm.sample_rate);
                out.push(id, &pcm.samples, playback);
                if index == 0 {
                    emit_start(&app, id);
                }
            }
            // Nothing played yet: hand the whole text to the system voice under the same id.
            Err(error) if index == 0 => {
                return fall_back(app, id, cloud, error.kind, text, rate).await
            }
            // Mid-utterance: stop where we are rather than restart from the top.
            Err(_) => break,
        }
    }
    out.close(id);
}

async fn stop_all(app: &AppHandle) {
    crate::audio_out::stop_if_running();
    let _ = with_engine(app.clone(), |engine| {
        if engine.supported_features().stop {
            engine.stop().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await;
}

#[tauri::command]
pub async fn tts_stop(app: AppHandle) -> Result<(), String> {
    CURRENT_ID.store(0, Ordering::SeqCst);
    stop_all(&app).await;
    Ok(())
}

async fn system_voices(app: AppHandle) -> Result<Vec<TtsVoice>, String> {
    with_engine(app, |engine| {
        if !engine.supported_features().voice {
            return Ok(Vec::new());
        }
        Ok(engine
            .voices()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|voice| TtsVoice {
                id: voice.id(),
                name: voice.name(),
                language: voice.language().to_string(),
            })
            .collect())
    })
    .await
}

/// OpenRouter and local server voices carry no name or language of their own: the id is shown as is.
fn router_voices(ids: Vec<String>) -> Vec<TtsVoice> {
    ids.into_iter()
        .map(|id| TtsVoice {
            name: id.clone(),
            id,
            language: String::new(),
        })
        .collect()
}

/// The voices of an OpenRouter speech model, from the live list (fetched when not cached).
/// Empty when the model is unknown or the list cannot be fetched.
async fn openrouter_voices(app: &AppHandle, model: Option<String>) -> Vec<TtsVoice> {
    let Some(model) = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| catalog::default_model(CloudProvider::Openrouter, "tts").map(str::to_string))
    else {
        return Vec::new();
    };
    if let Some(voices) = openrouter::cached_voices(&model) {
        return router_voices(voices);
    }
    let voices = match openrouter::live_models(app, "tts").await {
        Ok(models) => models
            .into_iter()
            .find(|entry| entry.id == model)
            .map(|entry| entry.voices)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    router_voices(voices)
}

#[tauri::command]
pub async fn tts_voices(
    app: AppHandle,
    provider: Option<TtsProvider>,
    model: Option<String>,
    server: Option<String>,
) -> Result<Vec<TtsVoice>, String> {
    if provider == Some(TtsProvider::Server) {
        let ids =
            crate::voice_servers::voices_for(&app, server.as_deref().unwrap_or_default()).await;
        return Ok(router_voices(ids));
    }
    match provider.and_then(TtsProvider::cloud) {
        None if provider == Some(TtsProvider::Local) => Ok(Vec::new()),
        None => system_voices(app).await,
        Some(CloudProvider::Elevenlabs) => {
            let Some(key) = keys::read_key(&app, CloudProvider::Elevenlabs)? else {
                return Ok(Vec::new());
            };
            let list = tts_cloud::fetch_voices(&key)
                .await
                .map_err(|e| e.to_string())?;
            Ok(list
                .into_iter()
                .map(|voice| TtsVoice {
                    id: voice.id,
                    name: voice.name,
                    language: voice.language,
                })
                .collect())
        }
        Some(CloudProvider::Openrouter) => Ok(openrouter_voices(&app, model).await),
        Some(cloud) => Ok(catalog::provider_catalog(cloud)
            .voices
            .iter()
            .map(|voice| TtsVoice {
                id: voice.id.into(),
                name: voice.label.into(),
                language: String::new(),
            })
            .collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::{matching_id, scaled_rate};

    #[test]
    fn only_cloud_providers_map_to_a_cloud_id() {
        use super::TtsProvider;
        assert!(TtsProvider::System.cloud().is_none());
        assert!(TtsProvider::Local.cloud().is_none());
        assert_eq!(
            TtsProvider::Gemini.cloud(),
            Some(crate::voice_providers::CloudProvider::Gemini)
        );
    }

    #[test]
    fn openrouter_voices_are_listed_by_id() {
        let voices = super::router_voices(vec!["pf_dora".into(), "Zephyr".into()]);
        let fields: Vec<(&str, &str, &str)> = voices
            .iter()
            .map(|v| (v.id.as_str(), v.name.as_str(), v.language.as_str()))
            .collect();
        assert_eq!(
            fields,
            vec![("pf_dora", "pf_dora", ""), ("Zephyr", "Zephyr", "")]
        );
    }

    #[test]
    fn a_missing_or_invalid_rate_plays_at_normal_speed() {
        use super::normalized_rate;
        assert_eq!(normalized_rate(None), 1.0);
        assert_eq!(normalized_rate(Some(f32::NAN)), 1.0);
        assert_eq!(normalized_rate(Some(0.0)), 1.0);
        assert_eq!(normalized_rate(Some(1.25)), 1.25);
    }

    #[test]
    fn callbacks_report_only_the_latest_utterance() {
        let latest = ("B".to_string(), 7);
        assert_eq!(matching_id(Some(&latest), "B", 3), Some(7));
        assert_eq!(matching_id(Some(&latest), "A", 3), None);
        assert_eq!(matching_id(None, "A", 3), Some(3));
    }

    #[test]
    fn the_rate_multiplier_scales_the_engine_rate_within_its_bounds() {
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 1.0), 1.0);
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 1.5), 1.5);
        assert_eq!(scaled_rate(1.0, 0.1, 2.0, 4.0), 2.0);
        assert_eq!(scaled_rate(0.5, 0.0, 1.0, 0.1), 0.05);
        assert_eq!(scaled_rate(0.5, 0.2, 1.0, 0.1), 0.2);
    }
}
