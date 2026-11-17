//! Ground player geometry shared by depth-tested rendering and pointer queries.
use super::layout::{self, SceneAreaLabelGeometry};
use crate::protocol::SceneArea;
use bevy::prelude::*;

pub(crate) fn geometry(area: &SceneArea, zoom: f32) -> Option<SceneAreaLabelGeometry> {
    let playback = area.playback.as_ref()?;
    if !playback.duration.is_finite() || playback.duration <= 0.0 || !playback.time.is_finite() {
        return None;
    }
    let corners = layout::scene_area_canvas_corners(&area.bounds)?;
    let right = (0..4).max_by(|&a, &b| corners[a].x.total_cmp(&corners[b].x))?;
    let bottom = (0..4).max_by(|&a, &b| corners[a].y.total_cmp(&corners[b].y))?;
    if right == bottom || ((right + 1) % 4 != bottom && (bottom + 1) % 4 != right) {
        return None;
    }
    let delta = corners[right] - corners[bottom];
    let length = delta.length();
    if !length.is_finite() || length < 0.001 {
        return None;
    }
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    let scale = (18.0 / (22.0 * zoom)).max(1.0).min(length * 0.72 / 248.0);
    Some(SceneAreaLabelGeometry {
        node_id: area.node_id.clone(),
        center: (corners[right] + corners[bottom]) * 0.5,
        axis: delta / length,
        width: 248.0 * scale,
        height: 22.0 * scale,
    })
}

pub(crate) fn track(geometry: &SceneAreaLabelGeometry) -> (Vec2, Vec2) {
    let s = geometry.scale();
    (
        geometry.center + geometry.axis * (-geometry.width * 0.5 + 32.0 * s),
        geometry.center + geometry.axis * (geometry.width * 0.5 - 112.0 * s),
    )
}

pub(crate) fn control(geometry: &SceneAreaLabelGeometry, point: Vec2) -> Option<&'static str> {
    let offset = point - geometry.center;
    if offset.dot(geometry.axis).abs() > geometry.width * 0.5
        || offset.dot(geometry.axis.perp()).abs() > geometry.height * 0.5
    {
        return None;
    }
    let x = offset.dot(geometry.axis) / geometry.scale();
    if x < -96.0 {
        Some("play")
    } else if x > 96.0 {
        Some("loop")
    } else if x <= 12.0 {
        Some("track")
    } else {
        Some("body")
    }
}
