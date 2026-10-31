//! Disposable screen geometry shared by drawing and picking. No document or host dependencies.
mod object;
pub mod render;
mod shot;
mod view;
pub use object::*;
pub use shot::*;
pub use view::*;

use bevy::math::{Vec2, Vec3};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GizmoShape {
    Stroke,
    Cone,
    Cube,
}

#[derive(Clone, Debug)]
pub struct GizmoLine {
    pub shape: GizmoShape,
    pub start: Vec3,
    pub end: Vec3,
    pub width_css: f32,
    pub handle: &'static str,
    pub secondary: bool,
    pub rear: bool,
    pub visible: bool,
}

pub fn segment_distance(point: Vec2, a: Vec2, b: Vec2) -> f32 {
    let delta = b - a;
    let t = if delta.length_squared() > 1e-8 {
        ((point - a).dot(delta) / delta.length_squared()).clamp(0.0, 1.0)
    } else {
        0.0
    };
    point.distance(a + delta * t)
}

/// Hidden dashes remain in the continuous corridor; clipped geometry never participates.
pub fn hit_lines(
    lines: &[GizmoLine],
    view: &GizmoView,
    pointer: Vec2,
) -> Option<(&'static str, f32)> {
    let mut best: Option<(&'static str, f32, bool)> = None;
    for line in lines {
        if line.handle.is_empty() {
            continue;
        }
        let (Some(a), Some(b)) = (view.project(line.start), view.project(line.end)) else {
            continue;
        };
        let distance = segment_distance(pointer, a, b) / 9.0;
        if distance <= 1.0
            && best.is_none_or(|(_, d, rear)| {
                distance < d - 1e-4 || ((distance - d).abs() <= 1e-4 && rear && !line.rear)
            })
        {
            best = Some((line.handle, distance, line.rear));
        }
    }
    best.map(|(h, d, _)| (h, d))
}
