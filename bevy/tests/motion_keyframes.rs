//! JavaScript recorder 产出的同一份跑酷 IR 经 Rust 验证、采样与属性合成。
use bevy::prelude::*;
use woohaa_bevy_canvas::motion::{
    InitialCameraState, ModelDelta, RawModelTrack, evaluate, validate,
};

fn initial() -> InitialCameraState {
    InitialCameraState {
        azimuth: 0.0,
        elevation: 0.0,
        distance: 8.0,
        focus_offset: Vec3::ZERO,
    }
}

fn fixture() -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parkour-motion.json")).unwrap()).unwrap()
}

fn sample(time: f32) -> ModelDelta {
    let value = fixture();
    let tracks: Vec<RawModelTrack> = serde_json::from_value(value["modelMotion"].clone()).unwrap();
    let ir = validate("woohaa-motion-ir-v1", vec![], tracks, 12.0).unwrap();
    let (_, values) = evaluate(&ir, time, initial());
    assert_eq!(values.len(), 1, "一套人物，一个合成的变换");
    assert_eq!(values[0].0, "root");
    values[0].1
}

#[test]
fn javascript_parkour_ir_runs_jumps_turns_and_stops_on_one_target() {
    assert_eq!(sample(2.0).translation, Vec3::new(4.0, 0.0, 0.0));
    assert_eq!(sample(3.0).translation, Vec3::new(6.0, 3.0, 0.0));
    assert_eq!(sample(4.0).translation, Vec3::new(8.0, 1.0, 0.0));
    let landing = sample(8.0);
    assert_eq!(landing.translation, Vec3::new(16.0, 3.0, 0.0));
    assert!(
        landing
            .rotation
            .abs_diff_eq(Quat::from_rotation_y(1.57), 1e-5)
    );
    assert_eq!(sample(12.0).translation, landing.translation);
    assert!(sample(12.0).rotation.abs_diff_eq(landing.rotation, 1e-6));
    assert_eq!(sample(0.0).translation, Vec3::ZERO);
}

#[test]
fn adjacent_tracks_use_chronological_order_and_keep_other_properties() {
    let tracks: Vec<RawModelTrack> = serde_json::from_value(serde_json::json!([
        {"targetId":"root","startTime":2,"endTime":4,"motion":{"kind":"keyframes","property":"position","frames":[{"time":2,"value":[2,0,0]},{"time":4,"value":[4,1,0]}]}},
        {"targetId":"root","startTime":0,"endTime":4,"motion":{"kind":"keyframes","property":"scale","frames":[{"time":0,"value":[1,1,1]},{"time":4,"value":[2,2,2]}]}},
        {"targetId":"root","startTime":0,"endTime":4,"motion":{"kind":"keyframes","property":"rotation","frames":[{"time":0,"value":[0,0,0],"easing":"smoothstep"},{"time":4,"value":[0.4,0.8,1.2]}]}},
        {"targetId":"root","startTime":0,"endTime":2,"motion":{"kind":"keyframes","property":"position","frames":[{"time":0,"value":[0,0,0]},{"time":2,"value":[2,0,0]}]}}
    ])).unwrap();
    let ir = validate("woohaa-motion-ir-v1", vec![], tracks, 12.0).unwrap();
    let middle = evaluate(&ir, 1.0, initial()).1[0].1;
    assert!(middle.rotation.abs_diff_eq(
        Quat::from_euler(EulerRot::YXZ, 0.8 * 0.15625, 0.4 * 0.15625, 1.2 * 0.15625),
        1e-5
    ));
    let end = evaluate(&ir, 10.0, initial()).1[0].1;
    assert_eq!(end.translation, Vec3::new(4.0, 1.0, 0.0));
    assert_eq!(end.scale, Vec3::splat(2.0));
    assert!(
        end.rotation
            .abs_diff_eq(Quat::from_euler(EulerRot::YXZ, 0.8, 0.4, 1.2), 1e-5)
    );
}

#[test]
fn overlapping_property_and_invalid_frames_are_rejected() {
    for frames in [
        serde_json::json!([{ "time":0, "value":[0,0,0] }, { "time":0, "value":[1,0,0] }]),
        serde_json::json!([{ "time":0, "value":[0,0,0] }, { "time":3, "value":[1,0,0] }]),
    ] {
        let tracks: Vec<RawModelTrack> = serde_json::from_value(serde_json::json!([{"targetId":"root","startTime":0,"endTime":2,"motion":{"kind":"keyframes","property":"position","frames":frames}}])).unwrap();
        assert_eq!(
            validate("woohaa-motion-ir-v1", vec![], tracks, 4.0)
                .unwrap_err()
                .code,
            "invalid-motion"
        );
    }
    let mut value = fixture()["modelMotion"].as_array().unwrap().clone();
    value.push(value[0].clone());
    let tracks = serde_json::from_value(serde_json::Value::Array(value)).unwrap();
    assert_eq!(
        validate("woohaa-motion-ir-v1", vec![], tracks, 8.0)
            .unwrap_err()
            .code,
        "overlapping-model-track"
    );
}
