//! Runtime-only static sibling batches. Canonical specs and script remain untouched.
use std::collections::{BTreeMap, HashMap, HashSet};

use bevy::{
    asset::RenderAssetUsages,
    mesh::VertexAttributeValues,
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
};

use super::{
    quality::Quality,
    scene::{ModelEntitySpec, ModelGeometry},
};

const MAX_PARTS: usize = 64;
const MAX_VERTICES: usize = 65_536;
const CELL_SIZE: f32 = 32.0;

#[derive(Debug)]
pub(super) struct BatchPlan {
    pub parent: Option<String>,
    pub material: String,
    pub parts: Vec<usize>,
}

#[derive(Debug, Clone)]
pub(super) struct PartRange {
    pub id: String,
    pub vertices: std::ops::Range<u32>,
    pub indices: std::ops::Range<u32>,
}

#[derive(Clone)]
pub(super) struct BuiltBatch {
    pub source_mesh_builds: usize,
    pub source_buffer_bytes: usize,
    pub mesh: Mesh,
    pub ranges: Vec<PartRange>,
    pub min: Vec3,
    pub max: Vec3,
}

/// Keep animated nodes, parent scopes, transparent materials and reflected transforms separate.
/// Animated groups can still move a whole sibling batch without changing its local geometry.
pub(super) fn plan(
    specs: &[ModelEntitySpec],
    opaque: &HashSet<String>,
    independent: &HashSet<String>,
) -> Vec<BatchPlan> {
    let parents: HashSet<&str> = specs.iter().filter_map(|s| s.parent.as_deref()).collect();
    let mut buckets: BTreeMap<(Option<String>, String, [i32; 3]), Vec<usize>> = BTreeMap::new();
    for (index, spec) in specs.iter().enumerate() {
        if spec.geometry.is_none()
            || spec.animation.is_some()
            || independent.contains(&spec.id)
            || parents.contains(spec.id.as_str())
            || !opaque.contains(&spec.material_key)
            || !spec
                .position
                .iter()
                .chain(spec.rotation_radians.iter())
                .all(|v| v.is_finite())
            || !spec.scale.iter().all(|v| v.is_finite() && *v > 0.0)
        {
            continue;
        }
        // Custom reduction is asynchronous; leave these independently shared until a
        // completed quality-specific result is available for batching.
        if matches!(spec.geometry, Some(ModelGeometry::Mesh { .. })) {
            continue;
        }
        let cell = spec.position.map(|v| (v / CELL_SIZE).floor() as i32);
        buckets
            .entry((spec.parent.clone(), spec.material_key.clone(), cell))
            .or_default()
            .push(index);
    }
    let mut result = Vec::new();
    for ((parent, material, _), parts) in buckets {
        for chunk in parts.chunks(MAX_PARTS) {
            if chunk.len() >= 4 {
                result.push(BatchPlan {
                    parent: parent.clone(),
                    material: material.clone(),
                    parts: chunk.to_vec(),
                });
            }
        }
    }
    result
}

/// Bake sibling local transforms while preserving original UVs and shading normals.
/// Bounds cover transformed vertices, rather than only cell centers.
pub(super) fn build(
    plan: &BatchPlan,
    specs: &[ModelEntitySpec],
    quality: Quality,
) -> Option<BuiltBatch> {
    let mut source_meshes: HashMap<String, Vec<(&ModelGeometry, Mesh)>> = HashMap::new();
    let mut source_mesh_builds = 0;
    let mut positions = Vec::<[f32; 3]>::new();
    let mut normals = Vec::<[f32; 3]>::new();
    let mut uvs = Vec::<[f32; 2]>::new();
    let mut indices = Vec::<u32>::new();
    let mut ranges = Vec::new();
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for &index in &plan.parts {
        let spec = specs.get(index)?;
        let geometry = spec.geometry.as_ref()?;
        let bucket = source_meshes
            .entry(super::mesh::mesh_key(geometry))
            .or_default();
        let found = bucket.iter().position(|(source, _)| *source == geometry);
        let index = if let Some(index) = found {
            index
        } else {
            let mesh = super::mesh::build_mesh_quality(geometry, quality)?;
            bucket.push((geometry, mesh));
            source_mesh_builds += 1;
            bucket.len() - 1
        };
        let mesh = &bucket[index].1;
        let VertexAttributeValues::Float32x3(source_positions) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)?
        else {
            return None;
        };
        let VertexAttributeValues::Float32x3(source_normals) =
            mesh.attribute(Mesh::ATTRIBUTE_NORMAL)?
        else {
            return None;
        };
        let VertexAttributeValues::Float32x2(source_uvs) = mesh.attribute(Mesh::ATTRIBUTE_UV_0)?
        else {
            return None;
        };
        if positions.len() + source_positions.len() > MAX_VERTICES
            || source_normals.len() != source_positions.len()
            || source_uvs.len() != source_positions.len()
        {
            return None;
        }
        let start_vertex = positions.len() as u32;
        let start_index = indices.len() as u32;
        let rotation = super::scene::quat_from_xyz_radians(spec.rotation_radians);
        let scale = Vec3::from_array(spec.scale);
        let translation = Vec3::from_array(spec.position);
        for (&position, &normal) in source_positions.iter().zip(source_normals) {
            let position = rotation * (Vec3::from_array(position) * scale) + translation;
            let normal = (rotation * (Vec3::from_array(normal) / scale)).normalize_or_zero();
            if !position.is_finite() || !normal.is_finite() {
                return None;
            }
            min = min.min(position);
            max = max.max(position);
            positions.push(position.to_array());
            normals.push(normal.to_array());
        }
        uvs.extend_from_slice(source_uvs);
        indices.extend(mesh.indices()?.iter().map(|i| i as u32 + start_vertex));
        ranges.push(PartRange {
            id: spec.id.clone(),
            vertices: start_vertex..positions.len() as u32,
            indices: start_index..indices.len() as u32,
        });
    }
    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, normals);
    mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, uvs);
    mesh.insert_indices(Indices::U32(indices));
    let source_buffer_bytes = source_meshes
        .values()
        .flatten()
        .map(|(_, mesh)| {
            mesh.get_vertex_buffer_size() + mesh.indices().map_or(0, |indices| indices.len() * 4)
        })
        .sum();
    Some(BuiltBatch {
        source_mesh_builds,
        source_buffer_bytes,
        mesh,
        ranges,
        min,
        max,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn specs() -> Vec<ModelEntitySpec> {
        (0..8)
            .map(|i| ModelEntitySpec {
                id: format!("part-{i}"),
                parent: Some("group".into()),
                position: [i as f32, 0., 0.],
                rotation_radians: [0.; 3],
                scale: [2., 1., 0.5],
                geometry: Some(ModelGeometry::Box { size: [1.; 3] }),
                material_key: "opaque".into(),
                animation: None,
            })
            .collect()
    }
    #[test]
    fn preserves_identity_ranges_bounds_and_source() {
        let specs = specs();
        let original = specs.clone();
        let plans = plan(&specs, &HashSet::from(["opaque".into()]), &HashSet::new());
        assert_eq!(plans.len(), 1);
        let batch = build(&plans[0], &specs, Quality::High).unwrap();
        assert_eq!(batch.ranges.len(), 8);
        assert_eq!(batch.source_mesh_builds, 1);
        let buffer_bytes =
            batch.mesh.get_vertex_buffer_size() + batch.mesh.indices().unwrap().len() * 4;
        assert_eq!(buffer_bytes, batch.source_buffer_bytes * 8);
        assert_eq!(batch.min, Vec3::new(-1., -0.5, -0.25));
        assert_eq!(batch.max, Vec3::new(8., 0.5, 0.25));
        for (i, range) in batch.ranges.iter().enumerate() {
            assert_eq!(range.id, format!("part-{i}"));
            assert_eq!(range.vertices.end - range.vertices.start, 24);
            assert_eq!(range.indices.end - range.indices.start, 36);
        }
        assert_eq!(batch.mesh.indices().unwrap().len(), 8 * 36);
        assert_eq!(specs, original);
    }
    #[test]
    fn independent_transparent_reflected_and_other_scopes_do_not_merge() {
        let mut specs = specs();
        specs[0].scale[0] = -1.;
        specs[1].material_key = "transparent".into();
        specs[2].parent = Some("other".into());
        let plans = plan(
            &specs,
            &HashSet::from(["opaque".into()]),
            &HashSet::from(["part-3".into()]),
        );
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].parts, vec![4, 5, 6, 7]);
    }
}
