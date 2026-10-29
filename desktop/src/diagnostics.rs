//! Local run journal. File IO is off the UI thread; fatal evidence has an independent path.
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
const FILE_LIMIT: u64 = 10 * 1024 * 1024;
const RUN_LIMIT: u64 = 200 * 1024 * 1024;
static STARTED: OnceLock<std::time::Instant> = OnceLock::new();
static RUN: OnceLock<PathBuf> = OnceLock::new();
enum Work {
    Event(Value),
    Flush(mpsc::SyncSender<()>),
}
static SENDER: OnceLock<mpsc::SyncSender<Work>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);
static WEB_HEARTBEAT: AtomicU64 = AtomicU64::new(0);
static WEB_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn run_dir() -> Option<&'static Path> {
    RUN.get().map(PathBuf::as_path)
}
fn atomic_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(tmp, path)
}
fn append(dir: &Path, name: &str, value: &Value) -> std::io::Result<()> {
    let file = dir.join(name);
    if fs::metadata(&file)
        .map(|m| m.len() >= FILE_LIMIT)
        .unwrap_or(false)
    {
        let previous = dir.join(format!("{name}.1"));
        let _ = fs::remove_file(&previous);
        fs::rename(&file, previous)?;
    }
    let mut output = OpenOptions::new().create(true).append(true).open(file)?;
    writeln!(output, "{}", value)
}
fn size(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_symlink() {
                return 0;
            }
            if p.is_dir() {
                size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}
fn prune(root: &Path, active: &Path) {
    let mut runs: Vec<_> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_type()
                .map(|t| t.is_dir() && !t.is_symlink())
                .unwrap_or(false)
        })
        .collect();
    runs.sort_by_key(|e| e.file_name());
    let mut total = size(root);
    for entry in runs {
        let path = entry.path();
        if path == active {
            continue;
        }
        // Never delete another concurrently running instance's journal.
        if !path.join("finished.json").exists() {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs() > 7 * 86400)
            .unwrap_or(false);
        if old || total > RUN_LIMIT {
            let bytes = size(&path);
            if fs::remove_dir_all(path).is_ok() {
                total = total.saturating_sub(bytes);
            }
        }
    }
}
pub fn data_directory() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("WOOHAA_DESKTOP_DATA_DIR") {
        return Some(PathBuf::from(custom));
    }
    #[cfg(target_os = "macos")]
    let platform_base =
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let platform_base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let platform_base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    platform_base.map(|p| {
        p.join(if cfg!(debug_assertions) {
            "com.woohaa.desktop.dev"
        } else {
            "com.woohaa.desktop"
        })
    })
}
pub fn initialize() {
    let _ = STARTED.set(std::time::Instant::now());
    let base = data_directory();
    let Some(base) = base else {
        return;
    };
    let id = format!("{}-{}", now(), uuid::Uuid::new_v4());
    let dir = base.join("logs/runs").join(&id);
    if fs::create_dir_all(dir.join("incidents")).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(base.join("logs"), fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(base.join("logs/runs"), fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    if RUN.set(dir.clone()).is_err() {
        return;
    }
    let _ = atomic_json(
        &dir.join("session.json"),
        &json!({"schema":1,"runId":id,"startedAt":now(),"pid":std::process::id(),"version":serde_json::from_str::<Value>(include_str!("../tauri.conf.json")).ok().map(|v|v["version"].clone()),"revision":option_env!("WOOHAA_DIAGNOSTIC_REVISION").unwrap_or("unknown"),"executable":std::env::current_exe().ok(),"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"debug":cfg!(debug_assertions)}),
    );
    // Finder launches have no attached terminal. Capture native runtime stderr/stdout too.
    #[cfg(unix)]
    if !cfg!(debug_assertions) {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn dup2(old: i32, new: i32) -> i32;
        }
        for (fd, name) in [(1, "native-stdout.log"), (2, "native-stderr.log")] {
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(name))
            {
                unsafe {
                    dup2(file.as_raw_fd(), fd);
                }
            }
        }
    }
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        use std::os::windows::io::IntoRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn SetStdHandle(kind: u32, handle: *mut std::ffi::c_void) -> i32;
        }
        for (kind, name) in [
            (0xfffffff5, "native-stdout.log"),
            (0xfffffff4, "native-stderr.log"),
        ] {
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(name))
            {
                // Handle intentionally remains open until process exit.
                unsafe {
                    SetStdHandle(kind, file.into_raw_handle());
                }
            }
        }
    }
    let (tx, rx) = mpsc::sync_channel(512);
    let _ = SENDER.set(tx);
    let writer_dir = dir.clone();
    std::thread::spawn(move || {
        for work in rx {
            let mut value = match work {
                Work::Event(value) => value,
                Work::Flush(ack) => {
                    let _ = ack.try_send(());
                    continue;
                }
            };
            value["dropped"] = json!(DROPPED.swap(0, Ordering::Relaxed));
            let name = if value["source"] == "webview" {
                "webview.jsonl"
            } else {
                "desktop.jsonl"
            };
            if append(&writer_dir, name, &value).is_err() {
                DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
    });
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = run_dir() {
            let value = json!({"time":now(),"event":"rust-panic","message":info.to_string(),"backtrace":std::backtrace::Backtrace::force_capture().to_string()});
            if let Ok(mut f) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("incidents/panic.jsonl"))
            {
                let _ = writeln!(f, "{value}");
                let _ = f.sync_data();
            }
        }
        previous(info);
    }));
    event("desktop", "process-start", json!({"runId":id}));
    let binary_dir = dir.clone();
    std::thread::spawn(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        if let Ok(mut file) = std::env::current_exe().and_then(fs::File::open) {
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 64 * 1024];
            loop {
                match file.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => hasher.update(&buffer[..n]),
                    Err(_) => return,
                }
            }
            let _ = atomic_json(
                &binary_dir.join("binary.json"),
                &json!({"sha256":format!("{:x}",hasher.finalize()),"revision":option_env!("WOOHAA_DIAGNOSTIC_REVISION").unwrap_or("unknown")}),
            );
        }
    });
    let history_root = base.join("logs/runs");
    let history_dir = dir.clone();
    std::thread::spawn(move || {
        crate::diagnostic_history::recover(&history_root, &history_dir);
        loop {
            prune(&history_root, &history_dir);
            if history_dir.join("finished.json").exists() {
                break;
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
    if let Ok(exe) = std::env::current_exe() {
        let mut command = std::process::Command::new(exe);
        command
            .arg("--diagnostic-watchdog")
            .arg(&dir)
            .arg(std::process::id().to_string());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        if let Err(e) = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            event(
                "desktop",
                "watchdog-start-failed",
                json!({"error":e.to_string()}),
            );
        }
    }
}
pub fn event(source: &str, event: &str, detail: Value) {
    if let Some(tx) = SENDER.get() {
        if tx.try_send(Work::Event(json!({"time":now(),"elapsedMs":STARTED.get().map(|s|s.elapsed().as_millis() as u64),"pid":std::process::id(),"source":source,"event":event,"detail":detail}))).is_err() {DROPPED.fetch_add(1,Ordering::Relaxed);}
    }
}
pub fn stderr(args: std::fmt::Arguments<'_>) {
    let message = args.to_string();
    eprintln!("{message}");
    event("desktop", "message", json!({"message":message}));
}
pub fn flush() {
    if let Some(tx) = SENDER.get() {
        let (ack, rx) = mpsc::sync_channel(1);
        if tx.try_send(Work::Flush(ack)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_millis(500));
        }
    }
}
fn finish_at(dir: &Path, clean: bool) {
    let _ = atomic_json(
        &dir.join("finished.json"),
        &json!({"time":now(),"status":if clean {"clean_exit"}else{"failed_exit"}}),
    );
}
pub fn finish(clean: bool) {
    flush();
    if let Some(dir) = run_dir() {
        finish_at(dir, clean);
    }
}
fn finish_for_event(dir: &Path, event: &tauri::RunEvent) {
    // ExitRequested can be prevented (cancelled confirmation or failed host shutdown).
    // Only Exit is final. App::run exits the process directly, so code after it cannot journal.
    if matches!(event, tauri::RunEvent::Exit) {
        flush();
        finish_at(dir, true);
    }
}
pub fn handle_run_event(event: &tauri::RunEvent) {
    if let Some(dir) = run_dir() {
        finish_for_event(dir, event);
    }
}
pub fn ingest(body: &[u8]) -> Result<(), String> {
    if body.len() > 64 * 1024 {
        return Err("Diagnostic payload exceeds budget".into());
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "Invalid diagnostics")?;
    let events = value["events"].as_array().ok_or("Missing events")?;
    if events.len() > 20 {
        return Err("Too many diagnostic events".into());
    }
    let mut accepted = Vec::new();
    for e in events {
        let name = e["event"].as_str().ok_or("Invalid event")?;
        if ![
            "collector-ready",
            "request-failed",
            "console",
            "error",
            "resource-error",
            "unhandledrejection",
            "pagehide",
            "pageshow",
        ]
        .contains(&name)
        {
            return Err("Unknown event".into());
        }
        let message = e["message"].as_str().ok_or("Invalid message")?;
        if message.len() > 8192 {
            return Err("Message exceeds budget".into());
        }
        let level = e["level"]
            .as_str()
            .filter(|s| ["debug", "info", "warn", "error"].contains(s))
            .ok_or("Invalid level")?;
        accepted.push(json!({"event":name,"level":level,"message":message,"clientTime":e["clientTime"].as_u64()}));
    }
    WEB_VISIBLE.store(value["visibility"] != "hidden", Ordering::Relaxed);
    WEB_HEARTBEAT.store(now(), Ordering::Relaxed);
    if !accepted.is_empty() || value["dropped"].as_u64().unwrap_or(0) > 0 {
        event(
            "webview",
            "batch",
            json!({"events":accepted,"clientDropped":value["dropped"].as_u64().unwrap_or(0)}),
        );
    }
    Ok(())
}
/// Main-thread ping is bounded to one outstanding callback. No renderer or JS calls.
pub fn start_heartbeat(app: tauri::AppHandle) {
    let Some(dir) = run_dir().map(Path::to_path_buf) else {
        return;
    };
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::sync_channel(1);
        loop {
            let tx = tx.clone();
            if app
                .run_on_main_thread(move || {
                    let _ = tx.try_send(now());
                })
                .is_err()
            {
                break;
            }
            loop {
                match rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(time) => {
                        let _ = atomic_json(
                            &dir.join("heartbeat.json"),
                            &json!({"main":time,"webview":WEB_HEARTBEAT.load(Ordering::Relaxed),"webVisible":WEB_VISIBLE.load(Ordering::Relaxed)}),
                        );
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if dir.join("finished.json").exists() {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            }
            if dir.join("finished.json").exists() {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_completed_app_exit_marks_the_journal_clean() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&dir).unwrap();
        for event in [tauri::RunEvent::Ready, tauri::RunEvent::Resumed] {
            finish_for_event(&dir, &event);
            assert!(!dir.join("finished.json").exists());
        }
        finish_for_event(&dir, &tauri::RunEvent::Exit);
        let value: Value =
            serde_json::from_slice(&fs::read(dir.join("finished.json")).unwrap()).unwrap();
        assert_eq!(value["status"], "clean_exit");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn diagnostic_protocol_rejects_unbounded_and_unknown_input() {
        assert!(ingest(&vec![b' '; 65537]).is_err());
        assert!(
            ingest(br#"{"events":[{"event":"arbitrary","message":"x","level":"error"}]}"#).is_err()
        );
        assert!(ingest(br#"{"events":[{"event":"error","message":"failure","level":"error"}],"visibility":"visible"}"#).is_ok());
    }
    #[test]
    fn data_path_includes_application_identifier() {
        if std::env::var_os("WOOHAA_DESKTOP_DATA_DIR").is_none() {
            assert_eq!(
                data_directory().unwrap().file_name().unwrap(),
                if cfg!(debug_assertions) {
                    "com.woohaa.desktop.dev"
                } else {
                    "com.woohaa.desktop"
                }
            );
        }
    }
    #[test]
    fn writer_rotates_and_journal_is_atomic() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&dir).unwrap();
        let f = OpenOptions::new()
            .create(true)
            .write(true)
            .open(dir.join("desktop.jsonl"))
            .unwrap();
        f.set_len(FILE_LIMIT).unwrap();
        drop(f);
        append(&dir, "desktop.jsonl", &json!({"event":"after-rotation"})).unwrap();
        assert_eq!(
            fs::metadata(dir.join("desktop.jsonl.1")).unwrap().len(),
            FILE_LIMIT
        );
        atomic_json(&dir.join("session.json"), &json!({"status":"running"})).unwrap();
        assert!(!dir.join("session.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}

pub fn node_heartbeat(pid: u32, alive: bool) {
    if let Some(dir) = run_dir() {
        let _ = atomic_json(
            &dir.join("node-heartbeat.json"),
            &json!({"time":now(),"pid":pid,"alive":alive}),
        );
    }
}
