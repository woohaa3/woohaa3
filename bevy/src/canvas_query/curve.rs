//! 2D 边曲线与线段几何的**唯一**纯实现
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.2 / design D4）。
//!
//! 绘制（`geometry::Geometry::curve`）与命中查询（`canvas2d::query`）必须调用同一套控制点、
//! 采样点数与点到线段距离，避免此前 JS 48 段 / Rust 64 段的两套事实源。本模块只依赖 Bevy
//! 数学，不持有 ECS 状态、不读写 bridge。

use bevy::prelude::*;

/// 边曲线采样段数（单一常量）。绘制与命中查询共用；改造前 Rust 用 64、JS 用 48。
pub(crate) const EDGE_CURVE_SEGMENTS: usize = 64;

/// 边曲线水平弯曲量：`max(|dx| * 0.5, 65)`，与既有 JS/Rust 公式一致。
pub(crate) fn edge_bend(a: Vec2, b: Vec2) -> f32 {
    ((b.x - a.x).abs() * 0.5).max(65.0)
}

/// 三次贝塞尔控制点 `(c1, c2)`：水平偏移 `bend`，与绘制/命中共用。
pub(crate) fn edge_control_points(a: Vec2, b: Vec2) -> (Vec2, Vec2) {
    let bend = edge_bend(a, b);
    (a + Vec2::X * bend, b - Vec2::X * bend)
}

/// 三次贝塞尔在 `t` 处的点。
pub(crate) fn cubic_point(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, t: f32) -> Vec2 {
    let u = 1.0 - t;
    a * u.powi(3) + c1 * (3.0 * u * u * t) + c2 * (3.0 * u * t * t) + b * t.powi(3)
}

/// 采样一条边的折线点（`EDGE_CURVE_SEGMENTS + 1` 个点）。
pub(crate) fn sample_edge(a: Vec2, b: Vec2) -> Vec<Vec2> {
    let (c1, c2) = edge_control_points(a, b);
    (0..=EDGE_CURVE_SEGMENTS)
        .map(|index| cubic_point(a, c1, c2, b, index as f32 / EDGE_CURVE_SEGMENTS as f32))
        .collect()
}

/// 点到线段的最短距离（线段零长时回退到点距）。
pub(crate) fn point_segment_distance(point: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let denom = ab.length_squared();
    if denom <= f32::EPSILON {
        return point.distance(a);
    }
    let t = ((point - a).dot(ab) / denom).clamp(0.0, 1.0);
    point.distance(a + ab * t)
}

/// 线段轴对齐包围盒 `(min, max)`，用于命中 broad phase。
pub(crate) fn segment_bounds(a: Vec2, b: Vec2) -> ([f32; 2], [f32; 2]) {
    (
        [a.x.min(b.x), a.y.min(b.y)],
        [a.x.max(b.x), a.y.max(b.y)],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_points_use_max_bend() {
        let (c1, c2) = edge_control_points(Vec2::new(0.0, 0.0), Vec2::new(10.0, 0.0));
        // 最小弯曲 65。
        assert_eq!(c1, Vec2::new(65.0, 0.0));
        assert_eq!(c2, Vec2::new(-55.0, 0.0));
        let (c1, _c2) = edge_control_points(Vec2::new(0.0, 0.0), Vec2::new(400.0, 0.0));
        // |dx|*0.5 = 200 > 65。
        assert_eq!(c1.x, 200.0);
    }

    #[test]
    fn sample_edge_has_single_shared_segment_count() {
        let points = sample_edge(Vec2::ZERO, Vec2::new(200.0, 100.0));
        assert_eq!(points.len(), EDGE_CURVE_SEGMENTS + 1);
        // 端点必须精确落在起止点。
        assert!((points[0] - Vec2::ZERO).length() < 1e-4);
        assert!((points[points.len() - 1] - Vec2::new(200.0, 100.0)).length() < 1e-4);
    }

    #[test]
    fn point_segment_distance_clamps_to_ends() {
        let a = Vec2::new(0.0, 0.0);
        let b = Vec2::new(10.0, 0.0);
        // 投影落在段内。
        assert!((point_segment_distance(Vec2::new(5.0, 3.0), a, b) - 3.0).abs() < 1e-4);
        // 投影超出起点，回退到端点距离。
        assert!((point_segment_distance(Vec2::new(-4.0, 0.0), a, b) - 4.0).abs() < 1e-4);
        // 零长线段回退到点距。
        assert!((point_segment_distance(Vec2::new(3.0, 4.0), a, a) - 5.0).abs() < 1e-4);
    }
}
