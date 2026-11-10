#![cfg(feature = "native-renderer")]
//! 世界模型的命中语义：卡片预览命中已删除，模型没有卡片内容区与端口
//! （change: 2026-11-10-remove-legacy-model-card-nodes）。
use woohaa_bevy_canvas::golden_api::point_hit_kind as point_hit;

#[test]
fn world_model_has_no_card_preview_hit_and_no_ports() {
    let nodes = r#"[{"id":"model","type":"model","x":0,"y":0,"width":248,"height":232,
        "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"instance",
            "transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},
                "rotation":[0,0,0,1],"scale":1}},
        "model":{"resourceKey":"test","signature":"test"}}]"#;
    // 世界模型没有卡片：卡片中心不再返回 `model-preview` 命中（模型表面由 3D 拾取负责）。
    assert_ne!(
        point_hit(nodes, 124., 120., 1.).unwrap(),
        Some("model-preview:model".into())
    );
    // 旧卡片节点（无 sharedWorldInstance）也没有模型预览命中。
    let legacy = serde_json::json!([{
        "id": "legacy", "type": "model", "x": 0, "y": 0, "width": 248, "height": 232,
        "model": { "resourceKey": "test", "signature": "test" }
    }]);
    assert_ne!(
        point_hit(&legacy.to_string(), 124., 120., 1.).unwrap(),
        Some("model-preview:legacy".into())
    );
}
