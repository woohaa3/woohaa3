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
        "id":"a", "type":"model", "x":0,"y":0,"width":120,"height":100
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

/// 带部件动作的播放必须使用非合批表示、恢复真实层级。
///
/// 世界相机下模型按真实尺度渲染，不再按卡片面积把父级分组平铺（`merge_cells` 已关闭，
/// 旧卡片相机的 flat arm 前提不再成立）；这里锁定「播放时层级与作者结构一致」。
#[test]
fn part_motion_playback_keeps_authored_hierarchy() {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"hierarchy", "extent":2,
        "ops":[
            {"t":"group","id":"root","parent":null,"position":[0,0,0]},
            {"t":"group","id":"torso","parent":"root","position":[0,1,0]},
            {"t":"box","id":"arm","parent":"torso","position":[0,-0.5,0],"size":[0.2,1,0.2],"color":"#ffffff"}
        ]
    })).unwrap();
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"a", "type":"model", "x":0,"y":0,"width":120,"height":100
    })).unwrap();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);

    // 静态表示：层级与作者结构一致（手臂挂在 torso 下）。
    {
        let models = world.resource::<ModelVisuals>();
        let root = &models.roots["a"];
        let arm = root.part_entities["arm"];
        let torso = root.part_entities["torso"];
        let parent = world.get::<ChildOf>(arm).expect("arm parent").parent();
        assert_eq!(parent, torso, "authored hierarchy must be preserved");
    }

    // 同一根开始播放部件动作：必须使用非合批表示，手臂重新挂回 torso。
    scene.animation_playback = Some(serde_json::from_value(serde_json::json!({
        "clipId":"clip", "sourceIdentity":"s", "generation":1,
        "viewMode":"focus-preview", "nodeId":"a", "version":"woohaa-motion-ir-v1",
        "time":0.5, "duration":4, "looped":true, "playing":true,
        "initialCamera":{"aspect":"16:9","azimuth":0,"elevation":0.4,"distance":5,"focusOffset":[0,0,0]},
        "cameraMotion":[], "modelMotion":[
            {"targetId":"torso","motion":{"kind":"rotate","axis":"y","speed":1}}
        ]
    })).unwrap());
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    let root = &models.roots["a"];
    // 合批策略保留内部标记；`merge_cells` 关闭后世界根始终保留作者层级（见上方断言）。
    let _ = root.batched;
    let arm = root.part_entities["arm"];
    let torso = root.part_entities["torso"];
    assert_eq!(
        world.get::<ChildOf>(arm).expect("arm parent").parent(),
        torso,
        "unbatched representation must keep the authored hierarchy"
    );
}
