use super::Instances;
use crate::model3d::{
    batching,
    scene::{self, ModelAabb, ModelEntitySpec},
};
use bevy::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// Start with the same static/material/parent/spatial exclusions as merges,
/// then split by exact geometry. Hashes alone never authorize sharing.
pub(super) fn plans(
    specs: &[ModelEntitySpec],
    opaque: &HashSet<String>,
) -> Vec<batching::BatchPlan> {
    let mut result = Vec::new();
    for plan in batching::plan(specs, opaque, &HashSet::new()) {
        let mut groups: HashMap<String, Vec<Vec<usize>>> = HashMap::new();
        for index in plan.parts {
            let geometry = specs[index].geometry.as_ref().unwrap();
            let bucket = groups
                .entry(crate::model3d::mesh::mesh_key(geometry))
                .or_default();
            if let Some(group) = bucket
                .iter_mut()
                .find(|group| specs[group[0]].geometry.as_ref() == Some(geometry))
            {
                group.push(index);
            } else {
                bucket.push(vec![index]);
            }
        }
        let mut groups: Vec<_> = groups
            .into_values()
            .flatten()
            .filter(|g| g.len() >= 4)
            .collect();
        groups.sort_by_key(|g| g[0]);
        for parts in groups {
            result.push(batching::BatchPlan {
                parent: plan.parent.clone(),
                material: plan.material.clone(),
                parts,
            });
        }
    }
    result
}

pub(super) fn build(
    plan: &batching::BatchPlan,
    specs: &[ModelEntitySpec],
) -> Option<(Instances, ModelAabb)> {
    let mut bytes = Vec::with_capacity(plan.parts.len() * super::INSTANCE_STRIDE);
    let mut ids = Vec::with_capacity(plan.parts.len());
    let mut bounds: Option<ModelAabb> = None;
    for &index in &plan.parts {
        let spec = &specs[index];
        let scale = Vec3::from_array(spec.scale);
        let rotation = scene::quat_from_xyz_radians(spec.rotation_radians);
        let transform = Transform {
            translation: Vec3::from_array(spec.position),
            rotation,
            scale,
        };
        let rows = Mat4::from_scale_rotation_translation(scale, rotation, transform.translation)
            .transpose()
            .to_cols_array_2d();
        let normal = (Mat3::from_quat(rotation) * Mat3::from_diagonal(scale.recip()))
            .transpose()
            .to_cols_array_2d();
        let values = rows[..3]
            .iter()
            .copied()
            .chain(normal.map(|n| [n[0], n[1], n[2], 0.]));
        for value in values.flatten() {
            if !value.is_finite() {
                return None;
            }
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let (half, center) = scene::geometry_half_extents_and_center(spec.geometry.as_ref()?);
        let local = ModelAabb::new(
            std::array::from_fn(|i| center[i] - half[i]),
            std::array::from_fn(|i| center[i] + half[i]),
        )
        .transformed(&transform);
        if !local.is_finite() {
            return None;
        }
        bounds = Some(bounds.map_or(local, |previous| previous.union(local)));
        ids.push(spec.id.clone());
    }
    Some((
        Instances {
            bytes: Arc::from(bytes),
            parts: Arc::from(ids),
        },
        bounds?,
    ))
}
