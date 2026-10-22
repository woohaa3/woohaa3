//! 复合资产范围几何：矩形/地面平行四边形派生、点命中、正面积框选相交与 8 抓手
//! （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D4/D6）。
//!
//! 唯一派生公式：给定内容适配**基准矩形**、通用 `scopeShape` 与映射层派生的**地面矩形**
//! `ScopeGround`（模型地面占地等比外扩固定边距），派生与地面网格平行的平行四边形（地面宽深
//! 相等时为菱形）或保留矩形。绘制、点命中、框选、drop 与 resize 抓手共用本模块，禁止各自复制
//! 公式。
//!
//! 地面矩形顶点 = `center ± (AXIS_X×hx, AXIS_Y×hx) ± (-AXIS_X×hz, AXIS_Y×hz)`，边与当前地面投影
//! 轴平行（`s = |AXIS_Y / AXIS_X| = 0.5`，[`crate::isometric_grid::plan`]），外包矩形宽高比恒为
//! `1/s = 2`。顶点顺序固定 top → right → bottom → left（y 向下坐标中为顺时针）。抓手 8 个：
//! 四顶点 `n/e/s/w` 与四边中点 `ne/se/sw/nw`。本模块是纯几何，不依赖 ECS / bridge / wasm。

use bevy::prelude::Vec2;

use crate::isometric_grid::plan::{scope_axis_x, scope_axis_y};
use crate::protocol::{CompositeAssetScopeShape, GraphNode};

/// 空片场/复合资产最小可点击范围半边长（世界坐标），与 contracts 一致。
pub(crate) const SCOPE_MIN_HALF: f32 = 32.0;
/// 点包含的边界容差（世界单位）；仅表达「边界包含」，不作为空白区 padding。
pub(crate) const SCOPE_EPSILON: f32 = 1e-4;
/// 抓手命中方块边长，与 contracts `COMPOSITE_ASSET_SCOPE_HANDLE` 一致。
pub(crate) const DIAMOND_GRIP_LEG: f32 = 20.0;
/// 抓手命中的输入容差（世界单位），可略放宽可见方块以匹配现有输入容差。
pub(crate) const DIAMOND_GRIP_TOLERANCE: f32 = 2.0;

/// 抓手方向顺序：`n, ne, e, se, s, sw, w, nw`（与 contracts 一致）。
pub(crate) const HANDLE_NAMES: [&str; 8] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/// 范围基准矩形 `(x, y, width, height)`（世界坐标，内容适配矩形）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScopeRect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

/// 范围地面矩形：投影中心 `(cx, cy)`（画布世界）与沿地面 +x/+z 的半球面尺寸 `(hx, hz)`。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScopeGround {
    pub(crate) cx: f32,
    pub(crate) cy: f32,
    pub(crate) hx: f32,
    pub(crate) hz: f32,
}

/// 由基准矩形/形状/地面派生的范围几何。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScopeGeometry {
    pub(crate) shape: CompositeAssetScopeShape,
    /// 内容适配基准矩形（不是范围 AABB）。
    pub(crate) base: ScopeRect,
    pub(crate) center: Vec2,
    /// 闭合多边形顶点；rect 为四角，地面矩形为 top/right/bottom/left。
    pub(crate) vertices: [Vec2; 4],
    /// 粗筛/绘制用外接矩形；地面矩形时为 `(cx-rx, cy-ry, 2rx, 2ry)`。
    pub(crate) aabb: ScopeRect,
    pub(crate) radius_x: f32,
    pub(crate) radius_y: f32,
    /// 8 抓手中心：`n, ne, e, se, s, sw, w, nw`。
    pub(crate) handles: [Vec2; 8],
    /// 地面矩形（仅地面平行四边形时存在）。
    pub(crate) ground: Option<ScopeGround>,
}

/// 范围抓手集合：复合资产为 8 个抓手；普通矩形节点沿用右下角方形。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ScopeGrip {
    Handles([Vec2; 8]),
    Rect(ScopeRect),
}

fn finite(value: f32) -> bool {
    value.is_finite()
}

/// 规范化范围基准矩形：保证有限、非负尺寸并围绕中心保留最小可点击范围。
pub(crate) fn normalize_base_rect(rect: ScopeRect, min_half: f32) -> ScopeRect {
    let half = if finite(min_half) && min_half > 0.0 {
        min_half
    } else {
        SCOPE_MIN_HALF
    };
    let width = if finite(rect.width) { rect.width } else { 0.0 };
    let height = if finite(rect.height) { rect.height } else { 0.0 };
    let x = if finite(rect.x) { rect.x } else { 0.0 };
    let y = if finite(rect.y) { rect.y } else { 0.0 };
    let cx = x + width / 2.0;
    let cy = y + height / 2.0;
    let w = width.max(half * 2.0);
    let h = height.max(half * 2.0);
    ScopeRect {
        x: cx - w / 2.0,
        y: cy - h / 2.0,
        width: w,
        height: h,
    }
}

fn midpoint(a: Vec2, b: Vec2) -> Vec2 {
    (a + b) * 0.5
}

/// 地面矩形 → 画布顶点、AABB 与 8 抓手（唯一公式）。
fn ground_geometry(ground: ScopeGround, min_half: f32) -> (Vec2, [Vec2; 4], ScopeRect, f32, f32, [Vec2; 8]) {
    let ax = scope_axis_x();
    let ay = scope_axis_y();
    let safe = if finite(min_half) && min_half > 0.0 { min_half } else { SCOPE_MIN_HALF };
    let cx = if finite(ground.cx) { ground.cx } else { 0.0 };
    let cy = if finite(ground.cy) { ground.cy } else { 0.0 };
    let min_half_ground = safe / (ax * 2.0);
    let mut hx = if finite(ground.hx) { ground.hx } else { 0.0 };
    let mut hz = if finite(ground.hz) { ground.hz } else { 0.0 };
    if hx + hz < min_half_ground * 2.0 {
        hx = min_half_ground;
        hz = min_half_ground;
    }
    let top = Vec2::new(cx - ax * (hx - hz), cy - ay * (hx + hz));
    let right = Vec2::new(cx + ax * (hx + hz), cy + ay * (hx - hz));
    let bottom = Vec2::new(cx + ax * (hx - hz), cy + ay * (hx + hz));
    let left = Vec2::new(cx - ax * (hx + hz), cy - ay * (hx - hz));
    let radius_x = ax * (hx + hz);
    let radius_y = ay * (hx + hz);
    let vertices = [top, right, bottom, left];
    let handles = [
        top,
        midpoint(top, right),
        right,
        midpoint(right, bottom),
        bottom,
        midpoint(bottom, left),
        left,
        midpoint(left, top),
    ];
    (
        Vec2::new(cx, cy),
        vertices,
        ScopeRect {
            x: cx - radius_x,
            y: cy - radius_y,
            width: radius_x * 2.0,
            height: radius_y * 2.0,
        },
        radius_x,
        radius_y,
        handles,
    )
}

/// 由基准矩形/形状/地面派生范围几何（唯一公式）。
pub(crate) fn geometry(
    base: ScopeRect,
    shape: CompositeAssetScopeShape,
    ground: Option<ScopeGround>,
    min_half: f32,
) -> ScopeGeometry {
    let normalized = normalize_base_rect(base, min_half);
    let cx = normalized.x + normalized.width / 2.0;
    let cy = normalized.y + normalized.height / 2.0;
    if instance_of_diamond(shape) && let Some(ground) = ground {
        let (center, vertices, aabb, radius_x, radius_y, handles) = ground_geometry(ground, min_half);
        return ScopeGeometry {
            shape,
            base: normalized,
            center,
            vertices,
            aabb,
            radius_x,
            radius_y,
            handles,
            ground: Some(ground),
        };
    }
    let half_w = normalized.width / 2.0;
    let half_h = normalized.height / 2.0;
    let tl = Vec2::new(cx - half_w, cy - half_h);
    let tr = Vec2::new(cx + half_w, cy - half_h);
    let br = Vec2::new(cx + half_w, cy + half_h);
    let bl = Vec2::new(cx - half_w, cy + half_h);
    let handles = [
        midpoint(tl, tr),
        tr,
        midpoint(tr, br),
        br,
        midpoint(br, bl),
        bl,
        midpoint(bl, tl),
        tl,
    ];
    ScopeGeometry {
        shape: CompositeAssetScopeShape::Rect,
        base: normalized,
        center: Vec2::new(cx, cy),
        vertices: [tl, tr, br, bl],
        aabb: normalized,
        radius_x: half_w,
        radius_y: half_h,
        handles,
        ground: None,
    }
}

fn instance_of_diamond(shape: CompositeAssetScopeShape) -> bool {
    matches!(shape, CompositeAssetScopeShape::IsometricDiamond)
}

/// 是否地面平行四边形形状（供绘制/宿主按形状分支，避免各自匹配枚举）。
pub(crate) fn is_diamond(shape: CompositeAssetScopeShape) -> bool {
    instance_of_diamond(shape)
}

/// 范围是否包含世界点（凸多边形含边界判定）。
pub(crate) fn contains(geometry: &ScopeGeometry, point: Vec2) -> bool {
    if !finite(point.x) || !finite(point.y) {
        return false;
    }
    if geometry.ground.is_some() {
        return polygon_contains(&geometry.vertices, point, SCOPE_EPSILON);
    }
    let a = geometry.aabb;
    point.x >= a.x - SCOPE_EPSILON
        && point.x <= a.x + a.width + SCOPE_EPSILON
        && point.y >= a.y - SCOPE_EPSILON
        && point.y <= a.y + a.height + SCOPE_EPSILON
}

/// 范围是否与框选矩形有**正面积**相交（仅触边不算）。SAT：x/y 轴与范围边法线。
pub(crate) fn intersects_rect(geometry: &ScopeGeometry, rect: ScopeRect) -> bool {
    let left = rect.x.min(rect.x + rect.width);
    let right = rect.x.max(rect.x + rect.width);
    let top = rect.y.min(rect.y + rect.height);
    let bottom = rect.y.max(rect.y + rect.height);
    let marquee = ScopeRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
    if !finite(marquee.x) || !finite(marquee.y) || marquee.width <= 0.0 || marquee.height <= 0.0 {
        return false;
    }
    if !overlaps_positive(&geometry.aabb, &marquee) {
        return false;
    }
    if geometry.ground.is_none() {
        return true;
    }
    let marquee_vertices = [
        Vec2::new(left, top),
        Vec2::new(right, top),
        Vec2::new(right, bottom),
        Vec2::new(left, bottom),
    ];
    let mut axes: Vec<Vec2> = vec![Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0)];
    for index in 0..geometry.vertices.len() {
        let a = geometry.vertices[index];
        let b = geometry.vertices[(index + 1) % geometry.vertices.len()];
        let edge = b - a;
        let length = edge.length();
        if length > 0.0 {
            axes.push(Vec2::new(-edge.y / length, edge.x / length));
        }
    }
    for axis in axes {
        let a = project_range(&geometry.vertices, axis);
        let b = project_range(&marquee_vertices, axis);
        if a.1 <= b.0 || b.1 <= a.0 {
            return false;
        }
    }
    true
}

/// 平移范围几何（`base`/`center`/顶点/`aabb`/抓手/地面矩形同步偏移）。
///
/// 范围几何是基准矩形、形状与地面矩形的仿射派生，对平移封闭，因此局部预览增量只需整体
/// 位移，无需重跑 `node_scope`（change: 2026-10-10-optimize-canvas-interaction-hot-path）。
pub(crate) fn translate(geometry: &ScopeGeometry, offset: Vec2) -> ScopeGeometry {
    let translate_rect = |rect: ScopeRect| ScopeRect {
        x: rect.x + offset.x,
        y: rect.y + offset.y,
        ..rect
    };
    ScopeGeometry {
        base: translate_rect(geometry.base),
        center: geometry.center + offset,
        vertices: geometry.vertices.map(|vertex| vertex + offset),
        aabb: translate_rect(geometry.aabb),
        handles: geometry.handles.map(|handle| handle + offset),
        ground: geometry.ground.map(|ground| ScopeGround {
            cx: ground.cx + offset.x,
            cy: ground.cy + offset.y,
            ..ground
        }),
        ..*geometry
    }
}

/// 范围抓手集合：复合资产为 8 个抓手；其它分支沿用右下角方形。
pub(crate) fn grip(geometry: &ScopeGeometry) -> ScopeGrip {
    if geometry.ground.is_some() || instance_of_diamond(geometry.shape) {
        ScopeGrip::Handles(geometry.handles)
    } else {
        let size = DIAMOND_GRIP_LEG;
        ScopeGrip::Rect(ScopeRect {
            x: geometry.aabb.x + geometry.aabb.width - size,
            y: geometry.aabb.y + geometry.aabb.height - size,
            width: size,
            height: size,
        })
    }
}

/// 命中的抓手索引（`n, ne, e, se, s, sw, w, nw`）；`Rect` 分支返回 `None`（沿用自由缩放）。
pub(crate) fn grip_hit(grip: &ScopeGrip, point: Vec2, tolerance: f32) -> Option<usize> {
    match grip {
        ScopeGrip::Rect(rect) => {
            let inside = point.x >= rect.x - tolerance
                && point.x <= rect.x + rect.width + tolerance
                && point.y >= rect.y - tolerance
                && point.y <= rect.y + rect.height + tolerance;
            inside.then_some(usize::MAX)
        }
        ScopeGrip::Handles(handles) => {
            if !finite(point.x) || !finite(point.y) {
                return None;
            }
            let half = DIAMOND_GRIP_LEG / 2.0 + tolerance;
            let mut best: Option<(usize, f32)> = None;
            for (index, handle) in handles.iter().enumerate() {
                let dx = (point.x - handle.x).abs();
                let dy = (point.y - handle.y).abs();
                if dx <= half && dy <= half {
                    let distance = dx * dx + dy * dy;
                    if best.is_none_or(|(_, best_distance)| distance < best_distance) {
                        best = Some((index, distance));
                    }
                }
            }
            best.map(|(index, _)| index)
        }
    }
}

/// 凸多边形是否包含点（含边界；按顶点顺序判定同侧）。
pub(crate) fn polygon_contains(vertices: &[Vec2], point: Vec2, epsilon: f32) -> bool {
    let mut sign = 0.0_f32;
    for index in 0..vertices.len() {
        let a = vertices[index];
        let b = vertices[(index + 1) % vertices.len()];
        let edge = b - a;
        let length = edge.length();
        if length <= 0.0 {
            continue;
        }
        let distance = (edge.x * (point.y - a.y) - edge.y * (point.x - a.x)) / length;
        if distance.abs() <= epsilon {
            continue;
        }
        let current = if distance > 0.0 { 1.0 } else { -1.0 };
        if sign == 0.0 {
            sign = current;
        } else if sign != current {
            return false;
        }
    }
    true
}

/// 从节点读取范围几何（缺省 `rect`）。
///
/// `composite_asset` 缺失时按节点锚点附近的最小可点击范围回退（空片场）。声明菱形但缺
/// `scope_ground` 时回退矩形几何（映射层为菱形始终下发地面矩形）。
pub(crate) fn node_scope(node: &GraphNode) -> ScopeGeometry {
    match &node.composite_asset {
        Some(asset) => geometry(
            ScopeRect {
                x: asset.x,
                y: asset.y,
                width: asset.width,
                height: asset.height,
            },
            asset.scope_shape,
            asset.scope_ground.map(|g| ScopeGround {
                cx: g.cx,
                cy: g.cy,
                hx: g.hx,
                hz: g.hz,
            }),
            SCOPE_MIN_HALF,
        ),
        None => geometry(
            ScopeRect {
                x: node.x + node.width / 2.0 - SCOPE_MIN_HALF,
                y: node.y + node.height / 2.0 - SCOPE_MIN_HALF,
                width: SCOPE_MIN_HALF * 2.0,
                height: SCOPE_MIN_HALF * 2.0,
            },
            CompositeAssetScopeShape::Rect,
            None,
            SCOPE_MIN_HALF,
        ),
    }
}

fn overlaps_positive(a: &ScopeRect, b: &ScopeRect) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

fn project_range(vertices: &[Vec2], axis: Vec2) -> (f32, f32) {
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    for vertex in vertices {
        let value = vertex.x * axis.x + vertex.y * axis.y;
        min = min.min(value);
        max = max.max(value);
    }
    (min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(x: f32, y: f32, w: f32, h: f32) -> ScopeRect {
        ScopeRect { x, y, width: w, height: h }
    }

    fn ground(cx: f32, cy: f32, hx: f32, hz: f32) -> ScopeGround {
        ScopeGround { cx, cy, hx, hz }
    }

    #[test]
    fn grounded_square_is_rhombus_with_2to1_aabb() {
        // hx == hz → 菱形；顶点在投影轴上。
        let g = geometry(
            base(0.0, 0.0, 260.0, 195.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(100.0, 50.0, 40.0, 40.0)),
            SCOPE_MIN_HALF,
        );
        assert_eq!(g.center, Vec2::new(100.0, 50.0));
        let ax = scope_axis_x();
        let ay = scope_axis_y();
        assert!((g.vertices[0] - Vec2::new(100.0, 50.0 - ay * 80.0)).length() < 1e-4);
        assert!((g.vertices[1] - Vec2::new(100.0 + ax * 80.0, 50.0)).length() < 1e-4);
        assert!((g.aabb.width / g.aabb.height - 2.0).abs() < 1e-4);
        // 8 抓手：顶点与边中点。
        assert_eq!(g.handles.len(), 8);
        assert!((g.handles[2] - g.vertices[1]).length() < 1e-4);
    }

    #[test]
    fn grounded_rect_is_parallelogram_with_sloped_edges() {
        let g = geometry(
            base(0.0, 0.0, 200.0, 100.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(0.0, 0.0, 60.0, 30.0)),
            SCOPE_MIN_HALF,
        );
        // 边斜率 ±0.5。
        let edge = g.vertices[1] - g.vertices[0];
        assert!((edge.y / edge.x - 0.5).abs() < 1e-4);
        let edge2 = g.vertices[3] - g.vertices[0];
        assert!((edge2.y / edge2.x + 0.5).abs() < 1e-4);
    }

    #[test]
    fn contains_rejects_aabb_blank_corner_but_accepts_edges() {
        let g = geometry(
            base(0.0, 0.0, 260.0, 195.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(0.0, 0.0, 40.0, 40.0)),
            SCOPE_MIN_HALF,
        );
        assert!(contains(&g, g.center));
        assert!(contains(&g, g.vertices[0]));
        let blank = Vec2::new(g.aabb.x, g.aabb.y);
        assert!(!contains(&g, blank));
    }

    #[test]
    fn marquee_uses_positive_area_and_rejects_aabb_blank_corner() {
        let g = geometry(
            base(0.0, 0.0, 260.0, 195.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(0.0, 0.0, 40.0, 40.0)),
            SCOPE_MIN_HALF,
        );
        assert!(intersects_rect(&g, base(g.aabb.x, g.aabb.y, g.aabb.width, g.aabb.height)));
        assert!(intersects_rect(&g, base(-20.0, -10.0, 5.0, 5.0)));
        // 反向拖框与正向一致。
        assert!(intersects_rect(&g, base(g.aabb.x + g.aabb.width, g.aabb.y + g.aabb.height, -g.aabb.width, -g.aabb.height)));
    }

    #[test]
    fn rect_shape_stays_axis_aligned() {
        let g = geometry(base(0.0, 0.0, 200.0, 100.0), CompositeAssetScopeShape::Rect, None, SCOPE_MIN_HALF);
        assert_eq!(g.aabb, base(0.0, 0.0, 200.0, 100.0));
        assert!(contains(&g, Vec2::new(0.0, 0.0)));
        assert!(contains(&g, Vec2::new(200.0, 100.0)));
        assert!(!contains(&g, Vec2::new(200.5, 50.0)));
        assert!(matches!(grip(&g), ScopeGrip::Rect(_)));
    }

    #[test]
    fn grip_hit_maps_to_expected_handle_index() {
        let g = geometry(
            base(0.0, 0.0, 260.0, 195.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(0.0, 0.0, 40.0, 40.0)),
            SCOPE_MIN_HALF,
        );
        let grip = grip(&g);
        assert_eq!(grip_hit(&grip, g.vertices[1], SCOPE_EPSILON), Some(2)); // e
        assert_eq!(grip_hit(&grip, g.vertices[0], SCOPE_EPSILON), Some(0)); // n
        assert_eq!(grip_hit(&grip, g.center, SCOPE_EPSILON), None);
    }

    #[test]
    fn tiny_or_invalid_base_keeps_min_click_scope() {
        let tiny = normalize_base_rect(base(10.0, 10.0, 0.0, 0.0), SCOPE_MIN_HALF);
        assert_eq!(tiny, base(-22.0, -22.0, 64.0, 64.0));
        let g = geometry(
            base(0.0, 0.0, 4.0, 4.0),
            CompositeAssetScopeShape::IsometricDiamond,
            Some(ground(0.0, 0.0, 0.0, 0.0)),
            SCOPE_MIN_HALF,
        );
        assert!(g.radius_x > 0.0 && g.radius_y > 0.0);
    }
}
