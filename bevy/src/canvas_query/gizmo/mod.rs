//! Accepted editor queries and shared observer rays. All handle geometry lives in gizmo_layout.
#[cfg(feature = "canvas-core")]
mod accepted;
#[cfg(feature = "canvas-core")]
mod query;
#[cfg(feature = "canvas-core")]
pub(crate) use accepted::{accept_gizmo_observer, accept_gizmo_scene};
use bevy::math::{Vec2, Vec3};
#[cfg(feature = "canvas-core")]
pub(crate) use query::gizmo_query_json;
use serde::Serialize;

#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusCamera {
    pub(crate) target: [f32; 3],
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
}
pub(crate) fn focus_ray(
    camera: FocusCamera,
    surface: (f32, f32),
    point: (f32, f32),
) -> ([f32; 3], [f32; 3]) {
    crate::gizmo_layout::GizmoView::orbit(
        Vec3::from_array(camera.target),
        camera.yaw,
        camera.pitch,
        camera.distance,
        Vec2::new(surface.0, surface.1),
        MODEL_FOCUS_FOV,
    )
    .and_then(|view| view.ray(Vec2::new(point.0, point.1)))
    .map(|(origin, direction)| (origin.to_array(), direction.to_array()))
    .unwrap_or(([f32::NAN; 3], [f32::NAN; 3]))
}

/// gizmo 命中结果（JSON 边界用）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GizmoHitResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    /// `shot-origin` / `orbit-ring` / `distance` / `center` / `yaw-ring` / `x` / `y` / `z`。
    pub(crate) handle: Option<String>,
    /// 轴拖动约束（仅焦点三轴命中时）。
    pub(crate) constraint: Option<AxisDragConstraint>,
    pub(crate) yaw_constraint: Option<crate::gizmo_layout::YawConstraint>,
    pub(crate) layout_id: Option<String>,
    pub(crate) generation: u32,
    pub(crate) epoch: u32,
}

/// 与 contracts `MODEL_FOCUS_FOV` 一致（50°，弧度）。
pub(crate) const MODEL_FOCUS_FOV: f32 = 50.0 * std::f32::consts::PI / 180.0;

/// 焦点 gizmo 的屏幕轴约束（供 JS 连续拖动复用，无需重建相机矩阵）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AxisDragConstraint {
    pub(crate) axis: String,
    /// 轴屏幕方向（单位向量）。
    pub(crate) direction: (f32, f32),
    /// 世界长度 / 屏幕像素。
    pub(crate) world_per_pixel: f32,
}

#[cfg(all(test, feature = "canvas-core"))]
mod tests;

#[cfg(feature = "canvas-core")]
pub(crate) use accepted::gizmo_view;
