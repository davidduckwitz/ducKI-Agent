// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod desktop;
mod menu;
mod paths;
mod seed;
mod startup;
mod state;
mod updater;
mod win;

use std::sync::atomic::Ordering;

use tauri::{Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use crate::desktop::DesktopPrefs;
use crate::paths::AppPaths;
use crate::state::AppState;

const MINIMIZED_ARG: &str = "--minimized";

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let file_target = match AppPaths::early_logs_dir() {
        Some(path) => TargetKind::Folder {
            path,
            file_name: Some("desktop".into()),
        },
        None => TargetKind::LogDir {
            file_name: Some("desktop".into()),
        },
    };
    let level = match std::env::var("DUCKI_DESKTOP_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets([Target::new(TargetKind::Stdout), Target::new(file_target)])
        .level(level)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .build()
}

fn main() {
    let start_minimized = std::env::args().any(|arg| arg == MINIMIZED_ARG);

    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch only forwards to the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            menu::show_main_window(app);
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([MINIMIZED_ARG])
                .build(),
        )
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            log::info!(
                "Starting DucKI Node {} (minimized: {})",
                handle.package_info().version,
                start_minimized
            );
            let paths = AppPaths::resolve(&handle)?;
            paths.ensure_dirs()?;
            let prefs = DesktopPrefs::load(&paths);
            app.manage(AppState::new(paths, prefs, start_minimized));

            if let Err(e) = menu::build_tray(&handle) {
                log::error!("Tray setup failed: {}", e);
            }
            desktop::migrate_legacy_autostart(&handle);
            startup::begin(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::get_backend_url,
            desktop::get_backend_port,
            desktop::get_startup_status,
            desktop::retry_startup,
            desktop::open_logs,
            desktop::quit_app,
            desktop::desktop_info,
            desktop::desktop_set_preferences,
            desktop::desktop_open_folder,
            updater::check_update,
            updater::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            // `code == None` means "the last window was closed". While a (re)start swaps windows
            // (or the splash was dismissed early) that is transient, not a quit request - the
            // tray keeps the app reachable and the main window appears once the agent is up.
            let starting = app
                .try_state::<AppState>()
                .map(|s| s.starting.load(Ordering::SeqCst))
                .unwrap_or(false);
            if code.is_none() && starting {
                api.prevent_exit();
            }
        }
        RunEvent::Exit if app.try_state::<AppState>().is_some() => backend::stop(app),
        _ => {}
    });
}
