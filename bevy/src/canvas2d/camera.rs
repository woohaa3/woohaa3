//! 2D camera 跟随 viewport（pan/zoom）；图片聚焦时切换为 1:1 取景
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3；
//!  change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2/4.3）。

use bevy::prelude::*;

use crate::app::{CurrentScene, FrameFlags, SurfaceState};

/// 2D camera 跟随 viewport（pan/zoom）；仅在 scene/surface 变化时执行。
///
/// 图片与普通画布使用同一世界空间；聚焦 pan/zoom 仅投影到相机。
pub(crate) fn sync_camera(
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    flags: Res<FrameFlags>,
    mut camera: Query<(&mut Transform, &mut Projection), With<super::MainCanvasCamera>>,
) {
    if !flags.camera_changed {
        return;
    }
    let overlay = crate::canvas_query::focus_context::overlay(&scene.0);
    let view = &overlay.viewport;
    let (view_x, view_y, view_zoom) =
        super::image_focus::camera_view(&scene.0).unwrap_or((view.x, view.y, view.zoom));
    let size = surface.size;
    if let Ok((mut transform, mut projection)) = camera.single_mut() {
        transform.translation.x = (size.x / 2.0 - view_x) / view_zoom;
        transform.translation.y = -(size.y / 2.0 - view_y) / view_zoom;
        if let Projection::Orthographic(ref mut ortho) = *projection {
            ortho.scale = 1.0 / view_zoom;
        }
    }
}
