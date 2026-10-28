//! 自定义网格误差受控简化（D2）的运行时回归：
//! 异步生成完成后重绑共享 root、保留实体/pose/part identity，capture 立即取回原始 high；
//! 失败准备不得发布局部 handle 或 identity。
use super::super::{quality::Quality, runtime::sync_quality};
use super::*;
use std::collections::HashSet;

fn scene() -> (Scene, ModelAssets) {
    let nodes = serde_json::from_str(r#"[
        {"id":"a","type":"model","x":0,"y":0,"width":120,"height":100,"model":{"resourceKey":"s","signature":"s"},"modelPreview":{"azimuth":0,"elevation":0.4,"distanceScale":1}},
        {"id":"b","type":"model","x":500,"y":0,"width":120,"height":100,"model":{"resourceKey":"s","signature":"s"},"modelPreview":{"azimuth":0,"elevation":0.4,"distanceScale":1}}
    ]"#).unwrap();
    let snapshot: ModelSnapshot = serde_json::from_str(r##"{
        "sceneVersion":"woohaa-model-scene-ir-v2","signature":"s","extent":1,
        "ops":[{"t":"sphere","id":"body","radius":1,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#fff"},
        {"t":"rotate","id":"body","axis":"y","speed":1}]
    }"##).unwrap();
    (
        Scene { nodes, ..default() },
        resource_table([("s".into(), snapshot)]),
    )
}
fn quality(
    world: &mut World,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &HashSet<String>,
) {
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    sync_quality(
        &mut world.commands(),
        &mut meshes,
        &mut models,
        scene,
        focus,
        now,
        pins,
    );
    world.flush();
    world.insert_resource(meshes);
    world.insert_resource(models);
}

#[test]
fn invisible_prewarm_stays_low_until_visible_but_capture_pins_high() {
    let set_zoom = |scene: &mut Scene, zoom: f32| {
        scene.viewport.zoom = zoom;
        scene.viewport.x = -16.0 * zoom;
        scene.viewport.y = -52.0 * zoom;
    };
    let (mut scene, resources) = scene();
    scene.surface = Some(serde_json::from_value(serde_json::json!({
        "width":400,"height":300,"pixelRatio":1
    })).unwrap());
    set_zoom(&mut scene, 32.0);
    scene.nodes[1].x = 25.0; // Offscreen content, still inside the demand/prewarm margin.
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].quality, Quality::High);
    assert_eq!(models.roots["b"].quality, Quality::Low);
    let entity = models.roots["b"].part_entities["body"];
    let original = world.get::<Mesh3d>(entity).unwrap().0.clone();
    let generation = models.roots["b"].representation_generation;
    quality(&mut world, &scene, None, 1.0, &HashSet::new());
    assert_eq!(world.resource::<ModelVisuals>().roots["b"].quality, Quality::Low);
    assert_eq!(world.resource::<ModelVisuals>().roots["b"].representation_generation, generation);
    assert_eq!(world.get::<Mesh3d>(entity).unwrap().0, original);

    // A completion recorded while invisible must be applied on re-entry even
    // if the desired quality stays Low (no threshold transition to wake it).
    world.resource_mut::<ModelVisuals>().roots.get_mut("b").unwrap().quality_refresh_pending = true;
    quality(&mut world, &scene, None, 1.1, &HashSet::new());
    assert!(world.resource::<ModelVisuals>().roots["b"].quality_refresh_pending);
    set_zoom(&mut scene, 1.0);
    quality(&mut world, &scene, None, 2.0, &HashSet::new());
    let root = &world.resource::<ModelVisuals>().roots["b"];
    assert_eq!(root.quality, Quality::Low);
    assert!(!root.quality_refresh_pending);
    assert!(root.representation_generation > generation);

    set_zoom(&mut scene, 32.0);
    scene.nodes[1].x = 10.0;
    quality(&mut world, &scene, None, 3.0, &HashSet::new());
    assert_eq!(world.resource::<ModelVisuals>().roots["b"].quality, Quality::High);
    scene.nodes[1].x = 25.0;
    set_zoom(&mut scene, 1.0);
    quality(&mut world, &scene, None, 4.0, &HashSet::new());
    assert_eq!(world.resource::<ModelVisuals>().roots["b"].quality, Quality::Low);
    set_zoom(&mut scene, 32.0);
    quality(&mut world, &scene, None, 5.0, &HashSet::from(["b".into()]));
    assert_eq!(world.resource::<ModelVisuals>().roots["b"].quality, Quality::High);
}

#[test]
fn asynchronous_custom_lod_rebinds_shared_roots_without_changing_ids_or_capture_high() {
    use super::super::{scene::ModelGeometry, simplification::tests::sphere};
    let ModelGeometry::Mesh { vertices, faces, .. } = sphere() else {
        panic!()
    };
    let (mut scene, mut resources) = scene();
    scene.surface = Some(serde_json::from_value(serde_json::json!({
        "width":400,"height":300,"pixelRatio":1
    })).unwrap());
    let mut snapshot = (*resources["s"]).clone();
    snapshot.ops = serde_json::from_value(serde_json::json!([{
        "t":"mesh", "id":"body", "vertices":vertices, "faces":faces,
        "position":[0,0,0], "rotation":[0,0,0], "scale":[1,1,1], "color":"#ffffff"
    }]))
    .unwrap();
    resources.insert("s".into(), std::sync::Arc::new(snapshot));
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let a = world.resource::<ModelVisuals>().roots["a"].part_entities["body"];
    let b = world.resource::<ModelVisuals>().roots["b"].part_entities["body"];
    let original = world.get::<Mesh3d>(a).unwrap().0.clone();
    let original_triangles = world
        .resource::<Assets<Mesh>>()
        .get(&original)
        .unwrap()
        .indices()
        .unwrap()
        .len()
        / 3;
    let pose = Transform::from_xyz(3., 4., 5.);
    world.entity_mut(a).insert(pose);
    let start = std::time::Instant::now();
    loop {
        quality(&mut world, &scene, None, 1., &HashSet::new());
        if world.get::<Mesh3d>(a).unwrap().0 != original {
            break;
        }
        assert!(
            start.elapsed().as_secs_f64() < 3.,
            "custom LOD task did not settle"
        );
        std::thread::yield_now();
    }
    let low = world.get::<Mesh3d>(a).unwrap().0.clone();
    // The shared completion arrives while b is offscreen. Keep its old mesh,
    // then consume the completion when it enters the viewport on a later frame.
    assert_eq!(world.get::<Mesh3d>(b).unwrap().0, original);
    assert!(world.resource::<ModelVisuals>().roots["b"].quality_refresh_pending);
    scene.nodes[1].x = 200.0;
    quality(&mut world, &scene, None, 1.005, &HashSet::new());
    assert_eq!(world.get::<Mesh3d>(b).unwrap().0, low);
    assert_eq!(*world.get::<Transform>(a).unwrap(), pose);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["a"].part_entities["body"],
        a
    );
    assert!(
        world
            .resource::<Assets<Mesh>>()
            .get(&low)
            .unwrap()
            .indices()
            .unwrap()
            .len()
            / 3
            <= original_triangles / 2
    );
    assert!(world.resource::<ModelVisuals>().roots["a"].representation_generation > 0);
    quality(&mut world, &scene, None, 1.01, &HashSet::from(["a".into()]));
    assert_eq!(world.get::<Mesh3d>(a).unwrap().0, original);
    assert_eq!(world.get::<Mesh3d>(b).unwrap().0, low);
    assert_eq!(
        world
            .resource::<Assets<Mesh>>()
            .get(&original)
            .unwrap()
            .indices()
            .unwrap()
            .len()
            / 3,
        original_triangles
    );
}

#[test]
fn failed_quality_preparation_does_not_publish_partial_handles_or_identity() {
    use super::super::scene::ModelGeometry;
    let (scene, resources) = scene();
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    quality(&mut world, &scene, Some("a"), 0., &HashSet::new());
    let body = world.resource::<ModelVisuals>().roots["a"].part_entities["body"];
    let original = world.get::<Mesh3d>(body).unwrap().0.clone();
    let invalid = world
        .spawn((Transform::default(), Mesh3d(original.clone())))
        .id();
    let generation = {
        let mut models = world.resource_mut::<ModelVisuals>();
        let root = models.roots.get_mut("a").unwrap();
        root.geometries.push((
            invalid,
            "invalid-test-source".into(),
            std::sync::Arc::new(ModelGeometry::Sphere { radius: 0. }),
        ));
        root.representation_generation
    };
    quality(&mut world, &scene, None, 1., &HashSet::new());
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].quality, Quality::High);
    assert_eq!(models.roots["a"].representation_generation, generation);
    assert_eq!(world.get::<Mesh3d>(body).unwrap().0, original);
    assert_eq!(world.get::<Mesh3d>(invalid).unwrap().0, original);
    assert_eq!(models.roots["b"].quality, Quality::Low);
}
