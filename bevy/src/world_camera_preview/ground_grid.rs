//! A real horizontal grid for the flying observer. The canvas grid is a screen-
//! aligned backdrop at a fixed depth and cannot serve an arbitrary 3D lens.
use crate::{protocol::UNITS_PER_METER, theme::ThemeResource};
use bevy::{
    asset::RenderAssetUsages,
    camera::visibility::{NoFrustumCulling, RenderLayers},
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
};

#[derive(Default)]
pub(super) struct GroundGrid {
    slots: Vec<(Entity, Handle<Mesh>, Handle<StandardMaterial>)>,
    signature: String,
}

impl GroundGrid {
    pub fn clear(
        &mut self,
        commands: &mut Commands,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
    ) {
        for (entity, mesh, material) in self.slots.drain(..) {
            commands.entity(entity).try_despawn();
            meshes.remove(mesh.id());
            materials.remove(material.id());
        }
        self.signature.clear();
    }

    pub fn sync(
        &mut self,
        commands: &mut Commands,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
        pose: Transform,
        projection: &Projection,
        far: f32,
        theme: &ThemeResource,
    ) {
        let (min, max, spacing) = bounds(pose, projection, far);
        let signature = format!("{min:?}:{max:?}:{spacing}:{}", theme.fingerprint());
        if self.signature == signature {
            return;
        }
        self.signature = signature;
        for major in [false, true] {
            let mesh = grid_mesh(min, max, spacing, major);
            let color = theme.token_color(if major { "gridMajor" } else { "gridMinor" });
            let index = usize::from(major);
            if let Some((_, handle, material)) = self.slots.get(index) {
                // Keep the same entities, mesh handles and materials throughout movement.
                meshes.insert(handle.id(), mesh).expect("live grid mesh");
                if let Some(mut material) = materials.get_mut(material.id()) {
                    material.base_color = color;
                }
            } else {
                let mesh = meshes.add(mesh);
                let material = materials.add(crate::isometric_grid::grid_material(color));
                let entity = commands
                    .spawn((
                        bevy::light::NotShadowCaster,
                        Mesh3d(mesh.clone()),
                        MeshMaterial3d(material.clone()),
                        NoFrustumCulling,
                        RenderLayers::layer(super::EDITOR_GUIDE_LAYER),
                    ))
                    .id();
                self.slots.push((entity, mesh, material));
            }
        }
    }
}

fn bounds(pose: Transform, projection: &Projection, far: f32) -> (Vec2, Vec2, f32) {
    let far = far.clamp(UNITS_PER_METER as f32, 100_000.0);
    let center = Vec2::new(pose.translation.x, pose.translation.z);
    let mut min = center;
    let mut max = center;
    let corners = projection.get_frustum_corners(-1.0, -far);
    for i in 0..4 {
        let a = pose.transform_point(Vec3::from(corners[i]));
        let b = pose.transform_point(Vec3::from(corners[i + 4]));
        let direction = b - a;
        let t = -a.y / direction.y;
        let point = if t.is_finite() && (0.0..=1.0).contains(&t) {
            a + direction * t
        } else {
            b
        };
        let ground =
            Vec2::new(point.x, point.z).clamp(center - Vec2::splat(far), center + Vec2::splat(far));
        min = min.min(ground);
        max = max.max(ground);
    }
    let mut spacing = UNITS_PER_METER as f32;
    while (max - min).max_element() / spacing > 160.0 {
        spacing *= 2.0;
    }
    (
        (min / spacing).floor() * spacing - Vec2::splat(spacing),
        (max / spacing).ceil() * spacing + Vec2::splat(spacing),
        spacing,
    )
}

fn grid_mesh(min: Vec2, max: Vec2, spacing: f32, major: bool) -> Mesh {
    let mut positions = Vec::<[f32; 3]>::new();
    let mut indices = Vec::<u32>::new();
    let half_width = (spacing / UNITS_PER_METER as f32).sqrt() * if major { 0.65 } else { 0.4 };
    let mut line = |a: Vec2, b: Vec2| {
        let offset = (b - a).normalize_or_zero().perp() * half_width;
        let base = positions.len() as u32;
        for point in [a + offset, a - offset, b - offset, b + offset] {
            positions.push([point.x, -0.04, point.y]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    };
    for axis in 0..2 {
        let start = (min[axis] / spacing).round() as i32;
        let end = (max[axis] / spacing).round() as i32;
        for index in start..=end {
            if (index.rem_euclid(8) == 0) != major {
                continue;
            }
            let coordinate = index as f32 * spacing;
            if axis == 0 {
                line(Vec2::new(coordinate, min.y), Vec2::new(coordinate, max.y));
            } else {
                line(Vec2::new(min.x, coordinate), Vec2::new(max.x, coordinate));
            }
        }
    }
    let count = positions.len();
    Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    )
    .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
    .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; count])
    .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count])
    .with_inserted_indices(Indices::U32(indices))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::render::mesh::VertexAttributeValues;

    #[test]
    fn world_camera_grid_covers_a_perspective_ground_view_with_bounded_geometry() {
        let pose =
            Transform::from_xyz(0.0, 8.0 * 64.0, 10.0 * 64.0).looking_at(Vec3::ZERO, Vec3::Y);
        let mut projection = Projection::Perspective(PerspectiveProjection::default());
        projection.update(1200.0, 800.0);
        let (min, max, spacing) = bounds(pose, &projection, 500.0 * 64.0);
        assert!(min.cmple(Vec2::ZERO).all() && max.cmpge(Vec2::ZERO).all());
        for major in [false, true] {
            let mesh = grid_mesh(min, max, spacing, major);
            let Some(VertexAttributeValues::Float32x3(vertices)) =
                mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            else {
                panic!("ground grid vertices")
            };
            assert!(!vertices.is_empty() && vertices.len() < 1400);
            assert!(
                vertices
                    .iter()
                    .all(|point| point[1] == -0.04 && Vec3::from_array(*point).is_finite())
            );
        }
        // Looking above the horizon remains finite and does not create unbounded lines.
        let pose = Transform::from_xyz(0.0, 1.0, 0.0).looking_to(Vec3::Y, Vec3::Z);
        let (min, max, spacing) = bounds(pose, &projection, 500.0 * 64.0);
        assert!(min.is_finite() && max.is_finite());
        assert!((max - min).max_element() / spacing <= 164.0);
    }
}
