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
