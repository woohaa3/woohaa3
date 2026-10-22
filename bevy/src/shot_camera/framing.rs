//! Shot camera 取景数学（纯函数）
//! （change: add-reusable-bevy-shot-camera，任务 1.2 / design D2；
//!  change: add-shot-camera-elevation-control）。
//!
//! 移植 Godot `shot_camera.gd` 的轨道、AABB 自动取景、距离 clamp、正交取景
//! 与 Web `contracts/src/canvas/shot-camera.ts`。本模块不依赖 Bevy ECS / renderer / DOM，
//! 只做数值派生；Rust 与 TypeScript 通过同一 fixture 与容差测试保持一致。
//!
//! 持久化的只有 `azimuth` / `elevation` / `distance` / `aspect` / `focusOffset`；position、
//! focus、projection、fit distance、ortho size 全部由当前目标 AABB 派生。仰角默认 45°，
//! 可在竖直半圆 `[-90°, +90°]` 内变化，派生姿态钳入奇点容差。

use bevy::math::Vec3;

/// 固定仰角（45°）——作为缺省与兼容默认，不再强制（design D3；change: add-shot-camera-elevation-control）。
pub const SHOT_CAMERA_ELEVATION: f32 = std::f32::consts::FRAC_PI_4;
/// 仰角规范半圆范围（正下方到正上方）。
pub const SHOT_CAMERA_MIN_ELEVATION: f32 = -std::f32::consts::FRAC_PI_2;
pub const SHOT_CAMERA_MAX_ELEVATION: f32 = std::f32::consts::FRAC_PI_2;
/// 派生姿态与手势使用的奇点容差（89°），避免与世界上方向共线。
pub const SHOT_CAMERA_ELEVATION_LIMIT: f32 = 89.0 * std::f32::consts::PI / 180.0;
/// 自动 fit distance 的下/上系数（design D3；下限系数用于参考，实际下限见 `SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR`）。
pub const SHOT_CAMERA_FIT_MIN_FACTOR: f32 = 0.45;
pub const SHOT_CAMERA_FIT_MAX_FACTOR: f32 = 2.2;
/// 距离下限放开：绝对最小值与 fit 比例（change: switch-shot-camera-to-perspective）。
pub const SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE: f32 = 0.01;
pub const SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR: f32 = 0.02;
/// 距离上限绝对最小值（与旧行为一致）。
pub const SHOT_CAMERA_ABSOLUTE_MAX_DISTANCE: f32 = 2.4;
/// 自动取景外扩系数（与聚焦查看一致）。
pub const SHOT_FRAME_PADDING: f32 = 1.12;
/// 垂直 FOV（弧度），与 Web `MODEL_FOCUS_FOV` / Rust `model3d::focus` 一致。
pub const SHOT_CAMERA_FOV: f32 = 50.0 * std::f32::consts::PI / 180.0;
/// 退化情形下的最小 radius，避免除零。
pub const MIN_RADIUS: f32 = 1e-4;

/// 轴对齐包围盒（世界坐标）；与 Web `Aabb` 语义一致。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub const fn new(min: Vec3, max: Vec3) -> Self {
        Self { min, max }
    }

    /// 六个分量是否全部有限。
    pub fn is_finite(&self) -> bool {
        self.min.is_finite() && self.max.is_finite()
    }

    /// 包围球中心（AABB 中点）。
    pub fn center(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    /// 包围球半径（对角半长）。
    pub fn radius(&self) -> f32 {
        (self.max - self.min).length() * 0.5
    }
}

/// 由 AABB 求包围球半径（非有限/退化时回退 1）。
pub fn shot_bounding_radius(aabb: &Aabb) -> f32 {
    let radius = aabb.radius();
    if radius > MIN_RADIUS && radius.is_finite() {
        radius
    } else {
        1.0
    }
}

/// 自动 fit distance：Godot bounding-sphere 规则，再乘 padding。
///
/// 以垂直 FOV 为基准，按 aspect 取更紧的等效半角（与 Web `shotFitDistance` 一致）。
pub fn shot_fit_distance(radius: f32, aspect: f32) -> f32 {
    let safe_radius = if radius > MIN_RADIUS && radius.is_finite() {
        radius
    } else {
        1.0
    };
    let safe_aspect = if aspect > 0.0 && aspect.is_finite() {
        aspect
    } else {
        16.0 / 9.0
    };
    let vertical_half = SHOT_CAMERA_FOV / 2.0;
    let horizontal_half = (vertical_half.tan() * safe_aspect).atan();
    let effective_half = vertical_half.min(horizontal_half).max(1e-3);
    (safe_radius * SHOT_FRAME_PADDING) / effective_half.sin()
}

/// 距离合法范围：下限放开到可贴近，上限 `max(fit*2.2, 2.4)`（design D3 + switch-shot-camera-to-perspective）。
pub fn shot_distance_bounds(fit_distance: f32) -> (f32, f32) {
    let fit = if fit_distance > MIN_RADIUS && fit_distance.is_finite() {
        fit_distance
    } else {
        1.0
    };
    (
        (fit * SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR).max(SHOT_CAMERA_ABSOLUTE_MIN_DISTANCE),
        (fit * SHOT_CAMERA_FIT_MAX_FACTOR).max(SHOT_CAMERA_ABSOLUTE_MAX_DISTANCE),
    )
}

/// 把距离 clamp 进合法范围；非有限值回退 fit distance。
pub fn clamp_shot_distance(distance: f32, fit_distance: f32) -> f32 {
    let (min, max) = shot_distance_bounds(fit_distance);
    if !distance.is_finite() {
        return fit_distance;
    }
    distance.clamp(min, max)
}

/// 由方位角、仰角与距离求镜头相机位置：绕世界 Y 轴按 azimuth 环绕、沿竖直半圆按 elevation 抬升。
///
/// `position = focus + (sin(az)*cos(el), sin(el), cos(az)*cos(el)) * distance`。
/// `elevation` 缺省 45° 并钳入奇点容差。
pub fn shot_camera_position(focus: Vec3, azimuth: f32, distance: f32, elevation: f32) -> Vec3 {
    let el = clamp_shot_elevation(elevation);
    let cos_el = el.cos();
    let dir = Vec3::new(azimuth.sin() * cos_el, el.sin(), azimuth.cos() * cos_el);
    focus + dir * distance
}

/// 把仰角钳制到奇点容差以内；非有限值回退默认 45°。
pub fn clamp_shot_elevation(elevation: f32) -> f32 {
    if !elevation.is_finite() {
        return SHOT_CAMERA_ELEVATION;
    }
    elevation.clamp(-SHOT_CAMERA_ELEVATION_LIMIT, SHOT_CAMERA_ELEVATION_LIMIT)
}

/// 焦点平面处的世界高度：`2 * distance * tan(fov/2)`（change: switch-shot-camera-to-perspective）。
///
/// 透视下屏幕像素与世界单位的换算依赖到焦点的距离；替代正交的取景半高。
pub fn shot_focus_plane_height(distance: f32, fov: f32) -> f32 {
    let safe_distance = if distance.is_finite() { distance } else { 1.0 };
    let safe_fov = if fov.is_finite() && fov > 0.0 && fov < std::f32::consts::PI {
        fov
    } else {
        SHOT_CAMERA_FOV
    };
    2.0 * safe_distance * (safe_fov / 2.0).tan()
}

/// 焦点平面处的取景半高：`distance * tan(fov/2)`（change: switch-shot-camera-to-perspective）。
///
/// 供 gizmo 尺寸等按"当前取景多大"缩放的派生使用，替代正交的 `shot_ortho_size`。
pub fn shot_view_half_height(distance: f32, fov: f32) -> f32 {
    shot_focus_plane_height(distance, fov) * 0.5
}

/// 派生镜头透视相机（design D3 + change: switch-shot-camera-to-perspective）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramedShotCamera {
    pub position: Vec3,
    pub focus: Vec3,
    /// 透视垂直 FOV（弧度）。
    pub fov: f32,
    pub azimuth: f32,
    pub elevation: f32,
    pub distance: f32,
}

/// 从当前模型 AABB 与镜头记录派生完整正交相机。
///
/// 有效 focus = 模型 AABB 中心 + 镜头 `focus_offset`（缺省零偏移）。distance 以模型包围球
/// 半径自动 fit 并 clamp；focus 偏移不改变自动 fit 的半径基准。AABB 非法/退化时返回 None。
pub fn resolve_shot_camera(
    aabb: &Aabb,
    azimuth: f32,
    elevation: f32,
    distance: f32,
    aspect: f32,
    focus_offset: Vec3,
) -> Option<FramedShotCamera> {
    if !aabb.is_finite() {
        return None;
    }
    Some(resolve_from_center_radius(
        aabb.center(),
        aabb.radius(),
        azimuth,
        elevation,
        distance,
        aspect,
        focus_offset,
    ))
}

/// 由显式中心与 bounding radius 派生透视相机（宿主已从 AABB/包围球派生好这些值）。
pub fn resolve_from_center_radius(
    center: Vec3,
    radius: f32,
    azimuth: f32,
    elevation: f32,
    distance: f32,
    aspect: f32,
    focus_offset: Vec3,
) -> FramedShotCamera {
    let safe_radius = if radius > MIN_RADIUS && radius.is_finite() {
        radius
    } else {
        1.0
    };
    let fit_distance = shot_fit_distance(safe_radius, aspect);
    let distance = clamp_shot_distance(distance, fit_distance);
    let elevation = clamp_shot_elevation(elevation);
    let focus = if focus_offset.is_finite() {
        center + focus_offset
    } else {
        center
    };
    FramedShotCamera {
        position: shot_camera_position(focus, azimuth, distance, elevation),
        focus,
        fov: SHOT_CAMERA_FOV,
        azimuth,
        elevation,
        distance,
    }
}

/// 方位环拖动：一次横向拖动一屏（`surface_width` CSS px）对应一周。
pub fn azimuth_from_horizontal_drag(start_azimuth: f32, delta_x: f32, surface_width: f32) -> f32 {
    let safe_width = if surface_width > 1.0 && surface_width.is_finite() {
        surface_width
    } else {
        1.0
    };
    start_azimuth + (delta_x / safe_width) * std::f32::consts::TAU
}

/// 竖直半圆拖动（change: add-shot-camera-elevation-control）：向上增、向下减，结果钳入奇点容差。
///
/// `delta_pixels` 为相对起始点的屏幕 y 位移（向下为正）；一屏竖直拖动对应 180°。
pub fn elevation_from_vertical_drag(
    start_elevation: f32,
    delta_pixels: f32,
    surface_height: f32,
) -> f32 {
    let safe_height = if surface_height > 1.0 && surface_height.is_finite() {
        surface_height
    } else {
        1.0
    };
    let delta = if delta_pixels.is_finite() {
        delta_pixels
    } else {
        0.0
    };
    clamp_shot_elevation(start_elevation - (delta / safe_height) * std::f32::consts::PI)
}

/// 距离手柄拖动：把屏幕指针位移换算为距离变化，再 clamp 到合法范围。
///
/// `delta_pixels` 为相对起始点的屏幕 y 位移（向下为正）。
/// 向下（朝 focus）拉近，反向推远。
pub fn distance_from_drag(
    start_distance: f32,
    delta_pixels: f32,
    surface_height: f32,
    fit_distance: f32,
) -> f32 {
    let safe_height = if surface_height > 1.0 && surface_height.is_finite() {
        surface_height
    } else {
        1.0
    };
    // 透视：屏幕像素与世界单位的换算依赖到焦点的距离（change: switch-shot-camera-to-perspective）。
    let world_per_pixel = shot_focus_plane_height(start_distance, SHOT_CAMERA_FOV) / safe_height;
    let delta_world = -delta_pixels * world_per_pixel;
    clamp_shot_distance(start_distance + delta_world, fit_distance)
}

/// 相机 forward（-Z 指向 focus）；供渲染层与测试校验朝向。
pub fn shot_camera_forward(position: Vec3, focus: Vec3) -> Vec3 {
    let forward = focus - position;
    let length = forward.length();
    if length <= MIN_RADIUS {
        Vec3::new(0.0, 0.0, -1.0)
    } else {
        forward / length
    }
}

/// 相机右方向（forward × up）。
pub fn shot_camera_right(position: Vec3, focus: Vec3) -> Vec3 {
    let right = shot_camera_forward(position, focus).cross(Vec3::Y);
    let length = right.length();
    if length <= MIN_RADIUS {
        Vec3::X
    } else {
        right / length
    }
}
