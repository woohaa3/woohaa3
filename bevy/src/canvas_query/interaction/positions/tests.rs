use super::*;
use crate::canvas_query::interaction::snapshot::{apply_selection, build_snapshot};
use crate::canvas_query::interaction::{
    accept_positions, accept_scene, accept_viewport, base_generation, point_query,
};
use crate::protocol::{CANVAS_POSITION_UPDATE_VERSION, PositionUpdateRequest, Scene};

fn scene() -> Scene {
    Scene {
        nodes: serde_json::from_value(serde_json::json!([
            {"id":"a","type":"image","x":0,"y":0,"width":240,"height":180},
            {"id":"b","type":"text","x":400,"y":0,"width":240,"height":180},
            {"id":"c","type":"text","x":0,"y":500},
            {"id":"d","type":"text","x":400,"y":500}
        ])).unwrap(),
        edges: serde_json::from_value(serde_json::json!([
            {"id":"ab","source":"a","target":"b","label":"link"},
            {"id":"cd","source":"c","target":"d"}
        ])).unwrap(),
        selection: serde_json::from_value(serde_json::json!({"nodes":["a","b"]})).unwrap(),
        aggregate_connect: Some(serde_json::from_value(serde_json::json!({})).unwrap()),
        ..Default::default()
    }
}
fn request(base: u32, rows: &[(&str, f32, f32)]) -> PositionUpdateRequest {
    PositionUpdateRequest {
        version: CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: base,
        positions: rows
            .iter()
            .map(|&(id, x, y)| NodePosition {
                id: id.into(),
                x,
                y,
            })
            .collect(),
        viewport: None,
    }
}

#[test]
fn local_snapshot_matches_full_projection_and_retains_unrelated_edge_buffers() {
    let mut scene = scene();
    let mut snapshot = build_snapshot(&scene, 1);
    apply_selection(&mut snapshot, &scene.selection.nodes);
    let untouched = snapshot.edges[1].points.as_ptr();
    let untouched_node = snapshot.nodes[2].id.as_ptr();
    let updates = request(1, &[("a", 35., 70.), ("b", 450., 25.)]).positions;
    let deltas = apply(&mut snapshot, &updates).unwrap();
    assert_eq!(deltas.len(), 2);
    for p in &updates {
        let node = scene.nodes.iter_mut().find(|n| n.id == p.id).unwrap();
        node.x = p.x;
        node.y = p.y;
    }
    let mut expected = build_snapshot(&scene, 2);
    apply_selection(&mut expected, &scene.selection.nodes);
    assert_eq!(snapshot.edges[1].points.as_ptr(), untouched);
    assert_eq!(snapshot.nodes[2].id.as_ptr(), untouched_node);
    assert_eq!(snapshot.order, expected.order);
    assert_eq!(snapshot.aggregate_handles, expected.aggregate_handles);
    for (a, b) in snapshot.nodes.iter().zip(&expected.nodes) {
        assert_eq!(a.bounds, b.bounds);
        assert_eq!(a.center, b.center);
        assert_eq!(a.input_port, b.input_port);
        assert_eq!(a.output_port, b.output_port);
        assert_eq!(a.history_strip, b.history_strip);
        assert_eq!(a.resize, b.resize);
    }
    for (a, b) in snapshot.edges.iter().zip(&expected.edges) {
        assert_eq!(a.points, b.points);
        assert_eq!(a.aabb, b.aabb);
    }
    for x in (0..1500).step_by(15) {
        for y in (0..750).step_by(15) {
            let p = Vec2::new(x as f32, y as f32);
            assert_eq!(
                snapshot.point_hit(p, 1., Some("ab")),
                expected.point_hit(p, 1., Some("ab"))
            );
        }
    }
    assert_eq!(
        snapshot.marquee(20., 50., 250., 220.),
        expected.marquee(20., 50., 250., 220.)
    );
}

#[test]
fn accepts_interleaved_viewport_positions_and_rejects_old_base_atomically() {
    let original = scene();
    let base = accept_scene(&original);
    let view = accept_viewport(base, Default::default()).unwrap();
    let (moved, _) = accept_positions(&request(base, &[("a", 30., 30.)])).unwrap();
    assert_ne!(view, moved);
    assert_eq!(base_generation(), base);
    assert!(point_query(view, 50., 50., 1., None).reason.as_deref() == Some("stale"));
    let hit = point_query(moved, 50., 80., 1., None);
    assert!(hit.available);
    let failed = accept_positions(&request(base, &[("a", 300., 300.), ("gone", 0., 0.)]));
    assert_eq!(failed.unwrap_err(), "Unknown position node");
    assert_eq!(point_query(moved, 50., 80., 1., None).hit, hit.hit);
    assert!(point_query(moved, 50., 80., 1., None).available);
    let duplicate = accept_positions(&request(base, &[("a", 20., 20.), ("a", 40., 40.)]));
    assert_eq!(duplicate.unwrap_err(), "Duplicate position node");
    let bad = accept_positions(&request(base, &[("a", f32::INFINITY, 0.)]));
    assert_eq!(bad.unwrap_err(), "Invalid position values");
    assert!(point_query(moved, 50., 80., 1., None).available);
    let replacement = accept_scene(&original);
    assert_eq!(
        accept_positions(&request(base, &[("a", 0., 0.)])).unwrap_err(),
        "stale-base"
    );
    assert!(point_query(replacement, 50., 80., 1., None).available);
}

#[test]
fn invalid_derived_geometry_does_not_commit_an_earlier_valid_row() {
    let mut original = scene();
    original.nodes[1].x = -f32::MAX;
    let base = accept_scene(&original);
    assert_eq!(
        accept_positions(&request(base, &[("a", 30., 30.), ("b", f32::MAX, 0.)])).unwrap_err(),
        "Invalid position delta"
    );
    assert!(point_query(base, 50., 80., 1., None).available);
}

#[test]
fn video_focus_does_not_accept_overview_increments() {
    let mut original = scene();
    original.video_focus = Some(
        serde_json::from_value(serde_json::json!({
            "version":"woohaa-video-focus-v1","nodeId":"a","viewport":{"x":0,"y":0,"zoom":1},
            "sourceWidth":640,"sourceHeight":480
        }))
        .unwrap(),
    );
    let base = accept_scene(&original);
    assert_eq!(
        accept_positions(&request(base, &[("a", 30., 30.)])).unwrap_err(),
        "not-overview"
    );
    assert_eq!(
        accept_viewport(base, Default::default()).unwrap_err(),
        "not-overview"
    );
}
