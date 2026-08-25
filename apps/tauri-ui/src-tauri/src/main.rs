// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, Theme, Wry};
use tauri_plugin_shell::ShellExt;

struct UiState {
    zoom: Mutex<f64>,
}

fn navigate(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let script = format!(
            "window.history.pushState({{}}, '', '{}'); window.dispatchEvent(new PopStateEvent('popstate'));",
            path
        );
        let _ = window.eval(&script);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_theme(app: &AppHandle, theme: Option<Theme>, web_theme: &str) {
    app.set_theme(theme);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_theme(theme);
        let _ = window.eval(&format!(
            "window.dispatchEvent(new CustomEvent('ducki:set-theme', {{ detail: '{}' }}));",
            web_theme
        ));
    }
}

fn build_native_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let file = SubmenuBuilder::new(app, "&Datei")
        .text("nav_dashboard", "Dashboard")
        .text("nav_chat", "Neuer Chat")
        .text("nav_workspace", "Shared Workspace")
        .separator()
        .text("app_quit", "Beenden")
        .build()?;
    let edit = SubmenuBuilder::new(app, "&Bearbeiten")
        .text("edit_undo", "Rückgängig")
        .text("edit_redo", "Wiederholen")
        .separator()
        .cut_with_text("Ausschneiden")
        .copy_with_text("Kopieren")
        .paste_with_text("Einfügen")
        .select_all_with_text("Alles auswählen")
        .build()?;
    let view = SubmenuBuilder::new(app, "&Ansicht")
        .text("view_back", "Zurück")
        .text("view_forward", "Vorwärts")
        .text("view_reload", "Neu laden")
        .separator()
        .text("view_zoom_in", "Vergrößern")
        .text("view_zoom_out", "Verkleinern")
        .text("view_zoom_reset", "Tatsächliche Größe")
        .separator()
        .text("theme_dark", "Dunkles Erscheinungsbild")
        .text("theme_light", "Helles Erscheinungsbild")
        .text("theme_system", "Systemeinstellung verwenden")
        .separator()
        .text("view_fullscreen", "Vollbild umschalten")
        .build()?;
    let agent = SubmenuBuilder::new(app, "&Agent")
        .text("nav_settings", "Backend und Einstellungen")
        .text("nav_plugins", "Plugins")
        .text("nav_agents", "Agentenstatus")
        .text("nav_logs", "Logs")
        .separator()
        .text("agent_health", "Lokalen Systemstatus öffnen")
        .build()?;
    let help = SubmenuBuilder::new(app, "&Hilfe")
        .text("help_docs", "DucKI-Webseite")
        .text("help_about", "Über DucKI UI")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &agent, &help])
        .build()
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "nav_dashboard" => navigate(app, "/dashboard"),
        "nav_chat" => navigate(app, "/chat"),
        "nav_workspace" => navigate(app, "/shared"),
        "nav_settings" => navigate(app, "/settings"),
        "nav_plugins" => navigate(app, "/plugins"),
        "nav_agents" => navigate(app, "/agents"),
        "nav_logs" => navigate(app, "/logs"),
        "theme_dark" => set_theme(app, Some(Theme::Dark), "dark"),
        "theme_light" => set_theme(app, Some(Theme::Light), "light"),
        "theme_system" => set_theme(app, None, "system"),
        "agent_health" => {
            let _ = app.shell().open("http://127.0.0.1:3001/dashboard", None);
        }
        "help_docs" => {
            let _ = app.shell().open("https://ducki.cloud", None);
        }
        "app_quit" => app.exit(0),
        _ => {
            if let Some(window) = app.get_webview_window("main") {
                match id {
                    "view_back" => {
                        let _ = window.eval("history.back()");
                    }
                    "view_forward" => {
                        let _ = window.eval("history.forward()");
                    }
                    "view_reload" => {
                        let _ = window.eval("location.reload()");
                    }
                    "edit_undo" => {
                        let _ = window.eval("document.execCommand('undo')");
                    }
                    "edit_redo" => {
                        let _ = window.eval("document.execCommand('redo')");
                    }
                    "view_fullscreen" => {
                        let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
                    }
                    "help_about" => {
                        let _ = window
                            .eval("alert('DucKI UI 0.1.0\\nDesktop-Client für den DucKI Agent')");
                    }
                    "view_zoom_in" | "view_zoom_out" | "view_zoom_reset" => {
                        let state = app.state::<UiState>();
                        let mut zoom = state.zoom.lock().unwrap();
                        *zoom = match id {
                            "view_zoom_in" => (*zoom + 0.1).min(2.0),
                            "view_zoom_out" => (*zoom - 0.1).max(0.5),
                            _ => 1.0,
                        };
                        let _ = window.set_zoom(*zoom);
                    }
                    _ => {}
                }
            }
        }
    }
}

/// DucKI UI - a pure UI client.
///
/// Unlike `tauri-desktop` (server + UI in one process) and `tauri-server` (headless
/// agent), this app bundles NO backend and spawns NO Node sidecar. It embeds the built
/// web app (`apps/web/dist` via frontendDist) and connects to a running backend:
///
/// - By default the web app targets `http://localhost:3001` (where tauri-server /
///   tauri-desktop bind their agent). The web app detects the Tauri runtime
///   (`isDesktopApp()` in lib/backendUrl.ts) and uses absolute URLs for /api and
///   socket.io, so no proxy or redirect is needed.
/// - A different local port or a remote backend can be set in the web UI under
///   Settings -> Backend (stored in localStorage as "backend-config").
///
/// The Rust side stays deliberately minimal: one main window, external links opened via
/// the shell plugin (shell:allow-open), and window close quits the app.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(UiState { zoom: Mutex::new(1.0) })
        .menu(build_native_menu)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            #[cfg(debug_assertions)]
            println!("[TAURI] DucKI UI started (dev) - devUrl must serve the web app on :5173");
            #[cfg(not(debug_assertions))]
            println!("[TAURI] DucKI UI started (release) - connecting to backend on localhost:3001 by default");

            let _ = app.handle();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
