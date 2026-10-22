//! scene 单元测试（change: refactor-bevy-rust-file-size，任务 2.2 / design D4）。
//!
//! 由 `scene.rs` 内联测试移动而来，断言与覆盖完全保留；通过 `super::*` 访问 facade
//! 再导出的构建指令、AABB、material 与 transform 数学。

use bevy::prelude::*;

use super::*;
use crate::protocol::{ModelOp, ModelPlacement, ModelSnapshot};

fn snapshot(v2: bool, ops: Vec<ModelOp>) -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(if v2 {
            crate::protocol::MODEL_SCENE_IR_V2.to_owned()
        } else {
            "woohaa-model-scene-ir-v1".to_owned()
        }),
        ops,
        signature: "sig".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn group(id: &str, parent: Option<&str>) -> ModelOp {
    ModelOp::Group {
        id: id.into(),
        parent: parent.map(str::to_owned),
        position: [0.0; 3],
        rotation: [0.0; 3],
        scale: [1.0; 3],
    }
}

#[test]
fn v1_keeps_flat_specs() {
    let specs = build_entity_specs(&snapshot(
        false,
        vec![
            group("root", None),
            ModelOp::Box {
                id: "b".into(),
                parent: Some("root".into()),
                position: [1.0, 0.0, 0.0],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ff0000".into()),
                material: None,
                size: [1.0; 3],
            },
        ],
    ));
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[1].material_key, "color:#ff0000");
}

#[test]
fn v2_preserves_real_parent_links() {
    let specs = build_entity_specs(&snapshot(
        true,
        vec![
            group("arm", None),
            ModelOp::Sphere {
                id: "elbow".into(),
                parent: Some("arm".into()),
                position: [0.0, 0.0, 0.0],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                radius: 0.2,
            },
        ],
    ));
    assert_eq!(specs[1].parent.as_deref(), Some("arm"));
}

#[test]
fn segment_center_and_stable_orientation() {
    let forward = segment_geometry([0.0, 0.0, 0.0], [1.0, 2.0, 2.0], 0.2, 0.2, 0.0, true).unwrap();
    let reverse = segment_geometry([1.0, 2.0, 2.0], [0.0, 0.0, 0.0], 0.2, 0.2, 0.0, true).unwrap();
    assert_eq!(forward.center, reverse.center);
    // 交换端点得到同一朝向（不会随机翻转）。
    assert!(forward.rotation.abs_diff_eq(reverse.rotation, 1e-5));
    assert!((forward.length - 3.0).abs() < 1e-5);
}

#[test]
fn segment_built_transform_preserves_endpoints() {
    let start = Vec3::new(0.4, 1.2, -0.7);
    // 覆盖近乎竖直的腿、水平和空间斜向肢体，以及端点倒序。
    for delta in [
        Vec3::Y * 2.0,
        Vec3::new(0.05236, 2.0, 0.0),
        Vec3::X * 2.0,
        Vec3::Z * 2.0,
        Vec3::new(1.0, 2.0, -3.0),
    ] {
        for reverse in [false, true] {
            let end = start + delta;
            let (from, to) = if reverse { (end, start) } else { (start, end) };
            for shape in ["capsule", "box"] {
                let specs = build_entity_specs(&snapshot(
                    true,
                    vec![ModelOp::Segment {
                        id: "limb".into(),
                        parent: None,
                        position: [0.0; 3],
                        rotation: [0.0; 3],
                        scale: [1.0; 3],
                        from: from.to_array(),
                        to: to.to_array(),
                        width: 0.2,
                        depth: None,
                        shape: shape.into(),
                        overlap: 0.0,
                        color: None,
                        material: None,
                    }],
                ));
                let spec = &specs[0];
                let length = match spec.geometry.as_ref().unwrap() {
                    ModelGeometry::Capsule { height, .. } => *height,
                    ModelGeometry::Box { size } => size[1],
                    _ => panic!("unexpected segment geometry"),
                };
                let center = Vec3::from_array(spec.position);
                let half_axis =
                    quat_from_xyz_radians(spec.rotation_radians) * Vec3::Y * (length / 2.0);
                let a = center - half_axis;
                let b = center + half_axis;
                assert!(
                    (a.abs_diff_eq(from, 1e-4) && b.abs_diff_eq(to, 1e-4))
                        || (a.abs_diff_eq(to, 1e-4) && b.abs_diff_eq(from, 1e-4)),
                    "{shape}: {from:?} → {to:?}, rendered endpoints {a:?}, {b:?}"
                );
            }
        }
    }
}

#[test]
fn segment_rejects_degenerate() {
    assert!(segment_geometry([1.0, 1.0, 1.0], [1.0, 1.0, 1.0], 0.2, 0.2, 0.0, true).is_none());
}

#[test]
fn local_aabb_covers_hierarchy_and_radii() {
    // 父 group 抬升 2，子 sphere 半径 0.5 位于 (1,0,0)：世界局部 y ∈ [1.5, 2.5]。
    let mut root = group("root", None);
    if let ModelOp::Group { position, .. } = &mut root {
        *position = [0.0, 2.0, 0.0];
    }
    let model = snapshot(
        true,
        vec![
            root,
            ModelOp::Sphere {
                id: "s".into(),
                parent: Some("root".into()),
                position: [1.0, 0.0, 0.0],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                radius: 0.5,
            },
        ],
    );
    let aabb = model_local_aabb(&model).expect("aabb");
    assert!((aabb.min[0] - 0.5).abs() < 1e-5, "min.x={}", aabb.min[0]);
    assert!((aabb.max[0] - 1.5).abs() < 1e-5, "max.x={}", aabb.max[0]);
    assert!((aabb.min[1] - 1.5).abs() < 1e-5, "min.y={}", aabb.min[1]);
    assert!((aabb.max[1] - 2.5).abs() < 1e-5, "max.y={}", aabb.max[1]);
}

#[test]
fn local_aabb_includes_segment_radius_along_axis() {
    // 竖直 capsule segment：几何高度 = length + 2*overlap，半径在 x/z 向外扩。
    let model = snapshot(
        true,
        vec![ModelOp::Segment {
            id: "leg".into(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            from: [0.0, 0.0, 0.0],
            to: [0.0, 2.0, 0.0],
            width: 0.5,
            depth: None,
            shape: "capsule".into(),
            overlap: 0.0,
            color: Some("#ffffff".into()),
            material: None,
        }],
    );
    let aabb = model_local_aabb(&model).expect("aabb");
    // 中心 y=1、半高 1 → y ∈ [0, 2]；半径 0.25 使 x ∈ [-0.25, 0.25]。
    assert!((aabb.max[1] - 2.0).abs() < 1e-4, "max.y={}", aabb.max[1]);
    assert!((aabb.min[1]).abs() < 1e-4, "min.y={}", aabb.min[1]);
    assert!((aabb.min[0] + 0.25).abs() < 1e-4, "min.x={}", aabb.min[0]);
}

#[test]
fn world_aabb_scales_with_unit_and_rotates() {
    let model = snapshot(
        true,
        vec![ModelOp::Box {
            id: "b".into(),
            parent: None,
            position: [0.0, 1.0, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 2.0, 1.0],
        }],
    );
    // 局部 y ∈ [0, 2]；单位缩放 3 → [0, 6]。
    let aabb = model_world_aabb(&model, Quat::IDENTITY, 3.0).expect("aabb");
    assert!((aabb.min[1]).abs() < 1e-4, "min.y={}", aabb.min[1]);
    assert!((aabb.max[1] - 6.0).abs() < 1e-4, "max.y={}", aabb.max[1]);
}

#[test]
fn empty_model_has_no_aabb() {
    assert!(model_local_aabb(&snapshot(true, vec![])).is_none());
    assert!(model_local_aabb(&snapshot(true, vec![group("only", None)])).is_none());
}

/// change: refactor-bevy-reusable-components，任务 1.1/1.3 —— AABB 纯操作与兼容性。
#[test]
fn aabb_operations_are_finite_safe_and_composable() {
    let a = ModelAabb::new([-1.0, -1.0, -1.0], [1.0, 1.0, 1.0]);
    let b = ModelAabb::new([0.0, 0.0, 0.0], [4.0, 2.0, 2.0]);
    assert!(a.is_finite());
    assert!(!ModelAabb::new([f32::NAN, 0.0, 0.0], [1.0, 1.0, 1.0]).is_finite());

    let union = a.union(b);
    assert_eq!(union.min, [-1.0, -1.0, -1.0]);
    assert_eq!(union.max, [4.0, 2.0, 2.0]);

    // center/half_extents/radius 自洽。
    let c = union.center();
    assert!(c.abs_diff_eq(Vec3::new(1.5, 0.5, 0.5), 1e-6));
    let half = union.half_extents();
    assert!(half.abs_diff_eq(Vec3::new(2.5, 1.5, 1.5), 1e-6));
    assert!((union.radius() - (Vec3::new(5.0, 3.0, 3.0).length() / 2.0)).abs() < 1e-6);
}

#[test]
fn aabb_transform_matches_manual_corner_projection() {
    // 平移 + 均匀缩放后，包围盒应与直接计算一致。
    let a = ModelAabb::new([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]);
    let transform = Transform::from_xyz(10.0, -5.0, 2.0).with_scale(Vec3::splat(2.0));
    let transformed = a.transformed(&transform);
    assert!(Vec3::from_array(transformed.min).abs_diff_eq(Vec3::new(10.0, -5.0, 2.0), 1e-5));
    assert!(Vec3::from_array(transformed.max).abs_diff_eq(Vec3::new(12.0, -1.0, 8.0), 1e-5));
}

#[test]
fn aabb_transform_handles_rotation_without_undo() {
    // 绕 Y 轴 90°：x 与 z 半长互换。
    let a = ModelAabb::new([-1.0, 0.0, -3.0], [1.0, 2.0, 3.0]);
    let transform = Transform::from_rotation(Quat::from_rotation_y(std::f32::consts::FRAC_PI_2));
    let transformed = a.transformed(&transform);
    // 原 half = (1,1,3)；旋转后 x 半长应接近 3，z 半长接近 1。
    assert!((transformed.half_extents().x - 3.0).abs() < 1e-4);
    assert!((transformed.half_extents().z - 1.0).abs() < 1e-4);
    assert!((transformed.half_extents().y - 1.0).abs() < 1e-4);
}

#[test]
fn material_maps_to_pbr_subset() {
    let materials = collect_materials(&snapshot(
        true,
        vec![ModelOp::Material {
            id: "armor".into(),
            base_color: "#26343a".into(),
            roughness: 0.35,
            metallic: 0.85,
            emissive: "#000000".into(),
            emissive_strength: 0.0,
            alpha_mode: "opaque".into(),
            double_sided: false,
            unlit: false,
            opacity: None,
        }],
    ));
    let spec = materials.get("armor").expect("material");
    assert!((spec.metallic - 0.85).abs() < 1e-6);
    assert!((spec.roughness - 0.35).abs() < 1e-6);
}

#[test]
fn capsule_total_height_semantics() {
    let specs = build_entity_specs(&snapshot(
        true,
        vec![ModelOp::Capsule {
            id: "limb".into(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            radius: 0.3,
            height: 1.2,
        }],
    ));
    assert_eq!(
        specs[0].geometry,
        Some(ModelGeometry::Capsule {
            radius: 0.3,
            height: 1.2
        })
    );
}

/// 多级层级组合 golden：与 contracts `model-transform` 的结果一致（任务 3.2）。
#[test]
fn hierarchy_composition_matches_contracts_golden() {
    let root = LocalTransform::of([1.0, 2.0, 3.0], [10.0, 20.0, 30.0], [2.0, 1.0, 0.5]);
    let mid = LocalTransform::of([0.5, 0.0, -1.0], [0.0, 45.0, 0.0], [1.0, 2.0, 1.0]);
    let leaf = LocalTransform::of([1.0, 1.0, 0.0], [0.0, 0.0, 90.0], [1.0; 3]);
    let world = root.mul(mid).mul(leaf);
    // 与 web/contracts/scene-ir-v2.test golden 对齐。
    assert!(
        world
            .translation
            .abs_diff_eq(Vec3::new(1.5547956, 5.226905, 1.3350893), 1e-4)
    );
    assert!(world.scale.abs_diff_eq(Vec3::new(2.0, 2.0, 0.5), 1e-6));
}

/// 父 group 变换传播到后代：与「旋转手臂整个 group」一致（任务 3.2）。
#[test]
fn parent_transform_propagates_to_descendants() {
    let arm = LocalTransform::of([0.0, 2.0, 0.0], [0.0, 0.0, 90.0], [1.0; 3]);
    let forearm = LocalTransform::of([0.0, 1.0, 0.0], [0.0; 3], [1.0; 3]);
    let world = arm.mul(forearm);
    // 绕 Z 旋转 90° 把局部 +Y 映射到 -X（长度 1），叠加 arm 平移。
    assert!(
        world
            .translation
            .abs_diff_eq(Vec3::new(-1.0, 2.0, 0.0), 1e-5)
    );
}
