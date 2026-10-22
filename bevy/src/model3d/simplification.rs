//! Error-controlled derived indices. Source positions, normals and high remain
//! authoritative; independent parts never merge. No permissive/prune mode.
use super::{mesh, quality::Quality, scene::ModelGeometry};
use bevy::{
    mesh::{Indices, VertexAttributeValues},
    prelude::*,
};
use std::collections::{HashMap, HashSet};

pub(super) const VERSION: u32 = 1;
pub(super) const MAX_VERTICES: usize = 16_384;
pub(super) const MAX_FACES: usize = 8_192;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Fallback {
    SizeBudget,
    Small,
    Invalid,
    Degenerate,
    NonManifold,
    Thin,
    Protected,
    ErrorLimit,
}
pub(super) struct Reduced {
    pub mesh: Mesh,
    /// meshoptimizer quadric error relative to the mesh's longest extent;
    /// this is not a certified Hausdorff distance or measured GPU time.
    pub error: f32,
}
pub(super) fn error_limit(quality: Quality) -> f32 {
    match quality.tier() {
        Quality::Low => 0.005,
        Quality::Medium => 0.002,
        Quality::High => 0.0,
        _ => unreachable!("tier returns a base quality"),
    }
}

struct Edge {
    first: usize,
    second: Option<usize>,
    forward: bool,
}

fn protected_vertices(vertices: &[[f32; 3]], faces: &[[u32; 3]]) -> Result<Vec<bool>, Fallback> {
    if vertices.is_empty()
        || faces.is_empty()
        || vertices.iter().flatten().any(|v| !v.is_finite())
        || faces
            .iter()
            .flatten()
            .any(|v| *v as usize >= vertices.len())
    {
        return Err(Fallback::Invalid);
    }
    let mut min = Vec3::splat(f32::INFINITY);
    let mut max = Vec3::splat(f32::NEG_INFINITY);
    for vertex in vertices {
        let p = Vec3::from_array(*vertex);
        min = min.min(p);
        max = max.max(p);
    }
    let extent = max - min;
    let longest = extent.max_element();
    if !longest.is_finite() || longest <= 0.0 {
        return Err(Fallback::Degenerate);
    }
    if extent.min_element() / longest < 0.005 {
        return Err(Fallback::Thin);
    }
    let mut normals = Vec::with_capacity(faces.len());
    let mut edges = HashMap::<(u32, u32), Edge>::new();
    let mut incident = vec![Vec::new(); vertices.len()];
    let mut unique = HashSet::new();
    for (index, face) in faces.iter().enumerate() {
        let mut sorted = *face;
        sorted.sort_unstable();
        if !unique.insert(sorted) {
            return Err(Fallback::NonManifold);
        }
        let [a, b, c] = face.map(|v| Vec3::from_array(vertices[v as usize]));
        let normal = (b - a).cross(c - a);
        let edge2 = (b - a)
            .length_squared()
            .max((c - a).length_squared())
            .max((c - b).length_squared());
        if !normal.is_finite() || normal.length() <= edge2 * 0.00001 {
            return Err(Fallback::Degenerate);
        }
        normals.push(normal.normalize());
        for vertex in face {
            incident[*vertex as usize].push(index);
        }
        for (a, b) in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])] {
            let key = (a.min(b), a.max(b));
            if let Some(edge) = edges.get_mut(&key) {
                if edge.second.is_some() || edge.forward == (a < b) {
                    return Err(Fallback::NonManifold);
                }
                edge.second = Some(index);
            } else {
                edges.insert(
                    key,
                    Edge {
                        first: index,
                        second: None,
                        forward: a < b,
                    },
                );
            }
        }
    }
    // A rotated planar/thin sheet can have large extents on all world axes.
    // Test thickness along an actual face normal as an additional conservative
    // guard; strict topology/locked creases handle disconnected opposing walls.
    let normal = normals[0];
    let (mut near, mut far) = (f32::INFINITY, f32::NEG_INFINITY);
    for vertex in vertices {
        let distance = Vec3::from_array(*vertex).dot(normal);
        near = near.min(distance);
        far = far.max(distance);
    }
    if (far - near) / longest < 0.005 {
        return Err(Fallback::Thin);
    }
    let mut locks = vec![false; vertices.len()];
    let mut boundary_degree = vec![0; vertices.len()];
    let mut adjacency = vec![Vec::new(); faces.len()];
    for ((a, b), edge) in edges {
        if let Some(second) = edge.second {
            adjacency[edge.first].push((second, a, b));
            adjacency[second].push((edge.first, a, b));
            // >=45° dihedral: both endpoints stay fixed and used.
            if normals[edge.first].dot(normals[second]) < std::f32::consts::FRAC_1_SQRT_2 {
                locks[a as usize] = true;
                locks[b as usize] = true;
            }
        } else {
            boundary_degree[a as usize] += 1;
            boundary_degree[b as usize] += 1;
            locks[a as usize] = true;
            locks[b as usize] = true;
        }
    }
    // Check vertex fans as well as edges: two closed surfaces touching at one
    // vertex are a non-manifold bow tie even though every edge has two faces.
    for (vertex, faces) in incident.iter().enumerate() {
        if faces.is_empty() {
            continue;
        }
        if boundary_degree[vertex] != 0 && boundary_degree[vertex] != 2 {
            return Err(Fallback::NonManifold);
        }
        let mut visited = HashSet::from([faces[0]]);
        let mut stack = vec![faces[0]];
        while let Some(face) = stack.pop() {
            for &(neighbor, a, b) in &adjacency[face] {
                if (a as usize == vertex || b as usize == vertex) && visited.insert(neighbor) {
                    stack.push(neighbor);
                }
            }
        }
        if visited.len() != faces.len() {
            return Err(Fallback::NonManifold);
        }
    }
    Ok(locks)
}

pub(super) fn generate(geometry: &ModelGeometry, quality: Quality) -> Result<Reduced, Fallback> {
    let ModelGeometry::Mesh { vertices, faces } = geometry else {
        return Err(Fallback::Invalid);
    };
    if vertices.len() > MAX_VERTICES || faces.len() > MAX_FACES {
        return Err(Fallback::SizeBudget);
    }
    if quality == Quality::High {
        return Err(Fallback::Protected);
    }
    if faces.len() < 64 {
        return Err(Fallback::Small);
    }
    let locks = protected_vertices(vertices, faces)?;
    let original: Vec<u32> = faces.iter().flatten().copied().collect();
    let adapter = meshopt::VertexDataAdapter::new(meshopt::typed_to_bytes(vertices), 12, 0)
        .map_err(|_| Fallback::Invalid)?;
    let target = if quality == Quality::Low {
        original.len() / 4
    } else {
        original.len() / 2
    };
    let mut error = 0.0;
    super::simplification_allocator::initialize();
    let indices = meshopt::simplify_with_locks(
        &original,
        &adapter,
        &locks,
        target / 3 * 3,
        error_limit(quality),
        meshopt::SimplifyOptions::LockBorder,
        Some(&mut error),
    );
    if !error.is_finite() || error > error_limit(quality) + 0.000001 {
        return Err(Fallback::ErrorLimit);
    }
    if indices.len() > original.len() * 9 / 10 || indices.is_empty() {
        return Err(Fallback::Protected);
    }
    let used: HashSet<_> = indices.iter().copied().collect();
    if locks
        .iter()
        .enumerate()
        .any(|(i, locked)| *locked && !used.contains(&(i as u32)))
    {
        return Err(Fallback::Protected);
    }
    let source = mesh::build_mesh(geometry).ok_or(Fallback::Invalid)?;
    let Some(VertexAttributeValues::Float32x3(normals)) = source.attribute(Mesh::ATTRIBUTE_NORMAL)
    else {
        return Err(Fallback::Invalid);
    };
    // Retain canonical smooth normals, rather than changing shading by
    // recomputing them from the reduced triangles. Compact unused vertices.
    let mut remap = vec![u32::MAX; vertices.len()];
    let mut positions = Vec::new();
    let mut retained_normals = Vec::new();
    let indices: Vec<u32> = indices
        .into_iter()
        .map(|v| {
            if remap[v as usize] == u32::MAX {
                remap[v as usize] = positions.len() as u32;
                positions.push(vertices[v as usize]);
                retained_normals.push(normals[v as usize]);
            }
            remap[v as usize]
        })
        .collect();
    let mut mesh = Mesh::new(
        bevy::render::render_resource::PrimitiveTopology::TriangleList,
        bevy::asset::RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, retained_normals);
    mesh.insert_indices(Indices::U32(indices));
    Ok(Reduced { mesh, error })
}

#[cfg(test)]
pub(super) mod tests;
