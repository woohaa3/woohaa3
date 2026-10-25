//! 节点顶部操作横条的交互命中测试（change: 2026-10-13-add-node-to-film-set-shortcut）。
//!
//! 从 `tests.rs` 拆出以维持单文件体积护栏；复用父模块的场景构造与查询辅助。

use super::*;

#[test]
fn group_run_status_opens_activity_and_tracks_repeated_moves() {
    let mut group = group("g", 100., 200., 400., 300., 0);
    group.group.as_mut().unwrap().run_status = Some(crate::protocol::GroupRunStatus {
        label: "创作中".into(), state: "running".into(),
    });
    let base = accept_scene(&scene(vec![group.clone()], vec![]));
    let expected = Some(results::PointHit::NodeAction { node_id: "g".into(), action_id: "group-run-status".into(), menu: false });
    let assert_chip = |generation, group: &GraphNode| {
        let (x, y, w, h) = crate::canvas_query::layout::group_run_status_rect(group).unwrap();
        assert_eq!(point_query(generation, x + w / 2., y + h / 2., 1., None).hit, expected);
    };
    assert_chip(base, &group);
    for x in [250., 600.] {
        group.x = x;
        let request = crate::protocol::PositionUpdateRequest {
            version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.to_owned(), base_scene_generation: base,
            positions: vec![crate::protocol::NodePosition { id: "g".into(), x, y: group.y }], viewport: None,
        };
        let generation = accept_positions(&request).unwrap().0;
        assert_chip(generation, &group);
    }
    group.ghost = true;
    let generation = accept_scene(&scene(vec![group.clone()], vec![]));
    let (x, y, w, h) = crate::canvas_query::layout::group_run_status_rect(&group).unwrap();
    assert_eq!(point_query(generation, x + w / 2., y + h / 2., 1., None).hit, None);
}

/// 带顶部操作横条的场景：`nodeActions` 按节点 id 下发，命中由 Rust 快照判定。
fn scene_with_actions(nodes: Vec<GraphNode>) -> Scene {
    use crate::protocol::{NodeAction, NodeActions};
    let mut node_actions = std::collections::HashMap::new();
    node_actions.insert(
        "n1".to_owned(),
        NodeActions {
            actions: vec![
                NodeAction {
                    id: "download".into(),
                    label: "下载".into(),
                    enabled: true,
                    menu: false,
                    ..Default::default()
                },
                NodeAction {
                    id: "convert".into(),
                    label: "转为片场".into(),
                    enabled: true,
                    menu: true,
                    ..Default::default()
                },
            ],
            summary: None,
        },
    );
    Scene {
        node_actions,
        ..scene(nodes, vec![])
    }
}

#[test]
fn node_action_bar_hits_action_and_menu_rects_only() {
    clear_snapshot();
    let scene = scene_with_actions(vec![node("n1", 500.0, 300.0, 200.0, 120.0)]);
    let generation = accept_scene(&scene);
    // 复算横条几何，取动作与箭头矩形中心作为命中点。
    let layout = crate::canvas_query::layout::node_action_toolbar(
        &scene.nodes[0],
        scene.node_actions.get("n1").unwrap(),
        None,
        None,
    )
    .expect("layout");
    let action = layout.slots[0].rect;
    let action_center = Vec2::new(action.0 + action.2 / 2.0, action.1 + action.3 / 2.0);
    let hit = point_query(generation, action_center.x, action_center.y, 1.0, None).hit;
    assert_eq!(
        hit,
        Some(results::PointHit::NodeAction {
            node_id: "n1".into(),
            action_id: "download".into(),
            menu: false,
        })
    );
    let chevron = layout.slots[1].menu.expect("chevron");
    let chevron_center = Vec2::new(chevron.0 + chevron.2 / 2.0, chevron.1 + chevron.3 / 2.0);
    let hit = point_query(generation, chevron_center.x, chevron_center.y, 1.0, None).hit;
    assert_eq!(
        hit,
        Some(results::PointHit::NodeAction {
            node_id: "n1".into(),
            action_id: "convert".into(),
            menu: true,
        })
    );
    // 横条之外（节点本体中心）不命中动作，落到节点本体。
    let body_center = Vec2::new(600.0, 360.0);
    let hit = point_query(generation, body_center.x, body_center.y, 1.0, None).hit;
    assert_eq!(
        hit,
        Some(results::PointHit::Node { node_id: "n1".into() })
    );
}

#[test]
fn node_action_bar_follows_node_position_preview() {
    clear_snapshot();
    let scene = scene_with_actions(vec![node("n1", 500.0, 300.0, 200.0, 120.0)]);
    let generation = accept_scene(&scene);
    // 拖动预览把节点移到 +100/+50；position accept 复用快照并平移派生几何（含横条矩形）。
    let request = crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.to_owned(),
        base_scene_generation: generation,
        positions: vec![crate::protocol::NodePosition {
            id: "n1".into(),
            x: 600.0,
            y: 350.0,
        }],
        viewport: None,
    };
    let (moved, _) = accept_positions(&request).expect("accept positions");
    // 命中点取「移动后」横条动作矩形中心（与平移后的快照一致）。
    let moved_node = node("n1", 600.0, 350.0, 200.0, 120.0);
    let layout = crate::canvas_query::layout::node_action_toolbar(
        &moved_node,
        scene.node_actions.get("n1").unwrap(),
        None,
        None,
    )
    .expect("layout");
    let action = layout.slots[0].rect;
    let center = Vec2::new(action.0 + action.2 / 2.0, action.1 + action.3 / 2.0);
    let hit = point_query(moved, center.x, center.y, 1.0, None).hit;
    assert_eq!(
        hit,
        Some(results::PointHit::NodeAction {
            node_id: "n1".into(),
            action_id: "download".into(),
            menu: false,
        })
    );
    // 旧位置（未平移）不再命中横条动作。
    let old_layout = crate::canvas_query::layout::node_action_toolbar(
        &node("n1", 500.0, 300.0, 200.0, 120.0),
        scene.node_actions.get("n1").unwrap(),
        None,
        None,
    )
    .expect("layout");
    let old = old_layout.slots[0].rect;
    let old_center = Vec2::new(old.0 + old.2 / 2.0, old.1 + old.3 / 2.0);
    let hit = point_query(moved, old_center.x, old_center.y, 1.0, None).hit;
    assert!(!matches!(hit, Some(results::PointHit::NodeAction { .. })));
}

#[test]
fn node_action_hits_match_layout_after_viewport_and_edge_drag() {
    let mut scene = scene_with_actions(vec![node("n1", 500.0, 300.0, 200.0, 120.0)]);
    scene.surface = Some(crate::protocol::SurfaceSize {
        width: 1000.0, height: 800.0, pixel_ratio: 1.0, content_right: 0.0, content_rect: None,
        origin_x: 0.0, origin_y: 0.0,
    });
    let base = accept_scene(&scene);
    let viewport = crate::protocol::Viewport { x: 75.0, y: 10.0, zoom: 0.5 };
    let zoomed = accept_viewport(base, viewport.clone()).unwrap();
    let assert_hit = |generation, node: &GraphNode, viewport: &crate::protocol::Viewport| {
        let layout = crate::canvas_query::layout::node_action_toolbar(node, &scene.node_actions["n1"], Some((viewport.x, viewport.y, viewport.zoom)), Some((1000.0, 800.0))).unwrap();
        let rect = layout.slots[0].rect;
        assert!((rect.3 * viewport.zoom - 32.0).abs() < 0.001);
        assert_eq!(point_query(generation, rect.0 + rect.2 / 2.0, rect.1 + rect.3 / 2.0, viewport.zoom, None).hit,
            Some(results::PointHit::NodeAction { node_id: "n1".into(), action_id: "download".into(), menu: false }));
    };
    assert_hit(zoomed, &scene.nodes[0], &viewport);
    // 同一 base 上连续拖动到顶部/左边：不可以简单平移原来的 above 矩形。
    for (x, y) in [(-100.0, -20.0), (1800.0, 1450.0), (600.0, 350.0)] {
        let request = crate::protocol::PositionUpdateRequest {
            version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(), base_scene_generation: base,
            positions: vec![crate::protocol::NodePosition { id: "n1".into(), x, y }], viewport: Some(viewport.clone()),
        };
        let (generation, _) = accept_positions(&request).unwrap();
        assert_hit(generation, &node("n1", x, y, 200.0, 120.0), &viewport);
    }
}

#[test]
fn composite_node_action_bar_uses_scope_and_tracks_viewport_and_moves() {
    let original = film_set("n1", 500., 300., 200., 120., Some((450., 200., 400., 240.)));
    let scene = scene_with_actions(vec![original.clone()]);
    let base = accept_scene(&scene);
    let assert_hit = |generation, node: &GraphNode, viewport: &crate::protocol::Viewport| {
        let bar = crate::canvas_query::layout::node_action_toolbar(node, &scene.node_actions["n1"], Some((viewport.x, viewport.y, viewport.zoom)), None).unwrap();
        let rect = bar.slots[1].menu.unwrap();
        assert_eq!(point_query(generation, rect.0 + rect.2 / 2., rect.1 + rect.3 / 2., viewport.zoom, None).hit,
            Some(results::PointHit::NodeAction { node_id: "n1".into(), action_id: "convert".into(), menu: true }));
    };
    let viewport = crate::protocol::Viewport { x: 0., y: 0., zoom: 1. };
    assert_hit(base, &original, &viewport);
    let zoom = crate::protocol::Viewport { x: 50., y: 70., zoom: 0.6 };
    let zoomed = accept_viewport(base, zoom.clone()).unwrap();
    assert_hit(zoomed, &original, &zoom);
    let request = crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(), base_scene_generation: base,
        positions: vec![crate::protocol::NodePosition { id: "n1".into(), x: 600., y: 400. }], viewport: Some(zoom.clone()),
    };
    let (moved, _) = accept_positions(&request).unwrap();
    let mut shifted = original;
    shifted.x += 100.; shifted.y += 100.;
    let asset = shifted.composite_asset.as_mut().unwrap();
    asset.x += 100.; asset.y += 100.;
    if let Some(ground) = asset.scope_ground.as_mut() { ground.cx += 100.; ground.cy += 100.; }
    assert_hit(moved, &shifted, &zoom);
}


#[test]
fn focused_references_only_expose_enabled_close_hits_in_css_coordinates() {
    use crate::canvas_query::focus_context;
    let mut source = scene_with_actions(vec![node("n1", 900., 700., 200., 120.), node("owner", 0., 0., 400., 300.)]);
    source.model_focus = Some(serde_json::from_value(serde_json::json!({"version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87})).unwrap());
    source.model_focus_context = serde_json::from_value(serde_json::json!([{"nodeId":"n1","x":20,"y":20,"width":184,"height":36}])).unwrap();
    source.node_actions.get_mut("n1").unwrap().actions = vec![crate::protocol::NodeAction { id: focus_context::CLOSE_ACTION.into(), label: "关闭容器".into(), enabled: true, ..default() }];
    let generation = accept_scene(&source);
    let display = focus_context::node(&source, &source.nodes[0]);
    let (x,y,w,h) = focus_context::close_rect(&display);
    assert_eq!(point_query(generation, x+w/2., y+h/2., 1., None).hit, Some(results::PointHit::NodeAction { node_id:"n1".into(), action_id:focus_context::CLOSE_ACTION.into(), menu:false }));
    assert_eq!(point_query(generation, 40., 38., 1., None).hit, None);
    assert_eq!(point_query(generation, 950., 750., 1., None).hit, None);
    source.node_actions.get_mut("n1").unwrap().actions[0].enabled = false;
    let generation = accept_scene(&source);
    assert_eq!(point_query(generation, x+w/2., y+h/2., 1., None).hit, None);
}


#[test]
fn hidden_shot_has_no_canvas_hit() {
    let mut shot = node("hidden", 100., 100., 240., 180.);
    shot.shot_preview = Some(serde_json::from_value(serde_json::json!({"filmSetNodeId":"owner","clipId":"clip","kind":"static","name":"镜头","hidden":true,"aspect":1.7778,"duration":0,"state":"ready","coverCamera":{"azimuth":0,"elevation":0.4,"distance":4,"focusOffset":[0,0,0]}})).unwrap());
    let generation = accept_scene(&scene(vec![shot], vec![]));
    assert_eq!(point_query(generation, 200., 180., 1., None).hit, None);
}
