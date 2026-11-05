use super::*;

fn request(version: &str) -> RenderRequest {
    RenderRequest {
        protocol_version: RENDERER_PROTOCOL_VERSION.to_owned(),
        request_id: "req-1".to_owned(),
        scene_version: version.to_owned(),
        signature: "sig".to_owned(),
        extent: 2.0,
        ops: vec![ModelOp::Group {
            id: "root".to_owned(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
        }],
        capture: CaptureOptions::default(),
        placement: None,
        motion: None,
        world: None,
    }
}

#[test]
fn accepts_v2_and_rejects_v1() {
    assert!(validate_request(&request("woohaa-model-scene-ir-v2")).is_ok());
    // change: 2026-10-07-remove-residual-compatibility —— V1 在边界稳定拒绝。
    let rejected = validate_request(&request("woohaa-model-scene-ir-v1")).unwrap_err();
    assert_eq!(rejected.0, RenderErrorCode::UnsupportedSceneVersion);
}

#[test]
fn rejects_old_protocol_version() {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.protocol_version = "woohaa-model-renderer-protocol-v1".to_owned();
    assert_eq!(
        validate_request(&req).unwrap_err().0,
        RenderErrorCode::UnsupportedProtocolVersion
    );
}

#[test]
fn initial_preset_requires_motion() {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.capture.camera_preset = "initial".to_owned();
    assert_eq!(
        validate_request(&req).unwrap_err().0,
        RenderErrorCode::MalformedRequest
    );
}

#[test]
fn rejects_unknown_version() {
    assert_eq!(
        validate_request(&request("woohaa-model-scene-ir-v9"))
            .unwrap_err()
            .0,
        RenderErrorCode::UnsupportedSceneVersion
    );
}

#[test]
fn rejects_oversized_capture() {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.capture.width = MAX_PREVIEW_EDGE + 1;
    assert_eq!(
        validate_request(&req).unwrap_err().0,
        RenderErrorCode::MalformedRequest
    );
}

#[test]
fn rejects_script_source_injection() {
    let json = r#"{"protocolVersion":"woohaa-model-renderer-protocol-v1","requestId":"r","sceneVersion":"woohaa-model-scene-ir-v2","signature":"s","modelScript":"scene.box({});","ops":[]}"#;
    assert_eq!(
        parse_request(json).unwrap_err().0,
        RenderErrorCode::ScriptSourceRejected
    );
}

#[test]
fn rejects_malformed_json() {
    assert_eq!(
        parse_request("{ not json").unwrap_err().0,
        RenderErrorCode::MalformedRequest
    );
}

#[test]
fn accepts_v2_motion_request() {
    let json = r##"{
            "protocolVersion":"woohaa-model-renderer-protocol-v4",
            "requestId":"r","sceneVersion":"woohaa-model-scene-ir-v2","signature":"s",
            "extent":2,
            "ops":[{"t":"box","id":"b","parent":null,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ff0000","material":null,"size":[1,1,1]}],
            "capture":{"width":128,"height":128,"background":"transparent","cameraPreset":"initial"},
            "motion":{"duration":4,"looped":false,"cameraMotion":[],"modelMotion":[],"initialCamera":{"azimuth":0,"elevation":0.7,"distance":6,"focusOffset":[0,0,0],"aspect":"16:9"},"timeSeconds":2}
        }"##;
    let request = parse_request(json).expect("v2 motion request");
    assert!(validate_request(&request).is_ok());
    assert_eq!(request.motion.as_ref().unwrap().time_seconds, 2.0);
}

#[test]
fn rejects_out_of_range_time() {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.capture.camera_preset = "initial".to_owned();
    req.motion = Some(MotionRequest {
        duration: 4.0,
        looped: false,
        camera_motion: vec![],
        model_motion: vec![],
        initial_camera: InitialCameraRequest {
            azimuth: 0.0,
            elevation: 0.7,
            distance: 6.0,
            focus_offset: [0.0; 3],
            aspect: "16:9".to_owned(),
        },
        time_seconds: 9.0,
    });
    assert_eq!(
        validate_request(&req).unwrap_err().0,
        RenderErrorCode::MalformedRequest
    );
}

#[test]
fn rejects_empty_ops() {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.ops.clear();
    assert_eq!(
        validate_request(&req).unwrap_err().0,
        RenderErrorCode::InvalidScene
    );
}

fn world_request() -> RenderRequest {
    let mut req = request("woohaa-model-scene-ir-v2");
    req.protocol_version = WORLD_RENDERER_PROTOCOL_VERSION.into();
    req.ops.clear();
    req.world = Some(serde_json::from_value(serde_json::json!({
        "camera": {
            "kind": "world-camera", "version": "shared-world-v1", "cameraId": "camera", "settingsVersion": "v1",
            "position": { "u": 3, "v": -2, "h": 4 }, "rotation": [0, 0, 0, 1],
            "projection": { "kind": "perspective", "verticalFovRadians": 1.0, "nearMeters": 0.1, "farMeters": 500 },
            "captureMode": { "kind": "static" }, "aspect": { "width": 1, "height": 1 }, "boundInstanceId": null
        },
        "instances": []
    })).unwrap());
    req
}

#[test]
fn world_capture_accepts_an_empty_world_and_preserves_perspective() {
    let req = world_request();
    assert!(validate_request(&req).is_ok());
    assert!(matches!(crate::world_camera_view::projection(&req.world.as_ref().unwrap().camera, bevy::prelude::UVec2::splat(512)),
        bevy::prelude::Projection::Perspective(_)));
}

#[test]
fn world_capture_rejects_legacy_worker_protocol_and_auto_framing() {
    let mut req = world_request();
    req.protocol_version = RENDERER_PROTOCOL_VERSION.into();
    assert_eq!(validate_request(&req).unwrap_err().0, RenderErrorCode::UnsupportedProtocolVersion);
    req.protocol_version = WORLD_RENDERER_PROTOCOL_VERSION.into();
    req.ops = request("woohaa-model-scene-ir-v2").ops;
    assert_eq!(validate_request(&req).unwrap_err().0, RenderErrorCode::InvalidScene);
}

#[test]
fn bound_world_capture_cannot_silently_render_the_whole_world() {
    let mut req = world_request();
    req.world.as_mut().unwrap().camera.bound_instance_id = Some("missing".into());
    assert_eq!(validate_request(&req).unwrap_err().0, RenderErrorCode::InvalidScene);
}

#[test]
fn world_camera_uses_metric_pose_and_real_perspective_foreshortening() {
    use bevy::{camera::CameraProjection, prelude::*};
    let req = world_request();
    let camera = &req.world.as_ref().unwrap().camera;
    assert_eq!(crate::world_camera_view::pose(camera).translation, Vec3::new(192.0, 256.0, 128.0));
    let Projection::Perspective(mut projection) = crate::world_camera_view::projection(camera, UVec2::new(1600, 900)) else { panic!("perspective required") };
    projection.update(1600.0, 900.0);
    let clip = projection.get_clip_from_view();
    let near_object = clip.project_point3(Vec3::new(10.0, 0.0, -100.0));
    let far_object = clip.project_point3(Vec3::new(10.0, 0.0, -200.0));
    assert!((near_object.x / far_object.x - 2.0).abs() < 1e-5);
    assert!((projection.near - 6.4).abs() < 1e-5);
    assert_eq!(projection.far, 32000.0);
}
