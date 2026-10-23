//! Separate process: survives a blocked desktop main thread and does not initialize Tauri/GPU.
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};
fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn write(path: &Path, value: Value) {
    let _ = fs::write(path, value.to_string());
}
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // The watchdog is a direct child; reparenting means the exact original parent exited.
        unsafe extern "C" {
            fn getppid() -> i32;
        }
        unsafe { getppid() == pid as i32 }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x08000000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }
}
fn sample(dir: &Path, pid: u32, incident: u64) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(stats) = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "pid=,rss=,vsz=,etime=,state="])
            .output()
        {
            write(
                &dir.join(format!("incidents/{incident}-process.json")),
                json!({"columns":"pid rssKiB virtualKiB elapsed state","value":String::from_utf8_lossy(&stats.stdout)}),
            );
        }
        let output = dir.join(format!("incidents/{incident}-sample.txt"));
        match std::process::Command::new("/usr/bin/sample")
            .arg(pid.to_string())
            .args(["3", "10", "-file"])
            .arg(&output)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                let start = Instant::now();
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            if fs::metadata(&output)
                                .map(|m| m.len() > 5 * 1024 * 1024)
                                .unwrap_or(false)
                            {
                                if let Ok(f) = fs::OpenOptions::new().write(true).open(&output) {
                                    let _ = f.set_len(5 * 1024 * 1024);
                                }
                            }
                            write(
                                &dir.join(format!("incidents/{incident}-sample-status.json")),
                                json!({"success":status.success(),"code":status.code()}),
                            );
                            break;
                        }
                        Err(e) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            write(
                                &dir.join(format!("incidents/{incident}-sample-status.json")),
                                json!({"error":e.to_string()}),
                            );
                            break;
                        }
                        _ if start.elapsed() > Duration::from_secs(8) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            write(
                                &dir.join(format!("incidents/{incident}-sample-status.json")),
                                json!({"error":"sample timed out"}),
                            );
                            break;
                        }
                        _ => std::thread::sleep(Duration::from_millis(100)),
                    }
                }
            }
            Err(e) => write(
                &dir.join(format!("incidents/{incident}-sample-status.json")),
                json!({"error":e.to_string()}),
            ),
        }
    }
    #[cfg(not(target_os = "macos"))]
    write(
        &dir.join(format!("incidents/{incident}-sample-status.json")),
        json!({"status":"unsupported-platform","pid":pid}),
    );
}
pub fn run(dir: &Path, pid: u32) {
    let start = crate::diagnostics::now();
    let mut grace = start;
    let mut previous = start;
    let mut active = None;
    let mut count = 0;
    let mut last_sample = 0;
    while alive(pid) && !dir.join("finished.json").exists() {
        let now = crate::diagnostics::now();
        // Wall-clock jumps / sleep suspend the process. Allow fresh heartbeats before classifying.
        if now.saturating_sub(previous) > 8000 || now < previous {
            grace = now;
            active = None;
        }
        previous = now;
        // Raw inherited descriptors use O_APPEND; truncate in place rather than rename them.
        for name in ["host-stderr.log", "native-stdout.log", "native-stderr.log"] {
            let path = dir.join(name);
            if fs::metadata(&path)
                .map(|m| m.len() > 10 * 1024 * 1024)
                .unwrap_or(false)
            {
                let _ = fs::copy(&path, dir.join(format!("{name}.1")));
                if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
                    let _ = file.set_len(0);
                }
            }
        }
        let heartbeat = read(&dir.join("heartbeat.json"));
        let main = heartbeat["main"].as_u64().unwrap_or(start);
        let web = heartbeat["webview"].as_u64().unwrap_or(0);
        let stale_main = now.saturating_sub(main.max(grace)) > 10_000;
        let stale_web = web > 0
            && heartbeat["webVisible"] == true
            && now.saturating_sub(web.max(grace)) > 15_000;
        let node = read(&dir.join("node-heartbeat.json"));
        let stale_node = node["alive"] == true
            && now.saturating_sub(node["time"].as_u64().unwrap_or(now).max(grace)) > 10_000;
        let target = if stale_main || stale_web {
            pid
        } else {
            node["pid"].as_u64().unwrap_or(u64::from(pid)) as u32
        };
        if stale_main || stale_web || stale_node {
            if active.is_none() && count < 5 && now.saturating_sub(last_sample) > 60_000 {
                count += 1;
                active = Some(now);
                last_sample = now;
                write(
                    &dir.join(format!("incidents/{now}-hang.json")),
                    json!({"event":"unresponsive","time":now,"pid":pid,"mainStale":stale_main,"webviewStale":stale_web,"nodeStale":stale_node,"samplePid":target,"heartbeat":heartbeat}),
                );
                sample(dir, target, now);
                // Sampling itself blocks monitoring for a few seconds, not a system sleep.
                previous = crate::diagnostics::now();
            }
        } else if let Some(incident) = active.take() {
            write(
                &dir.join(format!("incidents/{incident}-recovered.json")),
                json!({"time":now,"durationMs":now.saturating_sub(incident)}),
            );
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    if !dir.join("finished.json").exists() {
        write(
            &dir.join("finished.json"),
            json!({"status":"abnormal_exit","time":crate::diagnostics::now(),"cause":"unknown; no clean exit marker"}),
        );
    }
}
