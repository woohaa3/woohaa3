//! 普通画布 3D 模型 ray/AABB picking
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2 / design D5）。
//!
//! 纯几何：调用方（lib.rs 接受点）把每个 canonical 模型的**世界 AABB**（含 placement/anchor，
//! 由共享 `model3d` 派生）以紧凑列表传入；本模块只做普通正交画布的屏幕射线/AABB 命中。
//!
//! 普通画布下世界 x/y 与 CSS 像素 1:1（相机 identity、ortho 半高 = surface.height/2），因此
//! 命中退化为「指针 x 落在 AABB x 区间 ∧ (surfaceHeight - 指针 y) 落在 AABB y 区间 ∧ AABB 在
//! 射线前方」，取最近（z 最小）模型。不做投影函数导出，避免边界成本与状态不一致。

use serde::Serialize;

use std::cell::RefCell;
use std::collections::HashMap;

use crate::isometric_grid::CANVAS_CAMERA_Z;

/// 单个模型的候选世界 AABB（由 model3d 派生后传入）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelCandidate {
    pub(crate) node_id: String,
    pub(crate) shared_world: bool,
    /// 空模型/资源未就绪的世界锚点：没有可见三角面，但必须可选中。
    pub(crate) empty_marker: bool,
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
    pub(crate) triangles: Option<std::sync::Arc<Vec<SurfaceTriangle>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SurfaceTriangle {
    pub(crate) vertices: [[f32; 3]; 3],
    pub(crate) cull_back: bool,
}

/// 模型聚焦时的透视相机快照；与渲染/手势共用同一 target/yaw/pitch/fov。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ModelPickFocus {
    pub(crate) target: [f32; 3],
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
    pub(crate) fov: f32,
}

/// 与候选一同发布的画布相机快照（viewport/surface）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ModelPickCamera {
    pub(crate) viewport: [f32; 3],
    pub(crate) surface: [f32; 2],
    pub(crate) ordinary: bool,
    pub(crate) focus: Option<ModelPickFocus>,
}

impl Default for ModelPickCamera {
    fn default() -> Self {
        Self {
            viewport: [0.0, 0.0, 1.0],
            surface: [1.0, 1.0],
            ordinary: true,
            focus: None,
        }
    }
}

thread_local! {
    /// 最近接受场景派生的模型候选世界 AABB；在 `set_scene` 接受点更新。
    static CANDIDATES: RefCell<Vec<ModelCandidate>> = const { RefCell::new(Vec::new()) };
    static SHARED_CURRENT: RefCell<Vec<ModelCandidate>> = const { RefCell::new(Vec::new()) };
    static POSITION_BASIS: RefCell<super::position_basis::PositionBasis<ModelCandidate>> = RefCell::new(Default::default());
    /// 每个候选最近发布的观察深度（逐像素平局偏移）；位置增量只按差值更新 AABB 的 z。
    ///
    /// 深度由顶层 `depth_order` 结算（change: 2026-10-27-order-canvas-layers-by-ground-anchor，
    /// design D1/D3/D4）；本模块不复制第二套排序。
    static DEPTHS: RefCell<HashMap<String, f32>> = RefCell::new(HashMap::new());
    /// 与候选同 generation 的画布相机快照；查询复用该快照（design D5）。
    static CAMERA: RefCell<ModelPickCamera> = const { RefCell::new(ModelPickCamera {
        viewport: [0.0, 0.0, 1.0],
        surface: [1.0, 1.0],
        ordinary: true,
        focus: None,
    }) };
    /// 模型 pick generation（与 2D interaction generation 同步递增通过 facade）。
    static GENERATION: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// 是否已接受过模型索引（区分「空画布」与「尚未就绪」）。
    static READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 接受一份模型候选列表与同 generation 的相机快照（`set_scene` 接受点调用）；latest-wins。
pub(crate) fn accept_models(
    candidates: Vec<ModelCandidate>,
    generation: u32,
    camera: ModelPickCamera,
) {
    POSITION_BASIS.with(|slot| slot.borrow_mut().reset(&candidates, |c| c.node_id.as_str()));
    DEPTHS.with(|slot| {
        *slot.borrow_mut() = candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.node_id.clone(),
                    crate::depth_order::depth_of(&candidate.node_id),
                )
            })
            .collect();
    });
    CANDIDATES.with(|slot| *slot.borrow_mut() = candidates);
    CAMERA.with(|slot| *slot.borrow_mut() = camera);
    GENERATION.with(|cell| cell.set(generation));
    READY.with(|cell| cell.set(true));
}

pub(crate) fn replace_shared_models(shared: Vec<ModelCandidate>) {
    SHARED_CURRENT.with(|slot| *slot.borrow_mut() = shared);
}

pub(crate) fn plan_positions(
    deltas: &[super::interaction::PositionDelta],
) -> Result<Vec<(usize, ModelCandidate)>, &'static str> {
    POSITION_BASIS.with(|slot| {
        slot.borrow().plan(deltas, |base, delta| {
            let mut next = base.clone();
            if !base.shared_world {
                (next.min, next.max) = super::position_basis::shift_bounds(base.min, base.max, delta)?;
            }
            Ok(next)
        })
    })
}

/// 位置接受点后按新观察深度差值平移候选 AABB 的 z；x/y 平移已由 `plan_positions` 完成。
///
/// 候选几何本身由共享 `model3d` 从同一深度派生，这里只对齐增量帧，避免位置预览期间
/// 3D 拾取仍使用旧的遮挡顺序（change: 2026-10-27-order-canvas-layers-by-ground-anchor，
/// design D3/D4）。
pub(crate) fn retune_depth(plan: &mut [(usize, ModelCandidate)]) {
    DEPTHS.with(|slot| {
        let mut depths = slot.borrow_mut();
        for (_, candidate) in plan.iter_mut() {
            if candidate.shared_world {
                continue;
            }
            let next = crate::depth_order::depth_of(&candidate.node_id);
            let previous = depths
                .insert(candidate.node_id.clone(), next)
                .unwrap_or(next);
            let shift = next - previous;
            candidate.min[2] += shift;
            candidate.max[2] += shift;
        }
    });
}

pub(crate) fn commit_positions(
    plan: Vec<(usize, ModelCandidate)>,
    generation: u32,
    viewport: Option<&crate::protocol::Viewport>,
) {
    CANDIDATES.with(|slot| {
        let mut slot = slot.borrow_mut();
        for (i, c) in plan {
            slot[i] = c;
        }
    });
    if let Some(v) = viewport {
        CAMERA.with(|slot| slot.borrow_mut().viewport = [v.x, v.y, v.zoom]);
    }
    GENERATION.with(|cell| cell.set(generation));
}

/// 纯视口接受点：复用模型候选 AABB，只原子更新相机快照与 query generation
/// （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3；MUST NOT 重算 bounds）。
pub(crate) fn accept_viewport_camera(viewport: [f32; 3], surface: [f32; 2], generation: u32) {
    CAMERA.with(|slot| {
        let mut camera = slot.borrow_mut();
        camera.viewport = viewport;
        camera.surface = surface;
    });
    GENERATION.with(|cell| cell.set(generation));
}

fn as_tuples(candidates: &[ModelCandidate]) -> Vec<(&str, [f32; 3], [f32; 3])> {
    candidates
        .iter()
        .map(|candidate| (candidate.node_id.as_str(), candidate.min, candidate.max))
        .collect()
}

/// 普通正交画布模型 picking（JSON 入口）；generation 不匹配返回 stale。
pub(crate) fn pick_query_json(json: &str) -> String {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code)] // `width`/`height` 属查询线格式，当前实现只消费 x/y/generation。
    struct Request {
        generation: u32,
        #[serde(default)]
        kind: Option<String>,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    }
    let request = match serde_json::from_str::<Request>(json) {
        Ok(request) => request,
        Err(_) => return stale_result("unavailable"),
    };
    if !READY.with(std::cell::Cell::get) {
        return stale_result("unavailable");
    }
    if request.generation != GENERATION.with(std::cell::Cell::get) {
        return stale_result("stale");
    }
    if request.kind.as_deref() == Some("ground") {
        if !request.x.is_finite() || !request.y.is_finite() {
            return stale_result("unavailable");
        }
        let camera = CAMERA.with(|slot| *slot.borrow());
        if !camera.ordinary { return stale_result("unavailable"); }
        let view = crate::isometric_grid::IsometricGridView {
            x: camera.viewport[0], y: camera.viewport[1], zoom: camera.viewport[2],
        };
        let p = crate::isometric_grid::screen_to_ground(&view, bevy::prelude::Vec2::new(request.x, request.y));
        let u = p.x as f64 / crate::protocol::UNITS_PER_METER;
        let v = -(p.y as f64) / crate::protocol::UNITS_PER_METER;
        if !u.is_finite() || !v.is_finite() { return stale_result("unavailable"); }
        return serde_json::json!({"available": true, "generation": request.generation, "ground": {"u": u, "v": v}}).to_string();
    }
    if request.kind.is_some() { return stale_result("unsupported"); }
    let mut candidates = CANDIDATES.with(|slot| slot.borrow().iter().filter(|candidate| !candidate.shared_world).cloned().collect::<Vec<_>>());
    SHARED_CURRENT.with(|slot| candidates.extend(slot.borrow().iter().cloned()));
    let camera = CAMERA.with(|slot| *slot.borrow());
    let (origin, direction, max_t) = if let Some(focus) = camera.focus {
        let width = if camera.surface[0].is_finite() && camera.surface[0] > 1.0 {
            camera.surface[0]
        } else {
            request.width.max(1.0)
        };
        let height = if camera.surface[1].is_finite() && camera.surface[1] > 1.0 {
            camera.surface[1]
        } else {
            request.height.max(1.0)
        };
        let target = bevy::prelude::Vec3::from_array(focus.target);
        let cp = focus.pitch.cos();
        let dir = bevy::prelude::Vec3::new(
            focus.yaw.sin() * cp,
            -focus.pitch.sin(),
            focus.yaw.cos() * cp,
        );
        let position = target + dir * focus.distance;
        let rotation = bevy::prelude::Transform::from_translation(position)
            .looking_at(target, bevy::prelude::Vec3::Y)
            .rotation;
        let ndc_x = (request.x / width) * 2.0 - 1.0;
        let ndc_y = 1.0 - (request.y / height) * 2.0;
        let half = (focus.fov * 0.5).tan().max(1e-4);
        let local = bevy::prelude::Vec3::new(
            ndc_x * half * (width / height).max(1e-4),
            ndc_y * half,
            -1.0,
        )
        .normalize_or_zero();
        (position, (rotation * local).normalize_or_zero(), 200_000.0)
    } else {
        let view = crate::isometric_grid::IsometricGridView { x: camera.viewport[0], y: camera.viewport[1], zoom: camera.viewport[2] };
        let projection = crate::isometric_grid::canvas_camera_projection();
        let origin = crate::isometric_grid::screen_point_to_world(bevy::prelude::Vec2::new(request.x, request.y), CANVAS_CAMERA_Z - projection.near, &view);
        let direction = crate::isometric_grid::canvas_camera_rotation() * bevy::prelude::Vec3::NEG_Z;
        (origin, direction, projection.far - projection.near)
    };
    let picked = pick_candidates(&candidates, origin, direction, max_t);
    let result = match picked {
        Some((node_id, target, radius)) => ModelPickResult {
            available: true,
            reason: None,
            generation: request.generation,
            node_id: Some(node_id),
            target: Some(target),
            radius: Some(radius),
        },
        None => ModelPickResult {
            available: true,
            reason: None,
            generation: request.generation,
            node_id: None,
            target: None,
            radius: None,
        },
    };
    serde_json::to_string(&result).unwrap_or_else(|_| stale_result("unavailable"))
}

pub(crate) fn pick_candidates(candidates: &[ModelCandidate], origin: bevy::prelude::Vec3, direction: bevy::prelude::Vec3, max_t: f32) -> Option<(String, [f32; 3], f32)> {
    let mut best = None;
    let mut best_t = max_t;
    for candidate in candidates {
        let Some(broad) = ray_hits_aabb_clipped(origin.to_array(), direction.to_array(), candidate.min, candidate.max, max_t) else { continue };
        let t = if let Some(triangles) = &candidate.triangles {
            triangles.iter().filter_map(|triangle| ray_triangle(origin, direction, triangle)).filter(|t| *t <= max_t).fold(None, |best: Option<f32>, t| Some(best.map_or(t, |b| b.min(t))))
        } else if candidate.empty_marker || !candidate.shared_world { Some(broad) } else { None };
        if let Some(t) = t.filter(|t| *t < best_t) {
            best_t = t;
            let (center, radius) = center_radius(candidate.min, candidate.max);
            best = Some((candidate.node_id.clone(), center, radius));
        }
    }
    best
}

fn ray_triangle(origin: bevy::prelude::Vec3, direction: bevy::prelude::Vec3, triangle: &SurfaceTriangle) -> Option<f32> {
    use bevy::prelude::Vec3;
    let [a, b, c] = triangle.vertices.map(Vec3::from_array);
    let edge1 = b - a;
    let edge2 = c - a;
    let p = direction.cross(edge2);
    let determinant = edge1.dot(p);
    if determinant.abs() < 1e-8 || (triangle.cull_back && determinant <= 0.0) { return None; }
    let inverse = determinant.recip();
    let s = origin - a;
    let u = s.dot(p) * inverse;
    if !(0.0..=1.0).contains(&u) { return None; }
    let q = s.cross(edge1);
    let v = direction.dot(q) * inverse;
    if v < 0.0 || u + v > 1.0 { return None; }
    let t = edge2.dot(q) * inverse;
    (t >= 0.0 && t.is_finite()).then_some(t)
}

fn stale_result(reason: &str) -> String {
    serde_json::to_string(&ModelPickResult {
        available: false,
        reason: Some(reason.to_owned()),
        generation: GENERATION.with(std::cell::Cell::get),
        node_id: None,
        target: None,
        radius: None,
    })
    .unwrap_or_else(|_| "{}".to_owned())
}

/// 命中的模型语义结果。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPickResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    pub(crate) generation: u32,
    pub(crate) node_id: Option<String>,
    pub(crate) target: Option<[f32; 3]>,
    pub(crate) radius: Option<f32>,
}

/// 便捷：AABB 中心与包围球半径。
pub(crate) fn center_radius(min: [f32; 3], max: [f32; 3]) -> ([f32; 3], f32) {
    let center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    let radius = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() * 0.5;
    (center, radius)
}

/// slab 法 ray-AABB 命中；返回最近正/负交点（AABB 在射线背后返回 None）。
///
/// 与 contracts `rayIntersectsAabb` 同语义（用于逐位对齐的单元测试）。
#[cfg(test)]
pub(crate) fn ray_hits_aabb(
    origin: [f32; 3],
    direction: [f32; 3],
    min: [f32; 3],
    max: [f32; 3],
) -> Option<f32> {
    let mut tmin = f32::NEG_INFINITY;
    let mut tmax = f32::INFINITY;
    for axis in 0..3 {
        let o = origin[axis];
        let d = direction[axis];
        if d.abs() < 1e-9 {
            if o < min[axis] || o > max[axis] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / d;
        let mut t1 = (min[axis] - o) * inv;
        let mut t2 = (max[axis] - o) * inv;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        tmin = tmin.max(t1);
        tmax = tmax.min(t2);
        if tmin > tmax {
            return None;
        }
    }
    if tmax < 0.0 {
        return None;
    }
    Some(if tmin >= 0.0 { tmin } else { tmax })
}

/// 普通正交画布下按屏幕点命中最近的模型 AABB。
///
/// `candidates` 为 `(nodeId, worldMin, worldMax)`；`surface` 为 CSS 尺寸；`point` 为 canvas 内
/// CSS 坐标（原点左上）。相机为等距倾斜正交相机（change: drive-focus-view-from-shot-rig）；
/// viewport 由接受点快照提供：射线起点取实际 near 平面并限制 far 深度范围，覆盖负 near
/// 允许的相机两侧几何（change: make-shot-framing-zoom-invariant，design D5）。
pub(crate) fn pick_nearest(
    candidates: &[(&str, [f32; 3], [f32; 3])],
    surface: (f32, f32),
    point: (f32, f32),
    viewport: [f32; 3],
) -> Option<(String, [f32; 3], f32)> {
    let _ = surface;
    let view = crate::isometric_grid::IsometricGridView {
        x: viewport[0],
        y: viewport[1],
        zoom: viewport[2],
    };
    let projection = crate::isometric_grid::canvas_camera_projection();
    let near = projection.near;
    let far = projection.far;
    // 起点在实际 near 平面；有效参数范围 0..=(far - near)。
    let origin = crate::isometric_grid::screen_point_to_world(
        bevy::prelude::Vec2::new(point.0, point.1),
        CANVAS_CAMERA_Z - near,
        &view,
    );
    let direction = crate::isometric_grid::canvas_camera_rotation() * bevy::prelude::Vec3::NEG_Z;
    pick_nearest_ray_clipped(
        candidates,
        origin.to_array(),
        direction.to_array(),
        far - near,
    )
}

/// 与 [`pick_nearest_ray`] 相同，但限制有效参数范围 `[0, max_t]`，覆盖 AABB 包含 near 起点
/// （命中距离取零）与完全超出可见深度范围的候选（design D5）。
pub(crate) fn pick_nearest_ray_clipped(
    candidates: &[(&str, [f32; 3], [f32; 3])],
    origin: [f32; 3],
    direction: [f32; 3],
    max_t: f32,
) -> Option<(String, [f32; 3], f32)> {
    let mut best: Option<(String, [f32; 3], f32, f32)> = None;
    for (node_id, min, max) in candidates {
        let Some(t) = ray_hits_aabb_clipped(origin, direction, *min, *max, max_t) else {
            continue;
        };
        if best
            .as_ref()
            .is_some_and(|(_, _, _, current)| t >= *current)
        {
            continue;
        }
        let (center, radius) = center_radius(*min, *max);
        best = Some(((*node_id).to_owned(), center, radius, t));
    }
    best.map(|(node_id, center, radius, _)| (node_id, center, radius))
}

/// slab 法 ray-AABB 命中，限制在 `[0, max_t]` 内；AABB 包含起点时距离取零。
pub(crate) fn ray_hits_aabb_clipped(
    origin: [f32; 3],
    direction: [f32; 3],
    min: [f32; 3],
    max: [f32; 3],
    max_t: f32,
) -> Option<f32> {
    let mut tmin = f32::NEG_INFINITY;
    let mut tmax = f32::INFINITY;
    for axis in 0..3 {
        let o = origin[axis];
        let d = direction[axis];
        if d.abs() < 1e-9 {
            if o < min[axis] || o > max[axis] {
                return None;
            }
            continue;
        }
        let inv = 1.0 / d;
        let mut t1 = (min[axis] - o) * inv;
        let mut t2 = (max[axis] - o) * inv;
        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }
        tmin = tmin.max(t1);
        tmax = tmax.min(t2);
        if tmin > tmax {
            return None;
        }
    }
    if tmax < 0.0 {
        return None;
    }
    // AABB 包含 near 起点（tmin < 0 <= tmax）时命中距离为零。
    let t = tmin.max(0.0);
    (t <= max_t).then_some(t)
}

/// 聚焦（透视）相机的屏幕射线命中（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D5）。
///
/// 与 `favicon` 无关；与 contracts `focusRay` 同针孔模型：`position/direction` 由调用方按当前
/// 聚焦相机与指针求出后传入，本函数只做 ray-AABB 取最近。
///
/// 生产路径走 [`pick_nearest_ray_clipped`]；本函数仅供 golden 单元测试对照。
#[cfg(test)]
pub(crate) fn pick_nearest_ray(
    candidates: &[(&str, [f32; 3], [f32; 3])],
    origin: [f32; 3],
    direction: [f32; 3],
) -> Option<(String, [f32; 3], f32)> {
    let mut best: Option<(String, [f32; 3], f32, f32)> = None;
    for (node_id, min, max) in candidates {
        let Some(t) = ray_hits_aabb(origin, direction, *min, *max) else {
            continue;
        };
        if best
            .as_ref()
            .is_some_and(|(_, _, _, current)| t >= *current)
        {
            continue;
        }
        let (center, radius) = center_radius(*min, *max);
        best = Some(((*node_id).to_owned(), center, radius, t));
    }
    best.map(|(node_id, center, radius, _)| (node_id, center, radius))
}

#[cfg(test)]
mod position_tests;

#[cfg(test)]
mod tests;
