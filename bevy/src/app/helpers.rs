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

/// 画布表面在窗口客户区中的放置结果。
///
/// 桌面顶栏把 DOM 画布从窗口原点往下推，但原生交换链挂在整个窗口上。
/// 交换链必须盖住客户区，相机视口再对齐 DOM 画布；否则少掉的高度会变成窗口底部黑边。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SurfacePlacement {
    pub window_width: u32,
    pub window_height: u32,
    pub logical_width: f32,
    pub logical_height: f32,
    pub viewport_x: u32,
    pub viewport_y: u32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    /// 表面不是从窗口原点开始。为 false 时不设相机视口，保持浏览器整窗行为。
    pub inset: bool,
}

/// 由 DOM 表面的原点、尺寸和 DPR 计算交换链与相机视口。
///
/// 小于 1px 的原点当作 0，避免亚像素噪声把整窗画布收成视口。
pub(crate) fn place_native_surface(
    origin_x: f32,
    origin_y: f32,
    width: f32,
    height: f32,
    pixel_ratio: f32,
) -> SurfacePlacement {
    let dpr = if pixel_ratio.is_finite() && pixel_ratio > 0.0 {
        pixel_ratio
    } else {
        1.0
    };
    let width = if width.is_finite() && width > 0.0 {
        width
    } else {
        1.0
    };
    let height = if height.is_finite() && height > 0.0 {
        height
    } else {
        1.0
    };
    let origin_x = if origin_x.is_finite() && origin_x >= 1.0 {
        origin_x
    } else {
        0.0
    };
    let origin_y = if origin_y.is_finite() && origin_y >= 1.0 {
        origin_y
    } else {
        0.0
    };
    let viewport_x = (origin_x * dpr).round().clamp(0.0, 16384.0) as u32;
    let viewport_y = (origin_y * dpr).round().clamp(0.0, 16384.0) as u32;
    let viewport_width = (width * dpr).round().clamp(1.0, 16384.0) as u32;
    let viewport_height = (height * dpr).round().clamp(1.0, 16384.0) as u32;
    SurfacePlacement {
        window_width: viewport_x.saturating_add(viewport_width).clamp(1, 16384),
        window_height: viewport_y.saturating_add(viewport_height).clamp(1, 16384),
        logical_width: viewport_width as f32 / dpr,
        logical_height: viewport_height as f32 / dpr,
        viewport_x,
        viewport_y,
        viewport_width,
        viewport_height,
        inset: viewport_x > 0 || viewport_y > 0,
    }
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
    let overlay_active = overlay_camera2d_active(focused) || (focused && !scene.0.model_focus_context.is_empty());
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
            origin_x: 0.0,
            origin_y: 0.0,
        });
        assert_eq!(surface_size(&scene), Some((1000.0, 800.0)));
    }

    #[test]
    fn zero_origin_keeps_the_swapchain_on_the_canvas() {
        let placed = place_native_surface(0.0, 0.4, 1280.0, 720.0, 1.0);
        assert!(!placed.inset);
        assert_eq!((placed.window_width, placed.window_height), (1280, 720));
        assert_eq!((placed.logical_width, placed.logical_height), (1280.0, 720.0));
    }

    #[test]
    fn chrome_inset_extends_the_window_and_offsets_the_viewport() {
        let placed = place_native_surface(0.0, 26.0, 1280.0, 694.0, 1.0);
        assert!(placed.inset);
        assert_eq!((placed.window_width, placed.window_height), (1280, 720));
        assert_eq!((placed.viewport_x, placed.viewport_y), (0, 26));
        assert_eq!((placed.viewport_width, placed.viewport_height), (1280, 694));
        assert_eq!((placed.logical_width, placed.logical_height), (1280.0, 694.0));
        // Native view layout must cover this swapchain (0,0,1280,720), not the
        // canvas hole (0,26,1280,694). The hole is only the camera viewport.
        assert_eq!(
            (0.0 + 1280.0, 26.0 + 694.0),
            (placed.window_width as f32, placed.window_height as f32)
        );
    }
}
