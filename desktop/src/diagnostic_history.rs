//! Recover journals when the watchdog was also killed; associate OS reports conservatively.
use serde_json::{Value, json};
use std::{fs, path::Path};
fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // pid 0 is never accepted (it addresses a process group).
        if pid == 0 || pid > i32::MAX as u32 {
            return true;
        }
        unsafe {
            kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1)
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(true)
    }
}
pub fn recover(root: &Path, current: &Path) {
    let mut runs: Vec<_> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p != current && p.is_dir() && !p.is_symlink())
        .collect();
    runs.sort();
    for dir in runs.iter().rev() {
        let session = read(&dir.join("session.json"));
        let Some(pid) = session["pid"].as_u64().and_then(|p| u32::try_from(p).ok()) else {
            continue;
        };
        if !dir.join("finished.json").exists() && !process_alive(pid) {
            let _=fs::write(dir.join("finished.json"),json!({"status":"abnormal_exit","detectedAt":crate::diagnostics::now(),"cause":"unknown; recovered on next launch"}).to_string());
        }
    }
    if let Some(dir) = runs.into_iter().rev().find(|d| {
        let status = read(&d.join("finished.json"));
        !status.is_null() && status["status"] != "clean_exit"
    }) {
        crate::diagnostics::event(
            "desktop",
            "previous-abnormal-exit",
            json!({"run":dir.file_name(),"status":read(&dir.join("finished.json"))}),
        );
        collect_reports(&dir);
    }
}
#[cfg(target_os = "macos")]
fn collect_reports(dir: &Path) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let reports = std::path::PathBuf::from(home).join("Library/Logs/DiagnosticReports");
    let session = read(&dir.join("session.json"));
    let Some(pid) = session["pid"].as_u64() else {
        return;
    };
    let mut pids = vec![pid];
    if let Ok(events) = fs::read_to_string(dir.join("desktop.jsonl")) {
        for line in events.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if v["source"] == "host" && v["event"] == "process-start" {
                    if let Some(pid) = v["detail"]["pid"].as_u64() {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    let started = session["startedAt"].as_u64().unwrap_or(u64::MAX);
    let end = read(&dir.join("finished.json"))["time"]
        .as_u64()
        .unwrap_or_else(crate::diagnostics::now);
    let mut files: Vec<_> = fs::read_dir(reports)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("woohaa-")
                && e.path().extension().is_some_and(|e| e == "ips")
        })
        .collect();
    files.sort_by_key(|e| e.file_name());
    let mut count = 0;
    for file in files.into_iter().rev().take(100) {
        let Ok(meta) = file.metadata() else {
            continue;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if meta.len() > 5 * 1024 * 1024
            || modified < started
            || modified > end.saturating_add(120_000)
        {
            continue;
        }
        let Ok(text) = fs::read_to_string(file.path()) else {
            continue;
        };
        let Some((_, body)) = text.split_once('\n') else {
            continue;
        };
        let Ok(report) = serde_json::from_str::<Value>(body) else {
            continue;
        };
        if report["pid"].as_u64().is_some_and(|p| pids.contains(&p)) {
            let _ = fs::create_dir_all(dir.join("incidents"));
            let _ = fs::copy(file.path(), dir.join("incidents").join(file.file_name()));
            count += 1;
            if count == 3 {
                break;
            }
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn collect_reports(_dir: &Path) {}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_process_is_not_marked_as_crashed() {
        assert!(process_alive(std::process::id()));
        assert!(process_alive(0));
    }
}
