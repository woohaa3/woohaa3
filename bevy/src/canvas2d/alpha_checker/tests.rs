//! 透明棋盘格回归：只在媒体聚焦时存在，且铺在聚焦素材的同一块世界矩形上。
//!
//! 回归背景（2026-10-24 审片 A5）：节点文档的透明区域曾直接露出应用网格背景，
//! 看起来像「矢量蒙版把整层藏了」。棋盘格必须是聚焦素材正下方的一层真实几何。

use bevy::ecs::system::RunSystemOnce;
use bevy::prelude::*;

use super::*;
use crate::app::{CurrentScene, FrameFlags};
use crate::protocol::Scene;

fn world() -> World {
    let mut world = World::new();
    world.insert_resource(Assets::<Image>::default());
    world.insert_resource(FrameFlags::default());
    world.init_resource::<MediaAlphaCheckerTexture>();
    world.insert_resource(super::Visuals {
        texture_store: Default::default(),
        card_blocks: Vec::new(),
        card_decorations: Vec::new(),
        container_blocks: Vec::new(),
        mesh: default(),
        material: default(),
        mesh_entity: None,
        blend_mesh: default(),
        blend_material: default(),
        blend_mesh_entity: None,
        font: default(),
        labels: default(),
        textures: default(),
        edge_blocks: default(),
        shared_key: None,
        attach_labels: default(),
        attach_probe_mesh: default(),
        attach_probe_entity: None,
        attach_probe_active: false,
        media_alpha_checker: None,
        node_action_mesh: default(),
        node_action_entity: None,
        node_action_labels: default(),
        node_action_active: false,
        running_mesh: default(),
        running_mesh_entity: None,
        running_labels: default(),
        running_active: false,
    });
    world.insert_resource(CurrentScene(Scene {
        nodes: serde_json::from_value(serde_json::json!([
            {"id":"poster","type":"image","x":0,"y":0,"width":320,"height":240,"title":"海报"}
        ]))
        .unwrap(),
        surface: serde_json::from_value(serde_json::json!({
            "width": 1200.0, "height": 800.0, "pixelRatio": 1.0, "contentRight": 0.0,
            "contentRect": {"x": 100.0, "y": 80.0, "width": 1000.0, "height": 700.0}
        }))
        .unwrap(),
        ..Default::default()
    }));
    world
}

fn run(world: &mut World) {
    world.resource_mut::<FrameFlags>().changed = true;
    world.run_system_once(sync).unwrap();
}

fn checker_entities(world: &mut World) -> Vec<(Vec2, f32)> {
    let mut query = world.query_filtered::<(&Sprite, &Transform), With<MediaAlphaChecker>>();
    query
        .iter(world)
        .map(|(sprite, transform)| (sprite.custom_size.unwrap_or(Vec2::ZERO), transform.translation.z))
        .collect()
}

#[test]
fn checker_appears_only_while_media_focus_is_presented() {
    let mut world = world();
    run(&mut world);
    assert!(checker_entities(&mut world).is_empty(), "普通画布不应铺棋盘格");

    world.resource_mut::<CurrentScene>().0.image_focus = Some(
        serde_json::from_value(serde_json::json!({
            "version": "woohaa-image-focus-v1",
            "nodeId": "poster",
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "sourceWidth": 320, "sourceHeight": 240,
            "presentationReady": true
        }))
        .unwrap(),
    );
    run(&mut world);
    let focused = checker_entities(&mut world);
    assert_eq!(focused.len(), 1, "聚焦时应有且只有一层棋盘格");
    let (size, z) = focused[0];
    // 棋盘格必须与聚焦素材**实际渲染**的矩形同尺寸（节点框内 contain，不拉伸）。
    let scene = &world.resource::<CurrentScene>().0;
    let node = scene.nodes.iter().find(|node| node.id == "poster").unwrap();
    let expected = crate::canvas_query::layout::texture_size(node, Vec2::new(320.0, 240.0));
    assert!((size.x - expected.x).abs() < 0.01 && (size.y - expected.y).abs() < 0.01,
        "棋盘格必须与聚焦素材同尺寸：期望 {expected:?}，实际 {size:?}");
    assert!(size.x > 1.0 && size.y > 1.0, "棋盘格尺寸必须为正");
    // 在素材（foreground_z）之下，才能在透明像素处透出来。
    assert!(z < crate::canvas_query::media_focus::foreground_z(&world.resource::<CurrentScene>().0));

    // 退出聚焦即撤掉，不留下盖住画布的格子。
    world.resource_mut::<CurrentScene>().0.image_focus = None;
    world.resource_mut::<FrameFlags>().changed = true;
    run(&mut world);
    assert!(checker_entities(&mut world).is_empty());
}

#[test]
fn checker_waits_for_the_presentation_ready_gate() {
    // 入场过渡期间素材还没呈现：棋盘格也不能先出现，否则会盖住原画布。
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.image_focus = Some(
        serde_json::from_value(serde_json::json!({
            "version": "woohaa-image-focus-v1",
            "nodeId": "poster",
            "viewport": {"x": 0, "y": 0, "zoom": 1},
            "sourceWidth": 320, "sourceHeight": 240,
            "presentationReady": false
        }))
        .unwrap(),
    );
    run(&mut world);
    assert!(checker_entities(&mut world).is_empty());
}
