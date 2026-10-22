//! Critical representation ownership checks; browser visuals are accepted separately.
use super::*;

#[test]
fn static_batches_share_assets_restore_for_focus_and_reuse_after_exit() {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"batch", "extent":4,
        "ops": (0..8).map(|i| serde_json::json!({
            "t":"box", "id":format!("p{i}"), "size":[1,1,1],
            "position":[i,0,0], "color":"#ffffff"
        })).collect::<Vec<_>>()
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
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].batches.len(), 1);
    assert_eq!(models.roots["a"].entities.len(), 2);
    assert_eq!(models.roots["a"].batches[0].asset.ranges.len(), 8);
    let shared = models.roots["a"].batches[0].asset.handle.clone();
    assert_eq!(shared, models.roots["b"].batches[0].asset.handle);
    scene.model_focus = serde_json::from_value(serde_json::json!({
        "nodeId":"a", "target":[0,0,0],"yaw":0,"pitch":0.4,"distance":10,"fov":45
    }))
    .unwrap();
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert!(models.roots["a"].batches.is_empty());
    assert_eq!(models.roots["a"].part_entities.len(), 8);
    assert_eq!(models.roots["b"].batches[0].asset.handle, shared);
    scene.model_focus = None;
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].batches[0].asset.handle, shared);
    assert!(models.roots["a"].representation_generation >= 2);
    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<Assets<Mesh>>().is_empty());
}
