// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Theme, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const AUTOSTART_REGISTRY_NAME: &str = "DucKI Node";

struct AppState {
    actual_port: Mutex<u16>,
    is_running: Mutex<bool>,
    child: Mutex<Option<CommandChild>>,
    autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    agent_lock: Mutex<Option<AgentMutexHandle>>,
    owns_backend: Mutex<bool>,
    zoom: Mutex<f64>,
}

struct AgentMutexHandle(isize);

impl Drop for AgentMutexHandle {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            #[link(name = "kernel32")]
            extern "system" {
                fn CloseHandle(handle: isize) -> i32;
            }
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn is_ducki_backend_running(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", port).parse().unwrap(),
        Duration::from_millis(400),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
        && response.contains("\"version\"")
}

fn app_data_and_workspace(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let app_data_dir = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Failed to resolve local data dir: {}", e))?
        .join("DucKI Node");
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    // User-authored files belong in a visible, stable location. AppData remains reserved for
    // databases, logs, plugins and other implementation details.
    let shared_workspace_path = app
        .path()
        .home_dir()
        .map_err(|e| format!("Failed to resolve user home: {}", e))?
        .join("DucKI")
        .join("shared-workspace");
    std::fs::create_dir_all(&shared_workspace_path)
        .map_err(|e| format!("Failed to create shared-workspace dir: {}", e))?;
    ensure_development_workspace_link(&shared_workspace_path);
    Ok((app_data_dir, shared_workspace_path))
}

/// In a source checkout, keep the historical apps/server/shared-workspace path working without
/// making an installed application depend on its build-machine source tree. Existing folders are
/// deliberately never replaced.
#[cfg(all(debug_assertions, target_os = "windows"))]
fn ensure_development_workspace_link(target: &std::path::Path) {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(apps_dir) = manifest.parent().and_then(std::path::Path::parent) else {
        return;
    };
    let link = apps_dir.join("server").join("shared-workspace");
    if link.exists() {
        // Preserve an existing checkout workspace: copy only files missing at the new canonical
        // location. Never rename or replace a directory that may contain user work.
        if let Err(e) = copy_missing_recursive(&link, target) {
            eprintln!(
                "[TAURI] Could not import existing development workspace: {}",
                e
            );
        }
    } else if let Err(e) = std::os::windows::fs::symlink_dir(target, &link) {
        eprintln!(
            "[TAURI] Could not create development workspace link {} -> {}: {}",
            link.display(),
            target.display(),
            e
        );
    }
}

#[cfg(not(all(debug_assertions, target_os = "windows")))]
fn ensure_development_workspace_link(_target: &std::path::Path) {}

#[cfg(target_os = "windows")]
fn acquire_agent_lock(_app: &AppHandle) -> Result<Option<AgentMutexHandle>, String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            attributes: *const std::ffi::c_void,
            initial_owner: i32,
            name: *const u16,
        ) -> isize;
        fn GetLastError() -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    let name: Vec<u16> = "Local\\DucKINode.Agent.v1\0".encode_utf16().collect();
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle == 0 {
            return Err("CreateMutexW failed".to_string());
        }
        if GetLastError() == 183 {
            CloseHandle(handle);
            Ok(None)
        } else {
            Ok(Some(AgentMutexHandle(handle)))
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn acquire_agent_lock(_app: &AppHandle) -> Result<Option<AgentMutexHandle>, String> {
    Ok(Some(AgentMutexHandle(1)))
}

fn release_agent_lock(state: &AppState) {
    state.agent_lock.lock().unwrap().take();
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
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

fn copy_missing_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
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

fn seed_core_runtime(app: &AppHandle, app_data_dir: &std::path::Path) -> Result<(), String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let source_root = resource_dir.join("resources/server-dist/core-runtime");
    for name in ["prompts", "skills"] {
        let source = source_root.join(name);
        if !source.is_dir() {
            return Err(format!(
                "Bundled core runtime directory missing: {}",
                source.display()
            ));
        }
        copy_missing_recursive(&source, &app_data_dir.join(name))
            .map_err(|e| format!("Failed to seed {}: {}", name, e))?;
    }
    Ok(())
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

/// Migrates the two historic per-app Roaming layouts into the shared Local layout. The migration
/// runs before Node opens SQLite, keeps a recoverable copy of a pre-existing v2 storage folder,
/// and never replaces bundled plugin code -- only plugin data/state/secrets.
fn migrate_legacy_data(
    app: &AppHandle,
    app_data_dir: &std::path::Path,
    workspace: &std::path::Path,
) -> Result<(), String> {
    let marker = app_data_dir.join(".layout-v2-migrated");
    if marker.exists() {
        return Ok(());
    }
    let Some(source) = newest_legacy_data_dir(app) else {
        std::fs::write(marker, b"no legacy data found\n").map_err(|e| e.to_string())?;
        return Ok(());
    };

    let source_storage = source.join("storage");
    let dest_storage = app_data_dir.join("storage");
    if dest_storage.join("ducki.db").exists() {
        let backup = app_data_dir.join("migration-backup-v2").join("storage");
        if !backup.exists() {
            copy_dir_recursive(&dest_storage, &backup)
                .map_err(|e| format!("Failed to back up current storage: {}", e))?;
        }
    }
    copy_dir_recursive(&source_storage, &dest_storage).map_err(|e| {
        format!(
            "Failed to migrate legacy storage from {}: {}",
            source.display(),
            e
        )
    })?;

    let source_plugins = source.join("plugins");
    let dest_plugins = app_data_dir.join("plugins");
    for special in [".secret-key", ".state.json"] {
        let src = source_plugins.join(special);
        if src.is_file() {
            std::fs::create_dir_all(&dest_plugins).map_err(|e| e.to_string())?;
            std::fs::copy(src, dest_plugins.join(special)).map_err(|e| e.to_string())?;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&source_plugins) {
        for entry in entries.flatten().filter(|e| e.path().is_dir()) {
            let data = entry.path().join("data");
            if data.is_dir() {
                copy_dir_recursive(&data, &dest_plugins.join(entry.file_name()).join("data"))
                    .map_err(|e| format!("Failed to migrate plugin data: {}", e))?;
            }
        }
    }
    let old_workspace = source.join("shared-workspace");
    if old_workspace.is_dir() {
        copy_missing_recursive(&old_workspace, workspace)
            .map_err(|e| format!("Failed to migrate legacy workspace: {}", e))?;
    }
    std::fs::write(&marker, format!("migrated from {}\n", source.display()))
        .map_err(|e| format!("Failed to write migration marker: {}", e))?;
    println!("[TAURI] Migrated legacy data from {}", source.display());
    Ok(())
}

/// The built-in plugin folders (calendar, notes, pet-companion, ...) are bundled read-only as a
/// Tauri resource. Plugins need a writable directory (per-plugin SQLite, encrypted settings, a
/// freshly generated .secret-key), so on first run each bundled plugin gets copied into the
/// writable app-data plugins dir - but only if it isn't already there, so app updates can add new
/// built-in plugins without ever clobbering a user's existing install/customization of one.
fn seed_builtin_plugins(app: &AppHandle, app_data_dir: &std::path::Path) -> std::path::PathBuf {
    let plugins_dir = app_data_dir.join("plugins");
    let _ = std::fs::create_dir_all(&plugins_dir);

    let Ok(resource_dir) = app.path().resource_dir() else {
        return plugins_dir;
    };
    let builtin_dir = resource_dir.join("resources/server-dist/plugins-builtin");

    // Runtime deps shared by multiple plugins (e.g. ffmpeg-static, @ducki/providers) are bundled
    // ONCE into plugins-builtin/node_modules instead of duplicated into every plugin that needs
    // them (see build.js) - Node's module resolution walks up from a plugin dir through its
    // parent's node_modules on its own, so seeding this shared tree as a sibling of the per-plugin
    // dirs (app_data/plugins/node_modules) is all that's needed for every plugin to resolve from
    // it. copy_missing_recursive is additive and safe to re-run on every launch/update.
    let shared_nm = builtin_dir.join("node_modules");
    if shared_nm.is_dir() {
        if let Err(e) = copy_missing_recursive(&shared_nm, &plugins_dir.join("node_modules")) {
            eprintln!("[TAURI] Failed to seed shared plugin runtime deps: {}", e);
        }
    }

    let Ok(entries) = std::fs::read_dir(&builtin_dir) else {
        return plugins_dir;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() || entry.file_name() == "node_modules" {
            continue;
        }
        let dest = plugins_dir.join(entry.file_name());
        if dest.exists() {
            // Existing install (possibly user-customized): never clobber the plugin
            // itself, but additively merge the packaging-added runtime deps
            // (node_modules, e.g. "ws" for discord-connector) so plugins keep loading
            // after app updates. Only copies when the dest has NO node_modules at all -
            // a user's own node_modules is left untouched.
            let bundled_nm = entry.path().join("node_modules");
            let dest_nm = dest.join("node_modules");
            if bundled_nm.is_dir() {
                if let Err(e) = copy_missing_recursive(&bundled_nm, &dest_nm) {
                    eprintln!(
                        "[TAURI] Failed to merge runtime deps into plugin {:?}: {}",
                        entry.file_name(),
                        e
                    );
                } else {
                    println!(
                        "[TAURI] Verified runtime deps for plugin: {}",
                        entry.file_name().to_string_lossy()
                    );
                }
            }
            continue;
        }
        if let Err(e) = copy_dir_recursive(&entry.path(), &dest) {
            eprintln!(
                "[TAURI] Failed to seed plugin {:?}: {}",
                entry.file_name(),
                e
            );
        } else {
            println!(
                "[TAURI] Seeded built-in plugin: {}",
                entry.file_name().to_string_lossy()
            );
        }
    }

    plugins_dir
}

fn start_backend_server(app: &AppHandle) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let preferred_port = 3001u16;
    let lock = acquire_agent_lock(app)?;
    if lock.is_none() {
        for _ in 0..30 {
            if is_ducki_backend_running(preferred_port) {
                *app_state.actual_port.lock().unwrap() = preferred_port;
                *app_state.is_running.lock().unwrap() = true;
                *app_state.owns_backend.lock().unwrap() = false;
                println!("[TAURI] Reusing the existing DucKI Agent on port 3001");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(500));
        }
        return Err("Another DucKI Agent instance is starting, but is not healthy yet".to_string());
    }
    let lock = lock.expect("agent lock checked above");

    if !is_port_available(preferred_port) {
        return Err(
            "Port 3001 is occupied by a process that is not a compatible DucKI Agent".to_string(),
        );
    }
    let actual_port = preferred_port;

    println!(
        "[TAURI] Starting backend server (sidecar) on port {}...",
        actual_port
    );

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let server_index_path = resource_dir.join("resources/server-dist/index.js");

    if !server_index_path.exists() {
        return Err(format!(
            "Server entry point not found: {}",
            server_index_path.display()
        ));
    }

    let (app_data_dir, shared_workspace_path) = app_data_and_workspace(app)?;
    seed_core_runtime(app, &app_data_dir)?;
    let plugins_dir = seed_builtin_plugins(app, &app_data_dir);
    migrate_legacy_data(app, &app_data_dir, &shared_workspace_path)?;

    println!("[TAURI] Server index: {}", server_index_path.display());
    println!("[TAURI] Working dir:  {}", app_data_dir.display());
    println!(
        "[TAURI] Shared workspace: {}",
        shared_workspace_path.display()
    );
    println!("[TAURI] Plugins dir: {}", plugins_dir.display());

    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Failed to resolve node sidecar: {}", e))?
        .args([server_index_path.to_string_lossy().to_string()])
        .current_dir(app_data_dir)
        .env("PORT", actual_port.to_string())
        .env("NODE_ENV", "production")
        .env(
            "SHARED_WORKSPACE_PATH",
            shared_workspace_path.to_string_lossy().to_string(),
        )
        .env(
            "DUCKI_PLUGINS_DIR",
            plugins_dir.to_string_lossy().to_string(),
        )
        .spawn()
        .map_err(|e| format!("Failed to start server sidecar: {}", e))?;

    *app_state.child.lock().unwrap() = Some(child);
    *app_state.agent_lock.lock().unwrap() = Some(lock);
    *app_state.owns_backend.lock().unwrap() = true;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[SERVER] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[SERVER] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Error(err) => eprintln!("[TAURI] Sidecar error: {}", err),
                CommandEvent::Terminated(payload) => {
                    println!("[TAURI] Server sidecar exited: {:?}", payload);
                    let state = app_handle.state::<AppState>();
                    *state.is_running.lock().unwrap() = false;
                    *state.child.lock().unwrap() = None;
                }
                _ => {}
            }
        }
    });

    println!(
        "[TAURI] Waiting for backend to be ready on port {}...",
        actual_port
    );
    for attempt in 1..=30 {
        if is_ducki_backend_running(actual_port) {
            println!("[TAURI] Backend server is ready on port {}!", actual_port);
            *app_state.actual_port.lock().unwrap() = actual_port;
            *app_state.is_running.lock().unwrap() = true;

            let _ = app
                .notification()
                .builder()
                .title("DucKI Node")
                .body(format!("Agent läuft auf Port {}", actual_port))
                .show();

            return Ok(());
        }
        if attempt % 5 == 0 {
            println!("[TAURI]   Health check attempt {}/30", attempt);
        }
        thread::sleep(Duration::from_millis(500));
    }

    *app_state.is_running.lock().unwrap() = false;
    if let Some(child) = app_state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    *app_state.owns_backend.lock().unwrap() = false;
    release_agent_lock(&app_state);
    Err(format!(
        "Backend server failed to start after 30 seconds on port {}",
        actual_port
    ))
}

fn stop_backend_server(app: &AppHandle) {
    let app_state = app.state::<AppState>();
    if *app_state.owns_backend.lock().unwrap() {
        let child = app_state.child.lock().unwrap().take();
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
    *app_state.is_running.lock().unwrap() = false;
    *app_state.owns_backend.lock().unwrap() = false;
    release_agent_lock(&app_state);
    // Give Windows a moment to release the port before a restart tries to rebind it.
    thread::sleep(Duration::from_millis(500));
}

fn restart_backend_server(app: &AppHandle) {
    println!("[TAURI] Restarting backend server...");
    stop_backend_server(app);
    let app_handle = app.clone();
    thread::spawn(move || {
        if let Err(e) = start_backend_server(&app_handle) {
            eprintln!("[TAURI] Restart failed: {}", e);
            let _ = app_handle
                .notification()
                .builder()
                .title("DucKI Node")
                .body(format!("Neustart fehlgeschlagen: {}", e))
                .show();
        } else {
            let _ = app_handle
                .notification()
                .builder()
                .title("DucKI Node")
                .body("Agent wurde neu gestartet")
                .show();
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn navigate_main(app: &AppHandle, path: &str) {
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

fn set_app_theme(app: &AppHandle, theme: Option<Theme>, web_theme: &str) {
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
        .text("open_workspace", "Workspace im Explorer öffnen")
        .text("open_data", "Daten und Logs öffnen")
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
        .text("nav_settings", "Einstellungen")
        .text("nav_plugins", "Plugins")
        .text("nav_agents", "Agentenstatus")
        .text("nav_logs", "Logs")
        .separator()
        .text("agent_restart", "Agent neu starten")
        .text("agent_health", "Systemstatus öffnen")
        .build()?;
    let help = SubmenuBuilder::new(app, "&Hilfe")
        .text("help_docs", "DucKI-Webseite")
        .text("help_about", "Über DucKI Node")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &agent, &help])
        .build()
}

fn handle_native_menu(app: &AppHandle, id: &str) {
    match id {
        "nav_dashboard" => navigate_main(app, "/dashboard"),
        "nav_chat" => navigate_main(app, "/chat"),
        "nav_workspace" => navigate_main(app, "/shared"),
        "nav_settings" => navigate_main(app, "/settings"),
        "nav_plugins" => navigate_main(app, "/plugins"),
        "nav_agents" => navigate_main(app, "/agents"),
        "nav_logs" => navigate_main(app, "/logs"),
        "theme_dark" => set_app_theme(app, Some(Theme::Dark), "dark"),
        "theme_light" => set_app_theme(app, Some(Theme::Light), "light"),
        "theme_system" => set_app_theme(app, None, "system"),
        "open_workspace" => {
            if let Ok(home) = app.path().home_dir() {
                let _ = std::process::Command::new("explorer")
                    .arg(home.join("DucKI/shared-workspace"))
                    .spawn();
            }
        }
        "open_data" => open_data_folder(app),
        "agent_restart" => restart_backend_server(app),
        "agent_health" => {
            let _ = app.shell().open("http://127.0.0.1:3001/dashboard", None);
        }
        "help_docs" => {
            let _ = app.shell().open("https://ducki.cloud", None);
        }
        "app_quit" => {
            stop_backend_server(app);
            app.exit(0);
        }
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
                        let _ = window.eval(
                            "alert('DucKI Node Desktop 0.1.0\\nAgent und Web-UI für Windows')",
                        );
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
}

fn open_data_folder(app: &AppHandle) {
    if let Ok(dir) = app.path().local_data_dir() {
        let _ = std::process::Command::new("explorer")
            .arg(dir.join("DucKI Node"))
            .spawn();
    }
}

#[cfg(target_os = "windows")]
fn autostart_exe_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|p| format!("\"{}\"", p.display()))
}

#[cfg(target_os = "windows")]
fn is_autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Some(expected) = autostart_exe_path() else {
        return false;
    };
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .ok()
        .and_then(|key| key.get_value::<String, _>(AUTOSTART_REGISTRY_NAME).ok())
        .map(|value| value == expected)
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn set_autostart(enabled: bool) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_WRITE | winreg::enums::KEY_QUERY_VALUE,
    ) else {
        return;
    };

    if enabled {
        if let Some(exe_str) = autostart_exe_path() {
            let _ = hkcu.set_value(AUTOSTART_REGISTRY_NAME, &exe_str);
            println!("[TAURI] Autostart enabled");
        }
    } else {
        let _ = hkcu.delete_value(AUTOSTART_REGISTRY_NAME);
        println!("[TAURI] Autostart disabled");
    }
}

#[cfg(not(target_os = "windows"))]
fn is_autostart_enabled() -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn set_autostart(_enabled: bool) {}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let open_item = MenuItemBuilder::with_id("open", "Oberfläche öffnen")
        .build(app)
        .map_err(|e| e.to_string())?;
    let restart_item = MenuItemBuilder::with_id("restart", "Agent neu starten")
        .build(app)
        .map_err(|e| e.to_string())?;
    let logs_item = MenuItemBuilder::with_id("logs", "Log-Anzeige öffnen")
        .build(app)
        .map_err(|e| e.to_string())?;
    let data_item = MenuItemBuilder::with_id("data", "Datenordner öffnen")
        .build(app)
        .map_err(|e| e.to_string())?;
    let theme_dark = MenuItemBuilder::with_id("theme_dark", "Dunkles Erscheinungsbild")
        .build(app)
        .map_err(|e| e.to_string())?;
    let theme_light = MenuItemBuilder::with_id("theme_light", "Helles Erscheinungsbild")
        .build(app)
        .map_err(|e| e.to_string())?;
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Autostart")
        .checked(is_autostart_enabled())
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "Beenden")
        .build(app)
        .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &open_item,
            &restart_item,
            &logs_item,
            &data_item,
            &separator,
            &theme_dark,
            &theme_light,
            &separator,
            &autostart_item,
            &separator,
            &quit_item,
        ])
        .build()
        .map_err(|e| e.to_string())?;

    *app.state::<AppState>().autostart_item.lock().unwrap() = Some(autostart_item);

    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::new()
        .tooltip("DucKI Node")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "restart" => restart_backend_server(app),
            "logs" => navigate_main(app, "/logs"),
            "data" => open_data_folder(app),
            "theme_dark" => set_app_theme(app, Some(Theme::Dark), "dark"),
            "theme_light" => set_app_theme(app, Some(Theme::Light), "light"),
            "autostart" => {
                let state = app.state::<AppState>();
                let checked = state
                    .autostart_item
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|item| item.is_checked().unwrap_or(false))
                    .unwrap_or(false);
                set_autostart(checked);
            }
            "quit" => {
                stop_backend_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Only react to a completed LEFT click here. Reacting to right-clicks too used to
            // steal focus for the main window right as the native context menu opened, which
            // made Windows immediately dismiss the menu again - so "Beenden" (and everything
            // else in it) was effectively unreachable. Right-click showing the menu is native
            // tray behavior and needs no handling here at all.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    println!("[TAURI] Starting DucKI Node...");

    let app_state = AppState {
        actual_port: Mutex::new(3001),
        is_running: Mutex::new(false),
        child: Mutex::new(None),
        autostart_item: Mutex::new(None),
        agent_lock: Mutex::new(None),
        owns_backend: Mutex::new(false),
        zoom: Mutex::new(1.0),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .menu(build_native_menu)
        .on_menu_event(|app, event| handle_native_menu(app, event.id().as_ref()))
        .setup(|app| {
            let handle = app.handle().clone();

            if let Err(e) = build_tray(&handle) {
                eprintln!("[TAURI] Tray setup failed: {}", e);
            }

            if let Some(window) = app.get_webview_window("main") {
                let handle_for_close = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(window) = handle_for_close.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                });
            }

            let handle_for_server = handle.clone();
            thread::spawn(move || {
                if let Err(e) = start_backend_server(&handle_for_server) {
                    eprintln!("[TAURI] ERROR: {}", e);
                    let _ = handle_for_server
                        .notification()
                        .builder()
                        .title("DucKI Node")
                        .body(format!("Agent konnte nicht gestartet werden: {}", e))
                        .show();
                    show_main_window(&handle_for_server);
                } else {
                    show_main_window(&handle_for_server);
                }
            });

            println!("[TAURI] Setup complete!");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_backend_url, get_backend_port])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                stop_backend_server(app_handle);
            }
        });
}

#[tauri::command]
fn get_backend_port(app_state: State<AppState>) -> u16 {
    *app_state.actual_port.lock().unwrap()
}

#[tauri::command]
fn get_backend_url(app_state: State<AppState>) -> String {
    let port = *app_state.actual_port.lock().unwrap();
    format!("http://localhost:{}", port)
}
