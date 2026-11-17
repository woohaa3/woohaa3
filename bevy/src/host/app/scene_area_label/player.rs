//! The player uses the nameplate's exact ground plane, material layers and depth pipeline.
use super::*;
use crate::protocol::SceneAreaPlayback;

fn tint(a: u32, b: u32, amount: f32) -> u32 {
    let mut result = 0;
    for shift in [0, 8, 16] {
        let av = ((a >> shift) & 255) as f32;
        let bv = ((b >> shift) & 255) as f32;
        result |= ((av + (bv - av) * amount).round() as u32) << shift;
    }
    result
}
fn polygon(shape: &mut Geometry, g: &SceneAreaLabelGeometry, points: &[Vec2], color: u32) {
    let points: Vec<_> = points
        .iter()
        .map(|p| g.center + g.axis * p.x + g.axis.perp() * p.y)
        .collect();
    shape.polygon(&points, 0.0, color);
}
fn rect(
    shape: &mut Geometry,
    g: &SceneAreaLabelGeometry,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    color: u32,
) {
    polygon(
        shape,
        g,
        &crate::scope_visual::rounded_path(x, y, width, height, height.min(width) * 0.25),
        color,
    );
}
fn line(shape: &mut Geometry, g: &SceneAreaLabelGeometry, a: Vec2, b: Vec2, color: u32) {
    let a = g.center + g.axis * a.x + g.axis.perp() * a.y;
    let b = g.center + g.axis * b.x + g.axis.perp() * b.y;
    shape.line(a, b, 1.4 * g.scale(), 0.0, color);
}
pub(super) fn mesh(
    g: &SceneAreaLabelGeometry,
    style: ScopeStyle,
    state: &SceneAreaPlayback,
    theme: &ThemeResource,
) -> Mesh {
    let mut shape = Geometry::default();
    let s = g.scale();
    let ink = style.label_text;
    let left = -g.width * 0.5;
    let right = g.width * 0.5;
    let selected = style.label_fill == theme.token_u32("canvasNodeBorderSelected");
    let play = left + 16.0 * s;
    if state.playing {
        for x in [-3.5, 1.5] {
            rect(
                &mut shape,
                g,
                play + x * s,
                -5.0 * s,
                2.0 * s,
                10.0 * s,
                ink,
            );
        }
    } else {
        polygon(
            &mut shape,
            g,
            &[
                Vec2::new(play - 3.0 * s, -5.0 * s),
                Vec2::new(play + 4.0 * s, 0.0),
                Vec2::new(play - 3.0 * s, 5.0 * s),
            ],
            ink,
        );
    }
    let track_x = left + 32.0 * s;
    let track_width = g.width - 144.0 * s;
    let track = if selected {
        tint(style.label_fill, ink, 0.2)
    } else {
        theme.token_u32("canvasProgressTrack")
    };
    let fill = if selected {
        tint(style.label_fill, ink, 0.5)
    } else {
        theme.token_u32("canvasProgressFill")
    };
    let progress = (state.time / state.duration).clamp(0.0, 1.0);
    let head = track_x + (track_width - 2.0 * s) * progress;
    // Disjoint ink shapes avoid coplanar self-overlap at grazing ground angles.
    if head > track_x {
        rect(
            &mut shape,
            g,
            track_x,
            -4.0 * s,
            head - track_x,
            8.0 * s,
            fill,
        );
    }
    rect(&mut shape, g, head, -5.0 * s, 2.0 * s, 10.0 * s, ink);
    let rest = track_x + track_width - head - 2.0 * s;
    if rest > 0.0 {
        rect(
            &mut shape,
            g,
            head + 2.0 * s,
            -4.0 * s,
            rest,
            8.0 * s,
            track,
        );
    }
    let center = Vec2::new(right - 16.0 * s, 0.0);
    let loop_ink = if state.r#loop {
        ink
    } else {
        tint(style.label_fill, ink, 0.45)
    };
    let radius = 5.0 * s;
    let at = |i: usize| {
        let a = (i as f32 * 300.0 / 16.0 - 60.0).to_radians();
        center + Vec2::new(a.cos(), a.sin()) * radius
    };
    for i in 0..16 {
        line(&mut shape, g, at(i), at(i + 1), loop_ink);
    }
    let end = at(16);
    line(&mut shape, g, end, end + Vec2::new(3.0, -1.0) * s, loop_ink);
    line(
        &mut shape,
        g,
        end,
        end + Vec2::new(-1.0, -3.0) * s,
        loop_ink,
    );
    ground_mesh(shape)
}
