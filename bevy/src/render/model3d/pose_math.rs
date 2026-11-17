//! 静态姿势下蒙皮几何的 CPU LBS 派生（change: 2026-11-15-add-model-script-static-poses）。
//!
//! 与拾取/运行期蒙皮同一规则：`jointWorld × inverseBind` 后按权重求和。本模块只做纯计算，
//! 不持有 ECS/资源；prepared bounds 与原生预览取景共用，避免把绑定 AABB 当成实际形状。

use bevy::prelude::*;

use crate::protocol::ModelSkin;

/// 每个 joint 的 `jointWorld × inverseBind` 矩阵；任一 joint 缺失时返回 `None`。
pub(crate) fn joint_matrices(
    skin: &ModelSkin,
    joint_world: impl Fn(&str) -> Option<Mat4>,
) -> Option<Vec<Mat4>> {
    skin.joint_ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            let world = joint_world(id)?;
            let inverse = skin.inverse_bind_matrices.get(index)?;
            Some(world * Mat4::from_cols_array(inverse))
        })
        .collect()
}

/// 按完整 indices/weights 变形顶点，返回根局部空间 AABB。
///
/// 权重不为 1 时保留 `sum(weight * position)` 语义（与运行期 `skin::deform` 一致，不归一化）。
pub(crate) fn deformed_bounds(
    vertices: &[[f32; 3]],
    indices: &[Vec<usize>],
    weights: &[Vec<f32>],
    matrices: &[Mat4],
) -> Option<([f32; 3], [f32; 3])> {
    let referenced: Vec<usize> = (0..vertices.len()).collect();
    deformed_bounds_indices(vertices, &referenced, indices, weights, matrices)
}

/// 只统计被面引用的顶点；未使用的绑定顶点不会扩大实际形状。
pub(crate) fn deformed_bounds_indices(
    vertices: &[[f32; 3]],
    referenced: &[usize],
    indices: &[Vec<usize>],
    weights: &[Vec<f32>],
    matrices: &[Mat4],
) -> Option<([f32; 3], [f32; 3])> {
    if vertices.is_empty() || referenced.is_empty() || matrices.is_empty() {
        return None;
    }
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    let mut any = false;
    for &vertex_index in referenced {
        let Some(point) = vertices.get(vertex_index) else {
            continue;
        };
        let index = vertex_index;
        let vertex_indices = indices.get(index)?;
        let vertex_weights = weights.get(index)?;
        let mut result = Vec3::ZERO;
        for (&joint, &weight) in vertex_indices.iter().zip(vertex_weights) {
            let matrix = matrices.get(joint)?;
            result += matrix.transform_point3(Vec3::from_array(*point)) * weight;
        }
        if !result.is_finite() {
            continue;
        }
        min = min.min(result);
        max = max.max(result);
        any = true;
    }
    any.then(|| (min.to_array(), max.to_array()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> [f32; 16] {
        [
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ]
    }

    #[test]
    fn deformed_bounds_follows_joint_world_and_inverse_bind() {
        let skin = ModelSkin {
            joint_ids: vec!["root.joint".into()],
            inverse_bind_matrices: vec![identity()],
            indices: vec![vec![0], vec![0], vec![0]],
            weights: vec![vec![1.], vec![1.], vec![1.]],
        };
        let vertices = vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        let matrices = joint_matrices(&skin, |_| {
            Some(Mat4::from_translation(Vec3::new(0., 2., 0.)))
        })
        .expect("matrices");
        let (min, max) =
            deformed_bounds(&vertices, &skin.indices, &skin.weights, &matrices).expect("bounds");
        assert!((min[1] - 2.0).abs() < 1e-6);
        assert!((max[1] - 3.0).abs() < 1e-6);
    }
}
