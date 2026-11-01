//! 模型编辑 gizmo 的 Canvas adapter
//! （change: add-model-editor-gizmo-shot-capture，任务 2.1 / 3.2；
//!  change: refactor-bevy-reusable-components，任务 5.3/5.4 / design D5）。
//!
//! 可丢弃的 handle 实体/几何/命中表示已迁到通用 [`crate::transform_gizmo`]。本模块只做
//! **领域适配**：把 `Scene.model_editor` 投影为 `TransformGizmoSelection`，并保留 editor
//! render layer 常量。模型工作区仍独占 editable/readonly 门禁、命中解释与 canonical 写回。
//!
//! 严格受限：模型 placement gizmo 只有位移中心 + 世界 Y 轴 yaw 环；镜头 focus 允许三轴编辑；
//! shot frustum/orbit/distance gizmo 仍由 `ShotCameraPlugin` 拥有，本模块不重复绘制。

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;

use crate::protocol::ModelEditor;
use crate::transform_gizmo::{
    TransformGizmoMode, TransformGizmoSelection, TransformGizmoStyle, TransformGizmoTarget,
};

/// 编辑辅助使用独立渲染层；主画布相机可见，截图相机不可见。
pub(crate) const EDITOR_LAYER: usize = 1;

/// 编辑辅助层标记：保留给后续「截图窗口回退时隐藏 editor chrome」的实体过滤；
/// 当前无实体使用，暂以 allow 保留以免每次升级误删。
#[derive(Component)]
#[allow(dead_code)]
pub(crate) struct ModelEditorGizmo;

/// editor layer 的 `RenderLayers`（与通用 gizmo 默认层一致）。
pub(crate) fn editor_render_layers() -> RenderLayers {
    RenderLayers::layer(EDITOR_LAYER)
}

/// 绘制签名：工具模式 + 目标 + 几何 + 镜头 pose；变化才重建。
///
/// 当前 gizmo 重建由 `TransformGizmoSelection` diff 驱动；本函数保留为 golden 对照。
#[cfg(test)]
pub(crate) fn editor_signature(editor: Option<&ModelEditor>) -> String {
    match editor {
        None => "none".to_owned(),
        Some(editor) => {
            let shot = editor
                .shot
                .as_ref()
                .map(|shot| {
                    format!(
                        "{}:{}:{}:{}:{}:{}:{}:{}",
                        shot.position[0],
                        shot.position[1],
                        shot.position[2],
                        shot.focus[0],
                        shot.focus[1],
                        shot.focus[2],
                        shot.fov,
                        shot.aspect
                    )
                })
                .unwrap_or_else(|| "-".to_owned());
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}",
                editor.tool_mode,
                editor.camera_tool.as_deref().unwrap_or("-"),
                editor.node_id,
                editor.focus[0],
                editor.focus[1],
                editor.focus[2],
                editor.radius,
                shot
            )
        }
    }
}

/// 把 `Scene.model_editor` 投影为通用 gizmo selection（命令面，驱动 handle 表示）。
///
/// 只在 scene 变化帧调用；只写 selection，不直接创建实体（实体由 `TransformGizmoPlugin` 管理）。
pub(crate) fn sync_editor_gizmo(
    selection: &mut TransformGizmoSelection,
    style: &mut TransformGizmoStyle,
    editor: Option<&ModelEditor>,
    theme: &crate::theme::ThemeResource,
) {
    selection.grid = editor
        .and_then(|editor| editor.grid.as_ref())
        .map(|grid| (Vec3::from_array(grid.origin), grid.spacing));
    style.palette = gizmo_palette(theme);
    style.layers = editor_render_layers();
    selection.hover = editor
        .and_then(|e| e.feedback.as_ref())
        .and_then(|f| f.hover.clone());
    selection.active = editor
        .and_then(|e| e.feedback.as_ref())
        .and_then(|f| f.active.clone());
    selection.basis = Mat3::IDENTITY;
    let Some(editor) = editor else {
        selection.set(None, None);
        return;
    };
    let mode = if editor.tool_mode == "camera"
        && editor.camera_tool.as_deref() == Some("focus")
        && editor.shot.is_some()
    {
        Some(TransformGizmoMode::FocusAxes)
    } else {
        None
    };
    let focus = if editor.tool_mode == "camera" {
        editor
            .shot
            .as_ref()
            .map(|s| s.focus)
            .unwrap_or(editor.focus)
    } else {
        editor.focus
    };
    selection.set(
        mode,
        mode.map(|_| TransformGizmoTarget {
            focus: Vec3::from_array(focus),
            radius: editor.radius,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor(tool: &str) -> ModelEditor {
        ModelEditor {
            grid: None,
            version: crate::protocol::MODEL_EDITOR_VERSION.to_owned(),
            node_id: "m1".to_owned(),
            tool_mode: tool.to_owned(),
            feedback: None,
            camera_tool: Some("orbit".to_owned()),
            camera_id: Some("cam-a".to_owned()),
            focus: [0.0, 1.0, 0.0],
            radius: 2.0,
            shot: Some(crate::protocol::ShotCamera {
                position: [1.0, 2.0, 1.0],
                focus: [0.0, 1.0, 0.0],
                fov: 0.87,
                azimuth: 0.4,
                elevation: std::f32::consts::FRAC_PI_4,
                distance: 5.0,
                aspect: "16:9".to_owned(),
            }),
        }
    }

    #[test]
    fn signature_changes_with_mode_and_geometry() {
        assert_eq!(editor_signature(None), "none");
        let a = editor_signature(Some(&editor("model")));
        let b = editor_signature(Some(&editor("camera")));
        assert_ne!(a, b);
        assert_ne!(a, "none");
    }

    #[test]
    fn signature_is_stable_for_same_state() {
        assert_eq!(
            editor_signature(Some(&editor("model"))),
            editor_signature(Some(&editor("model")))
        );
    }

    #[test]
    fn signature_tracks_shot_focus_shift() {
        let base = editor("camera");
        let mut moved = editor("camera");
        if let Some(shot) = moved.shot.as_mut() {
            shot.focus = [0.0, 9.0, 0.0];
        }
        assert_ne!(
            editor_signature(Some(&base)),
            editor_signature(Some(&moved))
        );
    }

    #[test]
    fn adapter_maps_mode_to_gizmo_selection() {
        let theme = crate::theme::ThemeResource::default();
        let mut style = TransformGizmoStyle::default();
        let mut selection = TransformGizmoSelection::default();

        sync_editor_gizmo(&mut selection, &mut style, Some(&editor("model")), &theme);
        assert_eq!(selection.mode, None);

        sync_editor_gizmo(&mut selection, &mut style, Some(&editor("camera")), &theme);
        assert_eq!(selection.mode, None);
        let mut focus_editor = editor("camera");
        focus_editor.camera_tool = Some("focus".into());
        sync_editor_gizmo(&mut selection, &mut style, Some(&focus_editor), &theme);
        assert_eq!(selection.mode, Some(TransformGizmoMode::FocusAxes));

        sync_editor_gizmo(&mut selection, &mut style, None, &theme);
        assert_eq!(selection.mode, None);
    }
}

/// Palette adapters are the only theme-aware part; reusable gizmos receive colors from their host.
pub(crate) fn gizmo_palette(
    theme: &crate::theme::ThemeResource,
) -> crate::gizmo_layout::render::GizmoPalette {
    crate::gizmo_layout::render::GizmoPalette {
        colors: [
            theme.token_color("gizmoAxisX"),
            theme.token_color("gizmoAxisY"),
            theme.token_color("gizmoAxisZ"),
            theme.token_color("webTextPrimary"),
            theme.token_color("webTextMuted"),
        ],
        accent: theme.token_color("interactionAccent"),
    }
}
