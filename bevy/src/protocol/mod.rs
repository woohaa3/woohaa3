//! 运行时渲染协议：与 Web `CanvasRenderScene` / Scene IR 对应的纯 serde DTO 与边界校验
//! （change: refactor-bevy-runtime-modules，任务 2.1 / design D2；
//! change: refactor-bevy-rust-file-size 拆分为 facade + 子模块）。
//!
//! 本模块只依赖 `serde` 与标准库：不导入 `bevy` / `wasm_bindgen`，不拥有 thread-local
//! 或 ECS 状态。权威校验仍在 Web contracts，Rust 侧只做边界级防御校验。
//!
//! 部分 DTO 字段只被 WASM 或 native-renderer 其中之一消费；非对应 feature 下显式 allow。
//!
//! 子模块边界：
//! - [`theme`]：主题快照、token 校验与规范 hex 解析；
//! - [`model`]：Scene IR V1/V2 模型 DTO（`ModelOp` / `ModelSnapshot` / placement）；
//! - [`scene`]：画布快照 `Scene` 及其节点/边/视口/聚焦 DTO 与整体校验。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]

mod animation_playback;
pub(crate) mod focus_details;
mod focus_transition;
mod image_focus;
mod model;
mod observer;
mod position;
mod resource_state;
pub(crate) use resource_state::{NodeResourceState, ResourceStateRequest};
mod prepared;
mod scene;
mod scene_instant;
mod shared_world;
mod theme;
mod world_camera;
mod video_focus;
mod viewport;

// 保留既有 `crate::protocol::*` 消费路径：facade 是唯一对外入口（design D1）。
//
// 部分 DTO 只在 WASM 或 native-renderer 其中之一（或只在测试中）被引用，因此某个
// feature 组合下个别再导出会看似“未被使用”。这些 path 必须稳定存在，故显式放行。
#[allow(unused_imports)]
pub(crate) use focus_transition::{FOCUS_TRANSITION_VERSION, FocusTransitionProgress};
#[allow(unused_imports)]
pub(crate) use image_focus::{IMAGE_FOCUS_VERSION, ImageFocus, ImageFocusViewport};
#[allow(unused_imports)]
pub(crate) use model::{
    CANVAS_RENDER_SCENE_VERSION, DEFAULT_BLEND_OPACITY, MODEL_ASSET_VERSION,
    MODEL_DESCRIPTOR_VERSION, MODEL_SCENE_IR_V2, ModelAabbDto, ModelAssetDescriptor,
    ModelDescriptor, ModelDescriptorDto, ModelOffset, ModelOp, ModelPlacement, ModelReference,
    ModelSnapshot, canonical_signature, fnv1a64_utf16,
};
#[allow(unused_imports)]
pub(crate) use observer::{CANVAS_OBSERVER_UPDATE_VERSION, ObserverUpdateRequest, apply_observer};
#[allow(unused_imports)]
pub(crate) use position::{
    CANVAS_POSITION_UPDATE_VERSION, MAX_POSITION_UPDATE_BYTES, MAX_POSITION_UPDATES, NodePosition,
    PositionUpdateRequest,
};
#[allow(unused_imports)]
pub(crate) use prepared::{PreparedModelMetadata, PreparedModelRequest};
#[allow(unused_imports)]
pub(crate) use scene::{
    Edge, GraphNode, HistoryStripDot, HistoryStripPresentation, NodeChrome, Scene, SceneArea,
    SceneAreaBounds, SceneAreaPlayback, SceneAreaPoint, Selection, Viewport,
};
#[allow(unused_imports)]
pub(crate) use scene_instant::{
    AggregateConnect, AnimationPlayback, CursorPoint, Draft, DragAttach, DragAttachEdge,
    MODEL_EDITOR_VERSION, MODEL_FOCUS_VERSION, Marquee, ModelEditor, ModelFocus, NodeAction,
    NodeActions, NodeHover, PlaybackCamera, SUPPORTED_SHOT_ASPECTS, ShotCamera, SurfaceSize,
    parse_shot_aspect_ratio,
};
#[allow(unused_imports)]
pub(crate) use shared_world::{
    WorldInstance,
    UNITS_PER_METER, renderer_rotation_to_world, renderer_to_world, world_rotation_to_renderer,
    world_to_renderer,
};
#[allow(unused_imports)]
pub(crate) use theme::{Theme, is_known_theme_token, parse_theme_hex};
#[allow(unused_imports)]
pub(crate) use world_camera::{
    WorldCamera, WorldCameraAspect, WorldCameraCaptureMode, WorldCameraPoint,
    WorldCameraProjection, WORLD_CAMERA_VERSION,
};
#[allow(unused_imports)]
pub(crate) use video_focus::{VIDEO_FOCUS_VERSION, VideoFocus};
pub(crate) use viewport::{CANVAS_VIEWPORT_UPDATE_VERSION, ViewportUpdateRequest};

/// 节点默认宽高（world ≈ CSS 像素）。与 contracts 的默认节点尺寸一致。
pub(crate) const DEFAULT_NODE_WIDTH: f32 = 224.0;
pub(crate) const DEFAULT_NODE_HEIGHT: f32 = 116.0;
/// 单边最大纹理尺寸。
pub(crate) const MAX_TEXTURE_EDGE: u32 = 2048;
/// set_scene JSON 载荷上限（16 MiB，与 native renderer 消息上限一致）。
pub(crate) const MAX_SCENE_BYTES: usize = 16 * 1024 * 1024;

/// 纹理边界校验；错误文案与重构前 `set_texture` 保持一致。
pub(crate) fn validate_texture(width: u32, height: u32, len: usize) -> Result<(), &'static str> {
    if width == 0
        || height == 0
        || width > MAX_TEXTURE_EDGE
        || height > MAX_TEXTURE_EDGE
        || len != (width as usize * height as usize * 4)
    {
        return Err("Invalid texture");
    }
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_instant;
#[cfg(test)]
mod tests_progress;

