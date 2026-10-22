//! 关闭 WebView 的独立 native 画布入口（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，
//! design D8，任务 2.6 / 6.3 的原型前置）。
//!
//! P0 只提供**不依赖 WebView/Web rAF** 的启动骨架：Tauri 仍拥有窗口与 OS 事件循环，native
//! 画布由同一宿主驱动；本机无显示会话时不创建窗口，只打印探测结果。
//!
//! 用法：
//!   cargo run -p woohaa_desktop_host --features native-only-entry --bin woohaa-desktop-native -- --probe
//!
//! 本入口受 `required-features = ["native-only-entry"]` 守门：发行打包不带该 feature，
//! `.app` 里只有应用入口。`pnpm desktop:native` 会显式开启。

fn main() {
    if std::env::args().any(|arg| arg == "--probe") {
        println!("{}", woohaa_desktop_host::view::desktop_support_report());
        return;
    }
    let session = woohaa_desktop_host::probe_desktop_session();
    if !session.has_session_env {
        eprintln!(
            "没有可用的桌面显示会话（Linux display / macOS WindowServer）。\
             native-only 截帧入口需要真实桌面会话与 GPU；本机不执行渲染/截帧验收。\
             使用 --probe 只查看环境事实。"
        );
        std::process::exit(2);
    }
    if let Err(error) = woohaa_desktop_host::run_native_only_host() {
        eprintln!("native-only 宿主启动失败：{error}");
        std::process::exit(1);
    }
}
