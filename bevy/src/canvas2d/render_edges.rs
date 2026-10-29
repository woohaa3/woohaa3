//! 2D 边线与草稿线的 overlay 绘制
//! （change: refactor-bevy-rust-file-size；合并 change: 2026-10-08-add-image-focus-editing-and-unified-node-history
//! 后 `render.rs` 超过文件体积守卫，抽出本模块）。
//!
//! 职责边界：绘制所有已连接边、边标签、悬停删除按钮与拖拽草稿线，并回收上一帧的边标签实体。
//! 不触碰节点卡片、group/片场范围或标签池——那些仍由 `render.rs` 负责。命中几何仍归 Rust
//! interaction state，本模块只被动消费 web 投影。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::canvas_ecs::components::CanvasLayout;
use crate::protocol::{Edge, Scene};
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::layout::{
    EDGE_DELETE_BUTTON_SIZE, EDGE_LABEL_FONT, EDGE_LABEL_HEIGHT, edge_delete_center,
    edge_label_text, edge_label_width,
};
use super::labels::Label;

/// Draw one retained document-order block; labels belong to that block's lifetime.
#[allow(clippy::too_many_arguments)]
pub(super) fn draw_block(
    edges: &[Edge],
    layouts: &HashMap<&str, CanvasLayout>,
    scene: &Scene,
    theme: &ThemeResource,
    geometry: &mut Geometry,
    overlay_z: f32,
    depth_offset: f32,
) -> Vec<Label> {
    let mut labels = Vec::new();
    for edge in edges {
        if let (Some(source), Some(target)) = (
            layouts.get(edge.source.as_str()),
            layouts.get(edge.target.as_str()),
        ) {
            let selected = scene.selection.edge.as_ref() == Some(&edge.id);
            geometry.curve(
                source.port(true),
                target.port(false),
                if selected { 3.0 } else { 2.0 },
                1.0 + depth_offset,
                if selected {
                    theme.token_u32("canvasEdgeSelected")
                } else {
                    theme.token_u32("canvasEdgeDefault")
                },
                false,
            );
            let mid = (source.port(true) + target.port(false)) / 2.;
            let label_width = edge_label_width(&edge.label);
            if label_width > 0.0 {
                geometry.rounded_rect(
                    mid.x - label_width / 2.0,
                    mid.y - EDGE_LABEL_HEIGHT / 2.0,
                    label_width,
                    EDGE_LABEL_HEIGHT,
                    4.,
                    2. + depth_offset,
                    theme.token_u32("canvasEdgeLabelBackground"),
                );
                labels.push((
                    edge_label_text(&edge.label),
                    mid,
                    EDGE_LABEL_FONT,
                    theme.token_u32("canvasEdgeLabelText"),
                ));
            }
            // 悬停该连线时显示删除按钮（change: add-edge-hover-delete）。
            // 位置与 JS 命中测试共用 contracts.`bevyEdgeDeleteRect` 的同一公式与常量：
            // 无标签时居中于连线中点，有标签时排在**按内容收缩**的标签胶囊右侧，避免盖住标签，
            // 也避免固定 104px 宽度把按钮推到远离曲线的地方（修复：标签过宽导致删除按钮点不到）。
            // 颜色取自既有主题 token（不新增 token、不升主题 schema）。
            if scene
                .hover
                .as_ref()
                .is_some_and(|hover| hover.edge_id.as_deref() == Some(edge.id.as_str()))
            {
                let center =
                    edge_delete_center(source.port(true), target.port(false), label_width);
                let radius = EDGE_DELETE_BUTTON_SIZE / 2.0;
                let accent = theme.token_u32("canvasEdgeSelected");
                // 圆面 + 描边环 + 叉号；z 高于所有卡片与标签，保证可点。
                geometry.circle(
                    center,
                    radius,
                    overlay_z + depth_offset,
                    theme.token_u32("canvasNodeSurface"),
                    20,
                );
                geometry.ring(
                    center,
                    radius - 1.0,
                    1.6,
                    overlay_z + depth_offset + 0.01,
                    accent,
                    20,
                );
                let arm = Vec2::splat(3.2);
                geometry.line(
                    center - arm,
                    center + arm,
                    1.8,
                    overlay_z + depth_offset + 0.02,
                    accent,
                );
                geometry.line(
                    center + Vec2::new(-arm.x, arm.y),
                    center + Vec2::new(arm.x, -arm.y),
                    1.8,
                    overlay_z + depth_offset + 0.02,
                    accent,
                );
            }
        }
    }
    labels
}

pub(super) fn draw_draft(
    geometry: &mut Geometry,
    scene: &Scene,
    theme: &ThemeResource,
    layouts: &HashMap<&str, CanvasLayout>,
) {
    if let Some(draft) = &scene.draft {
        if let Some(source) = layouts.get(draft.source.as_str()) {
            let cursor = Vec2::new(draft.x, draft.y);
            let (a, b) = if draft.side == "output" {
                (source.port(true), cursor)
            } else {
                (cursor, source.port(false))
            };
            geometry.curve(a, b, 2.2, 2.0, theme.token_u32("canvasEdgeDraft"), true);
        }
    }
}
