//! The WASM and native dispatcher share this exact accepted-layout query.
use super::{AxisDragConstraint, GizmoHitResult};
use crate::gizmo_layout::{ObjectGizmoLayout, ObjectTool, hit_shot_layout, shot_gizmo_layout};
use crate::protocol::ModelEditor;
use bevy::math::{Mat3, Vec2, Vec3};
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    kind: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    generation: u32,
    editor: ModelEditor,
    projection: Projection,
}
#[derive(serde::Deserialize)]
struct Projection {
    target: [f32; 3],
    yaw: f32,
    pitch: f32,
    distance: f32,
}
pub(crate) fn gizmo_query_json(json: &str) -> String {
    let mut result = GizmoHitResult {
        available: false,
        reason: Some("unavailable".into()),
        handle: None,
        constraint: None,
        yaw_constraint: None,
        layout_id: None,
        generation: 0,
        epoch: 0,
    };
    let apply = |result: &mut GizmoHitResult| -> Option<()> {
        let request = serde_json::from_str::<Request>(json).ok()?;
        if request.editor.validate().is_err() {
            return None;
        }
        let accepted = super::accepted::current()?;
        let generation = crate::canvas_query::interaction::current_generation();
        let expected = super::accepted::layout_id(&accepted.editor, &accepted.view);
        let view = crate::gizmo_layout::GizmoView::orbit(
            Vec3::from_array(request.projection.target),
            request.projection.yaw,
            request.projection.pitch,
            request.projection.distance,
            Vec2::new(request.width, request.height),
            accepted.view.fov,
        )?;
        if request.generation != generation
            || super::accepted::layout_id(&request.editor, &view) != expected
            || request.editor.feedback.as_ref().map(|f| f.epoch)
                != accepted.editor.feedback.as_ref().map(|f| f.epoch)
        {
            result.reason = Some("stale".into());
            return None;
        }
        result.generation = generation;
        result.layout_id = Some(expected);
        result.epoch = accepted.editor.feedback.as_ref().map_or(0, |f| f.epoch);
        let pointer = Vec2::new(request.x, request.y);
        if !pointer.is_finite() {
            return None;
        }
        let editor = &accepted.editor;
        if request.kind == "object" && editor.tool_mode != "object"
            || request.kind != "object" && editor.tool_mode != "camera"
        {
            return None;
        }
        let tool = if request.kind == "object" {
            editor.object_tool
        } else {
            ObjectTool::Move
        };
        if request.kind == "focus" && editor.camera_tool.as_deref() != Some("focus") {
            return None;
        }
        result.available = true;
        result.reason = None;
        if request.kind == "shot" {
            let shot = editor.shot.as_ref()?;
            let position = Vec3::from_array(shot.position);
            let lines = shot_gizmo_layout(
                &view,
                Vec3::from_array(shot.focus),
                position,
                shot.fov,
                crate::protocol::parse_shot_aspect_ratio(&shot.aspect)?,
                editor.camera_tool.as_deref().unwrap_or("orbit"),
            );
            result.handle = hit_shot_layout(&lines, &view, position, pointer).map(str::to_owned);
            return Some(());
        }
        if request.kind != "object" && request.kind != "focus" {
            return None;
        }
        let origin = if request.kind == "focus" {
            editor.shot.as_ref()?.focus
        } else {
            editor.focus
        };
        let parent = editor
            .parent_basis
            .map(|b| Mat3::from_cols_array(&b))
            .unwrap_or(Mat3::IDENTITY);
        let layout = ObjectGizmoLayout::new(&view, Vec3::from_array(origin), tool, parent)?;
        let Some(handle) = layout.hit(&view, pointer) else {
            return Some(());
        };
        match handle {
            "x" | "y" | "z" => {
                let index = match handle {
                    "x" => 0,
                    "y" => 1,
                    _ => 2,
                };
                let (direction, scale) = layout.axes[index]?;
                result.constraint = Some(AxisDragConstraint {
                    axis: handle.into(),
                    direction: (direction.x, direction.y),
                    world_per_pixel: scale,
                });
            }
            "yaw-ring" => result.yaw_constraint = Some(layout.yaw_constraint(&view, pointer)?),
            "scale" => {
                result.constraint = Some(AxisDragConstraint {
                    axis: handle.into(),
                    direction: (
                        std::f32::consts::FRAC_1_SQRT_2,
                        -std::f32::consts::FRAC_1_SQRT_2,
                    ),
                    world_per_pixel: 1.0 / 128.0,
                })
            }
            _ => {}
        }
        result.handle = Some(handle.into());
        Some(())
    };
    apply(&mut result);
    serde_json::to_string(&result).unwrap_or_else(|_| "{}".into())
}
