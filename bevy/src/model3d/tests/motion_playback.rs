//! 活动动画节点运动求值测试
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。

use super::{reference_for, resource_table, run_sync, scene_with, world_with_resources};
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
        target_preview_node_id: None,
        node_id: "anim".into(),
        version: crate::motion::MOTION_IR_VERSION.into(),
        time: 1.0,
        duration: 4.0,
        looped: false,
        playing: true,
        initial_camera: PlaybackCamera {
            aspect: "16:9".into(),
            azimuth: 0.0,
            elevation: std::f32::consts::FRAC_PI_4,
            distance: 8.0,
            focus_offset: [0.0; 3],
        },
        camera_motion: vec![],
        objects: vec![],
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
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut commands = world.commands();
    let camera = apply_motion_playback(&mut commands, &mut visuals, scene);
    world.flush();
    world.insert_resource(visuals);
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
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut commands = world.commands();
    let camera = apply_motion_playback(&mut commands, &mut visuals, scene);
    world.flush();
    world.insert_resource(visuals);
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
fn object_root_tracks_map_to_one_entity_and_preserve_geometry_on_seek() {
    let snapshot = rig_snapshot();
    let resources = resource_table([("woohaa-model-scene-ir-v2:sig-anim".to_owned(), snapshot)]);
    let mut world = world_with_resources();
    run_sync(&mut world, &base_scene_no_playback(), &resources);
    let entity = entity_of(&world, "body");
    let base = *world.entity(entity).get::<Transform>().unwrap();
    let count = world.entities().len();
    let ir: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/parkour-motion.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut scene = base_scene();
    let playback = scene.animation_playback.as_mut().unwrap();
    playback.model_motion.clear();
    playback.duration = 12.0;
    playback.time = 8.0;
    playback.objects = vec![
        serde_json::from_value(serde_json::json!({
            "itemId":"hero", "playback":{"startTime":0,"duration":8,"timeScale":1,"loop":false},
            "partIds":{"root":"body"}, "modelMotion":ir["modelMotion"]
        }))
        .unwrap(),
    ];
    run_motion(&mut world, &scene);
    let at_landing = *world.entity(entity).get::<Transform>().unwrap();
    assert_eq!(
        at_landing.translation,
        base.translation + Vec3::new(16.0, 3.0, 0.0)
    );
    assert!(
        at_landing
            .rotation
            .abs_diff_eq(base.rotation * Quat::from_rotation_y(1.57), 1e-5)
    );
    scene.animation_playback.as_mut().unwrap().time = 12.0;
    run_motion(&mut world, &scene);
    assert_eq!(
        world.entity(entity).get::<Transform>().unwrap().translation,
        at_landing.translation
    );
    scene.animation_playback.as_mut().unwrap().time = 0.0;
    run_motion(&mut world, &scene);
    assert_eq!(
        world.entity(entity).get::<Transform>().unwrap().translation,
        base.translation
    );
    assert_eq!(entity_of(&world, "body"), entity);
    assert_eq!(world.entities().len(), count);
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
