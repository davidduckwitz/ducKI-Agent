use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Every filesystem location the desktop shell touches, resolved once at startup.
///
/// AppData (`%LOCALAPPDATA%\DucKI Node`) holds implementation details - databases, logs, runtime
/// prompts. User-facing content (workspace, skills, plugins) lives under `~/DucKI` so it stays
/// visible, stable and independent of the install location.
#[derive(Clone, Debug)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub plugins_dir: PathBuf,
    pub server_dist: PathBuf,
}

pub const DATA_DIR_NAME: &str = "DucKI Node";

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let path = app.path();
        let data_dir = path
            .local_data_dir()
            .map_err(|e| format!("Lokaler Datenordner nicht ermittelbar: {}", e))?
            .join(DATA_DIR_NAME);
        let user_root = path
            .home_dir()
            .map_err(|e| format!("Benutzerordner nicht ermittelbar: {}", e))?
            .join("DucKI");
        let server_dist = path
            .resource_dir()
            .map_err(|e| format!("Ressourcenordner nicht ermittelbar: {}", e))?
            .join("resources")
            .join("server-dist");
        Ok(Self {
            logs_dir: data_dir.join("logs"),
            data_dir,
            workspace_dir: user_root.join("shared-workspace"),
            skills_dir: user_root.join("skills"),
            plugins_dir: user_root.join("plugins"),
            server_dist,
        })
    }

    pub fn ensure_dirs(&self) -> Result<(), String> {
        for dir in [
            &self.data_dir,
            &self.logs_dir,
            &self.workspace_dir,
            &self.skills_dir,
            &self.plugins_dir,
        ] {
            std::fs::create_dir_all(dir).map_err(|e| {
                format!(
                    "Ordner {} konnte nicht angelegt werden: {}",
                    dir.display(),
                    e
                )
            })?;
        }
        Ok(())
    }

    /// The log plugin is configured before the app (and therefore the path resolver) exists.
    /// On Windows `local_data_dir()` is exactly `%LOCALAPPDATA%`, so both agree.
    pub fn early_logs_dir() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join(DATA_DIR_NAME).join("logs"))
    }
}
