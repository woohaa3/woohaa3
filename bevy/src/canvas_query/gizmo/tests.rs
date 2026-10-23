use super::*;
use crate::protocol::Scene;
use serde_json::{Value, json};

fn fixture() -> Value {
    json!({"version":"woohaa-model-editor-v2", "nodeId":"film", "toolMode":"object",
        "objectTool":"move", "itemId":"item", "focus":[0,0,0], "radius":2,
        "feedback":{"epoch":4}})
}
fn accept(editor: Value) -> Value {
    let projection = json!({"version":"woohaa-model-focus-v1", "nodeId":"film", "target":[0,0,0],
        "yaw":0, "pitch":0, "distance":6, "fov":MODEL_FOCUS_FOV});
    let mut scene = Scene::default();
    scene.nodes.push(
        serde_json::from_value(json!({"id":"film","type":"composite-asset","x":0,"y":0,
        "compositeAsset":{"x":0,"y":0,"width":100,"height":100,"itemRoots":{"item":"item-root"}}}))
        .unwrap(),
    );
    scene.model_editor = Some(serde_json::from_value(editor.clone()).unwrap());
    scene.model_focus = Some(serde_json::from_value(projection.clone()).unwrap());
    scene.surface =
        Some(serde_json::from_value(json!({"width":1000,"height":800,"pixelRatio":2})).unwrap());
    let generation = crate::canvas_query::interaction::accept_scene(&scene);
    accepted::accept_gizmo_scene(&scene);
    json!({"kind":"object", "x":500,"y":350,"width":1000,"height":800,
        "editor":editor,"projection":projection,"generation":generation})
}
fn query(request: &Value) -> Value {
    serde_json::from_str(&gizmo_query_json(&request.to_string())).unwrap()
}

#[test]
fn accepted_query_returns_css_constraint_and_rejects_stale_identity() {
    let request = accept(fixture());
    let hit = query(&request);
    assert_eq!(hit["available"], true);
    assert_eq!(hit["handle"], "y");
    assert!(hit["constraint"]["worldPerPixel"].as_f64().unwrap() > 0.0);
    assert!(hit["layoutId"].as_str().unwrap().len() == 16);
    for (path, value) in [
        ("itemId", json!("other")),
        ("nodeId", json!("other")),
        ("objectTool", json!("scale")),
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
fn tool_gates_and_both_transport_facades_share_query() {
    let mut editor = fixture();
    editor["toolMode"] = json!("model");
    assert_eq!(query(&accept(editor))["available"], false);
    let mut editor = fixture();
    editor["objectTool"] = json!("yaw");
    let mut request = accept(editor);
    request["x"] = json!(550);
    request["y"] = json!(400);
    let hit = query(&request);
    assert_eq!(hit["handle"], "yaw-ring");
    assert_eq!(hit["yawConstraint"]["mode"], "tangent");
    // Native opaque dispatcher and WASM export call the same facade.
    let facade: Value =
        serde_json::from_str(&crate::query_gizmo_hit(&request.to_string())).unwrap();
    assert_eq!(facade, hit);
    let mut editor = fixture();
    editor["toolMode"] = json!("camera");
    editor["cameraTool"] = json!("orbit");
    let mut request = accept(editor);
    request["kind"] = json!("focus");
    assert_eq!(query(&request)["available"], false);
}
