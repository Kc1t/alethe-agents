//! Speech output for voice conversation. The `tts` crate's handle is not thread-safe (it wraps an
//! `Rc`), and AVSpeechSynthesizer delivers its callbacks on the main run loop, so the engine lives
//! on the main thread and every command hops there.

use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::audio_out::{AudioOut, TextSpan};
use crate::voice_providers::http::{CloudError, CloudErrorKind};
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

/// What muting does to the OS voice, from its volume scale (`Some((min, normal))`, when it has
/// one). Only a scale that reaches 0 can be silenced; otherwise a muted utterance is skipped and
/// the caller's estimate keeps the narration's pace.
#[derive(Debug, PartialEq)]
enum SystemVolume {
    Set(f32),
    Keep,
    Skip,
}

fn system_volume(muted: bool, scale: Option<(f32, f32)>) -> SystemVolume {
    match scale {
        Some((min, normal)) if min.abs() <= f32::EPSILON => {
            SystemVolume::Set(if muted { min } else { normal })
        }
        _ if muted => SystemVolume::Skip,
        _ => SystemVolume::Keep,
    }
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

/// How often the player reports where it is in the text (`tts://progress`).
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(100);

/// While utterance `id` plays, reports the character offset reached in its text, in code points,
/// whenever it moves: it stands still while paused and goes on while muted. Ends with the
/// utterance.
fn report_progress(app: AppHandle, out: Arc<AudioOut>, id: u64) {
    tauri::async_runtime::spawn(async move {
        let mut last = None;
        while is_current(id) {
            let Some(offset) = out.progress(id) else {
                break;
            };
            if last != Some(offset) {
                last = Some(offset);
                let _ = app.emit(
                    "tts://progress",
                    serde_json::json!({ "id": id, "charOffset": offset }),
                );
            }
            tokio::time::sleep(PROGRESS_EVERY).await;
        }
    });
}

fn span_of(start: usize, chunk: &str) -> TextSpan {
    TextSpan {
        start,
        len: chunk.chars().count(),
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
        let scale = features
            .volume
            .then(|| (engine.min_volume(), engine.normal_volume()));
        match system_volume(crate::audio_out::is_muted(), scale) {
            SystemVolume::Set(volume) => {
                engine.set_volume(volume).map_err(|e| e.to_string())?;
            }
            SystemVolume::Keep => {}
            SystemVolume::Skip => {
                // Silenced by not speaking: no end is reported, so the estimate paces the queue.
                if features.stop {
                    engine.stop().map_err(|e| e.to_string())?;
                }
                return Ok(id);
            }
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
        if let Some(Ok((dir, layout))) = found {
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
    let model = cloud_model(cloud, model);
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
    for (index, (start, chunk)) in tts_cloud::split_for_tts_spans(&text, LOCAL_CHUNK_CHARS)
        .into_iter()
        .enumerate()
    {
        if !is_current(id) {
            return;
        }
        let dir = dir.clone();
        let layout = layout.clone();
        let span = span_of(start, &chunk);
        let result = tokio::task::spawn_blocking(move || {
            crate::tts_local::synthesize(&dir, &layout, &chunk, rate, sid, lang)
        })
        .await;
        match result {
            Ok(Ok((samples, sample_rate))) => {
                out.push(id, &samples, sample_rate, span);
                if index == 0 {
                    emit_start(&app, id);
                    report_progress(app.clone(), Arc::clone(&out), id);
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

fn server_or_missing(server: Option<VoiceServer>) -> Result<VoiceServer, ServerErrorKind> {
    server.ok_or(ServerErrorKind::Missing)
}

/// Reports a local server failure and, when nothing has played yet, speaks the whole text with the
/// system voice under the same id. Logs and events carry the server id and error kind only.
/// `server` must already be a `shown_server_id`.
async fn fall_back_server(
    app: AppHandle,
    id: u64,
    server: String,
    kind: ServerErrorKind,
    text: String,
    rate: f32,
) {
    if !is_current(id) {
        return;
    }
    let _ = crate::diagnostics::append_spawn_log(
        &app,
        &format!("voice tts: server {server} failed: {kind:?}"),
    );
    let _ = app.emit(
        "voice://fallback",
        serde_json::json!({ "usage": "narration", "provider": "server", "server": server, "reason": kind, "fallback": "system" }),
    );
    let _ = speak_system(app, text, None, Some(rate), id).await;
}

/// The server id for logs and events: the webview's string is shown only once it parses as an id.
fn shown_server_id(raw: &str) -> String {
    crate::voice_servers::id::ServerId::parse(raw)
        .map(|id| id.to_string())
        .unwrap_or_else(|| "invalid".into())
}

/// A local voice server, chunk by chunk (short chunks: a CPU-only server is slow). A failure
/// before audio plays hands the text to the system voice; a later one stops where it is.
async fn speak_server(
    app: AppHandle,
    id: u64,
    server_id: String,
    voice: Option<String>,
    rate: f32,
    text: String,
) {
    let shown = shown_server_id(&server_id);
    let server = match server_or_missing(crate::voice_servers::find_active(&app, &server_id)) {
        Ok(server) => server,
        Err(kind) => return fall_back_server(app, id, shown, kind, text, rate).await,
    };
    let key = match crate::voice_servers::server_key(&app, &server).await {
        Ok(key) => key,
        Err(kind) => return fall_back_server(app, id, shown, kind, text, rate).await,
    };
    let Ok(out) = player(&app) else {
        return fall_back_server(app, id, shown, ServerErrorKind::Other, text, rate).await;
    };
    if !is_current(id) {
        return;
    }
    out.begin(id);
    let mut started = false;
    for (start, chunk) in tts_cloud::split_for_tts_spans(&text, LOCAL_CHUNK_CHARS) {
        if !is_current(id) {
            return;
        }
        match crate::voice_servers::client::synthesize(
            &server,
            key.as_deref(),
            voice.as_deref(),
            &chunk,
            rate,
        )
        .await
        {
            Ok(pcm) => {
                let pcm = tts_cloud::trim_silence(pcm);
                let playback = crate::voice_servers::adapter::playback_rate(
                    server.kind,
                    rate,
                    pcm.sample_rate,
                );
                out.push(id, &pcm.samples, playback, span_of(start, &chunk));
                if !started {
                    started = true;
                    emit_start(&app, id);
                    report_progress(app.clone(), Arc::clone(&out), id);
                }
            }
            Err(kind) if !started => {
                return fall_back_server(app, id, shown, kind, text, rate).await
            }
            Err(kind) => {
                let _ = crate::diagnostics::append_spawn_log(
                    &app,
                    &format!("voice tts: server {shown} chunk failed: {kind:?}"),
                );
                break;
            }
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

/// What a chunk was synthesized with; a prefetched chunk is used only for the very same request.
#[derive(Clone, Debug, PartialEq)]
struct ChunkKey {
    cloud: CloudProvider,
    model: String,
    voice: Option<String>,
    rate: u32,
    text: String,
}

impl ChunkKey {
    fn new(cloud: CloudProvider, model: &str, voice: Option<&str>, rate: f32, text: &str) -> Self {
        Self {
            cloud,
            model: model.to_string(),
            voice: voice.map(str::to_string),
            rate: rate.to_bits(),
            text: text.to_string(),
        }
    }
}

type Synthesis = Result<tts_cloud::Pcm, CloudError>;
type PendingChunk = Arc<tokio::sync::OnceCell<Synthesis>>;

/// First chunks of what the narrator says next (`tts_prefetch`), synthesized while the current
/// item plays so the next one starts without waiting for the network. A speak takes its chunk out,
/// waiting for it when the synthesis is still running.
static PREFETCHED: Mutex<Vec<(ChunkKey, PendingChunk)>> = Mutex::new(Vec::new());
/// Only the next item or two is ever prefetched; older entries were skipped and are dropped.
const PREFETCH_KEPT: usize = 4;

fn take_prefetched(key: &ChunkKey) -> Option<PendingChunk> {
    let mut cache = PREFETCHED.lock().unwrap_or_else(|e| e.into_inner());
    let index = cache.iter().position(|(cached, _)| cached == key)?;
    Some(cache.remove(index).1)
}

/// The pending synthesis for `key`, added when there is none; `true` when it was just added.
fn prefetch_slot(key: ChunkKey) -> (PendingChunk, bool) {
    let mut cache = PREFETCHED.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, pending)) = cache.iter().find(|(cached, _)| *cached == key) {
        return (Arc::clone(pending), false);
    }
    if cache.len() >= PREFETCH_KEPT {
        cache.remove(0);
    }
    let pending = PendingChunk::default();
    cache.push((key, Arc::clone(&pending)));
    (pending, true)
}

/// One chunk, from the prefetch cache when it holds it, else from the provider, with one more try
/// after a transient failure.
async fn synthesize_chunk(key: &ChunkKey, api_key: &str) -> Synthesis {
    if let Some(pending) = take_prefetched(key) {
        if let Ok(pcm) = pending.get_or_init(|| synthesize_once(key, api_key)).await {
            return Ok(pcm.clone());
        }
    }
    match synthesize_once(key, api_key).await {
        Err(error) if tts_cloud::is_transient(&error) => synthesize_once(key, api_key).await,
        result => result,
    }
}

async fn synthesize_once(key: &ChunkKey, api_key: &str) -> Synthesis {
    tts_cloud::synthesize(
        key.cloud,
        &key.model,
        key.voice.as_deref(),
        api_key,
        &key.text,
        f32::from_bits(key.rate),
    )
    .await
    .map(tts_cloud::trim_silence)
}

/// The voice to ask for: ElevenLabs voices belong to the account, so without a choice it is the
/// account's first one.
async fn resolve_voice(
    cloud: CloudProvider,
    voice: Option<String>,
    api_key: &str,
) -> Result<Option<String>, CloudError> {
    match (cloud, voice) {
        (CloudProvider::Elevenlabs, None) => Ok(tts_cloud::fetch_voices(api_key)
            .await?
            .into_iter()
            .next()
            .map(|voice| voice.id)),
        (_, voice) => Ok(voice),
    }
}

/// The model to speak with: the one chosen, else the provider's default.
fn cloud_model(cloud: CloudProvider, model: Option<String>) -> String {
    model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| catalog::default_model(cloud, "tts").map(str::to_string))
        .unwrap_or_default()
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
    let key = match keys::read_key_async(&app, cloud).await {
        Ok(Some(key)) => key,
        Ok(None) => return fall_back(app, id, cloud, CloudErrorKind::Auth, text, rate).await,
        Err(_) => return fall_back(app, id, cloud, CloudErrorKind::Other, text, rate).await,
    };
    let voice = match resolve_voice(cloud, voice, &key).await {
        Ok(voice) => voice,
        Err(error) => return fall_back(app, id, cloud, error.kind, text, rate).await,
    };
    let out = match player(&app) {
        Ok(out) => out,
        Err(_) => return fall_back(app, id, cloud, CloudErrorKind::Other, text, rate).await,
    };
    if !is_current(id) {
        return;
    }
    out.begin(id);
    let mut started = false;
    for (start, chunk) in tts_cloud::split_for_speech(&text) {
        if !is_current(id) {
            return;
        }
        let chunk_key = ChunkKey::new(cloud, &model, voice.as_deref(), rate, &chunk);
        match synthesize_chunk(&chunk_key, &key).await {
            Ok(pcm) => {
                let playback = tts_cloud::playback_rate(cloud, &model, rate, pcm.sample_rate);
                out.push(id, &pcm.samples, playback, span_of(start, &chunk));
                if !started {
                    started = true;
                    emit_start(&app, id);
                    report_progress(app.clone(), Arc::clone(&out), id);
                }
            }
            Err(error) => {
                let _ = crate::diagnostics::append_spawn_log(
                    &app,
                    &format!("voice tts: {} chunk failed: {error}", cloud.id()),
                );
                // Nothing played yet: hand the whole text to the system voice under the same id.
                if !started {
                    return fall_back(app, id, cloud, error.kind, text, rate).await;
                }
                // Mid-utterance: skip what could not be said and go on with the rest, rather than
                // leave the narration cut short.
            }
        }
    }
    out.close(id);
}

/// Synthesizes the first chunk of `text` ahead of its `tts_speak`, for a cloud voice only (local
/// and system voices start quickly). Best effort: a failure is retried by the speak itself.
#[tauri::command]
pub async fn tts_prefetch(
    webview: tauri::WebviewWindow,
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<f32>,
    provider: Option<TtsProvider>,
    model: Option<String>,
) -> Result<(), String> {
    crate::voice_hud::require_window(webview.label(), "main")?;
    let Some(cloud) = provider.and_then(TtsProvider::cloud) else {
        return Ok(());
    };
    let Some((_, chunk)) = tts_cloud::split_for_speech(&text).into_iter().next() else {
        return Ok(());
    };
    let Ok(Some(api_key)) = keys::read_key_async(&app, cloud).await else {
        return Ok(());
    };
    let model = cloud_model(cloud, model);
    // Keyed by the resolved voice, as the speak keys its chunks.
    let resolved = resolve_voice(cloud, voice, &api_key)
        .await
        .map_err(|error| error.to_string())?;
    let key = ChunkKey::new(
        cloud,
        &model,
        resolved.as_deref(),
        normalized_rate(rate),
        &chunk,
    );
    let (pending, added) = prefetch_slot(key.clone());
    if added {
        tauri::async_runtime::spawn(async move {
            let _ = pending
                .get_or_init(|| synthesize_once(&key, &api_key))
                .await;
        });
    }
    Ok(())
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
    // Only a stop (or barge-in) and `tts_resume` release a pause; a new `tts_speak` keeps it.
    crate::audio_out::stop_and_release();
    stop_all(&app).await;
    Ok(())
}

/// Holds cloud and local narration at the sample it reached. The OS voice cannot be held: the
/// frontend stops it and says the interrupted sentence again on resume.
#[tauri::command]
pub fn tts_pause(webview: tauri::WebviewWindow) -> Result<(), String> {
    crate::voice_hud::require_window(webview.label(), "main")?;
    crate::audio_out::set_paused(true);
    Ok(())
}

#[tauri::command]
pub fn tts_resume(webview: tauri::WebviewWindow) -> Result<(), String> {
    crate::voice_hud::require_window(webview.label(), "main")?;
    crate::audio_out::set_paused(false);
    Ok(())
}

/// Narration keeps its pace with no sound, for the rest of the session. The OS voice takes the
/// new volume from its next utterance.
#[tauri::command]
pub fn tts_set_muted(webview: tauri::WebviewWindow, muted: bool) -> Result<(), String> {
    crate::voice_hud::require_window(webview.label(), "main")?;
    crate::audio_out::set_muted(muted);
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
async fn openrouter_voices(model: Option<String>) -> Vec<TtsVoice> {
    let Some(model) = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| catalog::default_model(CloudProvider::Openrouter, "tts").map(str::to_string))
    else {
        return Vec::new();
    };
    if let Some(voices) = openrouter::cached_voices(&model) {
        return router_voices(voices);
    }
    let voices = match openrouter::live_models("tts").await {
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
        None if provider == Some(TtsProvider::Local) => {
            let Some(id) = model.filter(|m| !m.trim().is_empty()) else {
                return Ok(Vec::new());
            };
            Ok(crate::speech::local_tts_voices(&app, &id)
                .await
                .into_iter()
                .map(|voice| TtsVoice {
                    id: voice.id.to_string(),
                    name: voice.name,
                    language: voice.language,
                })
                .collect())
        }
        None => system_voices(app).await,
        Some(CloudProvider::Elevenlabs) => {
            let Some(key) = keys::read_key_async(&app, CloudProvider::Elevenlabs).await? else {
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
        Some(CloudProvider::Openrouter) => Ok(openrouter_voices(model).await),
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

    // A prefetched chunk is found only for the very same request, once, and the cache stays small.
    #[test]
    fn prefetched_chunks_match_their_request_and_are_taken_once() {
        let key = |text: &str, rate: f32| {
            ChunkKey::new(
                CloudProvider::Openrouter,
                "google/x-tts",
                Some("Zephyr"),
                rate,
                text,
            )
        };
        let (first, added) = prefetch_slot(key("prefetch test one.", 1.0));
        assert!(added);
        let (again, added) = prefetch_slot(key("prefetch test one.", 1.0));
        assert!(!added && Arc::ptr_eq(&first, &again));
        assert!(take_prefetched(&key("prefetch test one.", 1.5)).is_none());
        assert!(take_prefetched(&key("prefetch test one.", 1.0)).is_some());
        assert!(take_prefetched(&key("prefetch test one.", 1.0)).is_none());
        for index in 0..PREFETCH_KEPT + 2 {
            prefetch_slot(key(&format!("prefetch test filler {index}."), 1.0));
        }
        assert!(PREFETCHED.lock().unwrap().len() <= PREFETCH_KEPT);
    }
    use std::sync::Arc;

    use super::{
        local_failure_log, matching_id, prefetch_slot, scaled_rate, take_prefetched, ChunkKey,
        CloudProvider, TtsProvider, PREFETCHED, PREFETCH_KEPT,
    };

    #[test]
    fn server_is_a_provider_without_a_cloud() {
        let provider: TtsProvider = serde_json::from_str("\"server\"").unwrap();
        assert_eq!(provider, TtsProvider::Server);
        assert!(provider.cloud().is_none());
    }

    #[test]
    fn shown_server_id_hides_unparsed_input() {
        assert_eq!(super::shown_server_id("V1StGXR8_Z5jdHi6B-myT"), "V1StGXR8_Z5jdHi6B-myT");
        assert_eq!(super::shown_server_id("not an id\nINJECT"), "invalid");
    }

    #[test]
    fn missing_server_reads_as_missing() {
        assert_eq!(
            super::server_or_missing(None),
            Err(crate::voice_servers::error::ServerErrorKind::Missing)
        );
    }

    #[test]
    fn a_hub_voice_failure_is_logged_as_one() {
        assert_eq!(
            local_failure_log(true),
            "voice tts: local hub model failed to load"
        );
        assert_eq!(local_failure_log(false), "voice tts: local failed");
    }

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
    fn muting_silences_engines_that_reach_zero_and_skips_the_others() {
        use super::{system_volume, SystemVolume};
        // AVSpeechSynthesizer and WinRT: 0..1, normal 1.
        assert_eq!(
            system_volume(true, Some((0.0, 1.0))),
            SystemVolume::Set(0.0)
        );
        assert_eq!(
            system_volume(false, Some((0.0, 1.0))),
            SystemVolume::Set(1.0)
        );
        // speech-dispatcher's quietest (-100) is not silence: skip the utterance instead.
        assert_eq!(
            system_volume(true, Some((-100.0, 100.0))),
            SystemVolume::Skip
        );
        assert_eq!(
            system_volume(false, Some((-100.0, 100.0))),
            SystemVolume::Keep
        );
        // No volume control at all.
        assert_eq!(system_volume(true, None), SystemVolume::Skip);
        assert_eq!(system_volume(false, None), SystemVolume::Keep);
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
