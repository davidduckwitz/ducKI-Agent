// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// DucKI UI - a pure UI client.
///
/// Unlike `tauri-desktop` (server + UI in one process) and `tauri-server` (headless
/// agent), this app bundles NO backend and spawns NO Node sidecar. It embeds the built
/// web app (`apps/web/dist` via frontendDist) and connects to a running backend:
///
/// - By default the web app targets `http://localhost:3001` (where tauri-server /
///   tauri-desktop bind their agent). The web app detects the Tauri runtime
///   (`isDesktopApp()` in lib/backendUrl.ts) and uses absolute URLs for /api and
///   socket.io, so no proxy or redirect is needed.
/// - A different local port or a remote backend can be set in the web UI under
///   Settings -> Backend (stored in localStorage as "backend-config").
///
/// The Rust side stays deliberately minimal: one main window, external links opened via
/// the shell plugin (shell:allow-open), and window close quits the app.
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            println!("[TAURI] DucKI UI started (dev) - devUrl must serve the web app on :5173");
            #[cfg(not(debug_assertions))]
            println!("[TAURI] DucKI UI started (release) - connecting to backend on localhost:3001 by default");

            let _ = app.handle();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
