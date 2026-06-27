mod agent_cost;
mod agent_events;
mod activity_stats;
mod agent_library;
mod backup;
mod claude_sessions;
mod claude_usage;
mod cli_resolver;
mod codex_sessions;
mod crash_watch;
mod codex_usage;
mod diagnostics;
mod discord_presence;
mod economy_agents;
mod filesystem;
mod git_control;
mod github_sync;
mod logging;
mod paths;
mod projects;
mod profiles;
mod pty;
mod session_watcher;
mod spotify;
mod stats;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::pty::{PtySession, PtySessions};
#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();
    // Instala o panic hook cedo (antes do builder). O diretório de logs só é
    // resolvido no .setup(); panics anteriores a isso caem só no stderr.
    logging::install_panic_hook();
    let sessions: PtySessions = Arc::new(Mutex::new(HashMap::<String, PtySession>::new()));
    let sessions_for_exit = Arc::clone(&sessions);

    tauri::Builder::default()
        .manage(sessions)
        .manage(filesystem::FileWatchers::default())
        .manage(discord_presence::DiscordPresence::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("(DEV) Alethe");
            }
            logging::set_logs_dir(app.handle());
            // Detecta saída suja anterior (crash/OOM/kill) e sobe o heartbeat.
            crash_watch::start(app.handle().clone());
            // Limpa scrollback órfão antes de qualquer spawn (sem corrida).
            pty::cleanup_orphan_scrollback(app.handle());
            agent_events::start_listener(app.handle().clone());
            session_watcher::start_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_events::agent_hooks_settings_path,
            agent_events::agent_hooks_endpoint,
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
            filesystem::watch_file,
            filesystem::unwatch_file,
            pty::spawn_pty,
            pty::attach_pty,
            pty::restart_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::get_pty_cwd,
            pty::list_pty_processes,
            projects::load_projects,
            projects::save_projects,
            profiles::list_profiles,
            profiles::get_active_profile,
            profiles::set_active_profile,
            profiles::create_profile,
            profiles::rename_profile,
            profiles::delete_profile,
            cli_resolver::find_cli_launcher,
            backup::export_backup,
            backup::import_backup,
            github_sync::github_sync_status,
            github_sync::github_sync_set_token,
            github_sync::github_sync_logout,
            github_sync::github_sync_push,
            github_sync::github_sync_pull,
            git_control::git_status,
            git_control::git_stage,
            git_control::git_unstage,
            git_control::git_discard,
            git_control::git_commit,
            git_control::git_push,
            git_control::git_pull,
            diagnostics::open_data_folder,
            diagnostics::open_spawn_log,
            diagnostics::open_in_file_explorer,
            diagnostics::open_in_vscode,
            diagnostics::open_in_browser,
            diagnostics::read_clipboard_text,
            diagnostics::write_clipboard_text,
            diagnostics::reset_app_data,
            diagnostics::open_logs_folder,
            diagnostics::export_logs,
            logging::record_frontend_error,
            discord_presence::set_discord_presence,
            discord_presence::clear_discord_presence,
            stats::get_memory_stats,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_status,
            spotify::spotify_get_current,
            claude_sessions::snapshot_claude_sessions,
            claude_sessions::list_claude_sessions,
            claude_sessions::get_claude_activity,
            codex_sessions::snapshot_codex_sessions,
            claude_usage::get_claude_usage,
            codex_usage::get_codex_usage,
            agent_cost::get_session_cost,
            agent_cost::get_transcript_cost,
            agent_cost::get_model_pricing,
            crash_watch::get_last_crash_report,
            ping,
        ])
        .build(tauri::generate_context!())
        .expect("error while building alethe")
        .run(move |_app_handle, event| {
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
