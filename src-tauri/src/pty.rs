use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::cli_resolver::{command_builder_for_terminal, find_windows_cli_launcher};
use crate::diagnostics::append_spawn_log;
use crate::paths::{scrollback_dir, scrollback_path};
use crate::process_tree;
use crate::provider_common::now_ms;

pub const SCROLLBACK_CAP_BYTES: usize = 4 * 1024 * 1024;
pub const SCROLLBACK_FLUSH_INTERVAL_MS: u128 = 250;

/// `SCROLLBACK_CAP_BYTES`. 2× o cap = ~2× de write-amplification amortizada

pub const SCROLLBACK_COMPACT_BYTES: u64 = SCROLLBACK_CAP_BYTES as u64 * 2;

pub const PTY_ACTIVITY_EMIT_INTERVAL_MS: u128 = 450;
const TEARDOWN_NORMAL: u8 = 0;
const TEARDOWN_KILLED: u8 = 1;
const TEARDOWN_SUSPENDED: u8 = 2;
const TEARDOWN_RESTARTED: u8 = 3;

/// supervisor no modo manual.
const SPAWN_MIN_AVAILABLE_MB: f64 = 400.0;
const SPAWN_MEMORY_WAIT_POLL_MS: u64 = 1_000;

const SPAWN_MEMORY_WAIT_MAX_MS: u128 = 45_000;

fn wait_for_spawnable_memory() {
    let started = Instant::now();
    loop {
        let available_mb = crate::stats::memory_stats_cached().system_available_mb;
        if available_mb >= SPAWN_MIN_AVAILABLE_MB {
            return;
        }
        if started.elapsed().as_millis() >= SPAWN_MEMORY_WAIT_MAX_MS {
            return;
        }
        thread::sleep(Duration::from_millis(SPAWN_MEMORY_WAIT_POLL_MS));
    }
}

// (~5.8 GB de folga) enquanto a RAM "livre" parecia OK. Comprometer de

fn prepare_memory_for_boot() {
    wait_for_spawnable_memory();
}

pub struct ScrollbackBuffer {
    pub data: VecDeque<u8>,
    pub last_flush: Instant,
    pub dirty: bool,

    pub pending: Vec<u8>,
}

impl ScrollbackBuffer {
    pub fn new(initial: VecDeque<u8>) -> Self {
        Self {
            data: initial,
            last_flush: Instant::now(),
            dirty: false,
            pending: Vec::new(),
        }
    }
}

/// a cauda de um caractere multibyte que o `read()` do PTY partiu no limite do

fn valid_utf8_prefix_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(s) => s.len(),
        Err(error) => error.valid_up_to(),
    }
}

/// `from_utf8_lossy` seguinte.
pub(crate) fn align_to_char_boundary(slice: &[u8], start: usize) -> usize {
    let mut start = start.min(slice.len());
    while start < slice.len() && (slice[start] & 0xC0) == 0x80 {
        start += 1;
    }
    start
}

/// output real → resize → nudge de redesenho) em `spawn.log`, pro

fn pty_debug_enabled() -> bool {
    std::env::var("ALETHE_PTY_DEBUG").as_deref() == Ok("1")
}

fn activity_emit_due(last_activity_emit: Option<Instant>, interval_ms: u128) -> bool {
    match last_activity_emit {
        None => true,
        Some(last) => last.elapsed().as_millis() >= interval_ms,
    }
}

pub struct PtySession {
    pub pty_id: String,

    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,

    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,

    pub reader_done: Arc<(Mutex<Option<bool>>, Condvar)>,
    /// Motivo do teardown. Kill/restart pulam o flush final; suspend espera o
    pub teardown: Arc<AtomicU8>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub read_active: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,

    pub visible: Arc<AtomicBool>,

    /// OpenCode, disparado tanto no boot (primeiro output real do processo)
    /// quanto em `resize_pty`. Os dois gatilhos podem cair quase juntos —

    /// sobrepunham na tela em vez de um substituir o outro (texto/blocos de
    /// um redraw colidindo com o outro), confirmado analisando os bytes
    pub opencode_nudge_lock: Arc<AtomicU64>,
}

const OPENCODE_NUDGE_COOLDOWN_MS: u64 = 400;

/// relaxar.
fn try_claim_opencode_nudge(lock: &AtomicU64) -> bool {
    let now = now_ms();
    let last = lock.load(Ordering::SeqCst);
    if now.saturating_sub(last) < OPENCODE_NUDGE_COOLDOWN_MS {
        return false;
    }
    lock.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

pub type PtySessions = Arc<Mutex<HashMap<String, PtySession>>>;

#[cfg(windows)]
static PTY_JOB_HANDLE: OnceLock<isize> = OnceLock::new();

static SPAWN_COORDINATOR: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();

struct SpawnReservation {
    id: String,
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        let (spawning, ready) =
            SPAWN_COORDINATOR.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()));
        if let Ok(mut ids) = spawning.lock() {
            ids.remove(&self.id);
            ready.notify_all();
        }
    }
}

fn reserve_spawn(sessions: &PtySessions, id: &str) -> Result<Option<SpawnReservation>, String> {
    let (spawning, ready) =
        SPAWN_COORDINATOR.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()));
    let mut ids = spawning
        .lock()
        .map_err(|_| "PTY spawn coordinator lock poisoned".to_string())?;

    loop {
        let already_spawned = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?
            .contains_key(id);
        if already_spawned {
            return Ok(None);
        }
        if ids.insert(id.to_string()) {
            return Ok(Some(SpawnReservation { id: id.to_string() }));
        }
        ids = ready
            .wait(ids)
            .map_err(|_| "PTY spawn coordinator wait poisoned".to_string())?;
    }
}

#[derive(Serialize)]
pub struct SpawnPtyResponse {
    pub id: String,
}

#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub code: Option<i32>,
    pub reason: &'static str,
}

#[derive(Clone, Serialize)]
pub struct PtySuspendedPayload {
    pub id: String,
    pub reason: &'static str,
}

#[derive(Serialize)]
pub struct PtyProcessSnapshot {
    pub id: String,
    pub pid: Option<u32>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub process_name: Option<String>,
    pub cmdline: Option<String>,
    pub memory_mb: f64,
    pub alive: bool,
}

#[tauri::command]
pub fn pty_exists(sessions: State<'_, PtySessions>, id: String) -> Result<bool, String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    Ok(sessions.contains_key(&id))
}

#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    remote: State<'_, Arc<crate::remote::RemoteHub>>,
    cols: u16,
    rows: u16,
    id: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    // launcher_override: path absoluto que supersede o auto-detect. Frontend
    launcher_override: Option<String>,

    // canvas) — nunca polui o ambiente global nem outros terminais.
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<SpawnPtyResponse, String> {
    // OUTRO comando IPC (spawn de outro terminal, poll do GSD Sync, leitura de

    // `activity_stats`, `agent_cost`).
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let remote_hub = Arc::clone(remote.inner());
    tokio::task::spawn_blocking(move || {
        let extras: Vec<String> = extra_args.unwrap_or_default();
        let spawn_started = Instant::now();
        let id = id.unwrap_or_else(|| nanoid::nanoid!());
        let requested_command = command.clone();

        let Some(_spawn_reservation) = reserve_spawn(&sessions, &id)? else {
            return Ok(SpawnPtyResponse { id });
        };

                                                                        
                                                                            
        // `prepare_memory_for_boot`).
        prepare_memory_for_boot();

        let scrollback = Arc::new(Mutex::new(ScrollbackBuffer::new(load_scrollback(
            &app, &id,
        )?)));
        let teardown = Arc::new(AtomicU8::new(TEARDOWN_NORMAL));
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;

        let resolve_started = Instant::now();
        // 1. Se frontend mandou override (user configurou via cliPaths), usa ele
                                                                                 
                                                               
        let resolved_launcher = if let Some(override_path) = launcher_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_file())
        {
            Some(override_path.to_string_lossy().to_string())
        } else {
            requested_command
                .as_deref()
                .and_then(|raw| {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        return None;
                    }
                    find_windows_cli_launcher(trimmed)
                })
                .map(|path| path.to_string_lossy().to_string())
        };
        let mut command = command_builder_for_terminal(
            requested_command.as_deref(),
            resolved_launcher.as_deref(),
            &extras,
        );
        if let Some(extra_env) = env.as_ref() {
            for (key, value) in extra_env {
                command.env(key, value);
            }
        }
        let resolve_ms = resolve_started.elapsed().as_millis();
        let builder_ms = spawn_started.elapsed().as_millis();
        let effective_path_preview = command
            .get_env("Path")
            .or_else(|| command.get_env("PATH"))
            .map(|value| {
                let s = value.to_string_lossy();
                let limit = s.len().min(240);
                s[..limit].to_string()
            })
            .unwrap_or_else(|| "<none>".to_string());
        let cwd_warning = if let Some(cwd_value) = cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
            if PathBuf::from(cwd_value).is_dir() {
                                                                               
                                                                                 
                                                                                 
                                                                               
                                                                                
                                                                          
                                                                      
                command.cwd(crate::worktrees::git_arg(Path::new(cwd_value)));
                None
            } else {
                Some(format!(
                    "\r\nWarning: cwd not found, using default directory: {cwd_value}\r\n"
                ))
            }
        } else {
            None
        };
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        let shell_spawn_ms = spawn_started.elapsed().as_millis();
        let child = Arc::new(Mutex::new(child));
        let child_pid = child.lock().ok().and_then(|child| child.process_id());
        if let Some(pid) = child_pid {
            process_tree::register_pty_root(&id, pid);
        }
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = Arc::new(Mutex::new(
            pair.master
                .take_writer()
                .map_err(|error| error.to_string())?,
        ));
        let opencode_nudge_lock = Arc::new(AtomicU64::new(0));
        // Nudge de boot (ver uso mais abaixo, no loop de batches): o Ctrl+L
                                                                           
                                                                         
                                                                             
                                                                            
        // OpenCode terminar de subir e trocar o TTY pro modo raw/alt-screen
                                                                         
                                                                        
                                                                            
                                                                      
        let is_opencode = requested_command.as_deref() == Some("opencode");
        let boot_nudge_writer = Arc::clone(&writer);
        let boot_nudge_lock = Arc::clone(&opencode_nudge_lock);
                                                                            
                                                                             
        // do OpenCode em branco, docs/CHANGELOG.md), separado de `event_app`
                                                                          
        let debug_app = app.clone();
        let debug_id = id.clone();
        let event_name = format!("pty://data/{id}");
        let activity_event_name = format!("pty://activity/{id}");
        let exit_event_name = format!("pty://exit/{id}");
        let event_app = app.clone();
        let scrollback_app = app.clone();
        let scrollback_id = id.clone();
        let thread_scrollback = Arc::clone(&scrollback);
        let thread_teardown = Arc::clone(&teardown);
        let reader_done = Arc::new((Mutex::new(None), Condvar::new()));
        let thread_reader_done = Arc::clone(&reader_done);
        let thread_child = Arc::clone(&child);
        let thread_sessions = sessions.clone();
        let initial_warning = cwd_warning.clone();
        let read_active = Arc::new((std::sync::Mutex::new(true), std::sync::Condvar::new()));
        let thread_read_active = Arc::clone(&read_active);
        let visible = Arc::new(AtomicBool::new(true));
        let thread_visible = Arc::clone(&visible);
        let remote_pty_id = id.clone();

                                                                                 
                                                                                    
        // de emitir. Resultado: 1 evento IPC + 1 push_scrollback por LOTE em vez de
                                                                               
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1024);

        tauri::async_runtime::spawn(async move {
        tokio::task::spawn_blocking(move || {
                                                                              
                                                                  
            let mut buffer = [0_u8; 32 * 1024];
            loop {
                                                                            
                {
                    let (lock, cvar) = &*thread_read_active;
                    let mut active = lock.lock().unwrap();
                    while !*active {
                        active = cvar.wait(active).unwrap();
                    }
                }

                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if tx.blocking_send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

                                                                          
        let mut carry: Vec<u8> = Vec::new();
        let mut batch: Vec<u8> = Vec::new();
                                                                       
                                                                           
        let mut last_activity_emit: Option<Instant> = None;
                                                                         
                                                                              
                                                                            
                                                         
        let mut activity_pending = String::new();
        const ACTIVITY_PENDING_CAP: usize = 256 * 1024;

                                                                          
                                                                             
                                                                            
                                                                             
                                                                             
                                                                    
        //
        // O throttle ACUMULA em `activity_pending` em vez de descartar: o
                                                                          
                                                                               
        // amostrar o stream faria um agente em segundo plano nunca sair de
                                                                       
        let mut emit_data_or_activity = |text: &str| {
                                                                           
                                                                             
                                                                  
            remote_hub.publish(&remote_pty_id, || {
                serde_json::json!({ "type": "pty_output", "ptyId": &remote_pty_id, "text": text })
            });
            if thread_visible.load(Ordering::Relaxed) {
                if !activity_pending.is_empty() {
                    activity_pending.clear();
                }
                let _ = event_app.emit(&event_name, text);
                return;
            }
            activity_pending.push_str(text);
            if activity_pending.len() > ACTIVITY_PENDING_CAP {
                let drop_to = activity_pending.len() - ACTIVITY_PENDING_CAP;
                let boundary = align_to_char_boundary(activity_pending.as_bytes(), drop_to);
                activity_pending.drain(..boundary);
            }
            if activity_emit_due(last_activity_emit, PTY_ACTIVITY_EMIT_INTERVAL_MS) {
                let _ = event_app.emit(&activity_event_name, activity_pending.as_str());
                activity_pending.clear();
                last_activity_emit = Some(Instant::now());
            }
        };

        if let Some(warning) = initial_warning {
            let _ = event_app.emit(&event_name, &warning);
            let _ = push_scrollback(
                &scrollback_app,
                &scrollback_id,
                &thread_scrollback,
                warning.as_bytes(),
            );
        }

        let mut sent_boot_nudge = false;

        loop {
                                                                             
                                                                             
            let Some(first) = rx.recv().await else { break };
            batch.extend_from_slice(&first);

                                                                           
                                                                      
                                                                           
                                                                          
                                                                   
            if is_opencode && !sent_boot_nudge {
                sent_boot_nudge = true;
                if pty_debug_enabled() {
                    let _ = append_spawn_log(
                        &debug_app,
                        &format!(
                            "[pty-debug] {debug_id}: primeiro batch real recebido ({} bytes)",
                            first.len()
                        ),
                    );
                }
                let nudge_writer = Arc::clone(&boot_nudge_writer);
                let nudge_lock = Arc::clone(&boot_nudge_lock);
                let nudge_debug_app = debug_app.clone();
                let nudge_debug_id = debug_id.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                                                                             
                                                                          
                                                                          
                                                                           
                                                              
                    let claimed = try_claim_opencode_nudge(&nudge_lock);
                    if pty_debug_enabled() {
                        let _ = append_spawn_log(
                            &nudge_debug_app,
                            &format!(
                                "[pty-debug] {nudge_debug_id}: nudge de boot {} (150ms após 1º batch)",
                                if claimed { "ENVIADO" } else { "pulado (perdeu a trava)" }
                            ),
                        );
                    }
                    if claimed {
                        if let Ok(mut writer) = nudge_writer.lock() {
                            let _ = writer.write_all(&[12]);
                            let _ = writer.flush();
                        }
                    }
                });
            }

                                                                     
            let batch_started = Instant::now();
            while batch.len() < 64 * 1024 {
                let remaining =
                    Duration::from_millis(16).saturating_sub(batch_started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(chunk)) => batch.extend_from_slice(&chunk),
                    // None = canal fechou; ainda emitimos o lote acumulado.
                    Ok(None) => break,
                    // Timeout de 16ms estourou.
                    Err(_) => break,
                }
            }

            let count = batch.len();
                                                                              
                                                       
            let _ = push_scrollback(&scrollback_app, &scrollback_id, &thread_scrollback, &batch);

                                                                             
                                                                               
                                                      
            if carry.is_empty() {
                                                                          
                let valid = valid_utf8_prefix_len(&batch);
                if valid > 0 {
                                                                            
                    let text = unsafe { std::str::from_utf8_unchecked(&batch[..valid]) };
                    emit_data_or_activity(text);
                }
                if valid < count {
                    carry.extend_from_slice(&batch[valid..]);
                }
            } else {
                carry.extend_from_slice(&batch);
                let valid = valid_utf8_prefix_len(&carry);
                if valid > 0 {
                                                                            
                    let text = unsafe { std::str::from_utf8_unchecked(&carry[..valid]) };
                    emit_data_or_activity(text);
                    carry.drain(..valid);
                }
            }

                                                                          
                                                                        
                                                                      
            if carry.len() > 3 {
                let lossy = String::from_utf8_lossy(&carry).into_owned();
                emit_data_or_activity(lossy.as_str());
                carry.clear();
            }

            batch.clear();

                                                                     
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // Flush de qualquer cauda restante no fim do stream.
        if !carry.is_empty() {
            let lossy = String::from_utf8_lossy(&carry).into_owned();
            let _ = event_app.emit(&event_name, lossy.as_str());
            remote_hub.publish(&scrollback_id, || {
                serde_json::json!({ "type": "pty_output", "ptyId": &scrollback_id, "text": lossy })
            });
        }

                                                                                  
                                                                                      
                                                                                  
        //
                                                                               
                                                                               
                                                                               
                                                                                  
        let teardown_reason = thread_teardown.load(Ordering::SeqCst);
        let persisted = if teardown_reason == TEARDOWN_KILLED
            || teardown_reason == TEARDOWN_RESTARTED
        {
            if let Ok(mut buffer) = thread_scrollback.lock() {
                buffer.data = VecDeque::new();
                buffer.pending.clear();
                buffer.dirty = false;
            }
            true
        } else {
            let flushed = flush_scrollback(&scrollback_app, &scrollback_id, &thread_scrollback)
                .and_then(|_| {
                    if teardown_reason == TEARDOWN_SUSPENDED {
                        wait_for_scrollback_writer()
                    } else {
                        Ok(())
                    }
                })
                .is_ok();
            if flushed {
                if let Ok(mut buffer) = thread_scrollback.lock() {
                    buffer.data = VecDeque::new();
                    buffer.dirty = false;
                }
            }
            flushed
        };

        let (done_lock, done_ready) = &*thread_reader_done;
        if let Ok(mut done) = done_lock.lock() {
            *done = Some(persisted);
            done_ready.notify_all();
        }

        let code = thread_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);
        let reason = match teardown_reason {
            TEARDOWN_KILLED => "killed",
            TEARDOWN_SUSPENDED => "suspended",
            TEARDOWN_RESTARTED => "restarted",
            _ => "exited",
        };
        let _ = event_app.emit(&exit_event_name, PtyExitPayload { code, reason });
        remote_hub.publish(&scrollback_id, || {
            serde_json::json!({ "type": "pty_exit", "ptyId": &scrollback_id, "reason": reason })
        });

        if let Some(pid) = child_pid {
            if let Ok(mut sessions) = thread_sessions.lock() {
                let should_remove = sessions
                    .get(&scrollback_id)
                    .and_then(|session| session.child.lock().ok()?.process_id())
                    .map(|current_pid| current_pid == pid)
                    .unwrap_or(false);
                if should_remove {
                    sessions.remove(&scrollback_id);
                }
            }
        }
    });

        let _ = append_spawn_log(
            &app,
            &format!(
                "spawn id={id} command={:?} launcher={:?} resolve_ms={resolve_ms} builder_ms={builder_ms} shell_spawn_ms={shell_spawn_ms} total_ms={} path_preview={effective_path_preview:?}",
                requested_command,
                resolved_launcher,
                spawn_started.elapsed().as_millis()
            ),
        );

        let session = PtySession {
            pty_id: id.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            writer,
            child,
            scrollback,
            reader_done,
            teardown,
            command: requested_command,
            cwd,
            read_active,
            visible,
            opencode_nudge_lock,
        };

        sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?
            .insert(id.clone(), session);

        Ok(SpawnPtyResponse { id })
    })
    .await
    .map_err(|error| format!("spawn_pty: falha na task bloqueante: {error}"))?
}

/// direto (o shell/ConPTY) — `node`/`claude`/`codex` e seus filhos (MCP, workers)

/// Reads the pid, releases the lock, and only then kills the tree.
///
/// `kill_process_tree` runs `taskkill` and waits for it, which under load takes anywhere from
/// hundreds of milliseconds to seconds. Holding the child lock across that stalls the snapshot
/// path, which takes the global session lock before this one — and `write_pty` starts by taking
/// that same global lock, so a single slow kill stops every terminal in the app from accepting a
/// keystroke while output, which never touches the lock, keeps arriving.
fn kill_tree_without_holding_child(child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>) {
    let pid = child.lock().ok().and_then(|mut child| child.process_id());
    if let Some(pid) = pid {
        kill_process_tree(pid);
    }
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
}

#[cfg(windows)]
pub(crate) fn kill_process_tree(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/F", "/T", "/PID", &pid.to_string()]);
    crate::git_control::hide_console(&mut command);
    let _ = command.output();
}

#[cfg(not(windows))]
pub(crate) fn kill_process_tree(_pid: u32) {}

#[tauri::command]
pub async fn restart_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    remote: State<'_, Arc<crate::remote::RemoteHub>>,
    id: String,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    launcher_override: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnPtyResponse, String> {
    // apagar o scrollback antigo rodava direto no corpo async, fora de

    let kill_sessions: PtySessions = Arc::clone(sessions.inner());
    let kill_app = app.clone();
    let kill_id = id.clone();
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = kill_sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            sessions.remove(&kill_id)
        };
        if let Some(session) = session {
            session.teardown.store(TEARDOWN_RESTARTED, Ordering::SeqCst);
            // `kill_pty_tree` (process_tree.rs) derruba raiz + descendentes em

            let _ = process_tree::kill_pty_tree(&kill_id);
            kill_tree_without_holding_child(&session.child);
        }
        delete_scrollback(&kill_app, &kill_id)
    })
    .await
    .map_err(|error| format!("restart_pty: falha na task bloqueante: {error}"))??;

    spawn_pty(
        app,
        sessions,
        remote,
        80,
        24,
        Some(id),
        command,
        cwd,
        extra_args,
        launcher_override,
        env,
    )
    .await
}

#[tauri::command]
pub async fn attach_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    // lento sob um scrollback grande. Igual a `spawn_pty`, roda em

    // completo em `spawn_pty`.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let max_bytes = max_bytes.unwrap_or(512 * 1024).max(16 * 1024);

        {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&id) {
                let mut buffer = session
                    .scrollback
                    .lock()
                    .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
                if !buffer.data.is_empty() {
                    let slice = buffer.data.make_contiguous();
                    let start =
                        align_to_char_boundary(slice, slice.len().saturating_sub(max_bytes));
                    return Ok(String::from_utf8_lossy(&slice[start..]).into_owned());
                }
            }
        }

        // liberado. Em ambos os casos o disco tem a verdade (vazio ou o scrollback final).
        let disk = load_scrollback(&app, &id)?;
        let bytes: Vec<u8> = disk.into_iter().collect();
        let start = align_to_char_boundary(&bytes, bytes.len().saturating_sub(max_bytes));
        Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
    })
    .await
    .map_err(|error| format!("attach_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn clear_pty_scrollback(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<(), String> {
    let scrollback = {
        let sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        sessions
            .get(&id)
            .map(|session| Arc::clone(&session.scrollback))
    };
    let Some(scrollback) = scrollback else {
        return Ok(());
    };

    tokio::task::spawn_blocking(move || {
        let mut buffer = scrollback
            .lock()
            .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
        reset_scrollback_buffer(&mut buffer);
        let path = scrollback_path(&app, &id)?;
        scrollback_writer()
            .send(ScrollbackWrite::Overwrite {
                path,
                bytes: Vec::new(),
            })
            .map_err(|_| "scrollback writer unavailable".to_string())?;
        drop(buffer);
        wait_for_scrollback_writer()
    })
    .await
    .map_err(|error| format!("clear_pty_scrollback task failed: {error}"))?
}

fn reset_scrollback_buffer(buffer: &mut ScrollbackBuffer) {
    buffer.data.clear();
    buffer.pending.clear();
    buffer.dirty = false;
    buffer.last_flush = Instant::now();
}

#[tauri::command]
pub async fn write_pty(
    sessions: State<'_, PtySessions>,
    id: String,
    data: String,
) -> Result<(), String> {
    // lock, qualquer attach/resize/kill/spawn em outro PTY ficaria parado.

    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let writer = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&id)
                .ok_or_else(|| format!("PTY not found: {id}"))?;
            Arc::clone(&session.writer)
        };
        let mut writer = writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("write_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn resize_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        if pty_debug_enabled() {
            let _ = append_spawn_log(&app, &format!("[pty-debug] {id}: resize_pty {cols}x{rows}"));
        }
        let (master, writer, is_opencode, nudge_lock) = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&id)
                .ok_or_else(|| format!("PTY not found: {id}"))?;
            (
                Arc::clone(&session.master),
                Arc::clone(&session.writer),
                session.command.as_deref() == Some("opencode"),
                Arc::clone(&session.opencode_nudge_lock),
            )
        };

        {
            let master = master
                .lock()
                .map_err(|_| "PTY master lock poisoned".to_string())?;
            master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())?;
        }

        //

        // entrega/tratamento desse sinal e o Ctrl+L chegando no stdin logo

        // no meio — a tela sai com blocos de glifo corrompidos em vez de

        //
        // `try_claim_opencode_nudge` coordena com o nudge de boot (primeiro
        // output do processo, em `spawn_pty`) — os dois podem disparar quase

        // e o OpenCode fazia dois redesenhos concorrentes que se
        // sobrepunham na tela (confirmado analisando os bytes crus do
        // scrollback — texto de um redraw colidindo com blocos do outro).
        if is_opencode {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let claimed = try_claim_opencode_nudge(&nudge_lock);
            if pty_debug_enabled() {
                let _ = append_spawn_log(
                    &app,
                    &format!(
                        "[pty-debug] {id}: nudge de resize {} (50ms após master.resize)",
                        if claimed {
                            "ENVIADO"
                        } else {
                            "pulado (perdeu a trava)"
                        }
                    ),
                );
            }
            if claimed {
                if let Ok(mut writer) = writer.lock() {
                    let _ = writer.write_all(&[12]);
                    let _ = writer.flush();
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|error| format!("resize_pty: falha na task bloqueante: {error}"))?
}

fn terminate_session(session: PtySession) {
    let _ = process_tree::kill_pty_tree(&session.pty_id);
    process_tree::unregister_pty(&session.pty_id);
    {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
    kill_tree_without_holding_child(&session.child);
}

#[tauri::command]
pub async fn kill_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<(), String> {
    // fim do `if let`), prendendo TODO outro comando PTY (spawn/attach/write/

    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            sessions.remove(&id)
        };

        if let Some(session) = session {
            session.teardown.store(TEARDOWN_KILLED, Ordering::SeqCst);
            terminate_session(session);
        }

        delete_scrollback(&app, &id)
    })
    .await
    .map_err(|error| format!("kill_pty: falha na task bloqueante: {error}"))?
}

///

pub fn suspend_session(app: &AppHandle, sessions: &PtySessions, id: &str) -> Result<bool, String> {
    suspend_session_with_reason(app, sessions, id, "user-request")
}

pub fn suspend_session_with_reason(
    app: &AppHandle,
    sessions: &PtySessions,
    id: &str,
    reason: &'static str,
) -> Result<bool, String> {
    let session = {
        let mut sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        sessions.remove(id)
    };
    let Some(session) = session else {
        return Ok(false);
    };

    session.teardown.store(TEARDOWN_SUSPENDED, Ordering::SeqCst);
    let _ = process_tree::kill_pty_tree(&session.pty_id);
    kill_tree_without_holding_child(&session.child);
    {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
    // Close the pseudoconsole BEFORE waiting on the barrier. On Windows ConPTY,
    // killing the child does not close the output pipe — the blocking reader
    // stays in read() until the master (HPCON) is dropped. Holding the session
    // across the wait would deadlock the reader against its own flush barrier.
    let reader_done = Arc::clone(&session.reader_done);
    drop(session);

    let (done_lock, done_ready) = &*reader_done;
    let done = done_lock
        .lock()
        .map_err(|_| "PTY reader barrier lock poisoned".to_string())?;
    let (done, timeout) = done_ready
        .wait_timeout_while(done, Duration::from_secs(5), |status| status.is_none())
        .map_err(|_| "PTY reader barrier lock poisoned".to_string())?;
    if timeout.timed_out() && done.is_none() {
        return Err("PTY reader flush barrier timed out".to_string());
    }
    if *done != Some(true) {
        return Err("PTY reader failed to persist scrollback".to_string());
    }
    let _ = app.emit(
        "resource://pty-suspended",
        PtySuspendedPayload {
            id: id.to_string(),
            reason,
        },
    );
    let _ = append_spawn_log(app, &format!("suspend id={id} reason={reason}"));
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(id);
    }
    Ok(true)
}

#[tauri::command]
pub async fn suspend_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<bool, String> {
    let sessions: PtySessions = Arc::clone(sessions.inner());
    tokio::task::spawn_blocking(move || suspend_session(&app, &sessions, &id))
        .await
        .map_err(|error| format!("suspend_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn get_pty_cwd(
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<Option<String>, String> {
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let result = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let sessions = sessions.lock().ok()?;
        let session = sessions.get(&id)?;
        let pid_u32 = session.child.lock().ok()?.process_id()?;
        drop(sessions);

        let mut sys = System::new();
        let pid = Pid::from_u32(pid_u32);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            ProcessRefreshKind::new().with_cwd(sysinfo::UpdateKind::Always),
        );
        let cwd = sys.process(pid)?.cwd()?.to_string_lossy().to_string();
        Some(cwd)
    })
    .await
    .unwrap_or(None);
    Ok(result)
}

#[tauri::command]
pub fn set_pty_read_state(
    sessions: State<'_, PtySessions>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if let Some(session) = sessions.get(&id) {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut read_active) = lock.lock() {
            *read_active = active;
            if active {
                cvar.notify_all();
            }
        }
    }
    Ok(())
}

#[tauri::command]
/// Returns whether the flag was applied. `false` means the session was not there to receive it —
/// the caller must not assume the stream is now on, because output gating stays as it was.
pub fn set_pty_visible(
    sessions: State<'_, PtySessions>,
    id: String,
    visible: bool,
) -> Result<bool, String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    match sessions.get(&id) {
        Some(session) => {
            session.visible.store(visible, Ordering::Relaxed);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn set_pty_priority(
    _sessions: State<'_, PtySessions>,
    _id: String,
    _active: bool,
) -> Result<(), String> {
    let _sessions: PtySessions = Arc::clone(_sessions.inner());
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        unsafe {
            let sessions = _sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&_id) {
                if let Ok(child) = session.child.lock() {
                    if let Some(pid) = child.process_id() {
                        use windows_sys::Win32::Foundation::CloseHandle;
                        use windows_sys::Win32::System::Threading::{
                            OpenProcess, SetPriorityClass, IDLE_PRIORITY_CLASS,
                            NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
                        };

                        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
                        if !handle.is_null() {
                            let priority = if _active {
                                NORMAL_PRIORITY_CLASS
                            } else {
                                IDLE_PRIORITY_CLASS
                            };
                            let _ = SetPriorityClass(handle, priority);
                            let _ = CloseHandle(handle);
                        }
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("set_pty_priority: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn list_pty_processes(
    sessions: State<'_, PtySessions>,
) -> Result<Vec<PtyProcessSnapshot>, String> {
    // lento sob carga. Igual aos outros comandos PTY, isolado em

    // vazia se a task bloqueante falhar por algum motivo.
    let sessions: PtySessions = Arc::clone(sessions.inner());
    let result: Vec<PtyProcessSnapshot> = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

        let raw = {
            let Ok(sessions) = sessions.lock() else {
                return Vec::new();
            };
            sessions
                .iter()
                .map(|(id, session)| {
                    // try_lock, not lock: this snapshot is telemetry and it runs while holding
                    // the global session lock, which every keystroke needs. Waiting here for a
                    // busy child would stop the whole app from accepting input to report a pid.
                    let pid = session
                        .child
                        .try_lock()
                        .ok()
                        .and_then(|mut child| child.process_id());
                    (
                        id.clone(),
                        pid,
                        session.command.clone(),
                        session.cwd.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };

        let pids = raw
            .iter()
            .filter_map(|(_, pid, _, _)| pid.map(Pid::from_u32))
            .collect::<Vec<_>>();
        let mut sys = System::new();
        if !pids.is_empty() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                ProcessRefreshKind::everything(),
            );
        }

        raw.into_iter()
            .map(|(id, pid, command, cwd)| {
                let process = pid.and_then(|pid| sys.process(Pid::from_u32(pid)));
                let memory_mb = process
                    .map(|process| process.memory() as f64 / 1024.0 / 1024.0)
                    .unwrap_or(0.0);
                let process_name =
                    process.map(|process| process.name().to_string_lossy().to_string());
                let cmdline = process.map(|process| {
                    process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                PtyProcessSnapshot {
                    id,
                    pid,
                    command,
                    cwd,
                    process_name,
                    cmdline,
                    memory_mb,
                    alive: process.is_some(),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default();
    Ok(result)
}

pub fn load_scrollback(app: &AppHandle, id: &str) -> Result<VecDeque<u8>, String> {
    let path = scrollback_path(app, id)?;
    if !path.exists() {
        return Ok(VecDeque::new());
    }

    let mut data = fs::read(path).map_err(|error| error.to_string())?;
    if data.len() > SCROLLBACK_CAP_BYTES {
        data = data[data.len() - SCROLLBACK_CAP_BYTES..].to_vec();
    }
    Ok(data.into())
}

enum ScrollbackWrite {
    Append { path: PathBuf, bytes: Vec<u8> },

    Overwrite { path: PathBuf, bytes: Vec<u8> },

    Barrier(std::sync::mpsc::Sender<()>),
}

fn append_and_maybe_compact(path: &Path, bytes: &[u8]) {
    let mut file = match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    if file.write_all(bytes).is_err() {
        return;
    }
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    drop(file);
    if len > SCROLLBACK_COMPACT_BYTES {
        if let Ok(all) = fs::read(path) {
            if all.len() > SCROLLBACK_CAP_BYTES {
                let tail = &all[all.len() - SCROLLBACK_CAP_BYTES..];
                let _ = fs::write(path, tail);
            }
        }
    }
}

fn scrollback_writer() -> &'static std::sync::mpsc::Sender<ScrollbackWrite> {
    static WRITER: std::sync::OnceLock<std::sync::mpsc::Sender<ScrollbackWrite>> =
        std::sync::OnceLock::new();
    WRITER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<ScrollbackWrite>();
        thread::spawn(move || {
            while let Ok(msg) = rx.recv() {
                match &msg {
                    ScrollbackWrite::Append { path, bytes } => {
                        if let Some(parent) = path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        append_and_maybe_compact(path, bytes);
                    }
                    ScrollbackWrite::Overwrite { path, bytes } => {
                        if let Some(parent) = path.parent() {
                            let _ = fs::create_dir_all(parent);
                        }
                        let _ = fs::write(path, bytes);
                    }
                    ScrollbackWrite::Barrier(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        tx
    })
}

fn wait_for_scrollback_writer() -> Result<(), String> {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    scrollback_writer()
        .send(ScrollbackWrite::Barrier(done_tx))
        .map_err(|_| "scrollback writer unavailable".to_string())?;
    done_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "scrollback writer barrier timed out".to_string())
}

pub fn push_scrollback(
    app: &AppHandle,
    id: &str,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
    data: &[u8],
) -> Result<(), String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    buffer.data.extend(data);

    if buffer.data.len() > SCROLLBACK_CAP_BYTES {
        let excess = buffer.data.len() - SCROLLBACK_CAP_BYTES;
        buffer.data.drain(..excess);
    }

    buffer.pending.extend_from_slice(data);
    buffer.dirty = true;

    if buffer.last_flush.elapsed().as_millis() < SCROLLBACK_FLUSH_INTERVAL_MS {
        return Ok(());
    }

    if buffer.data.capacity() > SCROLLBACK_CAP_BYTES * 2 {
        buffer.data.shrink_to(SCROLLBACK_CAP_BYTES);
    }
    let bytes = std::mem::take(&mut buffer.pending);
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    if bytes.is_empty() {
        return Ok(());
    }

    let path = scrollback_path(app, id)?;

    let _ = scrollback_writer().send(ScrollbackWrite::Append { path, bytes });
    Ok(())
}

pub fn flush_scrollback(
    app: &AppHandle,
    id: &str,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
) -> Result<(), String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    if !buffer.dirty {
        return Ok(());
    }

    let bytes = buffer.data.iter().copied().collect::<Vec<_>>();
    buffer.pending.clear();
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    // a cauda no disco.
    let path = scrollback_path(app, id)?;
    let _ = scrollback_writer().send(ScrollbackWrite::Overwrite { path, bytes });
    Ok(())
}

pub fn delete_scrollback(app: &AppHandle, id: &str) -> Result<(), String> {
    let path = scrollback_path(app, id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    let _ = scrollback_dir(app);
    Ok(())
}

pub fn cleanup_orphan_scrollback(app: &AppHandle) {
    let Ok(dir) = scrollback_dir(app) else {
        return;
    };
    if !dir.is_dir() {
        return;
    }
    let projects_text = match crate::paths::projects_file_path(app) {
        Ok(path) => fs::read_to_string(&path).unwrap_or_default(),
        Err(_) => return,
    };

    if projects_text.is_empty() {
        return;
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !projects_text.contains(stem) {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Removes every session from shared state immediately and terminates process trees off the event
/// loop, so a slow Windows `taskkill` cannot make the application appear frozen while closing.
/// How long shutdown waits for terminal processes to die before giving up on them.
const SHUTDOWN_KILL_TIMEOUT: Duration = Duration::from_secs(4);

pub fn kill_all_sessions_background(sessions: &PtySessions) {
    let drained = sessions
        .lock()
        .ok()
        .map(|mut sessions| {
            sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if drained.is_empty() {
        return;
    }

    // One thread per session, then wait for them. Two reasons this is not fire-and-forget:
    // terminating a session runs `taskkill` and waits for it, so doing them in sequence costs the
    // sum of every kill; and a detached thread dies with the process, which on shutdown is
    // immediate — the agents were simply left running, and the next attempt to resume one of their
    // sessions found the old process still holding it.
    let total = drained.len();
    let (done, finished) = std::sync::mpsc::channel::<()>();
    for session in drained {
        let done = done.clone();
        let _ = std::thread::Builder::new()
            .name("alethe-pty-shutdown".to_string())
            .spawn(move || {
                terminate_session(session);
                let _ = done.send(());
            });
    }
    drop(done);

    // Bounded: a kill that will not finish must not hold the window open forever.
    let deadline = Instant::now() + SHUTDOWN_KILL_TIMEOUT;
    for _ in 0..total {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || finished.recv_timeout(remaining).is_err() {
            break;
        }
    }
}

static JOB_GUARD_ACTIVE: OnceLock<bool> = OnceLock::new();

pub fn job_guard_active() -> bool {
    JOB_GUARD_ACTIVE.get().copied().unwrap_or(false)
}

/// e seus descendentes (node/claude/codex/MCP) herdam o job. Enquanto o app vive,

#[cfg(windows)]
pub fn install_kill_on_close_guard() {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let active = unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[pty] install_kill_on_close_guard: CreateJobObjectW falhou (GetLastError não capturado)");
            false
        } else {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                eprintln!("[pty] install_kill_on_close_guard: SetInformationJobObject falhou");
                let _ = CloseHandle(job);
                false
            } else if AssignProcessToJobObject(job, GetCurrentProcess()) != 0 {
                // feche o Job Object cedo demais e elimine os terminais

                let _ = PTY_JOB_HANDLE.set(job as isize);
                true
            } else {
                // vazando.
                eprintln!(
                    "[pty] install_kill_on_close_guard: AssignProcessToJobObject falhou — \
                     rede de segurança contra terminais órfãos INATIVA nesta sessão"
                );
                let _ = CloseHandle(job);
                false
            }
        }
    };
    let _ = JOB_GUARD_ACTIVE.set(active);
}

#[cfg(not(windows))]
pub fn install_kill_on_close_guard() {
    // On Linux there is no equivalent of a Windows Job Object. Instead, the shutdown
    // handler in lib.rs calls kill_all_sessions_background() on ExitRequested, which
    // now works thanks to the SIGTERM/SIGKILL process-group kill in kill_process_tree.
    // On the next startup, sweep_orphans_from_previous_session() kills any grandchild
    // processes that escaped the previous shutdown.
    let _ = JOB_GUARD_ACTIVE.set(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the invariant that made every terminal stop accepting keystrokes at once:
    /// `kill_process_tree` runs `taskkill` and waits for it, and holding the child lock across
    /// that stalled the snapshot path, which holds the global session lock that every write needs.
    /// Guards the reason agents outlived the app: shutdown spawned a detached thread that killed
    /// sessions one after another, and the process exited before it got through them. The next
    /// attempt to resume one of those sessions then found the old process still holding it.
    #[test]
    fn shutdown_waits_for_the_kills_it_started() {
        let source = include_str!("pty.rs");
        let body = source
            .split("pub fn kill_all_sessions_background")
            .nth(1)
            .expect("the shutdown path exists");
        let body = &body[..body.len().min(2200)];

        assert!(
            body.contains("recv_timeout"),
            "shutdown must wait for the kills: a detached thread dies with the process"
        );
        assert!(
            !body.contains(
                "for session in drained {
                terminate_session"
            ),
            "kills must not run one after another: each waits on taskkill, so the cost adds up"
        );
    }

    #[test]
    fn a_kill_never_runs_while_the_child_lock_is_held() {
        let source = include_str!("pty.rs");
        for (index, _) in source.match_indices("child.lock()") {
            let tail = &source[index..];
            let block_end = tail
                .find(
                    "
    }",
                )
                .unwrap_or(tail.len().min(600));
            let block = &tail[..block_end.min(600)];
            assert!(
                !block.contains("kill_process_tree("),
                "a child lock is held across kill_process_tree near byte {index};                  read the pid, release the lock, then kill"
            );
        }
    }

    /// The snapshot paths run under the global session lock, so they must never wait on a child.
    #[test]
    fn telemetry_never_waits_on_a_child_lock() {
        let source = include_str!("pty.rs");
        let snapshot = source
            .split("fn list_pty_processes")
            .nth(1)
            .expect("list_pty_processes exists");
        let body = &snapshot[..snapshot.len().min(2000)];
        assert!(
            !body.contains(
                ".child
                        .lock()"
            ),
            "the process snapshot must use try_lock: it holds the lock every keystroke needs"
        );
    }

    #[test]
    fn scrollback_cap_keeps_long_agent_chats() {
        assert!(SCROLLBACK_CAP_BYTES >= 4 * 1024 * 1024);
    }

    #[test]
    fn clearing_a_full_scrollback_releases_all_buffered_content() {
        let initial = VecDeque::from(vec![b'x'; SCROLLBACK_CAP_BYTES]);
        let mut buffer = ScrollbackBuffer::new(initial);
        buffer.pending = vec![b'y'; 256 * 1024];
        buffer.dirty = true;

        reset_scrollback_buffer(&mut buffer);

        assert!(buffer.data.is_empty());
        assert!(buffer.pending.is_empty());
        assert!(!buffer.dirty);
    }

    #[test]
    fn valid_utf8_prefix_passes_complete_ascii_and_multibyte() {
        assert_eq!(valid_utf8_prefix_len(b"hello"), 5);

        let cafe = "café".as_bytes();
        assert_eq!(valid_utf8_prefix_len(cafe), cafe.len());
        // Box-drawing "─" (3 bytes) completo.
        let line = "─".as_bytes();
        assert_eq!(valid_utf8_prefix_len(line), 3);
    }

    #[test]
    fn valid_utf8_prefix_stops_before_split_multibyte() {
        assert_eq!(valid_utf8_prefix_len(&[0xC3]), 0);

        assert_eq!(valid_utf8_prefix_len(&[b'a', 0xC3]), 1);

        let grin = "😀".as_bytes();
        assert_eq!(valid_utf8_prefix_len(&grin[..2]), 0);
    }

    #[test]
    fn activity_emit_due_fires_immediately_on_first_call() {
        assert!(activity_emit_due(None, PTY_ACTIVITY_EMIT_INTERVAL_MS));
    }

    #[test]
    fn activity_emit_due_throttles_until_interval_elapses() {
        let just_emitted = Instant::now();
        assert!(!activity_emit_due(
            Some(just_emitted),
            PTY_ACTIVITY_EMIT_INTERVAL_MS
        ));

        let stale =
            Instant::now() - Duration::from_millis(PTY_ACTIVITY_EMIT_INTERVAL_MS as u64 + 1);
        assert!(activity_emit_due(
            Some(stale),
            PTY_ACTIVITY_EMIT_INTERVAL_MS
        ));
    }

    #[test]
    fn valid_utf8_prefix_carry_reassembles_split_char() {
        let full = "xé".as_bytes(); // [b'x', 0xC3, 0xA9]
        let first = &full[..2]; // "x" + 0xC3
        let valid = valid_utf8_prefix_len(first);
        assert_eq!(valid, 1);

        let mut carry = first[valid..].to_vec();
        carry.extend_from_slice(&full[2..]); // + 0xA9
        assert_eq!(valid_utf8_prefix_len(&carry), carry.len());
    }
}
