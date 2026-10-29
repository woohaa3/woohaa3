//! 图片/视频的共享取景计算；不依赖 ECS 或绘图上下文。
use super::layout::{content_center, texture_size};
use crate::protocol::Scene;
use bevy::prelude::*;

/// 共用二维媒体取景：图片与视频聚焦共享同一相机/可见性/取景语义
/// （change: 2026-10-10-add-video-node-focus-workspace，design D2）。
pub(crate) struct MediaFocus<'a> {
    pub(crate) node_id: &'a str,
    pub(crate) viewport: crate::protocol::ImageFocusViewport,
    pub(crate) source_width: f32,
    pub(crate) source_height: f32,
}

/// 当前活动二维媒体聚焦（图片优先；两者互斥）。缺失即普通画布。
pub(crate) fn media_focus(scene: &Scene) -> Option<MediaFocus<'_>> {
    if let Some(focus) = scene.image_focus.as_ref() {
        return Some(MediaFocus {
            node_id: focus.node_id.as_str(),
            viewport: focus.viewport,
            source_width: focus.source_width,
            source_height: focus.source_height,
        });
    }
    if let Some(focus) = scene.video_focus.as_ref() {
        return Some(MediaFocus {
            node_id: focus.node_id.as_str(),
            viewport: focus.viewport,
            source_width: focus.source_width,
            source_height: focus.source_height,
        });
    }
    None
}

/// 入场完成后切换画布呈现；相机始终读取 media_focus，不受此门禁影响。
pub(crate) fn presented_media_focus(scene: &Scene) -> Option<MediaFocus<'_>> {
    if scene
        .image_focus
        .as_ref()
        .is_some_and(|focus| !focus.presentation_ready)
    {
        return None;
    }
    media_focus(scene)
}

pub(crate) fn has_presented_media_focus(scene: &Scene) -> bool {
    presented_media_focus(scene).is_some()
}

/// Document focus drives the shared camera; a captured viewport may have a separate sprite layout.
pub(crate) fn camera_view(scene: &Scene) -> Option<(f32, f32, f32)> {
    let mut focus = media_focus(scene)?;
    if let Some(view) = scene
        .image_focus
        .as_ref()
        .and_then(|image| image.document_view)
    {
        focus.viewport = view.viewport;
        focus.source_width = view.source_width;
        focus.source_height = view.source_height;
    }
    let node = scene.nodes.iter().find(|node| node.id == focus.node_id)?;
    let size = texture_size(node, Vec2::new(focus.source_width, focus.source_height));
    let center = content_center(node);
    let zoom = (focus.viewport.zoom * focus.source_width / size.x).max(0.00001);
    let surface = scene.surface.as_ref();
    let (cx, cy) = surface
        .map(|surface| {
            surface
                .content_rect
                .as_ref()
                .map(|rect| (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0))
                .unwrap_or((
                    (surface.width - surface.content_right) / 2.0,
                    surface.height / 2.0,
                ))
        })
        .unwrap_or((0.0, 0.0));
    Some((
        cx + focus.viewport.x - center.x * zoom,
        cy + focus.viewport.y - center.y * zoom,
        zoom,
    ))
}

/// 当前素材在背景遮罩之上；背景卡片、标签和边沿用原文档层级。
pub(crate) fn foreground_z(scene: &Scene) -> f32 {
    10.0 + scene.nodes.len() as f32 * 0.1 + 4.0
}

/// 覆盖整张画布的世界空间矩形，跟随同一个媒体聚焦相机。
pub(crate) fn backdrop_rect(scene: &Scene) -> Option<[f32; 4]> {
    presented_media_focus(scene)?;
    let (x, y, zoom) = camera_view(scene)?;
    let surface = scene.surface.as_ref()?;
    Some([
        -x / zoom,
        -y / zoom,
        surface.width / zoom,
        surface.height / zoom,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn focused(kind: &str) -> Scene {
        let mut scene = Scene::default();
        scene.nodes = serde_json::from_value(serde_json::json!([
            {"id":"target", "type":"image", "x":120, "y":80, "width":320, "height":240},
            {"id":"other", "type":"image", "x":700, "y":80, "width":320, "height":240}
        ]))
        .unwrap();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({
                "width":1200, "height":800, "pixelRatio":1,
                "contentRect":{"x":52,"y":140,"width":860,"height":600}
            }))
            .unwrap(),
        );
        let focus = serde_json::json!({"version":format!("woohaa-{kind}-focus-v1"), "nodeId":"target",
            "viewport":{"x":38,"y":-24,"zoom":0.6}, "sourceWidth":1600,"sourceHeight":900});
        if kind == "image" {
            scene.image_focus = Some(serde_json::from_value(focus).unwrap());
        } else {
            scene.video_focus = Some(serde_json::from_value(focus).unwrap());
        }
        scene
    }

    #[test]
    fn presentation_waits_for_entry_completion_without_changing_camera() {
        let mut scene = focused("image");
        assert!(scene.image_focus.as_ref().unwrap().presentation_ready);
        let camera = camera_view(&scene);
        scene.image_focus.as_mut().unwrap().presentation_ready = false;
        assert!(media_focus(&scene).is_some());
        assert_eq!(camera_view(&scene), camera);
        assert!(presented_media_focus(&scene).is_none());
        assert!(!has_presented_media_focus(&scene));
        assert!(backdrop_rect(&scene).is_none());
        scene.image_focus.as_mut().unwrap().presentation_ready = true;
        assert_eq!(presented_media_focus(&scene).unwrap().node_id, "target");
        assert!(has_presented_media_focus(&scene));
        assert!(backdrop_rect(&scene).is_some());
        assert_eq!(camera_view(&scene), camera);
        scene.image_focus = None;
        assert!(presented_media_focus(&scene).is_none());
        assert!(backdrop_rect(&scene).is_none());
    }

    #[test]
    fn document_pan_zoom_moves_the_real_grid_and_background_with_a_fixed_capture_rect() {
        let mut scene = focused("image");
        let frame_viewport = scene.image_focus.as_ref().unwrap().viewport;
        let mut last = None;
        for (x, y, zoom) in [(38.0, -24.0, 0.6), (138.0, 76.0, 0.6), (138.0, 76.0, 1.2)] {
            scene.image_focus.as_mut().unwrap().document_view = Some(
                serde_json::from_value(serde_json::json!({
                    "sourceWidth":1600,"sourceHeight":900,"viewport":{"x":x,"y":y,"zoom":zoom}
                }))
                .unwrap(),
            );
            let camera = camera_view(&scene).unwrap();
            let grid = crate::model3d::grid::scene_view(&scene);
            assert_eq!((grid.x, grid.y, grid.zoom), camera);
            let target = content_center(&scene.nodes[0]);
            assert!((target.x * camera.2 + camera.0 - (482.0 + x)).abs() < 0.001);
            assert!((target.y * camera.2 + camera.1 - (440.0 + y)).abs() < 0.001);
            let other = content_center(&scene.nodes[1]);
            let screen = (other.x * camera.2 + camera.0, other.y * camera.2 + camera.1);
            if let Some(previous) = last {
                assert_ne!(screen, previous);
            }
            last = Some(screen);
            assert_eq!(
                scene.image_focus.as_ref().unwrap().viewport.x,
                frame_viewport.x
            );
        }
    }

    #[test]
    fn grid_and_media_share_view_and_content_center() {
        let scene = focused("image");
        let (x, y, zoom) = camera_view(&scene).unwrap();
        let grid = crate::model3d::grid::scene_view(&scene);
        assert_eq!((grid.x, grid.y, grid.zoom), (x, y, zoom));
        let center = content_center(&scene.nodes[0]);
        assert!((center.x * zoom + x - 520.0).abs() < 0.001);
        assert!((center.y * zoom + y - 416.0).abs() < 0.001);
    }

    #[test]
    fn backdrop_tracks_entire_surface_during_pan_zoom_and_layout_changes() {
        let mut scene = focused("image");
        for (pan, zoom, width) in [
            (38.0, 0.6, 1200.0),
            (-900.0, 0.05, 700.0),
            (1200.0, 12.0, 1800.0),
        ] {
            let focus = scene.image_focus.as_mut().unwrap();
            focus.viewport.x = pan;
            focus.viewport.zoom = zoom;
            scene.surface.as_mut().unwrap().width = width;
            let (vx, vy, scale) = camera_view(&scene).unwrap();
            let [x, y, w, h] = backdrop_rect(&scene).unwrap();
            assert!((x * scale + vx).abs() < 0.001);
            assert!((y * scale + vy).abs() < 0.001);
            assert!(((x + w) * scale + vx - width).abs() < 0.01);
            assert!(((y + h) * scale + vy - 800.0).abs() < 0.01);
        }
    }

    #[test]
    fn image_and_video_use_same_view_and_exit_restores_overview() {
        let mut image = focused("image");
        let video = focused("video");
        assert_eq!(camera_view(&image), camera_view(&video));
        assert_eq!(backdrop_rect(&image), backdrop_rect(&video));
        image.image_focus = None;
        assert!(camera_view(&image).is_none());
        assert!(backdrop_rect(&image).is_none());
        assert_eq!(
            crate::model3d::grid::scene_view(&image),
            crate::model3d::grid::grid_view(&image.viewport)
        );
    }

    #[test]
    fn missing_target_has_no_backdrop_and_foreground_is_above_background() {
        let mut scene = focused("image");
        let last_background_z = 10.0 + scene.nodes.len() as f32 * 0.1 + 2.0;
        assert!(foreground_z(&scene) - 0.1 > last_background_z);
        scene.nodes.clear();
        assert!(backdrop_rect(&scene).is_none());
    }
}
