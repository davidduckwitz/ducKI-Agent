// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::net::TcpListener;
use tauri::{Manager, State, AppHandle};

struct AppState {
    actual_port: Mutex<u16>,
    is_running: Mutex<bool>,
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
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(_) => true,
        Err(_) => false,
    }
}

fn is_backend_running(port: u16) -> bool {
    match std::net::TcpStream::connect(("127.0.0.1", port)) {
        Ok(_) => true,
        Err(_) => false,
    }
}

fn start_backend_server(app: &AppHandle, app_state: State<AppState>) -> Result<(), String> {
    let preferred_port = 3001u16;
    let actual_port = find_available_port(preferred_port);

    if actual_port == 0 {
        return Err("❌ No available ports found (3001-3010)".to_string());
    }

    println!("[TAURI] 🚀 Starting backend server on port {}...", actual_port);

    // Get exe directory
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?;
    let exe_dir = exe_path
        .parent()
        .ok_or("Failed to get exe directory")?;

    // In production, server-dist is bundled in resources/ next to exe
    // In dev, we need to traverse to the monorepo root
    let server_index_path = if cfg!(debug_assertions) {
        // Dev mode: traverse to monorepo root (exe is in src-tauri/target-debug)
        exe_dir
            .parent()
            .ok_or("Failed to get parent")?
            .parent()
            .ok_or("Failed to get parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent of parent")?
            .join("apps/server/dist/index.js")
    } else {
        // Production: use bundled server-dist in resources/ (next to exe)
        exe_dir.join("resources/server-dist/index.js")
    };

    // Get working directory
    let working_dir = if cfg!(debug_assertions) {
        // Dev mode: monorepo root
        exe_dir
            .parent()
            .ok_or("Failed to get parent")?
            .parent()
            .ok_or("Failed to get parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent of parent")?
            .to_path_buf()
    } else {
        // Production: exe directory (resources are accessed relative to exe)
        exe_dir.to_path_buf()
    };

    println!("[TAURI] 📂 Server index: {}", server_index_path.display());
    println!("[TAURI] 📂 Working dir: {}", working_dir.display());

    // Set up NODE_PATH for module resolution
    // Try bundled node_modules first, then fall back to workspace (for monorepo dev)
    let node_path = if cfg!(debug_assertions) {
        // Dev: monorepo node_modules
        format!("{}:{}",
            exe_dir
                .parent().unwrap().parent().unwrap().parent().unwrap().parent().unwrap()
                .parent().unwrap().parent().unwrap()
                .join("node_modules").to_string_lossy(),
            exe_dir.join("resources/server-dist/node_modules").to_string_lossy()
        )
    } else {
        // Prod: bundled first, then fall back to workspace
        format!("{}:{}:{}",
            exe_dir.join("resources/server-dist/node_modules").to_string_lossy(),
            exe_dir.join("resources/server-dist").to_string_lossy(),
            exe_dir.parent().unwrap_or_else(|| exe_dir).join("node_modules").to_string_lossy()
        )
    };

    println!("[TAURI] 📦 NODE_PATH: {}", node_path);

    // Start server as detached process using node directly
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        // CREATE_NEW_PROCESS_GROUP = 0x00000200 - makes process independent
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

        let mut cmd = Command::new("cmd");
        cmd.args(&["/c", "start", "/B", "node", server_index_path.to_string_lossy().as_ref()])
            .env("PORT", actual_port.to_string())
            .env("NODE_ENV", "production")
            .current_dir(&working_dir)
            .creation_flags(CREATE_NEW_PROCESS_GROUP);

        if !node_path.is_empty() {
            cmd.env("NODE_PATH", &node_path);
        }

        let _child = cmd.spawn()
            .map_err(|e| format!("Failed to start server: {}", e))?;

        // Don't store child - let it run independently
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("node");
        cmd.arg(server_index_path.to_string_lossy().as_ref())
            .env("PORT", actual_port.to_string())
            .env("NODE_ENV", "production")
            .current_dir(&working_dir);

        if !node_path.is_empty() {
            cmd.env("NODE_PATH", &node_path);
        }

        let _child = cmd.spawn()
            .map_err(|e| format!("Failed to start server: {}", e))?;
    }

    // Server runs detached - no need to track process
    *app_state.actual_port.lock().unwrap() = actual_port;

    println!("[TAURI] ⏳ Waiting for backend to be ready on port {}...", actual_port);
    for attempt in 1..=30 {
        if is_backend_running(actual_port) {
            println!("[TAURI] ✓ Backend server is ready on port {}!", actual_port);
            *app_state.is_running.lock().unwrap() = true;
            
            // Create tray icon - AFTER server is running
            match create_tray_icon(app, actual_port) {
                Ok(_) => println!("[TAURI] ✓ Tray icon created successfully"),
                Err(e) => println!("[TAURI] ⚠ Tray icon error: {}", e),
            }
            
            return Ok(());
        }
        if attempt % 5 == 0 {
            println!("[TAURI]   Health check attempt {}/30", attempt);
        }
        thread::sleep(Duration::from_millis(500));
    }

    *app_state.is_running.lock().unwrap() = false;
    Err(format!("❌ Backend server failed to start after 30 seconds on port {}", actual_port))
}

fn create_tray_icon(app: &AppHandle, port: u16) -> Result<(), String> {
    println!("[TAURI]   Creating tray icon...");
    
    let tooltip = format!("🟢 DucKI Server\nPort: {}\n\nClick to open", port);
    
    tauri::tray::TrayIconBuilder::new()
        .tooltip(&tooltip)
        .build(app)
        .map_err(|e| {
            println!("[TAURI]   ERROR creating tray: {}", e);
            format!("Failed to create tray: {}", e)
        })?;
    
    println!("[TAURI]   Tray icon built successfully");
    Ok(())
}

#[cfg(target_os = "windows")]
fn setup_autostart() {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        winreg::enums::KEY_WRITE,
    ) {
        if let Ok(exe_path) = std::env::current_exe() {
            let exe_str = exe_path.display().to_string();
            let _ = hkcu.set_value("DucKI Server", &exe_str);
            println!("[TAURI] ✓ Autostart registered");
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
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            println!("[TAURI] Setup phase - initializing...");
            let app_state = app.state::<AppState>();

            setup_autostart();

            // Start backend server (blocking until ready)
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
