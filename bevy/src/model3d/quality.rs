//! Runtime-only geometry quality. Canonical descriptors and bounds never change.
use crate::protocol::{
    CompositeAssetGeometryQuality, GraphNode, ModelPlacement, ModelSnapshot, Scene,
};

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
    /// 声明显式总览 primitive LOD 的复合资产（片场）总览用途
    /// （change: 2026-10-15-add-film-set-overview-lod，design D1/D2）。
    ///
    /// 按世界相机下的实际模型投影尺寸选择整场图元细分；High 消费者在用途解析中优先于它。
    WorldOverview,
}
impl ViewPurpose {
    pub(crate) fn requires_high(self) -> bool {
        matches!(
            self,
            Self::Focus | Self::Edit | Self::Selected | Self::Capture | Self::Export | Self::World
        )
    }
    /// `metric` 的含义随用途不同：Card/World 用卡片取景的物理像素，WorldOverview 用可视窗口
    /// 高度占比（design D2）。
    pub(crate) fn select(self, metric: f32, current: Quality) -> Quality {
        if self.requires_high() {
            Quality::High
        } else if self == Self::WorldOverview {
            Quality::for_overview_fraction(metric, current)
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
    } else if has_overview_lod_declaration(node)
        && scene.selection.nodes.iter().any(|id| id == &node.id)
    {
        ViewPurpose::Selected
    } else if has_overview_lod_declaration(node) {
        // 只有可信 adapter 显式声明的复合资产进入总览 LOD；Focused/Edit/Capture 已在上面优先返回。
        ViewPurpose::WorldOverview
    } else if node.model_preview.is_none() {
        ViewPurpose::World
    } else {
        ViewPurpose::Card
    }
}

/// 节点是否声明了总览 primitive LOD（严格按可信 adapter 的呈现声明，不推断内容形状）。
pub(super) fn has_overview_lod_declaration(node: &GraphNode) -> bool {
    node.composite_asset.as_ref().is_some_and(|asset| {
        asset.geometry_quality == Some(CompositeAssetGeometryQuality::OverviewPrimitivesV1)
    })
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

/// 总览规范的保守世界投影（design D2）：以已准备规范 bounds 得到的包围球半径和它在**可视
/// 窗口高度**上占的比例 `2 × radius × zoom / surface.height`。`radius` 已含等比 fit、
/// scene/item/source placement 与合法旋转。
///
/// 用屏幕占比而非绝对物理像素：占比 = `投影直径 ÷ 可视世界高度`，与 DPR、显示器分辨率无关，
/// 同一台机器缩放手感一致。DPR 已在占比中约掉，不进入判据。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct WorldProjection {
    pub radius: f32,
    pub fraction: f32,
}

/// 总览投影输入（design D2）：只有内容/准备 bounds、fit/placement、zoom、可视窗口高度或资源
/// identity 变化才失效；画布/根平移、播放头推进与 DPR 变化不进入 key，避免重复遍历源码求 bounds。
///
/// `layout` 是复合资产呈现层派生 bounds 与 item placement 的廉价哈希（拖拽预览可只改 item
/// transform 而不改节点矩形），这里不触碰 mesh 顶点。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ProjectionKey {
    resource: usize,
    offset: [u32; 3],
    scale: u32,
    yaw: u32,
    width: u32,
    height: u32,
    zoom: u32,
    surface_height: u32,
    layout: u64,
}

/// 每根总览投影输入缓存；命中时复用上次半径/占比，未命中重算并保存（含 `None` 保守结果）。
#[derive(Default)]
pub(super) struct ProjectionCache {
    key: Option<ProjectionKey>,
    value: Option<WorldProjection>,
}

impl ProjectionCache {
    /// 命中返回 `(cached, true)`；未命中用 `compute` 重算后保存并返回 `(value, false)`。
    pub(super) fn resolve(
        &mut self,
        key: ProjectionKey,
        compute: impl FnOnce() -> Option<WorldProjection>,
    ) -> (Option<WorldProjection>, bool) {
        if self.key == Some(key) {
            return (self.value, true);
        }
        let value = compute();
        self.key = Some(key);
        self.value = value;
        (value, false)
    }
}

/// 由节点/场景/已注册资源派生总览投影输入 key（不遍历 mesh 顶点）。
pub(super) fn projection_key(
    node: &GraphNode,
    scene: &Scene,
    resource: &std::sync::Arc<ModelSnapshot>,
) -> ProjectionKey {
    use std::hash::{DefaultHasher, Hash, Hasher};
    let placement = node
        .model
        .as_ref()
        .map_or(ModelPlacement::default(), |reference| {
            reference.placement.clone()
        });
    let mut hasher = DefaultHasher::new();
    if let Some(asset) = node.composite_asset.as_ref() {
        if let Some(bounds) = &asset.layout_aabb {
            for value in bounds.min.iter().chain(bounds.max.iter()) {
                value.to_bits().hash(&mut hasher);
            }
        }
        // 拖拽预览只替换 item transform：顺序无关地哈希每个条目的位模式。
        let mut entries: Vec<_> = asset
            .item_placements
            .iter()
            .map(|(id, placement)| {
                (
                    id.clone(),
                    placement.offset.x.to_bits(),
                    placement.offset.y.to_bits(),
                    placement.offset.z.to_bits(),
                    placement.scale.to_bits(),
                    placement.yaw.to_bits(),
                )
            })
            .collect();
        entries.sort();
        for entry in &entries {
            entry.hash(&mut hasher);
        }
    }
    ProjectionKey {
        // 资源表条目身份：同一 Arc 复用，内容替换（新 Arc）自然失效。
        resource: std::sync::Arc::as_ptr(resource) as *const () as usize,
        offset: [
            placement.offset.x.to_bits(),
            placement.offset.y.to_bits(),
            placement.offset.z.to_bits(),
        ],
        scale: placement.scale.to_bits(),
        yaw: placement.yaw.to_bits(),
        width: node.width.to_bits(),
        height: node.height.to_bits(),
        zoom: scene.viewport.zoom.to_bits(),
        surface_height: scene
            .surface
            .as_ref()
            .map_or(0.0, |surface| surface.height)
            .to_bits(),
        layout: hasher.finish(),
    }
}

/// 世界正交相机下的保守投影（design D2）：半径来自已准备规范 bounds，再换算为可视窗口高度
/// 占比；非法输入（含缺少 surface 高度）返回 `None`，由调用方保守回退 High。
pub(super) fn world_projection(
    node: &GraphNode,
    scene: &Scene,
    resource: &ModelSnapshot,
) -> Option<WorldProjection> {
    let reference = node.model.as_ref()?;
    let (bounds, _) = super::layout::model_bounds_for_node(resource, &reference.placement, node)?;
    if !bounds.is_finite() {
        return None;
    }
    let radius = bounds.radius();
    if !radius.is_finite() || radius < 0.0 {
        return None;
    }
    let viewport_height = scene.surface.as_ref().map_or(0.0, |surface| surface.height);
    let fraction = projected_viewport_fraction(radius, scene.viewport.zoom, viewport_height);
    if !fraction.is_finite() {
        return None;
    }
    Some(WorldProjection { radius, fraction })
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
        if has_overview_lod_declaration(node) {
            Quality::OverviewLow
        } else {
            Quality::Low
        }
    } else {
        let current = if has_overview_lod_declaration(node) {
            Quality::Low
        } else {
            Quality::Medium
        };
        desired(node, scene, focus, current, resource)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Quality {
    Low,
    OverviewLow,
    Medium,
    OverviewMedium,
    #[default]
    High,
}
impl Quality {
    pub(super) fn tier(self) -> Self {
        match self {
            Self::OverviewLow => Self::Low,
            Self::OverviewMedium => Self::Medium,
            other => other,
        }
    }

    /// 片场总览沿用投影占比分档；每档细分固定，避免同档缩放重建。
    pub(super) fn for_projection(projection: WorldProjection, current: Self) -> Self {
        match Self::for_overview_fraction(projection.fraction, current) {
            Self::Low => Self::OverviewLow,
            Self::Medium => Self::OverviewMedium,
            _ => Self::High,
        }
    }

    pub(super) fn subdivisions(self) -> (u32, u32, u32) {
        match self {
            Self::OverviewLow => (6, 3, 4),
            Self::OverviewMedium => (12, 6, 4),
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
        match current.tier() {
            Self::Low if pixels < 224.0 => Self::Low,
            Self::High if pixels > 448.0 => Self::High,
            _ if pixels < 176.0 => Self::Low,
            _ if pixels > 576.0 => Self::High,
            _ => Self::Medium,
        }
    }

    /// 原 High 的进入和保持边界现在用于 Medium；其余有效投影均使用 Low。
    pub(super) const OVERVIEW_MEDIUM_ENTER: f32 = 0.8;
    pub(super) const OVERVIEW_MEDIUM_STAY: f32 = 0.65;
    /// 可见片场实际处于 Medium 满此时长后才自动准备 High。
    pub(super) const OVERVIEW_HIGH_DELAY_SECONDS: f64 = 10.0;

    pub(super) fn for_overview_fraction(fraction: f32, current: Self) -> Self {
        if !fraction.is_finite() || fraction <= 0.0 {
            return Self::High;
        }
        match current.tier() {
            Self::Medium | Self::High if fraction > Self::OVERVIEW_MEDIUM_STAY => Self::Medium,
            _ if fraction > Self::OVERVIEW_MEDIUM_ENTER => Self::Medium,
            _ => Self::Low,
        }
    }

    /// 从实际发布 Medium 开始计时；自动升 High 后保持，直到投影回到 Low 或离屏。
    pub(super) fn after_overview_dwell(
        self,
        current: Self,
        since: &mut Option<f64>,
        now: f64,
    ) -> Self {
        if self != Self::OverviewMedium {
            *since = None;
            return self;
        }
        if current == Self::High && since.is_some() {
            return Self::High;
        }
        if current != Self::OverviewMedium {
            *since = None;
            return self;
        }
        let started = *since.get_or_insert(now);
        if now - started >= Self::OVERVIEW_HIGH_DELAY_SECONDS {
            Self::High
        } else {
            self
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
    if purpose == ViewPurpose::WorldOverview {
        return world_projection(node, scene, resource).map_or(Quality::High, |projection| {
            Quality::for_projection(projection, current)
        });
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

/// 总览投影占可视窗口高度的比例（design D2）：`2 × radiusWorld × zoom ÷ 可视窗口高度（CSS px）`。
///
/// 世界相机是正交的，因此不使用观察距离；平移不改变档位。占比与 DPR、显示器分辨率无关，
/// 同一台机器缩放手感一致。`radius` 来自已准备的规范 bounds（含等比 fit、scene/item/source
/// placement 与合法旋转）；非法或非正输入返回 `INFINITY`，由分档保守回退 High。
fn projected_viewport_fraction(radius: f32, zoom: f32, viewport_height: f32) -> f32 {
    if !radius.is_finite() || radius < 0.0 {
        return f32::INFINITY;
    }
    if [zoom, viewport_height]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0)
    {
        return f32::INFINITY;
    }
    2.0 * radius * zoom / viewport_height
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
