//! 2D interaction snapshot：可丢弃的派生几何与点/框选/probe 命中逻辑
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.3-2.5 / design D2）。
//!
//! 快照只含可由当前 `Scene` 重建的几何（节点画布矩形、端口、控件矩形、预采样边折线与
//! broad-phase AABB），不含命令、Yjs、任务或持久化事实。全部几何由 `super::curve` /
//! `super::layout` 的共享纯函数派生，保证与绘制一致。

use bevy::prelude::*;

use crate::canvas_query::aggregate::{aggregate_handle, selection_bounds};
use crate::canvas_query::scope::{
    self, DIAMOND_GRIP_TOLERANCE, ScopeGeometry, ScopeGrip, ScopeRect,
};
use crate::canvas_query::{curve, layout};
use crate::protocol::{GraphNode, Scene};

use super::results::{PointHit, ProbeCandidate, ScopeGeometryEntry};
use super::spatial::SpatialGrid;

/// 空间网格 cell 边长（世界单位）。
///
/// 取固定卡片量级：太小会让大卡片/片场跨很多 cell，太大则退化为全量候选。位置增量只搬动
/// 真正移动的对象，因此该值不需要随 zoom 变化（design D7 / 任务 7.3）。
const SPATIAL_CELL_SIZE: f32 = 256.0;

/// 快照中的单个节点几何。
#[derive(Clone)]
pub(super) struct SnapshotNode {
    pub(super) initial_position: Vec2,
    pub(super) layout_bounds: (f32, f32, f32, f32),
    pub(super) id: String,
    pub(super) group: bool,
    pub(super) group_outline: Vec<Vec2>,
    pub(super) group_badge: Vec<Vec2>,
    pub(super) group_badge_resize: Option<Vec2>,
    pub(super) ghost: bool,
    pub(super) composite_asset: bool,
    /// 粗筛用外接矩形；复合资产为范围 AABB，普通节点为节点矩形。
    pub(super) bounds: (f32, f32, f32, f32),
    /// 复合资产真实范围几何；普通节点为 `None`（用 `bounds`）。
    pub(super) scope: Option<ScopeGeometry>,
    pub(super) center: Vec2,
    pub(super) input_port: Option<Vec2>,
    pub(super) output_port: Option<Vec2>,
    pub(super) output_capable_group: bool,
    /// 底部历史条命中矩形（change: 2026-10-12-unify-generation-history-strip）。
    pub(super) history_strip: Option<(f32, f32, f32, f32)>,
    pub(super) group_status: Option<(f32, f32, f32, f32)>,
    pub(super) preview: Option<(f32, f32, f32, f32)>,
    /// 拍摄镜头预览**内容区**命中矩形（change: 2026-10-15，design D6）；
    /// 只有内容区建立拍摄播放资格，标题区走普通 `Node`。
    pub(super) shot_preview_content: Option<(f32, f32, f32, f32)>,
    /// 选中时的 resize 抓手；复合资产为菱形右顶点三角，普通节点为右下方形。
    pub(super) resize: Option<ScopeGrip>,
    pub(super) resizable: bool,
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
    focus_closes: Option<Vec<(String, (f32, f32, f32, f32))>>,
    pub(super) nodes: Vec<SnapshotNode>,
    pub(super) edges: Vec<SnapshotEdge>,
    /// 点命中顺序：非 group 倒序在前，group 倒序在后（与既有 JS 优先级一致）。
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
}

/// 节点参与空间候选的外接矩形：片场用真实范围 AABB，其余用节点矩形。
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

/// 点命中可触及的节点范围：节点几何 + 屏幕固定的操作横条/组运行状态芯片。
///
/// 横条按屏幕像素排版后换算回世界坐标，可能明显超出节点矩形（甚至在视口边缘被夹住），
/// 因此它必须计入空间候选，否则「画在哪、点在哪」会出现命不中的回归（design D7 / 任务 7.3）。
pub(super) fn node_hit_bounds(node: &SnapshotNode) -> (f32, f32, f32, f32) {
    let mut rect = node_bounds(node);
    for p in &node.group_outline {
        rect = union(rect, (p.x, p.y, 0., 0.));
    }
    if let Some(status) = node.group_status {
        rect = union(rect, status);
    }
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

    // 命中顺序：非 group 后绘制者优先，group 背景最后。
    let order: Vec<usize> = {
        let (groups, cards): (Vec<usize>, Vec<usize>) =
            (0..nodes.len()).partition(|index| nodes[*index].group);
        cards
            .into_iter()
            .rev()
            .chain(groups.into_iter().rev())
            .collect()
    };

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
        focus_closes: scene
            .model_focus
            .as_ref()
            .filter(|_| !scene.model_focus_context.is_empty())
            .map(|_| {
                scene
                    .model_focus_context
                    .iter()
                    .filter_map(|entry| {
                        if !crate::canvas_query::focus_context::close_enabled(scene, &entry.node_id)
                        {
                            return None;
                        }
                        let original = node_map.get(entry.node_id.as_str())?;
                        let node = crate::canvas_query::focus_context::node(scene, original);
                        Some((
                            entry.node_id.clone(),
                            crate::canvas_query::focus_context::close_rect(&node),
                        ))
                    })
                    .collect()
            }),
        overview: scene.model_focus.is_none()
            && scene.image_focus.is_none()
            && scene.video_focus.is_none(),
        action_descriptors: scene
            .node_actions
            .iter()
            .filter_map(|(id, actions)| {
                let index = *node_index.get(id)?;
                (!nodes[index].group).then(|| (index, actions.clone()))
            })
            .collect(),
        viewport,
        surface: scene.surface.as_ref().map(|s| (s.width, s.height)),
        node_index,
        adjacency,
        aggregate_selection,
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
    let group = node.group.is_some();
    let film_set = node.composite_asset.is_some();
    let selected = false; // resize handle 只对单选节点；由 scene.selection 决定，见下。
    let _ = selected;
    let size = Vec2::new(node.width, node.height);
    let center = Vec2::new(node.x + size.x / 2.0, node.y + size.y / 2.0);
    let output_capable_group = group
        && node
            .group
            .as_ref()
            .is_some_and(|group| group.output_capable_leaf_count > 0);
    // 片场纯模型：不暴露端口、关闭/历史/resize 控件；命中只用范围几何。
    let (input_port, output_port) = if film_set {
        (None, None)
    } else if group {
        (None, output_capable_group.then(|| layout::port(node, true)))
    } else {
        (
            Some(layout::port(node, false)),
            Some(layout::port(node, true)),
        )
    };
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
    // 复合资产：保存真实范围几何（形状由 presentation 声明），AABB 仅作粗筛。
    let scope_geometry = film_set.then(|| scope::node_scope(node));
    let bounds = match &scope_geometry {
        Some(scope) => (
            scope.aabb.x,
            scope.aabb.y,
            scope.aabb.width,
            scope.aabb.height,
        ),
        None => (node.x, node.y, node.width, node.height),
    };
    // 顶部操作横条：复合资产也可贡献操作，锚定其真实范围；group 使用独立横条。
    let node_actions = if group {
        None
    } else {
        node_actions.get(&node.id).and_then(|actions| {
            layout::node_action_toolbar(
                node,
                actions,
                Some(viewport),
                surface.map(|s| (s.width, s.height)),
            )
        })
    };
    SnapshotNode {
        initial_position: Vec2::new(node.x, node.y),
        layout_bounds: (node.x, node.y, node.width, node.height),
        id: node.id.clone(),
        group,
        group_badge: crate::canvas_query::group_model::badge_path(node),
        group_badge_resize: crate::canvas_query::group_model::resize_center(node),
        group_outline: if !crate::canvas_query::group_model::badge_path(node).is_empty() {
            crate::canvas_query::group_model::outline(node)
        } else {
            Vec::new()
        },
        ghost: node.ghost || crate::canvas_query::shot_preview::hidden(node),
        composite_asset: film_set,
        bounds,
        scope: scope_geometry,
        center,
        input_port,
        output_port,
        output_capable_group,
        history_strip,
        group_status: layout::group_run_status_rect(node),
        // resize 抓手只在选中时命中；快照构建时按 selection 决定（见 `apply_selection`）。
        resize: None,
        resizable: node.resizable,
        preview: if film_set {
            None
        } else {
            (node.model_preview.is_some() && node.model.is_some())
                .then(|| layout::content_rect(node))
        },
        // 拍摄镜头预览：内容区命中矩形（标题区在上）；只有内容区建立拍摄播放入口（design D6）。
        shot_preview_content: crate::canvas_query::shot_preview::is_shot_preview_node(node)
            .then(|| crate::canvas_query::shot_preview::content_rect_of(node)),
        node_actions,
    }
}

/// 选中节点集合（用于 resize 命中）。
pub(super) fn apply_selection(snapshot: &mut InteractionSnapshot, selected: &[String]) {
    let set: std::collections::HashSet<&str> = selected.iter().map(String::as_str).collect();
    for node in &mut snapshot.nodes {
        // 片场：范围右顶点/右下角可拖拽缩放（拖动即等比缩放整个片场内容）。
        // Selection can narrow an accepted capability, never grant a missing one.
        if set.len() != 1 || !set.contains(node.id.as_str()) || !node.resizable {
            node.resize = None;
        } else if let Some(scope) = &node.scope {
            node.resize = Some(scope::grip(scope));
        } else {
            let (x, y, width, height) = layout::resize_rect(node.bounds.0, node.bounds.1, node.bounds.2, node.bounds.3);
            node.resize = Some(ScopeGrip::Rect(ScopeRect { x, y, width, height }));
        }
    }
}

/// 抓手索引 → 方向名（`n/ne/e/se/s/sw/w/nw`）；`usize::MAX`（普通矩形右下角）返回 `None`。
fn handle_name(index: usize) -> Option<String> {
    scope::HANDLE_NAMES
        .get(index)
        .map(|name| (*name).to_owned())
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

    /// 点查询的候选半径（世界单位）。    ///
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

    /// 点命中：悬停边删除按钮 → 节点端口/关闭/历史/抓手 → 节点本体 → 悬停保持区 → 边。
    pub(crate) fn point_hit(
        &self,
        world: Vec2,
        zoom: f32,
        hovered_edge: Option<&str>,
    ) -> Option<PointHit> {
        if let Some(closes) = &self.focus_closes {
            return closes.iter().rev().find_map(|(id, (x, y, w, h))| {
                (world.x >= *x && world.x <= x + w && world.y >= *y && world.y <= y + h).then(
                    || PointHit::NodeAction {
                        node_id: id.clone(),
                        action_id: crate::canvas_query::focus_context::CLOSE_ACTION.into(),
                        menu: false,
                    },
                )
            });
        }
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
        // 悬停连线的删除按钮优先：先于节点判定，避免节点压住连线中点被误判。
        // 命中区在视觉按钮外扩 `EDGE_DELETE_HIT_PADDING`，补上标签与按钮之间的间隙
        // （修复：删除按钮悬停丢失）。
        if let Some(edge_id) = hovered_edge
            && let Some(edge) = self.edges.iter().find(|edge| edge.id == edge_id)
        {
            let center =
                layout::edge_delete_center(edge.source_port, edge.target_port, edge.label_width);
            if layout::in_rect(world, layout::edge_delete_hit_rect(center)) {
                return Some(PointHit::EdgeDelete {
                    edge_id: edge_id.to_owned(),
                });
            }
        }
        // 空间候选（design D7 / 任务 7.3）：只遍历与点邻域可能相交的节点，再按原命中顺序判定。
        for index in self.point_node_candidates(world, zoom) {
            let node = &self.nodes[index];
            if node.ghost {
                continue;
            }
            if node
                .group_status
                .is_some_and(|rect| layout::in_rect(world, rect))
            {
                return Some(PointHit::NodeAction {
                    node_id: node.id.clone(),
                    action_id: "group-run-status".into(),
                    menu: false,
                });
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
            // 片场纯模型：按范围多边形或范围顶部之上的模型身体命中（无端口/控件/preview）；
            // 选中时抓手优先命中 resize（拖动即等比缩放整个片场内容）。
            if node.composite_asset {
                if let Some(scope) = &node.scope {
                    if let Some(handle) = node
                        .resize
                        .as_ref()
                        .and_then(|grip| scope::grip_hit(grip, world, DIAMOND_GRIP_TOLERANCE))
                    {
                        return Some(PointHit::Resize {
                            node_id: node.id.clone(),
                            handle: handle_name(handle),
                        });
                    }
                    if scope::pick_contains(scope, world) {
                        return Some(PointHit::FilmScope {
                            node_id: node.id.clone(),
                        });
                    }
                }
                continue;
            }
            if node.group {
                if node.output_capable_group
                    && let Some(output) = node.output_port
                    && world.distance(output) <= radius
                {
                    return Some(PointHit::Port {
                        node_id: node.id.clone(),
                        side: "output".to_owned(),
                    });
                }
            } else {
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
            }
            // resize 抓手优先于历史条：若仍重叠则 resize 胜出
            // （change: 2026-10-12-unify-generation-history-strip，design D4）。
            if let Some(handle) = node
                .resize
                .as_ref()
                .and_then(|grip| scope::grip_hit(grip, world, DIAMOND_GRIP_TOLERANCE))
            {
                return Some(PointHit::Resize {
                    node_id: node.id.clone(),
                    handle: handle_name(handle),
                });
            }
            if node
                .history_strip
                .is_some_and(|rect| layout::in_rect(world, rect))
            {
                return Some(PointHit::History {
                    node_id: node.id.clone(),
                });
            }
            if node
                .preview
                .is_some_and(|rect| layout::in_rect(world, rect))
            {
                return Some(PointHit::ModelPreview {
                    node_id: node.id.clone(),
                });
            }
            // 拍摄镜头预览内容区（change: 2026-10-15，design D6）：只有内容区建立拍摄播放入口，
            // 标题区与卡片边框保持普通 Node 命中（不误开播）。
            if node
                .shot_preview_content
                .is_some_and(|rect| layout::in_rect(world, rect))
            {
                return Some(PointHit::ShotPreview {
                    node_id: node.id.clone(),
                });
            }
            if node.group_badge_resize.is_some_and(|center| (world - center).abs().max_element() <= 6. / zoom.max(0.1)) {
                return Some(PointHit::NodeAction {
                    node_id: node.id.clone(), action_id: "group-resize-badge".into(), menu: false,
                });
            }
            if crate::canvas_query::group_model::path_contains(&node.group_badge, world) {
                return Some(PointHit::NodeAction {
                    node_id: node.id.clone(),
                    action_id: "group-toggle-collapse".into(),
                    menu: false,
                });
            }
            if layout::in_rect(world, node.bounds)
                || crate::canvas_query::group_model::path_contains(&node.group_outline, world)
            {
                return Some(PointHit::Node {
                    node_id: node.id.clone(),
                });
            }
        }
        // 悬停保持区：有标签时删除按钮排在标签右侧，曲线只从标签中间穿过。指针从线体经
        // 标签走到按钮时，这一段既不在曲线命中带、也还没进按钮；把它判为该边可以让悬停
        // 连续，按钮不会在途中消失（修复：删除按钮悬停丢失）。只维持悬停，
        // 点击此处仍是连线本体（无操作），删除只由上面的按钮命中区触发。
        if let Some(edge_id) = hovered_edge
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

    /// 框选：与归一化矩形**正面积**相交且可交互（非 ghost）的节点，保持文档顺序。
    ///
    /// 复合资产使用真实范围多边形 SAT；仅触边不选中（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
    /// 候选来自空间网格（design D7 / 任务 7.3），因此只遍历可能相交的节点；结果仍按文档顺序返回，
    /// 未驻留/离屏节点照常参与框选。
    pub(crate) fn marquee(&self, x: f32, y: f32, width: f32, height: f32) -> Vec<String> {
        let left = x.min(x + width);
        let right = x.max(x + width);
        let top = y.min(y + height);
        let bottom = y.max(y + height);
        let rect = ScopeRect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        };
        let mut candidates = self
            .node_grid
            .candidates((left, top, right - left, bottom - top));
        candidates.sort_unstable();
        candidates
            .into_iter()
            .filter_map(|index| self.nodes.get(index))
            .filter(|node| !node.ghost)
            .filter(|node| match &node.scope {
                Some(scope) => scope::intersects_rect(scope, rect),
                None => {
                    let (nx, ny, nw, nh) = node.bounds;
                    nx < right && nx + nw > left && ny < bottom && ny + nh > top
                }
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
            .filter(|node| node.id != source_id && !node.ghost)
            .filter(|node| (node.center.x - source.center.x) * sign > 0.0)
            .map(|node| ProbeCandidate {
                node_id: node.id.clone(),
                direction: direction.to_owned(),
                connectable: !node.group && !node.composite_asset,
            })
            .collect()
    }

    /// 通用 drop target 查询：按既有命中顺序固定**最上层实际节点**，排除来源与 ghost。
    ///
    /// 只判定节点本体范围（复合资产用真实 shape），不命中端口、控件、resize 抓手、连线或把手。
    /// 返回 `None` 表示该点无实际节点（查询成功但继续普通移动）；调用方再按业务 owner 过滤。
    /// 不预过滤任何业务类型——否则被上层普通卡片遮住的片场会错误接收
    /// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
    pub(crate) fn drop_target(&self, world: Vec2, excluded: &[String]) -> Option<String> {
        if !world.x.is_finite() || !world.y.is_finite() {
            return None;
        }
        for index in self.point_node_candidates(world, 1.0) {
            let node = &self.nodes[index];
            if node.ghost || excluded.iter().any(|id| id == &node.id) {
                continue;
            }
            if node.composite_asset {
                if node
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope::contains(scope, world))
                {
                    return Some(node.id.clone());
                }
                continue;
            }
            if layout::in_rect(world, node.bounds)
                || crate::canvas_query::group_model::path_contains(&node.group_outline, world)
            {
                return Some(node.id.clone());
            }
        }
        None
    }

    /// 复合资产范围几何轻量读取：nodeId、shape、四顶点、AABB 与基准矩形。
    ///
    /// 只承载拖动提示所需几何，不含 SceneIR、mesh 或完整 scene JSON
    /// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
    pub(crate) fn scope_entries(&self) -> Vec<ScopeGeometryEntry> {
        self.nodes
            .iter()
            .filter_map(|node| {
                let scope = node.scope.as_ref()?;
                Some(ScopeGeometryEntry {
                    node_id: node.id.clone(),
                    shape: if scope::is_diamond(scope.shape) {
                        "isometric-diamond".to_owned()
                    } else {
                        "rect".to_owned()
                    },
                    vertices: [
                        [scope.vertices[0].x, scope.vertices[0].y],
                        [scope.vertices[1].x, scope.vertices[1].y],
                        [scope.vertices[2].x, scope.vertices[2].y],
                        [scope.vertices[3].x, scope.vertices[3].y],
                    ],
                    handles: [
                        [scope.handles[0].x, scope.handles[0].y],
                        [scope.handles[1].x, scope.handles[1].y],
                        [scope.handles[2].x, scope.handles[2].y],
                        [scope.handles[3].x, scope.handles[3].y],
                        [scope.handles[4].x, scope.handles[4].y],
                        [scope.handles[5].x, scope.handles[5].y],
                        [scope.handles[6].x, scope.handles[6].y],
                        [scope.handles[7].x, scope.handles[7].y],
                    ],
                    aabb: [
                        scope.aabb.x,
                        scope.aabb.y,
                        scope.aabb.width,
                        scope.aabb.height,
                    ],
                    base: [
                        scope.base.x,
                        scope.base.y,
                        scope.base.width,
                        scope.base.height,
                    ],
                })
            })
            .collect()
    }
}

/// 屏幕尺寸固定的横条必须随 zoom/pan 重新派生；其余世界几何保持复用。
pub(super) fn refresh_node_actions(
    snapshot: &mut InteractionSnapshot,
    viewport: Option<&crate::protocol::Viewport>,
) {
    if let Some(viewport) = viewport {
        snapshot.viewport = (viewport.x, viewport.y, viewport.zoom);
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
