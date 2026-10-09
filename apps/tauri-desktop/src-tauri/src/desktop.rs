//! Desktop-only preferences and the commands the web UI / splash call through `invoke`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_opener::OpenerExt;

use crate::backend;
use crate::paths::AppPaths;
use crate::startup::{self, StartupStatus};
use crate::state::AppState;

const PREFS_FILE: &str = "desktop-settings.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopPrefs {
    /// Closing the window hides it to the tray; the agent keeps running.
    pub close_to_tray: bool,
    pub show_splash: bool,
    /// Look for a new desktop version on startup (the UI shows a banner; nothing installs unasked).
    pub auto_update_check: bool,
    /// Periodic background check while the app runs: "off", "hourly" or "daily".
    pub update_interval: String,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            show_splash: true,
            auto_update_check: true,
            update_interval: "daily".into(),
        }
    }
}

impl DesktopPrefs {
    pub fn load(paths: &AppPaths) -> Self {
        std::fs::read_to_string(paths.data_dir.join(PREFS_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(&self, paths: &AppPaths) -> Result<(), String> {
        std::fs::create_dir_all(&paths.data_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(paths.data_dir.join(PREFS_FILE), json).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderKind {
    Workspace,
    Data,
    Logs,
    Plugins,
    Skills,
}

pub fn open_folder(app: &AppHandle, kind: FolderKind) -> Result<(), String> {
    let paths = &app.state::<AppState>().paths;
    let dir = match kind {
        FolderKind::Workspace => &paths.workspace_dir,
        FolderKind::Data => &paths.data_dir,
        FolderKind::Logs => &paths.logs_dir,
        FolderKind::Plugins => &paths.plugins_dir,
        FolderKind::Skills => &paths.skills_dir,
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn is_autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

pub fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())?;
    crate::menu::sync_autostart_item(app, enabled);
    log::info!("Autostart {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// Versions up to 0.1.x wrote the Run key without `--minimized`. Re-registering through the
/// plugin rewrites the same value (it uses the product name) with the current path and args.
pub fn migrate_legacy_autostart(app: &AppHandle) {
    if is_autostart_enabled(app) {
        if let Err(e) = app.autolaunch().enable() {
            log::warn!("Could not refresh autostart entry: {}", e);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    version: String,
    port: u16,
    backend_url: String,
    data_dir: String,
    logs_dir: String,
    workspace_dir: String,
    plugins_dir: String,
    skills_dir: String,
    autostart: bool,
    close_to_tray: bool,
    show_splash: bool,
    auto_update_check: bool,
    update_interval: String,
}

fn desktop_info_for(app: &AppHandle) -> DesktopInfo {
    let state = app.state::<AppState>();
    let prefs = state.prefs.lock().unwrap().clone();
    let paths = &state.paths;
    let port = backend::current_port(app);
    DesktopInfo {
        version: app.package_info().version.to_string(),
        port,
        backend_url: format!("http://127.0.0.1:{}", port),
        data_dir: paths.data_dir.to_string_lossy().into(),
        logs_dir: paths.logs_dir.to_string_lossy().into(),
        workspace_dir: paths.workspace_dir.to_string_lossy().into(),
        plugins_dir: paths.plugins_dir.to_string_lossy().into(),
        skills_dir: paths.skills_dir.to_string_lossy().into(),
        autostart: is_autostart_enabled(app),
        close_to_tray: prefs.close_to_tray,
        show_splash: prefs.show_splash,
        auto_update_check: prefs.auto_update_check,
        update_interval: prefs.update_interval,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefsPatch {
    autostart: Option<bool>,
    close_to_tray: Option<bool>,
    show_splash: Option<bool>,
    auto_update_check: Option<bool>,
    update_interval: Option<String>,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle) -> DesktopInfo {
    desktop_info_for(&app)
}

#[tauri::command]
pub fn desktop_set_preferences(
    app: AppHandle,
    patch: DesktopPrefsPatch,
) -> Result<DesktopInfo, String> {
    if let Some(enabled) = patch.autostart {
        set_autostart(&app, enabled)?;
    }
    {
        let state = app.state::<AppState>();
        let mut prefs = state.prefs.lock().unwrap();
        if let Some(value) = patch.close_to_tray {
            prefs.close_to_tray = value;
        }
        if let Some(value) = patch.show_splash {
            prefs.show_splash = value;
        }
        if let Some(value) = patch.auto_update_check {
            prefs.auto_update_check = value;
        }
        if let Some(value) = patch.update_interval {
            if matches!(value.as_str(), "off" | "hourly" | "daily") {
                prefs.update_interval = value;
            }
        }
        prefs.save(&state.paths)?;
    }
    Ok(desktop_info_for(&app))
}

#[tauri::command]
pub fn desktop_open_folder(app: AppHandle, kind: FolderKind) -> Result<(), String> {
    open_folder(&app, kind)
}

#[tauri::command]
pub fn get_startup_status(state: State<'_, AppState>) -> StartupStatus {
    state.startup.lock().unwrap().clone()
}

#[tauri::command]
pub fn retry_startup(app: AppHandle) {
    startup::begin(&app);
}

#[tauri::command]
pub fn open_logs(app: AppHandle) -> Result<(), String> {
    open_folder(&app, FolderKind::Logs)
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn get_backend_port(app: AppHandle) -> u16 {
    backend::current_port(&app)
}

#[tauri::command]
pub fn get_backend_url(app: AppHandle) -> String {
    format!("http://127.0.0.1:{}", backend::current_port(&app))
}
