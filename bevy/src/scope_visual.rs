//! Shared presentation rules for 2D workflow groups and ground scene areas.
//! Only hover fades (120ms); selection takes effect immediately and wins over hover.
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]
#[cfg(feature = "canvas-core")]
use crate::protocol::NodeChrome;
use crate::{protocol::Scene, theme::ThemeResource};
use bevy::prelude::*;
use std::collections::HashMap;
#[cfg(feature = "canvas-core")]
use std::collections::HashSet;

pub(crate) const FRAME_RADIUS: f32 = 12.0;
pub(crate) const LABEL_RADIUS: f32 = 6.0;
pub(crate) const LABEL_PADDING: f32 = 8.0;
/// Shared world height for scene-area outlines and their nameplates.
pub(crate) const GROUND_SCOPE_HEIGHT: f32 = 0.025;

/// Shared rounded path; painting and hit geometry use exactly the same corners.
pub(crate) fn rounded_path(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Vec<Vec2> {
    let radius = radius.min(width / 2.0).min(height / 2.0).max(0.0);
    let mut points = Vec::with_capacity(36);
    for (cx, cy, start) in [
        (x + width - radius, y + height - radius, 0.0),
        (x + radius, y + height - radius, std::f32::consts::FRAC_PI_2),
        (x + radius, y + radius, std::f32::consts::PI),
        (x + width - radius, y + radius, std::f32::consts::PI * 1.5),
    ] {
        for step in 0..=8 {
            let angle = start + step as f32 * std::f32::consts::PI / 16.0;
            points.push(Vec2::new(
                cx + radius * angle.cos(),
                cy + radius * angle.sin(),
            ));
        }
    }
    points
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScopeStyle {
    pub(crate) border: u32,
    pub(crate) width: f32,
    pub(crate) tint: f32,
    pub(crate) label_fill: u32,
    pub(crate) label_text: u32,
}

impl ScopeStyle {
    pub(crate) fn for_node(scene: &Scene, theme: &ThemeResource, id: &str) -> Self {
        Self::resolve(
            theme,
            scene.selection.nodes.iter().any(|selected| selected == id),
            if scene
                .hover
                .as_ref()
                .and_then(|hover| hover.node_id.as_deref())
                == Some(id)
            {
                1.0
            } else {
                0.0
            },
        )
    }

    pub(crate) fn resolve(theme: &ThemeResource, selected: bool, hover: f32) -> Self {
        Self {
            border: if selected {
                theme.token_u32("canvasNodeBorderSelected")
            } else {
                mix(
                    theme.token_u32("canvasEdgeDefault"),
                    theme.token_u32("webBorderStrong"),
                    hover,
                )
            },
            width: if selected { 2.0 } else { 1.25 + 0.25 * hover },
            tint: if selected { 0.05 } else { 0.03 * hover },
            label_fill: theme.token_u32(if selected {
                "canvasNodeBorderSelected"
            } else {
                "canvasNodeSurface"
            }),
            label_text: if selected {
                theme.token_u32("interactionOnAccent")
            } else {
                mix(
                    theme.token_u32("canvasBodyText"),
                    theme.token_u32("webTextPrimary"),
                    hover,
                )
            },
        }
    }
}

/// Slow execution breath shared by 2D and ground scope borders (1.8 seconds).
/// Opaque line color carries the breath even on retained 3D materials and selected frames.
/// The second value only controls the optional 2D halo, never the main stroke's opacity.
pub(crate) fn execution_border(theme: &ThemeResource, seconds: f32) -> (u32, f32) {
    let breath = 0.5 - 0.5 * (seconds * std::f32::consts::TAU / 1.8).cos();
    (
        mix(
            theme.token_u32("webBackdrop"),
            theme.token_u32("interactionAccent"),
            0.25 + 0.75 * breath,
        ),
        0.25 + 0.75 * breath,
    )
}

pub(crate) const EXECUTION_TRAIL_STEPS: usize = 8;

pub(crate) struct ExecutionSegment {
    pub(crate) start: Vec2,
    pub(crate) end: Vec2,
    pub(crate) step: usize,
}

pub(crate) fn execution_trail_strength(step: usize) -> f32 {
    ((step + 1) as f32 / EXECUTION_TRAIL_STEPS as f32).powf(1.5)
}

/// Two short comet trails travel around the real closed contour every 3.2 seconds.
/// Splitting by arc length keeps speed continuous through corners and across the seam.
pub(crate) fn execution_trail(points: &[Vec2], seconds: f32) -> Vec<ExecutionSegment> {
    if points.len() < 2 || !seconds.is_finite() {
        return Vec::new();
    }
    let lengths: Vec<_> = (0..points.len())
        .map(|i| points[i].distance(points[(i + 1) % points.len()]))
        .collect();
    let perimeter: f32 = lengths.iter().sum();
    if !perimeter.is_finite() || perimeter <= 0.001 {
        return Vec::new();
    }
    let mut segments = Vec::new();
    for offset in [0.0, 0.5] {
        let head = ((seconds / 3.2 + offset).rem_euclid(1.0) + 1.0) * perimeter;
        for step in 0..EXECUTION_TRAIL_STEPS {
            let start =
                head - perimeter * 0.12 * (1.0 - step as f32 / EXECUTION_TRAIL_STEPS as f32);
            let end =
                head - perimeter * 0.12 * (1.0 - (step + 1) as f32 / EXECUTION_TRAIL_STEPS as f32);
            let mut distance = 0.0;
            for _ in 0..2 {
                for (i, length) in lengths.iter().copied().enumerate() {
                    let from = start.max(distance);
                    let to = end.min(distance + length);
                    if length > 0.001 && to - from > 0.001 {
                        let a = points[i];
                        let b = points[(i + 1) % points.len()];
                        segments.push(ExecutionSegment {
                            start: a.lerp(b, ((from - distance) / length).clamp(0.0, 1.0)),
                            end: a.lerp(b, ((to - distance) / length).clamp(0.0, 1.0)),
                            step,
                        });
                    }
                    distance += length;
                }
            }
        }
    }
    segments
}

pub(crate) fn execution_trail_color(theme: &ThemeResource, seconds: f32, step: usize) -> u32 {
    // Deep green on light surfaces, a luminous mint on dark surfaces: the head must
    // stand out from both the canvas and the breathing baseline in either theme.
    let highlight = mix(
        theme.token_u32("interactionAccent"),
        theme.token_u32("webTextPrimary"),
        0.5,
    );
    mix(
        execution_border(theme, seconds).0,
        highlight,
        execution_trail_strength(step),
    )
}

fn mix(a: u32, b: u32, t: f32) -> u32 {
    [16, 8, 0].into_iter().fold(0, |out, shift| {
        let a = ((a >> shift) & 255) as f32;
        let b = ((b >> shift) & 255) as f32;
        out | (((a + (b - a) * t.clamp(0.0, 1.0)).round() as u32) << shift)
    })
}

#[derive(Default)]
struct HoverFade {
    value: f32,
    from: f32,
    target: f32,
    elapsed: f32,
}
impl HoverFade {
    fn advance(&mut self, target: f32, delta: f32) {
        if self.target != target {
            self.from = self.value;
            self.target = target;
            self.elapsed = 0.0;
        }
        self.elapsed = (self.elapsed + delta).min(0.12);
        let t = self.elapsed / 0.12;
        self.value = self.from + (self.target - self.from) * (1.0 - (1.0 - t).powi(3));
    }
}

#[derive(Resource, Default)]
pub(crate) struct ScopeVisuals {
    hover: HashMap<String, HoverFade>,
    styles: HashMap<String, ScopeStyle>,
    pub(crate) revision: u64,
}
impl ScopeVisuals {
    pub(crate) fn style(&self, scene: &Scene, theme: &ThemeResource, id: &str) -> ScopeStyle {
        self.styles
            .get(id)
            .copied()
            .unwrap_or_else(|| ScopeStyle::for_node(scene, theme, id))
    }
}

#[cfg(feature = "canvas-core")]
pub(crate) fn sync(
    scene: Res<crate::app::CurrentScene>,
    theme: Res<ThemeResource>,
    time: Res<Time>,
    mut visuals: ResMut<ScopeVisuals>,
) {
    if !scene.is_changed()
        && !theme.is_changed()
        && !visuals.hover.values().any(|fade| fade.value != fade.target)
    {
        return;
    }
    let ids: HashSet<_> = scene
        .0
        .nodes
        .iter()
        .filter(|node| matches!(node.chrome, NodeChrome::Frame { .. }))
        .map(|node| node.id.clone())
        .chain(scene.0.scene_areas.iter().map(|area| area.node_id.clone()))
        .collect();
    let mut changed = visuals.styles.len() != ids.len();
    visuals.hover.retain(|id, _| ids.contains(id));
    visuals.styles.retain(|id, _| ids.contains(id));
    for id in ids {
        let selected = scene.0.selection.nodes.contains(&id);
        let hovered = scene
            .0
            .hover
            .as_ref()
            .and_then(|hover| hover.node_id.as_deref())
            == Some(id.as_str());
        let fade = visuals.hover.entry(id.clone()).or_default();
        fade.advance(if hovered { 1.0 } else { 0.0 }, time.delta_secs());
        let style = ScopeStyle::resolve(&theme, selected, fade.value);
        changed |= visuals.styles.insert(id, style) != Some(style);
    }
    if changed {
        visuals.revision = visuals.revision.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_trails_follow_the_perimeter_through_corners_and_wrap_continuously() {
        let path = [Vec2::ZERO, Vec2::new(100.0, 0.0), Vec2::new(100.0, 60.0), Vec2::new(0.0, 60.0)];
        let on_edge = |point: Vec2| {
            point.x >= -0.001 && point.x <= 100.001 && point.y >= -0.001 && point.y <= 60.001
                && (point.x.abs() < 0.001 || (point.x - 100.0).abs() < 0.001
                    || point.y.abs() < 0.001 || (point.y - 60.0).abs() < 0.001)
        };
        for seconds in [0.0, 0.4, 1.6, 3.19, 3.2] {
            let trail = execution_trail(&path, seconds);
            assert!(trail.len() <= 2 * (EXECUTION_TRAIL_STEPS + 4));
            assert!(trail.iter().all(|segment| on_edge(segment.start) && on_edge(segment.end)));
            let length: f32 = trail.iter().map(|segment| segment.start.distance(segment.end)).sum();
            assert!((length - 320.0 * 0.24).abs() < 0.001, "trail must not disappear at the seam");
        }
        let start = execution_trail(&path, 0.0);
        let moved = execution_trail(&path, 0.4);
        let looped = execution_trail(&path, 3.2);
        assert_ne!(start[0].start, moved[0].start);
        assert_eq!(start[0].start, looped[0].start);
        assert!(execution_trail(&[Vec2::ZERO; 4], 1.0).is_empty());
    }

    #[test]
    fn execution_stroke_has_a_clear_periodic_light_dark_range_in_both_themes() {
        for (background, accent, foreground) in [("#f3f6f4", "#16846c", "#30443a"), ("#101713", "#55c9a7", "#e6efe9")] {
            let mut theme = ThemeResource::default();
            theme.0.tokens.insert("webBackdrop".into(), background.into());
            theme.0.tokens.insert("interactionAccent".into(), accent.into());
            theme.0.tokens.insert("webTextPrimary".into(), foreground.into());
            let (low, _) = execution_border(&theme, 0.0);
            let (high, _) = execution_border(&theme, 0.9);
            let luminance = |color: u32| {
                let channel = |shift: u32| ((color >> shift) & 255_u32) as f32 / 255.0;
                channel(16) * 0.2126 + channel(8) * 0.7152 + channel(0) * 0.0722
            };
            assert!(
                (luminance(high) - luminance(low)).abs() > 0.25,
                "execution must change the visible stroke, including in dark themes"
            );
            assert_eq!(high, theme.token_u32("interactionAccent"));
            let head = execution_trail_color(&theme, 0.9, EXECUTION_TRAIL_STEPS - 1);
            let backdrop = luminance(theme.token_u32("webBackdrop"));
            assert!((luminance(head) - backdrop).abs() > (luminance(high) - backdrop).abs(),
                "the traveling head must stand out from the breathing border in both themes");
            assert_eq!(execution_border(&theme, 0.0), execution_border(&theme, 1.8));
        }
    }

    #[test]
    fn selection_wins_over_hover_and_follows_theme() {
        let mut theme = ThemeResource::default();
        theme
            .0
            .tokens
            .insert("canvasNodeBorderSelected".into(), "#123456".into());
        assert_eq!(
            ScopeStyle::resolve(&theme, true, 0.0),
            ScopeStyle::resolve(&theme, true, 1.0)
        );
        assert_eq!(ScopeStyle::resolve(&theme, true, 1.0).border, 0x123456);
    }
    #[test]
    fn hover_reversal_starts_from_current_color_and_finishes_in_120ms() {
        let mut fade = HoverFade::default();
        fade.advance(1.0, 0.06);
        assert!(fade.value > 0.0 && fade.value < 1.0);
        let halfway = fade.value;
        fade.advance(0.0, 0.0);
        assert_eq!(fade.value, halfway);
        fade.advance(0.0, 0.12);
        assert_eq!(fade.value, 0.0);
    }
}
