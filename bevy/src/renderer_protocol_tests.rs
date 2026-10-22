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
        composite_asset_frame: None,
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
        objects: Vec::new(),
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
