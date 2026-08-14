// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct AppState {
    actual_port: Mutex<u16>,
    is_running: Mutex<bool>,
    child: Mutex<Option<CommandChild>>,
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

fn start_backend_server(app: &AppHandle, app_state: State<AppState>) -> Result<(), String> {
    let preferred_port = 3001u16;
    let actual_port = find_available_port(preferred_port);

    if actual_port == 0 {
        return Err("No available ports found (3001-3010)".to_string());
    }

    println!("[TAURI] Starting backend server (sidecar) on port {}...", actual_port);

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
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let shared_workspace_path = app_data_dir.join("shared-workspace");
    std::fs::create_dir_all(&shared_workspace_path)
        .map_err(|e| format!("Failed to create shared-workspace dir: {}", e))?;

    println!("[TAURI] Server index: {}", server_index_path.display());
    println!("[TAURI] Working dir:  {}", app_data_dir.display());
    println!("[TAURI] Shared workspace: {}", shared_workspace_path.display());

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
        .spawn()
        .map_err(|e| format!("Failed to start server sidecar: {}", e))?;

    *app_state.child.lock().unwrap() = Some(child);

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

    println!("[TAURI] Waiting for backend to be ready on port {}...", actual_port);
    for attempt in 1..=30 {
        if is_backend_running(actual_port) {
            println!("[TAURI] Backend server is ready on port {}!", actual_port);
            *app_state.actual_port.lock().unwrap() = actual_port;
            *app_state.is_running.lock().unwrap() = true;

            match create_tray_icon(app, actual_port) {
                Ok(_) => println!("[TAURI] Tray icon created successfully"),
                Err(e) => println!("[TAURI] Tray icon error: {}", e),
            }

            return Ok(());
        }
        if attempt % 5 == 0 {
            println!("[TAURI]   Health check attempt {}/30", attempt);
        }
        thread::sleep(Duration::from_millis(500));
    }

    *app_state.is_running.lock().unwrap() = false;
    Err(format!(
        "Backend server failed to start after 30 seconds on port {}",
        actual_port
    ))
}

fn create_tray_icon(app: &AppHandle, port: u16) -> Result<(), String> {
    let tooltip = format!("DucKI Server\nPort: {}\n\nClick to open", port);

    tauri::tray::TrayIconBuilder::new()
        .tooltip(&tooltip)
        .build(app)
        .map_err(|e| format!("Failed to create tray: {}", e))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn setup_autostart() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_WRITE,
    ) {
        if let Ok(exe_path) = std::env::current_exe() {
            let exe_str = exe_path.display().to_string();
            let _ = hkcu.set_value("DucKI Server", &exe_str);
            println!("[TAURI] Autostart registered");
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn setup_autostart() {}

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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            println!("[TAURI] Setup phase - initializing...");
            let app_state = app.state::<AppState>();

            setup_autostart();

            if let Err(e) = start_backend_server(app.handle(), app_state) {
                eprintln!("[TAURI] ERROR: {}", e);
                if let Some(window) = app.get_webview_window("server-logs") {
                    let _ = window.show();
                    let _ = window.set_title(&format!("Error: {}", e));
                }
            }

            println!("[TAURI] Setup complete!");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_backend_url, get_backend_port])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                let child = state.child.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        });
}
