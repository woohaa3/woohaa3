//! 图片聚焦的 2D 可见性与取景
//! （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2/4.3 / design D2）。
//!
//! Web 投影聚焦图片 id、源像素取景和共享内容矩形。图片保持原节点世界位置与尺寸，
//! 同一 Camera2d 根据取景推进，透明标注层使用相同的 image-to-screen 变换，
//! 其它节点和网格保留在背景遮罩下；不创建第二个 renderer，不写画布命令。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫）。

use bevy::prelude::*;

use super::layout::{content_center, texture_size};
use crate::protocol::{GraphNode, Scene};

use crate::canvas_query::media_focus::foreground_z;
pub(crate) use crate::canvas_query::media_focus::{camera_view, has_presented_media_focus, media_focus, presented_media_focus};

/// 新上传纹理的 Sprite 布局（wasm texture-sync 在聚焦期间也要正确摆放）。
///
/// 返回 `(显示尺寸, 画布中心, 颜色, z)`：当前素材在遮罩上，其他纹理保持原层级。
pub(crate) fn sprite_layout(
    scene: &Scene,
    node: &GraphNode,
    texture_px: Vec2,
    index: usize,
) -> (Vec2, Vec2, Color, f32) {
    if let Some(focus) = media_focus(scene) {
        if focus.node_id == node.id {
            if scene.image_focus.as_ref().is_some_and(|image| image.document_view.is_some()) {
                if let (Some((vx, vy, zoom)), Some(surface)) = (camera_view(scene), scene.surface.as_ref()) {
                    let (cx, cy) = surface.content_rect.as_ref()
                        .map(|rect| (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0))
                        .unwrap_or(((surface.width - surface.content_right) / 2.0, surface.height / 2.0));
                    return (
                        Vec2::new(focus.source_width, focus.source_height) * focus.viewport.zoom / zoom,
                        Vec2::new(cx + focus.viewport.x - vx, cy + focus.viewport.y - vy) / zoom,
                        Color::WHITE,
                        if has_presented_media_focus(scene) { foreground_z(scene) } else { 10.01 + index as f32 * 0.1 },
                    );
                }
            }
            return (
                texture_size(node, Vec2::new(focus.source_width, focus.source_height)),
                content_center(node),
                Color::WHITE,
                if has_presented_media_focus(scene) { foreground_z(scene) } else { 10.01 + index as f32 * 0.1 },
            );
        }
    }
    let color = if node.busy { Color::NONE } else { Color::WHITE };
    (
        texture_size(node, texture_px),
        content_center(node),
        color,
        10.01 + index as f32 * 0.1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_viewport_stays_on_screen_while_document_camera_pans_and_zooms() {
        let mut scene = Scene::default();
        scene.nodes = serde_json::from_value(serde_json::json!([
            {"id":"target","type":"image","x":120,"y":80,"width":320,"height":240}
        ])).unwrap();
        scene.surface = Some(serde_json::from_value(serde_json::json!({"width":1200,"height":800,
            "pixelRatio":2,"contentRect":{"x":52,"y":140,"width":860,"height":600}})).unwrap());
        scene.image_focus = Some(serde_json::from_value(serde_json::json!({"version":"woohaa-image-focus-v1",
            "nodeId":"target","sourceWidth":2000,"sourceHeight":1200,
            "viewport":{"x":20,"y":-30,"zoom":0.5}})).unwrap());
        for (x, zoom) in [(0.0, 0.4), (150.0, 0.4), (-30.0, 1.2)] {
            scene.image_focus.as_mut().unwrap().document_view = Some(serde_json::from_value(serde_json::json!({
                "sourceWidth":4000,"sourceHeight":3000,"viewport":{"x":x,"y":10,"zoom":zoom}
            })).unwrap());
            let (size, center, _, _) = sprite_layout(&scene, &scene.nodes[0], Vec2::new(2000.0,1200.0), 0);
            let (vx, vy, scale) = camera_view(&scene).unwrap();
            assert!((center.x * scale + vx - 502.0).abs() < 0.001);
            assert!((center.y * scale + vy - 410.0).abs() < 0.001);
            assert!((size.x * scale - 1000.0).abs() < 0.001);
            assert!((size.y * scale - 600.0).abs() < 0.001);
        }
    }
}
