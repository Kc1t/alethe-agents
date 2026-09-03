mod activity_stats;
mod agent_cost;
mod agent_events;
mod agent_library;
mod ai_memory;
mod antigravity_sessions;
mod antigravity_usage;
mod backup;
mod browser_pane;
mod browser_session;
mod cdp;
mod claude_sessions;
mod claude_usage;
mod cli_launch;
mod cli_resolver;
mod cli_shim;
mod codex_app_server;
mod codex_sessions;
mod codex_usage;
mod conflict_resolution;
mod contract_check;
mod crash_watch;
mod diagnostics;
mod discord_presence;
mod economy_agents;
mod event_bus;
mod filesystem;
mod ghostty_bridge;
#[cfg(all(target_os = "macos", ghostty_linked))]
mod ghostty_ffi;
mod git_control;
mod github_sync;
mod graphify;
mod handoff;
mod health_probe;
mod logging;
mod mcp_agents;
mod mcp_catalog;
mod mcp_health;
mod mcp_model;
mod mcp_store;
mod merge_analyzer;
mod opencode_bridge;
mod opencode_gsd_plugin;
mod opencode_sessions;
pub mod orchestrator;
pub mod orchestrator_core;
mod paths;
mod planning;
mod planning_gate;
mod plugins;
mod process_tree;
mod profiles;
mod project_detector;
mod projects;
mod provider_common;
mod pty;
mod remote;
mod resource_manager;
mod resources;
mod router9;
mod scheduler;
mod session_watcher;
mod skills;
mod spotify;
mod stats;
mod supervisor;
mod telemetry;
mod validation;
mod window_style;
#[cfg(windows)]
mod windows_webview;
mod worktrees;

use crate::pty::{PtySession, PtySessions};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

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
    // bugs conhecidos no Wayland — escala fracionada quebrando layout,

    // ("Error 71") em alguns drivers de GPU — documentados oficialmente em
    // https://v2.tauri.app/develop/debug/linux-graphics/. Desligar o

    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    let _ = dotenvy::dotenv();
    // `npm run app` (dev) injeta EDITOR=vi e GIT_EDITOR=true no ambiente do

    // o vi-mode (Ctrl+R vira "redisplay", Ctrl+A/E viram self-insert — bug real

    // npm (rodando sob npm run + valores exatos que o npm injeta); o ambiente

    if std::env::var_os("npm_lifecycle_event").is_some() {
        if std::env::var("EDITOR").as_deref() == Ok("vi") {
            std::env::remove_var("EDITOR");
        }
        if std::env::var("GIT_EDITOR").as_deref() == Ok("true") {
            std::env::remove_var("GIT_EDITOR");
        }
    }

    logging::install_panic_hook();

    pty::install_kill_on_close_guard();
    let sessions: PtySessions = Arc::new(Mutex::new(HashMap::<String, PtySession>::new()));
    let browser_session_state = browser_session::BrowserSessionState::default();
    let browser_pane_state = browser_pane::BrowserPaneState::default();
    let codex_app_server_state = codex_app_server::CodexAppServerState::default();
    let sessions_for_exit = Arc::clone(&sessions);
    let sessions_for_resources = Arc::clone(&sessions);
    let resource_supervisor = Arc::new(resources::ResourceSupervisor::default());
    let resource_supervisor_for_setup = Arc::clone(&resource_supervisor);

    let mut builder = tauri::Builder::default()
        .manage(sessions.clone())
        .manage(browser_session_state)
        .manage(browser_pane_state)
        .manage(codex_app_server_state)
        .manage(remote::hub())
        .manage(resource_supervisor)
        .manage(ghostty_bridge::GhosttySurfaces::default())
        .manage(filesystem::FileWatchers::default())
        .manage(discord_presence::DiscordPresence::new())
        .manage(planning::PlanningWatchers::default())
        .manage(cli_launch::PendingOpen::default())
        .manage(orchestrator::OrchestratorState::default())
        .manage(router9::Router9Process::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            cli_launch::handle_second_instance(app, argv, cwd);
        }));
    }

    builder
        .setup(move |app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("(DEV) Alethe");
            }

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
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
            if let Ok(dir) = paths::profile_data_dir(app.handle()) {
                process_tree::set_roots_file_dir(dir);
                let _ = process_tree::sweep_orphans_from_previous_session();
                process_tree::start_orphan_sweeper();
            }
            // Keep the terminal launcher available after installation.
            #[cfg(not(debug_assertions))]
            let _ = cli_shim::cli_shim_install();
            // `alethe <path>` com o app fechado: guarda o alvo agora, o

            cli_launch::capture_cold_start(app.handle());
            event_bus::set_app_handle(app.handle().clone());
            // Cantos arredondados no macOS (no-op nas outras plataformas). A

            window_style::apply_rounded_corners(app.handle());

            crash_watch::start(app.handle().clone());
            resources::start(
                app.handle().clone(),
                Arc::clone(&sessions_for_resources),
                Arc::clone(&resource_supervisor_for_setup),
            );

            pty::cleanup_orphan_scrollback(app.handle());
            agent_events::start_listener(app.handle().clone());

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
            agent_events::codex_hooks_config_write,
            agent_events::codex_mcp_config_write,
            agent_events::agent_hooks_endpoint,
            agent_events::agent_hooks_token,
            orchestrator::orchestrator_mcp_config_path,
            orchestrator::orchestrator_jobs,
            orchestrator::orchestrator_set_concurrency,
            orchestrator::orchestrator_message,
            orchestrator::orchestrator_answer,
            orchestrator::orchestrator_job_diff,
            browser_session::browser_session_start,
            browser_session::browser_session_stop,
            browser_session::browser_session_status,
            browser_session::playwright_mcp_config_path,
            browser_pane::browser_pane_open,
            browser_pane::browser_pane_close,
            browser_pane::browser_pane_navigate,
            browser_pane::browser_pane_reload,
            browser_pane::browser_pane_history,
            browser_pane::browser_pane_resize,
            browser_pane::browser_pane_set_streaming,
            browser_pane::browser_pane_mouse,
            browser_pane::browser_pane_key,
            browser_pane::browser_pane_observe,
            browser_pane::browser_pane_targets,
            browser_pane::browser_pane_watch,
            browser_pane::browser_pane_close_target,
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
            filesystem::browse_directory,
            filesystem::read_text_file,
            filesystem::write_text_file,
            filesystem::write_project_marker,
            filesystem::read_project_marker,
            filesystem::rename_filesystem_entry,
            filesystem::delete_filesystem_entry,
            filesystem::ensure_todo_template,
            filesystem::watch_file,
            filesystem::unwatch_file,
            pty::pty_exists,
            pty::spawn_pty,
            pty::attach_pty,
            pty::clear_pty_scrollback,
            pty::restart_pty,
            pty::write_pty,
            remote::remote_control_connected_devices,
            remote::remote_control_info,
            remote::remote_control_open_pairing,
            remote::remote_control_close_pairing,
            remote::remote_control_revoke,
            remote::remote_control_revoke_device,
            remote::remote_control_set_max_devices,
            remote::remote_control_set_session_expiry,
            remote::remote_control_set_read_only,
            remote::remote_control_set_shell_input,
            remote::remote_control_set_enabled,
            remote::remote_control_tailscale_status,
            remote::remote_control_set_reach_mode,
            pty::resize_pty,
            pty::kill_pty,
            pty::kill_ptys,
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
            projects::save_projects,
            projects::clone_github_repo,
            cli_resolver::discover_provider_models,
            profiles::list_profiles,
            profiles::list_profile_summaries,
            profiles::get_active_profile,
            profiles::set_active_profile,
            profiles::create_profile,
            profiles::rename_profile,
            profiles::delete_profile,
            cli_resolver::find_cli_launcher,
            cli_resolver::probe_install_toolchain,
            cli_resolver::agent_cli_version,
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
            git_control::git_show_commit_message,
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
            logging::record_app_event,
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
            claude_sessions::get_claude_session_title,
            claude_sessions::get_claude_activity,
            claude_sessions::get_multi_agent_activity,
            codex_sessions::snapshot_codex_sessions,
            codex_sessions::get_codex_session_title,
            handoff::prepare_agent_handoff,
            handoff::materialize_agent_handoff,
            handoff::complete_agent_handoff,
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
            worktrees::worktree_lock,
            worktrees::worktree_unlock,
            worktrees::worktree_commit_pending,
            worktrees::worktree_pending_changes,
            worktrees::worktree_commit_worktree,
            merge_analyzer::merge_analyze,
            conflict_resolution::merge_prepare,
            conflict_resolution::merge_validate,
            conflict_resolution::merge_finalize,
            conflict_resolution::merge_abort,
            conflict_resolution::merge_preflight_abort,
            conflict_resolution::merge_rebase_onto_target,
            conflict_resolution::merge_force_cleanup,
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
            planning::list_project_plans,
            planning_gate::read_planning_status,
            planning_gate::read_gsd_child_session,
            planning_gate::read_gsd_child_state,
            planning_gate::read_gsd_child_busy,
            planning_gate::read_gsd_child_error,
            planning_gate::read_gsd_procedure,
            opencode_gsd_plugin::gsd_opencode_plugin_write,
            scheduler::get_scheduler_tasks,
            scheduler::trigger_scheduler_tick,
            scheduler::cancel_task,
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
            router9::router9_status,
            router9::router9_install_command,
            router9::router9_uninstall_command,
            router9::router9_start,
            router9::router9_stop,
            plugins::plugins_list,
            plugins::plugins_disabled,
            plugins::plugins_dir,
            plugins::plugin_install,
            plugins::plugin_uninstall,
            plugins::plugin_set_enabled,
            mcp_store::mcp_scan,
            mcp_store::mcp_config_paths,
            mcp_store::mcp_capabilities,
            mcp_store::mcp_upsert,
            mcp_store::mcp_remove,
            mcp_store::mcp_set_enabled,
            mcp_store::mcp_reveal_env,
            mcp_store::mcp_sync,
            mcp_catalog::mcp_registry_search,
            mcp_health::mcp_health_check,
            skills::skills_scan,
            skills::skills_detail,
            skills::skills_uninstall,
            opencode_sessions::snapshot_opencode_sessions,
            opencode_sessions::opencode_export_session,
            ping,
        ])
        .build(tauri::generate_context!())
        .expect("error while building alethe")
        .run(move |_app_handle, event| {
            // emitir `Exit`; esperar esse evento deixa shells/agentes vivos

            if let tauri::RunEvent::ExitRequested { .. } = event {
                pty::kill_all_sessions_background(&sessions_for_exit);
                browser_session::kill_running_session(
                    &_app_handle.state::<browser_session::BrowserSessionState>(),
                );
                router9::stop_managed(&_app_handle.state::<router9::Router9Process>());
            }

            if let tauri::RunEvent::Exit = event {
                crash_watch::mark_clean_exit();
            }
        });
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle, sessions: tauri::State<'_, PtySessions>) {
    // The Windows job object remains the hard guarantee that descendants die with the app. The
    // best-effort explicit teardown runs in the background so a slow process tree cannot block exit.
    pty::kill_all_sessions_background(sessions.inner());
    crash_watch::mark_clean_exit();
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
