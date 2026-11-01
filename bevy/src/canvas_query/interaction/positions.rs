//! Plan every affected node/edge before mutating the current query snapshot.
use super::snapshot::{InteractionSnapshot, SnapshotEdge, SnapshotNode};
use crate::{
    canvas_query::{aggregate::aggregate_handle, curve, grip::ResizeGrip, layout},
    protocol::NodePosition,
};
use bevy::prelude::*;
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Debug, PartialEq)]
/// Canvas translation from the last full scene, not the preceding increment.
pub(crate) struct PositionDelta {
    pub(crate) id: String,
    pub(crate) dx: f32,
    pub(crate) dy: f32,
}

pub(super) fn edge_geometry(
    id: String,
    source: usize,
    target: usize,
    label_width: f32,
    a: Vec2,
    b: Vec2,
) -> SnapshotEdge {
    let points = curve::sample_edge(a, b);
    let mut min = [f32::INFINITY; 2];
    let mut max = [f32::NEG_INFINITY; 2];
    for window in points.windows(2) {
        let (lo, hi) = curve::segment_bounds(window[0], window[1]);
        for i in 0..2 {
            min[i] = min[i].min(lo[i]);
            max[i] = max[i].max(hi[i]);
        }
    }
    SnapshotEdge {
        id,
        source,
        target,
        source_port: a,
        target_port: b,
        label_width,
        points,
        aabb: (min, max),
    }
}

fn port(node: &SnapshotNode, output: bool) -> Vec2 {
    let (x, y, w, h) = node.layout_bounds;
    layout::port_for_bounds(x, y, w, h, output)
}
fn rect_finite(rect: (f32, f32, f32, f32)) -> bool {
    [
        rect.0,
        rect.1,
        rect.2,
        rect.3,
        rect.0 + rect.2,
        rect.1 + rect.3,
    ]
    .iter()
    .all(|v| v.is_finite())
}
fn relocate(node: &SnapshotNode, p: &NodePosition) -> Result<SnapshotNode, &'static str> {
    let mut next = node.clone();
    let (_, _, w, h) = node.layout_bounds;
    next.layout_bounds = (p.x, p.y, w, h);
    let delta = Vec2::new(p.x - node.layout_bounds.0, p.y - node.layout_bounds.1);
    next.bounds = (
        node.bounds.0 + delta.x,
        node.bounds.1 + delta.y,
        node.bounds.2,
        node.bounds.3,
    );
    next.center = node.center + delta;
    next.input_port = node.input_port.map(|_| port(&next, false));
    next.output_port = node.output_port.map(|_| port(&next, true));
    next.history_strip = node
        .history_strip
        .map(|_| layout::history_strip_rect(p.x, p.y, w, h));
    // 横条不对平移封闭（边缘避让、上下回退）；commit 后按当前视口重算。
    next.node_actions = None;
    next.preview = node
        .preview
        .map(|_| layout::content_rect_for_bounds(p.x, p.y, w, h));
    next.resize = node.resize.map(|_| {
        ResizeGrip::for_bounds(next.bounds.0, next.bounds.1, next.bounds.2, next.bounds.3)
    });
    if !rect_finite(next.layout_bounds)
        || !rect_finite(next.bounds)
        || !next.center.is_finite()
        || [next.history_strip, next.preview]
            .into_iter()
            .flatten()
            .any(|r| !rect_finite(r))
        || !grip_finite(next.resize.as_ref())
        || [next.input_port, next.output_port]
            .into_iter()
            .flatten()
            .any(|p| !p.is_finite())
        || next
            .node_actions
            .as_ref()
            .is_some_and(|toolbar| !toolbar.rects_finite())
    {
        return Err("Invalid derived position geometry");
    }
    Ok(next)
}

/// 抓手几何有限性。
fn grip_finite(grip: Option<&ResizeGrip>) -> bool {
    grip.is_none_or(|rect| rect_finite((rect.x, rect.y, rect.width, rect.height)))
}

pub(super) fn plan(
    snapshot: &InteractionSnapshot,
    updates: &[NodePosition],
) -> Result<PositionPlan, &'static str> {
    let mut nodes = HashMap::with_capacity(updates.len());
    let mut deltas = Vec::with_capacity(updates.len());
    let mut dirty_edges = BTreeSet::new();
    for p in updates {
        let index = *snapshot
            .node_index
            .get(&p.id)
            .ok_or("Unknown position node")?;
        let old = &snapshot.nodes[index];
        let delta = PositionDelta {
            id: p.id.clone(),
            dx: p.x - old.initial_position.x,
            dy: p.y - old.initial_position.y,
        };
        if !delta.dx.is_finite() || !delta.dy.is_finite() {
            return Err("Invalid position delta");
        }
        nodes.insert(index, relocate(old, p)?);
        deltas.push(delta);
        dirty_edges.extend(snapshot.adjacency[index].iter().copied());
    }
    let node_at = |index: usize| nodes.get(&index).unwrap_or(&snapshot.nodes[index]);
    let mut edges = Vec::with_capacity(dirty_edges.len());
    for index in dirty_edges {
        let old = &snapshot.edges[index];
        let next = edge_geometry(
            old.id.clone(),
            old.source,
            old.target,
            old.label_width,
            port(node_at(old.source), true),
            port(node_at(old.target), false),
        );
        if next.points.iter().any(|p| !p.is_finite())
            || next
                .aabb
                .0
                .iter()
                .chain(next.aabb.1.iter())
                .any(|v| !v.is_finite())
        {
            return Err("Invalid derived edge geometry");
        }
        edges.push((index, next));
    }
    let handles = if snapshot.aggregate_selection.is_empty() {
        None
    } else {
        let mut lo = Vec2::splat(f32::INFINITY);
        let mut hi = Vec2::splat(f32::NEG_INFINITY);
        for &index in &snapshot.aggregate_selection {
            let node = node_at(index);
            let (x, y, w, h) = node.layout_bounds;
            lo = lo.min(Vec2::new(x, y));
            hi = hi.max(Vec2::new(x + w, y + h));
        }
        let bounds = [lo.x, lo.y, hi.x - lo.x, hi.y - lo.y];
        if bounds.iter().any(|v| !v.is_finite()) {
            return Err("Invalid aggregate position geometry");
        }
        let (ix, iy) = aggregate_handle(bounds, false);
        let (ox, oy) = aggregate_handle(bounds, true);
        Some([
            ("input".to_owned(), Vec2::new(ix, iy)),
            ("output".to_owned(), Vec2::new(ox, oy)),
        ])
    };
    Ok(PositionPlan {
        nodes,
        edges,
        handles,
        deltas,
    })
}

pub(super) struct PositionPlan {
    nodes: HashMap<usize, SnapshotNode>,
    edges: Vec<(usize, SnapshotEdge)>,
    handles: Option<[(String, Vec2); 2]>,
    pub(super) deltas: Vec<PositionDelta>,
}

pub(super) fn commit(snapshot: &mut InteractionSnapshot, plan: PositionPlan) -> Vec<PositionDelta> {
    let moved_nodes: Vec<usize> = plan.nodes.keys().copied().collect();
    for (index, node) in plan.nodes {
        snapshot.nodes[index] = node;
    }
    // 横条按当前视口重新派生，因此先刷新派生几何，再把移动过的节点重新写进空间网格。
    super::snapshot::refresh_node_actions(snapshot, None);
    // 位置增量只搬动真正移动的节点/边（design D7 / 任务 7.3），不重建整张空间索引。
    for index in moved_nodes {
        snapshot.refresh_node_grid(index);
    }
    for (index, edge) in plan.edges {
        snapshot
            .edge_grid
            .relocate(index, super::snapshot::edge_bounds(&edge));
        snapshot.edges[index] = edge;
    }
    snapshot.aggregate_handles = plan.handles;
    plan.deltas
}

#[cfg(test)]
fn apply(
    snapshot: &mut InteractionSnapshot,
    updates: &[NodePosition],
) -> Result<Vec<PositionDelta>, &'static str> {
    let plan = plan(snapshot, updates)?;
    Ok(commit(snapshot, plan))
}

#[cfg(test)]
mod tests;
