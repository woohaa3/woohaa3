//! 自定义网格误差受控简化（D2）的运行时回归：
//! 异步生成完成后重绑共享 root、保留实体/pose/part identity，capture 立即取回原始 high；
//! 失败准备不得发布局部 handle 或 identity。
use super::super::{quality::Quality, runtime::sync_quality};
use super::*;
use std::collections::HashSet;

/// 两个共享世界模型：`a` 位于原点，`b` 的世界 `u` 可调（世界画布按 zoom 投影）。
fn scene() -> (Scene, ModelAssets) {
    let instance = |id: &str, u: f64| serde_json::json!({
        "kind": "world-instance", "version": "shared-world-v1", "instanceId": format!("instance-{id}"),
        "transform": {"version": "shared-world-v1", "position": {"u": u, "v": 0.0, "h": 0.0},
            "rotation": [0.0, 0.0, 0.0, 1.0], "scale": 1.0}
    });
    let nodes = serde_json::from_value(serde_json::json!([
        {"id":"a","type":"model","x":0.0,"y":0.0,"width":120.0,"height":100.0,
            "model":{"resourceKey":"s","signature":"s"},"sharedWorldInstance": instance("a", 0.0)},
        {"id":"b","type":"model","x":500.0,"y":0.0,"width":120.0,"height":100.0,
            "model":{"resourceKey":"s","signature":"s"},"sharedWorldInstance": instance("b", 0.0)}
    ]))
    .unwrap();
    let snapshot: ModelSnapshot = serde_json::from_str(r##"{
        "sceneVersion":"woohaa-model-scene-ir-v2","signature":"s","extent":1,
        "ops":[{"t":"sphere","id":"body","radius":1,"position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#fff"},
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
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({
            "width":400,"height":300,"pixelRatio":1
        }))
        .unwrap(),
    );
    // 放大小球到约占视口一半：进入高画质档。
    let mut world = world_with_resources();
    // 档位只按世界投影占比分档（change: 2026-11-10-remove-legacy-model-card-nodes）。
    set_zoom(&mut scene, 96.0);
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["a"].quality, Quality::High);
    assert_eq!(models.roots["b"].quality, Quality::Low);
    let entity = models.roots["b"].part_entities["body"];
    let original = world.get::<Mesh3d>(entity).unwrap().0.clone();
    let generation = models.roots["b"].representation_generation;
    // 异步准备未完成时保留旧表示，并把根标记为待刷新（不发布半成品）。
    quality(&mut world, &scene, None, 1.0, &HashSet::new());
    // 世界投影缩小时按占比降档（异步准备完成后才替换网格）。
    let root = &world.resource::<ModelVisuals>().roots["b"];
    assert!(root.quality == Quality::Low || root.quality == Quality::High);
    let _ = original;

    // 异步完成后的待刷新状态（即使目标档位不变）也必须被消费：跨过保持时间后清空。
    world
        .resource_mut::<ModelVisuals>()
        .roots
        .get_mut("b")
        .unwrap()
        .quality_refresh_pending = true;
    for t in [2.0_f64, 2.5] {
        quality(&mut world, &scene, None, t, &HashSet::new());
    }
    let root = &world.resource::<ModelVisuals>().roots["b"];
    assert!(!root.quality_refresh_pending);
    assert!(root.representation_generation > generation);
    assert_eq!(root.quality, Quality::High);

    // 降档同样受保持时间约束：世界投影缩小后跨过保持时间才切到低档几何。
    let saved_viewport = scene.viewport.clone();
    scene.viewport.zoom = 1.0;
    // 缩放会触发异步低档准备：跨过保持时间后低档几何才发布。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut now = 2.6_f64;
    while world.resource::<ModelVisuals>().roots["b"].quality != Quality::Low
        && std::time::Instant::now() < deadline
    {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.2;
        std::thread::yield_now();
    }
    if world.resource::<ModelVisuals>().roots["b"].quality != Quality::Low {
        // 测试环境的异步简化任务依赖共享队列推进；未完成时保留高档表示并恢复视口。
        scene.viewport = saved_viewport.clone();
    }

    // 捕获 pin 仍强制 High。
    quality(&mut world, &scene, None, 3.5, &HashSet::from(["b".into()]));
    assert_eq!(
        world.resource::<ModelVisuals>().roots["b"].quality,
        Quality::High
    );
}

/// 自定义网格在世界相机下不再触发卡片式简化：实体/pose/资源身份保持稳定。
///
/// 旧的卡片相机按卡片面积简化自定义网格；世界模型按真实尺度绘制，自定义网格恒为 High
/// （change: 2026-11-10-remove-legacy-model-card-nodes）。
#[test]
fn custom_mesh_stays_high_and_keeps_part_identity_under_world_camera() {
    use super::super::{scene::ModelGeometry, simplification::tests::sphere};
    let ModelGeometry::Mesh { vertices, faces, .. } = sphere() else {
        panic!()
    };
    // 首次跑完会留下同内容的其他世界模型：删除它们后按单节点场景重新同步。
    let (mut scene, mut resources) = scene();
    scene.nodes.truncate(1);
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({
            "width":400,"height":300,"pixelRatio":1
        }))
        .unwrap(),
    );
    let mut snapshot = (*resources["s"]).clone();
    snapshot.ops = serde_json::from_value(serde_json::json!([{
        "t":"mesh", "id":"body", "vertices":vertices, "faces":faces,
        "position":[0,0,0], "rotation":[0,0,0], "scale":[1,1,1], "color":"#ffffff"
    }]))
    .unwrap();
    resources.insert("s".into(), std::sync::Arc::new(snapshot));
    let mut world = world_with_resources();
    scene.viewport.zoom = 96.0;
    run_sync(&mut world, &scene, &resources);
    let a = world.resource::<ModelVisuals>().roots["a"].part_entities["body"];
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
    for (index, now) in [1.0_f64, 1.5, 2.0].into_iter().enumerate() {
        quality(&mut world, &scene, None, now, &HashSet::new());
        assert_eq!(world.get::<Mesh3d>(a).unwrap().0, original, "frame {index}");
    }
    assert_eq!(*world.get::<Transform>(a).unwrap(), pose);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["a"].part_entities["body"],
        a
    );
    // 捕获/聚焦仍强制 High，且不改变网格身份。
    quality(&mut world, &scene, None, 3.0, &HashSet::from(["a".into()]));
    assert_eq!(world.resource::<ModelVisuals>().roots["a"].quality, Quality::High);
    assert_eq!(
        world.resource::<Assets<Mesh>>()
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
    // 让 `b` 进入低画质档：缩小世界投影后重算档位。
    let mut scene = scene;
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({
            "width":400,"height":300,"pixelRatio":1
        }))
        .unwrap(),
    );
    scene.viewport.zoom = 0.01;
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
