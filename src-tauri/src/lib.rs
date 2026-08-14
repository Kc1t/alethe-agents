pub mod activity_stats;
pub mod agent_cost;
pub mod agent_events;
pub mod agent_library;
pub mod ai_memory;
pub mod antigravity_sessions;
pub mod antigravity_usage;
pub mod backup;
pub mod claude_sessions;
pub mod claude_usage;
pub mod cli_launch;
pub mod cli_resolver;
pub mod cli_shim;
pub mod codex_app_server;
pub mod codex_sessions;
pub mod codex_usage;
pub mod conflict_resolution;
pub mod contract_check;
pub mod crash_watch;
pub mod diagnostics;
pub mod discord_presence;
pub mod economy_agents;
pub mod event_bus;
pub mod filesystem;
pub mod ghostty_bridge;
#[cfg(all(target_os = "macos", ghostty_linked))]
pub mod ghostty_ffi;
pub mod git_control;
pub mod github_sync;
pub mod graphify;
pub mod health_probe;
pub mod logging;
pub mod merge_analyzer;
pub mod opencode_bridge;
pub mod opencode_gsd_plugin;
pub mod opencode_sessions;
pub mod paths;
pub mod planning;
pub mod planning_gate;
pub mod plugins;
pub mod process_tree;
pub mod profiles;
pub mod project_detector;
pub mod projects;
pub mod provider_common;
pub mod pty;
pub mod pty_sink;
pub mod remote;
pub mod resource_manager;
pub mod resources;
pub mod scheduler;
pub mod server_main;
pub mod session_watcher;
pub mod spotify;
pub mod stats;
pub mod supervisor;
pub mod telemetry;
pub mod validation;
pub mod window_style;
#[cfg(windows)]
pub mod windows_webview;
pub mod worktrees;

use crate::pty::PtySessions;
use std::sync::Arc;

#[cfg(windows)]
#[tauri::command]
fn set_window_opacity(window: tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetLayeredWindowAttributes, SetWindowLongW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };

    let opacity = opacity.clamp(0.6, 1.0);
    let alpha = (opacity * 255.0).round() as u8;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;

    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as i32);
        if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn set_window_opacity(_window: tauri::WebviewWindow, _opacity: f64) -> Result<(), String> {
    Err("Window opacity is currently supported on Windows only".into())
}

#[cfg(any(debug_assertions, desktop))]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Precisa ser setado ANTES da webview ser criada (mais abaixo, via
    // Tauri Builder). WebKitGTK, no caminho de composição via DMA-BUF, tem
    // bugs conhecidos no Wayland — escala fracionada quebrando layout,
    // animações CSS travando/renderizando parcial, e um crash silencioso
    // ("Error 71") em alguns drivers de GPU — documentados oficialmente em
    // https://v2.tauri.app/develop/debug/linux-graphics/. Desligar o
    // renderer DMA-BUF custa o caminho de rendering mais rápido, mas evita
    // essa classe inteira de bug; não mexe em nada no Windows/macOS.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let _ = dotenvy::dotenv();
    // `npm run app` (dev) injeta EDITOR=vi e GIT_EDITOR=true no ambiente do
    // processo. Shells spawnados pelos terminais herdariam isso e o zsh ligaria
    // o vi-mode (Ctrl+R vira "redisplay", Ctrl+A/E viram self-insert — bug real
    // depurado no macOS). Removemos APENAS quando é claramente o artefato do
    // npm (rodando sob npm run + valores exatos que o npm injeta); o ambiente
    // do usuário em produção passa intocado, em todas as plataformas.
    if std::env::var_os("npm_lifecycle_event").is_some() {
        if std::env::var("EDITOR").as_deref() == Ok("vi") {
            std::env::remove_var("EDITOR");
        }
        if std::env::var("GIT_EDITOR").as_deref() == Ok("true") {
            std::env::remove_var("GIT_EDITOR");
        }
    }
    // Instala o panic hook cedo (antes do builder). O diretório de logs só é
    // resolvido no .setup(); panics anteriores a isso caem só no stderr.
    logging::install_panic_hook();
    // Rede de segurança contra terminais órfãos: se o app morrer por crash/kill
    // forçado (onde RunEvent::Exit não roda), o Job Object mata a árvore de PTYs.
    pty::install_kill_on_close_guard();
    let sessions: PtySessions = pty::global_pty_sessions().clone();
    let codex_app_server_state = codex_app_server::CodexAppServerState::default();
    let sessions_for_exit = Arc::clone(&sessions);
    let sessions_for_resources = Arc::clone(&sessions);
    let resource_supervisor = Arc::new(resources::ResourceSupervisor::default());
    let resource_supervisor_for_setup = Arc::clone(&resource_supervisor);

    let mut builder = tauri::Builder::default()
        .manage(sessions.clone())
        .manage(codex_app_server_state)
        .manage(remote::hub())
        .manage(resource_supervisor)
        .manage(ghostty_bridge::GhosttySurfaces::default())
        .manage(filesystem::FileWatchers::default())
        .manage(discord_presence::DiscordPresence::new())
        .manage(planning::PlanningWatchers::default())
        .manage(cli_launch::PendingOpen::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Impede execuções paralelas do Alethe — pré-requisito real da guarda de
    // monotonicidade de `save_projects` (projects.rs): duas instâncias teriam
    // cada uma seu próprio LAST_WRITE_SEQUENCE em memória, e a garantia de
    // last-write-wins deixaria de valer entre processos. Segunda instância só
    // foca a janela existente em vez de abrir outra — e, quando veio de
    // `alethe <path>` no terminal, entrega o diretório pedido pra ela (ver
    // cli_launch.rs) antes de morrer.
    // A guarda de instância única é por `identifier` do app (D-Bus/named pipe),
    // não por data dir — uma instância de E2E (mesmo identifier, data dir
    // isolado por env var) seria detectada como "segunda instância" de um
    // `tauri dev` interativo já aberto e sairia na hora (code=0) sem nunca
    // subir. Sob `ALETHE_E2E=1` a instância de teste já é isolada por conta
    // própria, então esse guard não é necessário nem desejável.
    #[cfg(desktop)]
    if std::env::var_os("ALETHE_E2E").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            cli_launch::handle_second_instance(app, argv, cwd);
        }));
    }

    // Automação WebDriver (harness de E2E) — nunca compilada em release
    // (`debug_assertions`) e, mesmo em debug, só ativa com `ALETHE_E2E=1` no
    // ambiente. Sem a variável, uma sessão normal de `tauri dev` do dia a dia
    // não expõe superfície de automação nenhuma.
    #[cfg(debug_assertions)]
    if std::env::var_os("ALETHE_E2E").is_some() {
        // `-webdriver` sobe o servidor WebDriver embarcado em si; o outro dá
        // acesso à API `browser.tauri.execute()` e mocking de invoke a partir
        // dos specs. As duas peças são independentes no ecossistema wdio-tauri.
        builder = builder
            .plugin(tauri_plugin_wdio_webdriver::init())
            .plugin(tauri_plugin_wdio::init());
    }

    builder
        .setup(move |app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("(DEV) Alethe");
            }
            // `tauri dev` no Linux não instala `.desktop` file nenhum (só um
            // build empacotado via .deb/AppImage faz isso), então KWin/GNOME
            // Shell não têm de onde puxar o ícone pro Alt+Tab/task switcher e
            // caem num genérico — a config em `tauri.conf.json` (`bundle.icon`)
            // só é consumida no empacotamento, não em dev. `set_icon` seta
            // `_NET_WM_ICON` diretamente na janela em runtime, sem depender de
            // `.desktop` — não é garantia de funcionar em todo compositor
            // (alguns preferem lookup por tema/`.desktop` mesmo com o hint
            // presente), mas não tem custo nenhum tentar.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                // `tauri::image::Image` não decodifica PNG diretamente nesta
                // versão (só aceita pixels RGBA crus + dimensões) — decodifica
                // com a crate `image` (já dependência direta) antes.
                match image::load_from_memory(include_bytes!("../icons/128x128.png")) {
                    Ok(decoded) => {
                        let rgba = decoded.to_rgba8();
                        let (width, height) = rgba.dimensions();
                        let icon = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
                        if let Err(error) = window.set_icon(icon) {
                            eprintln!("[icon] falha ao aplicar ícone da janela: {error}");
                        }
                    }
                    Err(error) => eprintln!("[icon] falha ao decodificar ícone embutido: {error}"),
                }
            }
            logging::set_logs_dir(app.handle());
            let data_root = profiles::resolve_tauri_data_root(app.handle())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let runtime = server_main::ServerRuntime::embedded(
                app.config().identifier.clone(),
                data_root,
                app.handle().clone(),
            );
            tauri::async_runtime::spawn(async move {
                let listener =
                    match tokio::net::TcpListener::bind(server_main::SERVER_BIND_ADDRESS).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            eprintln!(
                                "[Alethe Embedded Server] Failed to bind http://{}; another core may already own this data root: {error}",
                                server_main::SERVER_BIND_ADDRESS
                            );
                            return;
                        }
                    };
                println!(
                    "[Alethe Embedded Server] Listening on http://{} (instance {}).",
                    server_main::SERVER_BIND_ADDRESS,
                    runtime.instance_id()
                );
                let router = server_main::build_router(runtime);
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("[Alethe Embedded Server] Server stopped with an error: {error}");
                }
            });
            // Keep the terminal launcher available after installation.
            #[cfg(not(debug_assertions))]
            let _ = cli_shim::cli_shim_install();
            // `alethe <path>` com o app fechado: guarda o alvo agora, o
            // frontend consome no boot (a webview ainda não existe aqui).
            cli_launch::capture_cold_start(app.handle());
            event_bus::set_app_handle(app.handle().clone());
            // Cantos arredondados no macOS (no-op nas outras plataformas). A
            // janela roda sem decorações nativas, então reaplicamos o
            // arredondamento no nível do AppKit.
            window_style::apply_rounded_corners(app.handle());
            // Detecta saída suja anterior (crash/OOM/kill) e sobe o heartbeat.
            crash_watch::start(app.handle().clone());
            resources::start(
                app.handle().clone(),
                Arc::clone(&sessions_for_resources),
                Arc::clone(&resource_supervisor_for_setup),
            );
            // Limpa scrollback órfão antes de qualquer spawn (sem corrida).
            pty::cleanup_orphan_scrollback(app.handle());
            agent_events::start_listener(app.handle().clone());
            remote::start(app.handle().clone(), Arc::clone(&sessions));
            // Best-effort: escreve/atualiza o plugin global do OpenCode que
            // reporta working/idle real de volta pro Alethe (ver opencode_bridge.rs).
            opencode_bridge::ensure_installed();
            session_watcher::start_watcher(app.handle().clone());

            // Multi-Agent & Telemetry Event Loops
            telemetry::start_telemetry_watcher(app.handle().clone());
            planning::start_planning_autocommit_loop();
            scheduler::start_scheduler_event_loop();
            supervisor::start_supervisor_event_loop();

            // Resource Manager (memory pressure, policy engine, task scheduler)
            resource_manager::start(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_events::agent_hooks_settings_path,
            agent_events::agent_hooks_endpoint,
            agent_events::agent_hooks_token,
            codex_app_server::codex_app_server_start,
            codex_app_server::codex_app_server_send,
            codex_app_server::codex_app_server_stop,
            activity_stats::record_activity_samples,
            activity_stats::get_activity_summary,
            activity_stats::clear_activity_stats,
            agent_library::list_installed_agents,
            agent_library::install_agent,
            agent_library::uninstall_agent,
            economy_agents::set_economy_agents,
            economy_agents::economy_agents_enabled,
            filesystem::list_directory,
            filesystem::read_text_file,
            filesystem::write_text_file,
            filesystem::write_project_marker,
            filesystem::read_project_marker,
            filesystem::ensure_todo_template,
            filesystem::watch_file,
            filesystem::unwatch_file,
            pty::pty_exists,
            pty::spawn_pty,
            pty::attach_pty,
            pty::restart_pty,
            pty::write_pty,
            remote::remote_control_info,
            remote::remote_control_revoke,
            remote::remote_control_revoke_device,
            remote::remote_control_set_max_devices,
            remote::remote_control_set_session_expiry,
            remote::remote_control_set_enabled,
            pty::resize_pty,
            pty::kill_pty,
            pty::suspend_pty,
            pty::get_pty_cwd,
            pty::set_pty_read_state,
            pty::set_pty_visible,
            pty::set_pty_priority,
            ghostty_bridge::ghostty_spawn,
            ghostty_bridge::ghostty_sync_frame,
            ghostty_bridge::ghostty_set_hidden,
            ghostty_bridge::ghostty_kill,
            ghostty_bridge::ghostty_kill_all,
            ghostty_bridge::ghostty_debug_send_read,
            pty::list_pty_processes,
            resource_manager::get_resource_metrics,
            process_tree::get_pty_tree_info,
            process_tree::kill_pty_tree_cmd,
            projects::load_projects,
            projects::load_projects_bootstrap,
            projects::save_projects,
            projects::save_projects_for_profile,
            projects::clone_github_repo,
            cli_resolver::discover_provider_models,
            profiles::list_profiles,
            profiles::get_core_storage_identity,
            profiles::list_profile_summaries,
            profiles::get_active_profile,
            profiles::set_active_profile,
            profiles::create_profile,
            profiles::rename_profile,
            profiles::delete_profile,
            cli_resolver::find_cli_launcher,
            cli_launch::cli_take_pending_open,
            cli_shim::cli_shim_status,
            cli_shim::cli_shim_install,
            cli_shim::cli_shim_uninstall,
            backup::export_backup,
            backup::export_profile_backup,
            backup::import_backup,
            github_sync::github_sync_status,
            github_sync::github_sync_set_token,
            github_sync::github_sync_logout,
            github_sync::github_sync_push,
            github_sync::github_sync_pull,
            git_control::git_init,
            git_control::git_status,
            git_control::git_diff,
            git_control::git_stage,
            git_control::git_unstage,
            git_control::git_discard,
            git_control::git_commit,
            git_control::git_push,
            git_control::git_pull,
            git_control::git_list_branches,
            git_control::git_diff_summary,
            git_control::git_log_graph,
            git_control::git_show_commit_files,
            git_control::git_create_branch_from_commit,
            git_control::git_cherry_pick_commit,
            git_control::git_revert_commit,
            git_control::git_reset_to_commit,
            git_control::git_incoming_outgoing,
            diagnostics::open_data_folder,
            diagnostics::open_spawn_log,
            diagnostics::open_in_file_explorer,
            diagnostics::open_in_vscode,
            diagnostics::open_in_browser,
            diagnostics::read_clipboard_text,
            diagnostics::write_clipboard_text,
            diagnostics::read_clipboard_payload,
            diagnostics::reset_app_data,
            diagnostics::wipe_all_app_data,
            diagnostics::open_logs_folder,
            diagnostics::export_logs,
            logging::record_frontend_error,
            discord_presence::set_discord_presence,
            discord_presence::clear_discord_presence,
            stats::get_memory_stats,
            resources::get_runtime_snapshot,
            resources::set_resource_policy,
            resources::update_pty_runtime_meta,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_status,
            spotify::spotify_get_current,
            claude_sessions::snapshot_claude_sessions,
            claude_sessions::list_claude_sessions,
            claude_sessions::get_claude_activity,
            claude_sessions::get_multi_agent_activity,
            codex_sessions::snapshot_codex_sessions,
            antigravity_sessions::snapshot_antigravity_sessions,
            claude_usage::get_claude_usage,
            codex_usage::get_codex_usage,
            antigravity_usage::get_antigravity_usage,
            agent_cost::get_session_cost,
            agent_cost::get_transcript_cost,
            agent_cost::get_model_pricing,
            agent_cost::get_opencode_usage_summary,
            crash_watch::get_last_crash_report,
            crash_watch::get_job_guard_status,
            set_window_opacity,
            quit_app,
            worktrees::worktree_provision,
            worktrees::worktree_list,
            worktrees::worktree_remove,
            worktrees::worktree_cleanup,
            worktrees::worktree_fetch_branch,
            worktrees::worktree_commit_pending,
            worktrees::worktree_pending_changes,
            worktrees::worktree_commit_worktree,
            worktrees::worktree_lock,
            worktrees::worktree_unlock,
            event_bus::publish_event,
            telemetry::get_telemetry_metrics,
            telemetry::get_telemetry_traces,
            validation::run_validation,
            planning::start_gsd_watcher,
            planning::stop_gsd_watcher,
            planning::planning_audit_record,
            planning::planning_audit_history,
            planning::set_planning_autocommit,
            planning::get_planning_autocommit,
            planning_gate::read_planning_status,
            planning_gate::read_gsd_child_session,
            planning_gate::read_gsd_child_busy,
            planning_gate::read_gsd_child_error,
            planning_gate::read_gsd_procedure,
            opencode_gsd_plugin::gsd_opencode_plugin_write,
            scheduler::get_scheduler_tasks,
            scheduler::trigger_scheduler_tick,
            scheduler::cancel_task,
            merge_analyzer::merge_analyze,
            conflict_resolution::merge_prepare,
            conflict_resolution::merge_validate,
            conflict_resolution::merge_finalize,
            conflict_resolution::merge_abort,
            conflict_resolution::merge_preflight_abort,
            conflict_resolution::merge_rebase_onto_target,
            conflict_resolution::merge_force_cleanup,
            project_detector::detect_project_stack,
            contract_check::contract_check,
            health_probe::health_probe,
            graphify::graphify_ensure_graph,
            graphify::graphify_detect,
            graphify::graphify_mcp_config_path,
            graphify::graphify_opencode_config_write,
            graphify::graphify_codex_config_write,
            graphify::graphify_read_graph,
            graphify::graphify_snapshot,
            graphify::graphify_list_snapshots,
            graphify::graphify_diff_snapshot,
            graphify::graphify_rollback,
            graphify::graphify_prune_snapshots,
            ai_memory::ai_memory_detect,
            ai_memory::ai_memory_mcp_config_path,
            ai_memory::ai_memory_opencode_config_write,
            ai_memory::ai_memory_codex_config_write,
            plugins::plugins_list,
            plugins::plugin_install,
            plugins::plugin_uninstall,
            opencode_sessions::snapshot_opencode_sessions,
            opencode_sessions::opencode_export_session,
            ping,
        ])
        .build(tauri::generate_context!())
        .expect("error while building alethe")
        .run(move |_app_handle, event| {
            // Faça o teardown assim que o runtime começa a sair. Em alguns
            // caminhos do Windows a janela é destruída, mas o loop demora a
            // emitir `Exit`; esperar esse evento deixa shells/agentes vivos
            // por tempo indefinido (e inacessíveis ao usuário).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                pty::kill_all_sessions(&sessions_for_exit);
            }
            // Saída limpa (event loop encerrou normalmente) → marca a sessão como
            // OK. Se o processo for morto/crashar, isto NÃO roda e o próximo boot
            // reporta a saída suja.
            if let tauri::RunEvent::Exit = event {
                pty::kill_all_sessions(&sessions_for_exit);
                crash_watch::mark_clean_exit();
            }
        });
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle, sessions: tauri::State<'_, PtySessions>) {
    // Última barreira do caminho normal de fechamento: o frontend chama este
    // comando depois de destruir a janela, então não dependemos do timing do
    // event loop para matar shells, agentes e seus descendentes.
    pty::kill_all_sessions(sessions.inner());
    app.exit(0);
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilt_path_is_non_empty_on_windows() {
        if !cfg!(windows) {
            return;
        }
        assert!(!cli_resolver::build_rebuilt_path().is_empty());
    }
}
