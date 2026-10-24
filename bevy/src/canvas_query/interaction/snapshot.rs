//! 2D interaction snapshot：可丢弃的派生几何与点/框选/probe 命中逻辑
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.3-2.5 / design D2）。
//!
//! 快照只含可由当前 `Scene` 重建的几何（节点画布矩形、端口、控件矩形、预采样边折线与
//! broad-phase AABB），不含命令、Yjs、任务或持久化事实。全部几何由 `super::curve` /
//! `super::layout` 的共享纯函数派生，保证与绘制一致。

use bevy::prelude::*;

use crate::canvas_query::aggregate::{aggregate_handle, selection_bounds};
use crate::canvas_query::scope::{self, ScopeGeometry, ScopeGrip, ScopeRect, DIAMOND_GRIP_TOLERANCE};
use crate::canvas_query::{curve, layout};
use crate::protocol::{GraphNode, Scene};

use super::results::{PointHit, ProbeCandidate, ScopeGeometryEntry};

/// 快照中的单个节点几何。
#[derive(Clone)]
pub(super) struct SnapshotNode {
    pub(super) initial_position: Vec2,
    pub(super) layout_bounds: (f32, f32, f32, f32),
    pub(super) id: String,
    pub(super) group: bool,
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
    pub(super) has_label: bool,
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
    /// 点命中顺序：非 group 倒序在前，group 倒序在后（与既有 JS 优先级一致）。
    pub(super) order: Vec<usize>,
    /// 两个把手只在合法 scene 投影声明可见时存在（冷路径生成）。
    pub(super) aggregate_handles: Option<[(String, Vec2); 2]>,
    pub(super) aggregate_selection: Vec<usize>,
    pub(super) node_index: std::collections::HashMap<String, usize>,
    pub(super) adjacency: Vec<Vec<usize>>,
    /// 仅保留有横条的节点，视口增量不重建节点/边的世界几何。
    pub(super) action_descriptors: Vec<(usize, crate::protocol::NodeActions)>,
    pub(super) viewport: (f32, f32, f32),
    pub(super) surface: Option<(f32, f32)>,
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
                !edge.label.is_empty(),
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
    InteractionSnapshot {
        generation,
        overview: scene.model_focus.is_none()
            && scene.image_focus.is_none()
            && scene.video_focus.is_none(),
        action_descriptors: scene.node_actions.iter().filter_map(|(id, actions)| {
            let index = *node_index.get(id)?;
            (!nodes[index].group && !nodes[index].composite_asset).then(|| (index, actions.clone()))
        }).collect(),
        viewport,
        surface: scene.surface.as_ref().map(|s| (s.width, s.height)),
        node_index,
        adjacency,
        aggregate_selection,
        nodes,
        edges,
        order,
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
        Some(layout::history_strip_rect(node.x, node.y, node.width, node.height))
    };
    // 复合资产：保存真实范围几何（形状由 presentation 声明），AABB 仅作粗筛。
    let scope_geometry = film_set.then(|| scope::node_scope(node));
    let bounds = match &scope_geometry {
        Some(scope) => (scope.aabb.x, scope.aabb.y, scope.aabb.width, scope.aabb.height),
        None => (node.x, node.y, node.width, node.height),
    };
    // 顶部操作横条：非 group、非片场纯模型节点可带横条；世界几何随节点移动重算。
    let node_actions = if group || film_set {
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
        ghost: node.ghost,
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
        // group 容器维持“选中不可 resize”的既有语义。
        if !set.contains(node.id.as_str()) || node.group {
            node.resize = None;
        } else if let Some(scope) = &node.scope {
            node.resize = Some(scope::grip(scope));
        } else {
            node.resize = Some(ScopeGrip::Rect(ScopeRect {
                x: node.bounds.0 + node.bounds.2 - layout::RESIZE_HANDLE_SIZE,
                y: node.bounds.1 + node.bounds.3 - layout::RESIZE_HANDLE_SIZE,
                width: layout::RESIZE_HANDLE_SIZE,
                height: layout::RESIZE_HANDLE_SIZE,
            }));
        }
    }
}

/// 抓手索引 → 方向名（`n/ne/e/se/s/sw/w/nw`）；`usize::MAX`（普通矩形右下角）返回 `None`。
fn handle_name(index: usize) -> Option<String> {
    scope::HANDLE_NAMES.get(index).map(|name| (*name).to_owned())
}

impl InteractionSnapshot {
    /// 点命中：悬停边删除按钮 → 节点端口/关闭/历史/抓手 → 节点本体 → 边。
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
        // 悬停连线的删除按钮优先：先于节点判定，避免节点压住连线中点被误判。
        if let Some(edge_id) = hovered_edge
            && let Some(edge) = self.edges.iter().find(|edge| edge.id == edge_id)
        {
            let center =
                layout::edge_delete_center(edge.source_port, edge.target_port, edge.has_label);
            if layout::in_rect(world, layout::edge_delete_rect(center)) {
                return Some(PointHit::EdgeDelete {
                    edge_id: edge_id.to_owned(),
                });
            }
        }
        for &index in &self.order {
            let node = &self.nodes[index];
            if node.ghost {
                continue;
            }
            if node.group_status.is_some_and(|rect| layout::in_rect(world, rect)) {
                return Some(PointHit::NodeAction {
                    node_id: node.id.clone(), action_id: "group-run-status".into(), menu: false,
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
            if layout::in_rect(world, node.bounds) {
                return Some(PointHit::Node {
                    node_id: node.id.clone(),
                });
            }
        }
        // 边：倒序（后绘制优先），先 broad phase 再逐段距离。
        let distance = layout::edge_hit_distance(zoom);
        for edge in self.edges.iter().rev() {
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
        self.nodes
            .iter()
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
    pub(crate) fn probe(&self, source_id: &str, direction: &str) -> Vec<ProbeCandidate> {
        let Some(source) = self.nodes.iter().find(|node| node.id == source_id) else {
            return Vec::new();
        };
        let sign = if direction == "prev" { -1.0 } else { 1.0 };
        self.nodes
            .iter()
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
        for &index in &self.order {
            let node = &self.nodes[index];
            if node.ghost || excluded.iter().any(|id| id == &node.id) {
                continue;
            }
            if node.composite_asset {
                if node.scope.as_ref().is_some_and(|scope| scope::contains(scope, world)) {
                    return Some(node.id.clone());
                }
                continue;
            }
            if layout::in_rect(world, node.bounds) {
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
                    aabb: [scope.aabb.x, scope.aabb.y, scope.aabb.width, scope.aabb.height],
                    base: [scope.base.x, scope.base.y, scope.base.width, scope.base.height],
                })
            })
            .collect()
    }
}

/// 屏幕尺寸固定的横条必须随 zoom/pan 重新派生；其余世界几何保持复用。
pub(super) fn refresh_node_actions(snapshot: &mut InteractionSnapshot, viewport: Option<&crate::protocol::Viewport>) {
    if let Some(viewport) = viewport {
        snapshot.viewport = (viewport.x, viewport.y, viewport.zoom);
    }
    for (index, actions) in &snapshot.action_descriptors {
        let node = &mut snapshot.nodes[*index];
        node.node_actions = layout::node_action_toolbar_for_bounds(node.layout_bounds, actions, Some(snapshot.viewport), snapshot.surface);
    }
}
