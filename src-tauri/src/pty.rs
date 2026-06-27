use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use crate::cli_resolver::{command_builder_for_terminal, find_windows_cli_launcher};
use crate::diagnostics::append_spawn_log;
use crate::paths::{scrollback_dir, scrollback_path};

pub const SCROLLBACK_CAP_BYTES: usize = 4 * 1024 * 1024;
pub const SCROLLBACK_FLUSH_INTERVAL_MS: u128 = 250;

pub struct ScrollbackBuffer {
    pub data: VecDeque<u8>,
    pub last_flush: Instant,
    pub dirty: bool,
}

impl ScrollbackBuffer {
    pub fn new(initial: VecDeque<u8>) -> Self {
        Self {
            data: initial,
            last_flush: Instant::now(),
            dirty: false,
        }
    }
}

/// Quantos bytes do início de `buf` formam UTF-8 válido. O resto (0–3 bytes) é
/// a cauda de um caractere multibyte que o `read()` do PTY partiu no limite do
/// buffer — esses bytes esperam a próxima leitura pra não virarem `�`.
fn valid_utf8_prefix_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(s) => s.len(),
        Err(error) => error.valid_up_to(),
    }
}

pub struct PtySession {
    pub master: Box<dyn MasterPty + Send>,
    // writer fica em Arc<Mutex> pra write_pty poder soltar o lock global de
    // sessions antes de escrever. Sem isso, escritas longas de um PTY bloqueiam
    // qualquer outra operacao (resize, attach, kill) em todos os outros PTYs.
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
    pub command: Option<String>,
    pub cwd: Option<String>,
}

pub type PtySessions = Arc<Mutex<HashMap<String, PtySession>>>;

#[derive(Serialize)]
pub struct SpawnPtyResponse {
    pub id: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    code: Option<i32>,
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
pub fn spawn_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    cols: u16,
    rows: u16,
    id: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    // launcher_override: path absoluto que supersede o auto-detect. Frontend
    // passa quando o user configurou um path manual via cliPaths.
    launcher_override: Option<String>,
    // env extra só deste PTY (ex.: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 no
    // canvas) — nunca polui o ambiente global nem outros terminais.
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<SpawnPtyResponse, String> {
    let extras: Vec<String> = extra_args.unwrap_or_default();
    let spawn_started = Instant::now();
    let id = id.unwrap_or_else(|| nanoid::nanoid!());
    let requested_command = command.clone();

    let mut sessions_guard = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if sessions_guard.contains_key(&id) {
        return Ok(SpawnPtyResponse { id });
    }

    let scrollback = Arc::new(Mutex::new(ScrollbackBuffer::new(load_scrollback(
        &app, &id,
    )?)));
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
    //    direto — só validando que existe pra evitar PathBuf vazio fantasma.
    // 2. Senão, auto-detect via find_windows_cli_launcher.
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
            command.cwd(cwd_value);
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
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|error| error.to_string())?,
    ));
    let event_name = format!("pty://data/{id}");
    let exit_event_name = format!("pty://exit/{id}");
    let event_app = app.clone();
    let scrollback_app = app.clone();
    let scrollback_id = id.clone();
    let thread_scrollback = Arc::clone(&scrollback);
    let thread_child = Arc::clone(&child);
    let thread_sessions = Arc::clone(sessions.inner());
    let initial_warning = cwd_warning.clone();

    thread::spawn(move || {
        // 32 KiB: menos syscalls e menos eventos IPC sob saída pesada (builds,
        // cat de arquivo grande) sem custo de latência pra outputs pequenos.
        let mut buffer = [0_u8; 32 * 1024];
        // Cauda de um caractere UTF-8 multibyte partido entre duas leituras.
        let mut carry: Vec<u8> = Vec::new();

        if let Some(warning) = initial_warning {
            let _ = event_app.emit(&event_name, &warning);
            let _ = push_scrollback(
                &scrollback_app,
                &scrollback_id,
                &thread_scrollback,
                warning.as_bytes(),
            );
        }

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    // Scrollback recebe os bytes crus desta leitura (sempre
                    // corretos — só o emit precisa de fronteira de caractere).
                    let _ = push_scrollback(
                        &scrollback_app,
                        &scrollback_id,
                        &thread_scrollback,
                        &buffer[..count],
                    );

                    // Emit PRIMEIRO o que é UTF-8 completo — user vê o echo na
                    // hora, sem disk I/O no caminho da tecla. Caractere partido
                    // no limite do read fica em `carry` pro próximo ciclo.
                    if carry.is_empty() {
                        // Caminho rápido (caso comum): nada pendente, zero alloc.
                        let valid = valid_utf8_prefix_len(&buffer[..count]);
                        if valid > 0 {
                            // SAFETY: buffer[..valid] é UTF-8 válido por construção.
                            let text = unsafe { std::str::from_utf8_unchecked(&buffer[..valid]) };
                            let _ = event_app.emit(&event_name, text);
                        }
                        if valid < count {
                            carry.extend_from_slice(&buffer[valid..count]);
                        }
                    } else {
                        carry.extend_from_slice(&buffer[..count]);
                        let valid = valid_utf8_prefix_len(&carry);
                        if valid > 0 {
                            // SAFETY: carry[..valid] é UTF-8 válido por construção.
                            let text = unsafe { std::str::from_utf8_unchecked(&carry[..valid]) };
                            let _ = event_app.emit(&event_name, text);
                            carry.drain(..valid);
                        }
                    }

                    // `carry` só deve guardar a cauda de UM caractere (≤3 bytes).
                    // Se passar disso, são bytes inválidos que nunca completam:
                    // emite lossy (mostra �) e zera pra não vazar nem travar.
                    if carry.len() > 3 {
                        let lossy = String::from_utf8_lossy(&carry).into_owned();
                        let _ = event_app.emit(&event_name, lossy.as_str());
                        carry.clear();
                    }
                }
                Err(_) => break,
            }
        }

        // Flush de qualquer cauda restante no fim do stream.
        if !carry.is_empty() {
            let lossy = String::from_utf8_lossy(&carry).into_owned();
            let _ = event_app.emit(&event_name, lossy.as_str());
        }

        // PTY morreu: garante o scrollback no disco e LIBERA o buffer em RAM (até
        // 4 MiB). A sessão fica no HashMap; attach_pty recarrega do disco se preciso.
        // Só libera se o flush deu certo, pra nunca perder dados não persistidos.
        if flush_scrollback(&scrollback_app, &scrollback_id, &thread_scrollback).is_ok() {
            if let Ok(mut buffer) = thread_scrollback.lock() {
                buffer.data = VecDeque::new();
                buffer.dirty = false;
            }
        }

        let code = thread_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);
        let _ = event_app.emit(&exit_event_name, PtyExitPayload { code });

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
        master: pair.master,
        writer,
        child,
        scrollback,
        command: requested_command,
        cwd,
    };

    sessions_guard.insert(id.clone(), session);

    Ok(SpawnPtyResponse { id })
}

/// Mata a árvore de processos inteira (o filho direto + todos os descendentes) a
/// partir do PID. `portable_pty::Child::kill()` no Windows só mata o processo
/// direto (o shell/ConPTY) — `node`/`claude`/`codex` e seus filhos (MCP, workers)
/// ficam órfãos, vazando processos e RAM a cada close/restart. `taskkill /F /T`
/// derruba a árvore toda. Deve ser chamado ANTES de `child.kill()` (com o pai
/// ainda vivo, senão a travessia da árvore não encontra os netos reparentados).
#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn kill_process_tree(_pid: u32) {}

#[tauri::command]
pub fn restart_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    command: Option<String>,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<SpawnPtyResponse, String> {
    {
        let mut sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        if let Some(session) = sessions.remove(&id) {
            if let Ok(mut child) = session.child.lock() {
                if let Some(pid) = child.process_id() {
                    kill_process_tree(pid);
                }
                let _ = child.kill();
            }
        }
    }

    delete_scrollback(&app, &id)?;
    spawn_pty(
        app,
        sessions,
        80,
        24,
        Some(id),
        command,
        cwd,
        extra_args,
        None,
        None,
    )
}

#[tauri::command]
pub fn attach_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let max_bytes = max_bytes.unwrap_or(512 * 1024).max(16 * 1024);

    // Caminho comum: serve do buffer em memória.
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
            // make_contiguous + slice evita a cópia extra do iter().skip().collect().
            let slice = buffer.data.make_contiguous();
            let start = slice.len().saturating_sub(max_bytes);
                return Ok(String::from_utf8_lossy(&slice[start..]).into_owned());
            }
        }
    }

    // Buffer vazio: PTY recém-criado (sem output) ou PTY morto cujo buffer foi
    // liberado. Em ambos os casos o disco tem a verdade (vazio ou o scrollback final).
    let disk = load_scrollback(&app, &id)?;
    let bytes: Vec<u8> = disk.into_iter().collect();
    let start = bytes.len().saturating_sub(max_bytes);
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

#[tauri::command]
pub fn write_pty(sessions: State<'_, PtySessions>, id: String, data: String) -> Result<(), String> {
    // Pega o handle do writer e SOLTA o lock global de sessions antes de
    // escrever. Escrita pode bloquear no PTY (buffer cheio); se segurassemos o
    // lock, qualquer attach/resize/kill/spawn em outro PTY ficaria parado.
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
}

#[tauri::command]
pub fn resize_pty(
    sessions: State<'_, PtySessions>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("PTY not found: {id}"))?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn kill_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
) -> Result<(), String> {
    let mut sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;

    if let Some(session) = sessions.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            if let Some(pid) = child.process_id() {
                kill_process_tree(pid);
            }
            let _ = child.kill();
        }
    }

    delete_scrollback(&app, &id)?;
    Ok(())
}

#[tauri::command]
pub fn get_pty_cwd(sessions: State<'_, PtySessions>, id: String) -> Option<String> {
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
}

#[tauri::command]
pub fn list_pty_processes(sessions: State<'_, PtySessions>) -> Vec<PtyProcessSnapshot> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let raw = {
        let Ok(sessions) = sessions.lock() else {
            return Vec::new();
        };
        sessions
            .iter()
            .map(|(id, session)| {
                let pid = session.child.lock().ok().and_then(|child| child.process_id());
                (id.clone(), pid, session.command.clone(), session.cwd.clone())
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
            let process_name = process.map(|process| process.name().to_string_lossy().to_string());
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

/// Writer global de scrollback: uma única thread em background recebe
/// `(path, bytes)` e escreve. Evita spawnar uma thread a cada flush (250ms por
/// PTY ativo). Vive pela vida do processo — sem teardown por PTY, sem vazar thread.
fn scrollback_writer() -> &'static std::sync::mpsc::Sender<(PathBuf, Vec<u8>)> {
    static WRITER: std::sync::OnceLock<std::sync::mpsc::Sender<(PathBuf, Vec<u8>)>> =
        std::sync::OnceLock::new();
    WRITER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<(PathBuf, Vec<u8>)>();
        thread::spawn(move || {
            while let Ok((path, bytes)) = rx.recv() {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(&path, &bytes);
            }
        });
        tx
    })
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
    // Drena de uma vez em vez de pop_front em loop (uma operação vs N).
    if buffer.data.len() > SCROLLBACK_CAP_BYTES {
        let excess = buffer.data.len() - SCROLLBACK_CAP_BYTES;
        buffer.data.drain(..excess);
    }
    buffer.dirty = true;

    if buffer.last_flush.elapsed().as_millis() < SCROLLBACK_FLUSH_INTERVAL_MS {
        return Ok(());
    }

    // make_contiguous evita a cópia de 256KB que `iter().copied().collect()` fazia.
    // Também encolhe a capacity se VecDeque ficou superdimensionado depois de drains.
    let slice = buffer.data.make_contiguous();
    let bytes = slice.to_vec();
    if buffer.data.capacity() > SCROLLBACK_CAP_BYTES * 2 {
        buffer.data.shrink_to(SCROLLBACK_CAP_BYTES);
    }
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    // Disk write em thread separada — segurar o reader thread aqui causava
    // latência visível de digitação (10-50ms por flush no Windows) propagando
    // pra TODOS os terminais com qualquer atividade.
    let path = scrollback_path(app, id)?;
    // Envia pro writer global em vez de spawnar uma thread por flush.
    let _ = scrollback_writer().send((path, bytes));
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
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    let path = scrollback_path(app, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

pub fn delete_scrollback(app: &AppHandle, id: &str) -> Result<(), String> {
    let path = scrollback_path(app, id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    let _ = scrollback_dir(app);
    Ok(())
}

/// Remove `.bin` órfãos — scrollback de terminais que não existem mais no
/// projects.json. Roda no startup, ANTES de qualquer spawn (sem corrida).
/// Conservador: só apaga se o id NÃO aparecer em nenhum lugar do texto do
/// projects.json (ids são nanoids; colisão com texto não-relacionado é
/// improvável). Se o projects.json não puder ser lido, não apaga nada.
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
    // Vazio = sem projects.json legível → melhor não arriscar apagar nada.
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

pub fn kill_all_sessions(sessions: &PtySessions) {
    let drained = sessions
        .lock()
        .ok()
        .map(|mut sessions| sessions.drain().map(|(_, session)| session).collect::<Vec<_>>())
        .unwrap_or_default();

    for session in drained {
        if let Ok(mut child) = session.child.lock() {
            if let Some(pid) = child.process_id() {
                kill_process_tree(pid);
            }
            let _ = child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_cap_keeps_long_agent_chats() {
        assert!(SCROLLBACK_CAP_BYTES >= 4 * 1024 * 1024);
    }

    #[test]
    fn valid_utf8_prefix_passes_complete_ascii_and_multibyte() {
        assert_eq!(valid_utf8_prefix_len(b"hello"), 5);
        // "café" — o "é" são 2 bytes (0xC3 0xA9), todos presentes.
        let cafe = "café".as_bytes();
        assert_eq!(valid_utf8_prefix_len(cafe), cafe.len());
        // Box-drawing "─" (3 bytes) completo.
        let line = "─".as_bytes();
        assert_eq!(valid_utf8_prefix_len(line), 3);
    }

    #[test]
    fn valid_utf8_prefix_stops_before_split_multibyte() {
        // Primeiro byte de "é" sozinho (read partiu aqui) → 0 bytes válidos.
        assert_eq!(valid_utf8_prefix_len(&[0xC3]), 0);
        // "a" + primeiro byte de "é" → só o "a" é válido.
        assert_eq!(valid_utf8_prefix_len(&[b'a', 0xC3]), 1);
        // Emoji 😀 (4 bytes) com só os 2 primeiros → 0 válidos.
        let grin = "😀".as_bytes();
        assert_eq!(valid_utf8_prefix_len(&grin[..2]), 0);
    }

    #[test]
    fn valid_utf8_prefix_carry_reassembles_split_char() {
        // Simula o split: "x" + "é" partido entre dois reads.
        let full = "xé".as_bytes(); // [b'x', 0xC3, 0xA9]
        let first = &full[..2]; // "x" + 0xC3
        let valid = valid_utf8_prefix_len(first);
        assert_eq!(valid, 1); // só "x" emitido
        // carry = [0xC3]; chega o resto do próximo read.
        let mut carry = first[valid..].to_vec();
        carry.extend_from_slice(&full[2..]); // + 0xA9
        assert_eq!(valid_utf8_prefix_len(&carry), carry.len()); // "é" completo
    }
}
