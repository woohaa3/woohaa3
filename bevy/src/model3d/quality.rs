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
///
/// 模型卡片预览已删除：`World` 是普通画布上唯一的默认用途，按世界相机下的实际投影占比
/// 分档（change: 2026-11-10-remove-legacy-model-card-nodes）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewPurpose {
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
            Self::Focus | Self::Edit | Self::Selected | Self::Capture | Self::Export
        )
    }
    pub(crate) fn select(self, metric: f32, current: Quality) -> Quality {
        if self.requires_high() {
            Quality::High
        } else {
            Quality::for_fraction(metric, current)
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
    } else {
        ViewPurpose::World
    }
}

/// Exact card visibility, without the demand/prewarm margin. Unknown surfaces
/// stay conservative for native callers. Focus/edit/capture bypass this gate.
///
/// 共享世界模型没有卡片：它始终参与世界绘制，因此不做卡片矩形裁剪。
pub(super) fn card_visible(node: &GraphNode, scene: &Scene, focus: Option<&str>) -> bool {
    if !matches!(node.chrome, crate::protocol::NodeChrome::Card) {
        return true;
    }
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
    /// 世界投影占比的档位阈值（带死区）。占比 = 投影直径 ÷ 可视窗口高度。
    pub(super) fn for_fraction(fraction: f32, current: Self) -> Self {
        if !fraction.is_finite() || fraction <= 0.0 {
            return Self::High;
        }
        const HIGH_ON: f32 = 0.45;
        const HIGH_OFF: f32 = 0.36;
        const LOW_ON: f32 = 0.12;
        const LOW_OFF: f32 = 0.09;
        match current {
            Self::Low if fraction < LOW_OFF => Self::Low,
            Self::High if fraction > HIGH_OFF => Self::High,
            _ if fraction < LOW_ON => Self::Low,
            _ if fraction > HIGH_ON => Self::High,
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
    let Some(surface) = scene.surface.as_ref().filter(|surface| {
        surface.height.is_finite() && surface.height > 0.0
    }) else {
        return Quality::High;
    };
    let radius = node
        .model
        .as_ref()
        .and_then(|_| super::layout::model_bounds_for_node(resource, node))
        .map(|(bounds, _)| {
            (bevy::prelude::Vec3::from_array(bounds.max)
                - bevy::prelude::Vec3::from_array(bounds.min))
            .length()
                * 0.5
        });
    let Some(radius) = radius.filter(|radius| radius.is_finite()) else {
        return Quality::High;
    };
    let zoom = crate::canvas_query::focus_context::viewport(scene)[2];
    let metric = projected_world_fraction(radius, zoom, surface.height);
    Quality::for_fraction(metric, current)
}

/// 世界相机下的保守投影占比：投影直径 ÷ 可视窗口高度。
///
/// 普通画布的世界几何按 `screen = canvas * zoom + pan` 投影，因此直径的 CSS 像素是
/// `2 · radius · zoom`；除以视口高度得到与 DPR、相机距离无关的占比。
fn projected_world_fraction(radius: f32, zoom: f32, viewport_height: f32) -> f32 {
    if !radius.is_finite() || radius < 0.0 {
        return f32::INFINITY;
    }
    if [zoom, viewport_height].iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return f32::INFINITY;
    }
    2.0 * radius.max(0.01) * zoom / viewport_height
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn high_consumers_stay_high_regardless_of_projection_size() {
        for purpose in [
            ViewPurpose::Focus,
            ViewPurpose::Edit,
            ViewPurpose::Capture,
            ViewPurpose::Export,
        ] {
            assert!(purpose.requires_high());
            assert_eq!(purpose.select(0.01, Quality::Low), Quality::High);
            assert_eq!(purpose.select(10.0, Quality::Low), Quality::High);
        }
        // 选中缩放与世界画布都按实际投影占比分档，不再恒为 High。
        assert!(!ViewPurpose::World.requires_high());
        assert_eq!(ViewPurpose::World.select(0.01, Quality::Medium), Quality::Low);
        assert_eq!(ViewPurpose::World.select(10.0, Quality::Medium), Quality::High);
    }

    #[test]
    fn world_projection_fraction_uses_zoom_and_viewport_height() {
        let base = projected_world_fraction(1.0, 1.0, 800.0);
        assert!((base - 2.0 / 800.0).abs() < 1e-6);
        // 放大 2 倍 ⇒ 投影占比翻倍；视口更高 ⇒ 占比变小。
        assert!((projected_world_fraction(1.0, 2.0, 800.0) - base * 2.0).abs() < 1e-6);
        assert!((projected_world_fraction(1.0, 1.0, 1600.0) - base / 2.0).abs() < 1e-6);
        assert!(projected_world_fraction(10.0, 1.0, 800.0) > base);
        assert!(projected_world_fraction(0.1, 1.0, 800.0) < base);
        for radius in [f32::NAN, f32::INFINITY, -1.0] {
            assert_eq!(Quality::for_fraction(projected_world_fraction(radius, 1.0, 800.0), Quality::Low), Quality::High);
        }
        for zoom in [0.0, -1.0, f32::NAN] {
            assert_eq!(Quality::for_fraction(projected_world_fraction(1.0, zoom, 800.0), Quality::Low), Quality::High);
        }
    }

    #[test]
    fn world_thresholds_have_dead_bands_and_invalid_values_are_conservative() {
        // 0.10（低档附近）：Low 保持，Medium 落到 Low。
        assert_eq!(Quality::for_fraction(0.10, Quality::Low), Quality::Low);
        assert_eq!(Quality::for_fraction(0.10, Quality::Medium), Quality::Low);
        // 0.30（中档）：Medium 保持；High 降到 Medium。
        assert_eq!(Quality::for_fraction(0.30, Quality::Medium), Quality::Medium);
        assert_eq!(Quality::for_fraction(0.30, Quality::High), Quality::Medium);
        // 0.50（高档）：High 保持，Medium 提到 High。
        assert_eq!(Quality::for_fraction(0.50, Quality::High), Quality::High);
        assert_eq!(Quality::for_fraction(0.50, Quality::Medium), Quality::High);
        for fraction in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert_eq!(Quality::for_fraction(fraction, Quality::Low), Quality::High);
        }
    }

    #[test]
    fn models_without_world_instance_have_no_world_quality() {
        let path = format!("{}/tests/fixtures/shared-world/render-scene.json", env!("CARGO_MANIFEST_DIR"));
        let scene: Scene = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let node = &scene.nodes[0];
        let resource = ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            vec![],
            "sig".to_owned(),
            1.0,
            Default::default(),
        );
        // 世界模型（无聚焦/编辑）使用世界投影占比分档。
        assert_eq!(purpose(node, &scene, None, false), ViewPurpose::World);
        assert_eq!(desired(node, &scene, None, Quality::Medium, &resource), Quality::High);
        // 旧卡片节点没有世界实例，因此没有世界 AABB：保守保持 High，不伪造尺寸。
        let mut legacy = node.clone();
        legacy.shared_world_instance = None;
        assert_eq!(crate::model3d::layout::model_bounds_for_node(&resource, &legacy), None);
        assert_eq!(desired(&legacy, &scene, None, Quality::Low, &resource), Quality::High);
    }
}
