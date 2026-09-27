//! First-run seeding and legacy-layout migration. Everything here is additive: bundled content is
//! only ever copied to places where nothing exists yet, so user customizations survive updates.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::paths::AppPaths;

/// Written by build.js on every packaging run. Seeding is skipped entirely when the stamp in the
/// data dir matches, which turns the (potentially multi-hundred-MB) plugin copy into a no-op on
/// every launch after the first one of a given build.
const BUILD_ID_FILE: &str = "BUILD_ID";
const SEED_STAMP_FILE: &str = ".seed-stamp";
const MIGRATION_MARKER: &str = ".layout-v2-migrated";

pub struct SeedOutcome {
    pub first_run: bool,
    pub skills: usize,
    pub plugins: usize,
}

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

pub fn copy_missing_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_missing_recursive(&entry.path(), &dest_path)?;
        } else if !dest_path.exists() {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

fn subdirs(dir: &Path) -> Vec<std::fs::DirEntry> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| {
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    name != "node_modules" && !name.starts_with('.')
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by_key(|e| e.file_name());
    entries
}

pub fn count_subdirs(dir: &Path) -> usize {
    subdirs(dir).len()
}

fn build_stamp(paths: &AppPaths) -> String {
    let build_id = std::fs::read_to_string(paths.server_dist.join(BUILD_ID_FILE))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    format!("{}+{}", env!("CARGO_PKG_VERSION"), build_id)
}

/// Seeds prompts, core skills and built-in plugins. `progress` receives 0..=100 plus a message.
pub fn seed_all(paths: &AppPaths, progress: &dyn Fn(u8, String)) -> Result<SeedOutcome, String> {
    let stamp_file = paths.data_dir.join(SEED_STAMP_FILE);
    let first_run = !stamp_file.exists();
    let stamp = build_stamp(paths);
    // Debug builds get fresh resources on every `tauri dev`, so never trust the stamp there.
    let up_to_date = !cfg!(debug_assertions)
        && std::fs::read_to_string(&stamp_file)
            .map(|s| s.trim() == stamp)
            .unwrap_or(false);

    if up_to_date {
        progress(100, "Skills und Plugins sind aktuell".into());
    } else {
        let core_runtime = paths.server_dist.join("core-runtime");

        progress(2, "Prompts vorbereiten".into());
        let prompts = core_runtime.join("prompts");
        if !prompts.is_dir() {
            return Err(format!("Gebündelte Prompts fehlen: {}", prompts.display()));
        }
        copy_missing_recursive(&prompts, &paths.data_dir.join("prompts"))
            .map_err(|e| format!("Prompts konnten nicht kopiert werden: {}", e))?;

        progress(8, "Core-Skills installieren".into());
        let skills = core_runtime.join("skills");
        if !skills.is_dir() {
            return Err(format!("Gebündelte Skills fehlen: {}", skills.display()));
        }
        copy_missing_recursive(&skills, &paths.skills_dir)
            .map_err(|e| format!("Skills konnten nicht kopiert werden: {}", e))?;

        seed_builtin_plugins(paths, &|pct, msg| {
            progress((20 + u32::from(pct) * 80 / 100) as u8, msg)
        });

        if let Err(e) = std::fs::write(&stamp_file, &stamp) {
            log::warn!("Could not write seed stamp: {}", e);
        }
    }

    Ok(SeedOutcome {
        first_run,
        skills: count_subdirs(&paths.skills_dir),
        plugins: count_subdirs(&paths.plugins_dir),
    })
}

/// The built-in plugin folders are bundled read-only as a Tauri resource. Plugins need a writable
/// directory (per-plugin SQLite, encrypted settings, a freshly generated .secret-key), so each
/// bundled plugin gets copied into the user plugins dir - only if it isn't already there.
fn seed_builtin_plugins(paths: &AppPaths, progress: &dyn Fn(u8, String)) {
    let builtin_dir = paths.server_dist.join("plugins-builtin");
    let plugins = subdirs(&builtin_dir);

    // Runtime deps shared by multiple plugins are bundled ONCE into plugins-builtin/node_modules
    // (see build.js). Node walks up from a plugin dir into its parent's node_modules, so seeding
    // this shared tree as a sibling of the plugin dirs is enough for every plugin to resolve it.
    let shared_nm = builtin_dir.join("node_modules");
    if shared_nm.is_dir() {
        let packages: Vec<_> = std::fs::read_dir(&shared_nm)
            .map(|it| it.flatten().collect())
            .unwrap_or_default();
        let total = packages.len().max(1);
        let dest_nm = paths.plugins_dir.join("node_modules");
        for (index, entry) in packages.iter().enumerate() {
            progress(
                (index * 50 / total) as u8,
                format!("Laufzeit-Pakete: {}", entry.file_name().to_string_lossy()),
            );
            let dest = dest_nm.join(entry.file_name());
            let result = if entry.path().is_dir() {
                copy_missing_recursive(&entry.path(), &dest)
            } else if !dest.exists() {
                std::fs::create_dir_all(&dest_nm)
                    .and_then(|_| std::fs::copy(entry.path(), &dest).map(|_| ()))
            } else {
                Ok(())
            };
            if let Err(e) = result {
                log::warn!(
                    "Failed to seed shared plugin dep {:?}: {}",
                    entry.file_name(),
                    e
                );
            }
        }
    }

    let total = plugins.len().max(1);
    for (index, entry) in plugins.iter().enumerate() {
        let name = entry.file_name();
        progress(
            (50 + index * 50 / total) as u8,
            format!("Plugin: {}", name.to_string_lossy()),
        );
        let dest = paths.plugins_dir.join(&name);
        if dest.exists() {
            // Existing (possibly customized) install: never clobber the plugin itself, only merge
            // packaging-added runtime deps so it keeps loading after app updates.
            let bundled_nm = entry.path().join("node_modules");
            if bundled_nm.is_dir() {
                if let Err(e) = copy_missing_recursive(&bundled_nm, &dest.join("node_modules")) {
                    log::warn!("Failed to merge runtime deps into plugin {:?}: {}", name, e);
                }
            }
            continue;
        }
        match copy_dir_recursive(&entry.path(), &dest) {
            Ok(()) => log::info!("Seeded built-in plugin: {}", name.to_string_lossy()),
            Err(e) => log::warn!("Failed to seed plugin {:?}: {}", name, e),
        }
    }
    progress(100, "Plugins bereit".into());
}

fn newest_legacy_data_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let roaming = app.path().data_dir().ok()?;
    [
        "de.davidduckwitz.ducki-node",
        "de.davidduckwitz.ducki-server",
    ]
    .into_iter()
    .map(|name| roaming.join(name))
    .filter(|dir| dir.join("storage/ducki.db").is_file())
    .max_by_key(|dir| {
        [
            dir.join("storage/ducki.db-wal"),
            dir.join("storage/ducki.db"),
        ]
        .into_iter()
        .filter_map(|p| std::fs::metadata(p).ok()?.modified().ok())
        .max()
    })
}

/// Migrates the two historic per-app Roaming layouts into the shared Local layout. Runs before
/// Node opens SQLite, keeps a recoverable copy of a pre-existing v2 storage folder, and never
/// replaces bundled plugin code - only plugin data/state/secrets.
pub fn migrate_legacy_data(app: &AppHandle, paths: &AppPaths) -> Result<(), String> {
    let marker = paths.data_dir.join(MIGRATION_MARKER);
    if marker.exists() {
        return Ok(());
    }
    let Some(source) = newest_legacy_data_dir(app) else {
        std::fs::write(marker, b"no legacy data found\n").map_err(|e| e.to_string())?;
        return Ok(());
    };

    let dest_storage = paths.data_dir.join("storage");
    if dest_storage.join("ducki.db").exists() {
        let backup = paths.data_dir.join("migration-backup-v2").join("storage");
        if !backup.exists() {
            copy_dir_recursive(&dest_storage, &backup)
                .map_err(|e| format!("Sicherung des Speichers fehlgeschlagen: {}", e))?;
        }
    }
    copy_dir_recursive(&source.join("storage"), &dest_storage)
        .map_err(|e| format!("Migration aus {} fehlgeschlagen: {}", source.display(), e))?;

    let source_plugins = source.join("plugins");
    for special in [".secret-key", ".state.json"] {
        let src = source_plugins.join(special);
        if src.is_file() {
            std::fs::create_dir_all(&paths.plugins_dir).map_err(|e| e.to_string())?;
            std::fs::copy(src, paths.plugins_dir.join(special)).map_err(|e| e.to_string())?;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&source_plugins) {
        for entry in entries.flatten().filter(|e| e.path().is_dir()) {
            let data = entry.path().join("data");
            if data.is_dir() {
                copy_dir_recursive(
                    &data,
                    &paths.plugins_dir.join(entry.file_name()).join("data"),
                )
                .map_err(|e| format!("Plugin-Daten konnten nicht migriert werden: {}", e))?;
            }
        }
    }
    let old_workspace = source.join("shared-workspace");
    if old_workspace.is_dir() {
        copy_missing_recursive(&old_workspace, &paths.workspace_dir)
            .map_err(|e| format!("Workspace konnte nicht migriert werden: {}", e))?;
    }
    std::fs::write(&marker, format!("migrated from {}\n", source.display()))
        .map_err(|e| format!("Migrationsmarker konnte nicht geschrieben werden: {}", e))?;
    log::info!("Migrated legacy data from {}", source.display());
    Ok(())
}

/// In a source checkout, keep the historical apps/server/shared-workspace path working without
/// making an installed application depend on its build-machine source tree. Existing folders are
/// deliberately never replaced.
#[cfg(all(debug_assertions, windows))]
pub fn ensure_development_workspace_link(target: &Path) {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(apps_dir) = manifest.parent().and_then(Path::parent) else {
        return;
    };
    let link = apps_dir.join("server").join("shared-workspace");
    if link.exists() {
        if let Err(e) = copy_missing_recursive(&link, target) {
            log::warn!("Could not import existing development workspace: {}", e);
        }
    } else if let Err(e) = std::os::windows::fs::symlink_dir(target, &link) {
        log::warn!(
            "Could not create development workspace link {} -> {}: {}",
            link.display(),
            target.display(),
            e
        );
    }
}

#[cfg(not(all(debug_assertions, windows)))]
pub fn ensure_development_workspace_link(_target: &Path) {}
