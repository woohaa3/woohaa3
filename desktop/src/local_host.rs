//! Owned Node process and the versioned desktop host control channel.
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Deserialize, Debug)]
pub struct Ready {
    pub protocol: u32,
    pub instance: String,
    pub origin: String,
    pub pid: u32,
}
pub fn validate_ready(line: &str, instance: &str, pid: u32) -> Result<Ready, String> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if value["type"] != "ready" {
        return Err("expected ready message".into());
    }
    let ready: Ready = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let url = tauri::Url::parse(&ready.origin).map_err(|e| e.to_string())?;
    if ready.protocol != 1
        || ready.instance != instance
        || ready.pid != pid
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("host ready identity or loopback origin rejected".into());
    }
    Ok(ready)
}
#[derive(Clone)]
pub struct Launch {
    pub node: PathBuf,
    pub root: PathBuf,
    pub data: PathBuf,
}
pub struct LocalHost {
    child: Child,
    recording: Option<woohaa_recording_supervisor::connection::ConnectionGuard>,
}
fn recording_config(
    launch: &Launch,
) -> Result<woohaa_recording_supervisor::SupervisorConfig, String> {
    let checkout = std::fs::canonicalize(&launch.data).map_err(|e| e.to_string())?;
    let worker = launch
        .root
        .join("tools")
        .join(format!("shot-recorder{}", std::env::consts::EXE_SUFFIX));
    Ok(woohaa_recording_supervisor::connection::development_config(
        &checkout, worker,
    ))
}

// Native executable lookup avoids Git/MSYS tar and PATH shadowing on Windows.
fn system_tar_path(windows: bool, system_root: Option<std::ffi::OsString>) -> PathBuf {
    if windows {
        let root = system_root.unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows"));
        let mut value = root.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        value.push_str(r"\System32\tar.exe");
        PathBuf::from(value)
    } else {
        PathBuf::from("/usr/bin/tar")
    }
}
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

impl LocalHost {
    pub fn start(launch: &Launch) -> Result<(Self, Ready), String> {
        std::fs::create_dir_all(launch.data.join("logs")).map_err(|e| e.to_string())?;
        let logs = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(launch.data.join("logs/host.log"))
            .map_err(|e| e.to_string())?;
        let instance = uuid::Uuid::new_v4().to_string();
        let mut command = hidden_command(&launch.node);
        command.arg(launch.root.join("desktop-host.mjs"));
        if cfg!(debug_assertions) {
            if let Ok(port) = std::env::var("WOOHAA_DESKTOP_HOST_PORT") {
                command.arg("--port").arg(port);
            }
            if let Ok(ui) = std::env::var("WOOHAA_DESKTOP_UI_URL") {
                command.arg("--dev-origin").arg(ui);
            }
        }
        let mut child = command
            .arg("--resource-root")
            .arg(&launch.root)
            .arg("--data-dir")
            .arg(&launch.data)
            .arg("--instance")
            .arg(&instance)
            .current_dir(&launch.data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(logs)
            .spawn()
            .map_err(|e| format!("启动本机宿主失败: {e}"))?;
        let stdout = child.stdout.take().ok_or("host stdout missing")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        let _ = tx.send(line);
                    }
                    Err(_) => break,
                }
            }
        });
        let mut host = Self {
            child,
            recording: None,
        };
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if let Some(status) = host.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("宿主启动时退出: {status}；请查看 logs/host.log"));
            }
            if Instant::now() >= deadline {
                return Err("宿主启动超时；请查看 logs/host.log".into());
            }
            if let Ok(line) = rx.recv_timeout(Duration::from_millis(100)) {
                if line.len() > 64 * 1024 {
                    return Err("host control message too large".into());
                }
                let value: serde_json::Value =
                    serde_json::from_str(&line).map_err(|e| format!("host protocol: {e}"))?;
                match value["type"].as_str() {
                    Some("ready") => {
                        let ready = validate_ready(&line, &instance, host.child.id())?;
                        // The backend recorder socket exists before ready. Match its
                        // canonical cwd (/tmp resolves to /private/tmp on macOS).
                        let config = recording_config(launch)?;
                        host.recording =
                            match woohaa_recording_supervisor::connection::start(config) {
                                Ok(guard) => Some(guard),
                                Err(error) => {
                                    eprintln!("原生录制不可用：{}", error.message);
                                    None
                                }
                            };
                        return Ok((host, ready));
                    }
                    Some("error") => return Err(format!("宿主启动失败: {}", value["message"])),
                    _ => {}
                }
            }
        }
    }
    pub fn exited(&mut self) -> Result<bool, String> {
        let exited = self
            .child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|e| e.to_string())?;
        if exited {
            self.recording.take();
        }
        Ok(exited)
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if self.exited()? {
            return Ok(());
        }
        if let Some(stdin) = self.child.stdin.as_mut() {
            stdin
                .write_all(b"{\"type\":\"shutdown\"}\n")
                .map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if self.exited()? {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("宿主未能在 60 秒内完成停止；已取消安装或退出".into())
    }
}
impl Drop for LocalHost {
    fn drop(&mut self) {
        self.child.stdin.take();
        if !self.exited().unwrap_or(true) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.recording.take();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn line(origin: &str) -> String {
        serde_json::json!({"type":"ready","protocol":1,"instance":"a","pid":12,"origin":origin})
            .to_string()
    }
    #[test]
    fn accepts_bound_loopback_identity() {
        assert!(validate_ready(&line("http://127.0.0.1:53421"), "a", 12).is_ok());
    }
    #[test]
    fn rejects_foreign_origin_and_identity() {
        for origin in [
            "https://127.0.0.1:12",
            "http://localhost:12",
            "http://127.0.0.1",
            "http://127.0.0.1:12/path",
            "http://user@127.0.0.1:12",
        ] {
            assert!(validate_ready(&line(origin), "a", 12).is_err(), "{origin}");
        }
        assert!(validate_ready(&line("http://127.0.0.1:12"), "b", 12).is_err());
        assert!(validate_ready(&line("http://127.0.0.1:12"), "a", 13).is_err());
    }
}

use std::sync::{
    Arc, Mutex, RwLock,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;
struct Managed {
    launch: Launch,
    retry: mpsc::Sender<()>,
    host: Mutex<Option<LocalHost>>,
    closing: AtomicBool,
    exit_ready: AtomicBool,
    busy: AtomicBool,
    required_update: AtomicBool,
}
fn status(app: &tauri::AppHandle, message: &str, failed: bool) {
    if let Some(window) = app.get_webview_window("startup") {
        let script = format!(
            "(function(){{function apply(){{document.getElementById('message').textContent={};document.getElementById('retry').hidden={};}}if(document.getElementById('message'))apply();else addEventListener('DOMContentLoaded',apply,{{once:true}});}})();",
            serde_json::to_string(message).unwrap(),
            !failed
        );
        let _ = window.eval(&script);
        let _ = window.show();
    }
}
pub fn install(
    app: &tauri::AppHandle,
    origin: Arc<RwLock<String>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    // Resolve only; archive verification and extraction run after the startup page is visible.
    let root = resolve_resource_root_path(app)
        .unwrap_or_else(|_| resources.join("desktop-host-unavailable"));
    let node = std::env::var_os("WOOHAA_DESKTOP_NODE")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "woohaa-node.exe"
        } else {
            "woohaa-node"
        }));
    let mut data = app.path().app_data_dir()?;
    if cfg!(debug_assertions) {
        data.set_file_name("com.woohaa.desktop.dev");
    }
    if let Some(custom) = std::env::var_os("WOOHAA_DESKTOP_DATA_DIR") {
        data = PathBuf::from(custom);
    }
    let launch = Launch { node, root, data };
    let (tx, rx) = mpsc::channel();
    let state = Arc::new(Managed {
        launch: launch.clone(),
        retry: tx.clone(),
        host: Mutex::new(None),
        closing: AtomicBool::new(false),
        exit_ready: AtomicBool::new(false),
        busy: AtomicBool::new(false),
        required_update: AtomicBool::new(false),
    });
    app.manage(state.clone());
    if let Some(menu) = app.menu() {
        let export = tauri::menu::MenuItem::with_id(
            app,
            "workspace-export",
            "导出工作区…",
            true,
            None::<&str>,
        )?;
        let import = tauri::menu::MenuItem::with_id(
            app,
            "workspace-import",
            "导入工作区…",
            true,
            None::<&str>,
        )?;
        let restore = tauri::menu::MenuItem::with_id(
            app,
            "workspace-restore",
            "从备份恢复…",
            true,
            None::<&str>,
        )?;
        let submenu =
            tauri::menu::Submenu::with_items(app, "工作区", true, &[&export, &import, &restore])?;
        menu.append(&submenu)?;
    }
    let retry = tx.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "startup",
        tauri::WebviewUrl::App("desktop-startup.html".into()),
    )
    .title("WooHaa3 启动")
    .inner_size(560., 260.)
    .on_navigation(move |url| {
        if url.host_str() == Some("woohaa-startup.invalid") {
            let _ = retry.send(());
            false
        } else {
            true
        }
    })
    .build()?;
    let _ = window.show();
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut first = true;
        loop {
            if !first && rx.recv().is_err() {
                break;
            }
            first = false;
            if state.closing.load(Ordering::Acquire) {
                break;
            }
            if state.busy.swap(true, Ordering::AcqRel) {
                continue;
            }
            let result = (|| {
                if crate::desktop_updates::startup(
                    &handle,
                    &resources,
                    &state.required_update,
                    |message| status(&handle, message, false),
                )? {
                    state.busy.store(false, Ordering::Release);
                    state.closing.store(true, Ordering::Release);
                    state.exit_ready.store(true, Ordering::Release);
                    handle.restart();
                }
                if state.closing.load(Ordering::Acquire) {
                    return Err("应用正在退出".into());
                }
                status(
                    &handle,
                    "正在校验和准备本机宿主资源，首次启动可能需要稍候…",
                    false,
                );
                let mut launch = launch.clone();
                launch.root = prepare_resource_root(&handle).map_err(|error| error.to_string())?;
                status(&handle, "正在启动本机宿主…", false);
                let (host, ready) = LocalHost::start(&launch)?;
                let ui_url = development_ui_url(&ready.origin)?;
                *origin.write().unwrap() = tauri::Url::parse(&ui_url)
                    .map_err(|e| e.to_string())?
                    .origin()
                    .ascii_serialization();
                *state.host.lock().unwrap() = Some(host);
                if let Some(main) = handle.get_webview_window("main") {
                    main.navigate(tauri::Url::parse(&ui_url).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    if main.show().is_ok() {
                        eprintln!("desktop main shown: {}", ui_url);
                    }
                    let _ = main.set_focus();
                }
                if let Some(startup) = handle.get_webview_window("startup") {
                    let _ = startup.hide();
                }
                Ok::<(), String>(())
            })();
            state.busy.store(false, Ordering::Release);
            if let Err(error) = result {
                eprintln!("desktop startup: {error}");
                status(
                    &handle,
                    &format!("{error}。可通过“工作区”菜单导入或从备份恢复。"),
                    true,
                );
                continue;
            }
            loop {
                if state.closing.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if state.busy.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                let exited = state
                    .host
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map(|host| host.exited().unwrap_or(true))
                    .unwrap_or(true);
                if exited {
                    if let Some(main) = handle.get_webview_window("main") {
                        let _ = main.hide();
                    }
                    status(
                        &handle,
                        "本机宿主已退出。请重试，或通过“工作区”菜单导入/从备份恢复；日志位于用户数据目录 logs/host.log。",
                        true,
                    );
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    });
    Ok(())
}
pub fn handle_exit(app: &tauri::AppHandle, event: &tauri::RunEvent) -> bool {
    let Some(state) = app.try_state::<Arc<Managed>>() else {
        return false;
    };
    let should_close = match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if state.exit_ready.load(Ordering::Acquire) {
                return false;
            }
            api.prevent_exit();
            true
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            true
        }
        _ => false,
    };
    if !should_close {
        return false;
    }
    if state.closing.swap(true, Ordering::AcqRel) {
        return true;
    }
    let state = state.inner().clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let running = state
            .host
            .lock()
            .unwrap()
            .as_mut()
            .map(|host| !host.exited().unwrap_or(true))
            .unwrap_or(false);
        if running
            && !handle
                .dialog()
                .message("退出应用将停止正在进行的本机任务。是否继续？")
                .title("退出 WooHaa3")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "停止任务并退出".into(),
                    "继续使用".into(),
                ))
                .blocking_show()
        {
            state.closing.store(false, Ordering::Release);
            return;
        }
        // A startup in progress owns the child until its ready handshake finishes.
        while state.busy.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let result = state
            .host
            .lock()
            .unwrap()
            .as_mut()
            .map(|host| host.stop())
            .unwrap_or(Ok(()));
        match result {
            Ok(()) => {
                state.exit_ready.store(true, Ordering::Release);
                handle.exit(0);
            }
            Err(error) => {
                state.closing.store(false, Ordering::Release);
                status(
                    &handle,
                    &format!("{error}。可通过“工作区”菜单导入或从备份恢复。"),
                    true,
                );
            }
        }
    });
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveAction {
    Export,
    Import,
    Restore,
}
impl ArchiveAction {
    fn from_menu(id: &str) -> Option<Self> {
        match id {
            "workspace-export" => Some(Self::Export),
            "workspace-import" => Some(Self::Import),
            "workspace-restore" => Some(Self::Restore),
            _ => None,
        }
    }
    fn flag(self) -> &'static str {
        match self {
            Self::Export => "--export",
            Self::Import => "--import",
            Self::Restore => "--restore-backup",
        }
    }
}
fn archive_allowed(busy: bool, closing: bool, required_update: bool) -> bool {
    !busy && !closing && !required_update
}
pub fn handle_menu(app: &tauri::AppHandle, event: &tauri::menu::MenuEvent) {
    let Some(action) = ArchiveAction::from_menu(event.id().as_ref()) else {
        return;
    };
    let Some(state) = app.try_state::<Arc<Managed>>() else {
        return;
    };
    let state = state.inner().clone();
    if !archive_allowed(
        state.busy.load(Ordering::Acquire),
        state.closing.load(Ordering::Acquire),
        state.required_update.load(Ordering::Acquire),
    ) {
        status(app, "请先完成当前启动、更新或退出操作。", true);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri_plugin_dialog::DialogExt;
        let dialog = app.dialog().file();
        let path = match action {
            ArchiveAction::Export => dialog
                .add_filter("WooHaa 工作区", &["woohaa"])
                .set_file_name("workspace.woohaa")
                .blocking_save_file(),
            ArchiveAction::Import => dialog
                .add_filter("WooHaa 工作区", &["woohaa"])
                .blocking_pick_file(),
            ArchiveAction::Restore => dialog.blocking_pick_folder(),
        };
        let Some(path) = path.and_then(|p| p.into_path().ok()) else {
            return;
        };
        if state.closing.load(Ordering::Acquire)
            || state.required_update.load(Ordering::Acquire)
            || state
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return;
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        status(
            &app,
            match action {
                ArchiveAction::Export => "正在停止宿主并导出工作区（包含配置和密钥）…",
                ArchiveAction::Import => "正在备份并导入工作区…",
                ArchiveAction::Restore => "正在从所选备份恢复工作区…",
            },
            false,
        );
        let result = (|| {
            if let Some(host) = state.host.lock().unwrap().as_mut() {
                host.stop()?;
            }
            // The startup worker exclusively owns restarts. It waits while busy is set.
            state.host.lock().unwrap().take();
            let output = hidden_command(&state.launch.node)
                .arg(state.launch.root.join("desktop-host.mjs"))
                .arg("--resource-root")
                .arg(&state.launch.root)
                .arg("--data-dir")
                .arg(&state.launch.data)
                .arg(action.flag())
                .arg(path)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(
                    "工作区操作失败，请检查文件格式和磁盘空间；原数据备份保留在用户目录。".into(),
                );
            }
            Ok::<(), String>(())
        })();
        let old_running = state
            .host
            .lock()
            .unwrap()
            .as_mut()
            .map(|host| !host.exited().unwrap_or(false))
            .unwrap_or(false);
        if let Err(error) = result {
            app.dialog().message(error).blocking_show();
        }
        state.busy.store(false, Ordering::Release);
        if old_running {
            status(&app, "宿主尚未完成停止，已取消工作区操作。", true);
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
            }
            return;
        }
        // Works for both the failure page waiting for retry and the live monitor,
        // which observes the absent host and returns to this same retry channel.
        let _ = state.retry.send(());
    });
}

#[cfg(all(test, unix))]
mod process_tests {
    use super::*;
    #[test]
    fn shutdown_waits_for_child_to_really_exit() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("read line; case \"$line\" in *shutdown*) exit 0;; *) exit 9;; esac")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut host = LocalHost {
            child,
            recording: None,
        };
        host.stop().unwrap();
        assert!(host.exited().unwrap());
        assert!(host.child.try_wait().unwrap().unwrap().success());
    }
    #[test]
    fn exited_child_can_be_stopped_again() {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 3")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let mut host = LocalHost {
            child,
            recording: None,
        };
        host.child.wait().unwrap();
        assert!(host.stop().is_ok());
    }
}

fn development_ui_url(host_origin: &str) -> Result<String, String> {
    if cfg!(debug_assertions) {
        if let Ok(ui) = std::env::var("WOOHAA_DESKTOP_UI_URL") {
            let url = tauri::Url::parse(&ui).map_err(|e| e.to_string())?;
            if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            {
                return Err("开发前端必须使用本机 HTTP 地址".into());
            }
            return Ok(ui);
        }
    }
    Ok(host_origin.to_owned())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn recovery_allowed_without_a_running_host() {
        assert!(archive_allowed(false, false, false));
        assert!(!archive_allowed(true, false, false));
        assert!(!archive_allowed(false, true, false));
        assert!(!archive_allowed(false, false, true));
    }
    #[test]
    fn restore_menu_uses_explicit_backup_cli() {
        assert_eq!(
            ArchiveAction::from_menu("workspace-restore"),
            Some(ArchiveAction::Restore)
        );
        assert_eq!(ArchiveAction::Restore.flag(), "--restore-backup");
        assert_eq!(ArchiveAction::Import.flag(), "--import");
    }
}

static RESOURCE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
pub fn prepared_resource_root() -> Option<&'static std::path::Path> {
    RESOURCE_ROOT.get().map(PathBuf::as_path)
}
/// Tauri does not copy pnpm symlinks as resources. Ship a hash-pinned archive and
/// extract once into the application cache, preserving its internal relative links.
pub fn resolve_resource_root_path(
    app: &tauri::AppHandle,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = std::env::var_os("WOOHAA_DESKTOP_HOST_ROOT") {
        return Ok(PathBuf::from(root));
    }
    let config = crate::desktop_updates::read_config(&app.path().resource_dir()?)
        .map_err(std::io::Error::other)?;
    let digest = config
        .host_archive_sha256
        .ok_or_else(|| std::io::Error::other("发行资源缺少 hostArchiveSha256"))?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(std::io::Error::other("非法宿主资源摘要").into());
    }
    Ok(app.path().app_cache_dir()?.join("runtime").join(digest))
}
pub fn prepare_resource_root(
    app: &tauri::AppHandle,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = RESOURCE_ROOT.get() {
        return Ok(root.clone());
    }
    let root = resolve_resource_root_path(app)?;
    if std::env::var_os("WOOHAA_DESKTOP_HOST_ROOT").is_none() {
        let digest = root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| std::io::Error::other("非法宿主资源摘要"))?;
        extract_resource_archive(
            &app.path().resource_dir()?.join("desktop-host.tar.gz"),
            root.parent()
                .ok_or_else(|| std::io::Error::other("宿主缓存目录不可用"))?,
            digest,
        )
        .map_err(std::io::Error::other)?;
    }
    if !root.join("desktop-host.mjs").is_file() {
        return Err(std::io::Error::other("宿主资源缺少 desktop-host.mjs").into());
    }
    let _ = RESOURCE_ROOT.set(root.clone());
    Ok(root)
}
fn extract_resource_archive(
    archive: &std::path::Path,
    cache: &std::path::Path,
    digest: &str,
) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(archive).map_err(|e| format!("无法打开宿主资源包: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != digest {
        return Err("宿主资源包 SHA256 校验失败".into());
    }
    let root = cache.join(digest);
    if std::fs::read_to_string(root.join(".complete"))
        .ok()
        .as_deref()
        == Some(digest)
        && root.join("desktop-host.mjs").is_file()
    {
        return Ok(root);
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let staging = cache.join(format!(".extract-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let status = hidden_command(system_tar_path(cfg!(windows), std::env::var_os("SystemRoot")))
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(&staging)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() || !staging.join("desktop-host.mjs").is_file() {
            return Err("宿主资源解包失败或缺少入口".into());
        }
        validate_extracted_links(&staging, &staging)?;
        std::fs::write(staging.join(".complete"), digest).map_err(|e| e.to_string())?;
        if root.exists() {
            std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staging, &root).map_err(|e| e.to_string())?;
        Ok(root)
    })();
    if staging.exists() {
        let _ = std::fs::remove_dir_all(staging);
    }
    result
}
#[cfg(all(test, unix))]
mod archive_cache_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn archive_extracts_internal_symlinks_and_rejects_wrong_hash() {
        let temp = std::env::temp_dir().join(format!("woohaa-host-cache-{}", uuid::Uuid::new_v4()));
        let source = temp.join("source");
        std::fs::create_dir_all(source.join("backend-runtime")).unwrap();
        std::fs::write(source.join("desktop-host.mjs"), "entry").unwrap();
        std::fs::write(source.join("backend-runtime/entry.mjs"), "backend").unwrap();
        std::os::unix::fs::symlink("backend-runtime", source.join("backend")).unwrap();
        let archive = temp.join("desktop-host.tar.gz");
        assert!(
            Command::new("/usr/bin/tar")
                .arg("-czf")
                .arg(&archive)
                .arg("-C")
                .arg(&source)
                .arg(".")
                .status()
                .unwrap()
                .success()
        );
        let digest = format!("{:x}", Sha256::digest(std::fs::read(&archive).unwrap()));
        assert!(extract_resource_archive(&archive, &temp.join("cache"), &"0".repeat(64)).is_err());
        let root = extract_resource_archive(&archive, &temp.join("cache"), &digest).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("backend/entry.mjs")).unwrap(),
            "backend"
        );
        assert!(
            std::fs::symlink_metadata(root.join("backend"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            extract_resource_archive(&archive, &temp.join("cache"), &digest).unwrap(),
            root
        );
        std::fs::write(temp.join("outside"), "outside").unwrap();
        std::os::unix::fs::symlink(temp.join("outside"), root.join("external")).unwrap();
        assert!(validate_extracted_links(&root, &root).is_err());
        std::fs::remove_dir_all(temp).unwrap();
    }
}

fn validate_extracted_links(
    root: &std::path::Path,
    directory: &std::path::Path,
) -> Result<(), String> {
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            let target = std::fs::read_link(entry.path()).map_err(|e| e.to_string())?;
            if target.is_absolute()
                || !entry
                    .path()
                    .canonicalize()
                    .map_err(|e| format!("宿主依赖链接无效: {e}"))?
                    .starts_with(&canonical_root)
            {
                return Err("宿主资源包含指向包外的依赖链接".into());
            }
        } else if kind.is_dir() {
            validate_extracted_links(root, &entry.path())?;
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod recorder_path_tests {
    use super::*;
    #[test]
    fn owned_recorder_identity_matches_canonical_backend_cwd() {
        let temp =
            std::env::temp_dir().join(format!("woohaa-recorder-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("actual-data")).unwrap();
        std::os::unix::fs::symlink("actual-data", temp.join("data-alias")).unwrap();
        let launch = Launch {
            node: temp.join("node"),
            root: temp.join("resources"),
            data: temp.join("data-alias"),
        };
        let config = recording_config(&launch).unwrap();
        let expected = woohaa_recording_supervisor::connection::development_config(
            &launch.data.canonicalize().unwrap(),
            launch.root.join("tools/shot-recorder"),
        );
        assert_eq!(config.checkout_id, expected.checkout_id);
        assert_eq!(config.socket_path, expected.socket_path);
        assert_eq!(config.worker_path, launch.root.join("tools/shot-recorder"));
        std::fs::remove_dir_all(temp).unwrap();
    }
}

#[cfg(test)]
mod platform_command_tests {
    use super::*;
    #[test]
    fn archive_command_uses_native_platform_tar() {
        let windows = system_tar_path(true, Some(std::ffi::OsString::from(r"D:\Windows")));
        assert_eq!(windows.to_string_lossy(), r"D:\Windows\System32\tar.exe");
        assert_eq!(system_tar_path(false, None), PathBuf::from("/usr/bin/tar"));
    }
}
