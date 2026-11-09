use super::*;
use crate::model3d::{batch_strategy::BatchStrategy, instancing::Instances};

#[test]
fn explicit_requests_recover_shadow_capable_entities_and_keep_shared_ownership() {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"instances", "extent":4,
        "ops": (0..8).map(|i| serde_json::json!({ "t":"box", "id":format!("p{i}"),
            "size":[1,1,1], "position":[i,0,0], "color":"#ffffff" })).collect::<Vec<_>>()
    }))
    .unwrap();
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"a", "type":"model", "x":0,"y":0,"width":120,"height":100,
        "modelPreview":{"azimuth":0,"elevation":0.4,"distanceScale":1}
    }))
    .unwrap();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    let mut second = scene.nodes[0].clone();
    second.id = "b".into();
    scene.nodes.push(second);
    let mut world = world_with_resources();
    world.resource_mut::<ModelVisuals>().batching_strategy = BatchStrategy::Explicit;
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].entities.len(), 9);
    assert!(models.roots["a"].instance_parts.is_empty());
    assert_eq!(models.roots["a"].part_entities.len(), 8);
    for &entity in models.roots["a"].part_entities.values() {
        assert!(world.get::<Instances>(entity).is_none());
        assert!(world.get::<MeshMaterial3d<StandardMaterial>>(entity).is_some());
    }
    let mesh = models.roots["a"].mesh_handles[0].clone();
    assert_eq!(mesh, models.roots["b"].mesh_handles[0]);
    let budget: serde_json::Value = serde_json::from_str(&models.budget_json(
        world.resource::<Assets<Mesh>>(),
        world.resource::<Assets<StandardMaterial>>(),
    ))
    .unwrap();
    assert_eq!(budget["parts"], 16);
    assert_eq!(budget["uniqueMeshes"], 1);
    assert_eq!(budget["instanceTriangles"], 16 * 12);
    {
        let mut models = world.resource_mut::<ModelVisuals>();
        crate::model3d::demand::update(
            &mut models,
            &scene,
            None,
            &Default::default(),
            &Default::default(),
            0.,
        );
        let demand = models.demand.clone();
        let high = std::collections::HashSet::from(["a".into()]);
        assert!(crate::model3d::demand::update(
            &mut models,
            &scene,
            None,
            &high,
            &high,
            0.1
        ));
        assert_eq!(models.demand, demand);
    }
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert!(models.roots["a"].instance_parts.is_empty());
    assert_eq!(models.roots["a"].part_entities.len(), 8);
    assert!(models.roots["b"].instance_parts.is_empty());
    assert!(crate::model3d::demand::update(
        &mut world.resource_mut::<ModelVisuals>(),
        &scene,
        None,
        &Default::default(),
        &Default::default(),
        0.2
    ));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["a"].mesh_handles[0],
        mesh
    );
    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<Assets<Mesh>>().is_empty());
}

#[test]
fn explicit_fallback_playback_keeps_unique_parts_and_standard_materials() {
    use super::playback_representation::{fixture, playback};
    let (mut scene, resources) = fixture();
    scene.nodes[0].model_preview =
        serde_json::from_value(serde_json::json!({"azimuth":0,"elevation":0.4,"distanceScale":1}))
            .unwrap();
    let mut world = world_with_resources();
    world.resource_mut::<ModelVisuals>().batching_strategy = BatchStrategy::Explicit;
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    let affected = root.part_entities["p0"];
    let unaffected = root.part_entities["p1"];
    let anchor = root.entities[0];
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.entities[0], anchor);
    assert!(root.part_entities.contains_key("p0"));
    assert!(root.batches.is_empty());
    assert!(root.instance_parts.is_empty());
    assert_eq!(root.part_entities["p1"], unaffected);
    assert!(world.get::<Instances>(affected).is_none());
    assert!(world.get::<MeshMaterial3d<StandardMaterial>>(affected).is_some());
    let count = world.entities().len();
    scene.animation_playback = None;
    run_sync(&mut world, &scene, &resources);
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(world.entities().len(), count);
    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<Assets<Mesh>>().is_empty());
}
