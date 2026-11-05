use super::*;

#[test]
fn back_faces_only_pick_when_material_is_double_sided() {
    let mut face = SurfaceTriangle { vertices: [[-1., -1., 0.], [1., -1., 0.], [0., 1., 0.]], cull_back: true };
    let origin = bevy::prelude::Vec3::new(0., 0., -1.);
    let direction = bevy::prelude::Vec3::Z;
    assert!(ray_triangle(origin, direction, &face).is_none());
    face.cull_back = false;
    assert!(ray_triangle(origin, direction, &face).is_some());
}

#[test]
fn shared_pick_uses_surface_depth_and_preserves_gaps() {
    use bevy::prelude::Vec3;
    let candidate = |id: &str, z: f32| ModelCandidate {
        node_id: id.into(), shared_world: true, empty_marker: false, min: [-2., -2., 0.], max: [2., 2., 10.],
        triangles: Some(std::sync::Arc::new(vec![SurfaceTriangle { vertices: [[-1., -1., z], [1., -1., z], [0., 1., z]], cull_back: false }])),
    };
    let candidates = vec![candidate("back", 7.), candidate("front", 3.)];
    assert_eq!(pick_candidates(&candidates, Vec3::ZERO, Vec3::Z, 20.).unwrap().0, "front");
    assert!(pick_candidates(&candidates, Vec3::new(1.5, 1.5, 0.), Vec3::Z, 20.).is_none());
}

#[test]
fn ray_hits_aabb_matches_slab_semantics() {
    // 正前方命中。
    assert_eq!(
        ray_hits_aabb([0.0, 0.0, 5.0], [0.0, 0.0, -1.0], [-1.0; 3], [1.0; 3]),
        Some(4.0)
    );
    // 背后不命中。
    assert_eq!(
        ray_hits_aabb([0.0, 0.0, 5.0], [0.0, 0.0, 1.0], [-1.0; 3], [1.0; 3]),
        None
    );
    // 平行且在区间外不命中。
    assert_eq!(
        ray_hits_aabb([5.0, 0.0, 0.0], [0.0, 0.0, -1.0], [-1.0; 3], [1.0; 3]),
        None
    );
}

/// 默认 viewport 快照（原点、zoom=1）。
fn origin_view() -> [f32; 3] {
    [0.0, 0.0, 1.0]
}

#[test]
fn pick_nearest_uses_screen_mapping_and_depth() {
    // AABB 落在指针屏幕点对应的 near 平面世界位置附近：判定 picking 使用同一相机映射。
    let view = origin_view();
    let near = crate::isometric_grid::canvas_camera_projection().near;
    let center = crate::isometric_grid::screen_point_to_world(
        bevy::prelude::Vec2::new(100.0, 100.0),
        CANVAS_CAMERA_Z - near,
        &crate::isometric_grid::IsometricGridView::default(),
    );
    let half = 5.0;
    let near_min = [center.x - half, center.y - half, center.z - half];
    let near_max = [center.x + half, center.y + half, center.z + half];
    let far_min = [center.x + 400.0, center.y, center.z];
    let far_max = [center.x + 500.0, center.y + 100.0, center.z + 100.0];
    let candidates: Vec<(&str, [f32; 3], [f32; 3])> =
        vec![("a", near_min, near_max), ("b", far_min, far_max)];
    assert_eq!(
        pick_nearest(&candidates, (1000.0, 800.0), (100.0, 100.0), view).map(|hit| hit.0),
        Some("a".to_owned())
    );
    // 远离任何候选的屏幕点不命中。
    assert!(pick_nearest(&candidates, (1000.0, 800.0), (900.0, 750.0), view).is_none());
}

#[test]
fn pick_nearest_covers_geometry_along_visible_depth() {
    // near 平面起点上的 AABB 命中距离为零；沿射线在 far 范围内的几何可命中；
    // 完全超出 far 范围的 AABB 不命中（负 near 允许相机两侧几何）。
    let view = origin_view();
    let near = crate::isometric_grid::canvas_camera_projection().near;
    let far = crate::isometric_grid::canvas_camera_projection().far;
    let max_t = far - near;
    let direction = crate::isometric_grid::canvas_camera_rotation() * bevy::prelude::Vec3::NEG_Z;
    let origin = crate::isometric_grid::screen_point_to_world(
        bevy::prelude::Vec2::new(250.0, 180.0),
        CANVAS_CAMERA_Z - near,
        &crate::isometric_grid::IsometricGridView::default(),
    );
    let aabb = |center: bevy::prelude::Vec3| {
        (
            [center.x - 5.0, center.y - 5.0, center.z - 5.0],
            [center.x + 5.0, center.y + 5.0, center.z + 5.0],
        )
    };
    let containing = aabb(origin);
    let hit: Vec<(&str, [f32; 3], [f32; 3])> = vec![("at-near", containing.0, containing.1)];
    assert_eq!(
        pick_nearest(&hit, (1000.0, 800.0), (250.0, 180.0), view).map(|hit| hit.0),
        Some("at-near".to_owned())
    );
    // 沿射线在可见范围内（远离 near 平面）的几何可命中。
    let mid = aabb(origin + direction * 1000.0);
    let visible: Vec<(&str, [f32; 3], [f32; 3])> = vec![("mid", mid.0, mid.1)];
    assert_eq!(
        pick_nearest(&visible, (1000.0, 800.0), (250.0, 180.0), view).map(|hit| hit.0),
        Some("mid".to_owned())
    );
    // 超出 far 平面（max_t 之外）。
    let too_far = aabb(origin + direction * (max_t + 1000.0));
    let out: Vec<(&str, [f32; 3], [f32; 3])> = vec![("far", too_far.0, too_far.1)];
    assert!(pick_nearest(&out, (1000.0, 800.0), (250.0, 180.0), view).is_none());
}

#[test]
fn center_radius_from_aabb() {
    let (center, radius) = center_radius([-1.0, -1.0, -1.0], [1.0, 1.0, 1.0]);
    assert_eq!(center, [0.0, 0.0, 0.0]);
    assert!((radius - 3f32.sqrt()).abs() < 1e-4);
}

#[test]
fn pick_query_respects_generation_and_emptiness() {
    // 把候选放在屏幕点 (100,100) 的射线命中处（相机映射与 picking 同源）。
    let near = crate::isometric_grid::canvas_camera_projection().near;
    let center = crate::isometric_grid::screen_point_to_world(
        bevy::prelude::Vec2::new(100.0, 100.0),
        CANVAS_CAMERA_Z - near,
        &crate::isometric_grid::IsometricGridView::default(),
    );
    accept_models(
        vec![ModelCandidate {
            shared_world: false, empty_marker: false,
            triangles: None,
            node_id: "m".into(),
            min: [center.x - 5.0, center.y - 5.0, center.z - 5.0],
            max: [center.x + 5.0, center.y + 5.0, center.z + 5.0],
        }],
        5,
        ModelPickCamera {
            viewport: origin_view(),
            surface: [1000.0, 800.0],
            ordinary: true,
            focus: None,
        },
    );
    // 命中。
    let hit =
        pick_query_json("{\"generation\":5,\"x\":100,\"y\":100,\"width\":1000,\"height\":800}");
    assert!(hit.contains("\"nodeId\":\"m\""));
    // 空白处 available 但无命中。
    let miss =
        pick_query_json("{\"generation\":5,\"x\":900,\"y\":750,\"width\":1000,\"height\":800}");
    assert!(miss.contains("\"available\":true"));
    assert!(miss.contains("\"nodeId\":null"));
    // 旧 generation → stale。
    let stale =
        pick_query_json("{\"generation\":4,\"x\":100,\"y\":100,\"width\":1000,\"height\":800}");
    assert!(stale.contains("\"available\":false"));
    assert!(stale.contains("stale"));
}
