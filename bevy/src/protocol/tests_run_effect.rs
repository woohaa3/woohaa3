use super::*;
use serde_json::{Value, json};

fn payload() -> Value {
    json!({"version":CANVAS_RENDER_SCENE_VERSION,"nodes":[{"id":"film","type":"model","x":0,"y":0,
        "compositeAsset":{"x":0,"y":0,"width":200,"height":140},
        "aggregateRun":{"active":true,"filmSet":{"operationKey":"conversion:request:attempt","phase":"running","source":"conversion","labelCode":"generating"}}
    }],"edges":[],"theme":serde_json::from_str::<Value>(&super::tests::theme_object()).unwrap()})
}

#[test]
fn run_feedback_codec_rejects_unknown_fields_phases_and_invalid_owners() {
    let validate = |input| {
        serde_json::from_value::<Scene>(input)
            .ok()
            .is_some_and(|s| s.validate().is_ok())
    };
    assert!(validate(payload()));
    for (key, value) in [
        ("phase", json!("success")),
        ("source", json!("untrusted")),
        ("labelCode", json!("100%")),
        ("operationKey", json!("")),
        ("clock", json!(1)),
    ] {
        let mut input = payload();
        input["nodes"][0]["aggregateRun"]["filmSet"][key] = value;
        assert!(!validate(input), "accepted invalid {key}");
    }
    let mut input = payload();
    input["nodes"][0]["aggregateRun"]["active"] = json!(false);
    assert!(!validate(input));
    let mut input = payload();
    input["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("compositeAsset");
    assert!(!validate(input));
    let mut input = payload();
    input["version"] = json!("woohaa-canvas-render-scene-v21");
    assert!(!validate(input));
}
