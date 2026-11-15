//! 实体/几何/动画 DTO 与 transform、segment 数学
//! （change: refactor-bevy-rust-file-size，任务 2.2 / design D2）。

use bevy::prelude::*;

use crate::protocol::ModelOp;

/// 运行时 primitive 质量档：脚本不能声明细分，由这里固定，便于预算与缓存。
pub const SPHERE_SECTORS: u32 = 24;
pub const SPHERE_STACKS: u32 = 12;
pub const CAPSULE_LONGITUDES: u32 = 24;
pub const CAPSULE_LATITUDES: u32 = 6;

/// 一个待构建的实体指令（与 ECS 解耦，便于单测与原生/原生复用）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelEntitySpec {
    pub(crate) id: String,
    pub(crate) parent: Option<String>,
    /// 相对 parent 的局部位移（已含 placement 的模型根缩放单位前的原始单位）。
    pub(crate) position: [f32; 3],
    /// 与 Bevy `EulerRot::YXZ` 一致的局部旋转（弧度）。
    pub(crate) rotation_radians: [f32; 3],
    pub(crate) scale: [f32; 3],
    pub(crate) geometry: Option<ModelGeometry>,
    /// material key（`color:#rrggbb` 或 `material:<id>`），供缓存复用。
    pub(crate) material_key: String,
    pub(crate) animation: Option<ModelAnimationSpec>,
    /// 独立静态姿势增量（change: 2026-11-15-add-model-script-static-poses）。
    pub(crate) pose: Option<ModelPoseSpec>,
}

/// 静态姿势通道增量：rotation 为绑定后的局部旋转增量（弧度），position 为父空间平移偏移。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ModelPoseSpec {
    pub(crate) rotation_radians: Option<[f32; 3]>,
    pub(crate) position: Option<[f32; 3]>,
}

impl ModelEntitySpec {
    /// 纯绑定/结构变换（不含静态姿势与动画）。
    pub(crate) fn bind_transform(&self) -> Transform {
        Transform {
            translation: Vec3::from_array(self.position),
            rotation: quat_from_xyz_radians(self.rotation_radians),
            scale: Vec3::from_array(self.scale),
        }
    }

    /// 绑定 × 静态姿势：无动画时的有效局部变换（层级由 ECS parent 组合）。
    pub(crate) fn static_transform(&self) -> Transform {
        self.effective_transform(None, None, None)
    }

    /// 按通道覆盖求有效局部变换。
    ///
    /// `rotation`/`position` 为动画实际接管的通道（显式 `Some`，零值同样接管）；缺失时回落到
    /// 静态姿势通道，再回落到绑定值。`scale` 只有乘法增量，不属于静态姿势。
    pub(crate) fn effective_transform(
        &self,
        rotation: Option<Quat>,
        position: Option<Vec3>,
        scale: Option<Vec3>,
    ) -> Transform {
        let bind_translation = Vec3::from_array(self.position);
        let bind_rotation = quat_from_xyz_radians(self.rotation_radians);
        let pose = self.pose;
        let translation = bind_translation
            + position
                .or_else(|| pose.and_then(|pose| pose.position.map(Vec3::from_array)))
                .unwrap_or(Vec3::ZERO);
        let rotation_delta = rotation.or_else(|| {
            pose.and_then(|pose| pose.rotation_radians)
                .map(quat_from_xyz_radians)
        });
        let rotation = rotation_delta.map_or(bind_rotation, |delta| bind_rotation * delta);
        Transform {
            translation,
            rotation,
            scale: Vec3::from_array(self.scale) * scale.unwrap_or(Vec3::ONE),
        }
    }
}

/// 与 ECS 无关的几何描述。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ModelGeometry {
    /// 盒：单位立方体 + scale（Bevy Cuboid 尺寸在构建时乘以单位）。
    Box {
        size: [f32; 3],
    },
    Cylinder {
        radius: f32,
        height: f32,
    },
    Sphere {
        radius: f32,
    },
    Capsule {
        radius: f32,
        height: f32,
    },
    Mesh {
        vertices: Vec<[f32; 3]>,
        faces: Vec<[u32; 3]>,
        /// 可选顶点属性（GLB 文件模型）；缺失时运行时计算平滑法线。
        normals: Option<Vec<[f32; 3]>>,
        uvs: Option<Vec<[f32; 2]>>,
        colors: Option<Vec<[f32; 4]>>,
    },
}

/// 与 ECS 无关的动画描述。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ModelAnimationSpec {
    Rotate {
        axis: usize,
        speed: f32,
    },
    Move {
        axis: usize,
        speed: f32,
        range: [f32; 2],
    },
    Oscillate {
        axis: usize,
        speed: f32,
        mode: String,
        amplitude: f32,
        phase: f32,
    },
}

pub(super) fn animation_spec(op: &ModelOp) -> Option<(String, ModelAnimationSpec)> {
    match op {
        ModelOp::Rotate { id, axis, speed } => Some((
            id.clone(),
            ModelAnimationSpec::Rotate {
                axis: animation_axis(axis),
                speed: *speed,
            },
        )),
        ModelOp::Move {
            id,
            axis,
            speed,
            range,
        } => Some((
            id.clone(),
            ModelAnimationSpec::Move {
                axis: animation_axis(axis),
                speed: *speed,
                range: *range,
            },
        )),
        ModelOp::Oscillate {
            id,
            axis,
            speed,
            mode,
            amplitude,
            phase,
        } => Some((
            id.clone(),
            ModelAnimationSpec::Oscillate {
                axis: animation_axis(axis),
                speed: *speed,
                mode: mode.clone(),
                amplitude: *amplitude,
                phase: *phase,
            },
        )),
        _ => None,
    }
}

/// 轴名 → 索引（`x` / `z`，其余归 `y`）。
pub(crate) fn animation_axis(axis: &str) -> usize {
    match axis {
        "x" => 0,
        "z" => 2,
        _ => 1,
    }
}

/// 度数 `[x,y,z]` → intrinsic Y-X-Z 四元数，等价于 `Ry(y) * Rx(x) * Rz(z)`。
///
/// glam 的 `from_euler(EulerRot::YXZ, i, j, k)` 参数按轴序（i=Y、j=X、k=Z）而不是字面
/// `x,y,z`，因此这里显式把 `[x,y,z]` 重排为 `(y, x, z)`。与 contracts
/// `quatFromEulerYXZDegrees` 逐位对齐（design D2）。
#[cfg(test)]
pub(crate) fn quat_from_euler_yxz_degrees(rotation: [f32; 3]) -> Quat {
    quat_from_xyz_radians([
        rotation[0].to_radians(),
        rotation[1].to_radians(),
        rotation[2].to_radians(),
    ])
}

/// `[x,y,z]` 弧度 → intrinsic Y-X-Z 四元数（glam 参数序重排）。
pub(crate) fn quat_from_xyz_radians(xyz: [f32; 3]) -> Quat {
    Quat::from_euler(EulerRot::YXZ, xyz[1], xyz[0], xyz[2])
}

/// 四元数 → `[x,y,z]` 弧度（intrinsic Y-X-Z 解算，glam 输出序重排）。
pub(crate) fn xyz_radians_from_quat(quaternion: Quat) -> [f32; 3] {
    let (y, x, z) = quaternion.to_euler(EulerRot::YXZ);
    [x, y, z]
}

/// 局部 transform（rotation 为四元数），用于层级组合测试。
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) struct LocalTransform {
    pub(crate) translation: Vec3,
    pub(crate) rotation: Quat,
    pub(crate) scale: Vec3,
}

#[cfg(test)]
impl LocalTransform {
    pub(crate) fn of(position: [f32; 3], rotation: [f32; 3], scale: [f32; 3]) -> Self {
        Self {
            translation: Vec3::from_array(position),
            rotation: quat_from_euler_yxz_degrees(rotation),
            scale: Vec3::from_array(scale),
        }
    }

    /// 组合父/子：与 Bevy `Transform::mul_transform` 完全一致。
    pub(crate) fn mul(self, child: LocalTransform) -> LocalTransform {
        LocalTransform {
            translation: self.transform_point(child.translation),
            rotation: self.rotation * child.rotation,
            scale: self.scale * child.scale,
        }
    }

    /// 把点从局部空间变换到父空间。
    pub(crate) fn transform_point(self, mut point: Vec3) -> Vec3 {
        point = self.scale * point;
        point = self.rotation * point;
        point + self.translation
    }
}

/// `segment` 的确定性中心/长度/朝向：从 `to - from` 计算，不依赖手写欧拉角。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SegmentGeometry {
    pub(crate) center: [f32; 3],
    pub(crate) rotation: Quat,
    pub(crate) length: f32,
    pub(crate) width: f32,
    pub(crate) depth: f32,
    pub(crate) overlap: f32,
    pub(crate) capsule: bool,
}

/// 方向 canonical 化 + 稳定朝向：`from→to` 与 `to→from` 得到同一四元数。
pub(crate) fn segment_geometry(
    from: [f32; 3],
    to: [f32; 3],
    width: f32,
    depth: f32,
    overlap: f32,
    capsule: bool,
) -> Option<SegmentGeometry> {
    let a = Vec3::from_array(from);
    let b = Vec3::from_array(to);
    let delta = b - a;
    let length = delta.length();
    if !(length.is_finite() && length > 1e-4) {
        return None;
    }
    let center = (a + b) * 0.5;
    // canonical 半空间：y<0 或 (y==0 且 x/z 字典序为负) 时取反，交换端点不改变结果。
    let mut direction = delta / length;
    if direction.y < 0.0
        || (direction.y == 0.0 && (direction.x < 0.0 || (direction.x == 0.0 && direction.z < 0.0)))
    {
        direction = -direction;
    }
    let rotation = align_y_to(direction);
    Some(SegmentGeometry {
        center: center.to_array(),
        rotation,
        length,
        width,
        depth,
        overlap,
        capsule,
    })
}

/// 稳定地把局部 `+Y` 对齐到方向；接近 ±Y 时使用固定备用轴。
pub(crate) fn align_y_to(direction: Vec3) -> Quat {
    let d = direction.normalize_or_zero();
    if d == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    let dot = d.y;
    if dot < -1.0 + 1e-6 {
        return Quat::from_rotation_x(std::f32::consts::PI);
    }
    if dot > 1.0 - 1e-6 {
        return Quat::IDENTITY;
    }
    let axis = Vec3::Y.cross(d).normalize_or_zero();
    Quat::from_axis_angle(axis, dot.clamp(-1.0, 1.0).acos())
}
