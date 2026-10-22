//! 模型局部/世界包围盒计算与可复用 AABB 操作
//! （change: refactor-bevy-rust-file-size，任务 2.2 / design D2；
//!  change: refactor-bevy-reusable-components，任务 1.1 / design D3）。
//!
//! 本模块只依赖 Bevy math 与 `crate::protocol` 的 Scene IR DTO；不依赖 ECS runtime、
//! bridge、window 或 renderer 资源。`ModelAabb` 同时作为 orbit/shot adapter 共用的纯
//! bounds 边界，避免重复遍历 mesh 顶点。

use bevy::prelude::*;

use crate::protocol::ModelSnapshot;

use super::types::ModelGeometry;

/// 模型在**局部规范空间**（未应用 placement/unit/view_rotation）的包围盒。
///
/// 提供有限值验证、union、center、half extents、radius 与 transform 后包围盒等纯操作，
/// 供 orbit/shot adapter 与布局共用。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ModelAabb {
    pub(crate) min: [f32; 3],
    pub(crate) max: [f32; 3],
}

impl ModelAabb {
    pub(crate) const fn new(min: [f32; 3], max: [f32; 3]) -> Self {
        Self { min, max }
    }

    /// 六个分量是否全部有限。
    pub(crate) fn is_finite(&self) -> bool {
        self.min.into_iter().chain(self.max).all(f32::is_finite)
    }

    /// 合并两个包围盒（分量 min/max）。
    pub(crate) fn union(self, other: ModelAabb) -> ModelAabb {
        let mut min = self.min;
        let mut max = self.max;
        for axis in 0..3 {
            min[axis] = min[axis].min(other.min[axis]);
            max[axis] = max[axis].max(other.max[axis]);
        }
        ModelAabb { min, max }
    }

    /// 中心点。
    pub(crate) fn center(&self) -> Vec3 {
        (Vec3::from_array(self.min) + Vec3::from_array(self.max)) * 0.5
    }

    /// 各轴半边长（非负）。
    #[allow(dead_code)]
    pub(crate) fn half_extents(&self) -> Vec3 {
        ((Vec3::from_array(self.max) - Vec3::from_array(self.min)) * 0.5).max(Vec3::ZERO)
    }

    /// 包围球半径（对角半长）。
    pub(crate) fn radius(&self) -> f32 {
        (Vec3::from_array(self.max) - Vec3::from_array(self.min)).length() * 0.5
    }

    /// 对自身应用变换后的重新包围盒（8 角取 min/max）。
    pub(crate) fn transformed(&self, transform: &Transform) -> ModelAabb {
        transform_aabb(transform, self)
    }
}

/// 求模型局部空间包围盒（含层级、scale、sphere/capsule/segment 半径与 overlap）。
///
/// 语义与 `web/contracts` 的 `v2SceneAabb` 一致：先组合祖先变换得到世界局部变换，再对
/// 每个 primitive 的自包围盒做变换后合并。用于把模型整体摆放在节点卡片下方，保证卡片
/// 不遮挡模型（change: 卡片与模型不重叠）。
pub(crate) fn model_local_aabb(model: &ModelSnapshot) -> Option<ModelAabb> {
    super::PreparedBounds::for_model(model).local
}

/// 模型经 `view_rotation` + `unit` 缩放后的世界包围盒（相对模型根锚点）。
///
/// 与 adapter 的根 transform 组合语义一致：`world = root(view_rotation, unit) ∘ local`。
pub(crate) fn model_world_aabb(
    model: &ModelSnapshot,
    view_rotation: Quat,
    unit: f32,
) -> Option<ModelAabb> {
    let local = model_local_aabb(model)?;
    if !(unit.is_finite() && unit > 0.0) {
        return Some(local);
    }
    let root = Transform {
        translation: Vec3::ZERO,
        rotation: view_rotation,
        scale: Vec3::splat(unit),
    };
    Some(local.transformed(&root))
}

/// 求组合模型中每个子树根的**模型局部空间** AABB（含根自身 transform，不含模型根
/// view_rotation/unit/anchor）。供片场对象 picking：组合 IR 中每个对象是一个 group 根。
///
/// 返回 `(rootId, localAabb)`；根没有几何后代时跳过。
pub(crate) fn model_subtree_aabb_by_root(
    model: &ModelSnapshot,
    root_ids: &[String],
) -> Vec<(String, ModelAabb)> {
    super::prepared_bounds::placed_subtree_aabbs(model, root_ids, None)
}

/// primitive 在**自身几何空间**的半边长与中心。
pub(crate) fn geometry_half_extents_and_center(geometry: &ModelGeometry) -> ([f32; 3], [f32; 3]) {
    match geometry {
        ModelGeometry::Box { size } => (
            [
                size[0].abs() * 0.5,
                size[1].abs() * 0.5,
                size[2].abs() * 0.5,
            ],
            [0.0, 0.0, 0.0],
        ),
        ModelGeometry::Cylinder { radius, height } => (
            [radius.abs(), height.abs() * 0.5, radius.abs()],
            [0.0, 0.0, 0.0],
        ),
        ModelGeometry::Sphere { radius } => ([radius.abs(); 3], [0.0, 0.0, 0.0]),
        ModelGeometry::Capsule { radius, height } => (
            [radius.abs(), height.abs() * 0.5, radius.abs()],
            [0.0, 0.0, 0.0],
        ),
        ModelGeometry::Mesh { vertices, .. } => {
            if vertices.is_empty() {
                return ([0.0; 3], [0.0; 3]);
            }
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            for vertex in vertices {
                for axis in 0..3 {
                    min[axis] = min[axis].min(vertex[axis]);
                    max[axis] = max[axis].max(vertex[axis]);
                }
            }
            (
                [
                    (max[0] - min[0]) * 0.5,
                    (max[1] - min[1]) * 0.5,
                    (max[2] - min[2]) * 0.5,
                ],
                [
                    (max[0] + min[0]) * 0.5,
                    (max[1] + min[1]) * 0.5,
                    (max[2] + min[2]) * 0.5,
                ],
            )
        }
    }
}

/// 用变换矩阵把局部 AABB 变换后重新包围（8 角取 min/max）。
fn transform_aabb(transform: &Transform, aabb: &ModelAabb) -> ModelAabb {
    let matrix = transform.compute_affine();
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for xi in 0..2 {
        for yi in 0..2 {
            for zi in 0..2 {
                let corner = Vec3::new(
                    if xi == 0 { aabb.min[0] } else { aabb.max[0] },
                    if yi == 0 { aabb.min[1] } else { aabb.max[1] },
                    if zi == 0 { aabb.min[2] } else { aabb.max[2] },
                );
                let world = matrix.transform_point3(corner);
                min[0] = min[0].min(world.x);
                min[1] = min[1].min(world.y);
                min[2] = min[2].min(world.z);
                max[0] = max[0].max(world.x);
                max[1] = max[1].max(world.y);
                max[2] = max[2].max(world.z);
            }
        }
    }
    ModelAabb { min, max }
}
