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

#[test]
fn badge_model_fits_stable_badge_for_size_yaw_scale_and_eccentric_bounds() {
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
                        let projected =
                            ModelAabb::new(aabb.min, aabb.max).transformed(&Transform {
                                rotation: grid::view_rotation()
                                    * Quat::from_rotation_y(yaw.to_radians()),
                                scale: Vec3::splat(layout.unit),
                                ..default()
                            });
                        for x in [projected.min[0], projected.max[0]] {
                            for y in [projected.min[1], projected.max[1]] {
                                let point = layout.anchor + Vec2::new(x, -y);
                                assert!(path_contains(&badge_path(&n), point));
                                let badge = badge_rect(&n);
                                assert!(point.y >= badge.y - 0.01);
                                assert!(point.y <= badge.y + badge.w + 0.01);
                            }
                        }
                        assert!((layout.center.x - (n.x + n.width / 2.)).abs() < 0.001);
                        let badge = badge_rect(&n);
                        assert!((layout.center.y - (badge.y + badge.w / 2.)).abs() < 0.001);
                        assert!(path_contains(&badge_path(&n), layout.center));
                        assert!(layout.radii.x * 2. <= MODEL_MAX_WIDTH + 0.001);
                        assert!(layout.radii.y * 2. <= MODEL_MAX_HEIGHT + 0.001);
                        assert!(
                            outline(&n)
                                .iter()
                                .all(|p| p.y <= n.y + n.height + BADGE_OUTSET + 0.001)
                        );
                        assert!(outline(&n).iter().any(|p| p.y > n.y + n.height));
                        assert!(!frame_path(&n).windows(2).any(
                            |p| (p[0].y - (n.y + n.height)).abs() < 0.001
                                && (p[1].y - (n.y + n.height)).abs() < 0.001
                                && p[0].x > n.x + n.width / 2.
                                && p[1].x < n.x + n.width / 2.
                        ));
                        assert_eq!(fill_regions(&n), vec![rectangle(&n)]);
                    }
                }
            }
        }
    }
}

#[test]
fn footer_model_follows_move_and_resize_and_ignores_detaching_offsets() {
    let n = node(500., 300.);
    let original = for_node(&n).unwrap();
    let mut moved = n.clone();
    moved.x += 700.;
    moved.y -= 900.;
    let next = for_node(&moved).unwrap();
    assert_eq!(next.center, original.center + Vec2::new(700., -900.));
    assert!(
        next.anchor
            .distance(original.anchor + Vec2::new(700., -900.))
            < 0.001
    );
    moved.width = 200.;
    moved.height = 64.;
    let small = for_node(&moved).unwrap();
    assert_eq!(small.center.x, moved.x + 100.);
    assert!(small.unit < original.unit);
    moved.model.as_mut().unwrap().placement.offset.x = 50.;
    moved.model.as_mut().unwrap().placement.offset.y = -30.;
    assert_eq!(for_node(&moved).unwrap(), small);
}

#[test]
fn bubble_tail_keeps_its_own_size_when_the_group_grows() {
    let span = |tail: &[Vec2]| {
        let min = tail.iter().map(|point| point.x).fold(f32::MAX, f32::min);
        let max = tail.iter().map(|point| point.x).fold(f32::MIN, f32::max);
        max - min
    };
    for width in [220., 700., 2400.] {
        let n = node(width, 320.);
        let tail = tail_path(&n);
        assert!(
            (span(&tail) - TAIL_BASE).abs() < 0.001,
            "tail base must not follow the {width} wide body"
        );
        assert!((tail[1].x - (n.x + n.width / 2.)).abs() < 0.001);
        // 尾巴高度只由徽标外侧间距决定，与组尺寸无关。
        assert!((tail[1].y - (n.y + n.height + BADGE_OUTSET)).abs() < 0.001);
    }
    // 徽标倍率只放大徽标底座与模型：片场组（badge_scale = 3）的尖角与普通组同形。
    for scale in [1., 2., 3.] {
        let mut scaled = node(1800., 320.);
        scaled.group.as_mut().unwrap().badge_scale = scale;
        let tail = tail_path(&scaled);
        assert!(
            (span(&tail) - TAIL_BASE).abs() < 0.001,
            "tail must stay {TAIL_BASE} wide at badgeScale {scale}"
        );
        assert!((tail[1].y - (scaled.y + scaled.height + BADGE_OUTSET)).abs() < 0.001);
    }
    // 比尾巴还窄的畸形组只会被裁到自身宽度，不会翻折。
    let mut narrow = node(12., 80.);
    narrow.width = 12.;
    let tail = tail_path(&narrow);
    assert!((span(&tail) - 12.).abs() < 0.001);
    assert!(
        tail.iter()
            .all(|point| point.x >= narrow.x - 0.001 && point.x <= narrow.x + narrow.width + 0.001)
    );
}

#[test]
fn missing_model_retains_structural_frame_and_has_no_orphan_badge() {
    let mut n = node(500., 300.);
    let path = outline(&n);
    n.model = None;
    assert!(for_node(&n).is_none());
    assert!(badge_path(&n).is_empty());
    assert_eq!(outline(&n), rectangle(&n));
    assert_ne!(outline(&n), path);
}

#[test]
fn model_content_does_not_change_badge_size_or_center() {
    let mut n = node(500., 300.);
    let badge = badge_path(&n);
    let center = for_node(&n).unwrap().center;
    for max in [[100., 0., 0.], [3., 100., -3.], [20., 30., 40.]] {
        n.group
            .as_mut()
            .unwrap()
            .model_bounds
            .as_mut()
            .unwrap()
            .aabb
            .max = max;
        assert_eq!(badge_path(&n), badge);
        assert_eq!(for_node(&n).unwrap().center, center);
    }
    let tail = tail_path(&n);
    let frame = frame_path(&n);
    assert!(
        frame
            .first()
            .is_some_and(|point| point.distance(tail[2]) < 0.001)
    );
    assert!(
        frame
            .last()
            .is_some_and(|point| point.distance(tail[2]) < 0.001)
    );
    assert!(
        frame
            .windows(2)
            .any(|pair| pair[0].distance(tail[2]) < 0.001 && pair[1].distance(tail[1]) < 0.001)
    );
    assert!(
        frame
            .windows(2)
            .any(|pair| pair[0].distance(tail[1]) < 0.001 && pair[1].distance(tail[0]) < 0.001)
    );
    let left = tail[0].x;
    let right = tail[2].x;
    let bottom = n.y + n.height;
    assert!(!frame.windows(2).any(|pair| {
        (pair[0].y - bottom).abs() < 0.001
            && (pair[1].y - bottom).abs() < 0.001
            && pair[0].x.min(pair[1].x) <= left + 0.001
            && pair[0].x.max(pair[1].x) >= right - 0.001
    }));
    assert!(path_contains(
        &outline(&n),
        Vec2::new(n.x + n.width / 2., n.y + n.height + BADGE_OUTSET / 2.)
    ));
}

#[test]
fn independent_badge_scale_keeps_centerline_and_preserves_aspect() {
    let mut n = node(600., 400.);
    let original = for_node(&n).unwrap();
    let base = badge_rect(&n);
    for scale in [0.5, 1., 2., 2.5, 6., 12., 250.] {
        n.group.as_mut().unwrap().badge_scale = scale;
        let next = for_node(&n).unwrap();
        let rect = badge_rect(&n);
        // 气泡与徽标永远中线对齐：水平中心固定在气泡中心，左右对称扩张；
        // 上缘固定，只向下增长。
        assert!((rect.x + rect.z / 2. - (n.x + n.width / 2.)).abs() < 0.001);
        assert!((rect.y - base.y).abs() < 0.001);
        assert!((rect.z - base.z * scale).abs() < 0.001);
        assert!((rect.w - base.w * scale).abs() < 0.001);
        assert!((next.center.x - (rect.x + rect.z / 2.)).abs() < 0.001);
        assert!((next.center.y - (rect.y + rect.w / 2.)).abs() < 0.001);
        assert!((next.radii.x / original.radii.x - scale).abs() < 0.001);
        assert!((next.radii.y / original.radii.y - scale).abs() < 0.001);
        assert!((rect.z / rect.w - base.z / base.w).abs() < 0.001);
        assert_eq!((n.width, n.height), (600., 400.));
    }
    n.width = 196.;
    n.height = 112.;
    let rect = badge_rect(&n);
    assert!((rect.y - (n.y + n.height + BADGE_OUTSET)).abs() < 0.001);
    // 徽标允许明显大于承载它的 group：片场场景就画在徽标里。
    n.width = 600.;
    n.height = 400.;
    n.group.as_mut().unwrap().badge_scale = 250.;
    assert!(badge_rect(&n).z > n.width);
    assert!((badge_rect(&n).z - badge_rect(&n).w * 88. / 64.).abs() < 0.001);
}
