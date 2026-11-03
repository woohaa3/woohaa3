//! 多选聚合拉线把手的 2D overlay 绘制
//! （change: add-multi-select-aggregate-connect，design D5）。
//!
//! Web 控制器把选区左右聚合把手与拖拽状态投影到 `CanvasRenderScene.aggregateConnect`；
//! 本模块只**被动**消费该语义投影，绘制选区左右把手、活动方向强调与拖拽虚线预览。
//! 它不执行碰撞、不展开成员、不分配 edge id、不提交命令。
//!
//! 抽出独立模块的理由：`render.rs` 接近文件体积上限（`tests/file_size.rs` 守卫），
//! 且把手 overlay 的绘制来源（`aggregateConnect` 字段）与节点卡片不同。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::protocol::{AggregateConnect, GraphNode};
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::layout::{hex, port};

#[cfg(test)]
use crate::canvas_query::aggregate::AGGREGATE_HANDLE_GAP;
use crate::canvas_query::aggregate::{AGGREGATE_HANDLE_RADIUS, aggregate_handle, selection_bounds_iter};

/// 多选选区背景带的 z：低于所有卡片（卡片 z = 10.0 + index*0.1），高于边。
pub(crate) const SELECTION_BAND_Z: f32 = 1.0;

/// 待提交连线预览线宽。
const PENDING_EDGE_WIDTH: f32 = 2.0;
/// 拖拽中「把手 → 指针」草稿线线宽。
const DRAFT_EDGE_WIDTH: f32 = 2.2;
/// 选区背景圆角半径与描边宽度。
const BAND_RADIUS: f32 = 10.0;
const BAND_BORDER: f32 = 1.5;
/// 选区背景填充 alpha：轻微层次暗示，不遮挡成员卡片。
const BAND_FILL_ALPHA: f32 = 0.08;

/// 在共享几何里追加多选聚合**选区背景带**（半透明底 + 虚线框）。
///
/// 绘制在成员卡片**之下**（低 z，由调用方在节点循环前调用），让多选范围像「打组」一样成为
/// 一个临时容器；聚合把手与拖拽预览则绘制在卡片之上（`draw_aggregate_connect`）。
pub(crate) fn draw_aggregate_selection_band(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    nodes: &[&GraphNode],
    selected: &[String],
    z: f32,
) {
    let Some(bounds) = selection_bounds_iter(nodes.iter().copied(), selected) else {
        return;
    };
    let [x, y, width, height] = bounds;
    geometry.rounded_rect_alpha(
        x,
        y,
        width,
        height,
        BAND_RADIUS,
        z,
        theme.token_u32("canvasNodeSelectedHalo"),
        BAND_FILL_ALPHA,
    );
    super::dash::dashed_rounded_rect(
        geometry,
        x,
        y,
        width,
        height,
        BAND_RADIUS,
        BAND_BORDER,
        z + 0.001,
        theme.token_u32("canvasNodeBorderSelected"),
    );
}

/// 在共享几何里追加聚合把手 overlay。
///
/// `base_z` 由调用方按节点数量给出，保证 overlay 高于所有节点卡片、又低于框选（500）。
pub(crate) fn draw_aggregate_connect(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    nodes: &[&GraphNode],
    aggregate: &AggregateConnect,
    selected: &[String],
    base_z: f32,
) {
    let node_map: HashMap<&str, &GraphNode> = nodes
        .iter()
        .copied()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let Some(bounds) = selection_bounds_iter(nodes.iter().copied(), selected) else {
        return;
    };
    let accent = theme.token_u32("interactionAccent");
    let idle = theme.token_u32("canvasPortDefault");
    let fill = theme.token_u32("canvasPortFill");
    let draft = theme.token_u32("canvasEdgeDraft");
    let active = aggregate.direction.as_deref();

    // 左右把手：圆面 + 环；活动方向用强调色。
    for (side, output) in [("input", false), ("output", true)] {
        let (x, y) = aggregate_handle(bounds, output);
        let ring = if active == Some(side) { accent } else { idle };
        geometry.circle(Vec2::new(x, y), AGGREGATE_HANDLE_RADIUS, base_z, fill, 20);
        geometry.ring(
            Vec2::new(x, y),
            AGGREGATE_HANDLE_RADIUS - 1.0,
            2.0,
            base_z + 0.001,
            ring,
            20,
        );
        // 把手内小圆点表示「聚合端点」。
        geometry.circle(Vec2::new(x, y), 2.6, base_z + 0.002, ring, 16);
    }

    // 拖拽草稿：从活动把手到指针的虚线曲线（与单节点拉线一致的即时反馈）。
    if let (Some(direction), Some(cursor)) = (active, aggregate.cursor) {
        let (hx, hy) = aggregate_handle(bounds, direction == "output");
        geometry.curve(
            Vec2::new(hx, hy),
            Vec2::new(cursor.x, cursor.y),
            DRAFT_EDGE_WIDTH,
            base_z + 0.003,
            draft,
            true,
        );
    }

    // 拖拽预览：从活动把手出发，为每条待提交边画虚线曲线（成员端口 -> 目标端口）。
    for edge in &aggregate.pending_edges {
        if let (Some(source), Some(target)) = (
            node_map.get(edge.source.as_str()),
            node_map.get(edge.target.as_str()),
        ) {
            geometry.curve(
                port(source, true),
                port(target, false),
                PENDING_EDGE_WIDTH,
                base_z + 0.004,
                draft,
                true,
            );
        }
    }
}

/// 供测试/调试：把 `0xRRGGBB` 转成 Bevy 颜色。
#[allow(dead_code)]
pub(crate) fn handle_color(value: u32) -> Color {
    hex(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, x: f32, y: f32, width: f32, height: f32) -> GraphNode {
        GraphNode {
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            model_preview: None,
            ghost: false,
            card_label: None,
            id: id.into(),
            kind: "image".into(),
            x,
            y,
            width,
            height,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            model: None,
            history_strip: None,
        }
    }

    fn refs(nodes: &[GraphNode]) -> Vec<&GraphNode> {
        nodes.iter().collect()
    }

    fn positions(geometry: Geometry) -> usize {
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            .expect("positions")
            .as_float3()
            .expect("float3 positions")
            .iter()
            .filter(|p| p[0] > -1.0e5)
            .count()
    }

    #[test]
    fn handles_draw_when_selection_present() {
        let theme = ThemeResource::default();
        let nodes = vec![
            node("a", 0.0, 0.0, 200.0, 100.0),
            node("b", 400.0, 0.0, 200.0, 100.0),
        ];
        let selected = vec!["a".to_owned(), "b".to_owned()];
        let aggregate = AggregateConnect {
            direction: None,
            cursor: None,
            pending_edges: vec![],
        };
        let mut geometry = Geometry::default();
        draw_aggregate_connect(&mut geometry, &theme, &refs(&nodes), &aggregate, &selected, 100.0);
        // 两个把手：各为圆面 + 环 + 圆点。
        assert!(positions(geometry) > 60);
    }

    #[test]
    fn empty_selection_draws_nothing() {
        let theme = ThemeResource::default();
        let nodes = vec![node("a", 0.0, 0.0, 200.0, 100.0)];
        let aggregate = AggregateConnect {
            direction: None,
            cursor: None,
            pending_edges: vec![],
        };
        let mut geometry = Geometry::default();
        draw_aggregate_connect(&mut geometry, &theme, &refs(&nodes), &aggregate, &[], 100.0);
        assert_eq!(positions(geometry), 0);
    }

    #[test]
    fn pending_edges_draw_dashed_previews() {
        use crate::protocol::DragAttachEdge;
        let theme = ThemeResource::default();
        let nodes = vec![
            node("a", 0.0, 0.0, 200.0, 100.0),
            node("b", 600.0, 0.0, 200.0, 100.0),
        ];
        let aggregate = AggregateConnect {
            direction: Some("output".into()),
            cursor: Some(crate::protocol::CursorPoint { x: 10.0, y: 10.0 }),
            pending_edges: vec![DragAttachEdge {
                id: "e1".into(),
                source: "a".into(),
                target: "b".into(),
            }],
        };
        let mut geometry = Geometry::default();
        draw_aggregate_connect(
            &mut geometry,
            &theme,
            &refs(&nodes),
            &aggregate,
            &["a".to_owned()],
            100.0,
        );
        // 虚线曲线由多段短线组成，顶点数远高于两个把手。
        assert!(positions(geometry) > 200);
    }

    #[test]
    fn dragging_draws_handle_to_cursor_draft() {
        let theme = ThemeResource::default();
        let nodes = vec![
            node("a", 0.0, 0.0, 200.0, 100.0),
            node("b", 400.0, 0.0, 200.0, 100.0),
        ];
        let idle = AggregateConnect {
            direction: None,
            cursor: None,
            pending_edges: vec![],
        };
        let dragging = AggregateConnect {
            direction: Some("output".into()),
            cursor: Some(crate::protocol::CursorPoint { x: 700.0, y: 300.0 }),
            pending_edges: vec![],
        };
        let mut with_draft = Geometry::default();
        draw_aggregate_connect(
            &mut with_draft,
            &theme,
            &refs(&nodes),
            &dragging,
            &["a".to_owned()],
            100.0,
        );
        let mut without = Geometry::default();
        draw_aggregate_connect(
            &mut without,
            &theme,
            &refs(&nodes),
            &idle,
            &["a".to_owned()],
            100.0,
        );
        // 拖拽草稿虚线显著增加几何。
        assert!(positions(with_draft) > positions(without) + 100);
    }

    #[test]
    fn selection_band_draws_translucent_background() {
        let theme = ThemeResource::default();
        let nodes = vec![
            node("a", 0.0, 0.0, 200.0, 100.0),
            node("b", 400.0, 0.0, 200.0, 100.0),
        ];
        let mut geometry = Geometry::default();
        draw_aggregate_selection_band(
            &mut geometry,
            &theme,
            &refs(&nodes),
            &["a".to_owned(), "b".to_owned()],
            1.0,
        );
        // 半透明底 + 虚线框，几何量明显多于单条矩形。
        assert!(positions(geometry) > 40);
        // 空选区不绘制。
        let mut empty = Geometry::default();
        draw_aggregate_selection_band(&mut empty, &theme, &refs(&nodes), &[], 1.0);
        assert_eq!(positions(empty), 0);
    }

    #[test]
    fn handle_geometry_matches_sides() {
        let bounds = [100.0, 50.0, 200.0, 80.0];
        // 输入在左中、输出在右中，各外移固定间隙。
        assert_eq!(
            aggregate_handle(bounds, false),
            (100.0 - AGGREGATE_HANDLE_GAP, 90.0)
        );
        assert_eq!(
            aggregate_handle(bounds, true),
            (300.0 + AGGREGATE_HANDLE_GAP, 90.0)
        );
    }
}
