pub mod activity_stats;
pub mod agent_cost;
pub mod agent_events;
pub mod agent_library;
pub mod ai_memory;
pub mod antigravity_sessions;
pub mod antigravity_usage;
pub mod backup;
pub mod browser_pane;
pub mod browser_session;
pub mod cdp;
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
pub mod handoff;
pub mod health_probe;
pub mod logging;
pub mod mcp_agents;
pub mod mcp_catalog;
pub mod mcp_health;
pub mod mcp_model;
pub mod mcp_store;
pub mod merge_analyzer;
pub mod opencode_bridge;
pub mod opencode_gsd_plugin;
pub mod opencode_sessions;
pub mod orchestrator;
pub mod orchestrator_core;
pub mod paths;
pub mod planning;
pub mod planning_gate;
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
pub mod skills;
pub mod spotify;
pub mod stats;
pub mod supervisor;
pub mod sync_activation;
pub mod sync_access;
pub mod sync_chat;
pub mod sync_cloudflare_deploy;
pub mod sync_crypto;
pub mod sync_engine;
pub mod sync_invitation_bridge;
pub mod sync_manifest;
pub mod sync_mesh;
pub mod sync_p2p_bridge;
pub mod sync_protocol;
pub mod sync_remote_invitation;
pub mod sync_rendezvous;
pub mod sync_security;
pub mod sync_staging;
pub mod sync_subscription;
pub mod sync_tasks;
pub mod sync_transport;
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
    let sessions: PtySessions = pty::global_pty_sessions().clone();
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
        .manage(std::sync::Arc::new(sync_rendezvous::RendezvousRuntime::default()))
        .manage(std::sync::Arc::new(sync_p2p_bridge::P2pSessionRegistry::default()))
        .manage(orchestrator::OrchestratorState::default())
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
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(debug_assertions)]
                let _ = window.set_title("(DEV) Alethe");
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                match image::load_from_memory(include_bytes!("../icons/128x128@2x.png")) {
                    Ok(decoded) => {
                        let rgba = decoded.to_rgba8();
                        let (width, height) = rgba.dimensions();
                        let icon = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
                        if let Err(error) = window.set_icon(icon) {
                            eprintln!("[icon] failed to apply the Linux window icon: {error}");
                        }
                    }
                    Err(error) => eprintln!("[icon] failed to decode the embedded icon: {error}"),
                }
            }
            logging::set_logs_dir(app.handle());
            logging::record_platform_readiness();
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
            agent_events::agent_hooks_endpoint,
            agent_events::agent_hooks_token,
            orchestrator::orchestrator_mcp_config_path,
            orchestrator::orchestrator_jobs,
            orchestrator::orchestrator_set_concurrency,
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
            pty::resize_pty,
            pty::kill_pty,
            pty::suspend_pty,
            pty::get_pty_cwd,
            pty::get_pty_size,
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
            logging::record_console_log,
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
            worktrees::worktree_commit_pending,
            worktrees::worktree_pending_changes,
            worktrees::worktree_commit_worktree,
            worktrees::worktree_lock,
            worktrees::worktree_unlock,
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
            planning::list_project_plans,
            planning::save_project_plan,
            planning::patch_project_plan,
            planning::append_plan_diagram,
            planning::set_planning_autocommit,
            planning::get_planning_autocommit,
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
            sync_mesh::scan_project_folder_tree,
            sync_mesh::setup_project_mesh_isolation,
            sync_mesh::trigger_project_archive_backup,
            sync_mesh::purge_project_backups_secured,
            sync_mesh::start_google_sync_auth,
            sync_mesh::configure_google_sync,
            sync_mesh::get_google_sync_status,
            sync_mesh::disconnect_google_sync,
            sync_security::sync_security_snapshot,
            sync_security::sync_local_identity,
            sync_security::sync_find_trusted_device_for_account_route,
            sync_security::sync_add_chat_contact,
            sync_security::sync_list_chat_contacts,
            sync_security::sync_remove_chat_contact,
            sync_security::sync_rename_chat_contact,
            sync_security::sync_prepare_collaborator_suggestion,
            sync_security::sync_open_collaborator_suggestion,
            sync_security::sync_seal_chat_contact_ack,
            sync_security::sync_open_chat_contact_ack,
            sync_security::sync_seal_avatar_update,
            sync_security::sync_open_avatar_update,
            sync_security::sync_seal_chat_contact_confirm,
            sync_security::sync_open_chat_contact_confirm,
            sync_security::sync_approve_device,
            sync_security::sync_reject_device,
            sync_security::sync_rename_device,
            sync_security::sync_revoke_device,
            sync_security::sync_remove_device,
            sync_security::sync_issue_invitation,
            sync_security::sync_revoke_invitation,
            sync_security::sync_redeem_invitation,
            sync_security::sync_revoke_grant,
            sync_security::sync_update_grant,
            sync_security::sync_list_project_grants,
            sync_security::sync_rotate_device_keys,
            sync_security::sync_export_account_data,
            sync_security::sync_delete_project_access,
            sync_security::sync_resolve_capabilities,
            sync_subscription::sync_list_subscriptions,
            sync_subscription::sync_offer_subscription,
            sync_subscription::sync_configure_subscription_destination,
            sync_subscription::sync_select_subscription_mode,
            sync_subscription::sync_confirm_subscription,
            sync_subscription::sync_defer_subscription,
            sync_subscription::sync_decline_subscription,
            sync_staging::sync_begin_staging,
            sync_staging::sync_receive_chunk,
            sync_staging::sync_verify_staged,
            sync_staging::sync_publish_staging,
            sync_staging::sync_load_staging,
            sync_engine::sync_engine_pause,
            sync_engine::sync_engine_resume,
            sync_engine::sync_engine_mark_needs_rescan,
            sync_engine::sync_engine_load,
            sync_engine::sync_engine_resolve_conflict,
            sync_engine::sync_engine_apply_local,
            sync_tasks::sync_create_task,
            sync_tasks::sync_list_visible_tasks,
            sync_tasks::sync_get_task,
            sync_tasks::sync_complete_task,
            sync_tasks::sync_reopen_task,
            sync_tasks::sync_add_task_comment,
            sync_tasks::sync_update_task,
            sync_tasks::sync_assign_task,
            sync_tasks::sync_delete_task,
            sync_chat::sync_create_conversation,
            sync_chat::sync_get_conversation,
            sync_chat::sync_add_conversation_member,
            sync_chat::sync_remove_conversation_member,
            sync_chat::sync_list_messages,
            sync_chat::sync_react_to_message,
            sync_chat::sync_mark_conversation_read,
            sync_chat::sync_ensure_project_conversation,
            sync_chat::sync_start_direct_conversation,
            sync_chat::sync_delete_direct_conversation,
            sync_chat::sync_send_message,
            sync_chat::sync_send_message_for_transport,
            sync_chat::sync_ingest_chat_transport_frame,
            sync_chat::sync_list_decrypted_messages,
            sync_chat::sync_edit_message,
            sync_chat::sync_delete_message,
            sync_chat::sync_upload_attachment,
            sync_chat::sync_download_attachment,
            sync_chat::sync_seal_chat_relay_message,
            sync_chat::sync_open_chat_relay_message,
            sync_activation::sync_get_activation_settings,
            sync_activation::sync_set_activation_mode,
            sync_activation::sync_enable_activation,
            sync_activation::sync_disable_activation,
            sync_activation::sync_resolve_activation_state,
            sync_access::sync_access_list,
            sync_access::sync_access_update,
            sync_access::sync_access_resolve_action,
            sync_rendezvous::sync_rendezvous_connect,
            sync_rendezvous::sync_rendezvous_status,
            sync_rendezvous::sync_rendezvous_disconnect,
            sync_rendezvous::sync_rendezvous_send,
            sync_rendezvous::sync_rendezvous_drain_events,
            sync_rendezvous::sync_rendezvous_validate_endpoint,
            sync_rendezvous::sync_adopt_discovered_endpoint,
            sync_invitation_bridge::sync_verify_discovered_device,
            sync_invitation_bridge::sync_prepare_remote_invitation,
            sync_invitation_bridge::sync_consume_remote_invitation,
            sync_cloudflare_deploy::cloudflare_deploy_workdir,
            sync_cloudflare_deploy::cloudflare_generate_secret,
            sync_cloudflare_deploy::cloudflare_probe_state,
            sync_p2p_bridge::sync_prepare_remote_candidate,
            sync_p2p_bridge::sync_consume_remote_candidate,
            sync_p2p_bridge::p2p_discover_candidate,
            sync_p2p_bridge::sync_p2p_connect,
            sync_p2p_bridge::p2p_send_frame,
            sync_p2p_bridge::p2p_drain_frames,
            sync_p2p_bridge::p2p_session_state,
            sync_remote_invitation::sync_consume_remote_invitation_cross_device,
            sync_remote_invitation::sync_export_pairing_code,
            sync_remote_invitation::sync_parse_pairing_code,
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
            ai_memory::ai_memory_detect,
            ai_memory::ai_memory_mcp_config_path,
            ai_memory::ai_memory_opencode_config_write,
            ai_memory::ai_memory_codex_config_write,
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
            recorder_scratch_dir,
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

/// Só usado pelo gravador de procedimentos e2e (`e2e/support/recorder.ts`,
/// painel `RecorderHelper`) — atalho "pular criação de projeto" pra não
/// obrigar o dono a digitar uma pasta real toda vez que só quer gravar um
/// procedimento. Mesmo padrão de `std::env::temp_dir()` já usado em dezenas
/// de outros pontos do backend (testes, `agent_events.rs`
/// etc.) — nunca exposto antes pro frontend porque nada até agora precisava.
#[tauri::command]
fn recorder_scratch_dir() -> Result<String, String> {
    let dir = std::env::temp_dir()
        .join("alethe-recorder")
        .join(format!("rec-{}", nanoid::nanoid!(8)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
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
