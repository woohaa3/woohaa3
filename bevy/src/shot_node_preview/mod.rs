//! 拍摄镜头卡片 GPU 预览：串行采样、就绪代数、缓存与预算
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 本模块把每个可见的 `film-set-shot-preview` 节点映射成一块**直接采样 GPU Image** 的
//! 2D Sprite：它复用的是 Shot Camera 的 `Offscreen` + `ShotPreviewOutput`，把同一张
//! render-target Image 挂到 Sprite 上，因此 Web/WASM 与 Desktop/native 语义一致，且
//! **不**走 `requestCapture`、RGBA→JS、PNG/Blob 或逐帧像素桥。
//!
//! 共享片场只有一个采样状态：不同镜头必须串行——先设置该镜头的 T/对象/媒体，再派生相机、
//! 等资源就绪、渲染到 Image 后发布匹配 generation。本模块用**一个** `shot_camera` rig 轮转
//! 目标来保证这一点，因此绝不可能出现「在 A 的对象姿态下更新 B 的封面」。
//!
//! 纯判定分三层，均不依赖 GPU/ECS：
//! - [`policy`]：尺寸分档、像素预算、串行选择与 LRU 淘汰顺序；
//! - [`plan`]：从场景派生采样目标与 dirty 身份（内容/镜头/时间/代数/尺寸档）；
//! - `crate::canvas_query::shot_preview`：卡片/内容区/归属线共享几何与状态文案。
//!
//! 其余部分装配 ECS：目标 rig、Sprite 生命周期、就绪检查与诊断，只在运行时（`canvas-core`）编译。

mod plan;
mod policy;
#[cfg(feature = "canvas-core")]
pub(crate) use plan::pin_capture_owners;
#[cfg(feature = "canvas-core")]
mod state;
#[cfg(feature = "canvas-core")]
mod sync;

#[cfg(feature = "canvas-core")]
pub(crate) use state::{ShotNodePreviewPlugin, ShotPreviewCards, ShotPreviewRig};
#[cfg(feature = "canvas-core")]
pub(crate) use sync::sync;
