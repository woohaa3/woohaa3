//! 活动动画节点运动求值测试
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。

use super::{
    opacity_instances, reference_for, resource_table, run_sync, scene_with, world_with_resources,
};
use crate::model3d::runtime::{ModelVisuals, apply_motion_playback};
use crate::protocol::{
    AnimationPlayback, GraphNode, ModelOp, ModelPlacement, ModelSnapshot, PlaybackCamera, Scene,
};
use bevy::prelude::*;

fn model_node() -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id":"anim", "type":"model", "x":0, "y":0, "width":224, "height":116
    }))
    .unwrap()
}

fn rig_snapshot() -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![
            ModelOp::Group {
                id: "root".into(),
                parent: None,
                position: [0.0; 3],
                rotation: [0.0; 3],
                scale: [1.0; 3],
            },
            ModelOp::Box {
                id: "body".into(),
                parent: Some("root".into()),
                position: [0.0; 3],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                size: [1.0; 3],
            },
            ModelOp::Box {
                id: "hand".into(),
                parent: Some("root".into()),
                position: [0.0; 3],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                size: [0.3; 3],
            },
        ],
        signature: "sig-anim".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn base_scene() -> Scene {
    let snapshot = rig_snapshot();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let mut scene = scene_with(&model_node(), Some(reference));
    scene.animation_playback = Some(AnimationPlayback {
        clip_id: "test-clip".into(),
        source_identity: "test".into(),
        generation: 1,
        view_mode: "overview-observer".into(),
        node_id: "anim".into(),
        version: crate::motion::MOTION_IR_VERSION.into(),
        time: 1.0,
        duration: 4.0,
        looped: false,
        backdrop: None,
        playing: true,
        initial_camera: PlaybackCamera {
            aspect: "16:9".into(),
            azimuth: 0.0,
            elevation: std::f32::consts::FRAC_PI_4,
            distance: 8.0,
            focus_offset: [0.0; 3],
        },
        camera_motion: vec![],
        model_motion: vec![crate::motion::RawModelTrack {
            target_id: "body".into(),
            start_time: Some(0.0),
            end_time: Some(4.0),
            motion: crate::motion::RawModelMotion {
                kind: "rotate".into(),
                axis: Some("y".into()),
                speed: Some(1.0),
                range: None,
                mode: None,
                amplitude: None,
                phase: None,
                ..Default::default()
            },
        }],
    });
    scene
}

fn entity_of(world: &World, part: &str) -> Entity {
    *world
        .resource::<ModelVisuals>()
        .roots
        .get("anim")
        .expect("root")
        .part_entities
        .get(part)
        .expect("part entity")
}

fn run_motion(world: &mut World, scene: &Scene) {
    let instances = opacity_instances(world);
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut materials = world
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap_or_default();
    let mut commands = world.commands();
    let camera = apply_motion_playback(&mut commands, &mut visuals, &mut materials, &instances, scene);
    world.flush();
    world.insert_resource(visuals);
    world.insert_resource(materials);
    assert!(camera.is_some());
}

#[test]
fn motion_rotates_only_the_targeted_part() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);

    let hand_before = *world
        .entity(entity_of(&world, "hand"))
        .get::<Transform>()
        .unwrap();

    run_motion(&mut world, &base_scene());

    let body_after = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    let hand_after = *world
        .entity(entity_of(&world, "hand"))
        .get::<Transform>()
        .unwrap();

    // body 旋转 1 秒 × 1 rad/s；四元数 Y 分量 ≈ sin(0.5)。
    assert!((body_after.rotation.y - 0.5f32.sin()).abs() < 1e-4);
    assert!((body_after.rotation.w - 0.5f32.cos()).abs() < 1e-4);
    // hand 未声明运动，保持基础姿态。
    assert!((hand_after.rotation.y - hand_before.rotation.y).abs() < 1e-6);
}

#[test]
fn leaving_animation_node_restores_base_pose() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let body_before = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();

    run_motion(&mut world, &base_scene());

    // 清除动画投影（选中其它节点/无活动动画节点）。
    let cleared = base_scene_no_playback();
    run_motion_expect_none(&mut world, &cleared);
    let body_restored = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    assert!((body_restored.rotation.y - body_before.rotation.y).abs() < 1e-6);
    assert!((body_restored.rotation.w - body_before.rotation.w).abs() < 1e-6);
}

fn run_motion_expect_none(world: &mut World, scene: &Scene) {
    let instances = opacity_instances(world);
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut materials = world
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap_or_default();
    let mut commands = world.commands();
    let camera = apply_motion_playback(&mut commands, &mut visuals, &mut materials, &instances, scene);
    world.flush();
    world.insert_resource(visuals);
    world.insert_resource(materials);
    assert!(camera.is_none());
}

/// 无动画投影的场景（仅模型引用），用于初始化/清除。
fn base_scene_no_playback() -> Scene {
    let mut scene = base_scene();
    scene.animation_playback = None;
    scene
}

#[test]
fn seeking_before_motion_start_restores_base_instead_of_previous_frame() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let base = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    let mut scene = base_scene();
    let playback = scene.animation_playback.as_mut().unwrap();
    playback.model_motion[0].start_time = Some(1.0);
    playback.time = 3.0;
    run_motion(&mut world, &scene);
    scene.animation_playback.as_mut().unwrap().time = 0.0;
    run_motion(&mut world, &scene);
    let restored = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    assert!(restored.rotation.abs_diff_eq(base.rotation, 1e-6));
    assert_eq!(restored.translation, base.translation);
}


#[test]
fn removing_motion_on_same_node_restores_previous_targets() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let base = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    let mut scene = base_scene();
    run_motion(&mut world, &scene);
    scene
        .animation_playback
        .as_mut()
        .unwrap()
        .model_motion
        .clear();
    run_motion(&mut world, &scene);
    let restored = *world
        .entity(entity_of(&world, "body"))
        .get::<Transform>()
        .unwrap();
    assert!(restored.rotation.abs_diff_eq(base.rotation, 1e-6));
}

#[test]
fn switching_clip_resets_properties_absent_from_the_new_clip() {
    let resources = resource_table([(
        "woohaa-model-scene-ir-v2:sig-anim".to_owned(),
        rig_snapshot(),
    )]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let entity = entity_of(&world, "body");
    let base = *world.entity(entity).get::<Transform>().unwrap();
    let mut scene = base_scene();
    let playback = scene.animation_playback.as_mut().unwrap();
    playback.model_motion = [
        ("position", [3.0, 4.0, 5.0]),
        ("rotation", [0.0, 1.0, 0.0]),
        ("scale", [2.0, 2.0, 2.0]),
    ]
    .into_iter()
    .map(|(property, value)| {
        serde_json::from_value(serde_json::json!({
        "id":property,"targetId":"body","startTime":0,"endTime":2,
        "motion":{"kind":"keyframes","property":property,"frames":[
            {"time":0,"value":value,"easing":"linear"}, {"time":2,"value":value,"easing":"linear"}
        ]}
    })).unwrap()
    })
    .collect();
    run_motion(&mut world, &scene);
    let moved = *world.entity(entity).get::<Transform>().unwrap();
    assert_ne!(moved.translation, base.translation);
    assert_ne!(moved.scale, base.scale);
    let playback = scene.animation_playback.as_mut().unwrap();
    playback.clip_id = "rotation-only".into();
    playback.generation += 1;
    playback.model_motion = vec![playback.model_motion[1].clone()];
    run_motion(&mut world, &scene);
    let changed = *world.entity(entity).get::<Transform>().unwrap();
    assert_eq!(changed.translation, base.translation);
    assert_eq!(changed.scale, base.scale);
    assert!(changed.rotation.abs_diff_eq(moved.rotation, 1e-6));
    assert_eq!(entity_of(&world, "body"), entity);
}

/// 透明度动作：目标部件获得专属材质实例、透明度为 0 时隐藏，回到 1 时写回共享材质
/// （change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
#[test]
fn opacity_track_uses_a_material_instance_and_restores_the_shared_material() {
    let resources = resource_table([(
        "woohaa-model-scene-ir-v2:sig-anim".to_owned(),
        rig_snapshot(),
    )]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let entity = entity_of(&world, "body");
    let shared = world
        .entity(entity)
        .get::<MeshMaterial3d<StandardMaterial>>()
        .expect("shared material")
        .0
        .clone();

    let mut scene = base_scene();
    let playback = scene.animation_playback.as_mut().unwrap();
    playback.model_motion = vec![
        serde_json::from_value(serde_json::json!({
            "targetId":"body","startTime":0,"endTime":2,
            "motion":{"kind":"keyframes","property":"opacity","frames":[
                {"time":0,"value":0,"easing":"linear"},
                {"time":2,"value":1,"easing":"linear"}
            ]}
        }))
        .unwrap(),
    ];
    run_motion(&mut world, &scene);

    // 半透明：材质被换成专属实例，共享材质仍按原样存在。
    let instance = world
        .entity(entity)
        .get::<MeshMaterial3d<StandardMaterial>>()
        .expect("instance material")
        .0
        .clone();
    assert_ne!(instance, shared, "局部目标必须获得专属材质实例");
    let record = world
        .entity(entity)
        .get::<crate::canvas_ecs::components::OpacityMaterialInstance>()
        .expect("实例状态在实体组件上");
    assert_eq!(record.instance, instance, "组件记录当前实例");
    assert_eq!(record.original, shared, "组件记录原共享材质");
    let instance_alpha = world
        .resource::<Assets<StandardMaterial>>()
        .get(&instance)
        .expect("instance asset")
        .base_color
        .alpha();
    assert!(
        instance_alpha < 1.0,
        "opacity 应写入实例 alpha，实际 {instance_alpha}"
    );
    assert_eq!(
        world
            .resource::<Assets<StandardMaterial>>()
            .get(&shared)
            .expect("shared asset")
            .base_color
            .alpha(),
        1.0,
        "共享材质不得被就地改写"
    );
    // 半透明不等于隐藏：不要因透明度动作改变可见性。
    assert_ne!(
        world.entity(entity).get::<Visibility>().copied(),
        Some(Visibility::Hidden)
    );

    // 终值 1：写回原共享材质、保持可见。
    scene.animation_playback.as_mut().unwrap().time = 2.0;
    run_motion(&mut world, &scene);
    assert_eq!(
        world
            .entity(entity)
            .get::<MeshMaterial3d<StandardMaterial>>()
            .expect("restored")
            .0,
        shared
    );
    let restored = world
        .entity(entity)
        .get::<crate::canvas_ecs::components::OpacityMaterialInstance>()
        .expect("恢复后仍保留实例归属");
    assert!(!restored.hidden, "恢复后组件不得继续标记隐藏");
    assert_ne!(
        world.entity(entity).get::<Visibility>().copied(),
        Some(Visibility::Hidden)
    );
}

/// 透明度 0：部件不可见且不参与绘制。
#[test]
fn zero_opacity_hides_the_part() {
    let resources = resource_table([(
        "woohaa-model-scene-ir-v2:sig-anim".to_owned(),
        rig_snapshot(),
    )]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let entity = entity_of(&world, "body");
    let mut scene = base_scene();
    scene.animation_playback.as_mut().unwrap().model_motion = vec![
        serde_json::from_value(serde_json::json!({
            "targetId":"body","startTime":0,"endTime":2,
            "motion":{"kind":"keyframes","property":"opacity","frames":[
                {"time":0,"value":0,"easing":"linear"},
                {"time":2,"value":0,"easing":"linear"}
            ]}
        }))
        .unwrap(),
    ];
    run_motion(&mut world, &scene);
    assert_eq!(
        world.entity(entity).get::<Visibility>().copied(),
        Some(Visibility::Hidden)
    );
}

/// 对象根透明度：该对象名下全部块同步淡出，实体与 mesh handle 不变（不拆合并块）。

/// 反复播放不增长透明度材质实例；根释放时实例从材质资产中回收（D2 / 任务 2.6）。
#[test]
fn opacity_material_instances_are_reused_and_released_with_the_root() {
    let resources = resource_table([(
        "woohaa-model-scene-ir-v2:sig-anim".to_owned(),
        rig_snapshot(),
    )]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let baseline = world.resource::<Assets<StandardMaterial>>().len();

    let mut scene = base_scene();
    scene.animation_playback.as_mut().unwrap().model_motion = vec![
        serde_json::from_value(serde_json::json!({
            "targetId":"body","startTime":0,"endTime":2,
            "motion":{"kind":"keyframes","property":"opacity","frames":[
                {"time":0,"value":0.2,"easing":"linear"},
                {"time":2,"value":0.8,"easing":"linear"}
            ]}
        }))
        .unwrap(),
    ];
    // 跨多帧反复 seek：同一实体只应持有一份实例。
    for step in 0..12 {
        scene.animation_playback.as_mut().unwrap().time = 0.2 + (step % 6) as f32 * 0.3;
        run_motion(&mut world, &scene);
    }
    let playing = world.resource::<Assets<StandardMaterial>>().len();
    assert_eq!(
        playing,
        baseline + 1,
        "同一实体的透明度实例必须复用，不得逐帧增长"
    );
    assert_eq!(
        world.resource::<ModelVisuals>().roots["anim"].opacity.len(),
        1,
        "透明度实例表只应有该目标的唯一实例"
    );

    let root = world.resource::<ModelVisuals>().roots["anim"]
        .entities
        .clone();
    run_sync(&mut world, &Scene::default(), &resources);
    let released = world.resource::<Assets<StandardMaterial>>().len();
    assert_eq!(released, 0, "根释放后克隆实例必须从材质资产中回收");
    for entity in root {
        assert!(world.get_entity(entity).is_err(), "根实体应已销毁");
    }
}

#[test]
fn part_rotations_preserve_hierarchy_instances_and_reset_without_rebuilding() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut scene = base_scene();
    let q = Quat::from_rotation_z(0.7);
    scene.nodes[0].model.as_mut().unwrap().part_rotations = Some(std::collections::HashMap::from([("root".into(), q.to_array())]));
    let mut other = scene.nodes[0].clone();
    other.id = "other".into();
    other.model.as_mut().unwrap().part_rotations = Some(Default::default());
    scene.nodes.push(other);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let parent = entity_of(&world, "root");
    let child = entity_of(&world, "hand");
    run_motion(&mut world, &scene);
    assert!(world.get::<Transform>(parent).unwrap().rotation.abs_diff_eq(q, 1e-5));
    assert_eq!(world.get::<ChildOf>(child).unwrap().parent(), parent);
    let models = world.resource::<ModelVisuals>();
    let other_parent = models.roots["other"].part_entities["root"];
    assert!(world.get::<Transform>(other_parent).unwrap().rotation.abs_diff_eq(Quat::IDENTITY, 1e-5));
    assert!(!models.roots["anim"].batched);
    scene.nodes[0].model.as_mut().unwrap().part_rotations = Some(Default::default());
    run_sync(&mut world, &scene, &resources);
    run_motion(&mut world, &scene);
    assert_eq!(entity_of(&world, "root"), parent);
    assert!(world.get::<Transform>(parent).unwrap().rotation.abs_diff_eq(Quat::IDENTITY, 1e-5));
    assert!((world.get::<Transform>(entity_of(&world, "body")).unwrap().rotation.y - 0.5_f32.sin()).abs() < 1e-4);
}

#[test]
fn part_positions_reset_from_base_each_sample_and_on_removal() {
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), rig_snapshot())]);
    let mut scene = base_scene();
    scene.nodes[0].model.as_mut().unwrap().part_positions = Some(std::collections::HashMap::from([("root".into(), [0.0, 0.2, 0.0])]));
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let root = entity_of(&world, "root");
    let base = world.get::<Transform>(root).unwrap().translation;
    run_motion(&mut world, &scene);
    run_motion(&mut world, &scene);
    assert!(world.get::<Transform>(root).unwrap().translation.abs_diff_eq(base + Vec3::Y * 0.2, 1e-5));
    scene.nodes[0].model.as_mut().unwrap().part_positions = None;
    run_motion(&mut world, &scene);
    assert!(world.get::<Transform>(root).unwrap().translation.abs_diff_eq(base, 1e-5));
}
