//! 2D 边线与草稿线的 overlay 绘制
//! （change: refactor-bevy-rust-file-size；合并 change: 2026-10-08-add-image-focus-editing-and-unified-node-history
//! 后 `render.rs` 超过文件体积守卫，抽出本模块）。
//!
//! 职责边界：绘制所有已连接边、边标签、悬停删除按钮与拖拽草稿线，并回收上一帧的边标签实体。
//! 不触碰节点卡片、group/片场范围或标签池——那些仍由 `render.rs` 负责。命中几何仍归 Rust
//! interaction state，本模块只被动消费 web 投影。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::protocol::{Edge, GraphNode, Scene};
use crate::theme::ThemeResource;

use super::Visuals;
use super::geometry::Geometry;
use super::layout::{
    EDGE_DELETE_BUTTON_GAP, EDGE_DELETE_BUTTON_SIZE, EDGE_LABEL_HEIGHT, EDGE_LABEL_WIDTH, hex,
    port, shortened,
};

/// 绘制全部边、边标签、悬停删除按钮与草稿线。
///
/// 返回的 `overlay_z` 供 `render.rs` 继续摆放更上层的粘连操作条等 overlay。
pub(crate) fn sync_edges(
    commands: &mut Commands,
    scene: &Scene,
    theme: &ThemeResource,
    visuals: &mut Visuals,
    meshes: &mut Assets<Mesh>,
) -> (f32, u64) {
    let node_map: HashMap<&str, &GraphNode> =
        scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // 连线删除按钮高于所有节点卡片（卡片 z = 10.0 + index*0.1），与命中测试「按钮优先于节点」
    // 保持一致（change: add-edge-hover-delete）。
    let overlay_z = 10.0 + scene.nodes.len() as f32 * 0.1 + 1.5;
    let rebuilt = super::edge_cache::sync(
        commands, meshes, visuals, scene, theme, &node_map, overlay_z,
    );
    (overlay_z, rebuilt)
}

/// Draw one retained document-order block; labels belong to that block's lifetime.
#[allow(clippy::too_many_arguments)]
pub(super) fn draw_block(
    commands: &mut Commands,
    edges: &[Edge],
    node_map: &HashMap<&str, &GraphNode>,
    scene: &Scene,
    theme: &ThemeResource,
    font: &Handle<Font>,
    geometry: &mut Geometry,
    overlay_z: f32,
    depth_offset: f32,
) -> Vec<Entity> {
    let mut labels = Vec::new();
    for edge in edges {
        if let (Some(source), Some(target)) = (
            node_map.get(edge.source.as_str()),
            node_map.get(edge.target.as_str()),
        ) {
            let selected = scene.selection.edge.as_ref() == Some(&edge.id);
            geometry.curve(
                port(source, true),
                port(target, false),
                if selected { 3.0 } else { 2.0 },
                1.0 + depth_offset,
                if selected {
                    theme.token_u32("canvasEdgeSelected")
                } else {
                    theme.token_u32("canvasEdgeDefault")
                },
                false,
            );
            if !edge.label.is_empty() {
                let center = (port(source, true) + port(target, false)) / 2.;
                geometry.rounded_rect(
                    center.x - EDGE_LABEL_WIDTH / 2.0,
                    center.y - EDGE_LABEL_HEIGHT / 2.0,
                    EDGE_LABEL_WIDTH,
                    EDGE_LABEL_HEIGHT,
                    4.,
                    2. + depth_offset,
                    theme.token_u32("canvasEdgeLabelBackground"),
                );
                let entity = commands
                    .spawn((
                        Text2d::new(shortened(&edge.label, 96., 11.)),
                        TextFont {
                            font: font.clone().into(),
                            font_size: FontSize::Px(11.),
                            ..default()
                        },
                        TextColor(hex(theme.token_u32("canvasEdgeLabelText"))),
                        Transform::from_xyz(center.x, -center.y, 2.1 + depth_offset),
                    ))
                    .id();
                labels.push(entity);
            }
            // 悬停该连线时显示删除按钮（change: add-edge-hover-delete）。
            // 位置与 JS 命中测试共用 contracts.`bevyEdgeDeleteRect` 的同一公式与常量：
            // 无标签时居中于连线中点，有标签时排在标签胶囊右侧，避免盖住标签。
            // 颜色取自既有主题 token（不新增 token、不升主题 schema）。
            if scene
                .hover
                .as_ref()
                .is_some_and(|hover| hover.edge_id.as_deref() == Some(edge.id.as_str()))
            {
                let mid = (port(source, true) + port(target, false)) / 2.;
                let center = if edge.label.is_empty() {
                    mid
                } else {
                    Vec2::new(
                        mid.x
                            + EDGE_LABEL_WIDTH / 2.0
                            + EDGE_DELETE_BUTTON_GAP
                            + EDGE_DELETE_BUTTON_SIZE / 2.0,
                        mid.y,
                    )
                };
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
    node_map: &HashMap<&str, &GraphNode>,
) {
    if let Some(draft) = &scene.draft {
        if let Some(source) = node_map.get(draft.source.as_str()) {
            let cursor = Vec2::new(draft.x, draft.y);
            let (a, b) = if draft.side == "output" {
                (port(source, true), cursor)
            } else {
                (cursor, port(source, false))
            };
            geometry.curve(a, b, 2.2, 2.0, theme.token_u32("canvasEdgeDraft"), true);
        }
    }
}

/// 拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）。
///
/// 起点由映射层投影给出（`ShotPreviewLink.start`），终点复用卡片左侧中点
/// （`canvas_query::shot_preview::card_attachment_of`，与卡片命中几何一致）。使用共享边曲线
/// 规则，并与普通边一致画**实线**（`dashed = false`、同宽度 2.0），只表达稳定的永久归属而非
/// 临时/草稿关系；不参与普通边拓扑，因此没有端口、删除按钮、断开或重连命中。目标节点缺失时
/// 跳过该线，绝不伪造终点。`overlay_z` 使线画在普通卡片之上，便于始终看清归属。
pub(super) fn draw_shot_preview_links(
    geometry: &mut Geometry,
    scene: &Scene,
    theme: &ThemeResource,
    node_map: &HashMap<&str, &GraphNode>,
    overlay_z: f32,
) {
    if scene.shot_preview_links.is_empty() {
        return;
    }
    let color = theme.token_u32("canvasEdgeDefault");
    for link in &scene.shot_preview_links {
        let Some(target) = node_map.get(link.preview_node_id.as_str()) else {
            continue;
        };
        let start = Vec2::new(link.start.x, link.start.y);
        let end = crate::canvas_query::shot_preview::card_attachment_of(target);
        geometry.curve(start, end, 2.0, overlay_z, color, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas_query::curve::EDGE_CURVE_SEGMENTS;
    use crate::protocol::ShotPreviewLink;

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
        let mut map: HashMap<&str, &GraphNode> = HashMap::new();
        if with_target {
            map.insert(target.id.as_str(), &target);
        }
        let mut geometry = Geometry::default();
        draw_shot_preview_links(&mut geometry, &scene, &theme, &map, 20.0);
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            .and_then(|values| values.as_float3())
            .map(|values| values.iter().filter(|p| p[0] > -1.0e5).count())
            .unwrap_or(0)
    }

    /// 归属线是**实线**：与普通边一致，是一条连续折线（每段一个四边形 = 4 顶点），
    /// 而不是虚线（虚线会按 `i % 6` 跳段，顶点数更少）。这条回归钉住「实线而非虚线」。
    #[test]
    fn shot_preview_link_is_solid_not_dashed() {
        let solid = draw(vec![link("shot-preview:AAAA")], true);
        assert_eq!(solid, EDGE_CURVE_SEGMENTS * 4, "实线每段 4 顶点，无跳段");
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
