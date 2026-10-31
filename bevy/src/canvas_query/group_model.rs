//! The group identity badge is the group's own model.
//!
//! There is no fixed badge frame, corner, plate or user-editable presentation multiplier. Both an
//! ordinary group and a film-set group keep the shared canvas model unit
//! (`placement.scale * CANVAS_UNITS_PER_METER`) exactly like a `model3d` card: the badge size comes only
//! from the model geometry and placement, never from the group rectangle or the badge rect. A
//! film-set group's badge grows downward from the fixed anchor so it cannot cover the member cards.
//! In both cases the badge range is derived from the projected bounding box (changes:
//! 2026-10-30-remove-group-badge-scaling, 2026-10-31-render-film-set-badge-at-model-units).
use crate::{
    model3d::{grid, scene::ModelAabb},
    protocol::{GraphNode, ModelPlacement},
};
use bevy::prelude::*;

/// 组模型锚点：组结构底边中点向下 40 画布单位（即 80 单位底部页脚的中点）。
///
/// 这是锚点位置，不是徽标尺寸：它不随模型、组宽或手势变化，也不参与任何钳制。
pub(crate) const GROUP_BADGE_ANCHOR_OFFSET: f32 = 40.;
/// 组结构框的圆角半径（既有气泡语言，与徽标无关）。
const CORNER: f32 = 12.;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GroupModelLayout {
    /// 徽标中心（画布坐标，y 向下）。
    pub(crate) center: Vec2,
    /// 模型投影包围盒的半宽/半高（画布单位）。
    pub(crate) radii: Vec2,
    /// 模型根锚点（画布坐标，y 向下）；模型投影中心对齐 [`Self::center`]。
    pub(crate) anchor: Vec2,
    /// 画布共享模型单位：`placement.scale * CANVAS_UNITS_PER_METER`（绝对米制）。
    pub(crate) unit: f32,
}

/// No viewport, payload lease or mesh scan: these are accepted-scene presentation inputs.
///
/// 组没有可呈现模型（缺少 accepted 场景里的 `modelBounds` 或 `model` 引用）时不产生布局，
/// 也就不产生徽标范围；不得用固定框或历史倍率占位。
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
    _extent: f32,
    placement: &ModelPlacement,
) -> GroupModelLayout {
    let unit = placement.scale.max(0.001) * crate::model3d::CANVAS_UNITS_PER_METER;
    let rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let projected = local.transformed(&Transform {
        rotation,
        scale: Vec3::splat(unit),
        ..default()
    });
    let size =
        (Vec3::from_array(projected.max) - Vec3::from_array(projected.min)).max(Vec3::splat(0.001));
    let radii = Vec2::new(size.x, size.y) * 0.5;
    // 锚点与模型尺寸无关：组结构底边中点向下固定 40 画布单位。
    // 普通组把模型投影中心对齐该点；片场组把模型顶边对齐该点并向下展开，
    // 这样大场景不会盖住组框内的成员卡片。`unit` 只来自共享画布模型单位。
    let top_anchored = node
        .group
        .as_ref()
        .is_some_and(|group| group.badge_top_anchor);
    let center = Vec2::new(
        node.x + node.width / 2.,
        node.y + node.height + GROUP_BADGE_ANCHOR_OFFSET
            + if top_anchored { radii.y } else { 0. },
    );
    let c = projected.center();
    let anchor = center - Vec2::new(c.x, -c.y);
    GroupModelLayout {
        center,
        radii,
        anchor,
        unit,
    }
}

/// 徽标范围：以锚点为中心的模型投影包围盒 `(x, y, width, height)`。
///
/// 无模型投影时返回 `None`：不可见也不可命中。
pub(crate) fn badge_rect(node: &GraphNode) -> Option<Vec4> {
    let layout = for_node(node)?;
    Some(Vec4::new(
        layout.center.x - layout.radii.x,
        layout.center.y - layout.radii.y,
        layout.radii.x * 2.,
        layout.radii.y * 2.,
    ))
}

/// 徽标向下超出组结构底边的画布距离；无徽标为 0。
pub(crate) fn badge_outset(node: &GraphNode) -> f32 {
    badge_rect(node)
        .map(|rect| (rect.y + rect.w - node.y - node.height).max(0.))
        .unwrap_or(0.)
}

/// 收起组占用的呈现矩形：有可呈现模型时就是徽标范围，否则保留结构矩形。
pub(crate) fn presentation_rect(node: &GraphNode) -> Vec4 {
    if node.group.as_ref().is_some_and(|group| group.collapsed) {
        if let Some(badge) = badge_rect(node) {
            return badge;
        }
    }
    Vec4::new(node.x, node.y, node.width, node.height)
}

/// 徽标命中/描边多边形：模型投影包围盒的闭合四角；无徽标为空。
pub(crate) fn badge_polygon(node: &GraphNode) -> Vec<Vec2> {
    let Some(rect) = badge_rect(node) else {
        return Vec::new();
    };
    vec![
        Vec2::new(rect.x, rect.y),
        Vec2::new(rect.x + rect.z, rect.y),
        Vec2::new(rect.x + rect.z, rect.y + rect.w),
        Vec2::new(rect.x, rect.y + rect.w),
        Vec2::new(rect.x, rect.y),
    ]
}

/// 组结构缩放的四个抓手位置，顺序与 [`crate::canvas_query::scope::CORNER_NAMES`] 一致
/// （`nw, ne, sw, se`）。
///
/// 抓手画成压在外框角点上的小圆点：圆的圆心就是矩形的角点，与 `layout::resize_corner_rects`
/// 的 20×20 命中框同心，所以「画在哪、点在哪」一致；圆点也贴合圆角气泡的轮廓语言。
pub(crate) fn resize_corners(node: &GraphNode) -> [Vec2; 4] {
    let left = node.x;
    let top = node.y;
    let right = node.x + node.width;
    let bottom = node.y + node.height;
    [
        Vec2::new(left, top),
        Vec2::new(right, top),
        Vec2::new(left, bottom),
        Vec2::new(right, bottom),
    ]
}

/// 只有带模型身份的组才有底部徽标；深度与命中几何都用这一处判定。
pub(crate) fn has_badge(node: &GraphNode) -> bool {
    node.model.is_some() && node.group.is_some()
}

fn rounded_rect(rect: Vec4) -> Vec<Vec2> {
    let (x, y, w, h) = (rect.x, rect.y, rect.z, rect.w);
    rounded_path(
        &[
            Vec2::new(x, y),
            Vec2::new(x + w, y),
            Vec2::new(x + w, y + h),
            Vec2::new(x, y + h),
        ],
        CORNER,
    )
}
fn rectangle(node: &GraphNode) -> Vec<Vec2> {
    rounded_rect(Vec4::new(node.x, node.y, node.width, node.height))
}

/// 组框是闭合圆角矩形：不为徽标开口、不画气泡尖尾、不沿徽标描边。
pub(crate) fn outline(node: &GraphNode) -> Vec<Vec2> {
    if node.group.as_ref().is_some_and(|group| group.collapsed) {
        return Vec::new();
    }
    rectangle(node)
}

/// 展开态虚线组框：与 [`outline`] 同一条闭合圆角矩形。
pub(crate) fn frame_path(node: &GraphNode) -> Vec<Vec2> {
    rectangle(node)
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
