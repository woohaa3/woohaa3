//! WASM 可用的时钟入口。
//!
//! `wasm32-unknown-unknown` 没有系统时钟：`std::time::Instant::now()` 在浏览器里直接
//! panic（`time not implemented on this platform`），整个 WASM 实例随即被 poison，
//! 画布上表现为 `RuntimeError: unreachable` 与「渲染器发生故障」。
//!
//! 因此计时一律从本模块取：wasm 下是 `web_time`（`performance.now()`），原生下等价于
//! `std::time::Instant`。`bridge` 这类禁止依赖 `bevy` 的分层也经这里取得同一时钟。
//!
//! `epoch_millis` 提供**挂钟**时间（Unix epoch 毫秒），专供与 Web 侧共享的时间点比较：
//! 节点进度环要按「该 run 在 Web 侧何时开始」估算经过时间，那个起点是 epoch 毫秒
//! （change: 2026-10-31-unify-node-and-activity-progress）。

pub(crate) use bevy::platform::time::Instant;

/// 当前挂钟时间（Unix epoch 毫秒）；无法取得时返回 0，调用方按「起点未知」处理。
///
/// **只有浏览器 WASM 需要它**：那里的进度环可能因聚焦切换或运行器重建而重启，必须以 Web
/// 侧的运行起点重新估算，不能让进度跳回 1%。wasm 下 `std` 的系统时钟不可用，因此走
/// `js_sys::Date::now()`（`Date` 一定存在，且不受单调时钟限制）。
///
/// 原生画布（Tauri）与离屏渲染器没有这条重建路径，进度由本实例的单调时钟推进即可，因此
/// 直接返回 0 —— 也让本模块保持「不出现 `std::time::SystemTime`」的架构约束
/// （`tests/architecture.rs` 的 `wasm_paths_never_use_std_clock`）。
#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
pub(crate) fn epoch_millis() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(all(target_arch = "wasm32", feature = "wasm")))]
pub(crate) fn epoch_millis() -> f64 {
    0.0
}
