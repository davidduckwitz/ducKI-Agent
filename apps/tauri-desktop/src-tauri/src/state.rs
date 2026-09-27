use std::collections::VecDeque;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;
use std::time::Instant;

use tauri::menu::CheckMenuItem;
use tauri::tray::TrayIcon;
use tauri::Wry;
use tauri_plugin_shell::process::CommandChild;

use crate::desktop::DesktopPrefs;
use crate::paths::AppPaths;
use crate::startup::StartupStatus;
use crate::win::{NamedMutex, ProcessJob};

/// The sidecar this app spawned (if any). `generation` identifies one particular spawn so a late
/// `Terminated` event from a previous run can never clobber the state of the current one.
#[derive(Default)]
pub struct BackendSlot {
    pub child: Option<CommandChild>,
    pub job: Option<ProcessJob>,
    pub owned: bool,
    pub generation: u64,
}

pub struct AppState {
    pub paths: AppPaths,
    pub port: Mutex<u16>,
    pub running: AtomicBool,
    pub backend: Mutex<BackendSlot>,
    pub generation: AtomicU64,
    pub agent_lock: Mutex<Option<NamedMutex>>,
    /// Set while we deliberately stop the sidecar, so its exit is not treated as a crash.
    pub stopping: AtomicBool,
    /// Set while a startup/restart sequence runs; guards against overlapping starts.
    pub starting: AtomicBool,
    pub crash_times: Mutex<Vec<Instant>>,
    pub startup: Mutex<StartupStatus>,
    /// Last lines of sidecar output, shown on the splash screen when the start fails.
    pub output_tail: Mutex<VecDeque<String>>,
    pub prefs: Mutex<DesktopPrefs>,
    pub zoom: Mutex<f64>,
    pub shutdown_token: String,
    pub start_minimized: bool,
    pub autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    pub tray: Mutex<Option<TrayIcon<Wry>>>,
}

pub const OUTPUT_TAIL_LINES: usize = 40;

impl AppState {
    pub fn new(paths: AppPaths, prefs: DesktopPrefs, start_minimized: bool) -> Self {
        Self {
            paths,
            port: Mutex::new(0),
            running: AtomicBool::new(false),
            backend: Mutex::new(BackendSlot::default()),
            generation: AtomicU64::new(0),
            agent_lock: Mutex::new(None),
            stopping: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            crash_times: Mutex::new(Vec::new()),
            startup: Mutex::new(StartupStatus::default()),
            output_tail: Mutex::new(VecDeque::with_capacity(OUTPUT_TAIL_LINES)),
            prefs: Mutex::new(prefs),
            zoom: Mutex::new(1.0),
            shutdown_token: random_token(),
            start_minimized,
            autostart_item: Mutex::new(None),
            tray: Mutex::new(None),
        }
    }

    pub fn push_output(&self, line: String) {
        let mut tail = self.output_tail.lock().unwrap();
        if tail.len() >= OUTPUT_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }
}

/// 128 bits from two independently keyed SipHash instances. `RandomState` is seeded from the OS
/// RNG per process, which is plenty for a loopback-only shutdown token.
fn random_token() -> String {
    let mut out = String::with_capacity(32);
    for salt in [0x9e37_79b9_7f4a_7c15u64, std::process::id() as u64] {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default(),
        );
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}
