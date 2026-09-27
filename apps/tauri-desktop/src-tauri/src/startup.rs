//! Startup orchestration: splash window → migrate → seed → agent → main window.
//!
//! Progress is published both as an event (`startup://progress`) and as state the splash can pull
//! with `get_startup_status`, so a splash that loads after the first events still renders the
//! current phase instead of an empty bar.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::backend;
use crate::seed;
use crate::state::AppState;

pub const PROGRESS_EVENT: &str = "startup://progress";
pub const SPLASH_LABEL: &str = "splash";
pub const MAIN_LABEL: &str = "main";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStats {
    pub version: String,
    pub skills: usize,
    pub plugins: usize,
    pub port: u16,
    pub first_run: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// prepare | migrate | seed | agent | ready | error
    pub phase: String,
    pub progress: u8,
    pub message: String,
    pub error: Option<String>,
    pub ready: bool,
    pub stats: StartupStats,
}

fn publish(app: &AppHandle, update: impl FnOnce(&mut StartupStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut status = state.startup.lock().unwrap();
        update(&mut status);
        status.clone()
    };
    let _ = app.emit_to(SPLASH_LABEL, PROGRESS_EVENT, snapshot);
}

fn report(app: &AppHandle, phase: &str, progress: u8, message: impl Into<String>) {
    let message = message.into();
    publish(app, |s| {
        s.phase = phase.to_string();
        // Never move backwards within a run - phases hand over at fixed boundaries.
        s.progress = s.progress.max(progress.min(100));
        s.message = message;
    });
}

/// Maps a sub-step's own 0..=100 onto the global range [from, to].
fn scaled(from: u8, to: u8, pct: u8) -> u8 {
    (u32::from(from) + (u32::from(to) - u32::from(from)) * u32::from(pct.min(100)) / 100) as u8
}

pub fn show_splash(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == SPLASH_LABEL)
        .cloned()
    else {
        return;
    };
    match WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(_) => {}
        Err(e) => log::error!("Could not create splash window: {}", e),
    }
}

fn close_splash(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        let _ = window.destroy();
    }
}

/// Runs the full startup sequence on a background thread.
pub fn begin(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let mut status = state.startup.lock().unwrap();
        *status = StartupStatus {
            phase: "prepare".into(),
            message: "DucKI wird geweckt …".into(),
            stats: StartupStats {
                version: app.package_info().version.to_string(),
                ..Default::default()
            },
            ..Default::default()
        };
    }
    let show_splash_window = !state.start_minimized && state.prefs.lock().unwrap().show_splash;
    if show_splash_window && app.get_webview_window(MAIN_LABEL).is_none() {
        show_splash(app);
    }

    let app = app.clone();
    thread::spawn(move || {
        let result = run(&app);
        let state = app.state::<AppState>();
        state.starting.store(false, Ordering::SeqCst);
        if let Err(error) = result {
            log::error!("Startup failed: {}", error);
            publish(&app, |s| {
                s.phase = "error".into();
                s.error = Some(error.clone());
                s.message = "Start fehlgeschlagen".into();
            });
            // A failure must always be visible, even for a minimized autostart.
            if app.get_webview_window(MAIN_LABEL).is_none() {
                show_splash(&app);
            }
            backend::notify(
                &app,
                "DucKI Node konnte nicht gestartet werden – Details im Startfenster.",
            );
        }
    });
}

fn run(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let paths = state.paths.clone();

    report(app, "prepare", 2, "Arbeitsverzeichnisse vorbereiten");
    paths.ensure_dirs()?;
    seed::ensure_development_workspace_link(&paths.workspace_dir);

    report(app, "migrate", 5, "Ältere Daten übernehmen");
    seed::migrate_legacy_data(app, &paths)?;

    let outcome = seed::seed_all(&paths, &|pct, msg| {
        report(app, "seed", scaled(8, 45, pct), msg)
    })?;
    publish(app, |s| {
        s.stats.skills = outcome.skills;
        s.stats.plugins = outcome.plugins;
        s.stats.first_run = outcome.first_run;
    });

    let port = backend::start(app, &|pct, msg| {
        report(app, "agent", scaled(46, 98, pct), msg)
    })?;
    publish(app, |s| {
        s.stats.port = port;
        s.phase = "ready".into();
        s.progress = 100;
        s.ready = true;
        s.message = "Bereit – quak!".into();
    });

    // Give the splash a moment to play its "ready" animation before the UI takes over.
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        thread::sleep(Duration::from_millis(900));
    }
    open_main_window(app, port, !state.start_minimized)?;
    close_splash(app);

    if state.start_minimized {
        backend::notify(app, &format!("Agent läuft im Hintergrund (Port {})", port));
    }
    Ok(())
}

/// Called after an in-app restart. Rebuilds the main window when the port changed, because the
/// injected port is baked into its initialization script.
pub fn restart_backend(app: &AppHandle, announce: bool) {
    let state = app.state::<AppState>();
    if state.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous_port = backend::current_port(app);
    backend::stop(app);
    let result = backend::start(app, &|_, _| {});
    // `starting` stays set until the window swap below is done: ExitRequested treats "no windows
    // left" as a quit unless a (re)start is in progress.
    match result {
        Ok(port) => {
            if port != previous_port {
                if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                    let visible = window.is_visible().unwrap_or(true);
                    let _ = window.destroy();
                    if let Err(e) = open_main_window(app, port, visible) {
                        log::error!("Could not recreate main window: {}", e);
                    }
                }
            }
            if announce {
                backend::notify(app, "Agent wurde neu gestartet");
            }
        }
        Err(e) => {
            log::error!("Restart failed: {}", e);
            backend::notify(
                app,
                &format!(
                    "Neustart fehlgeschlagen: {}",
                    e.lines().next().unwrap_or_default()
                ),
            );
        }
    }
    state.starting.store(false, Ordering::SeqCst);
}

fn init_script(app: &AppHandle, port: u16) -> String {
    format!(
        "window.__DUCKI_DESKTOP__ = Object.freeze({{ port: {}, version: {:?}, platform: {:?} }});",
        port,
        app.package_info().version.to_string(),
        std::env::consts::OS
    )
}

pub fn open_main_window(
    app: &AppHandle,
    port: u16,
    visible: bool,
) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        if visible {
            crate::menu::show_main_window(app);
        }
        return Ok(window);
    }
    let menu = crate::menu::build_native_menu(app).map_err(|e| e.to_string())?;
    let window = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("DucKI Node")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(8, 11, 20, 255))
        .initialization_script(init_script(app, port))
        .menu(menu)
        .visible(visible)
        .build()
        .map_err(|e| format!("Hauptfenster konnte nicht erstellt werden: {}", e))?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let state = handle.state::<AppState>();
            if state.prefs.lock().unwrap().close_to_tray {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
                    let _ = window.hide();
                }
            }
        }
    });
    if visible {
        let _ = window.set_focus();
    }
    Ok(window)
}
