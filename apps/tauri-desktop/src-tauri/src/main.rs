// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const AUTOSTART_REGISTRY_NAME: &str = "DucKI Node";

struct AppState {
    actual_port: Mutex<u16>,
    is_running: Mutex<bool>,
    child: Mutex<Option<CommandChild>>,
    autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
}

fn find_available_port(preferred_port: u16) -> u16 {
    if is_port_available(preferred_port) {
        return preferred_port;
    }
    for port in (preferred_port + 1)..=(preferred_port + 10) {
        if is_port_available(port) {
            return port;
        }
    }
    0
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn is_backend_running(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn app_data_and_workspace(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let shared_workspace_path = app_data_dir.join("shared-workspace");
    std::fs::create_dir_all(&shared_workspace_path)
        .map_err(|e| format!("Failed to create shared-workspace dir: {}", e))?;
    Ok((app_data_dir, shared_workspace_path))
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
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let dest = plugins_dir.join(entry.file_name());
        if dest.exists() {
            continue; // don't overwrite an existing (possibly user-customized) plugin
        }
        if let Err(e) = copy_dir_recursive(&entry.path(), &dest) {
            eprintln!("[TAURI] Failed to seed plugin {:?}: {}", entry.file_name(), e);
        } else {
            println!("[TAURI] Seeded built-in plugin: {}", entry.file_name().to_string_lossy());
        }
    }

    plugins_dir
}

fn start_backend_server(app: &AppHandle) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let preferred_port = 3001u16;
    let actual_port = find_available_port(preferred_port);

    if actual_port == 0 {
        return Err("No available ports found (3001-3010)".to_string());
    }

    println!("[TAURI] Starting backend server (sidecar) on port {}...", actual_port);

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let server_index_path = resource_dir.join("resources/server-dist/index.js");

    if !server_index_path.exists() {
        return Err(format!("Server entry point not found: {}", server_index_path.display()));
    }

    let (app_data_dir, shared_workspace_path) = app_data_and_workspace(app)?;
    let plugins_dir = seed_builtin_plugins(app, &app_data_dir);

    println!("[TAURI] Server index: {}", server_index_path.display());
    println!("[TAURI] Working dir:  {}", app_data_dir.display());
    println!("[TAURI] Shared workspace: {}", shared_workspace_path.display());
    println!("[TAURI] Plugins dir: {}", plugins_dir.display());

    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Failed to resolve node sidecar: {}", e))?
        .args([server_index_path.to_string_lossy().to_string()])
        .current_dir(app_data_dir)
        .env("PORT", actual_port.to_string())
        .env("NODE_ENV", "production")
        .env("SHARED_WORKSPACE_PATH", shared_workspace_path.to_string_lossy().to_string())
        .env("DUCKI_PLUGINS_DIR", plugins_dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to start server sidecar: {}", e))?;

    *app_state.child.lock().unwrap() = Some(child);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => println!("[SERVER] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => eprintln!("[SERVER] {}", String::from_utf8_lossy(&line)),
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

    println!("[TAURI] Waiting for backend to be ready on port {}...", actual_port);
    for attempt in 1..=30 {
        if is_backend_running(actual_port) {
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
    Err(format!("Backend server failed to start after 30 seconds on port {}", actual_port))
}

fn stop_backend_server(app: &AppHandle) {
    let app_state = app.state::<AppState>();
    let child = app_state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
    *app_state.is_running.lock().unwrap() = false;
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

fn open_data_folder(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
}

#[cfg(target_os = "windows")]
fn autostart_exe_path() -> Option<String> {
    std::env::current_exe().ok().map(|p| format!("\"{}\"", p.display()))
}

#[cfg(target_os = "windows")]
fn is_autostart_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Some(expected) = autostart_exe_path() else { return false };
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
    let open_item = MenuItemBuilder::with_id("open", "Oberfläche öffnen").build(app).map_err(|e| e.to_string())?;
    let restart_item = MenuItemBuilder::with_id("restart", "Agent neu starten").build(app).map_err(|e| e.to_string())?;
    let logs_item = MenuItemBuilder::with_id("logs", "Logs öffnen").build(app).map_err(|e| e.to_string())?;
    let autostart_item = CheckMenuItemBuilder::with_id("autostart", "Autostart")
        .checked(is_autostart_enabled())
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("quit", "Beenden").build(app).map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .items(&[&open_item, &restart_item, &logs_item, &separator, &autostart_item, &separator, &quit_item])
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
            "logs" => open_data_folder(app),
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
            if let TrayIconEvent::Click { .. } = event {
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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
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
