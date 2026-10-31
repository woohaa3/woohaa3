use super::{GizmoLine, GizmoView, RING_SEGMENTS, hit_lines};
use bevy::math::{Vec2, Vec3};

/// Real rig geometry: cage radius is full eye-to-focus distance, unrelated to handle size.
pub fn shot_gizmo_layout(
    view: &GizmoView,
    focus: Vec3,
    position: Vec3,
    fov: f32,
    aspect: f32,
    tool: &str,
) -> Vec<GizmoLine> {
    let radius = position.distance(focus);
    if !radius.is_finite()
        || radius <= 1e-5
        || !fov.is_finite()
        || !(0.01..3.13).contains(&fov)
        || !aspect.is_finite()
        || aspect <= 0.0
    {
        return Vec::new();
    }
    let mut lines = Vec::with_capacity(128);
    let delta = position - focus;
    let radial = Vec3::new(delta.x, 0.0, delta.z)
        .try_normalize()
        .unwrap_or(Vec3::Z);
    for (handle, segments) in [
        ("orbit-ring", RING_SEGMENTS),
        ("elevation-ring", RING_SEGMENTS / 2),
    ] {
        let point = |i: usize| {
            if handle == "orbit-ring" {
                let a = i as f32 / segments as f32 * std::f32::consts::TAU;
                focus + Vec3::new(a.cos(), 0.0, a.sin()) * radius
            } else {
                let a = -std::f32::consts::FRAC_PI_2
                    + i as f32 / segments as f32 * std::f32::consts::PI;
                focus + (radial * a.cos() + Vec3::Y * a.sin()) * radius
            }
        };
        for i in 0..segments {
            let start = point(i);
            let end = point(i + 1);
            let rear = ((start + end) * 0.5 - focus).dot(view.position - focus) < 0.0;
            let secondary = if handle == "orbit-ring" {
                tool != "orbit"
            } else {
                tool != "elevation"
            };
            lines.push(GizmoLine {
                shape: super::GizmoShape::Stroke,
                start,
                end,
                width_css: if secondary { 1.0 } else { 3.0 },
                handle,
                secondary,
                rear,
                visible: !rear || i % 2 == 0,
            });
        }
    }
    let forward = (focus - position) / radius;
    let right = forward.cross(Vec3::Y).try_normalize().unwrap_or(view.right);
    let up = right.cross(forward).normalize();
    let mut line = |start, end, handle, secondary| {
        lines.push(GizmoLine {
            shape: super::GizmoShape::Stroke,
            start,
            end,
            width_css: if secondary { 1.0 } else { 3.0 },
            handle,
            secondary,
            rear: false,
            visible: true,
        })
    };
    line(position, focus, "distance", tool != "distance");
    // A real lens frustum at a world depth. Only its line width is a CSS size.
    let depth = radius * 0.24;
    let half_height = depth * (fov * 0.5).tan();
    let corners = rectangle(
        position + forward * depth,
        right * half_height * aspect,
        up * half_height,
    );
    for i in 0..4 {
        line(position, corners[i], "", true);
        line(corners[i], corners[(i + 1) % 4], "", true);
    }
    // Compact wire camera, longest body envelope 22 CSS px. No solid origin sphere.
    if let Some(scale) = view.world_per_css(position) {
        let half_width = 8.0 * scale;
        let half_height = 5.0 * scale;
        let back = rectangle(
            position - forward * scale * 6.0,
            right * half_width,
            up * half_height,
        );
        let front = rectangle(
            position + forward * scale * 6.0,
            right * half_width,
            up * half_height,
        );
        for i in 0..4 {
            line(
                back[i],
                back[(i + 1) % 4],
                "shot-origin",
                tool != "distance",
            );
            line(
                front[i],
                front[(i + 1) % 4],
                "shot-origin",
                tool != "distance",
            );
            line(back[i], front[i], "shot-origin", tool != "distance");
        }
        let lens = rectangle(
            position + forward * scale * 11.0,
            right * scale * 4.0,
            up * scale * 3.0,
        );
        for i in 0..4 {
            line(front[i], lens[i], "shot-origin", tool != "distance");
            line(
                lens[i],
                lens[(i + 1) % 4],
                "shot-origin",
                tool != "distance",
            );
        }
    }
    if let Some(scale) = view.world_per_css(position) {
        lines.push(GizmoLine {
            shape: super::GizmoShape::Cone,
            start: position + forward * scale * 6.0,
            end: position + forward * scale * 14.0,
            width_css: 7.0,
            handle: "shot-origin",
            secondary: tool != "distance",
            rear: false,
            visible: true,
        });
    }
    lines
}

fn rectangle(center: Vec3, right: Vec3, up: Vec3) -> [Vec3; 4] {
    [
        center - right - up,
        center + right - up,
        center + right + up,
        center - right + up,
    ]
}

pub fn hit_shot_layout(
    lines: &[GizmoLine],
    view: &GizmoView,
    position: Vec3,
    pointer: Vec2,
) -> Option<&'static str> {
    if lines.iter().any(|line| {
        line.handle == "shot-origin"
            && view.project(line.start).is_some()
            && view.project(line.end).is_some()
    }) && let Some(center) = view.project(position)
        && pointer.distance(center) <= 11.0
    {
        return Some("shot-origin");
    }
    hit_lines(lines, view, pointer).map(|(h, _)| h)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn orbit_uses_real_distance_and_rear_dashes_remain_pickable() {
        let view =
            GizmoView::orbit(Vec3::ZERO, 0.7, -0.5, 30.0, Vec2::new(1200.0, 800.0), 1.0).unwrap();
        let lines = shot_gizmo_layout(
            &view,
            Vec3::ZERO,
            Vec3::new(0.0, 3.0, 4.0),
            1.0,
            1.777,
            "orbit",
        );
        let orbit: Vec<_> = lines.iter().filter(|l| l.handle == "orbit-ring").collect();
        assert_eq!(orbit.len(), 64);
        assert!(orbit.iter().all(|l| (l.start.length() - 5.0).abs() < 1e-4));
        assert!(orbit.iter().any(|l| l.rear && !l.visible));
        assert!(
            lines
                .iter()
                .filter(|l| l.handle == "elevation-ring")
                .all(|l| l.secondary)
        );
        let rear = orbit.iter().find(|l| l.rear && !l.visible).unwrap();
        assert!(
            hit_shot_layout(
                &lines,
                &view,
                Vec3::new(0.0, 3.0, 4.0),
                view.project((rear.start + rear.end) * 0.5).unwrap()
            )
            .is_some()
        );
    }
}
