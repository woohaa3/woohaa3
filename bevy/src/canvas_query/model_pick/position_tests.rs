use super::*;
use crate::canvas_query::interaction::{accept_positions, accept_scene, point_query};
use crate::protocol::{CANVAS_POSITION_UPDATE_VERSION, NodePosition, PositionUpdateRequest, Scene};

fn setup() -> (u32, Vec<ModelCandidate>) {
    let scene = Scene {
        nodes: serde_json::from_value(serde_json::json!([
            {"id":"m","type":"model","x":10,"y":20},
            {"id":"other","type":"text","x":500,"y":500}
        ]))
        .unwrap(),
        ..Default::default()
    };
    let base = accept_scene(&scene);
    let candidates = vec![
        ModelCandidate {
            node_id: "m".into(),
            shared_world: false,
            triangles: None,
            min: [-10.; 3],
            max: [10.; 3],
        },
        ModelCandidate {
            node_id: "other".into(),
            shared_world: false,
            triangles: None,
            min: [100.; 3],
            max: [120.; 3],
        },
    ];
    accept_models(
        candidates.clone(),
        base,
        ModelPickCamera {
            viewport: [12., 34., 2.],
            surface: [1000., 800.],
            ordinary: true,
        },
    );
    (base, candidates)
}

fn request(base: u32, x: f32, y: f32) -> PositionUpdateRequest {
    PositionUpdateRequest {
        version: CANVAS_POSITION_UPDATE_VERSION.into(),
        base_scene_generation: base,
        positions: vec![NodePosition {
            id: "m".into(),
            x,
            y,
        }],
        viewport: None,
    }
}

#[test]
fn absolute_moves_translate_only_affected_candidates_without_return_drift() {
    let (base, original) = setup();
    for i in 0..200 {
        let x = 10. + i as f32 * 0.13;
        let y = 20. - i as f32 * 0.17;
        let (generation, _) = accept_positions(&request(base, x, y)).unwrap();
        let delta = crate::isometric_grid::canvas_point_to_world(x - 10., y - 20., 0.);
        CANDIDATES.with(|slot| {
            let current = slot.borrow();
            assert_eq!(
                current[0].min,
                (bevy::math::Vec3::from_array(original[0].min) + delta).to_array()
            );
            assert_eq!(current[1], original[1]);
        });
        assert_eq!(GENERATION.with(std::cell::Cell::get), generation);
        assert!(point_query(generation, x, y, 1., None).available);
    }
    accept_positions(&request(base, 10., 20.)).unwrap();
    CANDIDATES.with(|slot| assert_eq!(*slot.borrow(), original));
}

#[test]
fn combined_viewport_updates_generation_and_position_only_preserves_camera() {
    let (base, _) = setup();
    let mut update = request(base, 30., 50.);
    update.viewport = Some(crate::protocol::Viewport {
        x: 90.,
        y: 80.,
        zoom: 0.5,
    });
    let (generation, _) = accept_positions(&update).unwrap();
    CAMERA.with(|slot| {
        assert_eq!(
            *slot.borrow(),
            ModelPickCamera {
                viewport: [90., 80., 0.5],
                surface: [1000., 800.]
                , ordinary: true
            }
        )
    });
    let stale = pick_query_json(&format!(
        r#"{{"generation":{base},"x":0,"y":0,"width":1000,"height":800}}"#
    ));
    assert!(stale.contains("stale"));
    let (next, _) = accept_positions(&request(base, 40., 60.)).unwrap();
    assert_ne!(next, generation);
    CAMERA.with(|slot| assert_eq!(slot.borrow().viewport, [90., 80., 0.5]));
}

#[test]
fn shared_world_candidate_ignores_card_position_updates() {
    let (base, mut original) = setup();
    original[0].shared_world = true;
    accept_models(original.clone(), base, ModelPickCamera::default());
    accept_positions(&request(base, 300., 400.)).unwrap();
    CANDIDATES.with(|slot| assert_eq!(slot.borrow()[0], original[0]));
}

#[test]
fn ground_query_uses_accepted_camera_and_rejects_stale_generation() {
    let (generation, _) = setup();
    let query = |generation, x: f32, y: f32| pick_query_json(&format!(
        r#"{{"kind":"ground","generation":{generation},"x":{x},"y":{y},"width":1000,"height":800}}"#
    ));
    let value: serde_json::Value = serde_json::from_str(&query(generation, 12., 34.)).unwrap();
    assert_eq!(value["ground"]["u"], 0.0);
    assert_eq!(value["ground"]["v"], 0.0);
    let view = crate::isometric_grid::IsometricGridView { x: 12., y: 34., zoom: 2. };
    let screen = crate::isometric_grid::screen_point_from_world(bevy::prelude::Vec3::new(128., 0., -192.), &view);
    let value: serde_json::Value = serde_json::from_str(&query(generation, screen.x, screen.y)).unwrap();
    assert!((value["ground"]["u"].as_f64().unwrap() - 2.).abs() < 1e-5);
    assert!((value["ground"]["v"].as_f64().unwrap() - 3.).abs() < 1e-5);
    assert!(query(generation.wrapping_add(1), 12., 34.).contains("stale"));
    CAMERA.with(|slot| slot.borrow_mut().ordinary = false);
    assert!(query(generation, 12., 34.).contains("unavailable"));
}

#[test]
fn model_overflow_rejects_all_query_changes_before_generation_advances() {
    let (base, _) = setup();
    let extreme = vec![ModelCandidate {
        node_id: "m".into(),
        shared_world: false,
        triangles: None,
        min: [f32::MAX; 3],
        max: [f32::MAX; 3],
    }];
    accept_models(extreme.clone(), base, ModelPickCamera::default());
    assert_eq!(
        accept_positions(&request(base, f32::MAX, 20.)).unwrap_err(),
        "Invalid model position geometry"
    );
    assert!(point_query(base, 20., 40., 1., None).available);
    assert_eq!(GENERATION.with(std::cell::Cell::get), base);
    CANDIDATES.with(|slot| assert_eq!(*slot.borrow(), extreme));
}
