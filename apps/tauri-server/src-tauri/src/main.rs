// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::{AppHandle, Manager, RunEvent, State, Theme};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct AppState {
    actual_port: Mutex<u16>,
    is_running: Mutex<bool>,
    child: Mutex<Option<CommandChild>>,
    agent_lock: Mutex<Option<AgentMutexHandle>>,
    owns_backend: Mutex<bool>,
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
    let Ok(entries) = std::fs::read_dir(&builtin_dir) else {
        return plugins_dir;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
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

    // Server-Skript liegt als Tauri-Resource neben der Sidecar-Node-Binary.
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

    // Schreibbares App-Datenverzeichnis fuer shared-workspace/DB statt Installationsordner
    // (der bei Standardnutzern i.d.R. schreibgeschuetzt ist).
    let app_data_dir = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("Failed to resolve local data dir: {}", e))?
        .join("DucKI Node");
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let shared_workspace_path = app
        .path()
        .home_dir()
        .map_err(|e| format!("Failed to resolve user home: {}", e))?
        .join("DucKI")
        .join("shared-workspace");
    std::fs::create_dir_all(&shared_workspace_path)
        .map_err(|e| format!("Failed to create shared-workspace dir: {}", e))?;
    ensure_development_workspace_link(&shared_workspace_path);
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
                    println!("[SERVER] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[SERVER] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[TAURI] Sidecar error: {}", err);
                }
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

#[cfg(all(debug_assertions, target_os = "windows"))]
fn ensure_development_workspace_link(target: &std::path::Path) {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let Some(apps_dir) = manifest.parent().and_then(std::path::Path::parent) else {
        return;
    };
    let link = apps_dir.join("server").join("shared-workspace");
    if link.exists() {
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

fn stop_backend_server(app: &AppHandle) {
    let state = app.state::<AppState>();
    if *state.owns_backend.lock().unwrap() {
        if let Some(child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
    *state.is_running.lock().unwrap() = false;
    *state.owns_backend.lock().unwrap() = false;
    release_agent_lock(&state);
}

fn open_folder(path: std::path::PathBuf) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let status = MenuItemBuilder::with_id("status", "Agent: Port 3001")
        .enabled(false)
        .build(app)
        .map_err(|e| e.to_string())?;
    let workspace = MenuItemBuilder::with_id("workspace", "Workspace öffnen")
        .build(app)
        .map_err(|e| e.to_string())?;
    let data = MenuItemBuilder::with_id("data", "Daten und Logs öffnen")
        .build(app)
        .map_err(|e| e.to_string())?;
    let theme_dark = MenuItemBuilder::with_id("theme_dark", "Dunkles Erscheinungsbild")
        .build(app)
        .map_err(|e| e.to_string())?;
    let theme_light = MenuItemBuilder::with_id("theme_light", "Helles Erscheinungsbild")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "Beenden")
        .build(app)
        .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .items(&[
            &status,
            &workspace,
            &data,
            &separator,
            &theme_dark,
            &theme_light,
            &separator,
            &quit,
        ])
        .build()
        .map_err(|e| e.to_string())?;

    let mut tray = tauri::tray::TrayIconBuilder::new()
        .tooltip("DucKI Agent · localhost:3001")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "workspace" => {
                if let Ok(home) = app.path().home_dir() {
                    open_folder(home.join("DucKI").join("shared-workspace"));
                }
            }
            "data" => {
                if let Ok(dir) = app.path().local_data_dir() {
                    open_folder(dir.join("DucKI Node"));
                }
            }
            "theme_dark" => {
                app.set_theme(Some(Theme::Dark));
                if let Some(window) = app.get_webview_window("server-logs") {
                    let _ = window.set_theme(Some(Theme::Dark));
                    let _ = window.eval("document.documentElement.dataset.theme = 'dark';");
                }
            }
            "theme_light" => {
                app.set_theme(Some(Theme::Light));
                if let Some(window) = app.get_webview_window("server-logs") {
                    let _ = window.set_theme(Some(Theme::Light));
                    let _ = window.eval("document.documentElement.dataset.theme = 'light';");
                }
            }
            "quit" => {
                stop_backend_server(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app).map_err(|e| e.to_string())?;
    Ok(())
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

fn main() {
    println!("[TAURI] Starting DucKI Server Tauri App...");

    let app_state = AppState {
        actual_port: Mutex::new(3001),
        is_running: Mutex::new(false),
        child: Mutex::new(None),
        agent_lock: Mutex::new(None),
        owns_backend: Mutex::new(false),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            println!("[TAURI] Setup phase - initializing...");
            if let Err(e) = build_tray(app.handle()) {
                eprintln!("[TAURI] Tray setup failed: {}", e);
            }
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(e) = start_backend_server(&handle) {
                    eprintln!("[TAURI] ERROR: {}", e);
                    if let Some(window) = handle.get_webview_window("server-logs") {
                        let _ = window.set_title(&format!("DucKI Server - Error: {}", e));
                        let _ = window.show();
                    }
                }
            });

            println!("[TAURI] Setup complete!");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_backend_url, get_backend_port])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                stop_backend_server(app_handle);
            }
        });
}
