//! Runtime-only geometry quality. Canonical descriptors and bounds never change.
use crate::protocol::{GraphNode, ModelSnapshot, Scene};

pub(crate) const QUALITY_VERSION: u32 = 3;
pub(crate) const PREVIEW_FIT_MARGIN: f32 = 1.12;
pub(crate) fn preview_fit_angle(aspect: f32) -> f32 {
    let half = crate::orbit_camera::ORBIT_DEFAULT_FOV * 0.5;
    half.min((half.tan() * aspect).atan())
}
pub(crate) fn preview_fit_distance(radius: f32, aspect: f32) -> f32 {
    let effective = preview_fit_angle(aspect);
    let floor = 0.4_f32.max(radius * 0.5);
    (radius * PREVIEW_FIT_MARGIN / effective.sin()).clamp(floor, 10_000_000_f32.max(floor))
}

/// Highest consumer requirement owns a shared root representation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewPurpose {
    Card,
    Focus,
    Edit,
    Selected,
    Capture,
    Export,
    World,
}
impl ViewPurpose {
    pub(crate) fn requires_high(self) -> bool {
        matches!(
            self,
            Self::Focus | Self::Edit | Self::Selected | Self::Capture | Self::Export | Self::World
        )
    }
    pub(crate) fn select(self, metric: f32, current: Quality) -> Quality {
        if self.requires_high() {
            Quality::High
        } else {
            Quality::for_pixels(metric, current)
        }
    }
}
pub(super) fn purpose(
    node: &GraphNode,
    scene: &Scene,
    focus: Option<&str>,
    capture: bool,
) -> ViewPurpose {
    if capture {
        ViewPurpose::Capture
    } else if scene
        .model_editor
        .as_ref()
        .is_some_and(|e| e.node_id == node.id)
    {
        ViewPurpose::Edit
    } else if focus == Some(node.id.as_str())
        || scene
            .model_focus
            .as_ref()
            .is_some_and(|f| f.node_id == node.id)
    {
        ViewPurpose::Focus
    } else if node.model_preview.is_none() {
        ViewPurpose::World
    } else {
        ViewPurpose::Card
    }
}

/// Exact card visibility, without the demand/prewarm margin. Unknown surfaces
/// stay conservative for native callers. Focus/edit/capture bypass this gate.
pub(super) fn card_visible(node: &GraphNode, scene: &Scene, focus: Option<&str>) -> bool {
    if (focus.is_some() || scene.model_focus.is_some())
        && !crate::canvas_query::focus_context::contains(scene, &node.id)
    {
        return false;
    }
    let Some(surface) = scene.surface.as_ref() else {
        return true;
    };
    if !surface.width.is_finite()
        || !surface.height.is_finite()
        || surface.width <= 0.0
        || surface.height <= 0.0
    {
        return true;
    }
    let display = crate::canvas_query::focus_context::node(scene, node);
    let (x, y, width, height) = crate::canvas_query::layout::content_rect(&display);
    let [vx, vy, zoom] = crate::canvas_query::focus_context::viewport(scene);
    x * zoom + vx < surface.width
        && (x + width) * zoom + vx > 0.0
        && y * zoom + vy < surface.height
        && (y + height) * zoom + vy > 0.0
}

pub(super) fn initial(
    node: &GraphNode,
    scene: &Scene,
    focus: Option<&str>,
    capture: bool,
    resource: &ModelSnapshot,
) -> Quality {
    if purpose(node, scene, focus, capture).requires_high() {
        Quality::High
    } else if !card_visible(node, scene, focus) {
        Quality::Low
    } else {
        desired(node, scene, focus, Quality::Medium, resource)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Quality {
    Low,
    Medium,
    #[default]
    High,
}
impl Quality {
    pub(super) fn tier(self) -> Self {
        self
    }
    pub(super) fn subdivisions(self) -> (u32, u32, u32) {
        match self {
            Self::Low => (8, 4, 4),
            Self::Medium => (super::scene::CAPSULE_LONGITUDES * 2 / 3, 8, 4),
            Self::High => (
                super::scene::SPHERE_SECTORS,
                super::scene::SPHERE_STACKS,
                super::scene::CAPSULE_LATITUDES,
            ),
        }
    }
    /// A dead band around both thresholds prevents wheel/pinch oscillation.
    pub(super) fn for_pixels(pixels: f32, current: Self) -> Self {
        if !pixels.is_finite() || pixels <= 0.0 {
            return Self::High;
        }
        match current {
            Self::Low if pixels < 224.0 => Self::Low,
            Self::High if pixels > 448.0 => Self::High,
            _ if pixels < 176.0 => Self::Low,
            _ if pixels > 576.0 => Self::High,
            _ => Self::Medium,
        }
    }

}

/// Shared entities use the highest consumer requirement. Focus/edit/capture use
/// the same focused root; the transition owner also pins high through readback.
pub(super) fn desired(
    node: &GraphNode,
    scene: &Scene,
    focus: Option<&str>,
    current: Quality,
    resource: &ModelSnapshot,
) -> Quality {
    let purpose = purpose(node, scene, focus, false);
    if purpose.requires_high() {
        return Quality::High;
    }
    let dpr = scene.surface.as_ref().map_or(1.0, |s| s.pixel_ratio);
    let display = crate::canvas_query::focus_context::node(scene, node);
    let (_, _, width, height) = crate::canvas_query::layout::content_rect(&display);
    let radius = node
        .model
        .as_ref()
        .and_then(|reference| {
            super::layout::model_bounds_for_node(resource, &reference.placement, node)
        })
        .map(|(bounds, _)| {
            (bevy::prelude::Vec3::from_array(bounds.max)
                - bevy::prelude::Vec3::from_array(bounds.min))
            .length()
                * 0.5
        });
    let Some(radius) = radius.filter(|radius| radius.is_finite()) else {
        return Quality::High;
    };
    let distance_scale = node
        .model_preview
        .as_ref()
        .map_or(1.0, |view| view.distance_scale);
    let metric = projected_card_pixels(
        width,
        height,
        crate::canvas_query::focus_context::viewport(scene)[2],
        dpr,
        distance_scale,
        radius,
    );
    purpose.select(metric, current)
}

/// Conservative projected bounding-sphere diameter for the card's perspective lens.
/// Applies exactly the same distance floors/caps as preview framing, using prepared
/// bounds rather than vertex traversal. 中心平面高度换算对透视/正交等价
/// （`2·d·tan(fov/2)`），因此改投影不改变分档数值。
fn projected_card_pixels(
    width: f32,
    height: f32,
    zoom: f32,
    dpr: f32,
    distance_scale: f32,
    radius: f32,
) -> f32 {
    if !radius.is_finite() || radius < 0.0 {
        return f32::INFINITY;
    }
    if [width, height, zoom, dpr, distance_scale]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0)
    {
        return f32::INFINITY;
    }
    let radius = radius.max(0.01);
    let distance = preview_fit_distance(radius, width.max(1.0) / height.max(1.0)) * distance_scale;
    let viewport_height = crate::orbit_camera::orthographic_viewport_height(
        distance,
        crate::orbit_camera::ORBIT_DEFAULT_FOV,
    );
    height.max(1.0) * zoom * dpr * 2.0 * radius / viewport_height
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_consumers_pin_high_independent_of_pixel_budget() {
        for purpose in [
            ViewPurpose::Focus,
            ViewPurpose::Edit,
            ViewPurpose::Selected,
            ViewPurpose::Capture,
            ViewPurpose::Export,
            ViewPurpose::World,
        ] {
            assert!(purpose.requires_high());
            assert_eq!(purpose.select(1., Quality::Low), Quality::High);
        }
        assert!(!ViewPurpose::Card.requires_high());
        assert_eq!(ViewPurpose::Card.select(1., Quality::Medium), Quality::Low);
    }
    #[test]
    fn card_projection_accounts_for_lens_scale_and_physical_pixels() {
        let base = projected_card_pixels(800., 400., 1., 1., 1., 1.);
        assert!((projected_card_pixels(800., 400., 2., 2., 1., 1.) - base * 4.).abs() < 0.001);
        assert!((projected_card_pixels(800., 400., 1., 1., 4., 1.) - base / 4.).abs() < 0.001);
        assert_eq!(
            Quality::for_pixels(base / 4., Quality::Medium),
            Quality::Low
        );
        assert_eq!(
            Quality::for_pixels(base * 4., Quality::Medium),
            Quality::High
        );
        assert!(projected_card_pixels(800., 400., 1., 1., 1., 1e8) > base);
        assert!(projected_card_pixels(800., 400., 1., 1., 1., 0.001) < base);
        let portrait = projected_card_pixels(200., 800., 1., 1., 1., 1.);
        assert!(portrait < base && portrait > 0.);
        for scale in [0., -1., f32::NAN, f32::INFINITY] {
            assert_eq!(
                Quality::for_pixels(
                    projected_card_pixels(800., 400., 1., 1., scale, 1.),
                    Quality::Low
                ),
                Quality::High
            );
        }
    }
    #[test]
    fn thresholds_have_dead_bands_and_invalid_values_are_conservative() {
        assert_eq!(Quality::for_pixels(200., Quality::Low), Quality::Low);
        assert_eq!(Quality::for_pixels(200., Quality::Medium), Quality::Medium);
        assert_eq!(Quality::for_pixels(500., Quality::High), Quality::High);
        assert_eq!(Quality::for_pixels(500., Quality::Medium), Quality::Medium);
        assert_eq!(Quality::for_pixels(160., Quality::High), Quality::Low);
        assert_eq!(Quality::for_pixels(600., Quality::Low), Quality::High);
        for p in [0., -1., f32::NAN, f32::INFINITY] {
            assert_eq!(Quality::for_pixels(p, Quality::Low), Quality::High);
        }
    }
}
