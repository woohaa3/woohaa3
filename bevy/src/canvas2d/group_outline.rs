//! Rounded group perimeter shared by the steady run outline and travelling strokes.
use super::geometry::Geometry;
use bevy::prelude::*;

pub(super) fn path(node: &crate::protocol::GraphNode) -> Vec<Vec2> {
    crate::canvas_query::group_model::outline(node)
}

pub(super) fn length(path: &[Vec2]) -> f32 {
    path.windows(2).map(|p| p[0].distance(p[1])).sum()
}

/// Clip a stroke by arc length; wrap without a diagonal across the container.
#[allow(clippy::too_many_arguments)]
pub(super) fn stroke(
    geometry: &mut Geometry,
    path: &[Vec2],
    start: f32,
    span: f32,
    width: f32,
    z: f32,
    color: u32,
) {
    let perimeter = length(path);
    if perimeter <= 0. {
        return;
    }
    let start = start.rem_euclid(perimeter);
    for offset in [start, start - perimeter] {
        let mut distance = 0.;
        for edge in path.windows(2) {
            let len = edge[0].distance(edge[1]);
            let a = offset.max(distance);
            let b = (offset + span).min(distance + len);
            if b > a && len > 0. {
                let dir = (edge[1] - edge[0]) / len;
                geometry.line(
                    edge[0] + dir * (a - distance),
                    edge[0] + dir * (b - distance),
                    width,
                    z,
                    color,
                );
            }
            distance += len;
        }
    }
}
