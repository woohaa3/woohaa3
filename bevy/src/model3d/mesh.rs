//! `ModelGeometry` → `Mesh` 与稳定 mesh key
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2）。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
};

use super::scene::ModelGeometry;
use super::quality::{Quality, QUALITY_VERSION};

pub(crate) fn mesh_key(geometry: &ModelGeometry) -> String {
    match geometry {
        ModelGeometry::Box { size } => format!("box:{:08x},{:08x},{:08x}", size[0].to_bits(), size[1].to_bits(), size[2].to_bits()),
        ModelGeometry::Cylinder { radius, height } => format!("cyl:{:08x}:{:08x}", radius.to_bits(), height.to_bits()),
        ModelGeometry::Sphere { radius } => format!("sphere:{:08x}", radius.to_bits()),
        ModelGeometry::Capsule { radius, height } => format!("capsule:{:08x}:{:08x}", radius.to_bits(), height.to_bits()),
        ModelGeometry::Mesh { vertices, faces } => {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            vertices.len().hash(&mut hash);
            faces.len().hash(&mut hash);
            for value in vertices.iter().flatten() { value.to_bits().hash(&mut hash); }
            for value in faces.iter().flatten() { value.hash(&mut hash); }
            format!("mesh-hash-v1:{}:{}:{:016x}", vertices.len(), faces.len(), hash.finish())
        },
    }
}

pub(super) fn quality_key(base: &str, geometry: &ModelGeometry, quality: Quality) -> String {
    let quality = if matches!(geometry, ModelGeometry::Box { .. }) { Quality::High } else { quality };
    if matches!(geometry, ModelGeometry::Mesh { .. }) {
        format!("v{QUALITY_VERSION}:meshopt-0.6.2-s{}-e{:08x}:{quality:?}:{base}",
            super::simplification::VERSION, super::simplification::error_limit(quality).to_bits())
    } else { format!("v{QUALITY_VERSION}:{quality:?}:{base}") }
}

/// 每几何**有效**图元档位（change: 2026-10-15-add-film-set-overview-lod，design D3）。
///
/// 首版总览 LOD 只降低受支持的图元：球体、圆柱、胶囊（含胶囊 segment）使用根目标档位；Box
/// （含盒形 segment）始终 High（各档几何相同）；**总览根**的自定义 Mesh 也始终 High，不请求或
/// 消费其中低档简化缓存，也不因本策略新增简化队列。普通卡片保持既有简化行为（`overview=false`）。
///
/// spawn、runtime quality、playback_prepare、资源 lookup、batch/引用和诊断都经此解析，避免只改
/// mesh cache key 或让诊断按根 Low 漏计实际 High handle。
pub(super) fn effective_quality(geometry: &ModelGeometry, requested: Quality, overview: bool) -> Quality {
    match geometry {
        ModelGeometry::Box { .. } => Quality::High,
        ModelGeometry::Mesh { .. } if overview => Quality::High,
        _ => requested,
    }
}

#[allow(dead_code)]
pub(super) fn build_mesh(geometry: &ModelGeometry) -> Option<Mesh> {
    build_mesh_quality(geometry, super::quality::ViewPurpose::Export.select(0.0, Quality::High))
}

pub(super) fn build_mesh_quality(geometry: &ModelGeometry, quality: Quality) -> Option<Mesh> {
    let valid = |v: f32| v.is_finite() && v > 0.0;
    let legal = match geometry {
        ModelGeometry::Box { size } => size.iter().all(|v| valid(*v)),
        ModelGeometry::Sphere { radius } => valid(*radius),
        ModelGeometry::Cylinder { radius, height } | ModelGeometry::Capsule { radius, height } => valid(*radius) && valid(*height),
        ModelGeometry::Mesh { vertices, faces } => !vertices.is_empty() && !faces.is_empty()
            && vertices.iter().flatten().all(|v| v.is_finite())
            && faces.iter().flatten().all(|i| (*i as usize) < vertices.len()),
    };
    if !legal { return None; }
    let (longitudes, stacks, latitudes) = quality.subdivisions();
    match geometry {
        ModelGeometry::Box { size } => Some(Cuboid::new(size[0], size[1], size[2]).mesh().into()),
        ModelGeometry::Cylinder { radius, height } => Some(
            Cylinder::new(*radius, *height)
                .mesh()
                .resolution(longitudes)
                .into(),
        ),
        ModelGeometry::Sphere { radius } => Some(
            Sphere::new(*radius)
                .mesh()
                .uv(longitudes, stacks),
        ),
        ModelGeometry::Capsule { radius, height } => {
            // Bevy Capsule3d 的 height 是两端半球中心距（不含半径）；V2 total height 含半球。
            let cylinder_length = (height - radius * 2.0).max(0.0);
            Some(
                Capsule3d::new(*radius, cylinder_length)
                    .mesh()
                    .longitudes(longitudes)
                    .latitudes(latitudes)
                    .into(),
            )
        }
        ModelGeometry::Mesh { vertices, faces } => {
            let mut mesh = Mesh::new(
                PrimitiveTopology::TriangleList,
                RenderAssetUsages::default(),
            );
            mesh.insert_attribute(
                Mesh::ATTRIBUTE_POSITION,
                vertices.iter().map(|vertex| *vertex).collect::<Vec<_>>(),
            );
            mesh.insert_indices(Indices::U32(faces.iter().flatten().copied().collect()));
            mesh.compute_smooth_normals();
            Some(mesh)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn triangles(mesh: &Mesh) -> usize { mesh.indices().unwrap().len() / 3 }
    #[test]
    fn primitive_budgets_decrease_and_high_matches_existing_profile() {
        for geometry in [ModelGeometry::Sphere { radius: 1. }, ModelGeometry::Cylinder { radius: 1., height: 3. }, ModelGeometry::Capsule { radius: 1., height: 3. }] {
            let counts = [Quality::Low, Quality::Medium, Quality::High].map(|q| triangles(&build_mesh_quality(&geometry, q).unwrap()));
            assert!(counts[0] < counts[1] && counts[1] < counts[2], "{counts:?}");
        }
        let sphere = ModelGeometry::Sphere { radius: 1. };
        assert_eq!(triangles(&build_mesh_quality(&sphere, Quality::Low).unwrap()), 48);
        assert_eq!(triangles(&build_mesh_quality(&sphere, Quality::High).unwrap()), 528);
    }
    #[test]
    fn invalid_geometry_does_not_panic_or_allocate_a_mesh() {
        for radius in [0., -1., f32::NAN, f32::INFINITY] {
            assert!(build_mesh_quality(&ModelGeometry::Sphere { radius }, Quality::Low).is_none());
        }
        let bad = ModelGeometry::Mesh { vertices: vec![[0., 0., 0.]], faces: vec![[0, 1, 2]] };
        assert!(build_mesh_quality(&bad, Quality::High).is_none());
    }
    #[test]
    fn close_dimensions_cannot_alias_and_quality_has_separate_identity() {
        let a = ModelGeometry::Sphere { radius: 1.00001 };
        let b = ModelGeometry::Sphere { radius: 1.00002 };
        assert_ne!(mesh_key(&a), mesh_key(&b));
        assert_ne!(quality_key(&mesh_key(&a), &a, Quality::Low), quality_key(&mesh_key(&a), &a, Quality::High));
    }
}
