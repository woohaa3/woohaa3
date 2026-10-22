//! 模型编辑 gizmo（focus 三轴 / shot 镜头 / placement）的投影与命中
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.3 / design D5）。
//!
//! 纯数组数学，不依赖 ECS/wasm/Bevy：与 contracts 的 `gizmo.ts` **逐条同构**，供 Rust
//! picking 与绘制共用同一事实源。命中阈值与 contracts 常量一致（CSS px）。
//!
//! 本模块不接收 scene JSON：调用方（WASM facade）从已接受的瞬时 editor/focus 快照取几何入参。

mod query;

#[cfg(feature = "canvas-core")]
pub(crate) use query::gizmo_query_json;

use serde::Serialize;

/// 命中阈值（CSS px）。与 contracts `gizmo.ts` 常量一致。
pub(crate) const SHOT_RING_HIT_RADIUS_CSS: f32 = 28.0;
pub(crate) const SHOT_ORIGIN_HIT_RADIUS_CSS: f32 = 36.0;
pub(crate) const SHOT_DISTANCE_SEGMENT_HIT_CSS: f32 = 14.0;
/// 竖直半圆命中阈值（CSS px；change: add-shot-camera-elevation-control）。
pub(crate) const SHOT_ELEVATION_RING_HIT_CSS: f32 = 24.0;
pub(crate) const MODEL_GIZMO_CENTER_HIT_CSS: f32 = 18.0;
pub(crate) const MODEL_GIZMO_RING_HIT_CSS: f32 = 12.0;
pub(crate) const FOCUS_GIZMO_AXIS_HIT_CSS: f32 = 12.0;
/// 注视点中心抓取半径（CSS px）；与主画面/旧 TS 命中一致（10px）。
pub(crate) const FOCUS_GIZMO_CENTER_HIT_CSS: f32 = 10.0;

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn length(a: V3) -> f32 {
    dot(a, a).sqrt()
}
fn normalize(a: V3) -> V3 {
    let len = length(a);
    if len < 1e-9 {
        [0.0, 0.0, 0.0]
    } else {
        [a[0] / len, a[1] / len, a[2] / len]
    }
}

/// 屏幕点。
pub(crate) type Screen = (f32, f32);
/// 世界点 → 屏幕点；不可投影返回 None。
pub(crate) type Projector<'a> = Box<dyn Fn(V3) -> Option<Screen> + 'a>;

/// 点到线段的最短距离（CSS px）。
pub(crate) fn distance_to_segment(point: Screen, a: Screen, b: Screen) -> f32 {
    let abx = b.0 - a.0;
    let aby = b.1 - a.1;
    let length_sq = abx * abx + aby * aby;
    if length_sq <= 1e-9 {
        return ((point.0 - a.0).powi(2) + (point.1 - a.1).powi(2)).sqrt();
    }
    let mut t = ((point.0 - a.0) * abx + (point.1 - a.1) * aby) / length_sq;
    t = t.clamp(0.0, 1.0);
    ((point.0 - (a.0 + abx * t)).powi(2) + (point.1 - (a.1 + aby * t)).powi(2)).sqrt()
}

/// 聚焦相机参数（与 contracts `ModelFocusCamera` 一致）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusCamera {
    pub(crate) target: V3,
    pub(crate) yaw: f32,
    pub(crate) pitch: f32,
    pub(crate) distance: f32,
}

impl FocusCamera {
    fn position(&self) -> V3 {
        let dir = [
            self.yaw.sin() * self.pitch.cos(),
            -self.pitch.sin(),
            self.yaw.cos() * self.pitch.cos(),
        ];
        [
            self.target[0] + dir[0] * self.distance,
            self.target[1] + dir[1] * self.distance,
            self.target[2] + dir[2] * self.distance,
        ]
    }
}

/// 聚焦（透视）投影器，与 contracts `makeFocusProjector` 同针孔模型。
pub(crate) fn focus_projector(camera: FocusCamera, surface: (f32, f32), fov: f32) -> Projector<'static> {
    let position = camera.position();
    let forward = normalize(sub(camera.target, position));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let width = if surface.0 > 0.0 { surface.0 } else { 1.0 };
    let height = if surface.1 > 0.0 { surface.1 } else { 1.0 };
    let focal = height / (2.0 * (fov / 2.0).tan());
    Box::new(move |world: V3| {
        let rel = sub(world, position);
        let z = dot(rel, forward);
        if !z.is_finite() || z <= 1e-4 {
            return None;
        }
        let x = dot(rel, right);
        let y = dot(rel, up);
        Some((width / 2.0 + (x * focal) / z, height / 2.0 - (y * focal) / z))
    })
}

/// Pointer ray using exactly the focus projector camera basis.
pub(crate) fn focus_ray(camera: FocusCamera, surface: (f32, f32), point: (f32, f32)) -> (V3, V3) {
    let position = camera.position();
    let forward = normalize(sub(camera.target, position));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let focal = surface.1.max(1.0) / (2.0 * (MODEL_FOCUS_FOV / 2.0).tan());
    let x = (point.0 - surface.0 / 2.0) / focal;
    let y = (surface.1 / 2.0 - point.1) / focal;
    let direction = normalize(std::array::from_fn(|i| forward[i] + right[i] * x + up[i] * y));
    (position, direction)
}

/// 拍摄镜头投影器：透视针孔模型
/// （change: switch-shot-camera-to-perspective）。
///
/// 与 `focus_projector` 同源：世界点经相机基分解后按 `focal/z` 投影，`focal = height/(2*tan(fov/2))`。
/// 相机自身眼点退化为投影中心（shot-origin handle）；其余后方点不可投影。
pub(crate) fn shot_projector(
    focus: V3,
    camera_position: V3,
    fov: f32,
    surface: (f32, f32),
) -> Projector<'static> {
    let forward = normalize(sub(focus, camera_position));
    let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
    let up = cross(right, forward);
    let width = if surface.0 > 0.0 { surface.0 } else { 1.0 };
    let height = if surface.1 > 0.0 { surface.1 } else { 1.0 };
    let safe_fov = if fov.is_finite() && fov > 0.0 && fov < std::f32::consts::PI {
        fov
    } else {
        std::f32::consts::FRAC_PI_3
    };
    let focal = height / (2.0 * (safe_fov / 2.0).tan());
    Box::new(move |world: V3| {
        let rel = sub(world, camera_position);
        let z = dot(rel, forward);
        let x = dot(rel, right);
        let y = dot(rel, up);
        if !z.is_finite() || !x.is_finite() || !y.is_finite() {
            return None;
        }
        if z <= 1e-4 {
            let radial = (x * x + y * y).sqrt();
            if radial <= 1e-4 {
                return Some((width / 2.0, height / 2.0));
            }
            return None;
        }
        Some((width / 2.0 + (x * focal) / z, height / 2.0 - (y * focal) / z))
    })
}

/// 焦点三轴 gizmo 几何。
pub(crate) struct FocusGizmo {
    pub(crate) origin: V3,
    pub(crate) axis_length: f32,
    pub(crate) x: V3,
    pub(crate) y: V3,
    pub(crate) z: V3,
}

pub(crate) fn focus_gizmo(focus: V3, radius: f32) -> FocusGizmo {
    let radius = if radius > 1e-3 && radius.is_finite() { radius } else { 1.0 };
    let length = radius * 1.15;
    FocusGizmo {
        origin: focus,
        axis_length: length,
        x: [focus[0] + length, focus[1], focus[2]],
        y: [focus[0], focus[1] + length, focus[2]],
        z: [focus[0], focus[1], focus[2] + length],
    }
}

/// 命中焦点三轴：阈值内取距离最近的轴。
pub(crate) fn hit_focus_gizmo(pointer: Screen, geometry: &FocusGizmo, project: &Projector) -> Option<(&'static str, f32)> {
    let origin = project(geometry.origin)?;
    let mut best: Option<(&'static str, f32)> = None;
    for (axis, endpoint) in [("x", geometry.x), ("y", geometry.y), ("z", geometry.z)] {
        let Some(tip) = project(endpoint) else { continue };
        let distance = distance_to_segment(pointer, origin, tip);
        if distance <= FOCUS_GIZMO_AXIS_HIT_CSS && best.is_none_or(|(_, current)| distance < current) {
            best = Some((axis, distance));
        }
    }
    best
}

/// shot gizmo 几何。
pub(crate) struct ShotGizmo {
    pub(crate) focus: V3,
    pub(crate) camera_position: V3,
    pub(crate) ring_radius: f32,
}

pub(crate) fn shot_gizmo(focus: V3, camera_position: V3, radius: f32) -> ShotGizmo {
    let radius = if radius > 1e-3 && radius.is_finite() { radius } else { 1.0 };
    ShotGizmo {
        focus,
        camera_position,
        ring_radius: radius * 1.15,
    }
}

fn horizontal_ring(center: V3, radius: f32, segments: usize) -> Vec<V3> {
    (0..segments)
        .map(|index| {
            let angle = (index as f32 / segments as f32) * std::f32::consts::PI * 2.0;
            [center[0] + angle.cos() * radius, center[1], center[2] + angle.sin() * radius]
        })
        .collect()
}

/// 竖直仰角半圆采样（过 focus、含世界 Y 轴与方位径向；`-90°..+90°`，change: add-shot-camera-elevation-control）。
fn vertical_semicircle(center: V3, radial: V3, radius: f32, segments: usize) -> Vec<V3> {
    (0..=segments)
        .map(|index| {
            let angle = -std::f32::consts::FRAC_PI_2
                + (index as f32 / segments as f32) * std::f32::consts::PI;
            let cos = angle.cos();
            let sin = angle.sin();
            [
                center[0] + radial[0] * cos * radius,
                center[1] + sin * radius,
                center[2] + radial[2] * cos * radius,
            ]
        })
        .collect()
}

/// 命中 shot gizmo：镜头原点 → 水平方位环 → 竖直半圆 → 距离段。
pub(crate) fn hit_shot_gizmo(pointer: Screen, geometry: &ShotGizmo, project: &Projector) -> Option<(&'static str, f32)> {
    let origin = project(geometry.camera_position);
    if let Some(origin) = origin {
        let d = ((pointer.0 - origin.0).powi(2) + (pointer.1 - origin.1).powi(2)).sqrt();
        if d <= SHOT_ORIGIN_HIT_RADIUS_CSS {
            return Some(("shot-origin", d));
        }
    }
    let delta = sub(geometry.camera_position, geometry.focus);
    let full = length(delta);
    let horizontal = (delta[0] * delta[0] + delta[2] * delta[2]).sqrt();
    // 球笼半径 = 相机到焦点的完整距离（与 contracts 一致），拖动仰角/方位时保持不变。
    let cage_radius = if full > 1e-3 { full } else { geometry.ring_radius };
    let ring = horizontal_ring(geometry.focus, cage_radius, 48);
    let mut best: Option<(&'static str, f32)> = None;
    for index in 0..ring.len() {
        let (Some(a), Some(b)) = (project(ring[index]), project(ring[(index + 1) % ring.len()])) else {
            continue;
        };
        let distance = distance_to_segment(pointer, a, b);
        if distance <= SHOT_RING_HIT_RADIUS_CSS && best.is_none_or(|(_, current)| distance < current) {
            best = Some(("orbit-ring", distance));
        }
    }
    if best.is_some() {
        return best;
    }
    // 竖直半圆：与水平环同段优先级，命中更近者胜出。
    let radial = if horizontal > 1e-3 {
        [delta[0] / horizontal, 0.0, delta[2] / horizontal]
    } else {
        [0.0, 0.0, 1.0]
    };
    let arc = vertical_semicircle(geometry.focus, radial, cage_radius, 32);
    for index in 0..arc.len().saturating_sub(1) {
        let (Some(a), Some(b)) = (project(arc[index]), project(arc[index + 1])) else {
            continue;
        };
        let distance = distance_to_segment(pointer, a, b);
        if distance <= SHOT_ELEVATION_RING_HIT_CSS && best.is_none_or(|(_, current)| distance < current) {
            best = Some(("elevation-ring", distance));
        }
    }
    if best.is_some() {
        return best;
    }
    if let (Some(origin), Some(focus)) = (origin, project(geometry.focus)) {
        let distance = distance_to_segment(pointer, origin, focus);
        if distance <= SHOT_DISTANCE_SEGMENT_HIT_CSS {
            return Some(("distance", distance));
        }
    }
    None
}

/// placement gizmo 几何（世界 Y 轴 yaw 环）。
pub(crate) struct ModelGizmo {
    pub(crate) center: V3,
    pub(crate) ring_radius: f32,
}

pub(crate) fn model_gizmo(focus: V3, radius: f32) -> ModelGizmo {
    let radius = if radius > 1e-3 && radius.is_finite() { radius } else { 1.0 };
    ModelGizmo {
        center: focus,
        ring_radius: radius * 1.15,
    }
}

/// 命中 placement gizmo：中心 → yaw 环。
pub(crate) fn hit_model_gizmo(pointer: Screen, geometry: &ModelGizmo, project: &Projector) -> Option<(&'static str, f32)> {
    if let Some(center) = project(geometry.center) {
        let d = ((pointer.0 - center.0).powi(2) + (pointer.1 - center.1).powi(2)).sqrt();
        if d <= MODEL_GIZMO_CENTER_HIT_CSS {
            return Some(("center", d));
        }
    }
    let ring = horizontal_ring(geometry.center, geometry.ring_radius, 48);
    let mut best: Option<(&'static str, f32)> = None;
    for index in 0..ring.len() {
        let (Some(a), Some(b)) = (project(ring[index]), project(ring[(index + 1) % ring.len()])) else {
            continue;
        };
        let distance = distance_to_segment(pointer, a, b);
        if distance <= MODEL_GIZMO_RING_HIT_CSS && best.is_none_or(|(_, current)| distance < current) {
            best = Some(("yaw-ring", distance));
        }
    }
    best
}

/// 轴拖动 → 世界位移（与 contracts `focusAxisDragWorldDelta` 同公式）。
///
/// 当前生产路径直接消费 contracts 计算的约束；本函数仅供 golden 单元测试对照。
#[cfg(test)]
pub(crate) fn focus_axis_drag_world_delta(
    delta_screen: (f32, f32),
    axis_start: Screen,
    axis_end: Screen,
    axis_length: f32,
) -> Option<f32> {
    let sx = axis_end.0 - axis_start.0;
    let sy = axis_end.1 - axis_start.1;
    let screen_length = (sx * sx + sy * sy).sqrt();
    if !screen_length.is_finite() || screen_length < 1e-3 {
        return None;
    }
    if !(axis_length > 0.0) || !axis_length.is_finite() {
        return None;
    }
    let ux = sx / screen_length;
    let uy = sy / screen_length;
    let projected = delta_screen.0 * ux + delta_screen.1 * uy;
    let world_per_pixel = axis_length / screen_length;
    let delta = projected * world_per_pixel;
    delta.is_finite().then_some(delta)
}

/// gizmo 命中结果（JSON 边界用）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GizmoHitResult {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    /// `shot-origin` / `orbit-ring` / `distance` / `center` / `yaw-ring` / `x` / `y` / `z`。
    pub(crate) handle: Option<String>,
    /// 轴拖动约束（仅焦点三轴命中时）。
    pub(crate) constraint: Option<AxisDragConstraint>,
}

/// 与 contracts `MODEL_FOCUS_FOV` 一致（50°，弧度）。
pub(crate) const MODEL_FOCUS_FOV: f32 = 50.0 * std::f32::consts::PI / 180.0;

/// 焦点 gizmo 的屏幕轴约束（供 JS 连续拖动复用，无需重建相机矩阵）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AxisDragConstraint {
    pub(crate) axis: String,
    /// 轴屏幕方向（单位向量）。
    pub(crate) direction: (f32, f32),
    /// 世界长度 / 屏幕像素。
    pub(crate) world_per_pixel: f32,
}

pub(crate) fn focus_axis_constraint(geometry: &FocusGizmo, axis: &str, project: &Projector) -> Option<AxisDragConstraint> {
    let endpoint = match axis {
        "x" => geometry.x,
        "y" => geometry.y,
        "z" => geometry.z,
        _ => return None,
    };
    let origin = project(geometry.origin)?;
    let tip = project(endpoint)?;
    let sx = tip.0 - origin.0;
    let sy = tip.1 - origin.1;
    let screen_length = (sx * sx + sy * sy).sqrt();
    if !screen_length.is_finite() || screen_length < 1e-3 {
        return None;
    }
    Some(AxisDragConstraint {
        axis: axis.to_owned(),
        direction: (sx / screen_length, sy / screen_length),
        world_per_pixel: geometry.axis_length / screen_length,
    })
}

#[cfg(test)]
mod tests;
