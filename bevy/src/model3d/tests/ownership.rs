//! 3D 实体 owner / part / batch 组件与 `ModelRoot` 索引的一致性回归
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 5.1）。
use super::*;
use crate::canvas_ecs::components::{ModelBatch, ModelOwner, ModelPart};
use std::collections::HashMap;

fn snapshot() -> ModelSnapshot {
    serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"ownership", "extent":4,
        "ops": (0..4).map(|i| serde_json::json!({
            "t":"box", "id":format!("p{i}"), "size":[1,1,1],
            "position":[i,0,0], "color":"#ffffff"
        })).collect::<Vec<_>>()
    }))
    .unwrap()
}

fn node() -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id":"a", "type":"model", "x":0,"y":0,"width":120,"height":100,
        "modelPreview":{"azimuth":0,"elevation":0.4,"distanceScale":1}
    }))
    .unwrap()
}

/// 未合批根：每个部件实体都自持 `ModelOwner` + `ModelPart`，与 `part_entities` 一一对应。
#[test]
fn part_entities_carry_owner_and_part_components() {
    let mut world = world_with_resources();
    world.resource_mut::<ModelVisuals>().batching_strategy =
        super::super::batch_strategy::BatchStrategy::Automatic;
    let snapshot = snapshot();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let scene = scene_with(&node(), Some(reference));

    run_sync(&mut world, &scene, &resources);

    let (root, parts) = {
        let models = world.resource::<ModelVisuals>();
        let root_state = &models.roots["a"];
        let root = root_state.root_entity();
        let parts: Vec<(String, Entity)> = root_state
            .part_entities
            .iter()
            .map(|(id, entity)| (id.clone(), *entity))
            .collect();
        (root, parts)
    };
    assert_eq!(parts.len(), 4);
    let owner = world.get::<ModelOwner>(root).expect("root owner");
    assert_eq!(owner.root, root, "根实体自持 owner");
    for (id, entity) in parts {
        let owner = world.get::<ModelOwner>(entity).expect("part owner");
        assert_eq!(owner.root, root);
        let part = world.get::<ModelPart>(entity).expect("part marker");
        assert_eq!(part.owner, root);
        assert_eq!(part.part_id, id);
        assert!(
            world.get::<ModelBatch>(entity).is_none(),
            "未合批部件不是批次实体"
        );
    }
}

/// 合批根：批次实体自持 `ModelOwner` + `ModelBatch`，不再出现在 `part_entities` 中。
#[test]
fn batched_entities_carry_owner_and_batch_components() {
    let mut world = world_with_resources();
    let snapshot = snapshot();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let scene = scene_with(&node(), Some(reference));

    run_sync(&mut world, &scene, &resources);

    let (root, batches) = {
        let models = world.resource::<ModelVisuals>();
        let root_state = &models.roots["a"];
        assert!(
            root_state.part_entities.is_empty(),
            "合批根不应保留部件实体索引"
        );
        let batches: Vec<(String, Entity)> = root_state
            .part_batches
            .iter()
            .map(|(id, entity)| (id.clone(), *entity))
            .collect();
        (root_state.root_entity(), batches)
    };
    assert!(!batches.is_empty());
    let mut batch_entities: HashMap<Entity, String> = HashMap::new();
    for (part_id, entity) in batches {
        let owner = world.get::<ModelOwner>(entity).expect("batch owner");
        assert_eq!(owner.root, root);
        let batch = world.get::<ModelBatch>(entity).expect("batch marker");
        assert_eq!(batch.owner, root);
        assert!(!batch.batch_id.is_empty());
        assert!(
            !batch.batch_id.contains(part_id.as_str()),
            "batch_id 是批次身份，不是部件 id"
        );
        if let Some(previous) = batch_entities.insert(entity, batch.batch_id.clone()) {
            assert_eq!(previous, batch.batch_id, "同一批次实体身份稳定");
        }
        assert!(
            world.get::<ModelPart>(entity).is_none(),
            "批次实体不伪装成部件"
        );
    }
}

/// 根删除后组件随之回收，不留下可继续写入的 owner 记录。
#[test]
fn owner_components_are_recycled_with_root() {
    let mut world = world_with_resources();
    let snapshot = snapshot();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node(), Some(reference));
    run_sync(&mut world, &scene, &resources);
    let root = world.resource::<ModelVisuals>().roots["a"].root_entity();
    assert!(world.get_entity(root).is_ok());

    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
    assert!(world.get_entity(root).is_err(), "根实体已回收");
}
