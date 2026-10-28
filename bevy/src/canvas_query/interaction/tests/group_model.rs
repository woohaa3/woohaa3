use super::*;
use crate::canvas_query::group_model;

fn appearance_group() -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id":"g", "type":"group", "x":0., "y":0., "width":500., "height":300.,
        // 缩放是能力投影结果：组的能力声明 resize，唯一选中时 contracts 置位。
        "resizable": true,
        "group":{"memberCount":1,"outputCapableLeafCount":1,
          "modelBounds":{"aabb":{"min":[-1.,-1.,-1.],"max":[1.,1.,1.]},"extent":2.}},
        "model":{"resourceKey":"test:box", "signature":"box"}
    }))
    .unwrap()
}

#[test]
fn footer_model_hits_group_and_keeps_member_controls_and_marquee_rectangular() {
    let group = appearance_group();
    let badge = group_model::for_node(&group).unwrap();
    let center = badge.center + Vec2::Y * badge.radii.y * 0.45;
    let plain = scene(vec![group.clone()], vec![]);
    let generation = accept_scene(&plain);
    assert_eq!(
        point_query(generation, center.x, center.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
    // No former diamond area remains outside the rectangle.
    let blank = Vec2::new(group.x + 10., group.y + group.height + 20.);
    assert_eq!(
        point_query(generation, blank.x, blank.y, 1., None).hit,
        None
    );
    assert!(
        marquee_query(
            generation,
            center.x - 10.,
            group.y + group.height + 5.,
            20.,
            20.
        )
        .node_ids
        .is_empty()
    );
    let card = node("member", center.x - 50., center.y - 30., 100., 60.);
    let generation = accept_scene(&scene(vec![group, card], vec![]));
    assert_eq!(
        point_query(generation, center.x, center.y, 1., None).hit,
        Some(PointHit::Node {
            node_id: "member".into()
        })
    );
    assert_eq!(
        point_query(generation, center.x + 50., center.y, 1., None).hit,
        Some(PointHit::Port {
            node_id: "member".into(),
            side: "output".into()
        })
    );
}

#[test]
fn position_increment_moves_footer_and_spatial_grid_like_full_scene() {
    let group = appearance_group();
    let badge = group_model::for_node(&group).unwrap();
    let original = scene(vec![group.clone()], vec![]);
    let generation = accept_scene(&original);
    let request = crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: generation,
        viewport: None,
        positions: vec![crate::protocol::NodePosition {
            id: "g".into(),
            x: 1000.,
            y: 600.,
        }],
    };
    let (generation, _) = accept_positions(&request).unwrap();
    let center = badge.center + Vec2::new(1000., 600.);
    assert_eq!(
        point_query(generation, center.x, center.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
    assert_eq!(
        point_query(generation, badge.center.x, badge.center.y, 1., None).hit,
        None
    );
    let mut moved = group;
    moved.x = 1000.;
    moved.y = 600.;
    let rebuilt = accept_scene(&scene(vec![moved], vec![]));
    assert_eq!(
        point_query(rebuilt, center.x, center.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
}

#[test]
fn short_group_footer_model_remains_in_the_group_hit_area() {
    let mut group = appearance_group();
    group.height = 80.;
    group
        .group
        .as_mut()
        .unwrap()
        .model_bounds
        .as_mut()
        .unwrap()
        .aabb
        .max = [1., 100., 1.];
    let badge = group_model::for_node(&group).unwrap();
    let upper = badge.center - Vec2::Y * badge.radii.y * 0.5;
    let generation = accept_scene(&scene(vec![group], vec![]));
    assert_eq!(
        point_query(generation, upper.x, upper.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
}

#[test]
fn selected_group_resize_handle_survives_position_updates_and_clears_on_multiselect() {
    let group = appearance_group();
    let corner = Vec2::new(group.x + group.width - 10., group.y + group.height - 10.);
    let mut s = scene(vec![group], vec![]);
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, corner.x, corner.y, 1., None).hit,
        Some(PointHit::Node { .. })
    ));
    s.selection.nodes = vec!["g".into()];
    let g = accept_scene(&s);
    assert_eq!(
        point_query(g, corner.x, corner.y, 1., None).hit,
        Some(PointHit::Resize {
            node_id: "g".into(),
            handle: None
        })
    );
    let (g, _) = accept_positions(&crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: g,
        viewport: None,
        positions: vec![crate::protocol::NodePosition {
            id: "g".into(),
            x: 1000.,
            y: 600.,
        }],
    })
    .unwrap();
    assert_eq!(
        point_query(g, corner.x + 1000., corner.y + 600., 1., None).hit,
        Some(PointHit::Resize {
            node_id: "g".into(),
            handle: None
        })
    );
    s.selection.nodes = vec!["g".into(), "other".into()];
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, corner.x, corner.y, 1., None).hit,
        Some(PointHit::Node { .. })
    ));
}

#[test]
fn badge_lip_hits_group_but_does_not_expand_marquee_or_resize_bounds() {
    let group = appearance_group();
    let mut s = scene(vec![group.clone()], vec![]);
    s.selection.nodes = vec!["g".into()];
    let g = accept_scene(&s);
    let x = group.x + group.width / 2.;
    let badge = group_model::badge_rect(&group);
    let y = badge.y + 2.;
    assert_eq!(
        point_query(g, x, y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
    assert!(
        marquee_query(g, x - 5., group.y + group.height + 1., 10., 4.)
            .node_ids
            .is_empty()
    );
    assert_eq!(
        point_query(
            g,
            group.x + group.width - 10.,
            group.y + group.height - 10.,
            1.,
            None
        )
        .hit,
        Some(PointHit::Resize {
            node_id: "g".into(),
            handle: None
        })
    );
    assert_eq!(point_query(g, group.x + 10., y, 1., None).hit, None);
}

#[test]
fn independent_badge_resize_handle_and_scaled_lip_follow_position_increments() {
    let mut group = appearance_group();
    group.group.as_mut().unwrap().badge_scale = 2.;
    group.group.as_mut().unwrap().badge_resizable = true;
    let handle = group_model::resize_center(&group).unwrap();
    let badge = group_model::badge_rect(&group);
    let lip = Vec2::new(group.x + group.width / 2., badge.y + badge.w - 2.);
    let generation = accept_scene(&scene(vec![group.clone()], vec![]));
    assert_eq!(
        point_query(generation, handle.x, handle.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-resize-badge".into(),
            menu: false
        })
    );
    assert_eq!(
        point_query(generation, lip.x, lip.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-toggle-collapse".into(),
            menu: false
        })
    );
    assert!(
        marquee_query(generation, lip.x - 2., lip.y - 2., 4., 4.)
            .node_ids
            .is_empty()
    );
    let (generation, _) = accept_positions(&crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: generation,
        viewport: None,
        positions: vec![crate::protocol::NodePosition {
            id: "g".into(),
            x: 1000.,
            y: 600.,
        }],
    })
    .unwrap();
    assert_eq!(
        point_query(generation, handle.x + 1000., handle.y + 600., 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-resize-badge".into(),
            menu: false
        })
    );
    group.group.as_mut().unwrap().badge_resizable = false;
    let generation = accept_scene(&scene(vec![group], vec![]));
    assert!(
        !matches!(point_query(generation, handle.x, handle.y, 1., None).hit,
        Some(PointHit::NodeAction {action_id, ..}) if action_id == "group-resize-badge")
    );
}
