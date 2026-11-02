use super::*;
use crate::protocol::Scene;
use serde_json::{Value, json};

fn fixture() -> Value {
    json!({"version":"woohaa-model-editor-v2", "nodeId":"film", "toolMode":"object",
        "objectTool":"move", "itemId":"item", "focus":[0,0,0], "radius":2,
        "feedback":{"epoch":4}})
}
fn accept(editor: Value) -> Value {
    accept_scene(editor, None)
}
fn accept_scene(editor: Value, group: Option<Value>) -> Value {
    let projection = json!({"version":"woohaa-model-focus-v1", "nodeId":"film", "target":[0,0,0],
        "yaw":0, "pitch":0, "distance":6, "fov":MODEL_FOCUS_FOV});
    let mut scene = Scene::default();
    scene.nodes.push(
        serde_json::from_value(json!({"id":"film","type":"composite-asset","x":0,"y":0,
        "compositeAsset":{"x":0,"y":0,"width":100,"height":100,"itemRoots":{"item":"item-root"}}}))
        .unwrap(),
    );
    if let Some(group) = group {
        scene.nodes[0] =
            serde_json::from_value(json!({"id":"film","type":"group","x":0,"y":0,"group":{}}))
                .unwrap();
        let kind = group["bindings"][0]["kind"].as_str().unwrap_or("image");
        scene
            .nodes
            .push(serde_json::from_value(json!({"id":"source","type":kind,"x":0,"y":0})).unwrap());
        scene.film_set_groups = serde_json::from_value(json!([group])).unwrap();
    }
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

fn group_fixture(kind: &str) -> Value {
    json!({"schemaVersion":"woohaa-film-set-group-render-v1","ownerId":"film",
        "badgeOrigin":{"x":0,"y":0},"bindings":[{"bindingId":"item","sourceNodeId":"source",
        "kind":kind,"contentKey":"v1","transform":{"x":0,"y":0,"z":0,"yaw":0,"scale":1}}],
        "ground":{"width":10,"depth":10}})
}

#[test]
fn group_bindings_and_ground_use_current_owner_identity() {
    for kind in ["model3d", "image", "video"] {
        let request = accept_scene(fixture(), Some(group_fixture(kind)));
        assert_eq!(query(&request)["handle"], "y", "{kind}");
        let mut stale = request.clone();
        stale["editor"]["itemId"] = json!("removed-binding");
        assert_eq!(query(&stale)["available"], false);
    }
    let mut editor = fixture();
    editor["itemId"] = json!("film-set-ground");
    assert_eq!(
        query(&accept_scene(
            editor.clone(),
            Some(group_fixture("model3d"))
        ))["available"],
        true
    );
    let mut group = group_fixture("model3d");
    group.as_object_mut().unwrap().remove("ground");
    assert_eq!(
        query(&accept_scene(editor, Some(group)))["available"],
        false
    );
    for (field, value) in [
        ("visible", json!(false)),
        ("diagnostic", json!("missing asset")),
        ("sourceNodeId", json!("removed")),
    ] {
        let mut group = group_fixture("image");
        group["bindings"][0][field] = value;
        assert_eq!(
            query(&accept_scene(fixture(), Some(group)))["available"],
            false,
            "{field}"
        );
    }
    let mut group = group_fixture("video");
    group["ownerId"] = json!("old-owner");
    assert_eq!(
        query(&accept_scene(fixture(), Some(group)))["available"],
        false
    );
}

#[test]
fn readonly_shot_preview_rejects_group_gizmo_queries() {
    let mut editor = fixture();
    editor["shotPreview"] = json!(true);
    assert_eq!(
        query(&accept_scene(editor, Some(group_fixture("model3d"))))["available"],
        false
    );
}
