//! 录制执行器 supervisor
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.5 / design D1）。
//!
//! 职责边界（只做这三件事）：
//! - 从**可信启动配置**拿到 socket 路径与注册 nonce，向本机宿主注册执行器能力；
//! - 按宿主指令启动/停止 `shot-recorder` 子进程，每次 attempt 一个进程；
//! - 宿主消失或 lease 过期时**有限终止**子进程并清理私有临时目录。
//!
//! **不**通过 Tauri 主循环、窗口 tick 或 WebView timer 推进录制：worker 自己跑事件循环，
//! supervisor 只做进程与连接管理。因此可见 renderer 重建、窗口最小化都不影响录制。
//!
//! 独立 crate 不依赖 Tauri/Bevy；连接线程独立管理注册、心跳与 worker 控制帧。
//! JSON 协议使用 serde_json，checkout 身份使用 SHA-256，与宿主 paths.ts 一致。

pub mod connection;
#[cfg(windows)]
mod named_pipe;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Recorder helpers are native background children of the desktop application.
fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = &mut command;
    command
}

/// supervisor 从可信启动配置读取的定位信息。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupervisorConfig {
    /// 宿主 socket 的绝对路径。
    pub socket_path: PathBuf,
    /// 注册 nonce 文件（与 socket 同目录，0600）。
    pub nonce_path: PathBuf,
    /// worker 可执行文件（由应用资源提供，不来自 UI 或 PATH 搜索）。
    pub worker_path: PathBuf,
    /// 每个 attempt 的私有工作目录根。
    pub work_root: PathBuf,
    /// 本执行器实例 id（同一宿主内唯一）。
    pub executor_instance_id: String,
    /// checkout 身份：与宿主绑定的工作区一致，跨 worktree 会被拒绝。
    pub checkout_id: String,
    /// lease 时长（毫秒）。
    pub lease_ms: u64,
    /// 终止子进程前的宽限时间。
    pub terminate_grace: Duration,
}

impl SupervisorConfig {
    /// 校验路径与身份；缺失或为空即视为配置错误（不静默降级）。
    pub fn validate(&self) -> Result<(), SupervisorError> {
        if !self.socket_path.is_absolute() {
            return Err(SupervisorError::config("socket 路径必须是绝对路径"));
        }
        if !self.worker_path.is_absolute() {
            return Err(SupervisorError::config("worker 路径必须是绝对路径"));
        }
        if self.executor_instance_id.trim().is_empty() {
            return Err(SupervisorError::config("executorInstanceId 不能为空"));
        }
        if self.checkout_id.trim().is_empty() {
            return Err(SupervisorError::config("checkoutId 不能为空"));
        }
        if self.lease_ms == 0 {
            return Err(SupervisorError::config("lease 必须为正"));
        }
        Ok(())
    }

    /// 为某个 attempt 分配私有工作目录（每个 attempt 独立，结束即删）。
    pub fn attempt_directory(&self, attempt_id: &str) -> PathBuf {
        // attemptId 来自宿主，但仍做最小化清洗，避免路径穿越或空名。
        let safe: String = attempt_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        self.work_root.join(if safe.is_empty() { "attempt".to_owned() } else { safe })
    }
}

/// supervisor 的稳定错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupervisorError {
    pub code: &'static str,
    pub message: String,
}

impl SupervisorError {
    pub fn config(message: impl Into<String>) -> Self {
        Self { code: "recording-supervisor-config-invalid", message: message.into() }
    }

    pub fn spawn(message: impl Into<String>) -> Self {
        Self { code: "recording-worker-spawn-failed", message: message.into() }
    }

    pub fn terminated(message: impl Into<String>) -> Self {
        Self { code: "recording-worker-terminated", message: message.into() }
    }
}

/// 一个在跑的 worker。
pub struct WorkerProcess {
    pub attempt_id: String,
    pub directory: PathBuf,
    child: Child,
    started: Instant,
}

impl WorkerProcess {
    /// 进程是否仍在运行（顺带回收僵尸）。
    pub fn running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// 已运行时长。
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// 有限终止：先 kill，再在宽限期内回收；超时也返回（不无限等待）。
    pub fn terminate(&mut self, grace: Duration) -> Result<(), SupervisorError> {
        let _ = self.child.kill();
        let deadline = Instant::now() + grace;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(None) => {
                    // 宽限期内没退出：已经 kill 过，不再等待，交给 OS 回收。
                    return Ok(());
                }
                Err(error) => {
                    return Err(SupervisorError::terminated(format!("回收 worker 失败：{error}")));
                }
            }
        }
    }
}

impl Drop for WorkerProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 同时最多一个活动 worker 的 supervisor。
///
/// 一个执行租约至多一个 worker：新 attempt 必须先终止旧 worker（design D1）。
#[derive(Default)]
pub struct RecordingSupervisor {
    active: BTreeMap<String, WorkerProcess>,
}

impl RecordingSupervisor {
    pub fn new() -> Self {
        Self { active: BTreeMap::new() }
    }

    /// 当前活动 worker 数（生产上限为 1）。
    pub fn active_count(&self) -> usize {
        self.active.len()
    }

    pub fn is_running(&mut self, attempt_id: &str) -> bool {
        self.active
            .get_mut(attempt_id)
            .map(|worker| worker.running())
            .unwrap_or(false)
    }

    /// 启动一个 attempt 的 worker；已有活动 worker 时先终止它。
    pub fn start(
        &mut self,
        config: &SupervisorConfig,
        attempt_id: &str,
        nonce: &str,
    ) -> Result<(), SupervisorError> {
        config.validate()?;
        self.stop_all(config.terminate_grace)?;
        let directory = config.attempt_directory(attempt_id);
        std::fs::create_dir_all(&directory)
            .map_err(|error| SupervisorError::spawn(format!("无法创建 attempt 目录：{error}")))?;

        std::fs::write(directory.join("lease.json"), b"{}")
            .map_err(|error| SupervisorError::spawn(error.to_string()))?;
        let child = hidden_command(&config.worker_path)
            .env("WOOHAA3_RECORDING_SOCKET", &config.socket_path)
            .env("WOOHAA3_RECORDING_NONCE_FILE", &config.nonce_path)
            .env("WOOHAA3_RECORDING_LEASE_MS", config.lease_ms.to_string())
            .env("WOOHAA3_RECORDING_WORK_DIR", &directory)
            .env("WOOHAA3_RECORDING_EXECUTOR_ID", &config.executor_instance_id)
            .env("WOOHAA3_RECORDING_CHECKOUT", &config.checkout_id)
            .env("WOOHAA3_RECORDING_NONCE", nonce)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| SupervisorError::spawn(format!("无法启动 shot-recorder：{error}")))?;

        self.active.insert(
            attempt_id.to_owned(),
            WorkerProcess {
                attempt_id: attempt_id.to_owned(),
                directory,
                child,
                started: Instant::now(),
            },
        );
        Ok(())
    }

    /// 停止指定 attempt 的 worker，并删除其私有目录。
    pub fn stop(&mut self, attempt_id: &str, grace: Duration) -> Result<(), SupervisorError> {
        let Some(mut worker) = self.active.remove(attempt_id) else {
            return Ok(());
        };
        worker.terminate(grace)?;
        remove_directory(&worker.directory);
        Ok(())
    }

    /// 停止全部 worker（应用退出/宿主失联/lease 过期）。
    pub fn stop_all(&mut self, grace: Duration) -> Result<(), SupervisorError> {
        let attempts: Vec<String> = self.active.keys().cloned().collect();
        let mut first_error = None;
        for attempt in attempts {
            if let Err(error) = self.stop(&attempt, grace) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// 清扫工作根目录下的过期残留（上次异常退出的 attempt 目录）。
    pub fn sweep_work_root(&self, root: &Path, older_than: Duration) -> usize {
        let Ok(entries) = std::fs::read_dir(root) else { return 0 };
        let mut removed = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let stale = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.elapsed().ok())
                .map(|age| age > older_than)
                .unwrap_or(false);
            if stale && remove_directory(&path) {
                removed += 1;
            }
        }
        removed
    }
}

fn remove_directory(path: &Path) -> bool {
    std::fs::remove_dir_all(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(root: &Path) -> SupervisorConfig {
        SupervisorConfig {
            socket_path: root.join("executor.sock"),
            nonce_path: root.join("registration.nonce"),
            worker_path: root.join("shot-recorder"),
            work_root: root.join("work"),
            executor_instance_id: "exec-1".into(),
            checkout_id: "checkout-1".into(),
            lease_ms: 1_000,
            terminate_grace: Duration::from_millis(200),
        }
    }

    #[test]
    fn rejects_incomplete_configuration_instead_of_guessing() {
        let root = std::env::temp_dir().join("wo-sup-config");
        let mut cfg = config(&root);
        cfg.socket_path = PathBuf::from("relative.sock");
        assert_eq!(cfg.validate().unwrap_err().code, "recording-supervisor-config-invalid");

        let mut cfg = config(&root);
        cfg.worker_path = PathBuf::from("shot-recorder");
        assert!(cfg.validate().is_err());

        let mut cfg = config(&root);
        cfg.executor_instance_id = "  ".into();
        assert!(cfg.validate().is_err());

        let mut cfg = config(&root);
        cfg.checkout_id = String::new();
        assert!(cfg.validate().is_err());

        let mut cfg = config(&root);
        cfg.lease_ms = 0;
        assert!(cfg.validate().is_err());

        assert!(config(&root).validate().is_ok());
    }

    #[test]
    fn sanitizes_attempt_directories() {
        let root = std::env::temp_dir().join("wo-sup-dir");
        let cfg = config(&root);
        let safe = cfg.attempt_directory("../../etc/passwd");
        assert!(safe.starts_with(&cfg.work_root));
        assert!(!safe.to_string_lossy().contains(".."));
        assert_eq!(cfg.attempt_directory(""), cfg.work_root.join("attempt"));
        assert_eq!(cfg.attempt_directory("attempt-1"), cfg.work_root.join("attempt-1"));
    }

    #[test]
    fn reports_spawn_failure_with_a_stable_code() {
        let root = std::env::temp_dir().join("wo-sup-missing");
        std::fs::create_dir_all(&root).expect("dir");
        let cfg = config(&root);
        let mut supervisor = RecordingSupervisor::new();
        let error = supervisor.start(&cfg, "attempt-1", "nonce").unwrap_err();
        assert_eq!(error.code, "recording-worker-spawn-failed");
        assert_eq!(supervisor.active_count(), 0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn starts_and_stops_a_real_child_process() {
        let root = std::env::temp_dir().join("wo-sup-child");
        std::fs::create_dir_all(&root).expect("dir");
        // 用系统 `sleep` 充当 worker：只验证进程生命周期，不涉及 GPU。
        let worker = root.join("worker.sh");
        std::fs::write(&worker, "#!/bin/sh\nsleep 30\n").expect("write worker");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let mut cfg = config(&root);
        cfg.worker_path = worker;
        let mut supervisor = RecordingSupervisor::new();
        supervisor.start(&cfg, "attempt-1", "nonce").expect("start");
        assert_eq!(supervisor.active_count(), 1);
        assert!(supervisor.is_running("attempt-1"));
        assert!(cfg.attempt_directory("attempt-1").is_dir());

        // 新 attempt 会先终止旧 worker：一个租约至多一个活动进程。
        supervisor.start(&cfg, "attempt-2", "nonce").expect("restart");
        assert_eq!(supervisor.active_count(), 1);
        assert!(!supervisor.is_running("attempt-1"));
        assert!(!cfg.attempt_directory("attempt-1").exists(), "被取代的 attempt 目录应清理");

        supervisor.stop_all(Duration::from_millis(200)).expect("stop");
        assert_eq!(supervisor.active_count(), 0);
        assert!(!cfg.attempt_directory("attempt-2").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sweeps_only_stale_directories() {
        let root = std::env::temp_dir().join("wo-sup-sweep");
        std::fs::create_dir_all(&root).expect("dir");
        let fresh = root.join("fresh");
        std::fs::create_dir_all(&fresh).expect("fresh");
        let supervisor = RecordingSupervisor::new();
        // 刚创建的目录不应被清扫。
        assert_eq!(supervisor.sweep_work_root(&root, Duration::from_secs(3_600)), 0);
        assert!(fresh.exists());
        // 阈值 0 时视为过期（模拟上次异常退出留下的目录）。
        assert_eq!(supervisor.sweep_work_root(&root, Duration::from_millis(0)), 1);
        assert!(!fresh.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stopping_an_unknown_attempt_is_a_no_op() {
        let mut supervisor = RecordingSupervisor::new();
        assert!(supervisor.stop("nope", Duration::from_millis(10)).is_ok());
        assert!(supervisor.stop_all(Duration::from_millis(10)).is_ok());
    }
}
