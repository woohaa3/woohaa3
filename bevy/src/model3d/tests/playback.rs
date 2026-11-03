//! hover/focus 模型动画播放门禁测试
//! （change: play-model-animations-on-hover，任务 1.3 / 2.1–2.3）。
//!
//! 覆盖动画实体记录与释放、none→A、A→B、非模型 hover、focus-over-hover、内容重建与
//! placement/base 更新下的播放状态。

use super::{reference_for, resource_table, run_sync, scene_with, world_with_resources};
use crate::model3d::animation::{TransformAnimation, TransformAnimationPlayback};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot, Scene};
use bevy::prelude::*;

fn model_node() -> GraphNode {
    GraphNode {
        chrome: crate::protocol::NodeChrome::Card,
        shared_world_instance: None,
        model_preview: None,
        id: "m".into(),
        kind: "model".into(),
        x: 0.0,
        y: 0.0,
        width: 224.0,
        height: 116.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        progress_started_at: None,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        model: None,
        history_strip: None,
    }
}

fn sphere_snapshot(signature: &str) -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Sphere {
            id: "joint".into(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            radius: 0.3,
        }],
        signature: signature.into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn animated_snapshot(signature: &str, scene_version: &str) -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(scene_version.to_owned()),
        ops: vec![
            ModelOp::Box {
                id: "body".into(),
                parent: None,
                position: [0.0; 3],
                rotation: [0.0; 3],
                scale: [1.0; 3],
                color: Some("#ffffff".into()),
                material: None,
                size: [1.0; 3],
            },
            ModelOp::Rotate {
                id: "body".into(),
                axis: "y".into(),
                speed: std::f32::consts::PI,
            },
        ],
        signature: signature.into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn hover_node(id: &str) -> crate::protocol::NodeHover {
    crate::protocol::NodeHover {
        node_id: Some(id.to_owned()),
        port: None,
        edge_id: None,
    }
}

fn focus_on(id: &str) -> crate::protocol::ModelFocus {
    crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: id.to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    }
}

fn playback_of(world: &World, node_id: &str) -> Vec<TransformAnimationPlayback> {
    let roots = &world
        .resource::<super::super::runtime::ModelVisuals>()
        .roots;
    let root = roots.get(node_id).expect("model root");
    root.animation_entities
        .iter()
        .map(|entity| {
            *world
                .entity(*entity)
                .get::<TransformAnimationPlayback>()
                .expect("playback component")
        })
        .collect()
}

fn active_model(world: &World) -> Option<String> {
    world
        .resource::<super::super::runtime::ModelVisuals>()
        .active_model
        .clone()
}

#[test]
fn hover_only_disables_overview_cache_for_animated_roots() {
    let mut world = world_with_resources();
    let node = model_node();
    for (snapshot, animated) in [(sphere_snapshot("static"), false), (animated_snapshot("animated", crate::protocol::MODEL_SCENE_IR_V2), true)] {
        let reference = reference_for(&snapshot, ModelPlacement::default());
        let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
        let mut scene = scene_with(&node, Some(reference));
        scene.hover = Some(hover_node("m"));
        run_sync(&mut world, &scene, &resources);
        let models = world.resource::<super::super::runtime::ModelVisuals>();
        assert!(models.is_active_model("m"));
        assert_eq!(models.is_active_animated_model("m"), animated);
    }
}

/// 记录动画实体并在 spawn 时默认 stopped/reset；释放后无陈旧引用。
#[test]
fn animated_model_records_and_releases_animation_entities() {
    let mut world = world_with_resources();
    let node = model_node();
    let snapshot = animated_snapshot("anim", crate::protocol::MODEL_SCENE_IR_V2);
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    run_sync(&mut world, &scene_with(&node, Some(reference)), &resources);

    let recorded = {
        let roots = &world
            .resource::<super::super::runtime::ModelVisuals>()
            .roots;
        roots.get("m").unwrap().animation_entities.clone()
    };
    assert_eq!(recorded.len(), 1, "一个 rotate 动画应记录一个实体");
    assert!(!playback_of(&world, "m")[0].active, "默认停止");
    assert_eq!(playback_of(&world, "m")[0].elapsed, 0.0);

    // 删除模型：记录被释放，不残留活动根。
    run_sync(&mut world, &scene_with(&node, None), &resources);
    assert!(
        world
            .resource::<super::super::runtime::ModelVisuals>()
            .roots
            .is_empty()
    );
    assert!(world.get_entity(recorded[0]).is_err(), "动画实体应随根销毁");
}

/// hover 进入从零激活；离开 stop/reset。
#[test]
fn hover_activates_then_leaving_stops_and_resets() {
    let mut world = world_with_resources();
    let node = model_node();
    let snapshot = animated_snapshot("anim", crate::protocol::MODEL_SCENE_IR_V2);
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);

    // 无 hover：不播放。
    let mut scene = scene_with(&node, Some(reference.clone()));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world), None);
    assert!(!playback_of(&world, "m")[0].active);

    // hover：从零点激活。
    scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world).as_deref(), Some("m"));
    let playback = playback_of(&world, "m");
    assert!(playback[0].active);
    assert_eq!(playback[0].elapsed, 0.0);

    // 离开：stop 并归零局部时间。
    scene.hover = None;
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world), None);
    let playback = playback_of(&world, "m");
    assert!(!playback[0].active);
    assert_eq!(playback[0].elapsed, 0.0);
}

/// A→B 原子切换：旧根停止、新根从零开始，任意时刻只有 B active。
#[test]
fn hovering_model_b_stops_model_a() {
    let mut world = world_with_resources();
    let node = |id: &str| {
        let mut node = model_node();
        node.id = id.to_owned();
        node
    };
    let snapshot = animated_snapshot("anim", crate::protocol::MODEL_SCENE_IR_V2);
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);

    let mut scene = Scene {
        nodes: vec![node("a"), node("b")],
        ..Scene::default()
    };
    for entry in &mut scene.nodes {
        entry.model = Some(reference.clone());
    }
    scene.hover = Some(hover_node("a"));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world).as_deref(), Some("a"));
    assert!(playback_of(&world, "a")[0].active);

    scene.hover = Some(hover_node("b"));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world).as_deref(), Some("b"));
    assert!(!playback_of(&world, "a")[0].active, "A 应停止");
    assert!(playback_of(&world, "b")[0].active, "B 应从零播放");
    assert_eq!(playback_of(&world, "b")[0].elapsed, 0.0);
}

/// hover 普通/无模型或无动画模型时不激活任何动画实体；门禁仍记录 hover 到的模型节点，
/// 以便该模型后续替换出动画内容时能从零开始（任务 2.3）。
#[test]
fn hover_without_animated_model_activates_nothing() {
    let mut world = world_with_resources();
    let node = model_node();
    // 无动画的球体模型。
    let snapshot = sphere_snapshot("plain");
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world).as_deref(), Some("m"));
    assert!(
        playback_of(&world, "m").is_empty(),
        "无动画模型没有可播放实体"
    );

    // hover 非模型节点：不激活任何模型。
    let mut plain_node = model_node();
    plain_node.model = None;
    let mut plain_scene = scene_with(&plain_node, None);
    plain_scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &plain_scene, &resources);
    assert_eq!(active_model(&world), None);
}

/// modelFocus 覆盖 hover：聚焦同帧停止动画，残留 hover 不重启。
#[test]
fn model_focus_overrides_hover() {
    let mut world = world_with_resources();
    let node = model_node();
    let snapshot = animated_snapshot("anim", crate::protocol::MODEL_SCENE_IR_V2);
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);

    let mut scene = scene_with(&node, Some(reference));
    scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &scene, &resources);
    assert!(playback_of(&world, "m")[0].active);

    // 进入聚焦：同一 scene 仍携带 hover，但门禁优先，必须停止。
    scene.model_focus = Some(focus_on("m"));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(active_model(&world), None);
    let playback = playback_of(&world, "m");
    assert!(!playback[0].active);
    assert_eq!(playback[0].elapsed, 0.0);

    // 聚焦期间重复同步不隐式重播。
    run_sync(&mut world, &scene, &resources);
    assert!(!playback_of(&world, "m")[0].active);
}

/// 内容重建时按当前门禁初始化：仍被合法 hover 则从零播放，否则保持停止。
#[test]
fn rebuilt_model_initializes_from_current_gate() {
    let mut world = world_with_resources();
    let node = model_node();
    let snapshot = animated_snapshot("anim-a", crate::protocol::MODEL_SCENE_IR_V2);
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &scene, &resources);
    assert!(playback_of(&world, "m")[0].active);

    // 内容 signature 变化触发重建：目标仍被合法 hover，应从零重新播放。
    let rebuilt = animated_snapshot("anim-b", crate::protocol::MODEL_SCENE_IR_V2);
    let rebuilt_reference = reference_for(&rebuilt, ModelPlacement::default());
    let rebuilt_resources = resource_table([(rebuilt_reference.resource_key.clone(), rebuilt)]);
    scene.nodes[0].model = Some(rebuilt_reference);
    run_sync(&mut world, &scene, &rebuilt_resources);
    let playback = playback_of(&world, "m");
    assert!(playback[0].active, "重建后仍 hover 应从零播放");
    assert_eq!(playback[0].elapsed, 0.0);

    // 无 hover 时重建：保持停止。
    let rebuilt_c = animated_snapshot("anim-c", crate::protocol::MODEL_SCENE_IR_V2);
    let reference_c = reference_for(&rebuilt_c, ModelPlacement::default());
    let resources_c = resource_table([(reference_c.resource_key.clone(), rebuilt_c)]);
    let mut no_hover = scene_with(&node, Some(reference_c));
    no_hover.hover = None;
    run_sync(&mut world, &no_hover, &resources_c);
    assert!(!playback_of(&world, "m")[0].active);
}

/// placement 变化保留 active 状态（V2 局部 base 不随根位移改变）。
#[test]
fn placement_update_preserves_active_playback() {
    let mut world = world_with_resources();
    let node = model_node();
    let snapshot = animated_snapshot("anim", crate::protocol::MODEL_SCENE_IR_V2);
    let base = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(base.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(base.clone()));
    scene.hover = Some(hover_node("m"));
    run_sync(&mut world, &scene, &resources);
    assert!(playback_of(&world, "m")[0].active);

    let mut moved = base.clone();
    moved.placement = ModelPlacement {
        offset: crate::protocol::ModelOffset {
            x: 3.0,
            y: 0.0,
            z: 0.0,
        },
        scale: 2.0,
        yaw: 0.3,
    };
    scene.nodes[0].model = Some(moved);
    run_sync(&mut world, &scene, &resources);
    assert!(
        playback_of(&world, "m")[0].active,
        "placement 预览不应打断播放"
    );
}
