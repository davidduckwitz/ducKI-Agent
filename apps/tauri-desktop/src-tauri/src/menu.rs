//! Native window menu and system tray.

use std::thread;

use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Theme, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::backend;
use crate::desktop::{self, FolderKind};
use crate::startup::{self, MAIN_LABEL};
use crate::state::AppState;

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        // Still starting (or failed): the splash is the only meaningful surface.
        startup::show_splash(app);
    }
}

/// Client-side navigation inside the SPA. `path` is always one of our own constants.
fn navigate_main(app: &AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(format!(
            "window.history.pushState({{}}, '', {:?}); window.dispatchEvent(new PopStateEvent('popstate'));",
            path
        ));
    }
    show_main_window(app);
}

fn dispatch_to_ui(app: &AppHandle, event: &str, detail: &str) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent({:?}, {{ detail: {:?} }}));",
            event, detail
        ));
    }
}

fn open_setup_wizard(app: &AppHandle) {
    dispatch_to_ui(app, "ducki:open-setup", "");
    show_main_window(app);
}

fn set_app_theme(app: &AppHandle, theme: Option<Theme>, web_theme: &str) {
    app.set_theme(theme);
    dispatch_to_ui(app, "ducki:set-theme", web_theme);
}

fn restart_in_background(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || startup::restart_backend(&app, true));
}

pub fn build_native_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let package = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some("DucKI Node"))
        .version(Some(package.version.to_string()))
        .authors(Some(vec![package.authors.to_string()]))
        .comments(Some(
            "Lokaler KI-Agent mit Web-UI, Skills, Plugins, Memory und LLM-Wiki.",
        ))
        .website(Some("https://ducki.cloud"))
        .website_label(Some("ducki.cloud"))
        .icon(app.default_window_icon().cloned())
        .build();

    let file = SubmenuBuilder::new(app, "&Datei")
        .text("nav_dashboard", "Dashboard")
        .text("nav_chat", "Neuer Chat")
        .text("nav_workspace", "Shared Workspace")
        .separator()
        .text("open_workspace", "Workspace im Explorer öffnen")
        .text("open_data", "Daten und Logs öffnen")
        .separator()
        .text("app_quit", "Beenden")
        .build()?;
    let edit = SubmenuBuilder::new(app, "&Bearbeiten")
        .undo_with_text("Rückgängig")
        .redo_with_text("Wiederholen")
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
        .text("nav_setup", "Setup-Assistent …")
        .text("nav_settings", "Einstellungen")
        .text("nav_plugins", "Plugins")
        .text("nav_agents", "Agentenstatus")
        .text("nav_logs", "Logs")
        .separator()
        .text("agent_restart", "Agent neu starten")
        .text("agent_health", "Systemstatus im Browser öffnen")
        .build()?;
    let help = SubmenuBuilder::new(app, "&Hilfe")
        .text("help_docs", "DucKI-Webseite")
        .text("open_logs", "Desktop-Logs öffnen")
        .separator()
        .about_with_text("Über DucKI Node", Some(about))
        .build()?;
    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &agent, &help])
        .build()
}

/// Shared by the window menu and the tray menu.
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main_window(app),
        "nav_dashboard" => navigate_main(app, "/dashboard"),
        "nav_chat" => navigate_main(app, "/chat"),
        "nav_workspace" => navigate_main(app, "/shared"),
        "nav_settings" => navigate_main(app, "/settings"),
        "nav_plugins" => navigate_main(app, "/plugins"),
        "nav_agents" => navigate_main(app, "/agents"),
        "nav_logs" | "logs" => navigate_main(app, "/logs"),
        "nav_setup" => open_setup_wizard(app),
        "theme_dark" => set_app_theme(app, Some(Theme::Dark), "dark"),
        "theme_light" => set_app_theme(app, Some(Theme::Light), "light"),
        "theme_system" => set_app_theme(app, None, "system"),
        "open_workspace" => {
            let _ = desktop::open_folder(app, FolderKind::Workspace);
        }
        "open_data" | "data" => {
            let _ = desktop::open_folder(app, FolderKind::Data);
        }
        "open_logs" => {
            let _ = desktop::open_folder(app, FolderKind::Logs);
        }
        "agent_restart" | "restart" => restart_in_background(app),
        "agent_health" => {
            let url = format!("http://127.0.0.1:{}/dashboard", backend::current_port(app));
            let _ = app.opener().open_url(url, None::<&str>);
        }
        "help_docs" => {
            let _ = app.opener().open_url("https://ducki.cloud", None::<&str>);
        }
        "autostart" => {
            let state = app.state::<AppState>();
            let checked = state
                .autostart_item
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|item| item.is_checked().ok())
                .unwrap_or(false);
            if let Err(e) = desktop::set_autostart(app, checked) {
                log::warn!("Autostart toggle failed: {}", e);
            }
        }
        "app_quit" | "quit" => app.exit(0),
        _ => {
            let Some(window) = app.get_webview_window(MAIN_LABEL) else {
                return;
            };
            match id {
                "view_back" => {
                    let _ = window.eval("history.back()");
                }
                "view_forward" => {
                    let _ = window.eval("history.forward()");
                }
                "view_reload" => {
                    let _ = window.reload();
                }
                "view_fullscreen" => {
                    let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
                }
                "view_zoom_in" | "view_zoom_out" | "view_zoom_reset" => {
                    let state = app.state::<AppState>();
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

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Mit Windows starten")
        .checked(desktop::is_autostart_enabled(app))
        .build(app)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "DucKI öffnen").build(app)?)
        .item(&MenuItemBuilder::with_id("nav_chat", "Neuer Chat").build(app)?)
        .item(&MenuItemBuilder::with_id("nav_setup", "Setup-Assistent …").build(app)?)
        .item(&separator()?)
        .item(&MenuItemBuilder::with_id("restart", "Agent neu starten").build(app)?)
        .item(&MenuItemBuilder::with_id("logs", "Log-Anzeige öffnen").build(app)?)
        .item(&MenuItemBuilder::with_id("data", "Datenordner öffnen").build(app)?)
        .item(&separator()?)
        .item(&MenuItemBuilder::with_id("theme_dark", "Dunkles Erscheinungsbild").build(app)?)
        .item(&MenuItemBuilder::with_id("theme_light", "Helles Erscheinungsbild").build(app)?)
        .item(&MenuItemBuilder::with_id("theme_system", "Systemeinstellung").build(app)?)
        .item(&separator()?)
        .item(&autostart_item)
        .item(&separator()?)
        .item(&MenuItemBuilder::with_id("quit", "Beenden").build(app)?)
        .build()?;

    let state = app.state::<AppState>();
    *state.autostart_item.lock().unwrap() = Some(autostart_item);

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("DucKI Node – startet …")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // No tray-level on_menu_event: in Tauri 2 it registers a *global* menu listener, so it
        // would run every item twice alongside the app-wide handler in main.rs.
        .on_tray_icon_event(|tray, event| {
            // Only react to a completed LEFT click. Reacting to right-clicks too stole focus
            // right as the native context menu opened, which made Windows dismiss it again.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    *state.tray.lock().unwrap() = Some(tray);
    Ok(())
}

pub fn update_tray_tooltip(app: &AppHandle, status: &str, port: u16) {
    let text = match status {
        "running" => format!("DucKI Node – läuft (Port {})", port),
        "restarting" => "DucKI Node – startet neu …".to_string(),
        "stopping" => "DucKI Node – wird beendet …".to_string(),
        "crashed" => "DucKI Node – Agent gestoppt (Fehler)".to_string(),
        other => format!("DucKI Node – {}", other),
    };
    if let Some(tray) = app.state::<AppState>().tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(text));
    }
}

pub fn sync_autostart_item(app: &AppHandle, enabled: bool) {
    if let Some(item) = app
        .state::<AppState>()
        .autostart_item
        .lock()
        .unwrap()
        .as_ref()
    {
        let _ = item.set_checked(enabled);
    }
}
