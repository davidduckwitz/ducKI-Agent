//! Thin wrappers around the few Win32 primitives the desktop shell needs: a named mutex that
//! marks "this process owns the DucKI agent", and a job object that ties the Node sidecar's whole
//! process tree to our lifetime. Non-Windows builds get no-op stand-ins so the rest of the code
//! stays platform-agnostic.

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateMutexW, OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct NamedMutex(HANDLE);

    // Kernel handles are process-wide; moving one between threads is fine.
    unsafe impl Send for NamedMutex {}
    unsafe impl Sync for NamedMutex {}

    impl NamedMutex {
        /// `Ok(None)` when another process already holds a mutex with this name.
        pub fn acquire(name: &str) -> Result<Option<Self>, String> {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            unsafe {
                let handle = CreateMutexW(std::ptr::null(), 0, wide.as_ptr());
                if handle.is_null() {
                    return Err(format!("CreateMutexW failed ({})", GetLastError()));
                }
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    CloseHandle(handle);
                    return Ok(None);
                }
                Ok(Some(Self(handle)))
            }
        }
    }

    impl Drop for NamedMutex {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// Job object with KILL_ON_JOB_CLOSE: every process Node spawns (STT server, ffmpeg,
    /// headless browsers, shell-tool dev servers, ...) inherits the job, so dropping this handle -
    /// or this process dying for any reason - takes the whole tree down instead of leaving orphans
    /// that keep ports and VRAM busy.
    pub struct ProcessJob(HANDLE);

    unsafe impl Send for ProcessJob {}
    unsafe impl Sync for ProcessJob {}

    impl ProcessJob {
        pub fn for_process(pid: u32) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(format!("CreateJobObjectW failed ({})", GetLastError()));
                }
                let job = Self(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(format!(
                        "SetInformationJobObject failed ({})",
                        GetLastError()
                    ));
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(format!("OpenProcess({}) failed ({})", pid, GetLastError()));
                }
                let assigned = AssignProcessToJobObject(job.0, process);
                CloseHandle(process);
                if assigned == 0 {
                    return Err(format!(
                        "AssignProcessToJobObject failed ({})",
                        GetLastError()
                    ));
                }
                Ok(job)
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct NamedMutex;

    impl NamedMutex {
        pub fn acquire(_name: &str) -> Result<Option<Self>, String> {
            Ok(Some(Self))
        }
    }

    pub struct ProcessJob;

    impl ProcessJob {
        pub fn for_process(_pid: u32) -> Result<Self, String> {
            Ok(Self)
        }

        pub fn terminate(&self) {}
    }
}

pub use imp::{NamedMutex, ProcessJob};
