use super::*;
use crate::model3d::scene::{ModelEntitySpec, ModelGeometry};
use std::collections::HashSet;

fn specs() -> Vec<ModelEntitySpec> {
    (0..8)
        .map(|index| ModelEntitySpec {
            id: format!("p{index}"),
            parent: Some("group".into()),
            position: [index as f32, 0., 0.],
            rotation_radians: [0., 0., 0.4],
            scale: [2., 1., 0.5],
            geometry: Some(ModelGeometry::Box { size: [1.; 3] }),
            material_key: "opaque".into(),
            animation: None,
        })
        .collect()
}
#[test]
fn exact_geometry_and_static_boundaries_control_instance_groups() {
    let mut specs = specs();
    specs[0].geometry = Some(ModelGeometry::Box { size: [2.; 3] });
    specs[1].scale[0] = -1.;
    specs[2].material_key = "transparent".into();
    specs[3].parent = Some("other".into());
    let plans = plan::plans(&specs, &HashSet::from(["opaque".into()]));
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0].parts, vec![4, 5, 6, 7]);
}
#[test]
fn immutable_records_match_nonuniform_transform_normals_and_canonical_bounds() {
    let specs = specs();
    let original = specs.clone();
    let plans = plan::plans(&specs, &HashSet::from(["opaque".into()]));
    let (data, bounds) = plan::build(&plans[0], &specs).unwrap();
    assert_eq!(data.parts.len(), 8);
    assert_eq!(data.bytes.len(), 8 * INSTANCE_STRIDE);
    let floats: Vec<_> = data.bytes[..INSTANCE_STRIDE]
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    let point = Vec4::new(0.3, 0.2, -0.4, 1.);
    let encoded = Vec3::new(
        Vec4::from_slice(&floats[0..4]).dot(point),
        Vec4::from_slice(&floats[4..8]).dot(point),
        Vec4::from_slice(&floats[8..12]).dot(point),
    );
    let transform = Transform {
        translation: Vec3::ZERO,
        rotation: crate::model3d::scene::quat_from_xyz_radians(specs[0].rotation_radians),
        scale: Vec3::from_array(specs[0].scale),
    };
    assert!(encoded.distance(transform.transform_point(point.truncate())) < 0.00001);
    let source_normal = Vec3::new(1., 1., 0.).normalize();
    let encoded_normal = Vec3::new(
        Vec3::from_slice(&floats[12..15]).dot(source_normal),
        Vec3::from_slice(&floats[16..19]).dot(source_normal),
        Vec3::from_slice(&floats[20..23]).dot(source_normal),
    );
    let tangent = transform.rotation * (transform.scale * Vec3::new(1., -1., 0.));
    assert!(encoded_normal.dot(tangent).abs() < 0.00001);
    assert!(bounds.min[0] < -1. && bounds.max[0] > 8.);
    assert_eq!(specs, original);
}
