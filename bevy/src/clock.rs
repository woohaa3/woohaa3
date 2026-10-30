//! WASM 可用的单调时钟入口。
//!
//! `wasm32-unknown-unknown` 没有系统时钟：`std::time::Instant::now()` 在浏览器里直接
//! panic（`time not implemented on this platform`），整个 WASM 实例随即被 poison，
//! 画布上表现为 `RuntimeError: unreachable` 与「渲染器发生故障」。
//!
//! 因此计时一律从本模块取：wasm 下是 `web_time`（`performance.now()`），原生下等价于
//! `std::time::Instant`。`bridge` 这类禁止依赖 `bevy` 的分层也经这里取得同一时钟。

pub(crate) use bevy::platform::time::Instant;
