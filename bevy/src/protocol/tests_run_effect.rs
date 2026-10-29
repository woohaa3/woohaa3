use super::*;
use serde_json::{Value, json};

fn payload() -> Value {
    json!({"version":CANVAS_RENDER_SCENE_VERSION,"nodes":[{"id":"film","type":"model","x":0,"y":0,
        "compositeAsset":{"x":0,"y":0,"width":200,"height":140},
        "aggregateRun":{"active":true,"reduceMotion":false}
    }],"edges":[],"runFeedback":[{"nodeId":"film","active":true,"phase":"running","source":"conversion","labelCode":"generating"}],"theme":serde_json::from_str::<Value>(&super::tests::theme_object()).unwrap()})
}

#[test]
fn run_feedback_requires_generic_codes_and_valid_owner() {
    let validate = |input| {
        serde_json::from_value::<Scene>(input)
            .ok()
            .is_some_and(|s| s.validate().is_ok())
    };
    assert!(validate(payload()));
    for (key, value) in [
        ("phase", json!("")),
        ("source", json!("")),
        ("labelCode", json!("")),
        ("progress", json!(1.5)),
        ("nodeId", json!("missing")),
    ] {
        let mut input = payload();
        input["runFeedback"][0][key] = value;
        assert!(!validate(input), "accepted invalid {key}");
    }
    // 聚合遮罩只声明通用布尔；旧的业务字段必须被拒绝（deny_unknown_fields）。
    let mut input = payload();
    input["nodes"][0]["aggregateRun"]["filmSet"] = json!({"phase":"running"});
    assert!(!validate(input));
    let mut input = payload();
    input["version"] = json!("woohaa-canvas-render-scene-v21");
    assert!(!validate(input));
}
