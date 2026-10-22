//! Tauri 桌面宿主原型入口（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 1.4）。
//!
//! 目的（P0）：证明 Tauri 独占窗口与 OS 事件循环，且 native 画布生命周期与 `App::run()`/
//! winit runner 分离。**本入口不包含渲染/合成验收**：它只打印会话探测与句柄事实，不伪造 surface
//! 或截图结果。
//!
//! 用法：
//!   cargo run -p woohaa_desktop_host --bin woohaa-desktop            # overlay 原型（需桌面会话）
//!   cargo run -p woohaa_desktop_host --bin woohaa-desktop -- --probe # 只探测环境（无会话也安全）

fn main() {
    // `--probe` 只报告环境事实，不创建窗口/GPU 资源；用于无显示会话的 CI/容器。
    if std::env::args().any(|arg| arg == "--probe") {
        println!("{}", woohaa_desktop_host::view::desktop_support_report());
        return;
    }
    // 预先检查显示会话：没有会话时 GTK 初始化会失败；这里给出明确诊断而不是静默继续。
    let session = woohaa_desktop_host::probe_desktop_session();
    if !session.has_session_env {
        eprintln!(
            "没有可用的桌面显示会话（Linux display / macOS WindowServer / Windows 可见窗口站）。\
             同窗口 overlay 原型需要真实桌面会话与 GPU；本机不执行渲染/合成验收。\
             使用 --probe 只查看环境事实。"
        );
        std::process::exit(2);
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
        eprintln!("桌面宿主启动失败：{error}");
        std::process::exit(1);
    }
}
