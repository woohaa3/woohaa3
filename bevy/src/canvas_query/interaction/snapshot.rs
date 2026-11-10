//! 2D interaction snapshot：可丢弃的派生几何与点/框选/probe 命中逻辑
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.3-2.5 / design D2）。
//!
//! 快照只含可由当前 `Scene` 重建的几何（节点画布矩形、端口、控件矩形、预采样边折线与
//! broad-phase AABB），不含命令、Yjs、任务或持久化事实。全部几何由 `super::curve` /
//! `super::layout` 的共享纯函数派生，保证与绘制一致。

use bevy::prelude::*;

use crate::canvas_query::aggregate::{aggregate_handle, selection_bounds};
use crate::canvas_query::{curve, grip::ResizeGrip, layout};
use crate::protocol::{GraphNode, Scene};

use super::results::{PointHit, ProbeCandidate};
use super::spatial::SpatialGrid;

/// 空间网格 cell 边长（世界单位）。
///
/// 取固定卡片量级：太小会让大卡片跨很多 cell，太大则退化为全量候选。位置增量只搬动
/// 真正移动的对象，因此该值不需要随 zoom 变化（design D7 / 任务 7.3）。
const SPATIAL_CELL_SIZE: f32 = 256.0;

/// 快照中的单个节点几何。
#[derive(Clone)]
pub(super) struct SnapshotNode {
    pub(super) initial_position: Vec2,
    pub(super) layout_bounds: (f32, f32, f32, f32),
    pub(super) id: String,
    pub(super) ghost: bool,
    /// 粗筛用外接矩形（节点矩形）。
    pub(super) bounds: (f32, f32, f32, f32),
    pub(super) center: Vec2,
    pub(super) input_port: Option<Vec2>,
    pub(super) output_port: Option<Vec2>,
    /// 底部历史条命中矩形（change: 2026-10-12-unify-generation-history-strip）。
    pub(super) history_strip: Option<(f32, f32, f32, f32)>,
    /// 选中时显示的四角 resize 抓手。
    pub(super) resize: Option<[ResizeGrip; 4]>,
    pub(super) resizable: bool,
    /// `chrome.kind == "none"` 的世界模型没有内容卡片：不再保留卡片矩形、端口、
    /// 历史条与选中抓手的命中（change: shared-world 直接地面拖动）。
    pub(super) card: bool,
    /// Frames have a transparent interior for point queries; drop/marquee keep their bounds.
    pub(super) frame: bool,
    /// 顶部操作横条世界几何（change: 2026-10-13-add-node-to-film-set-shortcut）；无横条为 `None`。
    pub(super) node_actions: Option<layout::NodeActionLayout>,
}

/// 快照中的单条边：预采样折线 + broad-phase AABB + 删除按钮几何。
pub(super) struct SnapshotEdge {
    pub(super) id: String,
    pub(super) source: usize,
    pub(super) target: usize,
    pub(super) source_port: Vec2,
    pub(super) target_port: Vec2,
    /// 标签胶囊宽度（世界坐标）；0 表示无标签。
    pub(super) label_width: f32,
    pub(super) points: Vec<Vec2>,
    pub(super) aabb: ([f32; 2], [f32; 2]),
}

/// 可丢弃的 2D interaction snapshot；与 render scene 在同一接受点发布。
pub(crate) struct InteractionSnapshot {
    /// 单调 interaction generation；仅在接受合法场景时递增。
    pub(crate) generation: u32,
    /// 是否为普通 overview 画布（非模型聚焦/图片聚焦）。纯视口增量只在 overview 下接受
    /// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
    pub(crate) overview: bool,
    pub(super) nodes: Vec<SnapshotNode>,
    pub(super) edges: Vec<SnapshotEdge>,
    /// 导演区边框胶囊的命中几何（Bevy 2D）：画在 3D 线框上，点它选中导演区。
    pub(super) scene_area_labels: Vec<layout::SceneAreaLabelGeometry>,
    pub(super) scene_area_players: Vec<layout::SceneAreaLabelGeometry>,
    pub(super) scope_areas: Vec<crate::protocol::SceneArea>,
    pub(super) scope_frames: Vec<usize>,
    /// 点命中顺序：按发射序列倒序（最上层先）。
    pub(super) order: Vec<usize>,
    /// 两个把手只在合法 scene 投影声明可见时存在（冷路径生成）。
    pub(super) aggregate_handles: Option<[(String, Vec2); 2]>,
    pub(super) aggregate_selection: Vec<usize>,
    pub(super) node_index: std::collections::HashMap<String, usize>,
    pub(super) adjacency: Vec<Vec<usize>>,
    /// 仅保留有横条的节点，视口增量不重建节点/边的世界几何。
    pub(super) action_descriptors: Vec<(usize, crate::protocol::NodeActions)>,
    /// 节点 AABB 空间网格：点/框选/drop/probe 先取候选再细判（design D7 / 任务 7.3）。
    pub(super) node_grid: SpatialGrid,
    /// 边折线 AABB 空间网格（边命中先粗筛，再逐段距离）。
    pub(super) edge_grid: SpatialGrid,
    /// `nodes` 下标 → 点命中优先级（`order` 中的位置；不在 `order` 里为 `u32::MAX`）。
    pub(super) order_rank: Vec<u32>,
    pub(super) viewport: (f32, f32, f32),
    pub(super) surface: Option<(f32, f32)>,
    pub(super) hover: Option<crate::protocol::NodeHover>,
    pub(super) selected_edge: Option<String>,
}

/// 节点参与空间候选的外接矩形。
pub(super) fn node_bounds(node: &SnapshotNode) -> (f32, f32, f32, f32) {
    node.bounds
}

/// 合并两个矩形。
fn union(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32)) -> (f32, f32, f32, f32) {
    let left = a.0.min(b.0);
    let top = a.1.min(b.1);
    let right = (a.0 + a.2).max(b.0 + b.2);
    let bottom = (a.1 + a.3).max(b.1 + b.3);
    (left, top, right - left, bottom - top)
}

/// 点命中可触及的节点范围：节点几何 + 屏幕固定的操作横条。
///
/// 横条按屏幕像素排版后换算回世界坐标，可能明显超出节点矩形（甚至在视口边缘被夹住），
/// 因此它必须计入空间候选，否则「画在哪、点在哪」会出现命不中的回归（design D7 / 任务 7.3）。
pub(super) fn node_hit_bounds(node: &SnapshotNode) -> (f32, f32, f32, f32) {
    let mut rect = node_bounds(node);
    if let Some(actions) = &node.node_actions {
        rect = union(rect, actions.bar);
    }
    rect
}

/// 重建节点网格（只在完整场景接受点调用；位置增量用 `relocate`）。
fn build_node_grid(nodes: &[SnapshotNode]) -> SpatialGrid {
    let mut grid = SpatialGrid::new(SPATIAL_CELL_SIZE);
    for (index, node) in nodes.iter().enumerate() {
        grid.insert(index, node_hit_bounds(node));
    }
    grid
}

/// 重建边网格；`aabb` 为 `([min_x, min_y], [max_x, max_y])`。
fn build_edge_grid(edges: &[SnapshotEdge]) -> SpatialGrid {
    let mut grid = SpatialGrid::new(SPATIAL_CELL_SIZE);
    for (index, edge) in edges.iter().enumerate() {
        grid.insert(index, edge_bounds(edge));
    }
    grid
}

pub(super) fn edge_bounds(edge: &SnapshotEdge) -> (f32, f32, f32, f32) {
    (
        edge.aabb.0[0],
        edge.aabb.0[1],
        edge.aabb.1[0] - edge.aabb.0[0],
        edge.aabb.1[1] - edge.aabb.0[1],
    )
}

/// 点命中优先级索引：`order` 中的位置，未列出为 `u32::MAX`。
fn build_order_rank(order: &[usize], nodes: usize) -> Vec<u32> {
    let mut rank = vec![u32::MAX; nodes];
    for (position, index) in order.iter().enumerate() {
        rank[*index] = position as u32;
    }
    rank
}

/// 按点命中优先级排序候选（同 `order` 语义：靠前者优先）。
fn sort_by_order_rank(candidates: &mut [usize], rank: &[u32]) {
    candidates.sort_by_key(|index| rank.get(*index).copied().unwrap_or(u32::MAX));
}

/// 构建快照：所有几何由共享纯函数派生，与绘制一致。
pub(crate) fn build_snapshot(scene: &Scene, generation: u32) -> InteractionSnapshot {
    let node_map: std::collections::HashMap<&str, &GraphNode> =
        scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let node_index: std::collections::HashMap<String, usize> = scene
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();
    let viewport = (scene.viewport.x, scene.viewport.y, scene.viewport.zoom);
    let nodes: Vec<SnapshotNode> = scene
        .nodes
        .iter()
        .map(|node| snapshot_node(node, &scene.node_actions, viewport, scene.surface.as_ref()))
        .collect();
    let edges: Vec<SnapshotEdge> = scene
        .edges
        .iter()
        .filter_map(|edge| {
            let source = node_map.get(edge.source.as_str())?;
            let target = node_map.get(edge.target.as_str())?;
            let a = layout::port(source, true);
            let b = layout::port(target, false);
            Some(super::positions::edge_geometry(
                edge.id.clone(),
                node_index[&edge.source],
                node_index[&edge.target],
                layout::edge_label_width(&edge.label),
                a,
                b,
            ))
        })
        .collect();

    // 命中顺序：按发射序列倒序，最上层（最后绘制）优先。
    let order: Vec<usize> = (0..nodes.len()).rev().collect();

    let mut adjacency = vec![Vec::new(); nodes.len()];
    for (i, edge) in edges.iter().enumerate() {
        adjacency[edge.source].push(i);
        if edge.target != edge.source {
            adjacency[edge.target].push(i);
        }
    }
    let aggregate_selection = if scene.aggregate_connect.is_some() {
        scene
            .selection
            .nodes
            .iter()
            .filter_map(|id| node_index.get(id).copied())
            .collect()
    } else {
        Vec::new()
    };
    // 空间候选索引与几何同代：只在完整场景接受点构建（design D7 / 任务 7.3）。
    let node_grid = build_node_grid(&nodes);
    let edge_grid = build_edge_grid(&edges);
    let nodes_len = nodes.len();
    InteractionSnapshot {
        generation,
        hover: scene.hover.clone(),
        selected_edge: scene.selection.edge.clone(),
        overview: scene.model_focus.is_none()
            && scene.image_focus.is_none()
            && scene.video_focus.is_none(),
        action_descriptors: scene
            .node_actions
            .iter()
            .filter_map(|(id, actions)| {
                let index = *node_index.get(id)?;
                Some((index, actions.clone()))
            })
            .collect(),
        viewport,
        surface: scene.surface.as_ref().map(|s| (s.width, s.height)),
        node_index,
        adjacency,
        aggregate_selection,
        scene_area_labels: layout::scene_area_labels(scene),
        scene_area_players: if scene.model_focus.is_none()
            && scene.image_focus.is_none()
            && scene.video_focus.is_none()
        {
            scene
                .scene_areas
                .iter()
                .filter_map(|area| {
                    crate::canvas_query::scene_area_player::geometry(area, scene.viewport.zoom)
                })
                .collect()
        } else {
            Vec::new()
        },
        scope_frames: nodes
            .iter()
            .enumerate()
            .filter_map(|(i, node)| (node.frame && !node.ghost).then_some(i))
            .collect(),
        scope_areas: if scene.model_focus.is_none()
            && scene.image_focus.is_none()
            && scene.video_focus.is_none()
        {
            scene.scene_areas.clone()
        } else {
            Vec::new()
        },
        nodes,
        edges,
        order_rank: build_order_rank(&order, nodes_len),
        order,
        node_grid,
        edge_grid,
        aggregate_handles: scene.aggregate_connect.as_ref().and_then(|_| {
            let bounds = selection_bounds(&scene.nodes, &scene.selection.nodes)?;
            let (ix, iy) = aggregate_handle(bounds, false);
            let (ox, oy) = aggregate_handle(bounds, true);
            Some([
                ("input".into(), Vec2::new(ix, iy)),
                ("output".into(), Vec2::new(ox, oy)),
            ])
        }),
    }
}

fn snapshot_node(
    node: &GraphNode,
    node_actions: &std::collections::HashMap<String, crate::protocol::NodeActions>,
    viewport: (f32, f32, f32),
    surface: Option<&crate::protocol::SurfaceSize>,
) -> SnapshotNode {
    // `card` 只表示“有内容卡片”（普通卡片/模型预览）；2D 组是空框，没有内容卡，
    // 但仍必须可点、可拖、可缩放并显示顶部栏。
    let card = node.chrome.is_card();
    let interactable = !node.chrome.is_none();
    let history_strip = if !layout::has_history_strip(node) {
        None
    } else {
        Some(layout::history_strip_rect(
            node.x,
            node.y,
            node.width,
            node.height,
        ))
    };
    // `chrome.none` 的世界对象不在画布上绘制动作横条（动作留在原生菜单），
    // 因此也不保留命中的隐形横条。
    let node_actions = interactable
        .then(|| node_actions.get(&node.id))
        .flatten()
        .and_then(|actions| {
            layout::node_action_toolbar(
                node,
                actions,
                Some(viewport),
                surface.map(|s| (s.width, s.height)),
            )
        });
    SnapshotNode {
        initial_position: Vec2::new(node.x, node.y),
        layout_bounds: (node.x, node.y, node.width, node.height),
        id: node.id.clone(),
        ghost: node.ghost,
        bounds: (node.x, node.y, node.width, node.height),
        center: Vec2::new(node.x + node.width / 2., node.y + node.height / 2.),
        // 世界模型没有内容卡片：端口/预览/历史条都不可见，也不能留下可命中的隐形矩形。
        input_port: card.then(|| layout::port(node, false)),
        output_port: card.then(|| layout::port(node, true)),
        history_strip: card.then_some(history_strip).flatten(),
        // resize 抓手只在选中时命中；快照构建时按 selection 决定（见 `apply_selection`）。
        resize: None,
        resizable: interactable && node.resizable,
        // 命中与拖拽按“可交互画布对象”判定：2D 组空框也要能选中；世界对象仍排除。
        card: interactable,
        frame: matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }),
        node_actions,
    }
}

/// 选中节点集合（用于 resize 命中）。
pub(super) fn apply_selection(snapshot: &mut InteractionSnapshot, selected: &[String]) {
    let set: std::collections::HashSet<&str> = selected.iter().map(String::as_str).collect();
    for node in &mut snapshot.nodes {
        // Selection can narrow an accepted capability, never grant a missing one.
        // `resizable` 已在快照期按 chrome 收窄：世界模型没有卡片尺寸抓手。
        if set.len() != 1 || !set.contains(node.id.as_str()) || !node.resizable {
            node.resize = None;
        } else {
            node.resize = Some(ResizeGrip::all_for_bounds(
                node.bounds.0,
                node.bounds.1,
                node.bounds.2,
                node.bounds.3,
            ));
        }
    }
}

impl InteractionSnapshot {
    /// 把该节点当前的可命中范围写回空间网格（位置/横条变化后调用）。
    ///
    /// 只移动单个条目：位置增量不重建整张索引（design D7 / 任务 7.3）。
    pub(crate) fn refresh_node_grid(&mut self, index: usize) {
        let Some(node) = self.nodes.get(index) else {
            self.node_grid.remove(index);
            return;
        };
        let bounds = node_hit_bounds(node);
        self.node_grid.relocate(index, bounds);
    }

    /// 点查询的候选半径（世界单位）。
    ///
    /// 端口/抓手的命中半径随 zoom 放大（`10/zoom`），节点顶部操作横条按屏幕像素排版后换算回
    /// 世界坐标（约 `48/zoom` 的偏移），因此候选窗口必须同时覆盖两者；这样既不会漏掉横条，
    /// 也不会因为固定 64 世界单位在低 zoom 下漏判。
    fn point_candidate_margin(zoom: f32) -> f32 {
        let safe_zoom = if zoom.is_finite() && zoom > 0.0 {
            zoom
        } else {
            1.0
        };
        layout::hit_radius(safe_zoom).max(96.0 / safe_zoom)
    }

    /// 点周围的候选矩形（`(x, y, width, height)`）。
    fn point_candidate_rect(world: Vec2, zoom: f32) -> (f32, f32, f32, f32) {
        let margin = Self::point_candidate_margin(zoom);
        (
            world.x - margin,
            world.y - margin,
            margin * 2.0,
            margin * 2.0,
        )
    }

    /// 点查询的节点候选：空间网格取邻域，再按 `order`（z/who-owns-the-pixel）排序。
    ///
    /// 候选只是**缩小遍历范围**：命中判定仍用原几何与顺序，因此结果与全量扫描一致。
    pub(super) fn point_node_candidates(&self, world: Vec2, zoom: f32) -> Vec<usize> {
        let mut candidates = self
            .node_grid
            .candidates(Self::point_candidate_rect(world, zoom));
        sort_by_order_rank(&mut candidates, &self.order_rank);
        candidates.retain(|index| {
            self.order_rank
                .get(*index)
                .is_some_and(|rank| *rank != u32::MAX)
        });
        candidates
    }

    /// 点命中的边候选：按绘制倒序（后绘制优先），与既有边命中顺序一致。
    fn point_edge_candidates(&self, world: Vec2, zoom: f32) -> Vec<usize> {
        let margin = layout::edge_hit_distance(zoom);
        let mut candidates = self.edge_grid.candidates((
            world.x - margin,
            world.y - margin,
            margin * 2.0,
            margin * 2.0,
        ));
        candidates.reverse();
        candidates
    }

    /// 点命中：悬停边删除按钮 → 节点端口/控件/抓手 → 节点本体 → 悬停保持区 → 边。
    pub(crate) fn point_hit(
        &self,
        world: Vec2,
        zoom: f32,
        hovered_edge: Option<&str>,
    ) -> Option<PointHit> {
        let radius = layout::hit_radius(zoom);
        // 把手 overlay 在节点之上；查询只比较预计算的两个中心，无全场景扫描。
        if let Some(handles) = &self.aggregate_handles {
            for (direction, center) in handles {
                if world.distance(*center) <= radius {
                    return Some(PointHit::AggregateHandle {
                        direction: direction.clone(),
                    });
                }
            }
        }
        for player in &self.scene_area_players {
            if let Some(control) = crate::canvas_query::scene_area_player::control(player, world) {
                let (a, b) = crate::canvas_query::scene_area_player::track(player);
                return Some(PointHit::SceneAreaPlayback {
                    node_id: player.node_id.clone(),
                    control: control.into(),
                    track: [a.x, a.y, b.x, b.y],
                });
            }
        }
        // 导演区边框胶囊画在 3D 线框上、位于节点之上：先判标签，点它选中导演区。
        for label in &self.scene_area_labels {
            let offset = world - label.center;
            let along = offset.dot(label.axis).abs();
            let across = offset.dot(label.axis.perp()).abs();
            if along <= label.width / 2.0 && across <= label.height / 2.0 {
                return Some(PointHit::Node {
                    node_id: label.node_id.clone(),
                });
            }
        }
        // New pointer-following controls only exist on the selected edge.
        if let Some(edge_id) = hovered_edge
            && let Some(edge) = self.edges.iter().find(|edge| edge.id == edge_id)
        {
            let cursor = self
                .hover
                .as_ref()
                .filter(|h| h.edge_id.as_deref() == Some(edge_id))
                .and_then(|h| h.cursor);
            if cursor.is_none() || self.selected_edge.as_deref() == Some(edge_id) {
                let center = cursor
                    .map(|p| {
                        curve::closest_edge_point(
                            Vec2::new(p.x, p.y),
                            edge.source_port,
                            edge.target_port,
                        )
                    })
                    .unwrap_or_else(|| {
                        layout::edge_delete_center(
                            edge.source_port,
                            edge.target_port,
                            edge.label_width,
                        )
                    });
                if layout::in_rect(world, layout::edge_delete_hit_rect(center)) {
                    return Some(PointHit::EdgeDelete {
                        edge_id: edge_id.to_owned(),
                    });
                }
            }
        }
        // Keep the acquired side active around its fixed anchor, including the
        // half-button extension inside the node. Never acquire the other side here.
        if let Some(hover) = &self.hover
            && let Some(node_id) = &hover.node_id
            && let Some(index) = self.node_index.get(node_id)
        {
            let node = &self.nodes[*index];
            let point = match hover.port.as_deref() {
                Some("input") => node.input_port,
                Some("output") => node.output_port,
                _ => None,
            };
            if !node.ghost
                && let Some(anchor) = point
                && world.distance(anchor) <= layout::magnetic_port_radius(zoom)
            {
                return Some(PointHit::Port {
                    node_id: node_id.clone(),
                    side: hover.port.clone().unwrap(),
                });
            }
        }
        // 空间候选（design D7 / 任务 7.3）：只遍历与点邻域可能相交的节点，再按原命中顺序判定。
        for index in self.point_node_candidates(world, zoom) {
            let node = &self.nodes[index];
            if node.ghost {
                continue;
            }
            // 顶部操作横条优先命中（change: 2026-10-13-add-node-to-film-set-shortcut）：横条浮在
            // 节点上方，位于画布内，因此命中与画布手势并存——只有左键落在动作矩形内才触发动作。
            if let Some(layout) = &node.node_actions {
                for slot in &layout.slots {
                    if layout::in_rect(world, slot.rect) {
                        return Some(PointHit::NodeAction {
                            node_id: node.id.clone(),
                            action_id: slot.id.clone(),
                            menu: false,
                        });
                    }
                    if let Some(menu) = slot.menu
                        && layout::in_rect(world, menu)
                    {
                        return Some(PointHit::NodeAction {
                            node_id: node.id.clone(),
                            action_id: slot.id.clone(),
                            menu: true,
                        });
                    }
                }
            }
            for (side, point) in [("input", node.input_port), ("output", node.output_port)] {
                if let Some(point) = point
                    && world.distance(point) <= radius
                {
                    return Some(PointHit::Port {
                        node_id: node.id.clone(),
                        side: side.to_owned(),
                    });
                }
            }
            // resize 抓手优先于历史条：若仍重叠则 resize 胜出
            // （change: 2026-10-12-unify-generation-history-strip，design D4）。
            if let Some(grips) = &node.resize {
                if let Some(grip) = grips.iter().find(|grip| grip.hit(world, radius)) {
                    return Some(PointHit::Resize {
                        node_id: node.id.clone(),
                        handle: Some(grip.handle.to_owned()),
                    });
                }
            }
            if node
                .history_strip
                .is_some_and(|rect| layout::in_rect(world, rect))
            {
                return Some(PointHit::History {
                    node_id: node.id.clone(),
                });
            }
            // 世界模型（`chrome.none`）没有卡片本体：点它只能经渲染器的模型拾取命中，
            // 这里不再返回可能是迁移前残留矩形的 `Node` 命中。
            let body_hit = if node.frame {
                let (x, y, width, height) = node.bounds;
                let r = crate::scope_visual::FRAME_RADIUS
                    .min(width / 2.0)
                    .min(height / 2.0);
                let q = (world - Vec2::new(x + width / 2.0, y + height / 2.0)).abs()
                    - Vec2::new(width / 2.0 - r, height / 2.0 - r);
                let distance = q.max(Vec2::ZERO).length() + q.x.max(q.y).min(0.0) - r;
                distance.abs() <= 6.0 / zoom.max(0.01)
            } else {
                layout::in_rect(world, node.bounds)
            };
            if node.card && body_hit {
                return Some(PointHit::Node {
                    node_id: node.id.clone(),
                });
            }
        }
        // 悬停保持区：有标签时删除按钮排在标签右侧，曲线只从标签中间穿过。指针从线体经
        // 标签走到按钮时，这一段既不在曲线命中带、也还没进按钮；把它判为该边可以让悬停
        // 连续，按钮不会在途中消失（修复：删除按钮悬停丢失）。只维持悬停，
        // 点击此处仍是连线本体（无操作），删除只由上面的按钮命中区触发。
        if self.hover.as_ref().and_then(|h| h.cursor).is_none()
            && let Some(edge_id) = hovered_edge
            && let Some(edge) = self.edges.iter().find(|edge| edge.id == edge_id)
            && layout::in_rect(
                world,
                layout::edge_hover_bridge_rect(
                    edge.source_port,
                    edge.target_port,
                    edge.label_width,
                ),
            )
        {
            return Some(PointHit::Edge {
                edge_id: edge_id.to_owned(),
            });
        }
        // 边：倒序（后绘制优先），先用边网格缩小范围，再做 broad phase 与逐段距离。
        let distance = layout::edge_hit_distance(zoom);
        for index in self.point_edge_candidates(world, zoom) {
            let edge = &self.edges[index];
            if world.x < edge.aabb.0[0] - distance
                || world.x > edge.aabb.1[0] + distance
                || world.y < edge.aabb.0[1] - distance
                || world.y > edge.aabb.1[1] + distance
            {
                continue;
            }
            for window in edge.points.windows(2) {
                if curve::point_segment_distance(world, window[0], window[1]) <= distance {
                    return Some(PointHit::Edge {
                        edge_id: edge.id.clone(),
                    });
                }
            }
        }
        None
    }

    /// 框选：与归一化矩形**正面积**相交且可交互（非 ghost）的节点，保持当前发射顺序。
    ///
    /// 候选来自空间网格（design D7 / 任务 7.3），因此只遍历可能相交的节点；结果仍按发射顺序返回
    /// （与 scene.nodes 一致），未驻留/离屏节点照常参与框选。
    pub(crate) fn marquee(&self, x: f32, y: f32, width: f32, height: f32) -> Vec<String> {
        let left = x.min(x + width);
        let right = x.max(x + width);
        let top = y.min(y + height);
        let bottom = y.max(y + height);
        let mut candidates = self
            .node_grid
            .candidates((left, top, right - left, bottom - top));
        candidates.sort_unstable();
        candidates
            .into_iter()
            .filter_map(|index| self.nodes.get(index))
            // 世界对象没有内容卡片：不能用迁移前的卡片矩形参与框选/点击框选。
            .filter(|node| node.card && !node.ghost)
            .filter(|node| {
                let (nx, ny, nw, nh) = node.bounds;
                nx < right && nx + nw > left && ny < bottom && ny + nh > top
            })
            .map(|node| node.id.clone())
            .collect()
    }

    /// drag-touch probe：返回拖动节点在给定方向上的候选目标（非 ghost）。
    ///
    /// 方向判定只依赖节点中心与来源中心的相对位置，与 z 顺序无关；空间候选用「来源节点
    /// 一侧的延伸矩形」，避免全量遍历，结果仍按文档顺序返回。
    pub(crate) fn probe(&self, source_id: &str, direction: &str) -> Vec<ProbeCandidate> {
        let Some(source_index) = self.node_index.get(source_id).copied() else {
            return Vec::new();
        };
        let source = &self.nodes[source_index];
        let sign = if direction == "prev" { -1.0 } else { 1.0 };
        // 候选矩形：来源节点中心沿方向的半平面，纵向取网格整体范围（probe 不限制纵向距离）。
        let extent =
            self.node_grid
                .extent()
                .unwrap_or((source.center.x, source.center.y, 0.0, 0.0));
        let top = extent.1;
        let bottom = extent.1 + extent.3;
        let query = if sign > 0.0 {
            (
                source.center.x,
                top,
                extent.0 + extent.2 - source.center.x,
                bottom - top,
            )
        } else {
            (extent.0, top, source.center.x - extent.0, bottom - top)
        };
        let mut candidates = self.node_grid.candidates(query);
        candidates.sort_unstable();
        candidates
            .into_iter()
            .filter_map(|index| self.nodes.get(index))
            // 世界对象没有卡片/端口，不能成为拖动粘连或合并的目标。
            .filter(|node| node.card && node.id != source_id && !node.ghost)
            .filter(|node| (node.center.x - source.center.x) * sign > 0.0)
            .map(|node| ProbeCandidate {
                node_id: node.id.clone(),
                direction: direction.to_owned(),
                connectable: true,
            })
            .collect()
    }

    /// 通用 drop target 查询：按既有命中顺序固定**最上层实际节点**，排除来源与 ghost。
    ///
    /// 只判定节点本体范围，不命中端口、控件、resize 抓手、连线或把手。
    /// 返回 `None` 表示该点无实际节点（查询成功但继续普通移动）；调用方再按业务 owner 过滤。
    pub(crate) fn drop_target(&self, world: Vec2, excluded: &[String]) -> Option<String> {
        if !world.x.is_finite() || !world.y.is_finite() {
            return None;
        }
        for index in self.point_node_candidates(world, 1.0) {
            let node = &self.nodes[index];
            if !node.card || node.ghost || excluded.iter().any(|id| id == &node.id) {
                continue;
            }
            if layout::in_rect(world, node.bounds) {
                return Some(node.id.clone());
            }
        }
        None
    }
}

fn refresh_scope_labels(snapshot: &mut InteractionSnapshot) {
    if !snapshot.overview {
        return;
    }
    let zoom = snapshot.viewport.2;
    snapshot.scene_area_players = snapshot
        .scope_areas
        .iter()
        .filter_map(|area| crate::canvas_query::scene_area_player::geometry(area, zoom))
        .collect();
    snapshot.scene_area_labels = snapshot
        .scope_areas
        .iter()
        .filter_map(|area| layout::scene_area_label_geometry_for_zoom(area, zoom))
        .chain(
            snapshot
                .scope_frames
                .iter()
                .map(|&index| &snapshot.nodes[index])
                .map(|node| {
                    layout::workflow_group_label_for_bounds(&node.id, node.layout_bounds, zoom)
                }),
        )
        .collect();
}

/// 屏幕尺寸固定的横条必须随 zoom/pan 重新派生；其余世界几何保持复用。
pub(super) fn refresh_node_actions(
    snapshot: &mut InteractionSnapshot,
    viewport: Option<&crate::protocol::Viewport>,
) {
    let labels_changed = viewport.is_none_or(|v| v.zoom != snapshot.viewport.2);
    if let Some(viewport) = viewport {
        snapshot.viewport = (viewport.x, viewport.y, viewport.zoom);
    }
    if labels_changed {
        refresh_scope_labels(snapshot);
    }
    for (index, actions) in &snapshot.action_descriptors {
        let node = &mut snapshot.nodes[*index];
        node.node_actions = layout::node_action_toolbar_for_bounds(
            node.bounds,
            actions,
            Some(snapshot.viewport),
            snapshot.surface,
        );
    }
    // 横条几何随 zoom/pan 变化，命中候选范围也必须同步（design D7 / 任务 7.3）：
    // 只搬动带横条的节点，不重建整张索引。
    let reindexed: Vec<usize> = snapshot
        .action_descriptors
        .iter()
        .map(|(index, _)| *index)
        .collect();
    for index in reindexed {
        snapshot.refresh_node_grid(index);
    }
}
