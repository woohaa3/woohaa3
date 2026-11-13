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
        super::with_world_instance(&mut node);
        node.model = Some(reference.clone());
        scene.nodes.push(node);
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

/// 共享世界模型没有卡片矩形，始终参与世界绘制：删除节点后根与资源立即释放，
/// 不会再出现「离屏一秒后按卡片矩形回收」（change: 2026-11-10-remove-legacy-model-card-nodes）。
#[test]
fn world_models_stay_resident_and_release_on_deletion() {
    let (mut scene, resources) = fixture(1);
    let mut world = world_with_resources();
    update(&mut world, &scene, &resources, 0.);
    let entities = world.resource::<ModelVisuals>().roots["film-0"]
        .entities
        .clone();
    scene.viewport.x = -10_000.;
    update(&mut world, &scene, &resources, 1.);
    update(&mut world, &scene, &resources, 5.);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film-0"].entities,
        entities,
        "世界模型不因卡片视口移出而回收"
    );
    scene.viewport.x = 0.;
    update(&mut world, &scene, &resources, 6.);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film-0"].entities,
        entities
    );
    scene.nodes.clear();
    update(&mut world, &scene, &resources, 7.);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
    assert!(world.resource::<Assets<Mesh>>().is_empty());
    assert!(world.resource::<Assets<StandardMaterial>>().is_empty());
}

/// 十个世界模型全部常驻；删除节点立即释放对应根。
#[test]
fn world_roots_are_not_bounded_by_card_viewport() {
    let (mut scene, resources) = fixture(10);
    let mut world = world_with_resources();
    update(&mut world, &scene, &resources, 0.);
    scene.viewport.x = -10_000.;
    update(&mut world, &scene, &resources, 1.);
    update(&mut world, &scene, &resources, 3.);
    assert_eq!(world.resource::<ModelVisuals>().roots.len(), 10);
    scene.nodes.clear();
    update(&mut world, &scene, &resources, 4.);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
}
