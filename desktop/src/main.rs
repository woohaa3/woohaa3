#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Tauri 桌面宿主原型入口（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 1.4）。
//!
//! 目的（P0）：证明 Tauri 独占窗口与 OS 事件循环，且 native 画布生命周期与 `App::run()`/
//! winit runner 分离。**本入口不包含渲染/合成验收**：它只打印会话探测与句柄事实，不伪造 surface
//! 或截图结果。
//!
//! 用法：
//!   cargo run -p woohaa_desktop_host --bin woohaa-desktop            # overlay 原型（需桌面会话）
//!   cargo run -p woohaa_desktop_host --bin woohaa-desktop -- --probe # 只探测环境（无会话也安全）
//!
//! 发行构建声明 `windows_subsystem = "windows"`：双击不再附加控制台窗口。代价是失败信息不再
//! 可见，因此所有致命路径都走 `fatal`：写 `logs/startup.log` 并在 Windows 上弹出原生错误框。

/// 致命错误出口：记录诊断、提示用户，然后以给定退出码结束进程。
fn fatal(message: &str, code: i32) -> ! {
    report_fatal(message);
    woohaa_desktop_host::diagnostics::finish(false);
    std::process::exit(code);
}

fn report_fatal(message: &str) {
    woohaa_desktop_host::diagnostics::stderr(format_args!("{message}"));
    write_startup_log(message);
    #[cfg(target_os = "windows")]
    show_windows_error(message);
}

/// 与应用数据目录一致的日志位置；目录不可写时返回 None（诊断退化为 stderr）。
fn startup_log_path() -> Option<std::path::PathBuf> {
    if let Some(run) = woohaa_desktop_host::diagnostics::run_dir() {
        return Some(run.join("startup.log"));
    }
    let base = woohaa_desktop_host::diagnostics::data_directory()?;
    let logs = base.join("logs");
    std::fs::create_dir_all(&logs).ok()?;
    Some(logs.join("startup.log"))
}

fn write_startup_log(message: &str) {
    use std::io::Write;
    let Some(path) = startup_log_path() else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

#[cfg(target_os = "windows")]
fn show_windows_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    let text = wide(message);
    let title = wide("四喜 AI");
    // SAFETY: 两个指针都指向调用期内保持存活的以 NUL 结尾的 UTF-16 缓冲。
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

/// 未捕获的 panic 同样要留下可读诊断：发行构建没有控制台，默认回溯等于消失。
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let log = startup_log_path()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "（数据目录不可写）".to_owned());
        let message = format!("四喜 AI 启动失败（未捕获的错误）：{info}\n日志：{log}");
        report_fatal(&message);
        default_hook(info);
    }));
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--diagnostic-watchdog") {
        if let (Some(dir), Some(pid)) = (args.get(2), args.get(3).and_then(|s| s.parse().ok())) {
            woohaa_desktop_host::diagnostic_watchdog::run(std::path::Path::new(dir), pid);
        }
        return;
    }
    install_panic_hook();
    // `--probe` 只报告环境事实，不创建窗口/GPU 资源；用于无显示会话的 CI/容器。
    if std::env::args().any(|arg| arg == "--probe") {
        println!("{}", woohaa_desktop_host::view::desktop_support_report());
        return;
    }
    woohaa_desktop_host::diagnostics::initialize();
    // 预先检查显示会话：没有会话时 GTK 初始化会失败；这里给出明确诊断而不是静默继续。
    let session = woohaa_desktop_host::probe_desktop_session();
    if !session.has_session_env {
        fatal(
            "没有可用的桌面显示会话（Linux display / macOS WindowServer / Windows 可见窗口站）。\
             同窗口 overlay 原型需要真实桌面会话与 GPU；本机不执行渲染/合成验收。\
             使用 --probe 只查看环境事实。",
            2,
        );
    }
    let external_host = std::env::args().any(|arg| arg == "--ui-url")
        || std::env::var_os("WOOHAA_DESKTOP_URL").is_some();
    let _recording = if external_host {
        let checkout = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let worker = std::env::var_os("WOOHAA_RECORDING_WORKER")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let name = format!("shot-recorder{}", std::env::consts::EXE_SUFFIX);
                let sibling = std::env::current_exe().unwrap().with_file_name(&name);
                if sibling.exists() {
                    sibling
                } else {
                    checkout.join(format!("bevy/target/debug/{name}"))
                }
            });
        match woohaa_recording_supervisor::connection::start(
            woohaa_recording_supervisor::connection::development_config(checkout, worker),
        ) {
            Ok(guard) => Some(guard),
            Err(error) => {
                eprintln!("原生录制不可用：{}", error.message);
                None
            }
        }
    } else {
        None
    };
    if let Err(error) = woohaa_desktop_host::run_host() {
        fatal(&format!("桌面宿主启动失败：{error}"), 1);
    }
}
