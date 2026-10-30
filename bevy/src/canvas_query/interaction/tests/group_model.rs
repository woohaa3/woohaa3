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
            action_id: "group-badge-select".into(),
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
fn group_badge_is_a_drop_target_and_exposes_drop_scope_geometry() {
    let group = appearance_group();
    let badge = group_model::for_node(&group).unwrap();
    let generation = accept_scene(&scene(vec![group.clone()], vec![]));
    assert_eq!(
        drop_target_query(generation, badge.center.x, badge.center.y, &[]).target_node_id,
        Some("g".into())
    );
    let scopes = scope_geometry_query(generation);
    assert!(scopes.available);
    let entry = scopes
        .scopes
        .iter()
        .find(|entry| entry.node_id == "g")
        .expect("group badge scope");
    assert_eq!(entry.shape, "rect");
    assert!(entry.aabb[2] > 0. && entry.aabb[3] > 0.);
    // 拖放范围就是模型投影派生的徽标矩形，且确实延伸到组结构底边之外。
    let badge = group_model::badge_rect(&group).expect("badge rect");
    let expected = [
        [badge.x, badge.y],
        [badge.x + badge.z, badge.y],
        [badge.x + badge.z, badge.y + badge.w],
        [badge.x, badge.y + badge.w],
    ];
    for (actual, expected) in entry.vertices.iter().zip(expected) {
        assert!((actual[0] - expected[0]).abs() < 0.001);
        assert!((actual[1] - expected[1]).abs() < 0.001);
    }
    assert!(badge.y + badge.w > group.y + group.height);
    assert!((entry.aabb[0] - badge.x).abs() < 0.001);
    assert!((entry.aabb[1] - badge.y).abs() < 0.001);
    assert!((entry.aabb[2] - badge.z).abs() < 0.001);
    assert!((entry.aabb[3] - badge.w).abs() < 0.001);
}

#[test]
fn collapsed_group_badge_is_not_a_drop_target() {
    let mut group = appearance_group();
    group.group.as_mut().unwrap().collapsed = true;
    let badge = group_model::for_node(&group).unwrap();
    let generation = accept_scene(&scene(vec![group], vec![]));
    assert_eq!(
        drop_target_query(generation, badge.center.x, badge.center.y, &[]).target_node_id,
        None
    );
}

#[test]
fn collapsed_group_has_no_structural_hit_area_but_badge_remains_selectable() {
    let mut group = appearance_group();
    group.group.as_mut().unwrap().collapsed = true;
    let badge = group_model::for_node(&group).unwrap();
    let generation = accept_scene(&scene(vec![group.clone()], vec![]));

    let assert_badge_only = |generation, dx, dy| {
        for point in [
            Vec2::new(40., 40.),
            Vec2::new(group.width, group.height / 2.),
        ] {
            assert_eq!(
                point_query(
                    generation,
                    group.x + point.x + dx,
                    group.y + point.y + dy,
                    1.,
                    None
                )
                .hit,
                None
            );
        }
        assert!(
            marquee_query(
                generation,
                group.x + dx,
                group.y + dy,
                100.,
                200.
            )
            .node_ids
            .is_empty()
        );
        assert_eq!(
            marquee_query(
                generation,
                badge.center.x + dx - 4.,
                badge.center.y + dy - 4.,
                8.,
                8.
            )
            .node_ids,
            vec!["g"]
        );
        assert_eq!(
            point_query(
                generation,
                badge.center.x + dx,
                badge.center.y + dy,
                1.,
                None
            )
            .hit,
            Some(PointHit::NodeAction {
                node_id: "g".into(),
                action_id: "group-badge-select".into(),
                menu: false
            })
        );
    };
    assert_badge_only(generation, 0., 0.);
    let (moved, _) = accept_positions(&crate::protocol::PositionUpdateRequest {
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
    assert_badge_only(moved, 1000., 600.);
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
            action_id: "group-badge-select".into(),
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
            action_id: "group-badge-select".into(),
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
            action_id: "group-badge-select".into(),
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
            handle: Some("se".into())
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
            handle: Some("se".into())
        })
    );
    s.selection.nodes = vec!["g".into(), "other".into()];
    let g = accept_scene(&s);
    assert!(matches!(
        point_query(g, corner.x, corner.y, 1., None).hit,
        Some(PointHit::Node { .. })
    ));
}

/// 组选中后四个角都能拖拽缩放，且方向名与 contracts / 前端一致。
#[test]
fn selected_group_exposes_four_named_corner_resize_handles() {
    let group = appearance_group();
    let mut s = scene(vec![group.clone()], vec![]);
    s.selection.nodes = vec!["g".into()];
    let g = accept_scene(&s);
    // 抓手是压在角点上的圆点，命中框以角点为中心；点角点以及框外侧仍应命中。
    let cases = [
        ("nw", group.x, group.y),
        ("ne", group.x + group.width, group.y),
        ("sw", group.x, group.y + group.height),
        ("se", group.x + group.width, group.y + group.height),
        ("nw", group.x - 8., group.y - 8.),
        ("se", group.x + group.width + 8., group.y + group.height + 8.),
    ];
    for (name, x, y) in cases {
        assert_eq!(
            point_query(g, x, y, 1., None).hit,
            Some(PointHit::Resize {
                node_id: "g".into(),
                handle: Some(name.into())
            }),
            "{name} corner"
        );
    }
    // 边中点保持普通节点命中：组只有四角抓手，不引入边缩放。
    assert_eq!(
        point_query(g, group.x + group.width / 2., group.y + 4., 1., None).hit,
        Some(PointHit::Node {
            node_id: "g".into()
        })
    );
}

#[test]
fn badge_lip_hits_group_but_does_not_expand_marquee_or_resize_bounds() {
    let group = appearance_group();
    let mut s = scene(vec![group.clone()], vec![]);
    s.selection.nodes = vec!["g".into()];
    let g = accept_scene(&s);
    let x = group.x + group.width / 2.;
    let badge = group_model::badge_rect(&group).unwrap();
    // 徽标下唇：结构底边之下、模型包围盒之内。
    let y = group.y + group.height + 2.;
    assert!(y <= badge.y + badge.w);
    assert_eq!(
        point_query(g, x, y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-badge-select".into(),
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
            handle: Some("se".into())
        })
    );
    // 组外、徽标左侧的空白仍然无命中；四角抓手只向体外扩出 10 个单位，不占用徽标唇边。
    assert_eq!(point_query(g, group.x + 40., y, 1., None).hit, None);
}

#[test]
fn model_derived_badge_hit_follows_position_increments() {
    let group = appearance_group();
    let badge = group_model::badge_rect(&group).unwrap();
    let point = Vec2::new(badge.x + badge.z / 2., badge.y + badge.w - 2.);
    let generation = accept_scene(&scene(vec![group.clone()], vec![]));
    assert_eq!(
        point_query(generation, point.x, point.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-badge-select".into(),
            menu: false
        })
    );
    // 徽标底部远在组框之外，框选不得把它当作成员或组结构范围。
    assert!(
        marquee_query(generation, point.x - 2., point.y - 2., 4., 4.)
            .node_ids
            .is_empty()
    );
    // 位置增量只平移已接受的模型投影；徽标范围随组一起移动。
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
        point_query(generation, point.x + 1000., point.y + 600., 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-badge-select".into(),
            menu: false
        })
    );
    assert_eq!(point_query(generation, point.x, point.y, 1., None).hit, None);
}

#[test]
fn tall_model_badge_lower_half_remains_a_spatial_hit_candidate() {
    // 模具很高的组徽标远高于组卡片本身。下半部必须留在广相索引中，精确命中的
    // 模型包围盒判定才能收到指针事件。
    let mut group = appearance_group();
    group
        .group
        .as_mut()
        .unwrap()
        .model_bounds
        .as_mut()
        .unwrap()
        .aabb
        .max = [4., 100., -3.];
    let badge = group_model::badge_rect(&group).unwrap();
    let generation = accept_scene(&scene(vec![group], vec![]));
    let point = Vec2::new(badge.x + badge.z / 2., badge.y + badge.w - 2.);
    assert!(point.y > badge.y + badge.w / 2.);
    assert_eq!(
        point_query(generation, point.x, point.y, 1., None).hit,
        Some(PointHit::NodeAction {
            node_id: "g".into(),
            action_id: "group-badge-select".into(),
            menu: false
        })
    );
}
