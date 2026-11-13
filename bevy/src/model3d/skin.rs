//! Instance-owned CPU LBS. Mesh vertices feed drawing, shadows and capture together.
use bevy::prelude::*;
#[derive(Component)]
pub(crate) struct SkinBinding {
    pub joints: Vec<Entity>,
    pub skin: crate::protocol::ModelSkin,
    pub vertices: Vec<[f32; 3]>,
    pub last_matrices: Vec<Mat4>,
}
pub(crate) fn deform(
    vertices: &[[f32; 3]],
    skin: &crate::protocol::ModelSkin,
    matrices: &[Mat4],
) -> Vec<[f32; 3]> {
    vertices
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut result = Vec3::ZERO;
            if let (Some(indices), Some(weights)) = (skin.indices.get(i), skin.weights.get(i)) {
                for k in 0..8 {
                    if let Some(m) = matrices.get(indices[k]) {
                        result += m.transform_point3(Vec3::from_array(*p)) * weights[k];
                    }
                }
            }
            result.to_array()
        })
        .collect()
}
pub(crate) fn update(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut bindings: Query<(Entity, &Mesh3d, &GlobalTransform, &mut SkinBinding)>,
    transforms: Query<&GlobalTransform>,
) {
    for (entity, handle, global, mut binding) in &mut bindings {
        let inverse = global.to_matrix().inverse();
        let matrices: Option<Vec<Mat4>> = binding
            .joints
            .iter()
            .enumerate()
            .map(|(i, j)| {
                Some(
                    inverse
                        * transforms.get(*j).ok()?.to_matrix()
                        * Mat4::from_cols_array(binding.skin.inverse_bind_matrices.get(i)?),
                )
            })
            .collect();
        let Some(matrices) = matrices else { continue };
        if binding.last_matrices == matrices {
            continue;
        }
        binding.last_matrices.clone_from(&matrices);
        let positions = deform(&binding.vertices, &binding.skin, &matrices);
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for p in &positions {
            min = min.min(Vec3::from_array(*p));
            max = max.max(Vec3::from_array(*p));
        }
        if !min.is_finite() || !max.is_finite() {
            continue;
        }
        if let Some(mut mesh) = meshes.get_mut(&handle.0) {
            mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
            super::normals::compute_smooth_normals(&mut mesh);
        }
        commands
            .entity(entity)
            .insert(bevy::camera::primitives::Aabb::from_min_max(min, max));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_eight_influences_are_used_and_instances_are_independent() {
        let skin = crate::protocol::ModelSkin {
            joint_ids: (0..8).map(|i| i.to_string()).collect(),
            inverse_bind_matrices: vec![Mat4::IDENTITY.to_cols_array(); 8],
            indices: vec![[0, 1, 2, 3, 4, 5, 6, 7]],
            weights: vec![[0.125; 8]],
        };
        let rest = vec![[1., 2., 3.]];
        let bind = vec![Mat4::IDENTITY; 8];
        assert_eq!(deform(&rest, &skin, &bind), rest);
        let mut posed = bind.clone();
        posed[7] = Mat4::from_translation(Vec3::X * 8.);
        assert_eq!(deform(&rest, &skin, &posed), vec![[2., 2., 3.]]);
        assert_eq!(deform(&rest, &skin, &bind), rest);
        assert!(
            deform(&rest, &skin, &posed)[0]
                .iter()
                .all(|x| x.is_finite())
        );
    }
    #[test]
    fn instance_meshes_update_independently_and_publish_finite_bounds() {
        use bevy::render::mesh::VertexAttributeValues;
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .add_systems(Update, update);
        let mut source = Mesh::new(bevy::render::render_resource::PrimitiveTopology::TriangleList, bevy::asset::RenderAssetUsages::default());
        source.insert_attribute(Mesh::ATTRIBUTE_POSITION, vec![[0., 0., 0.], [0.001, 0., 0.], [0., 0.001, 0.]]);
        source.insert_indices(bevy::render::mesh::Indices::U32(vec![0, 1, 2]));
        let Some(VertexAttributeValues::Float32x3(vertices)) =
            source.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("positions")
        };
        let vertices = vertices.clone();
        let first = app
            .world_mut()
            .resource_mut::<Assets<Mesh>>()
            .add(source.clone());
        let second = app.world_mut().resource_mut::<Assets<Mesh>>().add(source);
        let moved = app
            .world_mut()
            .spawn(GlobalTransform::from_translation(Vec3::X))
            .id();
        let rest = app.world_mut().spawn(GlobalTransform::IDENTITY).id();
        let skin = crate::protocol::ModelSkin {
            joint_ids: vec!["joint".into()],
            inverse_bind_matrices: vec![Mat4::IDENTITY.to_cols_array()],
            indices: vec![[0; 8]; vertices.len()],
            weights: vec![[1., 0., 0., 0., 0., 0., 0., 0.]; vertices.len()],
        };
        let mut entities = Vec::new();
        for (handle, joint) in [(first.clone(), moved), (second.clone(), rest)] {
            entities.push(
                app.world_mut()
                    .spawn((
                        Mesh3d(handle),
                        GlobalTransform::IDENTITY,
                        SkinBinding {
                            joints: vec![joint],
                            skin: skin.clone(),
                            vertices: vertices.clone(),
                            last_matrices: Vec::new(),
                        },
                    ))
                    .id(),
            );
        }
        app.update();
        let meshes = app.world().resource::<Assets<Mesh>>();
        for (handle, offset) in [(first, 1.), (second, 0.)] {
            let Some(VertexAttributeValues::Float32x3(actual)) = meshes
                .get(&handle)
                .unwrap()
                .attribute(Mesh::ATTRIBUTE_POSITION)
            else {
                panic!("positions")
            };
            let Some(VertexAttributeValues::Float32x3(normals)) = meshes.get(&handle).unwrap().attribute(Mesh::ATTRIBUTE_NORMAL) else { panic!("normals") };
            assert_eq!(normals, &vec![[0., 0., 1.]; 3]);
            assert_eq!(
                actual[0],
                [vertices[0][0] + offset, vertices[0][1], vertices[0][2]]
            );
        }
        for entity in entities {
            let bounds = app
                .world()
                .get::<bevy::camera::primitives::Aabb>(entity)
                .unwrap();
            assert!(bounds.center.is_finite() && bounds.half_extents.is_finite());
        }
    }
}
