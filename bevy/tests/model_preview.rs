#![cfg(feature = "native-renderer")]
use woohaa_bevy_canvas::golden_api::point_hit_kind as point_hit;

#[test]
fn model_preview_content_does_not_take_header_or_port_actions() {
    let nodes = r#"[{"id":"model","type":"model","x":0,"y":0,"width":248,"height":232,
        "modelPreview":{"azimuth":0.5,"elevation":0.3,"distanceScale":1,"targetOffset":[0,0,0]},
        "model":{"resourceKey":"test","signature":"test","placement":{"offset":{"x":0,"y":0,"z":0},"scale":1,"yaw":0}}}]"#;
    assert_eq!(
        point_hit(nodes, 124., 120., 1.).unwrap(),
        Some("model-preview:model".into())
    );
    // 右上角历史动作已移除，原位置现在是普通节点命中
    // （change: 2026-10-12-unify-generation-history-strip，design D4）。
    assert_eq!(
        point_hit(nodes, 172., 22., 1.).unwrap(),
        Some("node:model".into())
    );
    assert_eq!(
        point_hit(nodes, 200., 22., 1.).unwrap(),
        Some("node:model".into())
    );
    assert_eq!(
        point_hit(nodes, 230., 22., 1.).unwrap(),
        Some("node:model".into())
    );
    assert_eq!(
        point_hit(nodes, 0., 116., 1.).unwrap(),
        Some("port:model:input".into())
    );
    assert_eq!(
        point_hit(nodes, 110., 22., 1.).unwrap(),
        Some("node:model".into())
    );
}

#[test]
fn history_strip_hit_is_below_node() {
    // 历史条是节点下方的独立横条（含左侧历史图标）
    // （change: 2026-10-12-unify-generation-history-strip，design D4）。
    let nodes = r#"[{"id":"img","type":"image","x":0,"y":0,"width":248,"height":232}]"#;
    // 节点下缘 (232) + gap (6) + 半个条高 (9) ≈ 247 命中 history。
    assert_eq!(
        point_hit(nodes, 120., 247., 1.).unwrap(),
        Some("history:img".into())
    );
    // 节点内底边附近不再是 history（回落到 node）。
    assert_eq!(
        point_hit(nodes, 120., 224., 1.).unwrap(),
        Some("node:img".into())
    );
}

#[test]
fn compact_filmset_retains_ordinary_card_interaction() {
    let nodes = r#"[{"id":"filmset","type":"model","x":0,"y":0,"width":196,"height":64}]"#;
    assert_eq!(
        point_hit(nodes, 90., 22., 1.).unwrap(),
        Some("node:filmset".into())
    );
}
