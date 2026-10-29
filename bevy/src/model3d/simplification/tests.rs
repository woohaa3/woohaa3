use super::*;

pub(crate) fn sphere() -> ModelGeometry {
    let mesh = Sphere::new(1.).mesh().ico(16).unwrap();
    let VertexAttributeValues::Float32x3(vertices) =
        mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
    else {
        panic!()
    };
    let faces = mesh
        .indices()
        .unwrap()
        .iter()
        .map(|v| v as u32)
        .collect::<Vec<_>>()
        .chunks_exact(3)
        .map(|v| [v[0], v[1], v[2]])
        .collect();
    ModelGeometry::Mesh {
        vertices: vertices.clone(),
        faces,
    }
}
#[test]
fn curved_mesh_reduces_at_least_half_with_original_positions_normals_and_high() {
    let geometry = sphere();
    let canonical = geometry.clone();
    let high = mesh::build_mesh(&geometry).unwrap();
    let low = generate(&geometry, Quality::Low).unwrap();
    let medium = generate(&geometry, Quality::Medium).unwrap();
    assert_eq!(geometry, canonical);
    assert!(low.error <= error_limit(Quality::Low));
    assert!(medium.error <= error_limit(Quality::Medium));
    assert!(low.mesh.indices().unwrap().len() <= high.indices().unwrap().len() / 2);
    assert!(low.mesh.count_vertices() < high.count_vertices());
    let VertexAttributeValues::Float32x3(positions) =
        high.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
    else {
        panic!()
    };
    let VertexAttributeValues::Float32x3(normals) = high.attribute(Mesh::ATTRIBUTE_NORMAL).unwrap()
    else {
        panic!()
    };
    let VertexAttributeValues::Float32x3(low_positions) =
        low.mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
    else {
        panic!()
    };
    let VertexAttributeValues::Float32x3(low_normals) =
        low.mesh.attribute(Mesh::ATTRIBUTE_NORMAL).unwrap()
    else {
        panic!()
    };
    for (p, normal) in low_positions.iter().zip(low_normals) {
        let index = positions.iter().position(|v| v == p).unwrap();
        assert_eq!(*normal, normals[index]);
    }
    assert_eq!(
        high.indices(),
        mesh::build_mesh(&canonical).unwrap().indices()
    );
}

#[test]
fn open_surface_preserves_every_boundary_and_hard_edge_vertex() {
    let mut vertices = Vec::new();
    let mut faces = Vec::new();
    const N: u32 = 24;
    for y in 0..N {
        for x in 0..N {
            let x = x as f32 / (N - 1) as f32;
            let y = y as f32 / (N - 1) as f32;
            vertices.push([
                x,
                y,
                0.2 * (x * std::f32::consts::PI).sin() * (y * std::f32::consts::PI).sin(),
            ]);
        }
    }
    for y in 0..N - 1 {
        for x in 0..N - 1 {
            let a = y * N + x;
            faces.push([a, a + 1, a + N]);
            faces.push([a + 1, a + N + 1, a + N]);
        }
    }
    let locks = protected_vertices(&vertices, &faces).unwrap();
    assert_eq!(locks.iter().filter(|v| **v).count(), ((N - 1) * 4) as usize);
    let reduced = generate(
        &ModelGeometry::Mesh {
            vertices: vertices.clone(),
            faces,
        },
        Quality::Low,
    )
    .unwrap();
    let VertexAttributeValues::Float32x3(positions) =
        reduced.mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap()
    else {
        panic!()
    };
    for (vertex, locked) in vertices.iter().zip(locks) {
        if locked {
            assert!(positions.contains(vertex));
        }
    }
}

#[test]
fn invalid_thin_degenerate_and_nonmanifold_surfaces_fall_back() {
    let thin = vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
    assert_eq!(protected_vertices(&thin, &[[0, 1, 2]]), Err(Fallback::Thin));
    assert_eq!(
        protected_vertices(&thin, &[[0, 1, 9]]),
        Err(Fallback::Invalid)
    );
    let rotated_thin = vec![[0., 0., 0.], [1., 0., 1.], [0., 1., 1.]];
    assert_eq!(
        protected_vertices(&rotated_thin, &[[0, 1, 2]]),
        Err(Fallback::Thin)
    );
    let vertices = vec![
        [0., 0., 0.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [-1., 0., 0.],
        [0., -1., 0.],
        [0., 0., -1.],
    ];
    let tetra = vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
    let locks = protected_vertices(&vertices, &tetra).unwrap();
    assert!(
        locks[..4].iter().all(|locked| *locked),
        "all tetrahedral creases must lock their vertices"
    );
    let mut bowtie = tetra.clone();
    bowtie.extend([[0, 5, 4], [0, 4, 6], [0, 6, 5], [4, 5, 6]]);
    assert_eq!(
        protected_vertices(&vertices, &bowtie),
        Err(Fallback::NonManifold)
    );
    let mut duplicate = tetra.clone();
    duplicate.push(tetra[0]);
    assert_eq!(
        protected_vertices(&vertices, &duplicate),
        Err(Fallback::NonManifold)
    );
    let mut degenerate = tetra;
    degenerate.push([0, 0, 1]);
    assert_eq!(
        protected_vertices(&vertices, &degenerate),
        Err(Fallback::Degenerate)
    );
}

#[test]
fn high_and_oversized_meshes_are_never_simplified() {
    assert!(matches!(
        generate(&sphere(), Quality::High),
        Err(Fallback::Protected)
    ));
    let geometry = ModelGeometry::Mesh {
        vertices: vec![[0., 0., 0.]; MAX_VERTICES + 1],
        faces: vec![[0, 1, 2]; 100],
    };
    assert!(matches!(
        generate(&geometry, Quality::Low),
        Err(Fallback::SizeBudget)
    ));
}
