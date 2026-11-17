//! Area-weighted normals without an absolute, model-unit-dependent area cutoff.
use bevy::{prelude::Mesh, render::mesh::VertexAttributeValues};

pub(super) fn compute_smooth_normals(mesh: &mut Mesh) {
    let Some(VertexAttributeValues::Float32x3(positions)) =
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
    else {
        return;
    };
    // f64 preserves tiny surface areas and avoids overflow across finite f32 coordinates.
    let mut sums = vec![[0.0_f64; 3]; positions.len()];
    let indices: Vec<usize> = match mesh.indices() {
        Some(indices) => indices.iter().collect(),
        None => (0..positions.len()).collect(),
    };
    for triangle in indices.chunks_exact(3) {
        let [a, b, c] = [triangle[0], triangle[1], triangle[2]];
        let (Some(pa), Some(pb), Some(pc)) = (positions.get(a), positions.get(b), positions.get(c))
        else {
            continue;
        };
        let ab = std::array::from_fn::<_, 3, _>(|i| f64::from(pb[i]) - f64::from(pa[i]));
        let ac = std::array::from_fn::<_, 3, _>(|i| f64::from(pc[i]) - f64::from(pa[i]));
        let normal = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        if normal.iter().any(|v| !v.is_finite()) {
            continue;
        }
        for index in [a, b, c] {
            for axis in 0..3 {
                sums[index][axis] += normal[axis];
            }
        }
    }
    let normals: Vec<[f32; 3]> = sums
        .into_iter()
        .map(|normal| {
            let length = normal.iter().map(|v| v * v).sum::<f64>().sqrt();
            if length > 0.0 && length.is_finite() {
                normal.map(|v| (v / length) as f32)
            } else {
                // Isolated/collapsed vertices have no geometric normal; keep shader input valid.
                [0.0, 1.0, 0.0]
            }
        })
        .collect();
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, normals);
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::{
        asset::RenderAssetUsages,
        render::{mesh::Indices, render_resource::PrimitiveTopology},
    };
    #[test]
    fn official_soma_small_surface_faces_have_geometric_normals() {
        #[derive(serde::Deserialize)]
        struct Fixture {
            vertices: Vec<[f32; 3]>,
            faces: Vec<[u32; 3]>,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("fixtures/soma-small-faces.json")).unwrap();
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        );
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, fixture.vertices.clone());
        mesh.insert_indices(Indices::U32(
            fixture.faces.iter().flatten().copied().collect(),
        ));
        compute_smooth_normals(&mut mesh);
        let Some(VertexAttributeValues::Float32x3(normals)) =
            mesh.attribute(Mesh::ATTRIBUTE_NORMAL)
        else {
            panic!("normals")
        };
        for face in fixture.faces {
            let [a, b, c] =
                face.map(|i| bevy::math::Vec3::from_array(fixture.vertices[i as usize]));
            let expected = (b - a).cross(c - a).normalize();
            for index in face {
                let actual = bevy::math::Vec3::from_array(normals[index as usize]);
                assert!((actual.length() - 1.).abs() < 1e-6);
                assert!(actual.dot(expected) > 0.99999);
            }
        }
    }
    #[test]
    fn shared_vertex_accumulates_area_weighted_faces() {
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        );
        mesh.insert_attribute(
            Mesh::ATTRIBUTE_POSITION,
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 2.]],
        );
        mesh.insert_indices(Indices::U32(vec![0, 1, 2, 0, 3, 1]));
        compute_smooth_normals(&mut mesh);
        let Some(VertexAttributeValues::Float32x3(normals)) =
            mesh.attribute(Mesh::ATTRIBUTE_NORMAL)
        else {
            panic!("normals")
        };
        let expected = bevy::math::Vec3::new(0., 2., 1.).normalize();
        assert!((bevy::math::Vec3::from_array(normals[0]) - expected).length() < 1e-6);
    }
    #[test]
    fn tiny_triangles_keep_normals_across_model_scales() {
        for scale in [1.0_f32, 0.001, 1e-20, 1e20] {
            let mut mesh = Mesh::new(
                PrimitiveTopology::TriangleList,
                RenderAssetUsages::default(),
            );
            mesh.insert_attribute(
                Mesh::ATTRIBUTE_POSITION,
                vec![[0., 0., 0.], [scale, 0., 0.], [0., scale, 0.], [0., 0., 0.]],
            );
            mesh.insert_indices(Indices::U32(vec![0, 1, 2, 3, 3, 3]));
            compute_smooth_normals(&mut mesh);
            let Some(VertexAttributeValues::Float32x3(normals)) =
                mesh.attribute(Mesh::ATTRIBUTE_NORMAL)
            else {
                panic!("normals")
            };
            assert_eq!(&normals[..3], &[[0., 0., 1.]; 3]);
            assert_eq!(normals[3], [0., 1., 0.]);
        }
    }
}
