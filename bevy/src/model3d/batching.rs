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

/// 单批次部件上限（与 `runtime::quality` 的每帧准备预算一致）。
///
/// 总览片场同材质部件排到上千个；每 64 个切成一个批次会让 draw call 被批次粒度而不是
/// 材质数量决定。这里放大到 256：单次构建仍只有一个批次，顶点由 `VERTEX_BUDGET` 兜底。
const MAX_PARTS: usize = 256;
/// 单批次顶点预算（`build` 的硬上限是 65 536，这里留出余量）。
const VERTEX_BUDGET: usize = 60_000;
/// 低于该部件数的分组不值得单独建批次。
const MIN_PARTS: usize = 4;
const MAX_VERTICES: usize = 65_536;
const CELL_SIZE: f32 = 32.0;

/// 合批计划：`plans` 是实际批次，`flatten` 是需要改写为根空间变换的部件。
pub(super) struct Planned {
    pub plans: Vec<BatchPlan>,
    pub flatten: Vec<FlattenedPart>,
}

/// 平铺到根空间的部件：调用方按 `index` 改写 `ModelEntitySpec`。
#[derive(Debug, Clone, Copy)]
pub(super) struct FlattenedPart {
    pub index: usize,
    pub position: [f32; 3],
}

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
///
/// `merge_cells` 让同一 `(parent, material)` 的部件跨空间网格合并：总览档下整根本来就落在
/// 少量像素里，按 32 单位网格切片只会把同一材质拆成几十个 draw call，却没有可用的局部剔除
/// 收益（2026-10-28 总览 draw call 优化）。普通模型卡片保持按网格切片。
pub(super) fn plan(
    specs: &[ModelEntitySpec],
    opaque: &HashSet<String>,
    independent: &HashSet<String>,
    merge_cells: bool,
) -> Planned {
    let parents: HashSet<&str> = specs.iter().filter_map(|s| s.parent.as_deref()).collect();
    let index: HashMap<&str, usize> = specs
        .iter()
        .enumerate()
        .map(|(index, spec)| (spec.id.as_str(), index))
        .collect();
    let mut buckets: BTreeMap<(Option<String>, String, [i32; 3]), Vec<usize>> = BTreeMap::new();
    let mut flatten = Vec::new();
    for (index_in_specs, spec) in specs.iter().enumerate() {
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
        // 自定义 Mesh 的简化结果异步到达：普通卡片要等完成结果才可合批；声明总览 LOD 的
        // 片场其 Mesh 恒为原始几何（`mesh::effective_quality` = High），可以同步合批。
        // 带顶点色或没有 UV 的 Mesh 不参与：批次只烘焙位置/法线/UV，且构建要求 UV。
        match &spec.geometry {
            Some(ModelGeometry::Mesh {
                colors: Some(_), ..
            }) => continue,
            Some(ModelGeometry::Mesh { uvs: None, .. }) => continue,
            Some(ModelGeometry::Mesh { .. }) if !merge_cells => continue,
            _ => {}
        }
        // 总览片场：父级只做平移时把叶子部件平铺到根空间，按材质合并——父级分组会把同一
        // 材质拆成几十个批次，而总览下整根本来只有几十像素，分组没有剔除收益
        // （2026-10-28 draw call 优化）。父级带旋转/缩放或子树有动画时仍按原父级分组。
        let flattened = merge_cells
            .then(|| static_offset(specs, &index, spec))
            .flatten();
        if let Some(offset) = flattened {
            flatten.push(FlattenedPart {
                index: index_in_specs,
                position: [
                    offset.x + spec.position[0],
                    offset.y + spec.position[1],
                    offset.z + spec.position[2],
                ],
            });
        }
        let (parent, cell) = match flattened {
            Some(_) => (None, [0; 3]),
            None if merge_cells => (spec.parent.clone(), [0; 3]),
            None => (
                spec.parent.clone(),
                spec.position.map(|v| (v / CELL_SIZE).floor() as i32),
            ),
        };
        buckets
            .entry((parent, spec.material_key.clone(), cell))
            .or_default()
            .push(index_in_specs);
    }
    let mut plans = Vec::new();
    for ((parent, material, _), parts) in buckets {
        let mut chunk: Vec<usize> = Vec::new();
        let mut vertices = 0usize;
        for index_in_specs in parts {
            let estimate = specs[index_in_specs]
                .geometry
                .as_ref()
                .map_or(0, estimated_vertices);
            if !chunk.is_empty() && (chunk.len() >= MAX_PARTS || vertices + estimate > VERTEX_BUDGET)
            {
                if chunk.len() >= MIN_PARTS {
                    plans.push(BatchPlan {
                        parent: parent.clone(),
                        material: material.clone(),
                        parts: std::mem::take(&mut chunk),
                    });
                } else {
                    chunk.clear();
                }
                vertices = 0;
            }
            chunk.push(index_in_specs);
            vertices += estimate;
        }
        if chunk.len() >= MIN_PARTS {
            plans.push(BatchPlan {
                parent,
                material,
                parts: chunk,
            });
        }
    }
    Planned { plans, flatten }
}

/// 叶子部件到根空间的平移偏移：只有**全部祖先都只做平移**时才成立。
///
/// 旋转/缩放会改变子级的方向与尺度，没有无损的欧拉角回写路径，因此这类部件保持原分组；
/// 祖先带动画时位移随时间变化，不能烘焙进静态批次。
fn static_offset(
    specs: &[ModelEntitySpec],
    index: &HashMap<&str, usize>,
    spec: &ModelEntitySpec,
) -> Option<Vec3> {
    let mut offset = Vec3::ZERO;
    let mut current = spec.parent.as_deref();
    let mut steps = 0;
    while let Some(parent_id) = current {
        let parent = specs.get(*index.get(parent_id)?)?;
        if parent.animation.is_some()
            || !parent.rotation_radians.iter().all(|v| v.abs() < 1e-6)
            || !parent.scale.iter().all(|v| (v - 1.0).abs() < 1e-6)
            || !parent.position.iter().all(|v| v.is_finite())
        {
            return None;
        }
        offset += Vec3::from_array(parent.position);
        current = parent.parent.as_deref();
        steps += 1;
        if steps > 64 {
            return None;
        }
    }
    Some(offset)
}

/// 把平铺部件改写为根空间变换；未被合批时也按同一位置单绘，画面不变。
pub(super) fn apply_flatten(specs: &mut [ModelEntitySpec], flatten: &[FlattenedPart]) {
    for part in flatten {
        if let Some(spec) = specs.get_mut(part.index) {
            spec.position = part.position;
            spec.parent = None;
        }
    }
}

/// 单部件顶点数上界（按最高档细分估算）：偏大只会让批次更小，不会让 `build` 因顶点超限
/// 整批失败而退化成逐个绘制。
fn estimated_vertices(geometry: &ModelGeometry) -> usize {
    let (longitudes, stacks, latitudes) = Quality::High.subdivisions();
    match geometry {
        ModelGeometry::Box { .. } => 24,
        ModelGeometry::Cylinder { .. } => (longitudes as usize + 1) * 2,
        ModelGeometry::Sphere { .. } => (longitudes as usize + 1) * (stacks as usize + 1),
        ModelGeometry::Capsule { .. } => (longitudes as usize + 1) * (latitudes as usize + 2),
        ModelGeometry::Mesh { vertices, .. } => vertices.len(),
    }
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
mod tests;
