//! 小相机的低面数黑白几何；同色部件合并，避免提手、镜头环与线框各自增加 draw call。

use bevy::mesh::{ConvexPolygonMeshBuilder, ExtrusionBuilder};
use bevy::prelude::*;

pub(super) const BODY_WIDTH: f32 = 1.0;
pub(super) const LENS_FRONT_Z: f32 = -0.94;
const FRUSTUM_DEPTH: f32 = 0.8;
const FRAME_RADIUS: f32 = 0.035;

/// 四个 mesh 依次为黑色机体、白色机壳、黑色视锥线段、白色视锥线段。
pub(super) fn build() -> [Mesh; 4] {
    let mut dark = clipped_box(Vec3::new(BODY_WIDTH, 0.68, 0.8), 0.08);
    let mut light = None;

    // 六面都有浅色机壳与深色边框，绕到背面或俯视时仍有相邻的黑白区域。
    for side in [-1.0, 1.0] {
        append(
            &mut light,
            clipped_box(Vec3::new(0.78, 0.46, 0.018), 0.06),
            Transform::from_xyz(0.0, 0.0, side * 0.408),
        );
        append(
            &mut light,
            clipped_box(Vec3::new(0.62, 0.46, 0.018), 0.06),
            Transform::from_xyz(side * 0.508, 0.0, 0.0)
                .with_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2)),
        );
        append(
            &mut light,
            clipped_box(Vec3::new(0.78, 0.60, 0.018), 0.06),
            Transform::from_xyz(0.0, side * 0.348, 0.0)
                .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
        );
    }

    // 短镜筒沿局部 -Z；Cylinder 默认沿 Y，必须显式转轴。
    merge(
        &mut dark,
        cylinder(0.265, 0.50, Vec3::new(0.0, -0.035, -0.665)),
    );
    for z in [-0.48, -0.865] {
        append(
            &mut light,
            cylinder(0.30, 0.115, Vec3::new(0.0, -0.035, z)),
            Transform::IDENTITY,
        );
    }
    // 深色镜片覆盖白色前环中心，保持可辨识的同心轮廓。
    merge(
        &mut dark,
        cylinder(0.22, 0.03, Vec3::new(0.0, -0.035, -0.925)),
    );

    // 开放提手表达摄影机轮廓；白色握把与黑色支架形成对比。
    for z in [-0.23, 0.23] {
        merge(
            &mut dark,
            Cuboid::new(0.12, 0.22, 0.12)
                .mesh()
                .build()
                .transformed_by(Transform::from_xyz(0.0, 0.43, z)),
        );
    }
    merge(
        &mut dark,
        clipped_box(Vec3::new(0.20, 0.12, 0.64), 0.04)
            .transformed_by(Transform::from_xyz(0.0, 0.58, 0.0)),
    );
    append(
        &mut light,
        clipped_box(Vec3::new(0.218, 0.065, 0.40), 0.025),
        Transform::from_xyz(0.0, 0.625, 0.0),
    );

    let [dark_frame, light_frame] = frustum();
    [
        dark,
        light.expect("white camera shell"),
        dark_frame,
        light_frame,
    ]
}

/// 切角矩形挤出；比裸方块柔和，保持低面数与小尺寸轮廓清晰。
fn clipped_box(size: Vec3, bevel: f32) -> Mesh {
    let x = size.x * 0.5;
    let y = size.y * 0.5;
    let base_builder = ConvexPolygonMeshBuilder {
        vertices: vec![
            Vec2::new(-x + bevel, -y),
            Vec2::new(x - bevel, -y),
            Vec2::new(x, -y + bevel),
            Vec2::new(x, y - bevel),
            Vec2::new(x - bevel, y),
            Vec2::new(-x + bevel, y),
            Vec2::new(-x, y - bevel),
            Vec2::new(-x, -y + bevel),
        ],
    };
    ExtrusionBuilder::<ConvexPolygon> {
        base_builder,
        half_depth: size.z * 0.5,
        segments: 1,
    }
    .build()
}

fn cylinder(radius: f32, length: f32, center: Vec3) -> Mesh {
    Cylinder::new(radius, length)
        .mesh()
        .resolution(12)
        .build()
        .transformed_by(
            Transform::from_translation(center)
                .with_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
        )
}

/// 四角开放视锥；每条边都含黑白两段，去掉实心锥体对被摄主体的遮盖。
fn frustum() -> [Mesh; 2] {
    let start = Vec3::new(0.0, -0.035, LENS_FRONT_Z);
    let corners = [
        Vec3::new(-0.40, -0.26, -FRUSTUM_DEPTH),
        Vec3::new(0.40, -0.26, -FRUSTUM_DEPTH),
        Vec3::new(0.40, 0.26, -FRUSTUM_DEPTH),
        Vec3::new(-0.40, 0.26, -FRUSTUM_DEPTH),
    ]
    .map(|point| start + point);
    let mut dark = None;
    let mut light = None;
    for index in 0..4 {
        striped_edge(&mut dark, &mut light, start, corners[index], index);
        striped_edge(
            &mut dark,
            &mut light,
            corners[index],
            corners[(index + 1) % 4],
            index,
        );
    }
    [dark.unwrap(), light.unwrap()]
}

fn striped_edge(dark: &mut Option<Mesh>, light: &mut Option<Mesh>, a: Vec3, b: Vec3, phase: usize) {
    let middle = a.midpoint(b);
    for (index, (from, to)) in [(a, middle), (middle, b)].into_iter().enumerate() {
        let transform = Transform::from_translation(from.midpoint(to))
            .with_rotation(Quat::from_rotation_arc(Vec3::Y, (to - from).normalize()));
        let mesh = Cylinder::new(FRAME_RADIUS, from.distance(to))
            .mesh()
            .resolution(6)
            .build();
        append(
            if (index + phase) % 2 == 0 {
                dark
            } else {
                light
            },
            mesh,
            transform,
        );
    }
}

fn append(target: &mut Option<Mesh>, mesh: Mesh, transform: Transform) {
    let mesh = mesh.transformed_by(transform);
    if let Some(target) = target {
        merge(target, mesh);
    } else {
        *target = Some(mesh);
    }
}

fn merge(target: &mut Mesh, mesh: Mesh) {
    target
        .merge(&mesh)
        .expect("camera primitives share triangle topology and attributes");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lens_extends_forward_without_inflating_camera_body() {
        let [dark, light, _, _] = build();
        let positions = dark
            .attribute(Mesh::ATTRIBUTE_POSITION)
            .unwrap()
            .as_float3()
            .unwrap();
        let lens_front = positions.iter().map(|p| p[2]).fold(f32::INFINITY, f32::min);
        assert!(
            (lens_front - LENS_FRONT_Z).abs() < 1e-5,
            "镜筒必须沿 -Z，而非默认 Y 轴"
        );
        for mesh in [&dark, &light] {
            let positions = mesh
                .attribute(Mesh::ATTRIBUTE_POSITION)
                .unwrap()
                .as_float3()
                .unwrap();
            assert!(positions.iter().all(|p| Vec3::from_array(*p).is_finite()));
            let min_x = positions.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min);
            let max_x = positions
                .iter()
                .map(|p| p[0])
                .fold(f32::NEG_INFINITY, f32::max);
            assert!(
                (max_x - min_x) * 12.0 <= 13.0,
                "机壳细节不得扩大约 12px 的尺寸目标"
            );
        }
    }

    #[test]
    fn frustum_has_no_surface_across_the_optical_axis() {
        // 在锥体内部沿光轴射向远端：开放线框不应遮住中央主体。
        let origin = Vec3::new(0.0, -0.035, LENS_FRONT_Z - 0.2);
        let direction = Vec3::NEG_Z;
        for mesh in frustum() {
            let positions = mesh
                .attribute(Mesh::ATTRIBUTE_POSITION)
                .unwrap()
                .as_float3()
                .unwrap();
            let indices: Vec<_> = mesh.indices().unwrap().iter().collect();
            for triangle in indices.chunks_exact(3) {
                let [a, b, c] = [triangle[0], triangle[1], triangle[2]]
                    .map(|index| Vec3::from_array(positions[index]));
                let edge1 = b - a;
                let edge2 = c - a;
                let cross = direction.cross(edge2);
                let determinant = edge1.dot(cross);
                if determinant.abs() < 1e-6 {
                    continue;
                }
                let offset = origin - a;
                let u = offset.dot(cross) / determinant;
                let q = offset.cross(edge1);
                let v = direction.dot(q) / determinant;
                let distance = edge2.dot(q) / determinant;
                assert!(
                    distance < 0.0 || u < 0.0 || v < 0.0 || u + v > 1.0,
                    "视锥中央不得有实心面"
                );
            }
        }
    }
}
