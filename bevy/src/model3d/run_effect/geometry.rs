use bevy::{
    asset::RenderAssetUsages,
    mesh::{Indices, PrimitiveTopology},
    prelude::*,
};

#[derive(Default)]
pub(super) struct Builder {
    shader_lines: bool,
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
    uv: Vec<[f32; 2]>,
    surface_uv: Vec<[f32; 2]>,
    indices: Vec<u32>,
}

impl Builder {
    fn quad(&mut self, points: [Vec3; 4], uv: [[f32; 2]; 4]) {
        let base = self.positions.len() as u32;
        self.positions.extend(points.map(|p| p.to_array()));
        self.normals.extend([[0., 1., 0.]; 4]);
        self.uv.extend(uv);
        self.surface_uv
            .extend([[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
        self.indices
            .extend([base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    fn line(&mut self, a: Vec3, b: Vec3, width: f32, kind: f32, range: [f32; 2], camera: Vec3) {
        let normal = (b - a).cross(camera).normalize_or_zero() * width * 0.5;
        let start = self.normals.len();
        self.quad(
            if self.shader_lines {
                [a, a, b, b]
            } else {
                [a - normal, a + normal, b + normal, b - normal]
            },
            [
                [range[0], kind],
                [range[0], kind],
                [range[1], kind],
                [range[1], kind],
            ],
        );
        if self.shader_lines {
            for value in &mut self.normals[start..] {
                *value = (b - a).normalize_or_zero().to_array();
            }
        }
    }

    fn outline(&mut self, corners: [Vec3; 4], width: f32, kind: f32, camera: Vec3, dashed: bool) {
        let lengths: [f32; 4] = std::array::from_fn(|i| corners[i].distance(corners[(i + 1) % 4]));
        let perimeter = lengths.iter().sum::<f32>().max(0.001);
        let mut distance = 0.;
        for i in 0..4 {
            let a = corners[i];
            let b = corners[(i + 1) % 4];
            if dashed {
                for [start, end] in [[0., 0.22], [0.39, 0.61], [0.78, 1.]] {
                    self.line(
                        a.lerp(b, start),
                        a.lerp(b, end),
                        width,
                        kind,
                        [0., 1.],
                        camera,
                    );
                }
            } else {
                self.line(
                    a,
                    b,
                    width,
                    kind,
                    [distance / perimeter, (distance + lengths[i]) / perimeter],
                    camera,
                );
            }
            distance += lengths[i];
        }
    }

    pub(super) fn mesh(self) -> Mesh {
        Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, self.normals)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uv)
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_1, self.surface_uv)
        .with_inserted_indices(Indices::U32(self.indices))
    }
}

pub(super) fn boundary(ground: [Vec3; 4], width: f32, camera: Vec3, warning: bool) -> Mesh {
    let mut mesh = Builder::default();
    mesh.outline(ground, width, 0., camera, warning);
    mesh.mesh()
}

/// 8 ground + 8 vertical + 8 top + 2 scan triangles. No model geometry is copied.
pub(super) fn animated(
    ground: [Vec3; 4],
    volume: Option<([Vec3; 4], Vec3)>,
    width: f32,
    camera: Vec3,
) -> Mesh {
    let mut mesh = Builder {
        shader_lines: true,
        ..default()
    };
    mesh.outline(ground, width, 0., camera, false);
    if let Some((bottom, axis)) = volume {
        let top = bottom.map(|p| p + axis);
        mesh.outline(top, width, 2., camera, false);
        for i in 0..4 {
            mesh.line(bottom[i], top[i], width, 1., [0., 1.], camera);
        }
        mesh.quad(bottom, [[0., 3.], [1., 3.], [1., 3.], [0., 3.]]);
    }
    mesh.mesh()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_is_bounded_and_empty_has_no_volume() {
        let corners = [Vec3::ZERO, Vec3::X, Vec3::X + Vec3::Z, Vec3::Z];
        let count = |mesh: Mesh| mesh.indices().unwrap().len() / 3;
        assert_eq!(count(animated(corners, None, 0.01, Vec3::Y)), 8);
        assert_eq!(
            count(animated(
                corners,
                Some((corners, Vec3::Y)),
                0.01,
                Vec3::Y + Vec3::Z
            )),
            26
        );
        assert_eq!(count(boundary(corners, 0.01, Vec3::Y, true)), 24);
    }
}
