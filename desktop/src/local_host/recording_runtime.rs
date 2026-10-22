//! Wait for an explicitly installed recording component without blocking host startup.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) struct RecordingRuntime {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for RecordingRuntime {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

fn managed_worker(launch: &Launch) -> Option<(PathBuf, PathBuf)> {
    let lock: serde_json::Value = serde_json::from_slice(&std::fs::read(launch.root.join("runtime-components.lock.json")).ok()?).ok()?;
    let version = lock["components"]["shot-recorder"]["version"].as_str()?;
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')) { return None; }
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let platform = if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "win32" } else { "linux" };
    let directory = launch.data.join("runtimes/shot-recorder").join(version).join(format!("{platform}-{arch}"));
    let ready: serde_json::Value = serde_json::from_slice(&std::fs::read(directory.join("ready.json")).ok()?).ok()?;
    if ready["version"].as_str()? != version || ready["kind"].as_str()? != "executable" { return None; }
    let entry = PathBuf::from(ready["entry"].as_str()?);
    let canonical = entry.canonicalize().ok()?;
    if !canonical.starts_with(directory.canonicalize().ok()?) || !canonical.is_file() { return None; }
    Some((canonical, directory))
}

pub(super) fn start(launch: &Launch) -> RecordingRuntime {
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let launch = launch.clone();
    let thread = std::thread::spawn(move || {
        let mut connection: Option<woohaa_recording_supervisor::connection::ConnectionGuard> = None;
        let mut lease_file: Option<PathBuf> = None;
        while !stopping.load(Ordering::Acquire) {
            if let Some(file) = lease_file.as_ref() {
                let requested = file.parent().and_then(|p| p.parent()).is_some_and(|p| p.join(".release-requested").exists());
                if requested { if let Some(guard) = connection.as_ref() { guard.request_idle_stop(); } }
                if connection.as_ref().is_some_and(|guard| guard.is_stopped()) {
                    drop(connection.take());
                    if let Some(file) = lease_file.take() { let _ = std::fs::remove_file(file); }
                }
            }
            if connection.is_none() {
                if let Ok(mut config) = recording_config(&launch) {
                    let managed = managed_worker(&launch);
                    if let Some((entry, directory)) = managed {
                        if directory.join(".release-requested").exists() { std::thread::sleep(Duration::from_millis(100)); continue; }
                        let leases = directory.join(".leases");
                        let lease_directory = std::fs::create_dir(&leases);
                        if lease_directory.is_ok() || (lease_directory.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) && leases.is_dir()) {
                            let file = leases.join(format!("{}-{}.json", std::process::id(), uuid::Uuid::new_v4()));
                            if std::fs::write(&file, serde_json::json!({"pid":std::process::id()}).to_string()).is_ok() {
                                // Removal may have renamed the installation while the lease
                                // was being acquired. Revalidate before starting any worker.
                                if managed_worker(&launch).is_some_and(|(current, _)| current == entry) {
                                    config.worker_path = entry;
                                    lease_file = Some(file);
                                } else { let _ = std::fs::remove_file(file); }
                            }
                        }
                    }
                    if config.worker_path.is_file() {
                        match woohaa_recording_supervisor::connection::start(config) {
                            Ok(guard) => connection = Some(guard),
                            Err(error) => eprintln!("原生录制不可用：{}", error.message),
                        }
                    }
                    if connection.is_none() {
                        if let Some(file) = lease_file.take() { let _ = std::fs::remove_file(file); }
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        drop(connection);
        if let Some(file) = lease_file { let _ = std::fs::remove_file(file); }
    });
    RecordingRuntime { stop, thread: Some(thread) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_locked_installed_worker_inside_component_directory() {
        let data = std::env::temp_dir().join(format!("woohaa-managed-recorder-{}", uuid::Uuid::new_v4()));
        let root = data.join("resources"); std::fs::create_dir_all(&root).unwrap();
        let launch = Launch { node: root.join("node"), root: root.clone(), data: data.clone() };
        std::fs::write(root.join("runtime-components.lock.json"), r#"{"components":{"shot-recorder":{"version":"v1"}}}"#).unwrap();
        assert!(managed_worker(&launch).is_none());
        let platform = if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "win32" } else { "linux" };
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        let directory = data.join("runtimes/shot-recorder/v1").join(format!("{platform}-{arch}"));
        std::fs::create_dir_all(&directory).unwrap();
        let entry = directory.join("worker"); std::fs::write(&entry, b"fixture").unwrap();
        let ready = directory.join("ready.json");
        std::fs::write(&ready, serde_json::json!({"entry":entry,"version":"v1","kind":"executable"}).to_string()).unwrap();
        assert_eq!(managed_worker(&launch).unwrap().0, entry.canonicalize().unwrap());
        std::fs::write(&ready, serde_json::json!({"entry":std::env::current_exe().unwrap(),"version":"v1","kind":"executable"}).to_string()).unwrap();
        assert!(managed_worker(&launch).is_none());
        std::fs::remove_dir_all(data).unwrap();
    }
}
