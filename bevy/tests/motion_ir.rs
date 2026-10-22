//! 动画运动 IR 求值与校验集成测试
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.2/4.3）。
//!
//! 这些断言与 contracts `motion-ir.test.ts` 使用同一组输入与期望，保证浏览器与原生
//! renderer 的求值语义一致。

use bevy::prelude::*;
use woohaa_bevy_canvas::motion::{
    Axis3, InitialCameraState, ModelMotion, OscillateMode, RawCameraTrack, RawModelTrack, evaluate,
    validate,
};

fn initial_camera() -> InitialCameraState {
    InitialCameraState {
        azimuth: 0.0,
        elevation: std::f32::consts::FRAC_PI_4,
        distance: 8.0,
        focus_offset: Vec3::ZERO,
    }
}

fn camera_track(
    property: &str,
    start: f32,
    end: f32,
    from: f32,
    to: f32,
    easing: &str,
) -> RawCameraTrack {
    RawCameraTrack {
        property: property.to_owned(),
        start_time: Some(start),
        end_time: Some(end),
        from,
        to,
        easing: Some(easing.to_owned()),
    }
}

fn model_track(target: &str, start: f32, end: f32, motion: ModelMotion) -> RawModelTrack {
    RawModelTrack {
        target_id: target.to_owned(),
        start_time: Some(start),
        end_time: Some(end),
        motion: raw_motion(motion),
    }
}

fn raw_motion(motion: ModelMotion) -> woohaa_bevy_canvas::motion::RawModelMotion {
    use woohaa_bevy_canvas::motion::RawModelMotion;
    match motion {
        ModelMotion::Keyframes { .. } => panic!("legacy fixture"),
        ModelMotion::Rotate { axis, speed } => RawModelMotion {
            kind: "rotate".to_owned(),
            axis: Some(axis_name(axis).to_owned()),
            speed: Some(speed),
            range: None,
            mode: None,
            amplitude: None,
            phase: None,
            ..Default::default()
        },
        ModelMotion::Move { axis, speed, range } => RawModelMotion {
            kind: "move".to_owned(),
            axis: Some(axis_name(axis).to_owned()),
            speed: Some(speed),
            range: Some(range),
            mode: None,
            amplitude: None,
            phase: None,
            ..Default::default()
        },
        ModelMotion::Oscillate {
            axis,
            mode,
            speed,
            amplitude,
            phase,
        } => RawModelMotion {
            kind: "oscillate".to_owned(),
            axis: Some(axis_name(axis).to_owned()),
            speed: Some(speed),
            range: None,
            mode: Some(mode_name(mode).to_owned()),
            amplitude: Some(amplitude),
            phase: Some(phase),
            ..Default::default()
        },
    }
}

fn axis_name(axis: Axis3) -> &'static str {
    match axis {
        Axis3::X => "x",
        Axis3::Y => "y",
        Axis3::Z => "z",
    }
}

fn mode_name(mode: OscillateMode) -> &'static str {
    match mode {
        OscillateMode::Position => "position",
        OscillateMode::Rotation => "rotation",
        OscillateMode::Scale => "scale",
    }
}

#[test]
fn evaluates_camera_from_initial_state() {
    let ir = validate(
        "woohaa-motion-ir-v1",
        vec![camera_track("azimuth", 0.0, 4.0, 0.0, 4.0, "linear")],
        vec![],
        4.0,
    )
    .expect("valid motion");
    let (camera, model) = evaluate(&ir, 2.0, initial_camera());
    assert!((camera.azimuth - 2.0).abs() < 1e-5);
    assert!((camera.distance - 8.0).abs() < 1e-5);
    assert!(model.is_empty());
}

#[test]
fn camera_track_holds_end_value_and_does_not_apply_before_start() {
    let ir = validate(
        "woohaa-motion-ir-v1",
        vec![camera_track("distance", 2.0, 3.0, 1.0, 5.0, "linear")],
        vec![],
        4.0,
    )
    .unwrap();
    let before = evaluate(&ir, 1.0, initial_camera()).0;
    assert_eq!(before.distance, 8.0);
    let after = evaluate(&ir, 3.5, initial_camera()).0;
    assert_eq!(after.distance, 5.0);
}

#[test]
fn smoothstep_easing_matches_contract_shape() {
    let ir = validate(
        "woohaa-motion-ir-v1",
        vec![camera_track("azimuth", 0.0, 4.0, 0.0, 4.0, "smoothstep")],
        vec![],
        4.0,
    )
    .unwrap();
    // 2 秒处 t=0.5 → smoothstep=0.5，与 linear 相同。
    assert!((evaluate(&ir, 2.0, initial_camera()).0.azimuth - 2.0).abs() < 1e-5);
    // 1 秒处 t=0.25 → 0.25^2*(3-0.5)=0.15625 → 0.625。
    assert!((evaluate(&ir, 1.0, initial_camera()).0.azimuth - 0.625).abs() < 1e-5);
}

#[test]
fn evaluates_model_tracks_and_holds_terminal_state() {
    let ir = validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![
            model_track(
                "body",
                0.0,
                4.0,
                ModelMotion::Rotate {
                    axis: Axis3::Y,
                    speed: 0.5,
                },
            ),
            model_track(
                "left-hand",
                1.0,
                4.0,
                ModelMotion::Oscillate {
                    axis: Axis3::Z,
                    mode: OscillateMode::Rotation,
                    speed: 6.0,
                    amplitude: 0.4,
                    phase: 0.0,
                },
            ),
        ],
        4.0,
    )
    .unwrap();

    let (_, model) = evaluate(&ir, 2.0, initial_camera());
    let body = find_delta(&model, "body");
    let expected_half = 1.0f32 / 2.0;
    assert!((body.rotation.y - expected_half.sin()).abs() < 1e-5);
    assert!((body.rotation.w - expected_half.cos()).abs() < 1e-5);

    // 未开始前 left-hand 不生效。
    let (_, early) = evaluate(&ir, 0.5, initial_camera());
    assert!(find_delta_opt(&early, "left-hand").is_none());
}

#[test]
fn rejects_overlapping_camera_tracks_but_allows_adjacent() {
    let overlap = validate(
        "woohaa-motion-ir-v1",
        vec![
            camera_track("azimuth", 0.0, 3.0, 0.0, 1.0, "linear"),
            camera_track("azimuth", 2.0, 4.0, 1.0, 2.0, "linear"),
        ],
        vec![],
        4.0,
    );
    assert!(overlap.is_err());

    let adjacent = validate(
        "woohaa-motion-ir-v1",
        vec![
            camera_track("azimuth", 0.0, 2.0, 0.0, 1.0, "linear"),
            camera_track("azimuth", 2.0, 4.0, 1.0, 2.0, "linear"),
        ],
        vec![],
        4.0,
    );
    assert!(adjacent.is_ok());
}

#[test]
fn rejects_duplicate_model_target_and_out_of_range_time() {
    let duplicate = validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![
            model_track(
                "body",
                0.0,
                4.0,
                ModelMotion::Rotate {
                    axis: Axis3::Y,
                    speed: 1.0,
                },
            ),
            model_track(
                "body",
                0.0,
                4.0,
                ModelMotion::Rotate {
                    axis: Axis3::Y,
                    speed: 1.0,
                },
            ),
        ],
        4.0,
    );
    assert_eq!(duplicate.unwrap_err().code, "overlapping-model-track");

    let out_of_range = validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![model_track(
            "body",
            0.0,
            9.0,
            ModelMotion::Rotate {
                axis: Axis3::Y,
                speed: 1.0,
            },
        )],
        4.0,
    );
    assert_eq!(out_of_range.unwrap_err().code, "track-out-of-range");
}

#[test]
fn rejects_unknown_version_and_inverted_time() {
    assert_eq!(
        validate("other", vec![], vec![], 4.0).unwrap_err().code,
        "version-mismatch"
    );
    let inverted = validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![model_track(
            "body",
            3.0,
            3.0,
            ModelMotion::Rotate {
                axis: Axis3::Y,
                speed: 1.0,
            },
        )],
        4.0,
    );
    assert_eq!(inverted.unwrap_err().code, "invalid-time-range");
}

#[test]
fn distinct_parts_do_not_interfere_and_bounds_are_enforced() {
    let ir = validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![
            model_track(
                "a",
                0.0,
                4.0,
                ModelMotion::Rotate {
                    axis: Axis3::X,
                    speed: 1.0,
                },
            ),
            model_track(
                "b",
                0.0,
                4.0,
                ModelMotion::Move {
                    axis: Axis3::Y,
                    speed: 1.0,
                    range: [0.0, 2.0],
                },
            ),
        ],
        4.0,
    )
    .unwrap();
    let (_, model) = evaluate(&ir, 1.0, initial_camera());
    assert_eq!(model.len(), 2);
    let moved = find_delta(&model, "b");
    assert!((moved.translation.y - 1.0).abs() < 1e-5);
    let rotated = find_delta(&model, "a");
    assert_eq!(rotated.translation, Vec3::ZERO);

    let too_many: Vec<RawCameraTrack> = (0..300)
        .map(|i| {
            camera_track(
                "azimuth",
                i as f32 * 0.01,
                i as f32 * 0.01 + 0.005,
                0.0,
                1.0,
                "linear",
            )
        })
        .collect();
    assert_eq!(
        validate("woohaa-motion-ir-v1", too_many, vec![], 3600.0)
            .unwrap_err()
            .code,
        "too-many-tracks"
    );
}

fn find_delta(
    model: &[(String, woohaa_bevy_canvas::motion::ModelDelta)],
    id: &str,
) -> woohaa_bevy_canvas::motion::ModelDelta {
    find_delta_opt(model, id).expect("delta exists")
}

fn find_delta_opt(
    model: &[(String, woohaa_bevy_canvas::motion::ModelDelta)],
    id: &str,
) -> Option<woohaa_bevy_canvas::motion::ModelDelta> {
    model
        .iter()
        .find(|(target, _)| target == id)
        .map(|(_, delta)| *delta)
}
