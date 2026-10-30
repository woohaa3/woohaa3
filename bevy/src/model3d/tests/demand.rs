//! 只验证 ECS/资源生命周期，不启动渲染器。
use super::*;
use crate::model3d::{demand, runtime::ModelVisuals};

fn fixture(count: usize) -> (Scene, ModelAssets) {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2","signature":"demand-shot","extent":2,
        "ops":[{"t":"box","id":"part","size":[1,1,1],"color":"#ffffff"}]
    }))
    .unwrap();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = Scene::default();
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({"width":800,"height":600,"pixelRatio":1}))
            .unwrap(),
    );
    scene.viewport.zoom = 1.;
    for index in 0..count {
        let id = format!("film-{index}");
        let mut node: GraphNode = serde_json::from_value(
            serde_json::json!({"id":id,"type":"model","x":0,"y":0,"width":240,"height":195}),
        )
        .unwrap();
        node.model = Some(reference.clone());
        scene.nodes.push(node);
        let preview: GraphNode = serde_json::from_value(serde_json::json!({
            "id":format!("preview-{index}"),"type":"slot","x":0,"y":0,"width":240,"height":185
        })).unwrap();
        scene.nodes.push(with_preview_card(preview, serde_json::json!({
            "nodeId":format!("preview-{index}"),"ownerNodeId":id,"entityId":"clip","animated":true,"title":"镜头",
            "aspect":1.7777778,"duration":5,"state":"preparing",
            "coverCamera":{"azimuth":0,"elevation":0.7,"distance":8,"focusOffset":[0,0,0]}
        })));
    }
    (scene, resources)
}

fn update(world: &mut World, scene: &Scene, resources: &ModelAssets, now: f64) {
    demand::update(
        &mut world.resource_mut::<ModelVisuals>(),
        scene,
        None,
        &Default::default(),
        &Default::default(),
        now,
    );
    run_sync(world, scene, resources);
}

#[test]
fn visible_shot_card_retains_offscreen_source_root() {
    let (mut scene, resources) = fixture(1);
    scene.nodes[0].x = -10_000.;
    let mut world = world_with_resources();
    update(&mut world, &scene, &resources, 0.);
    let entities = world.resource::<ModelVisuals>().roots["film-0"]
        .entities
        .clone();
    update(&mut world, &scene, &resources, 30.);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film-0"].entities,
        entities
    );
}

#[test]
fn leaving_and_returning_reuses_root_then_expires() {
    let (mut scene, resources) = fixture(1);
    let mut world = world_with_resources();
    update(&mut world, &scene, &resources, 0.);
    let entities = world.resource::<ModelVisuals>().roots["film-0"]
        .entities
        .clone();
    scene.viewport.x = -10_000.;
    update(&mut world, &scene, &resources, 1.);
    update(&mut world, &scene, &resources, 5.);
    scene.viewport.x = 0.;
    update(&mut world, &scene, &resources, 6.);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film-0"].entities,
        entities
    );
    scene.viewport.x = -10_000.;
    update(&mut world, &scene, &resources, 7.);
    update(&mut world, &scene, &resources, 18.);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
    assert!(world.resource::<Assets<Mesh>>().is_empty());
    assert!(world.resource::<Assets<StandardMaterial>>().is_empty());
}

#[test]
fn offscreen_warm_roots_are_bounded_and_deletion_releases_immediately() {
    let (mut scene, resources) = fixture(10);
    let mut world = world_with_resources();
    update(&mut world, &scene, &resources, 0.);
    scene.viewport.x = -10_000.;
    update(&mut world, &scene, &resources, 1.);
    update(&mut world, &scene, &resources, 3.);
    assert_eq!(world.resource::<ModelVisuals>().roots.len(), 8);
    scene.nodes.clear();
    update(&mut world, &scene, &resources, 4.);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
}
