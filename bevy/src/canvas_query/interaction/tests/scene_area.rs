//! 导演区边框胶囊标签的几何与命中测试。
//!
//! 标签贴在 3D 线框投影后的上边框并沿边框倾斜；命中矩形复用同一几何，
//! 因此「画在哪、点在哪」必须一致，点标签等同于点导演区节点。

use super::*;
use crate::protocol::{SceneArea, SceneAreaBounds, SceneAreaPoint};

fn area() -> SceneArea {
    SceneArea {
        node_id: "area".into(),
        title: "大厅".into(),
        playback: None,
        bounds: SceneAreaBounds {
            min: SceneAreaPoint { u: -2.0, v: -2.0 },
            max: SceneAreaPoint { u: 2.0, v: 2.0 },
        },
    }
}

#[test]
fn scene_area_label_sits_on_the_lower_left_projected_edge_and_is_diagonal() {
    let geometry = crate::canvas_query::layout::scene_area_label_geometry(&area())
        .expect("label geometry");
    assert!(geometry.width > 0.0 && geometry.height > 0.0);
    assert!((geometry.axis.length() - 1.0).abs() < 1e-4);
    // 等距投影下地面轴边斜着落在屏幕上（不是水平/竖直）。
    assert!(geometry.axis.y.abs() > 0.1);
    // 导演区以原点为中心：左下边的中点必须位于左下方（x<0, y>0）。
    assert!(geometry.center.x < 0.0);
    assert!(geometry.center.y > 0.0);
    let layout = crate::canvas_query::layout::scene_area_label_outline(&geometry);
    assert!(layout.len() >= 18);
    assert!(layout.iter().all(|point| point.x.is_finite() && point.y.is_finite()));
}

#[test]
fn clicking_the_scene_area_label_selects_that_area() {
    clear_snapshot();
    let mut scene = scene(vec![], vec![]);
    scene.scene_areas = vec![area()];
    let generation = accept_scene(&scene);
    let geometry = crate::canvas_query::layout::scene_area_label_geometry(&scene.scene_areas[0])
        .expect("label geometry");
    assert_eq!(
        point_query(generation, geometry.center.x, geometry.center.y, 1.0, None).hit,
        Some(PointHit::Node {
            node_id: "area".into()
        })
    );
    // 标签中心明显在导演区边框之内，而不是整块画布任意点都能命中。
    assert_ne!(point_query(generation, geometry.center.x, geometry.center.y - 80.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "area".into() }));
}

#[test]
fn scene_areas_without_title_fall_back_to_the_area_label() {
    let mut area = area();
    area.title.clear();
    let geometry = crate::canvas_query::layout::scene_area_label_geometry(&area).expect("geometry");
    // 几何不依赖标题；空标题由绘制侧回退为「导演区」。
    assert!(geometry.width > 0.0);
}

#[test]
fn workflow_group_label_selects_group_outside_the_frame() {
    clear_snapshot();
    let node = serde_json::from_value(serde_json::json!({
        "id":"g", "type":"workflow-group-2d", "x":0,"y":0,"width":300,"height":200,
        "chrome":{"kind":"frame","groupId":"g","memberNodeIds":[]}
    })).unwrap();
    let scene = scene(vec![node], vec![]);
    let generation = accept_scene(&scene);
    let geometry = crate::canvas_query::layout::workflow_group_label_geometry(&scene.nodes[0]).unwrap();
    assert_eq!(point_query(generation, geometry.center.x, geometry.center.y - 5.0, 1.0, None).hit,
        Some(PointHit::Node { node_id: "g".into() }));
}

#[test]
fn workflow_frame_only_hits_perimeter_leaving_interior_for_members_and_marquee() {
    clear_snapshot();
    let frame = serde_json::from_value(serde_json::json!({
        "id":"g", "type":"workflow-group-2d", "x":0,"y":0,"width":300,"height":200,
        "chrome":{"kind":"frame","groupId":"g","memberNodeIds":["m"]}
    })).unwrap();
    let member = serde_json::from_value(serde_json::json!({
        "id":"m", "type":"image", "x":50,"y":50,"width":180,"height":100
    })).unwrap();
    let scene = scene(vec![member, frame], vec![]);
    let generation = accept_scene(&scene);
    assert_eq!(point_query(generation, 100., 80., 1., None).hit,
        Some(PointHit::Node { node_id: "m".into() }));
    assert_eq!(point_query(generation, 260., 100., 1., None).hit, None);
    for zoom in [0.5, 1., 2.] {
        for x in [-5. / zoom, 5. / zoom] {
            assert_eq!(point_query(generation, x, 100., zoom, None).hit,
                Some(PointHit::Node { node_id: "g".into() }));
        }
        assert_eq!(point_query(generation, -8. / zoom, 100., zoom, None).hit, None);
    }
}

#[test]
fn scope_titles_compensate_only_when_zoomed_out_and_have_room() {
    use crate::canvas_query::layout;
    let group = |width| serde_json::from_value::<GraphNode>(serde_json::json!({
        "id":"g", "type":"workflow-group-2d", "x":0,"y":0,"width":width,"height":1000,
        "chrome":{"kind":"frame","groupId":"g","memberNodeIds":[]}
    })).unwrap();
    let large = group(5000.0);
    let base = layout::workflow_group_label_geometry_for_zoom(&large, 1.0).unwrap();
    assert_eq!((base.width, base.height), (200.0, 22.0));
    for zoom in [0.1, 0.2, 0.5, 0.8, 1.0, 2.0, 12.0] {
        let g = layout::workflow_group_label_geometry_for_zoom(&large, zoom).unwrap();
        assert!((g.height * zoom - (22.0 * zoom).max(18.0)).abs() < 0.001);
        assert!((g.width / g.height - base.width / base.height).abs() < 0.001);
        assert!(g.width <= large.width * 0.72);
        assert!((g.center.x - g.width / 2.0 - 12.0).abs() < 0.001);
        if zoom >= 1.0 { assert_eq!(g, base); }
    }
    let small = group(200.0);
    let tiny = layout::workflow_group_label_geometry_for_zoom(&small, 0.1).unwrap();
    assert_eq!(tiny.height, 22.0, "a tiny overview scope must not acquire an oversized title");
    let mut area = area();
    area.bounds.max.u = 200.0;
    area.bounds.max.v = 200.0;
    let a = layout::scene_area_label_geometry_for_zoom(&area, 1.0).unwrap();
    let b = layout::scene_area_label_geometry_for_zoom(&area, 0.1).unwrap();
    assert_eq!(a.center, b.center);
    assert_eq!(a.axis, b.axis);
    assert!((b.height * 0.1 - 18.0).abs() < 0.001);
}

#[test]
fn scope_title_hits_follow_viewport_and_position_increments() {
    use crate::canvas_query::layout;
    clear_snapshot();
    let group: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"g", "type":"workflow-group-2d", "x":0,"y":0,"width":5000,"height":1000,
        "chrome":{"kind":"frame","groupId":"g","memberNodeIds":[]}
    })).unwrap();
    let mut s = scene(vec![group], vec![]);
    let mut area = area();
    area.bounds.max.u = 200.0;
    area.bounds.max.v = 200.0;
    s.scene_areas = vec![area];
    let base = accept_scene(&s);
    let large = layout::workflow_group_label_geometry_for_zoom(&s.nodes[0], 0.1).unwrap();
    let probe = Vec2::new(large.center.x, -large.height * 0.4);
    assert_eq!(point_query(base, probe.x, probe.y, 1.0, None).hit, None);
    let view = crate::protocol::Viewport { x: 30.0, y: 50.0, zoom: 0.1 };
    let generation = accept_viewport(base, view).unwrap();
    assert_eq!(point_query(generation, probe.x, probe.y, 0.1, None).hit,
        Some(PointHit::Node { node_id: "g".into() }));
    let area_g = layout::scene_area_label_geometry_for_zoom(&s.scene_areas[0], 0.1).unwrap();
    let area_probe = area_g.center + area_g.axis * (area_g.width * 0.4);
    assert_eq!(point_query(generation, area_probe.x, area_probe.y, 0.1, None).hit,
        Some(PointHit::Node { node_id: "area".into() }));
    let (generation, _) = accept_positions(&crate::protocol::PositionUpdateRequest {
        version: crate::protocol::CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: base,
        positions: vec![crate::protocol::NodePosition { id: "g".into(), x: 100.0, y: 500.0 }],
        viewport: None,
    }).unwrap();
    assert_eq!(point_query(generation, probe.x + 100.0, probe.y + 500.0, 0.1, None).hit,
        Some(PointHit::Node { node_id: "g".into() }));
    assert_eq!(point_query(generation, probe.x, probe.y, 0.1, None).hit, None);
}

#[test]
fn scene_area_player_queries_share_the_lower_right_render_geometry() {
    clear_snapshot();
    let mut scene = scene(vec![], vec![]);
    let mut scope = area();
    assert!(crate::canvas_query::scene_area_player::geometry(&scope, 1.0).is_none());
    scope.playback = Some(crate::protocol::SceneAreaPlayback {
        time: 1.0,
        duration: 4.0,
        playing: false,
        r#loop: true,
    });
    scene.scene_areas = vec![scope];
    for zoom in [0.3, 1.0, 3.0] {
        scene.viewport.zoom = zoom;
        let generation = accept_scene(&scene);
        let geometry =
            crate::canvas_query::scene_area_player::geometry(&scene.scene_areas[0], zoom).unwrap();
        assert!(geometry.center.x > 0.0 && geometry.center.y > 0.0);
        assert!(geometry.axis.y.abs() > 0.1);
        let (a, b) = crate::canvas_query::scene_area_player::track(&geometry);
        for (control, x) in [("play", -108.0), ("track", -40.0), ("loop", 108.0)] {
            let point = geometry.center + geometry.axis * (x * geometry.scale());
            assert_eq!(
                point_query(generation, point.x, point.y, zoom, None).hit,
                Some(PointHit::SceneAreaPlayback {
                    node_id: "area".into(),
                    control: control.into(),
                    track: [a.x, a.y, b.x, b.y]
                })
            );
        }
    }
}
