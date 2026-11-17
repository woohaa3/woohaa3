//! 可复用 shot camera ECS 模块
//! （change: add-reusable-bevy-shot-camera，任务 1.1 / design D1–D7）。
//!
//! 普通 Bevy App 安装 [`ShotCameraPlugin`] 后，可在运行期间按实体创建、配置、查询和销毁
//! shot camera rig；每个 rig 拥有独立 pose、lens、target、view mask、editable、preview 与
//! capture 身份。实际 `Camera3d`、render target、gizmo 与 capture 作业是由 rig identity
//! 索引的内部子实体/资源，调用方不得依赖其布局。
//!
//! 架构边界：本模块只依赖 Bevy 与标准库，**不**依赖 canvas `protocol`、`bridge`、`canvas2d`、
//! DOM 或 Y.Doc（由 `tests/architecture.rs` 守卫）。领域适配（把模型 AABB/规范镜头记录投影
//! 成 rig）由宿主 side 的 adapter 完成。

mod capture;
mod capture_image;
mod capture_types;
mod components;
mod constants;
mod edit;
mod edit_types;
mod framing;
mod gizmo;
mod lifecycle;
pub mod preview_readiness;
mod preview_types;
mod runtime;

pub use capture::{ShotCaptureState, request_capture, rgba_from_image};
pub use capture_types::{
    CaptureRoute, ShotCaptureEnqueue, ShotCaptureErrorCode, ShotCaptureFailure, ShotCaptureQueue,
    ShotCaptureRequest, ShotCaptureResult, ShotCaptureResults, resolve_capture_route,
};
pub use components::*;
pub use constants::*;
#[cfg(feature = "canvas-core")]
pub use edit::{ShotCameraInteractionPlugin, ShotPointerAdapter};
pub use edit::{ShotEditCommand, ShotEditCommands};
pub use edit_types::{
    ShotEditEvent, ShotEditSession, ShotEditSessions, begin_edit, cancel_edit, commit_edit,
    has_moved, reset_pose, update_distance, update_elevation, update_focus, update_orbit,
};
pub use framing::{
    Aabb, FramedShotCamera, SHOT_CAMERA_ABSOLUTE_MAX_DISTANCE, SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE,
    SHOT_CAMERA_ELEVATION, SHOT_CAMERA_ELEVATION_LIMIT, SHOT_CAMERA_FIT_MAX_FACTOR,
    SHOT_CAMERA_FIT_MIN_FACTOR, SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR, SHOT_CAMERA_FOV,
    SHOT_CAMERA_MAX_ELEVATION, SHOT_CAMERA_MIN_ELEVATION, azimuth_from_horizontal_drag,
    clamp_shot_distance, clamp_shot_elevation, distance_from_drag, elevation_from_vertical_drag,
    resolve_from_center_radius, resolve_shot_camera, shot_bounding_radius, shot_camera_forward,
    shot_camera_position, shot_camera_right, shot_distance_bounds, shot_fit_distance,
    shot_focus_plane_height, shot_view_half_height,
};
pub use gizmo::{
    SHOT_ELEVATION_ARC_SEGMENTS, SHOT_GIZMO_LAYER, ShotGizmoAssets, ShotGizmoSelection,
};
pub use preview_types::{
    CallerViewport, PreviewTarget, ShotCameraPreview, ShotPreviewBudget, ShotPreviewClearColor,
    ShotPreviewOutput, ShotPreviewViewport, plan_preview_updates, preview_viewport_rect,
    resolve_caller_viewport, viewport_from_css,
};
pub use runtime::{ShotCameraPlugin, ShotCameraRegistry, ShotCameraSet};

/// rig 的内部子资源句柄（不保证布局稳定；仅供模块内部系统使用）。
#[derive(bevy::prelude::Component, Clone, Debug, Default)]
pub struct ShotCameraInner {
    /// 持久 preview 相机（启用 preview 时存在）。
    pub preview_camera: Option<bevy::prelude::Entity>,
    /// 已分配的 preview Image handle（用于释放）。
    pub preview_image: Option<bevy::prelude::Handle<bevy::prelude::Image>>,
    /// 已渲染到的 generation（仅在真正渲染时推进）。
    pub rendered_generation: u64,
    /// 当前 gizmo 布局（可丢弃视图）。
    pub gizmo: GizmoLayout,
}

/// 一个 gizmo 部件的几何描述；pose 平移时只按 delta 刷新 transform。
#[derive(Clone, Copy, Debug)]
pub struct GizmoPart {
    pub entity: bevy::prelude::Entity,
    pub kind: GizmoPartKind,
}

/// gizmo 部件类型（用于差量刷新）。
#[derive(Clone, Copy, Debug)]
pub enum GizmoPartKind {
    /// 线段（视线/frustum 边）。
    Line {
        start: bevy::math::Vec3,
        end: bevy::math::Vec3,
        width: f32,
    },
}

/// rig 当前 gizmo 部件（含用于差量刷新的基准）。
#[derive(Clone, Default, Debug)]
pub struct GizmoLayout {
    pub entities: Vec<GizmoPart>,
}

/// 标记：某实体是 rig 的 preview 相机。
#[derive(bevy::prelude::Component, Clone, Copy, Debug)]
pub struct ShotPreviewCamera {
    pub rig: bevy::prelude::Entity,
}

/// 标记：某实体是 rig 的 gizmo 子实体。
#[derive(bevy::prelude::Component, Clone, Copy, Debug)]
pub struct ShotGizmo {
    pub rig: bevy::prelude::Entity,
}

/// 手动请求一次 preview 刷新（`Manual`/`OnDirty` 策略外的显式触发）。
#[derive(bevy::prelude::Message, Clone, Copy, Debug)]
pub struct TriggerShotPreview {
    pub camera: bevy::prelude::Entity,
}

/// rig 的编辑提交事件（宿主据此写回 canonical 镜头记录）。
#[derive(bevy::prelude::Message, Clone, Copy, Debug)]
pub struct ShotCameraEditCommitted {
    pub camera: bevy::prelude::Entity,
    pub pose: components::ShotCameraPose,
}

/// rig 的 preview generation 变化事件。
#[derive(bevy::prelude::Message, Clone, Copy, Debug)]
pub struct ShotCameraPreviewChanged {
    pub camera: bevy::prelude::Entity,
    pub generation: u64,
}
