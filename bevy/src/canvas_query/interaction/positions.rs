//! Plan every affected node/edge before mutating the current query snapshot.
use super::snapshot::{InteractionSnapshot, SnapshotEdge, SnapshotNode};
use crate::canvas_query::scope::{ScopeGrip, ScopeRect};
use crate::{
    canvas_query::{aggregate::aggregate_handle, curve, layout, scope},
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
    has_label: bool,
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
        has_label,
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
    // 复合资产范围几何是基准矩形/形状/地面的仿射派生，对平移封闭：整体位移即可与
    // 全量 `build_snapshot` 一致（无需重跑 `node_scope`）。
    next.scope = node
        .scope
        .map(|scope| scope::translate(&scope, Vec2::new(p.x - node.initial_position.x, p.y - node.initial_position.y)));
    next.bounds = match &next.scope {
        Some(scope) => (scope.aabb.x, scope.aabb.y, scope.aabb.width, scope.aabb.height),
        None => next.layout_bounds,
    };
    next.center = Vec2::new(p.x + w / 2., p.y + h / 2.);
    next.input_port = node.input_port.map(|_| port(&next, false));
    next.output_port = node.output_port.map(|_| port(&next, true));
    next.history_strip = node.history_strip.map(|_| layout::history_strip_rect(p.x, p.y, w, h));
    next.group_status = node.group_status.map(|r| (r.0 + p.x - node.layout_bounds.0, r.1 + p.y - node.layout_bounds.1, r.2, r.3));
    // 横条不对平移封闭（边缘避让、上下回退）；commit 后按当前视口重算。
    next.node_actions = None;
    next.preview = node
        .preview
        .map(|_| layout::content_rect_for_bounds(p.x, p.y, w, h));
    next.resize = node.resize.and_then(|_| {
        next.scope
            .as_ref()
            .map(scope::grip)
            .or_else(|| Some(ScopeGrip::Rect(ScopeRect {
                x: next.bounds.0 + next.bounds.2 - layout::RESIZE_HANDLE_SIZE,
                y: next.bounds.1 + next.bounds.3 - layout::RESIZE_HANDLE_SIZE,
                width: layout::RESIZE_HANDLE_SIZE,
                height: layout::RESIZE_HANDLE_SIZE,
            })))
    });
    if !rect_finite(next.layout_bounds)
        || !rect_finite(next.bounds)
        || !next.center.is_finite()
        || [next.history_strip, next.group_status, next.preview]
            .into_iter()
            .flatten()
            .any(|r| !rect_finite(r))
        || !grip_finite(next.resize.as_ref())
        || [next.input_port, next.output_port]
            .into_iter()
            .flatten()
            .any(|p| !p.is_finite())
        || next.node_actions.as_ref().is_some_and(|toolbar| !toolbar.rects_finite())
    {
        return Err("Invalid derived position geometry");
    }
    Ok(next)
}

/// 抓手几何有限性：矩形直接判矩形；8 抓手判全部中心点。
fn grip_finite(grip: Option<&ScopeGrip>) -> bool {
    match grip {
        None => true,
        Some(ScopeGrip::Rect(rect)) => rect_finite((rect.x, rect.y, rect.width, rect.height)),
        Some(ScopeGrip::Handles(handles)) => handles.iter().all(|handle| handle.is_finite()),
    }
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
            old.has_label,
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
            let (x, y, w, h) = node_at(index).layout_bounds;
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
    for (index, node) in plan.nodes {
        snapshot.nodes[index] = node;
    }
    super::snapshot::refresh_node_actions(snapshot, None);
    for (index, edge) in plan.edges {
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
