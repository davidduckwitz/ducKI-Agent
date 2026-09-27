//! Lifecycle of the bundled Node agent: port selection, spawning the sidecar inside a job object,
//! health checks, graceful shutdown and crash supervision.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::paths::AppPaths;
use crate::state::AppState;
use crate::win::{NamedMutex, ProcessJob};

pub const PREFERRED_PORT: u16 = 3001;
const AGENT_LOCK_NAME: &str = "Local\\DucKINode.Agent.v1";
const PORT_FILE: &str = "backend.port";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const CRASH_WINDOW: Duration = Duration::from_secs(300);
const MAX_AUTO_RESTARTS: usize = 3;
pub const STATUS_EVENT: &str = "backend://status";

fn loopback(port: u16) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, port))
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(loopback(port)).is_ok()
}

fn random_free_port() -> Option<u16> {
    TcpListener::bind(loopback(0))
        .ok()?
        .local_addr()
        .ok()
        .map(|a| a.port())
}

fn http_request(port: u16, request: &str, timeout: Duration) -> Option<String> {
    let mut stream =
        TcpStream::connect_timeout(&loopback(port), Duration::from_millis(400)).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

pub fn is_ducki_backend_running(port: u16) -> bool {
    http_request(
        port,
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        Duration::from_millis(800),
    )
    .map(|r| {
        r.starts_with("HTTP/1.1 200")
            && r.contains("\"status\":\"ok\"")
            && r.contains("\"version\"")
    })
    .unwrap_or(false)
}

fn request_graceful_shutdown(port: u16, token: &str) -> bool {
    let request = format!(
        "POST /api/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Ducki-Shutdown-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        token
    );
    http_request(port, &request, Duration::from_millis(1500))
        .map(|r| r.starts_with("HTTP/1.1 2"))
        .unwrap_or(false)
}

fn read_port_file(paths: &AppPaths) -> Option<u16> {
    std::fs::read_to_string(paths.data_dir.join(PORT_FILE))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub fn current_port(app: &AppHandle) -> u16 {
    let port = *app.state::<AppState>().port.lock().unwrap();
    if port == 0 {
        PREFERRED_PORT
    } else {
        port
    }
}

fn mark_reused(state: &AppState, port: u16) {
    *state.port.lock().unwrap() = port;
    let mut slot = state.backend.lock().unwrap();
    slot.owned = false;
    slot.child = None;
    slot.job = None;
    slot.generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.running.store(true, Ordering::SeqCst);
}

fn emit_status(app: &AppHandle, status: &str, port: u16) {
    let _ = app.emit(
        STATUS_EVENT,
        serde_json::json!({ "status": status, "port": port }),
    );
    crate::menu::update_tray_tooltip(app, status, port);
}

/// Starts (or attaches to) the agent and blocks until it is healthy. Returns the port.
pub fn start(app: &AppHandle, progress: &dyn Fn(u8, String)) -> Result<u16, String> {
    let state = app.state::<AppState>();
    let paths = &state.paths;
    let server_index = paths.server_dist.join("index.js");
    if !server_index.exists() {
        return Err(format!(
            "Server-Einstiegspunkt fehlt: {}",
            server_index.display()
        ));
    }

    progress(0, "Agent-Sperre prüfen".into());
    let Some(lock) = NamedMutex::acquire(AGENT_LOCK_NAME)? else {
        // Another process owns the agent (the standalone tauri-server app or a dev setup) -
        // attach to it instead of starting a second one against the same database.
        let candidates = [read_port_file(paths), Some(PREFERRED_PORT)];
        let deadline = Instant::now() + Duration::from_secs(20);
        progress(20, "Mit laufendem Agenten verbinden".into());
        while Instant::now() < deadline {
            if let Some(port) = candidates
                .iter()
                .flatten()
                .copied()
                .find(|p| is_ducki_backend_running(*p))
            {
                log::info!(
                    "Reusing the DucKI agent owned by another process on port {}",
                    port
                );
                mark_reused(&state, port);
                emit_status(app, "running", port);
                return Ok(port);
            }
            thread::sleep(Duration::from_millis(500));
        }
        return Err(
            "Ein anderer DucKI-Agent läuft bereits, antwortet aber nicht. Beende ihn im Task-Manager (node.exe) und versuche es erneut."
                .into(),
        );
    };

    // Prefer the port we used last time (keeps restarts transparent for the open UI), then 3001.
    let previous = *state.port.lock().unwrap();
    let candidates = [previous, PREFERRED_PORT];
    let port = if let Some(port) = candidates
        .into_iter()
        .filter(|p| *p != 0)
        .find(|p| is_port_available(*p))
    {
        port
    } else if is_ducki_backend_running(PREFERRED_PORT) {
        // A dev server started outside this app holds the port without our lock.
        log::info!(
            "Reusing the DucKI agent already listening on port {}",
            PREFERRED_PORT
        );
        drop(lock);
        mark_reused(&state, PREFERRED_PORT);
        emit_status(app, "running", PREFERRED_PORT);
        return Ok(PREFERRED_PORT);
    } else {
        let port = random_free_port().ok_or("Kein freier Port für den Agenten gefunden")?;
        log::warn!(
            "Port {} is taken by another program, using {} instead",
            PREFERRED_PORT,
            port
        );
        port
    };
    let _ = std::fs::write(paths.data_dir.join(PORT_FILE), port.to_string());

    progress(10, format!("Node-Laufzeit startet (Port {})", port));
    log::info!("Starting backend sidecar on port {}", port);
    state.output_tail.lock().unwrap().clear();
    state.stopping.store(false, Ordering::SeqCst);

    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Node-Sidecar nicht gefunden: {}", e))?
        .args([server_index.to_string_lossy().to_string()])
        .current_dir(&paths.data_dir)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("DUCKI_DESKTOP", "1")
        .env("DUCKI_DESKTOP_SHUTDOWN_TOKEN", &state.shutdown_token)
        .env(
            "SHARED_WORKSPACE_PATH",
            paths.workspace_dir.to_string_lossy().to_string(),
        )
        .env(
            "DUCKI_PLUGINS_DIR",
            paths.plugins_dir.to_string_lossy().to_string(),
        )
        .env(
            "SKILLS_PATH",
            paths.skills_dir.to_string_lossy().to_string(),
        )
        .spawn()
        .map_err(|e| format!("Agent konnte nicht gestartet werden: {}", e))?;

    let job = match ProcessJob::for_process(child.pid()) {
        Ok(job) => Some(job),
        Err(e) => {
            log::warn!("Could not attach sidecar to a job object: {}", e);
            None
        }
    };
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut slot = state.backend.lock().unwrap();
        slot.child = Some(child);
        slot.job = job;
        slot.owned = true;
        slot.generation = generation;
    }
    *state.agent_lock.lock().unwrap() = Some(lock);
    *state.port.lock().unwrap() = port;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let state = app_handle.state::<AppState>();
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    log::debug!(target: "server", "{}", line);
                    state.push_output(line);
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    log::warn!(target: "server", "{}", line);
                    state.push_output(line);
                }
                CommandEvent::Error(err) => log::error!("Sidecar error: {}", err),
                CommandEvent::Terminated(payload) => {
                    log::info!(
                        "Server sidecar exited: code={:?} signal={:?}",
                        payload.code,
                        payload.signal
                    );
                    on_sidecar_exit(&app_handle, generation, payload.code);
                }
                _ => {}
            }
        }
    });

    let started = Instant::now();
    let mut attempt = 0u32;
    loop {
        if is_ducki_backend_running(port) {
            log::info!(
                "Backend ready on port {} after {:?}",
                port,
                started.elapsed()
            );
            state.running.store(true, Ordering::SeqCst);
            emit_status(app, "running", port);
            return Ok(port);
        }
        let exited = {
            let slot = state.backend.lock().unwrap();
            slot.generation == generation && slot.child.is_none()
        };
        if exited {
            release_lock(&state);
            return Err(with_output_tail(
                &state,
                "Der Agent hat sich beim Start beendet.",
            ));
        }
        if started.elapsed() > HEALTH_TIMEOUT {
            stop(app);
            return Err(with_output_tail(
                &state,
                &format!(
                    "Der Agent antwortet nach {} s nicht.",
                    HEALTH_TIMEOUT.as_secs()
                ),
            ));
        }
        attempt += 1;
        // Asymptotic 20 → 99 so the bar keeps moving on slow first starts without ever lying
        // about being done.
        let pct = 20 + (79.0 * (1.0 - (-(attempt as f64) / 25.0).exp())) as u8;
        progress(
            pct,
            format!("Warte auf den Agenten … {} s", started.elapsed().as_secs()),
        );
        thread::sleep(Duration::from_millis(400));
    }
}

fn with_output_tail(state: &AppState, message: &str) -> String {
    let tail = state.output_tail.lock().unwrap();
    let lines: Vec<_> = tail
        .iter()
        .rev()
        .take(12)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if lines.is_empty() {
        message.to_string()
    } else {
        format!("{}\n\nLetzte Ausgabe:\n{}", message, lines.join("\n"))
    }
}

fn release_lock(state: &AppState) {
    state.agent_lock.lock().unwrap().take();
}

fn on_sidecar_exit(app: &AppHandle, generation: u64, code: Option<i32>) {
    let state = app.state::<AppState>();
    {
        let mut slot = state.backend.lock().unwrap();
        if slot.generation != generation {
            return;
        }
        slot.child = None;
        // Closing the job kills anything the crashed agent left behind.
        slot.job = None;
    }
    let was_running = state.running.swap(false, Ordering::SeqCst);
    if state.stopping.load(Ordering::SeqCst)
        || state.starting.load(Ordering::SeqCst)
        || !was_running
    {
        return;
    }

    release_lock(&state);
    let port = current_port(app);
    let recent_crashes = {
        let mut times = state.crash_times.lock().unwrap();
        times.retain(|t| t.elapsed() < CRASH_WINDOW);
        times.push(Instant::now());
        times.len()
    };
    log::error!(
        "Agent crashed (code {:?}), crash #{} within 5 min",
        code,
        recent_crashes
    );

    if recent_crashes > MAX_AUTO_RESTARTS {
        emit_status(app, "crashed", port);
        notify(
            app,
            "Der Agent ist wiederholt abgestürzt. Details stehen in den Logs – Neustart über das Tray-Menü.",
        );
        return;
    }
    emit_status(app, "restarting", port);
    notify(
        app,
        "Der Agent wurde unerwartet beendet und wird neu gestartet …",
    );
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2 * recent_crashes as u64));
        crate::startup::restart_backend(&app, false);
    });
}

/// Stops the agent if this app owns it: graceful HTTP shutdown first, job termination after.
pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.stopping.store(true, Ordering::SeqCst);
    let (owned, generation, has_child) = {
        let slot = state.backend.lock().unwrap();
        (slot.owned, slot.generation, slot.child.is_some())
    };
    if owned && has_child {
        let port = current_port(app);
        emit_status(app, "stopping", port);
        if request_graceful_shutdown(port, &state.shutdown_token) {
            let deadline = Instant::now() + GRACEFUL_STOP_TIMEOUT;
            while Instant::now() < deadline {
                let slot = state.backend.lock().unwrap();
                if slot.generation != generation || slot.child.is_none() {
                    break;
                }
                drop(slot);
                thread::sleep(Duration::from_millis(100));
            }
        }
        let mut slot = state.backend.lock().unwrap();
        if slot.generation == generation {
            if let Some(job) = slot.job.take() {
                job.terminate();
            }
            if let Some(child) = slot.child.take() {
                let _ = child.kill();
            }
        }
        log::info!("Backend stopped");
    }
    {
        let mut slot = state.backend.lock().unwrap();
        slot.owned = false;
    }
    state.running.store(false, Ordering::SeqCst);
    release_lock(&state);
}

pub fn notify(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("DucKI Node")
        .body(body)
        .show();
}
