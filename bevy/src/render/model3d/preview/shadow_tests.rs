//! Hardware-only image evidence. CPU CI still compiles these fixtures.
use super::{render, tests::request};
use crate::{protocol::ModelOp, renderer_protocol::CaptureOptions};
use bevy::prelude::*;

fn fixture(angle: f32) -> crate::renderer_protocol::RenderRequest {
    let ops: Vec<ModelOp> = serde_json::from_value(serde_json::json!([
        {"t":"box","id":"floor","position":[0,-0.1,0],"size":[8,0.2,8],"color":"#aaaaaa"},
        {"t":"group","id":"joint","position":[0,1.7,0],"rotation":[0,0,angle]},
        {"t":"box","id":"caster","parent":"joint","size":[1.5,1.5,1.5],"color":"#dddddd"},
        {"t":"box","id":"wall","position":[-1,0.8,-1],"size":[0.2,1.6,2],"color":"#aaaaaa"}
    ]))
    .unwrap();
    let mut req = request(
        vec![],
        8.0,
        CaptureOptions {
            width: 384,
            height: 384,
            background: "transparent".into(),
            camera_preset: "dimetric".into(),
            format: "png".into(),
        },
    );
    req.protocol_version = crate::renderer_protocol::WORLD_RENDERER_PROTOCOL_VERSION.into();
    let eye = Vec3::new(6., 6., 8.);
    let q = Transform::from_translation(eye)
        .looking_at(Vec3::new(0., 0.5, 0.), Vec3::Y)
        .rotation;
    req.world = Some(serde_json::from_value(serde_json::json!({
        "camera":{"kind":"world-camera","version":"shared-world-v1","cameraId":"shadow-fixture","settingsVersion":"v1",
            "position":{"u":eye.x,"v":-eye.z,"h":eye.y}, "rotation":[q.x,-q.z,q.y,q.w],
            "projection":{"kind":"perspective","verticalFovRadians":0.8,"nearMeters":0.1,"farMeters":100.0},
            "captureMode":{"kind":"static"},"aspect":{"width":1,"height":1},"boundInstanceId":null},
        "instances":[{"instance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"target",
            "transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}},"ops":ops}]
    })).unwrap());
    req
}

#[test]
fn shadow_fixture_preserves_native_binding_validation() {
    let mut req = fixture(0.0);
    crate::renderer_protocol::validate_request(&req).unwrap();
    let world = req.world.as_mut().unwrap();
    world.camera.bound_instance_id = Some("target".into());
    let mut hidden = world.instances[0].clone();
    hidden.instance.instance_id = "hidden-blocker".into();
    world.instances.push(hidden);
    assert!(crate::renderer_protocol::validate_request(&req).is_err());
    req.world.as_mut().unwrap().instances.pop();
    crate::renderer_protocol::validate_request(&req).unwrap();
}

#[test]
#[ignore = "requires a real native hardware GPU; software adapters are rejected"]
fn native_renderer_png_camera_ignores_global_light_and_joint_pose() {
    let req = fixture(0.0);
    let off = render::run_render_with_shadows(&req, &req.capture, false).expect("hardware GPU");
    let on = render::run_render_with_shadows(&req, &req.capture, true).expect("hardware GPU");
    let moved = fixture(55.0);
    let moved =
        render::run_render_with_shadows(&moved, &moved.capture, true).expect("hardware GPU");
    let mut bound = req.clone();
    bound.world.as_mut().unwrap().camera.bound_instance_id = Some("target".into());
    crate::renderer_protocol::validate_request(&bound).unwrap();
    let bound =
        render::run_render_with_shadows(&bound, &bound.capture, true).expect("hardware GPU");
    assert_eq!(
        on, bound,
        "a native bound snapshot contains only its target"
    );
    assert_eq!(
        off, on,
        "world-camera output must ignore global directional light and shadows"
    );
    assert_ne!(
        on, moved,
        "joint pose must update the actual rendered geometry"
    );
    if let Some(directory) = std::env::var_os("WOOHAA_SHADOW_EVIDENCE_DIR") {
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        for (name, rgba) in [
            ("native-off", off),
            ("native-on", on),
            ("native-joint", moved),
        ] {
            std::fs::write(
                directory.join(format!("{name}.png")),
                render::encode_png(&rgba, 384, 384).unwrap(),
            )
            .unwrap();
        }
    }
}
