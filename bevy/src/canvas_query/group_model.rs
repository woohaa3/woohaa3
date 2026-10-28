//! A compact identity badge fixed outside the group speech bubble.
//! The badge is rendered as a free-standing 3D mark below the bubble tail, while model fitting
//! and picking continue to share this geometry.
use crate::{
    model3d::{grid, scene::ModelAabb},
    protocol::{GraphNode, ModelPlacement},
};
use bevy::prelude::*;

pub(crate) const MODEL_MAX_WIDTH: f32 = 56.;
pub(crate) const MODEL_MAX_HEIGHT: f32 = 44.;
/// Gap between the speech-bubble body and the external badge.
pub(crate) const BADGE_OUTSET: f32 = 6.;
const PADDING: f32 = 10.;
const CORNER: f32 = 12.;
const HEADER_CLEARANCE: f32 = 32.;
const TAIL_BASE: f32 = 28.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GroupModelLayout {
    pub(crate) center: Vec2,
    pub(crate) radii: Vec2,
    pub(crate) anchor: Vec2,
    pub(crate) unit: f32,
}

/// No viewport, payload lease or mesh scan: these are accepted-scene presentation inputs.
pub(crate) fn for_node(node: &GraphNode) -> Option<GroupModelLayout> {
    let bounds = node.group.as_ref()?.model_bounds.as_ref()?;
    let placement = &node.model.as_ref()?.placement;
    Some(derive(
        node,
        ModelAabb::new(bounds.aabb.min, bounds.aabb.max),
        bounds.extent,
        placement,
    ))
}

pub(crate) fn derive(
    node: &GraphNode,
    local: ModelAabb,
    extent: f32,
    placement: &ModelPlacement,
) -> GroupModelLayout {
    let natural = 192. / extent.max(0.001);
    let rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let projected = local.transformed(&Transform {
        rotation,
        scale: Vec3::splat(natural),
        ..default()
    });
    let size =
        (Vec3::from_array(projected.max) - Vec3::from_array(projected.min)).max(Vec3::splat(0.001));
    let base_badge = base_badge_rect(node);
    let available_width = (base_badge.z - PADDING * 2.).clamp(1., MODEL_MAX_WIDTH);
    let available_height = (base_badge.w - 20.).clamp(1., MODEL_MAX_HEIGHT);
    let fit = (available_width / size.x).min(available_height / size.y);
    let factor = placement.scale.min(1.).max(0.001) * fit * badge_scale(node);
    let half = Vec2::new(size.x, size.y) * factor * 0.5;
    let radii = half;
    // Stable optical center: changing model aspect ratio must not move the identity within its badge.
    let badge = badge_rect(node);
    let center = Vec2::new(badge.x + badge.z / 2., badge.y + badge.w / 2.);
    let c = projected.center() * factor;
    // Group appearance stays at the bottom midpoint. Saved offsets cannot detach it from its frame.
    let anchor = center - Vec2::new(c.x, -c.y);
    GroupModelLayout {
        center,
        radii,
        anchor,
        unit: natural * factor,
    }
}

/// Standard badge dimensions in canvas units (1 unit = 1 CSS px at 1× zoom).
/// The badge starts below the structural group rectangle, leaving a small gap for the bubble tail.
fn base_badge_rect(node: &GraphNode) -> Vec4 {
    let width = (node.width - 32.).clamp(24., 88.);
    let height = (node.height - HEADER_CLEARANCE + BADGE_OUTSET).clamp(24., 64.);
    Vec4::new(
        node.x + (node.width - width) / 2.,
        node.y + node.height + BADGE_OUTSET,
        width,
        height,
    )
}

/// Independent presentation scale, bounded by the group header and side margins.
pub(crate) fn badge_scale(node: &GraphNode) -> f32 {
    let base = base_badge_rect(node);
    let center_y = base.y + base.w / 2.;
    let limit = ((node.width - 32.) / base.z)
        .min(2. * (center_y - node.y - HEADER_CLEARANCE) / base.w)
        .clamp(1., 2.5);
    node.group
        .as_ref()
        .map_or(1., |g| g.badge_scale)
        .clamp(0.5, 2.5)
        .min(limit)
}

pub(crate) fn badge_rect(node: &GraphNode) -> Vec4 {
    let base = base_badge_rect(node);
    let scale = badge_scale(node);
    let size = Vec2::new(base.z, base.w) * scale;
    // Keep the badge top fixed below the bubble. Scaling grows it downward, so it never
    // intrudes into the group body.
    let center = Vec2::new(base.x + base.z / 2., base.y + size.y / 2.);
    Vec4::new(
        center.x - size.x / 2.,
        center.y - size.y / 2.,
        size.x,
        size.y,
    )
}

pub(crate) fn badge_outset(node: &GraphNode) -> f32 {
    let rect = badge_rect(node);
    (rect.y + rect.w - node.y - node.height).max(0.)
}

/// Same center for the drawn corner affordance and accepted-scene picking.
pub(crate) fn resize_center(node: &GraphNode) -> Option<Vec2> {
    if !node.group.as_ref()?.badge_resizable || node.model.is_none() {
        return None;
    }
    let rect = badge_rect(node);
    Some(Vec2::new(rect.x + rect.z - 5., rect.y + rect.w - 5.))
}

pub(crate) fn badge_path(node: &GraphNode) -> Vec<Vec2> {
    if !has_badge(node) {
        return Vec::new();
    }
    rounded_rect_radius(badge_rect(node), CORNER * badge_scale(node))
}

/// Filled speech-bubble tail behind the free-standing 3D badge.
///
/// The tail tip meets the badge's top edge outside the group body, without adding a plate or
/// changing the group's structural layout bounds.
pub(crate) fn tail_path(node: &GraphNode) -> Vec<Vec2> {
    if !has_badge(node) {
        return Vec::new();
    }
    let badge = badge_rect(node);
    let center_x = node.x + node.width / 2.;
    let base_half = (TAIL_BASE * badge_scale(node) / 2.).min((node.width - 24.).max(8.) / 2.);
    let base_y = node.y + node.height;
    let tip_y = badge.y;
    vec![
        Vec2::new(center_x - base_half, base_y),
        Vec2::new(center_x, tip_y),
        Vec2::new(center_x + base_half, base_y),
    ]
}

/// 只有带模型身份的组才有底部徽标；3D 尾巴与徽标命中几何都用这一处判定。
pub(crate) fn has_badge(node: &GraphNode) -> bool {
    node.model.is_some() && node.group.is_some()
}

fn rounded_rect(rect: Vec4) -> Vec<Vec2> {
    rounded_rect_radius(rect, CORNER)
}
fn rounded_rect_radius(rect: Vec4, radius: f32) -> Vec<Vec2> {
    let (x, y, w, h) = (rect.x, rect.y, rect.z, rect.w);
    rounded_path(
        &[
            Vec2::new(x, y),
            Vec2::new(x + w, y),
            Vec2::new(x + w, y + h),
            Vec2::new(x, y + h),
        ],
        radius,
    )
}
fn rectangle(node: &GraphNode) -> Vec<Vec2> {
    rounded_rect(Vec4::new(node.x, node.y, node.width, node.height))
}

/// Group perimeter follows a speech-bubble tail, with no straight edge through the badge interior.
pub(crate) fn outline(node: &GraphNode) -> Vec<Vec2> {
    let rect = rectangle(node);
    let tail = tail_path(node);
    if tail.is_empty() {
        return rect;
    }
    let bottom = node.y + node.height;
    let mut outline = vec![rect[0]];
    for edge in rect.windows(2) {
        if (edge[0].y - bottom).abs() < 0.001
            && (edge[1].y - bottom).abs() < 0.001
            && edge[0].x > edge[1].x
        {
            // The rectangle path runs right → left along the bottom edge.
            outline.push(tail[2]);
            outline.push(tail[1]);
            outline.push(tail[0]);
        }
        outline.push(edge[1]);
    }
    outline
}

/// Open dashed group frame around the speech-bubble body and tail.
///
/// Start at the right tail join, draw both slanted tail edges first, then walk around the body
/// back to the right join. Starting on the tail gives its short slanted edges a fresh dash phase
/// instead of allowing the preceding long bottom edge to consume the whole visible dash. The
/// body bottom is split at the joins, so no horizontal segment can cross the tail base.
pub(crate) fn frame_path(node: &GraphNode) -> Vec<Vec2> {
    let rect = rectangle(node);
    let tail = tail_path(node);
    if tail.is_empty() {
        return rect;
    }
    let bottom = node.y + node.height;
    let Some(at) = rect.windows(2).position(|edge| {
        (edge[0].y - bottom).abs() < 0.001
            && (edge[1].y - bottom).abs() < 0.001
            && edge[0].x > edge[1].x
    }) else {
        return rect;
    };
    // Put the tail first. `dashed_polyline` is an open path and carries one phase across all
    // segments; beginning at the right join guarantees that both slanted edges contribute a
    // visible dash even when their length is shorter than one dash period.
    let mut frame = vec![tail[2], tail[1], tail[0]];
    frame.extend_from_slice(&rect[at + 1..rect.len() - 1]);
    frame.extend_from_slice(&rect[..=at]);
    frame.push(tail[2]);
    frame
}

pub(crate) fn fill_regions(node: &GraphNode) -> Vec<Vec<Vec2>> {
    vec![rectangle(node)]
}

/// Sampled quadratic fillets preserve the existing 12-unit rounded-corner language.
fn rounded_path(vertices: &[Vec2], radius: f32) -> Vec<Vec2> {
    let mut points = Vec::with_capacity(vertices.len() * 9 + 1);
    for (i, &corner) in vertices.iter().enumerate() {
        let prev = vertices[(i + vertices.len() - 1) % vertices.len()] - corner;
        let next = vertices[(i + 1) % vertices.len()] - corner;
        let trim = radius.min(prev.length() / 2.).min(next.length() / 2.);
        let a = corner + prev.normalize_or_zero() * trim;
        let b = corner + next.normalize_or_zero() * trim;
        for step in 0..=8 {
            let t = step as f32 / 8.;
            points.push((1. - t).powi(2) * a + 2. * (1. - t) * t * corner + t * t * b);
        }
    }
    points.push(points[0]);
    points
}

/// The drawn closed perimeter is also the interaction polygon; transparent outside corners stay empty.
pub(crate) fn path_contains(path: &[Vec2], point: Vec2) -> bool {
    let mut inside = false;
    for pair in path.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if (a.y > point.y) != (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
        {
            inside = !inside;
        }
    }
    inside
}

#[cfg(test)]
mod tests;
