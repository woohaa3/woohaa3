//! App 内部 helper：画布尺寸与聚焦投影的纯函数
//! （change: add-reusable-bevy-shot-camera 顺带解决 app.rs 超行数守卫）。

use bevy::prelude::*;

use crate::canvas_query::layout::overlay_camera2d_active;
use crate::model3d;
use crate::protocol::Scene;

use super::CurrentScene;

/// 从场景取画布 CSS 尺寸（宽、高）；缺失返回 None。
pub(crate) fn surface_size(scene: &Scene) -> Option<(f32, f32)> {
    scene.surface.as_ref().map(|size| (size.width, size.height))
}

/// 应用聚焦/普通投影与 Camera2d 可见性（状态切换当帧即时生效）。
///
/// 片场标题、虚线框与编辑抓手只由 2D 覆盖层（`MainCanvasCamera`）绘制
/// （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。聚焦镜头预览、
/// 截图、离屏历史预览与视频导出都切换为透视聚焦相机并停用这张 2D 相机，因此成片结构上
/// 不会包含标题或编辑工具。
///
/// 退出聚焦时用当前 viewport 重新派生普通相机投影 `ortho.scale = 1/zoom`，不复用聚焦前
/// 的 scale（change: make-shot-framing-zoom-invariant，design D3/D5）。
pub(crate) fn apply_focus_projection(
    projection: &mut Projection,
    focused: bool,
    scene: &CurrentScene,
    camera2d: &mut Query<&mut Camera, (With<crate::canvas2d::MainCanvasCamera>, Without<Camera3d>)>,
) {
    let overlay_active = overlay_camera2d_active(focused);
    if focused {
        let fov = scene
            .0
            .model_focus
            .as_ref()
            .map(|focus| focus.fov)
            .unwrap_or(0.87);
        *projection = Projection::Perspective(PerspectiveProjection {
            fov,
            near: model3d::focus::FOCUS_NEAR,
            far: model3d::focus::FOCUS_FAR,
            ..default()
        });
    } else {
        let view = crate::isometric_grid::IsometricGridView {
            x: scene.0.viewport.x,
            y: scene.0.viewport.y,
            zoom: scene.0.viewport.zoom,
        };
        *projection = Projection::Orthographic(
            crate::isometric_grid::canvas_camera_projection_for_view(&view),
        );
    }
    for mut cam2d in camera2d.iter_mut() {
        cam2d.is_active = overlay_active;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_size_reads_scene_surface() {
        let mut scene = Scene::default();
        assert_eq!(surface_size(&scene), None);
        scene.surface = Some(crate::protocol::SurfaceSize {
            width: 1000.0,
            height: 800.0,
            pixel_ratio: 1.0,
            content_right: 0.0,
            content_rect: None,
        });
        assert_eq!(surface_size(&scene), Some((1000.0, 800.0)));
    }
}
