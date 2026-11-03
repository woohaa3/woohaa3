//! 3D 模型渲染域：颜色/material、transform、Scene IR shape 实例化与按 signature 同步
//! （change: refactor-bevy-runtime-modules，任务 4.3 / design D5；
//!  change: enhance-model-scene-authoring-api，任务 3.2–3.4 / 4.1–4.3；
//!  change: refactor-bevy-rust-file-size 拆分为 facade + 子模块；
//!  change: add-model-editor-gizmo-shot-capture 增加编辑 gizmo 与镜头截图子模块）。
//!
//! 本模块独占 3D Camera、灯光、网格与模型 entity，不导入 `canvas2d` / `bridge` /
//! `wasm_bindgen`。V2 采用真实 entity hierarchy：父级局部变换与动画自然传播到后代；
//! V1 保持既有平铺渲染结果不变。
//!
//! 浏览器 WASM adapter（`spawn_*` / `sync_models` / material）只被 wasm-only 的 `app`
//! 引用；native-renderer 复用 `scene` 的纯构建逻辑。非 wasm 构建下 adapter 是死代码，
//! 这里显式 allow，避免把 feature gate 撒到每个函数上。
//!
//! 子模块边界（design D2）：
//! - [`mesh`]：`ModelGeometry` → `Mesh` 与稳定 mesh key；
//! - [`layout`]：根单位、锚点与 transform 计算；
//! - [`spawn`]：V1/V2 entity hierarchy 构建与动画挂载；
//! - [`runtime`]：按 signature 同步、根 transform 应用、清理与聚焦可见性；
//! - [`editor`]：模型 placement gizmo 与镜头 shot gizmo 绘制；
//! - [`capture`]：镜头离屏截图目标与 WASM readback；
//! - [`pick`]：普通模型 picking 候选世界 AABB。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code, unused_imports))]

pub(crate) mod animation;
#[cfg(feature = "canvas-core")]
pub(crate) mod capture;
pub(crate) mod editor;
pub(crate) mod focus;
pub(crate) mod focus_transition;
pub(crate) mod grid;
pub(crate) mod pick;
pub(crate) mod scene;
pub(crate) mod shot_adapter;
// 跨后端容差比较：不依赖 Bevy，可在 CI 上单测；真实取图由带 GPU 的环境提供。
// change: 2026-10-09-refactor-large-source-files-and-remove-compatibility D02 —— 该模块只被
// 自身内联测试消费，收敛为 test-only 编译面，避免 native/wasm 生产构建携带未用代码。
#[cfg(test)]
pub(crate) mod visual_compare;

#[cfg(feature = "native-renderer")]
pub mod lod_benchmark;
#[cfg(feature = "native-renderer")]
pub mod preview;

mod layout;
pub(crate) use layout::CANVAS_UNITS_PER_METER;
mod batch_cache;
mod batch_strategy;
mod batching;
pub(crate) mod demand;
mod diagnostics;
#[cfg(feature = "explicit-instancing")]
pub(crate) mod instancing;
mod mesh;
pub(crate) mod model_textures;
mod motion_plan;
mod motion_reset;
mod opacity;
mod playback_prepare;
pub(crate) mod quality;
mod resource_ownership;
mod resource_work;
mod resources;
mod runtime;
pub(crate) mod world_presence;
mod simplification;
mod simplification_allocator;
mod simplification_jobs;
mod spawn;

pub(crate) use spawn::{PreviewRoot, spawn_preview_root};

pub(crate) use animation::TransformAnimationSet;

#[cfg(feature = "canvas-core")]
pub(crate) use grid::{setup as setup_grid, setup_camera};

pub(crate) use runtime::{
    FocusVisuals, ModelAssets, ModelVisuals, apply_animation_playback, apply_motion_playback,
    sync_models, sync_quality, sync_quality_with_demand,
};
#[cfg(test)]
pub(crate) use runtime::ModelAnchor;

/// `compose_delta` 仅 native renderer 的离屏预览复用；wasm 侧走 `runtime` 内部调用。
#[cfg(feature = "native-renderer")]
pub(crate) use runtime::compose_delta;

/// 共享纯模型几何派生（prepared/register 边界与 native renderer 复用）
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.1）。
///
/// `derive_aabb`/`derive_extent`/`preview_focus` 仅 native-renderer golden/preview 消费，
/// wasm 构建下未用，显式放行以免误报。
#[allow(unused_imports)]
pub(crate) use scene::{derive_aabb, derive_extent, prepare_snapshot, preview_focus};

/// 模型世界局部 AABB（含 placement/anchor）；卡片内嵌预览与质量选择共用同一事实源
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2）。
///
/// 普通画布 picking 候选现由 [`pick`] 直接消费 `layout` 派生（不再经此处转发）。
#[cfg(feature = "canvas-core")]
pub(crate) use layout::model_bounds_for_node;

/// 模型单位（自然单位 × 节点矩形容器适配）。
pub(crate) use layout::model_unit;

use bevy::camera::visibility::RenderLayers;

/// 模型实体渲染层：主画布层（0）+ 截图层，使截图像机只看到模型，不含网格/gizmo/2D chrome
/// （change: add-model-editor-gizmo-shot-capture，任务 3.3）。
pub(crate) fn model_render_layers() -> RenderLayers {
    #[cfg(feature = "canvas-core")]
    {
        RenderLayers::from_layers(&[0, capture::CAPTURE_LAYER])
    }
    #[cfg(not(feature = "canvas-core"))]
    {
        RenderLayers::from_layers(&[0])
    }
}

/// 在模型根实体上**追加**卡片预览渲染层，不改动其它层
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
///
/// 拍摄镜头卡片预览的相机只看自己那一层，因此共享模型根必须同时留在主画布层（0）、截图层
/// （wasm）与**全部**卡片预览层。返回实际写入的实体数，供调用方做未变化时的跳过与工作量
/// 统计；根不存在时返回 `None`。
pub(crate) fn add_preview_layers(
    models: &ModelVisuals,
    commands: &mut bevy::prelude::Commands,
    node_id: &str,
    layers: &[usize],
) -> Option<u64> {
    let root = models.roots.get(node_id)?;
    let mut combined = model_render_layers();
    for layer in layers {
        combined = combined.with(*layer);
    }
    for entity in &root.entities {
        commands.entity(*entity).insert(combined.clone());
    }
    Some(root.entities.len() as u64)
}

#[cfg(test)]
mod tests;
