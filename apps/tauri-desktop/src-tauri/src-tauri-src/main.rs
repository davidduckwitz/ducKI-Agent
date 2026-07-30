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
    // Try to start the backend server
    let exe_path = if cfg!(debug_assertions) {
        // In development, use node to run the server
        // This assumes the server is built and available at apps/server/dist/index.js
        std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?
            .parent()
            .ok_or("Failed to get parent of exe")?
            .parent()
            .ok_or("Failed to get parent of parent")?
            .parent()
            .ok_or("Failed to get parent of parent of parent")?
            .join("apps/server/dist/index.js")
    } else {
        // In production, use the bundled server executable
        std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?
            .parent()
            .ok_or("Failed to get parent of exe")?
            .join("server.exe")
    };

    // Check if backend is already running
    if is_backend_running() {
        println!("Backend server already running");
        return Ok(());
    }

    println!("Starting backend server from: {:?}", exe_path);

    let child = if cfg!(debug_assertions) {
        Command::new("node")
            .arg(&exe_path)
            .env("PORT", "3001")
            .env("NODE_ENV", "production")
            .spawn()
            .map_err(|e| format!("Failed to start backend with node: {}", e))?
    } else {
        Command::new(&exe_path)
            .env("PORT", "3001")
            .env("NODE_ENV", "production")
            .spawn()
            .map_err(|e| format!("Failed to start backend executable: {}", e))?
    };

    *backend_process.0.lock().unwrap() = Some(child);

    // Wait for backend to be ready
    for attempt in 1..=30 {
        if is_backend_running() {
            println!("Backend server is ready");
            return Ok(());
        }
        println!("Health check attempt {}/30", attempt);
        thread::sleep(Duration::from_secs(1));
    }

    Err("Backend server failed to start after 30 seconds".to_string())
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
                eprintln!("Failed to start backend: {}", e);
                // Continue anyway - user might want to connect to remote server
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_backend_url])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
