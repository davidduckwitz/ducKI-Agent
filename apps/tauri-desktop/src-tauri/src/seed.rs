//! Seeding of bundled content (prompts, core skills, built-in plugins) and legacy-layout migration.
//!
//! A manifest (`.seed-manifest.json` in the data dir) records the hash of every file seeding
//! installed. On an update, files the user never touched get the new version, files the user
//! edited are kept, and files or whole skills/plugins the user deleted stay deleted.

use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::paths::AppPaths;

/// Written by build.js on every packaging run. Seeding is skipped entirely when the stamp in the
/// data dir matches, which turns the (potentially multi-hundred-MB) plugin copy into a no-op on
/// every launch after the first one of a given build.
const BUILD_ID_FILE: &str = "BUILD_ID";
const SEED_STAMP_FILE: &str = ".seed-stamp";
const MIGRATION_MARKER: &str = ".layout-v2-migrated";
const SEED_MANIFEST_FILE: &str = ".seed-manifest.json";

/// "<area>/<relative path>" -> hash of the bundled content seeding last installed there.
type Manifest = std::collections::BTreeMap<String, String>;

/// FNV-1a: stable across Rust versions (unlike DefaultHasher), which the manifest relies on.
fn content_hash(path: &Path) -> std::io::Result<String> {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in std::fs::read(path)? {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    Ok(format!("{:016x}", hash))
}

struct Sync<'a> {
    old: &'a Manifest,
    new: Manifest,
    /// Pre-manifest installs: differing files are copied here before being replaced.
    backup_dir: std::path::PathBuf,
}

impl Sync<'_> {
    /// Brings `dest` up to date with `src` (see module docs). `skip` filters top-level names.
    fn tracked(
        &mut self,
        src: &Path,
        dest: &Path,
        key: &str,
        skip: &dyn Fn(&str) -> bool,
    ) -> std::io::Result<()> {
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if skip(&name) {
                continue;
            }
            let (src_path, dest_path, entry_key) =
                (entry.path(), dest.join(&name), format!("{}/{}", key, name));
            if entry.file_type()?.is_dir() {
                let prefix = format!("{}/", entry_key);
                if !dest_path.exists() && self.old.keys().any(|k| k.starts_with(&prefix)) {
                    // A whole skill/plugin/folder the user removed: keep it removed.
                    for (k, v) in self
                        .old
                        .range(prefix.clone()..)
                        .take_while(|(k, _)| k.starts_with(&prefix))
                    {
                        self.new.insert(k.clone(), v.clone());
                    }
                    continue;
                }
                self.tracked(&src_path, &dest_path, &entry_key, &|_| false)?;
                continue;
            }
            let shipped = content_hash(&src_path)?;
            let previous = self.old.get(&entry_key);
            if !dest_path.exists() {
                if let Some(previous) = previous {
                    self.new.insert(entry_key, previous.clone()); // deleted by the user
                    continue;
                }
            } else {
                let current = content_hash(&dest_path)?;
                if current == shipped {
                    self.new.insert(entry_key, shipped);
                    continue;
                }
                match previous {
                    Some(previous) if *previous != current => {
                        log::info!("Keeping customized {}", entry_key);
                        self.new.insert(entry_key, previous.clone());
                        continue;
                    }
                    Some(_) => {}
                    None => {
                        let backup = self.backup_dir.join(&entry_key);
                        if let Some(parent) = backup.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::copy(&dest_path, backup)?;
                    }
                }
            }
            if let Some(parent) = dest_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&src_path, &dest_path)?;
            self.new.insert(entry_key, shipped);
        }
        Ok(())
    }
}

/// Runtime dependencies nobody edits: copied whenever size or timestamp differ
/// (`fs::copy` keeps the timestamp on Windows, so unchanged files are skipped cheaply).
fn sync_managed(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            sync_managed(&entry.path(), &dest_path)?;
            continue;
        }
        let shipped = entry.metadata()?;
        let current = std::fs::metadata(&dest_path).ok();
        let same = current.is_some_and(|c| {
            c.len() == shipped.len() && c.modified().ok() == shipped.modified().ok()
        });
        if !same {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

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
        let manifest_file = paths.data_dir.join(SEED_MANIFEST_FILE);
        let old: Manifest = std::fs::read_to_string(&manifest_file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let mut sync = Sync {
            old: &old,
            new: Manifest::new(),
            backup_dir: paths
                .data_dir
                .join("backups")
                .join(format!("seed-{}", stamp.replace(['+', ':'], "_"))),
        };

        progress(2, "Prompts vorbereiten".into());
        let prompts = core_runtime.join("prompts");
        if !prompts.is_dir() {
            return Err(format!("Gebündelte Prompts fehlen: {}", prompts.display()));
        }
        sync.tracked(
            &prompts,
            &paths.data_dir.join("prompts"),
            "prompts",
            &|_| false,
        )
        .map_err(|e| format!("Prompts konnten nicht kopiert werden: {}", e))?;

        progress(8, "Core-Skills installieren".into());
        let skills = core_runtime.join("skills");
        if !skills.is_dir() {
            return Err(format!("Gebündelte Skills fehlen: {}", skills.display()));
        }
        sync.tracked(&skills, &paths.skills_dir, "skills", &|_| false)
            .map_err(|e| format!("Skills konnten nicht kopiert werden: {}", e))?;

        seed_builtin_plugins(paths, &mut sync, &|pct, msg| {
            progress((20 + u32::from(pct) * 80 / 100) as u8, msg)
        });

        // Written last: a failed run must not record versions it never installed.
        let manifest = serde_json::to_string_pretty(&sync.new).unwrap_or_default();
        if let Err(e) = std::fs::write(&manifest_file, manifest) {
            log::warn!("Could not write seed manifest: {}", e);
        }
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
/// bundled plugin is synced into the user plugins dir: code via the manifest (see module docs),
/// runtime deps as managed files, and the plugin's data/ is never touched.
fn seed_builtin_plugins(paths: &AppPaths, sync: &mut Sync, progress: &dyn Fn(u8, String)) {
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
                sync_managed(&entry.path(), &dest)
            } else {
                std::fs::create_dir_all(&dest_nm)
                    .and_then(|_| std::fs::copy(entry.path(), &dest).map(|_| ()))
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
        let key = format!("plugins/{}", name.to_string_lossy());
        let prefix = format!("{}/", key);
        if !dest.exists() && sync.old.keys().any(|k| k.starts_with(&prefix)) {
            // Uninstalled by the user: keep it that way (and keep remembering it).
            for (k, v) in sync
                .old
                .range(prefix.clone()..)
                .take_while(|(k, _)| k.starts_with(&prefix))
            {
                sync.new.insert(k.clone(), v.clone());
            }
            continue;
        }
        // data/ is runtime state (never ship the build machine's); node_modules are managed deps.
        let result = sync
            .tracked(&entry.path(), &dest, &key, &|n| {
                n == "data" || n == "node_modules"
            })
            .and_then(|_| {
                let bundled_nm = entry.path().join("node_modules");
                if bundled_nm.is_dir() {
                    sync_managed(&bundled_nm, &dest.join("node_modules"))
                } else {
                    Ok(())
                }
            });
        if let Err(e) = result {
            log::warn!("Failed to sync built-in plugin {:?}: {}", name, e);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn sync(src: &Path, dest: &Path, backup: &Path, old: &Manifest) -> Manifest {
        let mut sync = Sync {
            old,
            new: Manifest::new(),
            backup_dir: backup.to_path_buf(),
        };
        sync.tracked(src, dest, "skills", &|_| false).unwrap();
        sync.new
    }

    #[test]
    fn updates_untouched_keeps_edits_and_respects_deletions() {
        let root = std::env::temp_dir().join(format!("ducki-seed-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (src, dest, backup) = (root.join("src"), root.join("dest"), root.join("backup"));

        // v1 shipped and seeded; a pre-manifest install with an older, differing file.
        write(&src.join("a/SKILL.md"), "a v1");
        write(&src.join("b/SKILL.md"), "b v1");
        write(&src.join("c/SKILL.md"), "c v1");
        write(&dest.join("c/SKILL.md"), "c legacy");
        let v1 = sync(&src, &dest, &backup, &Manifest::new());
        assert_eq!(read(&dest.join("a/SKILL.md")), "a v1");
        assert_eq!(read(&dest.join("c/SKILL.md")), "c v1");
        assert_eq!(read(&backup.join("skills/c/SKILL.md")), "c legacy");

        // User edits a, deletes skill b entirely.
        write(&dest.join("a/SKILL.md"), "a edited");
        std::fs::remove_dir_all(dest.join("b")).unwrap();

        // v2 changes every file and adds a file to the deleted skill.
        write(&src.join("a/SKILL.md"), "a v2");
        write(&src.join("b/SKILL.md"), "b v2");
        write(&src.join("b/extra.md"), "new");
        write(&src.join("c/SKILL.md"), "c v2");
        let v2 = sync(&src, &dest, &backup, &v1);
        assert_eq!(read(&dest.join("a/SKILL.md")), "a edited");
        assert!(!dest.join("b").exists());
        assert_eq!(read(&dest.join("c/SKILL.md")), "c v2");

        // The edit is still recognized one update later; the deletion is still remembered.
        write(&src.join("a/SKILL.md"), "a v3");
        sync(&src, &dest, &backup, &v2);
        assert_eq!(read(&dest.join("a/SKILL.md")), "a edited");
        assert!(!dest.join("b").exists());

        let _ = std::fs::remove_dir_all(&root);
    }
}
