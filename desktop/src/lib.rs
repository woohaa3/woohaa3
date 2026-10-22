//! Woohaa3 桌面宿主原型（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy）。
//!
//! 本 crate 是**原型，不是完整迁移**。阶段 P0 只交付：
//! - 精确锁定的 Tauri/Bevy/wgpu 依赖与兼容检查（见 `notes/dependency-lock.md`）；
//! - Tauri 独占窗口/OS loop 的最小宿主；
//! - 与现有 `App::run()`/winit runner 分离的 native 画布生命周期（build/init/update/dispose）；
//! - 符合线程约束的有界 update/tick 调度与非渲染生命周期测试。
//!
//! 阶段 P1 的**完整门槛尚未放行**：跨 DPI/IME、输入与截帧矩阵还没排期。Windows 已在真实
//! GPU（RTX 4060 / Vulkan）与交互会话下采集到同窗口合成像素证据，并接通录制执行器注册，
//! 但这不是 P1 全量验收（见 `openspec/changes/2026-10-19-add-windows-desktop-host/verification.md`）。
//! 其余尚未采集的渲染/合成/截帧项按仓库约定标记「待人工验证」。P2 及后续完整迁移必须等待
//! P1 放行，本 crate 不得视为完整画布迁移已完成。

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
mod devtools;
pub mod host;
pub mod lifecycle;
#[cfg(target_os = "macos")]
mod macos_frame_clock;
#[cfg(target_os = "macos")]
mod macos_view;
mod metrics;
pub mod native_canvas;
pub mod notifications;
pub mod packaging;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
mod transport;
pub mod view;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
mod web_popups;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
mod window_controls;

pub use host::{HostConfig, NativeCanvasSession, run_host, run_native_only_host};
pub use view::{CompositionMode, ViewBounds, probe_desktop_session};

/// 原型能力标识；用于启动日志与 P1 证据记录，避免把编译通过当成验收通过。
pub const PROTOTYPE_VERSION: &str = "woohaa-desktop-prototype-p0";

/// 平台是否具备可运行的桌面宿主目标。
///
/// Linux、macOS 与 Windows 具备编译与启动路径；同窗口合成、输入/IME 与截帧仍需按平台
/// 真机验收（见 openspec 的 desktop-native-host 门槛），编译通过不等于验收通过。
pub const fn supports_desktop_host() -> bool {
    cfg!(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "windows"
    ))
}

pub mod desktop_updates;
pub mod local_host;
