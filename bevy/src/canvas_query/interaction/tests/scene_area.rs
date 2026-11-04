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
