//! 世界模型的像素级“胖点选”兜底。
//!
//! 精确射线按真实三角面命中，这是点选的主路径。细长/带孔模型（自行车车架、栏杆、宫殿柱廊）
//! 的间隙会让指针完全穿过表面，于是再加一次有界容差：指针到投影三角面的屏幕距离在
//! [`MAX_TOLERANCE_PX`] 以内才算命中。
//!
//! 容差仍以真实几何为准，**不**退化成包围盒相交：大模型的投影包围盒可能覆盖导演区之外的
//! 大片空域，按 AABB 判定会让点在空白处也选中模型。

use bevy::prelude::{Vec2, Vec3};

use super::{center_radius, ModelCandidate};

/// 指针到最近露出表面的最大屏幕容差（CSS 像素）。
pub(crate) const MAX_TOLERANCE_PX: f32 = 4.0;

/// 候选 AABB 的投影屏幕包围盒（CSS 坐标）；没有任何有限投影时返回 `None`。
///
/// 框选与胖点选共用同一投影约定（`screen_point_from_world`），不为查询另造一套映射。
pub(crate) fn screen_bounds(
    min: [f32; 3],
    max: [f32; 3],
    view: &crate::isometric_grid::IsometricGridView,
) -> Option<(Vec2, Vec2)> {
    if !min.iter().chain(max.iter()).all(|value| value.is_finite()) {
        return None;
    }
    let mut low = Vec2::splat(f32::INFINITY);
    let mut high = Vec2::splat(f32::NEG_INFINITY);
    for x in [min[0], max[0]] {
        for y in [min[1], max[1]] {
            for z in [min[2], max[2]] {
                let point = crate::isometric_grid::screen_point_from_world(Vec3::new(x, y, z), view);
                if !point.x.is_finite() || !point.y.is_finite() {
                    continue;
                }
                low = low.min(point);
                high = high.max(point);
            }
        }
    }
    (low.x.is_finite() && low.y.is_finite()).then_some((low, high))
}

/// 指针附近（`tolerance` 像素内）最近露出的模型表面；距离相同时保留先出现的候选。
pub(crate) fn pick_candidates_near(
    candidates: &[ModelCandidate],
    view: &crate::isometric_grid::IsometricGridView,
    x: f32,
    y: f32,
    tolerance: f32,
) -> Option<(String, [f32; 3], f32)> {
    let point = Vec2::new(x, y);
    let mut best: Option<(String, [f32; 3], f32, f32)> = None;
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        // 空模型标记没有三角面，其锚点已由精确射线命中负责。
        let Some(triangles) = candidate.triangles.as_ref() else { continue };
        // 相机的机位与视锥共用同一节点 id：命中结果只按节点去重。
        if !seen.insert(candidate.node_id.as_str()) {
            continue;
        }
        let Some((low, high)) = screen_bounds(candidate.min, candidate.max, view) else { continue };
        if point.x < low.x - tolerance
            || point.x > high.x + tolerance
            || point.y < low.y - tolerance
            || point.y > high.y + tolerance
        {
            continue;
        }
        let mut nearest = f32::INFINITY;
        for triangle in triangles.iter() {
            let [a, b, c] = triangle.vertices.map(|vertex| {
                crate::isometric_grid::screen_point_from_world(Vec3::from_array(vertex), view)
            });
            if ![a, b, c].iter().all(|vertex| vertex.x.is_finite() && vertex.y.is_finite()) {
                continue;
            }
            nearest = nearest.min(point_triangle_distance(point, a, b, c));
            if nearest <= 0.0 {
                break;
            }
        }
        if nearest <= tolerance
            && best
                .as_ref()
                .is_none_or(|(_, _, _, distance)| nearest < *distance)
        {
            let (center, radius) = center_radius(candidate.min, candidate.max);
            best = Some((candidate.node_id.clone(), center, radius, nearest));
        }
    }
    best.map(|(node_id, center, radius, _)| (node_id, center, radius))
}

/// 屏幕点到投影三角面的距离：点在面内为 0，否则取到三条边的最小距离。
fn point_triangle_distance(point: Vec2, a: Vec2, b: Vec2, c: Vec2) -> f32 {
    let edge = |from: Vec2, to: Vec2| {
        (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x)
    };
    let (ab, bc, ca) = (edge(a, b), edge(b, c), edge(c, a));
    let inside = (ab >= 0.0 && bc >= 0.0 && ca >= 0.0) || (ab <= 0.0 && bc <= 0.0 && ca <= 0.0);
    if inside {
        return 0.0;
    }
    segment_distance(point, a, b)
        .min(segment_distance(point, b, c))
        .min(segment_distance(point, c, a))
}

fn segment_distance(point: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let length_squared = ab.length_squared();
    if !(length_squared > 1e-6) {
        return (point - a).length();
    }
    let t = ((point - a).dot(ab) / length_squared).clamp(0.0, 1.0);
    (point - (a + ab * t)).length()
}
