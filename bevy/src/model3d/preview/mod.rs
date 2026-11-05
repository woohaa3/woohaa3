//! 原生无窗口预览渲染（change: enhance-model-scene-authoring-api，任务 6.2 / 6.4；
//! change: refactor-bevy-rust-file-size 拆分为 facade + 子模块）。
//!
//! 只用 `native-renderer` feature 编译。把**规范化 Scene IR**（绝不执行 JavaScript）渲染到
//! 离屏 `Image` 并回读为 PNG：使用 `ScheduleRunnerPlugin` 替代 winit runner、不创建窗口、
//! 不依赖用户浏览器。
//!
//! 相机使用受控 dimetric preset + 固定灯光 + 按 extent 自动取景；脚本不能修改这些资源。
//! 与 WASM adapter 共用 `model3d::scene` 的 primitive/material/transform 构建逻辑。
//!
//! 子模块边界（design D2）：
//! - [`render`]：离屏渲染、读回与 PNG 编码；
//! - [`stdio`]：framed 请求/响应服务与单请求处理。

mod animation_sample;
mod framing;
pub(crate) mod readiness;
pub(crate) mod render;
mod stdio;

pub use render::{render_preview, render_rgba};
pub use stdio::{render_request_json, run_stdio};

#[cfg(test)]
mod tests;
