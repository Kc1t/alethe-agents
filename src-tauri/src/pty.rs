use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

use crate::cli_resolver::{command_builder_for_terminal, find_windows_cli_launcher};
use crate::diagnostics::append_spawn_log_path;
use crate::paths::scrollback_dir;
use crate::process_tree;
use crate::provider_common::now_ms;
use crate::pty_sink::{PtyOutputSink, TauriSink};

pub const SCROLLBACK_CAP_BYTES: usize = 4 * 1024 * 1024;
pub const SCROLLBACK_FLUSH_INTERVAL_MS: u128 = 250;
/// Acima disso o `.bin` (append-only) é compactado pra cauda de
/// `SCROLLBACK_CAP_BYTES`. 2× o cap = ~2× de write-amplification amortizada
/// sobre a saída real, e no máximo ~8 MB por terminal em disco.
pub const SCROLLBACK_COMPACT_BYTES: u64 = SCROLLBACK_CAP_BYTES as u64 * 2;
/// Cadência do canal `pty://activity/{id}` enquanto o painel está invisível —
/// baixa o suficiente pra não pesar na main thread do webview, alta o
/// suficiente pra `AgentCompletionMonitor` (RESPONSE_IDLE_MS=4500 no frontend)
/// detectar "agente terminou" com folga mesmo em background.
pub const PTY_ACTIVITY_EMIT_INTERVAL_MS: u128 = 450;
const TEARDOWN_NORMAL: u8 = 0;
const TEARDOWN_KILLED: u8 = 1;
const TEARDOWN_SUSPENDED: u8 = 2;
const TEARDOWN_RESTARTED: u8 = 3;

/// RAM livre mínima (do SISTEMA, não só do que o Alethe gerencia) exigida
/// antes de tentar o boot de um agente novo. Sem isso, um boot com o sistema
/// já no limite deixa o PRÓPRIO processo do agente (Node/WebKit/etc.) nascer
/// sem memória suficiente e se matar sozinho assim que tenta alocar (visto ao
/// vivo: crash "MemoryExhaustion" do JavaScriptCore) — algo que o Alethe não
/// tem como evitar DEPOIS que o processo já nasceu, porque não controla o
/// alocador interno dele. O `ResourceSupervisor` (resources.rs) só enxerga a
/// memória dos processos que o próprio Alethe já gerencia, não a RAM livre
/// real do Windows — por isso esse gate é separado e roda sempre, mesmo com o
/// supervisor no modo manual.
const SPAWN_MIN_AVAILABLE_MB: f64 = 400.0;
const SPAWN_MEMORY_WAIT_POLL_MS: u64 = 1_000;
/// Teto de espera: depois disso tenta o boot mesmo sem folga confirmada — é
/// melhor arriscar um crash raro do que travar o usuário pra sempre esperando
/// uma liberação de RAM que pode nunca vir (ex.: outro processo com vazamento
/// real, não uma pressão passageira).
const SPAWN_MEMORY_WAIT_MAX_MS: u128 = 45_000;

/// Espera a RAM livre do sistema ter uma folga mínima antes de deixar o
/// chamador prosseguir com o boot real do processo. Depois que o agente já
/// nasceu com folga, o consumo contínuo dele é responsabilidade do próprio
/// provider (Claude/Codex/OpenCode já gerenciam sua própria memória em
/// runtime) — este gate protege só o MOMENTO do boot, nunca o funcionamento
/// depois.
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

// DESATIVADO (não removido, pra não perder o raciocínio): a ideia original
// era um "colchão" de RAM que o Alethe ia comprometendo aos poucos em segundo
// plano (só quando sobrava RAM FÍSICA livre) e soltava bem antes de cada
// boot, pra aumentar a chance da memória recém-liberada ir pro processo
// novo. Descartada depois de um crash real ao vivo: `sysinfo::available_memory()`
// só enxerga RAM física livre, nunca o LIMITE DE COMMIT do Windows (RAM +
// paginação somados) — e nesse teste o commit já estava em 39.7 de 45.5 GB
// (~5.8 GB de folga) enquanto a RAM "livre" parecia OK. Comprometer de
// propósito até 400 MB extras num sistema já perto do limite de commit é
// exatamente o tipo de coisa que pode estourar esse limite e causar um crash
// pior do que o que o mecanismo tentava evitar — o oposto da intenção. Uma
// versão futura precisaria checar o commit real (`GetPerformanceInfo` do
// Windows, via a crate `windows`) antes de comprometer qualquer coisa, não
// só a RAM física. Até lá, `wait_for_spawnable_memory` sozinha é a escolha
// seguro: só LÊ o estado, nunca aloca nada de propósito.
fn prepare_memory_for_boot() {
    wait_for_spawnable_memory();
}

pub struct ScrollbackBuffer {
    pub data: VecDeque<u8>,
    pub cursor: u64,
    pub last_flush: Instant,
    pub dirty: bool,
    /// Bytes novos ainda não escritos em disco. O flush faz APPEND só disto —
    /// não reescreve os 4 MB do anel. Sem isso, um spinner (poucos bytes/s)
    /// forçava um rewrite de 4 MB a cada 250ms (~16 MB/s por terminal ativo).
    pub pending: Vec<u8>,
}

impl ScrollbackBuffer {
    pub fn new(initial: VecDeque<u8>) -> Self {
        let cursor = initial.len() as u64;
        Self {
            data: initial,
            cursor,
            last_flush: Instant::now(),
            dirty: false,
            pending: Vec::new(),
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

/// Avança `start` até o próximo byte que inicia um caractere UTF-8 (ou até o
/// fim do slice), evitando cortar no meio de uma sequência multibyte quando
/// `start` foi escolhido só por contagem de bytes (ex.: truncar scrollback
/// pelos últimos N bytes em `attach_pty`). Bytes de continuação UTF-8 sempre
/// têm os dois bits mais altos como `10`; sem isso, um corte no meio de um
/// acento (ex.: "ã" = 2 bytes) sobra um byte órfão que vira `U+FFFD` no
/// `from_utf8_lossy` seguinte.
pub(crate) fn align_to_char_boundary(slice: &[u8], start: usize) -> usize {
    let mut start = start.min(slice.len());
    while start < slice.len() && (slice[start] & 0xC0) == 0x80 {
        start += 1;
    }
    start
}

/// `ALETHE_PTY_DEBUG=1` liga uma timeline de timestamps (spawn → primeiro
/// output real → resize → nudge de redesenho) em `spawn.log`, pro
/// procedimento de diagnóstico da área principal do OpenCode renderizando
/// em branco (ver docs/CHANGELOG.md e o plano de investigação). Mesmo
/// padrão de `ALETHE_E2E`/`ALETHE_GHOSTTY_PROBE` já usado no projeto — sem
/// a variável, zero custo extra (só a checagem do env var).
fn pty_debug_enabled() -> bool {
    std::env::var("ALETHE_PTY_DEBUG").as_deref() == Ok("1")
}

/// Decide se o canal `pty://activity/{id}` (painel invisível) já pode emitir
/// de novo. `None` = nunca emitiu ainda (primeiro lote invisível passa na
/// hora, sem esperar o intervalo).
fn activity_emit_due(last_activity_emit: Option<Instant>, interval_ms: u128) -> bool {
    match last_activity_emit {
        None => true,
        Some(last) => last.elapsed().as_millis() >= interval_ms,
    }
}

pub struct PtySession {
    pub pty_id: String,
    /// Stable profile ownership captured when the PTY is spawned.
    pub profile_id: String,
    /// Stable storage namespace captured when the PTY is spawned.
    pub scrollback_path: PathBuf,
    // Arc<Mutex> pelo mesmo motivo do writer (comentário abaixo): resize_pty
    // precisa poder clonar o handle e soltar o lock global de sessions antes
    // de chamar master.resize (ConPTY pode travar) sem prender kill/write/
    // attach de todos os outros PTYs atrás dele.
    // `Option` (em vez de só `Box<...>`) porque `suspend_session` precisa
    // conseguir fechar o pseudoconsole de verdade (`.take()`, dropando o
    // Box) ANTES de esperar o reader terminar — no ConPTY do Windows, matar
    // o processo filho não fecha o pipe de saída sozinho; só dropar o master
    // faz isso, e a sessão continua existindo no mapa (com master já `None`)
    // até o fim da suspensão, então write_pty/resize_pty continuam achando
    // a sessão (e falhando com erro real) em vez de "PTY not found".
    pub master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    // writer fica em Arc<Mutex> pra write_pty poder soltar o lock global de
    // sessions antes de escrever. Sem isso, escritas longas de um PTY bloqueiam
    // qualquer outra operacao (resize, attach, kill) em todos os outros PTYs.
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    pub scrollback: Arc<Mutex<ScrollbackBuffer>>,
    /// Sinaliza que o reader terminou de persistir a cauda final. Suspensão
    /// espera esta barreira antes de permitir que o mesmo id seja retomado.
    pub reader_done: Arc<(Mutex<Option<bool>>, Condvar)>,
    /// Motivo do teardown. Kill/restart pulam o flush final; suspend espera o
    /// flush final do reader antes de permitir a retomada do mesmo `ptyId`.
    pub teardown: Arc<AtomicU8>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub read_active: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    /// Visibilidade lógica do painel no frontend (aba/grupo ativo, não
    /// colapsado). NÃO pausa a leitura do PTY (isso travaria o `write()` do
    /// agente) — só decide se o coalescer manda o lote pro canal `data`
    /// (render caro) ou pro `activity` (throttlado, só recordIo/completion).
    pub visible: Arc<AtomicBool>,
    /// Timestamp (ms) do último nudge de redesenho (Ctrl+L) mandado pro
    /// processo, disparado tanto no boot (primeiro output real do processo)
    /// quanto em `resize_pty` — pra provedores cujo `RedrawNudgeConfig`
    /// liga isso (ver `redraw_nudge_config`). Os dois gatilhos podem cair
    /// quase juntos — sem coordenação, dois redesenhos concorrentes se
    /// sobrepunham na tela em vez de um substituir o outro (texto/blocos de
    /// um redraw colidindo com o outro), confirmado analisando os bytes
    /// crus do scrollback do OpenCode. `try_claim_redraw_nudge` garante só
    /// um disparo por janela curta, não importa qual gatilho chegou primeiro.
    pub redraw_nudge_lock: Arc<AtomicU64>,
    /// Tamanho de grade (cols x rows) atualmente aplicado ao PTY compartilhado
    /// — a fonte de verdade que um cliente recém-anexado consulta antes de
    /// decidir se vai reivindicar controle de resize (ver `get_pty_size_core`).
    pub cols: Arc<AtomicU16>,
    pub rows: Arc<AtomicU16>,
}

const REDRAW_NUDGE_COOLDOWN_MS: u64 = 400;

/// CAS simples: só concede o nudge se a última tentativa (de QUALQUER
/// gatilho) foi há mais de `REDRAW_NUDGE_COOLDOWN_MS`. `Ordering::SeqCst`
/// por segurança — não é um caminho quente o suficiente pra valer a pena
/// relaxar.
fn try_claim_redraw_nudge(lock: &AtomicU64) -> bool {
    let now = now_ms();
    let last = lock.load(Ordering::SeqCst);
    if now.saturating_sub(last) < REDRAW_NUDGE_COOLDOWN_MS {
        return false;
    }
    lock.compare_exchange(last, now, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Nudge de redesenho (Ctrl+L forçado) por provedor. Alguns TUIs não
/// repintam sozinhos em SIGWINCH/resize; nem todo CLI quer ou tolera
/// receber um Ctrl+L injetado, então isto é opt-in por provedor — nunca
/// ligado por padrão. Chave = string literal de `command`/
/// `requested_command`, o mesmo valor que `agentCliCommand()` manda do
/// frontend (`src/lib/types.ts`) — CUIDADO: pro Antigravity isso é `"agy"`,
/// não `"antigravity"`.
#[derive(Clone, Copy)]
struct RedrawNudgeConfig {
    /// Nudge ~150ms após o primeiro lote de saída real do processo (boot).
    boot: bool,
    /// Nudge ~50ms após `master.resize()` (resize).
    resize: bool,
}

const NO_REDRAW_NUDGE: RedrawNudgeConfig = RedrawNudgeConfig {
    boot: false,
    resize: false,
};

/// Só o OpenCode tem evidência confirmada de precisar disto hoje (bug
/// conhecido do opentui, anomalyco/opencode#3697). claude/codex/agy/mimo/
/// freebuff ficam de fora até alguém confirmar o mesmo problema pra eles —
/// adicionar suporte é só acrescentar uma entrada aqui.
const REDRAW_NUDGE_CONFIG: &[(&str, RedrawNudgeConfig)] = &[(
    "opencode",
    RedrawNudgeConfig {
        boot: true,
        resize: true,
    },
)];

fn redraw_nudge_config(command: Option<&str>) -> RedrawNudgeConfig {
    command
        .and_then(|c| REDRAW_NUDGE_CONFIG.iter().find(|(key, _)| *key == c))
        .map(|(_, cfg)| *cfg)
        .unwrap_or(NO_REDRAW_NUDGE)
}

pub type PtySessions = Arc<Mutex<HashMap<String, PtySession>>>;

pub fn global_pty_sessions() -> &'static PtySessions {
    static SESSIONS: OnceLock<PtySessions> = OnceLock::new();
    SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

#[cfg(windows)]
static PTY_JOB_HANDLE: OnceLock<isize> = OnceLock::new();

/// Coordena somente spawns do MESMO id. O mutex de `PtySessions` não pode
/// permanecer travado durante `openpty`/resolução/spawn do processo: isso
/// serializava todos os terminais apesar da fila do frontend permitir paralelismo.
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

fn reserve_spawn(
    sessions: &PtySessions,
    id: &str,
    expected_profile_id: &str,
    expected_scrollback_path: &Path,
) -> Result<Option<SpawnReservation>, String> {
    let (spawning, ready) =
        SPAWN_COORDINATOR.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()));
    let mut ids = spawning
        .lock()
        .map_err(|_| "PTY spawn coordinator lock poisoned".to_string())?;

    loop {
        {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(id) {
                if !pty_owner_matches(
                    &session.profile_id,
                    &session.scrollback_path,
                    expected_profile_id,
                    expected_scrollback_path,
                ) {
                    return Err(format!("PTY belongs to a different profile: {id}"));
                }
                return Ok(None);
            }
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

#[derive(Clone, Serialize)]
pub struct PtyResizedPayload {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPtyArgs {
    pub cols: u16,
    pub rows: u16,
    pub id: Option<String>,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub extra_args: Option<Vec<String>>,
    pub launcher_override: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub profile_id: String,
}

pub fn pty_exists_core(sessions: &PtySessions, id: &str) -> bool {
    let Ok(sessions) = sessions.lock() else {
        return false;
    };
    sessions.contains_key(id)
}

fn pty_owner_matches(
    session_profile_id: &str,
    session_scrollback_path: &Path,
    expected_profile_id: &str,
    expected_scrollback_path: &Path,
) -> bool {
    session_profile_id == expected_profile_id && session_scrollback_path == expected_scrollback_path
}

pub fn ensure_pty_owner(
    sessions: &PtySessions,
    id: &str,
    expected_profile_id: &str,
    expected_scrollback_path: &Path,
) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if let Some(session) = sessions.get(id) {
        if !pty_owner_matches(
            &session.profile_id,
            &session.scrollback_path,
            expected_profile_id,
            expected_scrollback_path,
        ) {
            return Err(format!("PTY belongs to a different profile: {id}"));
        }
    }
    Ok(())
}

fn resolve_pty_profile_paths(
    app: &AppHandle,
    requested_profile_id: Option<&str>,
    id: &str,
) -> Result<(String, PathBuf, PathBuf), String> {
    validate_pty_id(id)?;
    let data_root = crate::profiles::resolve_tauri_data_root(app)?;
    let index = crate::profiles::ensure_profiles_index_at(&data_root)?;
    let profile_id = requested_profile_id
        .unwrap_or(&index.active_profile_id)
        .to_string();
    let profile_dir =
        crate::profiles::profile_dir_for_id_in_index(&data_root, &index, &profile_id)?;
    Ok((
        profile_id,
        profile_dir.join("scrollback").join(format!("{id}.bin")),
        profile_dir.join("spawn.log"),
    ))
}

fn validate_pty_profile(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let data_root = crate::profiles::resolve_tauri_data_root(app)?;
    let index = crate::profiles::ensure_profiles_index_at(&data_root)?;
    crate::profiles::profile_dir_for_id_in_index(&data_root, &index, profile_id)?;
    Ok(())
}

pub(crate) fn owned_pty_root_pid(
    sessions: &PtySessions,
    id: &str,
    profile_id: &str,
    scrollback_path: &Path,
) -> Result<Option<u32>, String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    let session = sessions
        .get(id)
        .ok_or_else(|| format!("PTY not found: {id}"))?;
    if !pty_owner_matches(
        &session.profile_id,
        &session.scrollback_path,
        profile_id,
        scrollback_path,
    ) {
        return Err(format!("PTY belongs to a different profile: {id}"));
    }
    session
        .child
        .lock()
        .map_err(|_| "PTY child lock poisoned".to_string())
        .map(|child| child.process_id())
}

pub(crate) fn owned_pty_root_pid_for_profile(
    app: &AppHandle,
    sessions: &PtySessions,
    id: &str,
    profile_id: &str,
) -> Result<Option<u32>, String> {
    let (profile_id, scrollback_path, _) = resolve_pty_profile_paths(app, Some(profile_id), id)?;
    owned_pty_root_pid(sessions, id, &profile_id, &scrollback_path)
}

#[tauri::command]
pub fn pty_exists(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    profile_id: String,
) -> Result<bool, String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    if ensure_pty_owner(&sessions, &id, &profile_id, &expected).is_err() {
        return Ok(false);
    }
    Ok(pty_exists_core(&sessions, &id))
}

#[derive(Serialize)]
pub struct PtySizeResponse {
    pub cols: u16,
    pub rows: u16,
}

/// Tamanho de grade atualmente aplicado ao PTY compartilhado — consultado por
/// um cliente que está anexando a uma sessão já existente, pra adotar o
/// tamanho vigente em vez de brigar por um novo (ver `applyRemoteResize` no
/// frontend).
pub fn get_pty_size_core(
    sessions: &PtySessions,
    id: &str,
    expected_profile_id: &str,
    expected_scrollback_path: &Path,
) -> Result<(u16, u16), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    let session = sessions
        .get(id)
        .ok_or_else(|| format!("PTY not found: {id}"))?;
    if !pty_owner_matches(
        &session.profile_id,
        &session.scrollback_path,
        expected_profile_id,
        expected_scrollback_path,
    ) {
        return Err(format!("PTY belongs to a different profile: {id}"));
    }
    Ok((
        session.cols.load(Ordering::Relaxed),
        session.rows.load(Ordering::Relaxed),
    ))
}

#[tauri::command]
pub fn get_pty_size(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    profile_id: String,
) -> Result<PtySizeResponse, String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    let (cols, rows) = get_pty_size_core(&sessions, &id, &profile_id, &expected)?;
    Ok(PtySizeResponse { cols, rows })
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

#[derive(Serialize)]
pub struct PtyScrollbackSnapshot {
    pub content: String,
    pub cursor: u64,
}

pub fn validate_pty_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("PTY ID must contain only ASCII letters, digits, '-' or '_'".to_string());
    }
    Ok(())
}

pub async fn spawn_pty_core(
    sessions: PtySessions,
    sink: Arc<dyn PtyOutputSink>,
    remote: Arc<crate::remote::RemoteHub>,
    spawn_log_path_buf: Option<PathBuf>,
    sb_path_buf: PathBuf,
    args: SpawnPtyArgs,
) -> Result<SpawnPtyResponse, String> {
    tokio::task::spawn_blocking(move || {
        let cols = args.cols;
        let rows = args.rows;
        let id = args.id.unwrap_or_else(|| nanoid::nanoid!());
        let command = args.command;
        let cwd = args.cwd;
        let extra_args = args.extra_args;
        let launcher_override = args.launcher_override;
        let env = args.env;
        let profile_id = args.profile_id;

        let extras: Vec<String> = extra_args.unwrap_or_default();
        let spawn_started = Instant::now();
        let requested_command = command.clone();

        let Some(_spawn_reservation) =
            reserve_spawn(&sessions, &id, &profile_id, &sb_path_buf)?
        else {
            return Ok(SpawnPtyResponse { id });
        };

        prepare_memory_for_boot();

        let scrollback = Arc::new(Mutex::new(ScrollbackBuffer::new(load_scrollback(&sb_path_buf)?)));
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
        let _resolve_ms = resolve_started.elapsed().as_millis();
        let _builder_ms = spawn_started.elapsed().as_millis();
        let _effective_path_preview = command
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
        let _shell_spawn_ms = spawn_started.elapsed().as_millis();
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
        let redraw_nudge_lock = Arc::new(AtomicU64::new(0));
        let nudge_cfg = redraw_nudge_config(requested_command.as_deref());
        let boot_nudge_writer = Arc::clone(&writer);
        let boot_nudge_lock = Arc::clone(&redraw_nudge_lock);
        let debug_log_path = spawn_log_path_buf.clone();
        let debug_id = id.clone();
        let scrollback_path_thread = sb_path_buf.clone();
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
        let remote_hub = remote;
        let thread_sink = sink;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1024);

        tokio::spawn(async move {
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
            let mut activity_pending_cursor = 0_u64;
            let mut last_cursor = thread_scrollback
                .lock()
                .map(|buffer| buffer.cursor)
                .unwrap_or_default();
            const ACTIVITY_PENDING_CAP: usize = 256 * 1024;

            let mut emit_data_or_activity = |text: &str, cursor: u64| {
                remote_hub.publish(
                    serde_json::json!({ "type": "pty_output", "ptyId": &scrollback_id, "text": text }),
                );
                if thread_visible.load(Ordering::Relaxed) {
                    if !activity_pending.is_empty() {
                        activity_pending.clear();
                    }
                    thread_sink.emit_data(&scrollback_id, text, cursor);
                    return;
                }
                activity_pending.push_str(text);
                activity_pending_cursor = cursor;
                if activity_pending.len() > ACTIVITY_PENDING_CAP {
                    let drop_to = activity_pending.len() - ACTIVITY_PENDING_CAP;
                    let boundary = align_to_char_boundary(activity_pending.as_bytes(), drop_to);
                    activity_pending.drain(..boundary);
                }
                if activity_emit_due(last_activity_emit, PTY_ACTIVITY_EMIT_INTERVAL_MS) {
                    thread_sink.emit_activity(
                        &scrollback_id,
                        activity_pending.as_str(),
                        activity_pending_cursor,
                    );
                    activity_pending.clear();
                    last_activity_emit = Some(Instant::now());
                }
            };

            if let Some(warning) = initial_warning {
                last_cursor = push_scrollback(
                    &scrollback_path_thread,
                    &thread_scrollback,
                    warning.as_bytes(),
                )
                .unwrap_or(last_cursor);
                thread_sink.emit_data(&scrollback_id, &warning, last_cursor);
            }

            let mut sent_boot_nudge = false;

            loop {
                let Some(first) = rx.recv().await else { break };
                batch.extend_from_slice(&first);

                if nudge_cfg.boot && !sent_boot_nudge {
                    sent_boot_nudge = true;
                    if pty_debug_enabled() {
                        if let Some(ref path) = debug_log_path {
                            let _ = append_spawn_log_path(
                                path,
                                &format!(
                                    "[pty-debug] {debug_id}: primeiro batch real recebido ({} bytes)",
                                    first.len()
                                ),
                            );
                        }
                    }
                    let nudge_writer = Arc::clone(&boot_nudge_writer);
                    let nudge_lock = Arc::clone(&boot_nudge_lock);
                    let nudge_log_path = debug_log_path.clone();
                    let nudge_debug_id = debug_id.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        let claimed = try_claim_redraw_nudge(&nudge_lock);
                        if pty_debug_enabled() {
                            if let Some(ref path) = nudge_log_path {
                                let _ = append_spawn_log_path(
                                    path,
                                    &format!(
                                        "[pty-debug] {nudge_debug_id}: nudge de boot {} (150ms após 1º batch)",
                                        if claimed { "ENVIADO" } else { "pulado (perdeu a trava)" }
                                    ),
                                );
                            }
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
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }

                let count = batch.len();
                last_cursor = push_scrollback(
                    &scrollback_path_thread,
                    &thread_scrollback,
                    &batch,
                )
                .unwrap_or(last_cursor);

                if carry.is_empty() {
                    let valid = valid_utf8_prefix_len(&batch);
                    if valid > 0 {
                        let text = unsafe { std::str::from_utf8_unchecked(&batch[..valid]) };
                        emit_data_or_activity(text, last_cursor);
                    }
                    if valid < count {
                        carry.extend_from_slice(&batch[valid..]);
                    }
                } else {
                    carry.extend_from_slice(&batch);
                    let valid = valid_utf8_prefix_len(&carry);
                    if valid > 0 {
                        let text = unsafe { std::str::from_utf8_unchecked(&carry[..valid]) };
                        emit_data_or_activity(text, last_cursor);
                        carry.drain(..valid);
                    }
                }

                if carry.len() > 3 {
                    let lossy = String::from_utf8_lossy(&carry).into_owned();
                    emit_data_or_activity(lossy.as_str(), last_cursor);
                    carry.clear();
                }

                batch.clear();

                tokio::time::sleep(Duration::from_millis(2)).await;
            }

            if !carry.is_empty() {
                let lossy = String::from_utf8_lossy(&carry).into_owned();
                thread_sink.emit_data(&scrollback_id, lossy.as_str(), last_cursor);
                remote_hub.publish(serde_json::json!({ "type": "pty_output", "ptyId": &scrollback_id, "text": lossy }));
            }

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
                let flushed = flush_scrollback(&scrollback_path_thread, &thread_scrollback)
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
            thread_sink.emit_exit(&scrollback_id, &PtyExitPayload { code, reason });
            remote_hub.publish(serde_json::json!({ "type": "pty_exit", "ptyId": &scrollback_id, "reason": reason }));

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

        let session = PtySession {
            pty_id: id.clone(),
            profile_id,
            scrollback_path: sb_path_buf,
            child,
            master: Arc::new(Mutex::new(Some(pair.master))),
            writer,
            scrollback,
            reader_done,
            teardown,
            command: requested_command,
            cwd,
            read_active,
            visible,
            redraw_nudge_lock,
            cols: Arc::new(AtomicU16::new(cols.max(1))),
            rows: Arc::new(AtomicU16::new(rows.max(1))),
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
    launcher_override: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    profile_id: String,
) -> Result<SpawnPtyResponse, String> {
    let pty_id = id.clone().unwrap_or_else(|| nanoid::nanoid!());
    let (profile_id, sb_path, spawn_log_path) =
        resolve_pty_profile_paths(&app, Some(&profile_id), &pty_id)?;
    let args = SpawnPtyArgs {
        cols,
        rows,
        id: Some(pty_id),
        command,
        cwd,
        extra_args,
        launcher_override,
        env,
        profile_id,
    };
    spawn_pty_core(
        Arc::clone(sessions.inner()),
        Arc::new(crate::pty_sink::CombinedSink(
            crate::pty_sink::TauriSink(app),
            crate::pty_sink::WebSocketSink,
        )),
        Arc::clone(remote.inner()),
        Some(spawn_log_path),
        sb_path,
        args,
    )
    .await
}

#[cfg(windows)]
pub(crate) fn kill_process_tree(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command.args(["/F", "/T", "/PID", &pid.to_string()]);
    crate::git_control::hide_console(&mut command);
    let _ = command.output();
}

#[cfg(unix)]
pub(crate) fn kill_process_tree(pid: u32) {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    fn send_signal(target: i32, signal: i32) -> bool {
        // POSIX kill accepts a negative PID to address the whole process group.
        unsafe { kill(target, signal) == 0 }
    }

    fn process_alive(pid: u32) -> bool {
        send_signal(pid as i32, 0)
    }

    // portable-pty normally makes the child a process-group leader. Fall back
    // to the root PID if the platform PTY implementation did not do so.
    let group = -(pid as i32);
    if !send_signal(group, 15) {
        let _ = send_signal(pid as i32, 15);
    }

    let deadline = Instant::now() + Duration::from_millis(750);
    while process_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    if process_alive(pid) {
        if !send_signal(group, 9) {
            let _ = send_signal(pid as i32, 9);
        }
    }
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn kill_process_tree(_pid: u32) {}

pub async fn restart_pty_core(
    sessions: PtySessions,
    sink: Arc<dyn PtyOutputSink>,
    remote: Arc<crate::remote::RemoteHub>,
    spawn_log_path_buf: Option<PathBuf>,
    sb_path_buf: PathBuf,
    args: SpawnPtyArgs,
) -> Result<SpawnPtyResponse, String> {
    let kill_sessions = sessions.clone();
    let kill_sb_path = sb_path_buf.clone();
    let kill_id = args.id.clone().unwrap_or_default();
    let kill_profile_id = args.profile_id.clone();
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = kill_sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&kill_id) {
                if !pty_owner_matches(
                    &session.profile_id,
                    &session.scrollback_path,
                    &kill_profile_id,
                    &kill_sb_path,
                ) {
                    return Err(format!("PTY belongs to a different profile: {kill_id}"));
                }
            }
            sessions.remove(&kill_id)
        };
        let owned_scrollback = session
            .as_ref()
            .map(|session| session.scrollback_path.clone())
            .unwrap_or(kill_sb_path);
        if let Some(session) = session {
            session.teardown.store(TEARDOWN_RESTARTED, Ordering::SeqCst);
            terminate_child_tree(&kill_id, &session.child);
        }
        delete_scrollback(&owned_scrollback)
    })
    .await
    .map_err(|error| format!("restart_pty: falha na task bloqueante: {error}"))??;

    spawn_pty_core(
        sessions,
        sink,
        remote,
        spawn_log_path_buf,
        sb_path_buf,
        args,
    )
    .await
}

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
    profile_id: String,
) -> Result<SpawnPtyResponse, String> {
    let (profile_id, sb_path, spawn_log_path) =
        resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    let args = SpawnPtyArgs {
        cols: 80,
        rows: 24,
        id: Some(id),
        command,
        cwd,
        extra_args,
        launcher_override,
        env,
        profile_id,
    };
    restart_pty_core(
        Arc::clone(sessions.inner()),
        Arc::new(crate::pty_sink::CombinedSink(
            crate::pty_sink::TauriSink(app),
            crate::pty_sink::WebSocketSink,
        )),
        Arc::clone(remote.inner()),
        Some(spawn_log_path),
        sb_path,
        args,
    )
    .await
}

pub async fn attach_pty_snapshot_core(
    sessions: &PtySessions,
    sb_path: &Path,
    id: &str,
    max_bytes: usize,
) -> Result<PtyScrollbackSnapshot, String> {
    let sessions: PtySessions = sessions.clone();
    let sb_path_buf = sb_path.to_path_buf();
    let pty_id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let max_bytes = max_bytes.clamp(16 * 1024, SCROLLBACK_CAP_BYTES);

        let session_path = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&pty_id) {
                if session.scrollback_path != sb_path_buf {
                    return Err(format!("PTY belongs to a different profile: {pty_id}"));
                }
                let mut buffer = session
                    .scrollback
                    .lock()
                    .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
                if !buffer.data.is_empty() {
                    let slice = buffer.data.make_contiguous();
                    let start =
                        align_to_char_boundary(slice, slice.len().saturating_sub(max_bytes));
                    return Ok(PtyScrollbackSnapshot {
                        content: String::from_utf8_lossy(&slice[start..]).into_owned(),
                        cursor: buffer.cursor,
                    });
                }
                Some(session.scrollback_path.clone())
            } else {
                None
            }
        };

        let disk = load_scrollback(session_path.as_deref().unwrap_or(&sb_path_buf))?;
        let bytes: Vec<u8> = disk.into_iter().collect();
        let start = align_to_char_boundary(&bytes, bytes.len().saturating_sub(max_bytes));
        Ok(PtyScrollbackSnapshot {
            content: String::from_utf8_lossy(&bytes[start..]).into_owned(),
            cursor: bytes.len() as u64,
        })
    })
    .await
    .map_err(|error| format!("attach_pty: falha na task bloqueante: {error}"))?
}

pub async fn attach_pty_core(
    sessions: &PtySessions,
    sb_path: &Path,
    id: &str,
    max_bytes: usize,
) -> Result<String, String> {
    Ok(attach_pty_snapshot_core(sessions, sb_path, id, max_bytes)
        .await?
        .content)
}

#[tauri::command]
pub async fn attach_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    max_bytes: Option<usize>,
    profile_id: String,
) -> Result<String, String> {
    let (profile_id, sb_path, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &sb_path)?;
    attach_pty_core(&sessions, &sb_path, &id, max_bytes.unwrap_or(512 * 1024)).await
}

pub async fn write_pty_core(
    sessions: &PtySessions,
    id: &str,
    data: &str,
    expected_profile_id: Option<&str>,
    expected_scrollback_path: Option<&Path>,
) -> Result<(), String> {
    let sessions: PtySessions = sessions.clone();
    let pty_id = id.to_string();
    let payload = data.to_string();
    let expected_owner = expected_profile_id
        .zip(expected_scrollback_path)
        .map(|(profile_id, path)| (profile_id.to_string(), path.to_path_buf()));
    tokio::task::spawn_blocking(move || {
        let writer = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&pty_id)
                .ok_or_else(|| format!("PTY not found: {pty_id}"))?;
            if let Some((profile_id, scrollback_path)) = expected_owner.as_ref() {
                if !pty_owner_matches(
                    &session.profile_id,
                    &session.scrollback_path,
                    profile_id,
                    scrollback_path,
                ) {
                    return Err(format!("PTY belongs to a different profile: {pty_id}"));
                }
            }
            Arc::clone(&session.writer)
        };
        let mut writer = writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
        writer
            .write_all(payload.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("write_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn write_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    data: String,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    write_pty_core(&sessions, &id, &data, Some(&profile_id), Some(&expected)).await
}

pub async fn resize_pty_core(
    sessions: &PtySessions,
    sink: Arc<dyn PtyOutputSink>,
    log_path: Option<&Path>,
    id: &str,
    cols: u16,
    rows: u16,
    expected_profile_id: Option<&str>,
    expected_scrollback_path: Option<&Path>,
) -> Result<(), String> {
    let sessions: PtySessions = sessions.clone();
    let pty_id = id.to_string();
    let expected_owner = expected_profile_id
        .zip(expected_scrollback_path)
        .map(|(profile_id, path)| (profile_id.to_string(), path.to_path_buf()));
    let log_path_buf = log_path.map(|p| p.to_path_buf());
    tokio::task::spawn_blocking(move || {
        if pty_debug_enabled() {
            if let Some(ref path) = log_path_buf {
                let _ = append_spawn_log_path(
                    path,
                    &format!("[pty-debug] {pty_id}: resize_pty {cols}x{rows}"),
                );
            }
        }
        let (master, writer, wants_resize_nudge, nudge_lock, cols_atomic, rows_atomic) = {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            let session = sessions
                .get(&pty_id)
                .ok_or_else(|| format!("PTY not found: {pty_id}"))?;
            if let Some((profile_id, scrollback_path)) = expected_owner.as_ref() {
                if !pty_owner_matches(
                    &session.profile_id,
                    &session.scrollback_path,
                    profile_id,
                    scrollback_path,
                ) {
                    return Err(format!("PTY belongs to a different profile: {pty_id}"));
                }
            }
            (
                Arc::clone(&session.master),
                Arc::clone(&session.writer),
                redraw_nudge_config(session.command.as_deref()).resize,
                Arc::clone(&session.redraw_nudge_lock),
                Arc::clone(&session.cols),
                Arc::clone(&session.rows),
            )
        };

        {
            let master = master
                .lock()
                .map_err(|_| "PTY master lock poisoned".to_string())?;
            let master = master
                .as_ref()
                .ok_or_else(|| format!("PTY master ja fechado (sessao suspensa): {pty_id}"))?;
            master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())?;
        }

        cols_atomic.store(cols.max(1), Ordering::Relaxed);
        rows_atomic.store(rows.max(1), Ordering::Relaxed);

        // Tell every OTHER attached client (the one that requested this
        // resize already knows its own new size) so it can resize its own
        // xterm.js viewport to match — without this, a TUI redrawn for the
        // new grid renders into a stale-sized buffer on the other side.
        sink.emit_resized(&pty_id, cols.max(1), rows.max(1));

        if wants_resize_nudge {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let claimed = try_claim_redraw_nudge(&nudge_lock);
            if pty_debug_enabled() {
                if let Some(ref path) = log_path_buf {
                    let _ =
                        append_spawn_log_path(
                            path,
                            &format!(
                            "[pty-debug] {pty_id}: nudge de resize {} (50ms após master.resize)",
                            if claimed { "ENVIADO" } else { "pulado (perdeu a trava)" }
                        ),
                        );
                }
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

#[tauri::command]
pub async fn resize_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    cols: u16,
    rows: u16,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, expected, log_path) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    resize_pty_core(
        &sessions,
        Arc::new(crate::pty_sink::CombinedSink(
            crate::pty_sink::TauriSink(app),
            crate::pty_sink::WebSocketSink,
        )),
        Some(&log_path),
        &id,
        cols,
        rows,
        Some(&profile_id),
        Some(&expected),
    )
    .await
}

fn terminate_child_tree(
    pty_id: &str,
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) {
    let root_pid = child.lock().ok().and_then(|child| child.process_id());
    if let Some(pid) = root_pid {
        let _ = process_tree::kill_pty_tree_with_expected_root(pty_id, Some(pid));
        kill_process_tree(pid);
    }
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
}

fn terminate_session(session: PtySession) {
    terminate_child_tree(&session.pty_id, &session.child);
    process_tree::unregister_pty(&session.pty_id);
    {
        let (lock, cvar) = &*session.read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
}

pub async fn kill_pty_core(sessions: &PtySessions, sb_path: &Path, id: &str) -> Result<(), String> {
    let sessions: PtySessions = sessions.clone();
    let sb_path_buf = sb_path.to_path_buf();
    let pty_id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let session = {
            let mut sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&pty_id) {
                if session.scrollback_path != sb_path_buf {
                    return Err(format!("PTY belongs to a different profile: {pty_id}"));
                }
            }
            sessions.remove(&pty_id)
        };

        let owned_scrollback = session
            .as_ref()
            .map(|session| session.scrollback_path.clone())
            .unwrap_or(sb_path_buf);
        if let Some(session) = session {
            session.teardown.store(TEARDOWN_KILLED, Ordering::SeqCst);
            terminate_session(session);
        }

        delete_scrollback(&owned_scrollback)
    })
    .await
    .map_err(|error| format!("kill_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn kill_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, sb_path, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &sb_path)?;
    kill_pty_core(&sessions, &sb_path, &id).await
}

pub fn suspend_session(
    sink: &dyn PtyOutputSink,
    log_path: Option<&Path>,
    sessions: &PtySessions,
    id: &str,
) -> Result<bool, String> {
    let (pty_id, child, master, reader_done, teardown, read_active) = {
        let sessions = sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        let Some(session) = sessions.get(id) else {
            return Ok(false);
        };
        (
            session.pty_id.clone(),
            Arc::clone(&session.child),
            Arc::clone(&session.master),
            Arc::clone(&session.reader_done),
            Arc::clone(&session.teardown),
            Arc::clone(&session.read_active),
        )
    };

    teardown.store(TEARDOWN_SUSPENDED, Ordering::SeqCst);
    terminate_child_tree(&pty_id, &child);
    {
        let (lock, cvar) = &*read_active;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            cvar.notify_all();
        }
    }
    if let Ok(mut master) = master.lock() {
        master.take();
    }

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
    sink.emit_suspended(&PtySuspendedPayload {
        id: id.to_string(),
        reason: "memory-pressure",
    });
    if let Some(path) = log_path {
        let _ = append_spawn_log_path(path, &format!("suspend id={id} reason=memory-pressure"));
    }
    if let Ok(mut sessions) = sessions.lock() {
        sessions.remove(id);
    }
    Ok(true)
}

pub async fn suspend_pty_core(
    sessions: &PtySessions,
    sink: Arc<dyn PtyOutputSink>,
    log_path: Option<PathBuf>,
    id: &str,
) -> Result<bool, String> {
    let sessions = sessions.clone();
    let pty_id = id.to_string();
    tokio::task::spawn_blocking(move || {
        suspend_session(&*sink, log_path.as_deref(), &sessions, &pty_id)
    })
    .await
    .map_err(|error| format!("suspend_pty: falha na task bloqueante: {error}"))?
}

#[tauri::command]
pub async fn suspend_pty(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    profile_id: String,
) -> Result<bool, String> {
    let (profile_id, expected, log_path) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    suspend_pty_core(&sessions, Arc::new(TauriSink(app)), Some(log_path), &id).await
}

pub async fn get_pty_cwd_core(sessions: &PtySessions, id: &str) -> Result<Option<String>, String> {
    let sessions: PtySessions = sessions.clone();
    let pty_id = id.to_string();
    let result = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let sessions = sessions.lock().ok()?;
        let session = sessions.get(&pty_id)?;
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
pub async fn get_pty_cwd(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    profile_id: String,
) -> Result<Option<String>, String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    get_pty_cwd_core(&sessions, &id).await
}

pub fn set_pty_read_state_core(
    sessions: &PtySessions,
    id: &str,
    active: bool,
) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if let Some(session) = sessions.get(id) {
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
pub fn set_pty_read_state(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    active: bool,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    set_pty_read_state_core(&sessions, &id, active)
}

pub fn set_pty_visible_core(sessions: &PtySessions, id: &str, visible: bool) -> Result<(), String> {
    let sessions = sessions
        .lock()
        .map_err(|_| "PTY sessions lock poisoned".to_string())?;
    if let Some(session) = sessions.get(id) {
        session.visible.store(visible, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn set_pty_visible(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    visible: bool,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    set_pty_visible_core(&sessions, &id, visible)
}

pub async fn set_pty_priority_core(
    sessions: &PtySessions,
    id: &str,
    active: bool,
) -> Result<(), String> {
    let sessions: PtySessions = sessions.clone();
    let pty_id = id.to_string();
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        unsafe {
            let sessions = sessions
                .lock()
                .map_err(|_| "PTY sessions lock poisoned".to_string())?;
            if let Some(session) = sessions.get(&pty_id) {
                if let Ok(child) = session.child.lock() {
                    if let Some(pid) = child.process_id() {
                        use windows_sys::Win32::Foundation::CloseHandle;
                        use windows_sys::Win32::System::Threading::{
                            OpenProcess, SetPriorityClass, IDLE_PRIORITY_CLASS,
                            NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
                        };

                        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
                        if !handle.is_null() {
                            let priority = if active {
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
pub async fn set_pty_priority(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    id: String,
    active: bool,
    profile_id: String,
) -> Result<(), String> {
    let (profile_id, expected, _) = resolve_pty_profile_paths(&app, Some(&profile_id), &id)?;
    ensure_pty_owner(&sessions, &id, &profile_id, &expected)?;
    set_pty_priority_core(&sessions, &id, active).await
}

pub async fn list_pty_processes_core(
    sessions: &PtySessions,
    profile_id: Option<&str>,
) -> Result<Vec<PtyProcessSnapshot>, String> {
    let sessions: PtySessions = sessions.clone();
    let profile_id = profile_id.map(str::to_string);
    let result: Vec<PtyProcessSnapshot> = tokio::task::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

        let raw = {
            let Ok(sessions) = sessions.lock() else {
                return Vec::new();
            };
            sessions
                .iter()
                .filter(|(_, session)| {
                    profile_id
                        .as_ref()
                        .map_or(true, |expected| session.profile_id == *expected)
                })
                .map(|(id, session)| {
                    let pid = session
                        .child
                        .lock()
                        .ok()
                        .and_then(|child| child.process_id());
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

#[tauri::command]
pub async fn list_pty_processes(
    app: AppHandle,
    sessions: State<'_, PtySessions>,
    profile_id: String,
) -> Result<Vec<PtyProcessSnapshot>, String> {
    validate_pty_profile(&app, &profile_id)?;
    list_pty_processes_core(&sessions, Some(&profile_id)).await
}

pub fn load_scrollback(path: &Path) -> Result<VecDeque<u8>, String> {
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
enum ScrollbackWrite {
    /// Anexa `bytes` ao fim do `.bin` (cria se não existir). Compacta pra cauda
    /// de `SCROLLBACK_CAP_BYTES` se o arquivo passar de `SCROLLBACK_COMPACT_BYTES`.
    Append { path: PathBuf, bytes: Vec<u8> },
    /// Reescreve o arquivo inteiro (usado no teardown do PTY, uma vez).
    Overwrite { path: PathBuf, bytes: Vec<u8> },
    /// Confirma que todos os appends/overwrites anteriores já chegaram ao disco.
    Barrier(std::sync::mpsc::Sender<()>),
}

/// Anexa e, se o arquivo cresceu além do limite, compacta pra cauda do cap.
/// Compactar é raro (a cada ~4 MB de saída), então o custo é amortizado.
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

/// Writer global de scrollback: uma única thread em background recebe comandos
/// e escreve. Evita spawnar uma thread a cada flush (250ms por PTY ativo).
/// Vive pela vida do processo — sem teardown por PTY, sem vazar thread.
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
    path: &Path,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
    data: &[u8],
) -> Result<u64, String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    buffer.data.extend(data);
    buffer.cursor = buffer.cursor.saturating_add(data.len() as u64);
    let cursor = buffer.cursor;
    // Drena de uma vez em vez de pop_front em loop (uma operação vs N).
    if buffer.data.len() > SCROLLBACK_CAP_BYTES {
        let excess = buffer.data.len() - SCROLLBACK_CAP_BYTES;
        buffer.data.drain(..excess);
    }
    // Acumula SÓ os bytes novos pro append. O anel em memória (`data`) continua
    // servindo o getScrollback; o disco recebe só o delta, não os 4 MB inteiros.
    buffer.pending.extend_from_slice(data);
    buffer.dirty = true;

    if buffer.last_flush.elapsed().as_millis() < SCROLLBACK_FLUSH_INTERVAL_MS {
        return Ok(cursor);
    }

    if buffer.data.capacity() > SCROLLBACK_CAP_BYTES * 2 {
        buffer.data.shrink_to(SCROLLBACK_CAP_BYTES);
    }
    let bytes = std::mem::take(&mut buffer.pending);
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    if bytes.is_empty() {
        return Ok(cursor);
    }

    // Disk write em thread separada — segurar o reader thread aqui causava
    // latência visível de digitação (10-50ms por flush no Windows) propagando
    // pra TODOS os terminais com qualquer atividade.
    let path_buf = path.to_path_buf();
    // Envia pro writer global em vez de spawnar uma thread por flush.
    let _ = scrollback_writer().send(ScrollbackWrite::Append {
        path: path_buf,
        bytes,
    });
    Ok(cursor)
}

pub fn flush_scrollback(
    path: &Path,
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
) -> Result<(), String> {
    let mut buffer = scrollback
        .lock()
        .map_err(|_| "PTY scrollback lock poisoned".to_string())?;
    if !buffer.dirty {
        return Ok(());
    }
    // No teardown reescrevemos o anel inteiro (capado a 4 MB) — é a compactação
    // final do arquivo. `data` já inclui o que estava em `pending`.
    let bytes = buffer.data.iter().copied().collect::<Vec<_>>();
    buffer.pending.clear();
    buffer.last_flush = Instant::now();
    buffer.dirty = false;
    drop(buffer);

    // Via o writer global pra manter ordem FIFO com Appends ainda na fila —
    // senão um Append pendente poderia sobrescrever este Overwrite e duplicar
    // a cauda no disco.
    let path_buf = path.to_path_buf();
    let _ = scrollback_writer().send(ScrollbackWrite::Overwrite {
        path: path_buf,
        bytes,
    });
    Ok(())
}

pub fn delete_scrollback(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Remove `.bin` órfãos — scrollback de terminais que não existem mais no
/// projects.json. Roda no startup, ANTES de qualquer spawn (sem corrida).
/// Conservador: só apaga se o id NÃO aparecer em nenhum lugar do texto do
/// projects.json (ids são nanoids; colisão com texto não-relacionado é
/// improvável). Se o projects.json não puder ser lido, não apaga nada.
pub fn cleanup_orphan_scrollback_dir(dir: &Path, projects_text: &str) {
    if !dir.is_dir() || projects_text.is_empty() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
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

pub fn cleanup_orphan_scrollback(app: &AppHandle) {
    let Ok(dir) = scrollback_dir(app) else {
        return;
    };
    let projects_text = match crate::paths::projects_file_path(app) {
        Ok(path) => fs::read_to_string(&path).unwrap_or_default(),
        Err(_) => return,
    };
    cleanup_orphan_scrollback_dir(&dir, &projects_text);
}

pub fn kill_all_sessions(sessions: &PtySessions) {
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

    for session in drained {
        terminate_session(session);
    }
}

/// Resultado da instalação do Job Object — lido por `crash_watch.rs` (grava
/// no heartbeat, pra ficar registrado se um crash acontecer depois) e por um
/// comando Tauri de diagnóstico. Sem isso, uma falha de `install_kill_on_close_guard`
/// era 100% silenciosa: ninguém saberia que a rede de segurança contra
/// terminais órfãos estava inativa naquela sessão até órfãos aparecerem.
static JOB_GUARD_ACTIVE: OnceLock<bool> = OnceLock::new();

/// Status da rede de segurança (Job Object) desta sessão. `false` antes de
/// `install_kill_on_close_guard` rodar (só acontece bem cedo no boot) ou em
/// qualquer plataforma não-Windows.
pub fn job_guard_active() -> bool {
    JOB_GUARD_ACTIVE.get().copied().unwrap_or(false)
}

/// Rede de segurança no Windows contra terminais órfãos. Cria um Job Object com
/// KILL_ON_JOB_CLOSE e assigna o PRÓPRIO processo do app; todos os shells ConPTY
/// e seus descendentes (node/claude/codex/MCP) herdam o job. Enquanto o app vive,
/// o handle do job fica aberto; quando o app morre por QUALQUER via — fechar
/// normal, crash ou kill forçado (onde `RunEvent::Exit` NÃO roda) — o SO fecha o
/// handle e mata a árvore inteira. Complementa (não substitui) `kill_all_sessions`.
/// Deve ser chamado bem cedo no boot, antes de qualquer spawn. Se o SO recusar
/// em qualquer etapa, não há regressão (comportamento igual a antes desta rede
/// existir) — mas agora fica registrado em `JOB_GUARD_ACTIVE`/stderr em vez de
/// falhar 100% em silêncio.
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
        // `lpJobAttributes = null` já cria o handle como NÃO herdável por
        // padrão (SECURITY_ATTRIBUTES.bInheritHandle implícito = FALSE) — não
        // precisa de SetHandleInformation extra pra isso.
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
                // Mantém o handle num OnceLock estático. Além de documentar a
                // posse do recurso, isso impede que uma refatoração futura
                // feche o Job Object cedo demais e elimine os terminais
                // enquanto o app ainda está vivo.
                let _ = PTY_JOB_HANDLE.set(job as isize);
                true
            } else {
                // Se o Windows recusar a associação (por exemplo, uma
                // política de jobs aninhados), não deixe um handle inválido
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
    let _ = JOB_GUARD_ACTIVE.set(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_cap_keeps_long_agent_chats() {
        assert!(SCROLLBACK_CAP_BYTES >= 4 * 1024 * 1024);
    }

    #[test]
    fn scrollback_cursor_advances_monotonically_with_output_bytes() {
        let buffer = Arc::new(Mutex::new(ScrollbackBuffer::new(VecDeque::from(
            b"old".to_vec(),
        ))));
        let path = std::env::temp_dir().join(format!(
            "alethe-pty-cursor-{}-{}.bin",
            std::process::id(),
            nanoid::nanoid!(6)
        ));

        assert_eq!(push_scrollback(&path, &buffer, b"new").unwrap(), 6);
        assert_eq!(push_scrollback(&path, &buffer, "é".as_bytes()).unwrap(), 8);
        assert_eq!(buffer.lock().unwrap().cursor, 8);
    }

    #[test]
    fn pty_ids_cannot_escape_the_scrollback_directory() {
        assert!(validate_pty_id("agent-canvas_123").is_ok());
        assert!(validate_pty_id("").is_err());
        assert!(validate_pty_id("../outside").is_err());
        assert!(validate_pty_id("folder\\outside").is_err());
        assert!(validate_pty_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn web_spawn_payload_uses_camel_case_and_keeps_profile_ownership() {
        let args: SpawnPtyArgs = serde_json::from_value(serde_json::json!({
            "cols": 120,
            "rows": 40,
            "id": "terminal-1",
            "extraArgs": ["--resume", "session-1"],
            "launcherOverride": "/opt/alethe/codex",
            "profileId": "profile-a"
        }))
        .unwrap();

        assert_eq!(args.extra_args.unwrap(), vec!["--resume", "session-1"]);
        assert_eq!(args.launcher_override.as_deref(), Some("/opt/alethe/codex"));
        assert_eq!(args.profile_id, "profile-a");
    }

    #[test]
    fn pty_owner_requires_both_profile_and_scrollback_namespace() {
        let path = Path::new("profiles/profile-a/scrollback/terminal-1.bin");
        assert!(pty_owner_matches("profile-a", path, "profile-a", path));
        assert!(!pty_owner_matches("profile-a", path, "profile-b", path));
        assert!(!pty_owner_matches(
            "profile-a",
            path,
            "profile-a",
            Path::new("profiles/profile-a/scrollback/terminal-2.bin")
        ));
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
        // Instant "no passado" simulado por um intervalo já vencido.
        let stale =
            Instant::now() - Duration::from_millis(PTY_ACTIVITY_EMIT_INTERVAL_MS as u64 + 1);
        assert!(activity_emit_due(
            Some(stale),
            PTY_ACTIVITY_EMIT_INTERVAL_MS
        ));
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
