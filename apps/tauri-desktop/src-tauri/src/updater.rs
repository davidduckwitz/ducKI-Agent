//! Self-update: the web UI asks `check_update`, shows a banner and calls `install_update`.
//!
//! The update manifest (`latest.json`) and the signed NSIS installer live on ducki.cloud (see
//! `plugins.updater` in tauri.conf.json). The Node sidecar runs from the install directory, so it
//! has to be stopped before the installer starts - the updater plugin ends the process right after
//! launching the installer, which would skip the normal exit cleanup.

use std::path::Path;
use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::backend;
use crate::startup::{self, MAIN_LABEL};
use crate::state::AppState;

pub const PROGRESS_EVENT: &str = "update-progress";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Asks the update server whether a newer version exists.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version,
        current_version: u.current_version,
        notes: u.body,
    }))
}

/// Downloads the update (progress as `update-progress`), backs up the data, stops the agent and
/// runs the installer, which restarts the app. Only returns on failure.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Es ist kein Update verfügbar.")?;

    let mut downloaded: u64 = 0;
    let progress = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit_to(
                    MAIN_LABEL,
                    PROGRESS_EVENT,
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("Download fehlgeschlagen: {}", e))?;

    // Stop the agent (also flushes SQLite), then snapshot the data while nothing writes to it.
    let stopper = app.clone();
    tauri::async_runtime::spawn_blocking(move || backend::stop(&stopper))
        .await
        .map_err(|e| e.to_string())?;
    let state = app.state::<AppState>();
    state.starting.store(true, Ordering::SeqCst);
    let backup_dir = state
        .paths
        .data_dir
        .join("backups")
        .join(format!("vor-update-{}", app.package_info().version));
    if let Err(e) = backup_data(&state.paths.data_dir, &backup_dir) {
        log::warn!("Backup before update failed: {}", e);
    }

    log::info!("Installing update {}", update.version);
    if let Err(e) = update.install(bytes) {
        // Still here, so the installer did not take over: bring the agent back.
        state.starting.store(false, Ordering::SeqCst);
        let restarter = app.clone();
        std::thread::spawn(move || startup::restart_backend(&restarter, false));
        return Err(format!("Installation fehlgeschlagen: {}", e));
    }
    Ok(())
}

/// Copies the top-level files of the data dir (databases, settings); logs and old backups are skipped.
fn backup_data(data_dir: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(data_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.extension().is_none_or(|e| e != "log") {
            std::fs::copy(&path, target.join(entry.file_name()))?;
        }
    }
    prune_backups(target.parent());
    Ok(())
}

/// Keeps the three most recent pre-update backups.
fn prune_backups(dir: Option<&Path>) {
    let Some(dir) = dir else { return };
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("vor-update-"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in entries.into_iter().skip(3) {
        let _ = std::fs::remove_dir_all(path);
    }
}
