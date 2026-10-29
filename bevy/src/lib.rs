//! Woohaa3 画布运行时（共享 Bevy core、WASM 与原生宿主 facade）。
//!
//! 本文件是唯一的画布 public facade（change: refactor-bevy-runtime-modules）：
//! 负责 JSON/ABI 转换；渲染由 `canvas2d` / `model3d` / `app` / `bridge` 拥有。
//!
//! WASM 边界单向：快照进、渲染状态出。Bevy 不维护业务操作、历史或持久化数据。
//!
//! change: enhance-model-scene-authoring-api —— `protocol` 与 `model3d` 的纯构建逻辑
//! （`model3d::scene`）可在 native-renderer 下复用；
//! 原生画布与浏览器通过 `canvas-core` 共用帧系统与 facade；WASM ABI 只在 `wasm` 下导出。

mod frame_samples;
#[cfg(feature = "canvas-core")]
mod runtime_health;

mod generation_progress;
pub mod protocol;
mod startup_trace;
pub mod theme;
mod theme_generated;

/// 动画节点独立播放会话/时钟（change: 2026-10-05-bind-model-animation-to-shots）。
pub mod animation_session;
/// 通用相机过渡状态机（change: refactor-bevy-reusable-components）。
pub mod camera_transition;
/// 2D 共享纯几何与 interaction 查询（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
/// 不依赖 Bevy/ECS/wasm，可在 native 下单独测试；`canvas2d` 渲染复用其布局与曲线函数。
mod canvas_query;
/// 画布节点 ECS 投影层与公共组件（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
/// 组件在全部 feature 下编译（3D 模块复用 owner/part marker）；投影与批处理只在 `canvas-core`。
/// 实体只活在当前 renderer 实例内：结构变化由唯一投影点处理，位置增量只更新组件，
/// renderer 重建整体丢弃实体层级。第三方扩展最小接入方式见 `canvas_ecs/README.md`。
mod canvas_ecs;
/// 画布级 3D 根逐像素深度的平局偏移：纯几何 + 线程本地已接受表
/// （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D4）。
mod depth_order;
pub mod gizmo_layout;
/// 配置化等距网格（change: refactor-bevy-reusable-components）。
pub mod isometric_grid;
/// 动画节点运动 IR 求值器（change: 2026-10-05-bind-model-animation-to-shots）。
pub mod motion;
/// 独立目标轨道相机（change: refactor-bevy-reusable-components）。
pub mod orbit_camera;
/// 预览渲染层/槽的统一分配与回收
/// （change: 2026-10-23-scale-canvas-media-residency，design D6 / 任务 6.3）。
pub mod preview_layers;
/// 通用 transform 动画插件（change: refactor-bevy-reusable-components）。
pub mod transform_animation;
/// 可复用 transform gizmo（change: refactor-bevy-reusable-components）。
pub mod transform_gizmo;

