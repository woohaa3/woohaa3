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

/// 拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）。
///
/// 起点由映射层投影给出（`ShotPreviewLink.start`），终点复用卡片左侧中点
/// （`canvas_query::shot_preview::card_attachment_of`，与卡片命中几何一致）。使用共享边曲线
/// 规则，但画**虚线**（`dashed = true`、与普通边同宽 2.0）：只表达稳定的永久归属而非临时/
/// 草稿关系，虚线也让它与普通边一眼可分（change: 2026-10-28-migrate-film-set-to-groups，
/// 用户要求恢复虚线）。不参与普通边拓扑，因此没有端口、删除按钮、断开或重连命中。目标节点
/// 缺失时跳过该线，绝不伪造终点。`overlay_z` 使线画在普通卡片之上，便于始终看清归属。
pub(super) fn draw_shot_preview_links(
    geometry: &mut Geometry,
    scene: &Scene,
    theme: &ThemeResource,
    layouts: &HashMap<&str, CanvasLayout>,
    overlay_z: f32,
) {
    if scene.shot_preview_links.is_empty() {
        return;
    }
    let color = theme.token_u32("canvasEdgeDefault");
    for link in &scene.shot_preview_links {
        let Some(target) = layouts.get(link.preview_node_id.as_str()) else {
            continue;
        };
        let start = Vec2::new(link.start.x, link.start.y);
        let end = crate::canvas_query::shot_preview::card_attachment(
            target.x,
            target.y,
            target.width,
            target.height,
        );
        geometry.curve(start, end, 2.0, overlay_z, color, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas_query::curve::EDGE_CURVE_SEGMENTS;
    use crate::protocol::{GraphNode, ShotPreviewLink};

    fn preview_card(id: &str) -> GraphNode {
        GraphNode {
            model_preview: None,
            id: id.into(),
            kind: "node".into(),
            x: 400.0,
            y: 200.0,
            width: 240.0,
            height: 140.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            group: None,
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
            shot_preview: None,
        }
    }

    fn link(preview_node_id: &str) -> ShotPreviewLink {
        ShotPreviewLink {
            id: format!("link:film:{preview_node_id}"),
            owner_node_id: "film".into(),
            preview_node_id: preview_node_id.into(),
            clip_id: "clip-1".into(),
            start: crate::protocol::CursorPoint { x: 80.0, y: 60.0 },
        }
    }

    fn draw(links: Vec<ShotPreviewLink>, with_target: bool) -> usize {
        let theme = ThemeResource::default();
        let scene = Scene {
            shot_preview_links: links,
            ..Default::default()
        };
        let target = preview_card("shot-preview:AAAA");
        let mut map: HashMap<&str, CanvasLayout> = HashMap::new();
        if with_target {
            map.insert(target.id.as_str(), CanvasLayout::from_node(&target));
        }
        let mut geometry = Geometry::default();
        draw_shot_preview_links(&mut geometry, &scene, &theme, &map, 20.0);
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            .and_then(|values| values.as_float3())
            .map(|values| values.iter().filter(|p| p[0] > -1.0e5).count())
            .unwrap_or(0)
    }

    /// 归属线是**虚线**：与 group 容器框、框选范围共用「结构/归属而非实体连线」的表达，
    /// 也避免和普通边混淆（change: 2026-10-28-migrate-film-set-to-groups，用户要求恢复虚线）。
    /// 虚线按 10/6 世界单位跳段，顶点数少于实线的「每段一个四边形」。
    #[test]
    fn shot_preview_link_is_dashed() {
        // 短线上虚线的四边形数量可能与固定采样实线恰好相同（每段都只切出一块），
        // 因此用一条明显更长的归属线来区分：虚线按 10/6 世界长度继续切片，几何数量随
        // 长度增长；实线固定 `EDGE_CURVE_SEGMENTS` 段，与长度无关。
        let mut far = link("shot-preview:AAAA");
        far.start = crate::protocol::CursorPoint {
            x: -1200.0,
            y: 900.0,
        };
        let dashed = draw(vec![far], true);
        assert!(dashed > 0, "归属线必须画得出来");
        assert_eq!(dashed % 4, 0, "每个绘制的子段仍是 4 顶点四边形");
        assert_ne!(
            dashed,
            EDGE_CURVE_SEGMENTS * 4,
            "归属线必须是虚线而不是实线"
        );
        assert!(
            draw(vec![link("shot-preview:AAAA")], true) > 0,
            "短线上同样要画出来"
        );
    }

    /// 目标卡片缺失时跳过该线，绝不伪造终点。
    #[test]
    fn shot_preview_link_skips_missing_target() {
        assert_eq!(draw(vec![link("shot-preview:MISSING")], true), 0);
    }

    /// 无归属线时不产生任何几何。
    #[test]
    fn shot_preview_links_empty_draws_nothing() {
        assert_eq!(draw(vec![], true), 0);
    }
}
