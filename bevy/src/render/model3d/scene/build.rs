//! V2 实体指令构建
//! （change: refactor-bevy-rust-file-size，任务 2.2 / design D2；
//!  change: 2026-10-07-remove-residual-compatibility —— 删除 V1 平铺构建路径；
//!  change: 2026-11-15-add-model-script-static-poses —— group.pose 作为独立增量）。

use crate::protocol::{ModelOp, ModelPose, ModelSnapshot};

use super::materials::material_key;
use super::types::{
    ModelAnimationSpec, ModelEntitySpec, ModelGeometry, ModelPoseSpec, animation_spec,
    segment_geometry, xyz_radians_from_quat,
};

/// 展开一个 `ModelSnapshot` 为构建指令列表。
///
/// V2 建立真实 parent→child 关系；`position/rotation/scale` 为**绑定**局部值，静态姿势在
/// `pose` 中独立保存。`placement`/`unit` 由 adapter 在模型根上应用，不进入这里。
pub(crate) fn build_entity_specs(model: &ModelSnapshot) -> Vec<ModelEntitySpec> {
    let mut specs = Vec::new();
    for op in &model.ops {
        match op {
            ModelOp::Material { .. } => continue,
            ModelOp::Group {
                id,
                parent,
                position,
                rotation,
                scale,
                pose,
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                None,
                op,
                None,
                pose.as_ref().map(pose_spec),
            )),
            ModelOp::Box {
                id,
                parent,
                position,
                rotation,
                scale,
                size,
                ..
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                Some(ModelGeometry::Box { size: *size }),
                op,
                None,
                None,
            )),
            ModelOp::Cylinder {
                id,
                parent,
                position,
                rotation,
                scale,
                radius,
                height,
                ..
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                Some(ModelGeometry::Cylinder {
                    radius: *radius,
                    height: *height,
                }),
                op,
                None,
                None,
            )),
            ModelOp::Sphere {
                id,
                parent,
                position,
                rotation,
                scale,
                radius,
                ..
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                Some(ModelGeometry::Sphere { radius: *radius }),
                op,
                None,
                None,
            )),
            ModelOp::Capsule {
                id,
                parent,
                position,
                rotation,
                scale,
                radius,
                height,
                ..
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                Some(ModelGeometry::Capsule {
                    radius: *radius,
                    height: *height,
                }),
                op,
                None,
                None,
            )),
            ModelOp::Mesh {
                id,
                parent,
                position,
                rotation,
                scale,
                vertices,
                faces,
                normals,
                uvs,
                colors,
                ..
            } => specs.push(spec(
                id,
                parent.clone(),
                position,
                rotation,
                scale,
                Some(ModelGeometry::Mesh {
                    vertices: vertices.clone(),
                    faces: faces.clone(),
                    normals: normals.clone(),
                    uvs: uvs.clone(),
                    colors: colors.clone(),
                }),
                op,
                None,
                None,
            )),
            ModelOp::Segment {
                id,
                parent,
                position,
                rotation,
                scale,
                from,
                to,
                width,
                depth,
                shape,
                overlap,
                ..
            } => {
                let depth = depth.unwrap_or(*width);
                let capsule = shape == "capsule";
                // segment 的 from/to 在 parent 局部空间；实体自身保留父级 transform，
                // 几何由 center/rotation/length 表达（相对同一 parent）。
                let geometry =
                    segment_geometry(*from, *to, *width, depth, *overlap, capsule).map(|segment| {
                        if capsule {
                            ModelGeometry::Capsule {
                                radius: segment.width / 2.0,
                                // 含两端半球：圆柱段长度 = length + 2*overlap - 直径，总高 = 圆柱段 + 直径。
                                height: segment.length + 2.0 * segment.overlap,
                            }
                        } else {
                            ModelGeometry::Box {
                                size: [
                                    segment.width,
                                    segment.length + 2.0 * segment.overlap,
                                    segment.depth,
                                ],
                            }
                        }
                    });
                let mut entry = spec(
                    id,
                    parent.clone(),
                    position,
                    rotation,
                    scale,
                    geometry,
                    op,
                    None,
                    None,
                );
                // segment 的中心与朝向覆盖 op 的 position/rotation（from/to 是权威表达）。
                if let Some(segment) =
                    segment_geometry(*from, *to, *width, depth, *overlap, capsule)
                {
                    entry.position = segment.center;
                    entry.rotation_radians = xyz_radians_from_quat(segment.rotation);
                }
                specs.push(entry);
            }
            _ => {}
        }
    }
    attach_animations(model, &mut specs);
    specs
}

/// `group.pose` → 运行期姿势增量（角度转弧度）。
fn pose_spec(pose: &ModelPose) -> ModelPoseSpec {
    ModelPoseSpec {
        rotation_radians: pose.rotation.map(|rotation| {
            [
                rotation[0].to_radians(),
                rotation[1].to_radians(),
                rotation[2].to_radians(),
            ]
        }),
        position: pose.position,
    }
}

/// 动画挂到目标实体（V1/V2 相同：第二遍扫描 op）。
fn attach_animations(model: &ModelSnapshot, specs: &mut [ModelEntitySpec]) {
    for op in &model.ops {
        if let Some((target, animation)) = animation_spec(op)
            && let Some(spec) = specs.iter_mut().find(|spec| spec.id == target)
        {
            spec.animation = Some(animation);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spec(
    id: &str,
    parent: Option<String>,
    position: &[f32; 3],
    rotation: &[f32; 3],
    scale: &[f32; 3],
    geometry: Option<ModelGeometry>,
    op: &ModelOp,
    animation: Option<ModelAnimationSpec>,
    pose: Option<ModelPoseSpec>,
) -> ModelEntitySpec {
    ModelEntitySpec {
        id: id.to_owned(),
        parent,
        position: *position,
        rotation_radians: [
            rotation[0].to_radians(),
            rotation[1].to_radians(),
            rotation[2].to_radians(),
        ],
        scale: *scale,
        geometry,
        material_key: material_key(op),
        animation,
        pose,
    }
}
