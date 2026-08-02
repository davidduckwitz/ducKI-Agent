// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, State};

struct BackendProcess(Mutex<Option<Child>>);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn get_backend_url() -> Result<String, String> {
    Ok("http://localhost:3001".to_string())
}

fn start_backend_server(backend_process: State<BackendProcess>) -> Result<(), String> {
    // Check if backend is already running
    if is_backend_running() {
        println!("✓ Backend server already running on port 3001");
        return Ok(());
    }

    println!("🚀 Starting backend server...");

    // Determine the backend executable/script path
    let backend_source = if cfg!(debug_assertions) {
        // In development: use node with dist/index.js
        let script_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("Failed to get parent of exe")?
            .parent()
            .ok_or("Failed to get parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent of parent of parent")?
            .join("apps/server/dist/index.js");

        format!("node {}", script_path.display())
    } else {
        // In production: try bundled executable first, fallback to node
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("Failed to get parent of exe")?
            .join("resources")
            .join("server.exe");

        if exe_path.exists() {
            exe_path.display().to_string()
        } else {
            // Fallback: use node with embedded script
            let script_path = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|pp| pp.join("server.js")))
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "node".to_string());
            format!("node {}", script_path)
        }
    };

    println!("Backend source: {}", backend_source);

    // Start the backend process
    let child = if cfg!(debug_assertions) {
        // Development: start with node directly
        Command::new("node")
            .arg(std::env::current_exe()
                .map_err(|e| format!("Failed to get exe path: {}", e))?
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
                .join("apps/server/dist/index.js"))
            .env("PORT", "3001")
            .env("NODE_ENV", "production")
            .spawn()
            .map_err(|e| format!("Failed to start backend: {}", e))?
    } else {
        // Production: try standalone executable
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {}", e))?
            .parent()
            .ok_or("Failed to get parent of exe")?
            .join("resources")
            .join("server.exe");

        if exe_path.exists() {
            Command::new(&exe_path)
                .env("PORT", "3001")
                .env("NODE_ENV", "production")
                .spawn()
                .map_err(|e| format!("Failed to start server.exe: {}", e))?
        } else {
            // Fallback to node
            Command::new("node")
                .arg("server.js")
                .env("PORT", "3001")
                .env("NODE_ENV", "production")
                .spawn()
                .map_err(|e| format!("Failed to start backend with node: {}", e))?
        }
    };

    *backend_process.0.lock().unwrap() = Some(child);

    // Wait for backend to be ready with health checks
    println!("⏳ Waiting for backend to be ready...");
    for attempt in 1..=30 {
        if is_backend_running() {
            println!("✓ Backend server is ready!");
            return Ok(());
        }
        if attempt % 5 == 0 {
            println!("  Health check attempt {}/30", attempt);
        }
        thread::sleep(Duration::from_secs(1));
    }

    Err("❌ Backend server failed to start after 30 seconds".to_string())
}

fn is_backend_running() -> bool {
    match std::net::TcpStream::connect("127.0.0.1:3001") {
        Ok(_) => true,
        Err(_) => false,
    }
}

fn main() {
    let backend_process = BackendProcess(Mutex::new(None));

    tauri::Builder::default()
        .manage(backend_process)
        .setup(|app| {
            let backend_process = app.state::<BackendProcess>();

            // Start backend server
            if let Err(e) = start_backend_server(backend_process) {
                eprintln!("⚠ Failed to start backend: {}", e);
                // Continue anyway - user might want to connect to remote server
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_backend_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
