//! 片场场景空间 ↔ 画布呈现空间的纯数学
//! （change: 2026-10-23-isolate-film-set-camera-space，design D1/D2）。
//!
//! 片场作品的内容（几何、媒体、镜头距离、焦点偏移、镜头运动）全部使用**场景单位**；画布节点
//! 矩形、容器适配倍率与 viewport 只决定呈现。内容与完整相机姿态共享同一个正等比相似变换：
//!
//! ```text
//! world = anchor + s * R(yaw) * scene
//! s     = min(placement.scale, 1) * 192 / extent * filmSetFit（= model_unit）
//! ```
//!
//! 因此透视除法中的 x/z、y/z 不变，屏幕构图不随呈现倍率变化。任何非有限值或非正倍率都显式
//! 失败，不构造可产生 NaN 的镜头。Web 侧同一公式在 `contracts/src/canvas/film-set-space.ts`，
//! 共享 `web/contracts/fixtures/film-set-space.json` 对齐。

use bevy::prelude::{Quat, Vec3};

/// 场景单位 → 画布世界单位的显示变换（只含等比倍率与绕 Y 轴旋转）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayUnit {
    /// 正等比倍率。
    pub scale: f32,
    /// 显示容器绕世界 Y 轴旋转（弧度）。
    pub yaw: f32,
}

impl DisplayUnit {
    /// 非法倍率/旋转显式失败，不构造可产生 NaN 的镜头。
    pub fn validated(scale: f32, yaw: f32) -> Option<Self> {
        if !scale.is_finite() || scale <= 0.0 || !yaw.is_finite() {
            return None;
        }
        Some(Self { scale, yaw })
    }

    /// 场景点 → 画布世界点（相对锚点）。
    pub fn point(self, anchor: Vec3, point: Vec3) -> Vec3 {
        anchor + Quat::from_rotation_y(self.yaw) * (point * self.scale)
    }

    /// 场景向量 → 画布世界向量（缩放 + 绕 Y 轴旋转）。
    pub fn vector(self, vector: Vec3) -> Vec3 {
        Quat::from_rotation_y(self.yaw) * (vector * self.scale)
    }

    /// 画布世界向量 → 场景向量（逆旋转、逆缩放）。
    pub fn unvector(self, vector: Vec3) -> Vec3 {
        Quat::from_rotation_y(-self.yaw) * (vector / self.scale)
    }
}

/// 场景镜头状态（与 canonical `initialCamera` / `ModelCamera` 同单位）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneCamera {
    pub azimuth: f32,
    pub elevation: f32,
    pub distance: f32,
    pub focus_offset: Vec3,
}

/// 场景相机 → 画布显示相机（距离、focusOffset 与方位角同一相似变换）。
///
/// `distance` 乘显示倍率，`focusOffset` 旋转并缩放，`azimuth` 加上容器 yaw（相机位置必须等于
/// `D(sceneCameraPosition)`）；`elevation` 是竖直角，与容器绕 Y 轴旋转无关。非法输入返回
/// `None`，调用方不得写入或渲染猜测的镜头。
pub fn display_camera(display: Option<DisplayUnit>, camera: &SceneCamera) -> Option<SceneCamera> {
    if !camera.focus_offset.is_finite()
        || !camera.azimuth.is_finite()
        || !camera.elevation.is_finite()
        || !camera.distance.is_finite()
        || !(camera.distance > 0.0)
    {
        return None;
    }
    let (focus_offset, distance, azimuth) = match display {
        Some(unit) => (
            unit.vector(camera.focus_offset),
            camera.distance * unit.scale,
            camera.azimuth + unit.yaw,
        ),
        None => (camera.focus_offset, camera.distance, camera.azimuth),
    };
    if !focus_offset.is_finite() || !distance.is_finite() || distance <= 0.0 || !azimuth.is_finite() {
        return None;
    }
    Some(SceneCamera {
        azimuth,
        elevation: camera.elevation,
        distance,
        focus_offset,
    })
}
