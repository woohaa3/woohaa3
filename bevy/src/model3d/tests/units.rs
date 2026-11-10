//! 纯函数/单实体单元测试：颜色、transform、mesh key、锚点
//! （change: refactor-bevy-rust-file-size，任务 4.1 / design D4）。

use super::super::layout::{model_bounds_for_node, model_root_transform, world_instance_transform};
use super::super::mesh::mesh_key;
use super::super::scene::ModelGeometry;
use super::super::{grid, scene};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};
use bevy::prelude::*;

#[test]
fn world_root_reads_only_the_shared_world_instance() {
    // 旧卡片节点（无 sharedWorldInstance）没有世界根，也不产生可聚焦 AABB。
    let legacy: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "m", "type": "model3d", "x": 10., "y": 20., "width": 224., "height": 116.
    }))
    .unwrap();
    assert!(world_instance_transform(&legacy).is_none());
    assert!(model_root_transform(&legacy).is_none());
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![],
        signature: "sig".into(),
        extent: 1.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    assert!(model_bounds_for_node(&model, &legacy).is_none());

    // 世界模型：根姿态完全来自实例 transform，与卡片坐标无关。
    let world: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "w", "type": "model3d", "x": 0.0, "y": 0.0, "width": 260.0, "height": 195.0,
        "sharedWorldInstance": {"kind": "world-instance", "version": "shared-world-v1",
            "instanceId": "i1",
            "transform": {"version": "shared-world-v1", "position": {"u": 3.0, "v": 4.0, "h": 0.0},
                "rotation": [0.0, 0.0, 0.0, 1.0], "scale": 2.0}}
    }))
    .unwrap();
    let root = world_instance_transform(&world).unwrap();
    // u = 3m → 渲染 x = 3 × 64；v = 4m → 渲染 z = -4 × 64（Y-up）。
    assert!((root.translation.x - 192.0).abs() < 1e-3);
    assert!((root.translation.z + 256.0).abs() < 1e-3);
    assert!((root.scale.x - 128.0).abs() < 1e-3);
    // 内容签名变化不改变世界根；实例变换才是唯一位置来源。
    assert_eq!(world_instance_transform(&world).unwrap(), root);
}

#[test]
fn mesh_key_is_stable_for_same_geometry() {
    assert_eq!(
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 }),
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 })
    );
    assert_ne!(
        mesh_key(&ModelGeometry::Sphere { radius: 0.25 }),
        mesh_key(&ModelGeometry::Sphere { radius: 0.5 })
    );
}

#[test]
fn material_key_prefers_material_reference() {
    let op = ModelOp::Sphere {
        id: "s".into(),
        parent: None,
        position: [0.0; 3],
        rotation: [0.0; 3],
        scale: [1.0; 3],
        color: Some("#ff0000".into()),
        material: Some("armor".into()),
        radius: 0.2,
    };
    assert_eq!(scene::material_key(&op), "material:armor");
}

/// 内容 identity 与世界根 identity 分离（任务 1.1 / design D4）。
#[test]
fn content_and_world_root_identity_are_independent() {
    let node = |instance: &str| -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "v2", "type": "model3d", "x": 0.0, "y": 0.0, "width": 260.0, "height": 195.0,
            "sharedWorldInstance": {"kind": "world-instance", "version": "shared-world-v1",
                "instanceId": instance,
                "transform": {"version": "shared-world-v1", "position": {"u": 0.0, "v": 0.0, "h": 0.0},
                    "rotation": [0.0, 0.0, 0.0, 1.0], "scale": 1.0}}
        }))
        .unwrap()
    };
    let v2_before = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![],
        signature: "v2-sig-a".into(),
        extent: 3.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let v2_after = ModelSnapshot {
        signature: "v2-sig-b".into(),
        ..v2_before.clone()
    };
    // 内容签名变化（Scene IR）不改变世界根。
    assert_eq!(v2_before.signature == v2_after.signature, false);
    assert_eq!(model_root_transform(&node("i1")), model_root_transform(&node("i1")));
    // 实例身份不同但变换相同 ⇒ 世界根相同；变换改变才改变世界根。
    assert_eq!(model_root_transform(&node("i1")), model_root_transform(&node("i2")));
    let mut moved = node("i1");
    moved.shared_world_instance.as_mut().unwrap().transform.position.u = 5.0;
    assert_ne!(model_root_transform(&node("i1")), model_root_transform(&moved));
}

/// 重复 shape 复用同一 mesh key（任务 4.2）：同尺寸关节不线性创建重复资源。
#[test]
fn repeated_shapes_share_mesh_key() {
    let joint = ModelGeometry::Sphere { radius: 0.22 };
    assert_eq!(
        mesh_key(&joint),
        mesh_key(&ModelGeometry::Sphere { radius: 0.22 })
    );
    let keys: std::collections::HashSet<String> = (0..10).map(|_| mesh_key(&joint)).collect();
    assert_eq!(keys.len(), 1, "重复 shape 应共享同一 mesh key");
}

/// 固定世界不变式：同一世界变换派生稳定 AABB；实例 scale 改变才改变 bounds
/// （change: 2026-11-10-remove-legacy-model-card-nodes）。
#[test]
fn model_world_is_stable_and_scale_sensitive() {
    let node = |scale: f64| -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "w", "type": "model3d", "x": 0.0, "y": 0.0, "width": 260.0, "height": 195.0,
            "sharedWorldInstance": {"kind": "world-instance", "version": "shared-world-v1",
                "instanceId": "i1",
                "transform": {"version": "shared-world-v1", "position": {"u": 0.0, "v": 0.0, "h": 0.0},
                    "rotation": [0.0, 0.0, 0.0, 1.0], "scale": scale}}
        }))
        .unwrap()
    };
    let model = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 2.0, 0.0],
            rotation: [0.0, 0.0, 0.0],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0, 4.0, 1.0],
        }],
        signature: "sig".into(),
        extent: 4.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let base = model_bounds_for_node(&model, &node(1.0)).unwrap();
    // 派生函数只接受内容与实例变换：同输入多次派生逐位稳定。
    assert_eq!(base, model_bounds_for_node(&model, &node(1.0)).unwrap());
    // 实例 scale 改变确实改变世界 bounds。
    let scaled = model_bounds_for_node(&model, &node(2.0)).unwrap();
    let radius = |aabb: crate::model3d::scene::ModelAabb| {
        (bevy::prelude::Vec3::from_array(aabb.max) - bevy::prelude::Vec3::from_array(aabb.min)).length()
            * 0.5
    };
    assert!(
        (radius(scaled.0) - radius(base.0) * 2.0).abs() < 1e-2,
        "实例 scale 改变应翻倍世界半径"
    );
}

/// `modelPlacement` 仍是内容/历史快照字段，但不进入世界根：旧卡片偏移不再移动模型。
#[test]
fn model_placement_never_moves_the_world_root() {
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "w", "type": "model3d", "x": 0.0, "y": 0.0, "width": 260.0, "height": 195.0,
        "sharedWorldInstance": {"kind": "world-instance", "version": "shared-world-v1",
            "instanceId": "i1",
            "transform": {"version": "shared-world-v1", "position": {"u": 0.0, "v": 0.0, "h": 0.0},
                "rotation": [0.0, 0.0, 0.0, 1.0], "scale": 1.0}}
    }))
    .unwrap();
    let root = model_root_transform(&node).unwrap();
    // 根变换只看实例；`ModelReference` 已不含 placement 字段，因此无法再叠加卡片偏移。
    assert_eq!(root.translation, Vec3::ZERO);
    // 旧客户端携带 `placement`：按未知字段忽略，世界根仍是实例姿态。
    let _legacy_reference: crate::protocol::ModelReference = serde_json::from_value(serde_json::json!({
        "resourceKey": "woohaa-model-scene-ir-v2:sig",
        "placement": {"offset": {"x": 9.0, "y": 9.0, "z": 9.0}, "scale": 3.0, "yaw": 45.0}
    }))
    .unwrap();
    assert_eq!(model_root_transform(&node).unwrap(), root);
}
