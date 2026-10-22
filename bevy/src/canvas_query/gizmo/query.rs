//! gizmo 命中与轴拖动约束的 JSON 边界入口
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.3）。
//!
//! 从 `gizmo/mod.rs` 拆出以遵守文件体积守卫；只做 JSON 解码与调度，几何在父模块。

use super::{
    AxisDragConstraint, FocusCamera, FocusGizmo, GizmoHitResult, MODEL_FOCUS_FOV,
    FOCUS_GIZMO_CENTER_HIT_CSS, focus_axis_constraint, focus_gizmo, focus_projector, hit_focus_gizmo,
    hit_model_gizmo, hit_shot_gizmo, model_gizmo, shot_gizmo, shot_projector, Projector,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    /// 查询种类：`model` / `shot` / `focus`（与前端三个入口一一对应）。
    kind: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    #[serde(default)]
    radius: Option<f32>,
    #[serde(default)]
    focus: Option<[f32; 3]>,
    #[serde(default)]
    shot: Option<ShotJson>,
    #[serde(default)]
    projection: Option<ProjectionJson>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShotJson {
    position: [f32; 3],
    focus: [f32; 3],
    /// 透视垂直 FOV（弧度；change: switch-shot-camera-to-perspective）。
    fov: f32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionJson {
    target: [f32; 3],
    yaw: f32,
    pitch: f32,
    distance: f32,
}

/// JSON 入口：模型编辑 gizmo 命中。
///
/// 请求携带 editor 瞬时态（kind/toolMode/shot/focus/radius）、可选聚焦投影与 surface 尺寸，
/// 由 Rust 用同一相机/几何投影并返回稳定 handle 与轴拖动约束。
pub(crate) fn gizmo_query_json(json: &str) -> String {
    let Ok(request) = serde_json::from_str::<Request>(json) else {
        return gizmo_unavailable("unavailable");
    };
    let surface = (request.width, request.height);
    let radius = request.radius.unwrap_or(1.0);
    let pointer = (request.x, request.y);
    if request.kind == "model" {
        let Some(focus) = request.focus else {
            return gizmo_unavailable("unavailable");
        };
        let Some(camera) = focus_camera(request.projection.as_ref()) else {
            return gizmo_unavailable("unavailable");
        };
        let project = focus_projector(camera, surface, MODEL_FOCUS_FOV);
        let geometry = model_gizmo(focus, radius);
        return match hit_model_gizmo(pointer, &geometry, &project) {
            Some((handle, _)) => gizmo_hit(Some(handle), None),
            None => gizmo_hit(None, None),
        };
    }
    // 片场对象编辑：选中对象处三轴位移 + 中心（change: 2026-10-09）。
    if request.kind == "object" {
        let Some(focus) = request.focus else {
            return gizmo_unavailable("unavailable");
        };
        let Some(camera) = focus_camera(request.projection.as_ref()) else {
            return gizmo_unavailable("unavailable");
        };
        let project = focus_projector(camera, surface, MODEL_FOCUS_FOV);
        let geometry = focus_gizmo(focus, radius);
        if let Some(center) = project(geometry.origin) {
            let distance = ((pointer.0 - center.0).powi(2) + (pointer.1 - center.1).powi(2)).sqrt();
            if distance <= FOCUS_GIZMO_CENTER_HIT_CSS {
                return gizmo_hit(Some("center"), None);
            }
        }
        return match hit_focus_gizmo(pointer, &geometry, &project) {
            Some((axis, _)) => {
                let constraint = focus_axis_constraint(&geometry, axis, &project);
                gizmo_hit(Some(axis), constraint)
            }
            None => gizmo_hit(None, None),
        };
    }
    if request.kind == "focus" {
        let Some(shot) = request.shot else {
            return gizmo_unavailable("unavailable");
        };
        let Some(camera) = focus_camera(request.projection.as_ref()) else {
            return gizmo_unavailable("unavailable");
        };
        let project = focus_projector(camera, surface, MODEL_FOCUS_FOV);
        let geometry = focus_gizmo(shot.focus, radius);
        // 注视点中心优先：与主画面一致，中心拖动改变注视点本身（无轴约束）。
        if let Some(center) = project(geometry.origin) {
            let distance = ((pointer.0 - center.0).powi(2) + (pointer.1 - center.1).powi(2)).sqrt();
            if distance <= FOCUS_GIZMO_CENTER_HIT_CSS {
                return gizmo_hit(Some("center"), None);
            }
        }
        return match hit_focus_gizmo(pointer, &geometry, &project) {
            Some((axis, _)) => {
                let constraint = focus_axis_constraint(&geometry, axis, &project);
                gizmo_hit(Some(axis), constraint)
            }
            None => gizmo_hit(None, None),
        };
    }
    let Some(shot) = request.shot else {
        return gizmo_hit(None, None);
    };
    // 主观察相机的透视投影（与主画面 gizmo 一致）；无投影时回退镜头正交投影。
    let project = match focus_camera(request.projection.as_ref()) {
        Some(camera) => focus_projector(camera, surface, MODEL_FOCUS_FOV),
        None => shot_projector(shot.focus, shot.position, shot.fov, surface),
    };
    let geometry = shot_gizmo(shot.focus, shot.position, radius);
    match hit_shot_gizmo(pointer, &geometry, &project) {
        Some((handle, _)) => gizmo_hit(Some(handle), None),
        None => gizmo_hit(None, None),
    }
}

fn focus_camera(projection: Option<&ProjectionJson>) -> Option<FocusCamera> {
    let projection = projection?;
    Some(FocusCamera {
        target: projection.target,
        yaw: projection.yaw,
        pitch: projection.pitch,
        distance: projection.distance,
    })
}

fn gizmo_hit(handle: Option<&str>, constraint: Option<AxisDragConstraint>) -> String {
    serde_json::to_string(&GizmoHitResult {
        available: true,
        reason: None,
        handle: handle.map(str::to_owned),
        constraint,
    })
    .unwrap_or_else(|_| gizmo_unavailable("unavailable"))
}

fn gizmo_unavailable(reason: &str) -> String {
    serde_json::to_string(&GizmoHitResult {
        available: false,
        reason: Some(reason.to_owned()),
        handle: None,
        constraint: None,
    })
    .unwrap_or_else(|_| "{}".to_owned())
}

// 显式标记这些类型在子模块中作为签名一部分被引用（避免未使用告警）。
#[allow(dead_code)]
type _ProjectorAlias = Projector<'static>;
#[allow(dead_code)]
type _FocusGizmoAlias = FocusGizmo;
