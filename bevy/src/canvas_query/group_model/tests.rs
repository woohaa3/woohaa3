use super::*;
use crate::protocol::ModelAabbDto;

fn node(width: f32, height: f32) -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id":"g", "type":"group", "x":130., "y":270., "width":width, "height":height,
        "group":{"title":"组", "memberCount":3,"outputCapableLeafCount":2,
            "modelBounds":{"aabb":{"min":[2.,-1.,-4.],"max":[4.,3.,-2.]},"extent":4.}},
        "model":{"resourceKey":"test:box","signature":"box"}
    }))
    .unwrap()
}

fn projected_size(n: &GraphNode, aabb: ModelAabbDto, yaw: f32) -> (f32, f32) {
    let layout = for_node(n).expect("model layout");
    let projected = ModelAabb::new(aabb.min, aabb.max).transformed(&Transform {
        rotation: grid::view_rotation() * Quat::from_rotation_y(yaw.to_radians()),
        scale: Vec3::splat(layout.unit),
        ..default()
    });
    (
        projected.max[0] - projected.min[0],
        projected.max[1] - projected.min[1],
    )
}

#[test]
fn badge_is_the_model_projection_centered_on_the_fixed_anchor() {
    for width in [180., 320., 1200.] {
        for height in [64., 195., 600.] {
            for yaw in [0., 35., 90.] {
                for scale in [0.25, 1., 4.] {
                    for max in [[4., 3., -2.], [80., 0., -3.], [3., 100., -3.]] {
                        let mut n = node(width, height);
                        let aabb = ModelAabbDto {
                            min: [2., -1., -4.],
                            max,
                        };
                        n.group
                            .as_mut()
                            .unwrap()
                            .model_bounds
                            .as_mut()
                            .unwrap()
                            .aabb = aabb;
                        n.model.as_mut().unwrap().placement.yaw = yaw;
                        n.model.as_mut().unwrap().placement.scale = scale;
                        let layout = for_node(&n).unwrap();
                        let (w, h) = projected_size(&n, aabb, yaw);

                        // 锚点固定：组结构底边中点向下 40，不随模型尺寸或倍率移动。
                        assert!((layout.center.x - (n.x + n.width / 2.)).abs() < 0.001);
                        assert!(
                            (layout.center.y - (n.y + n.height + GROUP_BADGE_ANCHOR_OFFSET)).abs()
                                < 0.001
                        );

                        // 徽标范围就是投影包围盒，中心对齐锚点；没有任何固定框或倍率。
                        let rect = badge_rect(&n).unwrap();
                        assert!((rect.z - w).abs() < 0.001, "width follows projection");
                        assert!((rect.w - h).abs() < 0.001, "height follows projection");
                        assert!((rect.x + rect.z / 2. - layout.center.x).abs() < 0.001);
                        assert!((rect.y + rect.w / 2. - layout.center.y).abs() < 0.001);
                        assert!((layout.radii.x * 2. - w).abs() < 0.001);
                        assert!((layout.radii.y * 2. - h).abs() < 0.001);

                        // 命中多边形与绘制范围同源，且闭合。
                        let polygon = badge_polygon(&n);
                        assert_eq!(polygon.len(), 5);
                        assert_eq!(polygon[0], polygon[4]);
                        assert!(polygon[..4].iter().all(|p| p.x >= rect.x - 0.001
                            && p.x <= rect.x + rect.z + 0.001
                            && p.y >= rect.y - 0.001
                            && p.y <= rect.y + rect.w + 0.001));

                        // 组框保持结构矩形：徽标向下伸出也不会改写圆角气泡路径。
                        let outline = outline(&n);
                        assert_eq!(outline, rectangle(&n));
                        assert!(outline.iter().all(|p| p.y <= n.y + n.height + 0.001));
                        assert_eq!(fill_regions(&n), vec![rectangle(&n)]);
                    }
                }
            }
        }
    }
}

#[test]
fn badge_top_anchor_is_decoded_from_scene_wire() {
    let n: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"g", "type":"group", "x":0., "y":0., "width":500., "height":300.,
        "group":{"title":"组","memberCount":0,"outputCapableLeafCount":0,"badgeTopAnchor":true},
        "model":{"resourceKey":"test:box","signature":"box"}
    }))
    .unwrap();
    assert!(n.group.unwrap().badge_top_anchor);
}

#[test]
fn film_set_badge_top_is_anchored_below_the_structural_bottom() {
    let mut n = node(1192., 608.);
    n.group.as_mut().unwrap().badge_top_anchor = true;
    let layout = for_node(&n).unwrap();
    let rect = badge_rect(&n).unwrap();
    let bottom = n.y + n.height + GROUP_BADGE_ANCHOR_OFFSET;

    assert!(
        (rect.y - bottom).abs() < 0.001,
        "top edge sits on the anchor"
    );
    assert!((layout.center.y - (bottom + layout.radii.y)).abs() < 0.001);
    assert!((rect.y + rect.w / 2. - layout.center.y).abs() < 0.001);
    assert!((rect.y + rect.w - (bottom + layout.radii.y * 2.)).abs() < 0.001);
    assert!(badge_outset(&n) > layout.radii.y * 2. - 1.);
    assert!(
        rect.y >= n.y + n.height,
        "film-set badge never intrudes into the group frame"
    );
}

#[test]
fn group_model_unit_is_the_shared_canvas_model_unit() {
    for extent in [0.5, 2., 4., 16.] {
        for scale in [0.25, 1., 3.] {
            for (width, height) in [(180., 64.), (500., 300.), (2400., 900.)] {
                let mut n = node(width, height);
                n.group
                    .as_mut()
                    .unwrap()
                    .model_bounds
                    .as_mut()
                    .unwrap()
                    .extent = extent;
                n.model.as_mut().unwrap().placement.scale = scale;
                let layout = for_node(&n).unwrap();
                // 与 model3d 的 `model_unit` 完全相同：`placement.scale * CANVAS_UNITS_PER_METER`
                // （绝对米制，不除以 extent）。没有 film-set fit、没有 `min(1)`、没有 56×44 钳制。
                assert!((layout.unit - scale * crate::model3d::CANVAS_UNITS_PER_METER).abs() < 0.001);
            }
        }
    }
}

#[test]
fn anchor_follows_move_and_resize_and_ignores_model_offsets() {
    let n = node(500., 300.);
    let original = for_node(&n).unwrap();
    let mut moved = n.clone();
    moved.x += 700.;
    moved.y -= 900.;
    let next = for_node(&moved).unwrap();
    assert_eq!(next.center, original.center + Vec2::new(700., -900.));
    moved.width = 200.;
    moved.height = 64.;
    let small = for_node(&moved).unwrap();
    assert_eq!(small.center.x, moved.x + 100.);
    assert_eq!(small.center.y, moved.y + 64. + GROUP_BADGE_ANCHOR_OFFSET);
    // 非 `scale` 的 placement 段不参与组徽标：偏移只影响普通卡片，不影响锚点或单位。
    moved.model.as_mut().unwrap().placement.offset.x = 50.;
    moved.model.as_mut().unwrap().placement.offset.y = -30.;
    let offset = for_node(&moved).unwrap();
    assert_eq!(offset.center, small.center);
    assert_eq!(offset.unit, small.unit);
}

#[test]
fn missing_model_projection_has_no_badge_and_keeps_structural_rect() {
    let mut n = node(500., 300.);
    let frame = rectangle(&n);
    assert!(badge_rect(&n).is_some());
    assert!(badge_outset(&n) > 0.);

    // 没有 model 引用：无布局、无徽标、无伸出，组框仍是结构矩形。
    let mut without_model = n.clone();
    without_model.model = None;
    assert!(for_node(&without_model).is_none());
    assert!(badge_rect(&without_model).is_none());
    assert!(badge_polygon(&without_model).is_empty());
    assert_eq!(badge_outset(&without_model), 0.);
    assert_eq!(presentation_rect(&without_model), Vec4::new(n.x, n.y, n.width, n.height));
    assert_eq!(outline(&without_model), frame);

    // 没有 modelBounds（例如资源尚未就绪）：同样不产生占位徽标。
    n.group.as_mut().unwrap().model_bounds = None;
    assert!(for_node(&n).is_none());
    assert!(badge_rect(&n).is_none());
    assert_eq!(outline(&n), frame);
}

#[test]
fn collapsed_group_presentation_is_the_badge_or_the_structural_rect() {
    let mut n = node(500., 300.);
    let badge = badge_rect(&n).unwrap();
    n.group.as_mut().unwrap().collapsed = true;
    assert_eq!(presentation_rect(&n), badge);
    assert!(outline(&n).is_empty(), "收起组只画模型，不画结构框");
    assert_eq!(frame_path(&n), rectangle(&n));

    n.model = None;
    assert_eq!(presentation_rect(&n), Vec4::new(n.x, n.y, n.width, n.height));
}

#[test]
fn badge_outset_reports_only_the_part_below_the_structural_bottom() {
    let mut n = node(500., 300.);
    let bottom = n.y + n.height;
    let rect = badge_rect(&n).unwrap();
    assert_eq!(badge_outset(&n), (rect.y + rect.w - bottom).max(0.));
    n.group
        .as_mut()
        .unwrap()
        .model_bounds
        .as_mut()
        .unwrap()
        .aabb
        .max = [4., 0.5, -2.];
    let small = badge_rect(&n).unwrap();
    assert_eq!(badge_outset(&n), (small.y + small.w - bottom).max(0.));
}

#[test]
fn resize_corners_and_has_badge_follow_accepted_inputs() {
    let mut n = node(500., 300.);
    assert_eq!(
        resize_corners(&n),
        [
            Vec2::new(n.x, n.y),
            Vec2::new(n.x + n.width, n.y),
            Vec2::new(n.x, n.y + n.height),
            Vec2::new(n.x + n.width, n.y + n.height),
        ]
    );
    assert!(has_badge(&n));
    n.model = None;
    assert!(!has_badge(&n));
}

#[test]
fn badge_bottom_face_tracks_the_rendered_model_transform() {
    let mut n = node(500., 300.);
    assert!(
        badge_bottom_polygon(&n).is_none(),
        "ordinary groups have no floor outline"
    );
    n.group.as_mut().unwrap().badge_top_anchor = true;
    for yaw in [0., 35., 90., 145.] {
        for scale in [0.25, 1., 4.] {
            n.model.as_mut().unwrap().placement.yaw = yaw;
            n.model.as_mut().unwrap().placement.scale = scale;
            let polygon = badge_bottom_polygon(&n).unwrap();
            assert_eq!(polygon[0], polygon[4]);
            let layout = for_node(&n).unwrap();
            let bounds = n
                .group
                .as_ref()
                .unwrap()
                .model_bounds
                .as_ref()
                .unwrap()
                .aabb;
            // Undo the overview projection: every corner must be on the model's local bottom
            // face, even with an eccentric origin, root yaw and non-unit presentation scale.
            let inverse =
                (grid::view_rotation() * Quat::from_rotation_y(yaw.to_radians())).inverse();
            let rotation = grid::view_rotation() * Quat::from_rotation_y(yaw.to_radians());
            for (i, [x, z]) in [
                [bounds.min[0], bounds.min[2]],
                [bounds.max[0], bounds.min[2]],
                [bounds.max[0], bounds.max[2]],
                [bounds.min[0], bounds.max[2]],
            ]
            .into_iter()
            .enumerate()
            {
                let expected = Vec3::new(x, bounds.min[1], z);
                let depth = (rotation * expected * layout.unit).z;
                let canvas = polygon[i] - layout.anchor;
                let local = inverse * Vec3::new(canvas.x, -canvas.y, depth) / layout.unit;
                assert!(local.distance(expected) < 0.001);
            }
        }
    }
    n.group.as_mut().unwrap().model_bounds = None;
    assert!(
        badge_bottom_polygon(&n).is_none(),
        "no fabricated floor before bounds arrive"
    );
}
