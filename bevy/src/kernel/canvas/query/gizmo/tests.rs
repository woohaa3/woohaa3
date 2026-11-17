use super::*;
use crate::protocol::Scene;
use serde_json::{Value, json};

fn editor() -> Value {
    json!({"version":"woohaa-model-editor-v2", "nodeId":"model", "toolMode":"camera",
        "cameraTool":"orbit", "cameraId":"cam-a", "focus":[0,0,0], "radius":2,
        "shot":{"position":[1,2,1],"focus":[0,0,0],"fov":0.87,"azimuth":0.4,
            "elevation":0.785,"distance":5,"aspect":"16:9"},
        "feedback":{"epoch":4}})
}

fn accept(editor: Value) -> Value {
    let projection = json!({"version":"woohaa-model-focus-v1", "nodeId":"model", "target":[0,0,0],
        "yaw":0, "pitch":0, "distance":6, "fov":MODEL_FOCUS_FOV});
    let mut scene = Scene::default();
    scene.nodes.push(
        serde_json::from_value(json!({"id":"model","type":"model3d","x":0,"y":0,
            "model":{"resourceKey":"v:sig","signature":"sig"}}))
        .unwrap(),
    );
    scene.model_editor = Some(serde_json::from_value(editor.clone()).unwrap());
    scene.model_focus = Some(serde_json::from_value(projection.clone()).unwrap());
    scene.surface =
        Some(serde_json::from_value(json!({"width":1000,"height":800,"pixelRatio":2})).unwrap());
    let generation = crate::canvas_query::interaction::accept_scene(&scene);
    accepted::accept_gizmo_scene(&scene);
    json!({"kind":"shot", "x":500,"y":350,"width":1000,"height":800,
        "editor":editor,"projection":projection,"generation":generation})
}

fn query(request: &Value) -> Value {
    serde_json::from_str(&gizmo_query_json(&request.to_string())).unwrap()
}

#[test]
fn accepted_shot_query_rejects_stale_identity() {
    let request = accept(editor());
    let hit = query(&request);
    assert_eq!(hit["available"], true);
    assert_eq!(hit["layoutId"].as_str().unwrap().len(), 16);
    for (path, value) in [
        ("nodeId", json!("other")),
        ("cameraTool", json!("distance")),
    ] {
        let mut stale = request.clone();
        stale["editor"][path] = value;
        assert_eq!(query(&stale)["available"], false);
    }
    for field in ["generation", "width"] {
        let mut stale = request.clone();
        stale[field] = json!(0);
        assert_eq!(query(&stale)["available"], false);
    }
    let mut stale = request.clone();
    stale["editor"]["feedback"]["epoch"] = json!(3);
    assert_eq!(query(&stale)["reason"], "stale");
    // Hover changes styling without changing accepted geometry identity.
    let mut hover = request.clone();
    hover["editor"]["feedback"]["hover"] = json!("y");
    assert_eq!(query(&hover)["layoutId"], hit["layoutId"]);
    accepted::accept_gizmo_scene(&Scene::default());
    assert_eq!(query(&request)["available"], false);
}

#[test]
fn model_tool_is_rejected_and_transport_facades_share_query() {
    let mut model = editor();
    model["toolMode"] = json!("model");
    assert_eq!(query(&accept(model))["available"], false);
    // The opaque native dispatcher returns the same result as the JSON facade.
    let request = accept(editor());
    let facade: Value = serde_json::from_str(&crate::query_gizmo_hit(&request.to_string())).unwrap();
    assert_eq!(facade, query(&request));
}
