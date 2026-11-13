//! protocol 单元测试（change: refactor-bevy-rust-file-size，任务 2.1 / design D4）。
//!
//! 由 `protocol.rs` 内联测试移动而来，断言与覆盖完全保留；通过 `super::*` 访问 facade
//! 再导出的 DTO 与私有校验函数。

use super::*;


fn parse(json: &str) -> Scene {
    serde_json::from_str(&with_theme(json)).expect("valid scene json")
}

/// 完整合法 theme 对象 JSON（change: 2026-10-07-remove-residual-compatibility：
/// scene 必须携带完整合法 theme，缺失在接受点拒绝）。
pub(super) fn theme_object() -> String {
    let version = crate::theme_generated::APP_THEME_SCHEMA_VERSION;
    let mut tokens = String::new();
    for (index, (name, hex)) in crate::theme_generated::APP_THEME_DEFAULT_TOKENS
        .iter()
        .enumerate()
    {
        if index > 0 {
            tokens.push(',');
        }
        tokens.push_str(&format!("\"{name}\":\"{hex}\""));
    }
    format!(
        r#"{{"id":"default","version":"{version}","fingerprint":"{fp}","tokens":{{{tokens}}}}}"#,
        fp = crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT
    )
}

fn with_theme(json: &str) -> String {
    if json.contains("\"theme\"") {
        return json.to_owned();
    }
    json.replace(
        r#""edges":[]"#,
        &format!(r#""edges":[],"theme":{}"#, theme_object()),
    )
}

/// 最小合法快照：`nodes` / `edges` 是必填字段（与重构前一致）。
/// v5 起还必须携带 `version`；change: 2026-10-07-remove-residual-compatibility 起必须携带完整 theme。
fn scene_json(body: &str) -> String {
    format!(
        r#"{{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[]{},"theme":{}}}"#,
        body,
        theme_object()
    )
}

#[test]
fn defaults_fill_missing_fields() {
    let scene = parse(&scene_json(""));
    assert_eq!(scene.viewport.zoom, 1.0);
    assert!(scene.nodes.is_empty());
    assert!(scene.surface.is_none());
    assert_eq!(scene.revision, 0);
    assert_eq!(scene.version, CANVAS_RENDER_SCENE_VERSION);
}

#[test]
fn world_camera_editor_requires_a_valid_camera_and_matching_node() {
    let camera = serde_json::json!({
        "kind": "world-camera", "version": "shared-world-v1", "cameraId": "camera-1", "settingsVersion": "v1",
        "position": { "u": 0, "v": 0, "h": 2 }, "rotation": [0, 0, 0, 1],
        "projection": { "kind": "perspective", "verticalFovRadians": 1, "nearMeters": 0.1, "farMeters": 500 },
        "captureMode": { "kind": "static" }, "aspect": { "width": 16, "height": 9 }, "boundInstanceId": null
    });
    let mut value: serde_json::Value = serde_json::from_str(&scene_json("")).unwrap();
    value["nodes"] = serde_json::json!([{ "id": "node", "type": "node", "x": 0, "y": 0, "worldCamera": camera.clone() }]);
    value["worldCameraEdit"] = serde_json::json!({ "nodeId": "node", "camera": camera });
    let scene: Scene = serde_json::from_value(value.clone()).unwrap();
    assert!(scene.validate().is_ok());
    value["worldCameraEdit"]["nodeId"] = "missing".into();
    let scene: Scene = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(scene.validate(), Err("Invalid world camera editor"));
    value["worldCameraEdit"]["nodeId"] = "node".into();
    value["worldCameraEdit"]["camera"]["rotation"] = serde_json::json!([0, 0, 0, 2]);
    let scene: Scene = serde_json::from_value(value).unwrap();
    assert!(scene.validate().is_err());
}


#[test]
fn focus_transition_wire_field_parses_and_validates() {
    // 公共聚焦进度瞬时更新（change: 2026-10-12-unify-node-editors-and-focus-transitions，
    // design D6/D7）：wire 名 `focusTransition` 与 Web `BevyFocusTransition` 一致；合法通过，
    // 未知版本/越界进度被 `Scene::validate` 拒绝。
    let ok: Scene = parse(&scene_json(
        r#","focusTransition":{"version":"woohaa-focus-transition-v1","nodeId":"m1","kind":"model","progress":0.5,"runtimeGeneration":3,"transitionId":7}"#,
    ));
    let progress = ok
        .focus_transition
        .as_ref()
        .expect("parsed focus transition");
    assert_eq!(progress.node_id, "m1");
    assert_eq!(progress.kind, "model");
    assert!((progress.progress - 0.5).abs() < 1e-6);
    assert!(ok.validate().is_ok());

    let bad_version: Scene = parse(&scene_json(
        r#","focusTransition":{"version":"woohaa-focus-transition-v9","nodeId":"m1","kind":"model","progress":0.5}"#,
    ));
    assert!(bad_version.validate().is_err());

    let out_of_range: Scene = parse(&scene_json(
        r#","focusTransition":{"version":"woohaa-focus-transition-v1","nodeId":"m1","kind":"model","progress":1.5}"#,
    ));
    assert!(out_of_range.validate().is_err());
}

#[test]
fn rejects_unsupported_canvas_scene_version() {
    // 旧 Frontend/WASM 组合必须按版本拒绝，不静默降级为缺模型画面
    // （change: optimize-model-scene-snapshot-hot-path）。
    let v4 = r#"{"version":"woohaa-canvas-render-scene-v4","nodes":[],"edges":[]}"#;
    let parsed: Scene = parse(v4);
    assert_eq!(
        parsed.validate(),
        Err("Unsupported canvas render scene version")
    );
    // 缺失 version 同样拒绝。
    let missing: Scene = parse(r#"{"nodes":[],"edges":[]}"#);
    assert!(missing.validate().is_err());
    // v34 carried group/film-set presentations the renderer no longer implements; an older
    // frame would silently lose its containers, so the version mismatch is rejected whole.
    let mut previous = parse(&scene_json(""));
    previous.version = "woohaa-canvas-render-scene-v34".into();
    assert_eq!(
        previous.validate(),
        Err("Unsupported canvas render scene version")
    );
    // A composite-asset node is now an ordinary card: its former presentation field is ignored.
    let plain = parse(&scene_json("").replace(
        r#""nodes":[]"#,
        r#""nodes":[{"id":"c","type":"composite-asset","x":0,"y":0,"width":200,"height":150,"compositeAsset":{"x":0,"y":0,"width":200,"height":150}}]"#,
    ));
    assert!(plain.validate().is_ok());
}

#[test]
fn nodes_and_edges_are_required() {
    assert!(serde_json::from_str::<Scene>("{}").is_err());
    assert!(serde_json::from_str::<Scene>(r#"{"nodes":[]}"#).is_err());
}

#[test]
fn node_defaults_match_contracts() {
    let scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[{"id":"a","type":"text","x":1.0,"y":2.0}],"edges":[]}"#,
    ));
    let node = &scene.nodes[0];
    assert_eq!(node.width, DEFAULT_NODE_WIDTH);
    assert_eq!(node.height, DEFAULT_NODE_HEIGHT);
    assert!(node.model.is_none());
}


#[test]
fn viewport_zoom_is_bounded() {
    // 与 contracts 的 WOOHAA3_CANVAS_MIN_ZOOM / MAX_ZOOM（0.1–12）一致：
    // 区间内接受，区间外拒绝（change: fix-viewport-zoom-range）。
    assert!(
        parse(&scene_json(r#","viewport":{"x":0.0,"y":0.0,"zoom":0.1}"#))
            .validate()
            .is_ok()
    );
    assert!(
        parse(&scene_json(r#","viewport":{"x":0.0,"y":0.0,"zoom":12.0}"#))
            .validate()
            .is_ok()
    );
    // 捏合过程中会经过 >2 的中间值，必须被接受。
    assert!(
        parse(&scene_json(r#","viewport":{"x":0.0,"y":0.0,"zoom":2.0}"#))
            .validate()
            .is_ok()
    );
    assert_eq!(
        parse(&scene_json(r#","viewport":{"x":0.0,"y":0.0,"zoom":0.05}"#)).validate(),
        Err("Invalid viewport zoom")
    );
    assert_eq!(
        parse(&scene_json(r#","viewport":{"x":0.0,"y":0.0,"zoom":12.5}"#)).validate(),
        Err("Invalid viewport zoom")
    );
}

#[test]
fn surface_is_bounded() {
    let ok = parse(&scene_json(
        r#","surface":{"width":800,"height":600,"pixelRatio":2.0,"contentRight":320}"#,
    ));
    assert!(ok.validate().is_ok());
    assert_eq!(ok.surface.as_ref().unwrap().content_right, 320.0);
    let no_occlusion = parse(&scene_json(
        r#","surface":{"width":800,"height":600,"pixelRatio":2.0}"#,
    ));
    assert_eq!(no_occlusion.surface.as_ref().unwrap().content_right, 0.0);
    let bad = parse(&scene_json(
        r#","surface":{"width":0,"height":600,"pixelRatio":1.0}"#,
    ));
    assert_eq!(bad.validate(), Err("Invalid canvas size"));
}

#[test]
fn texture_length_is_checked() {
    assert!(validate_texture(2, 2, 16).is_ok());
    assert_eq!(validate_texture(2, 2, 15), Err("Invalid texture"));
    assert_eq!(validate_texture(0, 2, 0), Err("Invalid texture"));
    assert_eq!(validate_texture(3000, 1, 12000), Err("Invalid texture"));
}

/// V1 模型引用现在应被边界拒绝（change: 2026-10-07-remove-residual-compatibility）。
#[test]
fn rejects_v1_model_reference_version() {
    let json = r##"{"version":"woohaa-canvas-render-scene-v43","nodes":[{"id":"g1","type":"model","x":0,"y":0,"model":{"sceneVersion":"woohaa-model-scene-ir-v1","resourceKey":"woohaa-model-scene-ir-v1:abc123","signature":"abc123","placement":{"offset":{"x":1,"y":0,"z":0},"scale":2,"yaw":0}}}],"edges":[]}"##;
    // 引用本身可反序列化（保留原始权威记录），但资源注册边界拒绝 V1 版本。
    let scene = parse(&with_theme(json));
    let model = scene.nodes[0].model.as_ref().expect("model");
    assert_eq!(
        model.scene_version.as_deref(),
        Some("woohaa-model-scene-ir-v1")
    );
}

/// V1 注册 payload fixture 现在应被 V2-only 校验拒绝。
#[test]
fn rejects_v1_model_resource() {
    let json = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","resourceKey":"woohaa-model-scene-ir-v1:abc123","sceneVersion":"woohaa-model-scene-ir-v1","signature":"abc123","extent":2.0,"aabb":null,"ops":[{"t":"group","id":"root","parent":null,"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]},{"t":"box","id":"body","parent":"root","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ff0000","size":[1,2,1]}]}"##;
    let descriptor: ModelAssetDescriptor = serde_json::from_str(json).expect("parse");
    assert_eq!(
        descriptor.validate(),
        Err("Unsupported model scene version")
    );
}

/// V2 注册 payload fixture：material + sphere/capsule/segment + 层级。
#[test]
fn parses_v2_model_resource() {
    let json = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","resourceKey":"woohaa-model-scene-ir-v2:sig","sceneVersion":"woohaa-model-scene-ir-v2","signature":"sig","extent":3.0,"aabb":{"min":[-0.3,-0.3,-0.3],"max":[0.3,1.2,0.3]},"ops":[
        {"t":"material","id":"armor","baseColor":"#26343a","roughness":0.35,"metallic":0.85,"emissive":"#000000","emissiveStrength":0,"alphaMode":"opaque","doubleSided":false},
        {"t":"group","id":"arm","parent":null,"position":[0,2,0],"rotation":[0,0,0],"scale":[1,1,1]},
        {"t":"sphere","id":"elbow","parent":"arm","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"material":"armor","color":null,"radius":0.2},
        {"t":"capsule","id":"limb","parent":"arm","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","material":null,"radius":0.3,"height":1.2},
        {"t":"segment","id":"forearm","parent":"arm","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"material":"armor","color":null,"from":[0,0,0],"to":[0,1,0],"width":0.3,"depth":0.3,"shape":"capsule","overlap":0.05}
    ]}"##;
    let descriptor: ModelAssetDescriptor = serde_json::from_str(json).expect("parse");
    assert!(descriptor.validate().is_ok());
    assert_eq!(descriptor.ops.len(), 5);
    let snapshot = descriptor.into_snapshot();
    assert_eq!(
        snapshot.scene_version.as_deref(),
        Some("woohaa-model-scene-ir-v2")
    );
    assert_eq!(snapshot.ops.len(), 5);
}

#[test]
fn model_resource_validation_rejects_bad_descriptors() {
    let base = |key: &str, signature: &str, ops: &str| {
        format!(
            r#"{{"resourceVersion":"woohaa-prepared-model-resource-v1","resourceKey":"{key}","sceneVersion":"woohaa-model-scene-ir-v2","signature":"{signature}","extent":2.0,"aabb":null,"ops":{ops}}}"#
        )
    };
    // key/signature 不一致。
    let mismatched: ModelAssetDescriptor = serde_json::from_str(&base(
        "v2:abc",
        "def",
        r#"[{"t":"group","id":"g","parent":null}]"#,
    ))
    .expect("parse");
    assert!(mismatched.validate().is_err());
    // 空 ops。
    let empty: ModelAssetDescriptor =
        serde_json::from_str(&base("v2:abc", "abc", "[]")).expect("parse");
    assert_eq!(empty.validate(), Err("Empty model resource ops"));
    // 未知版本。
    let bad_version: ModelAssetDescriptor = serde_json::from_str(
        r#"{"resourceVersion":"nope","resourceKey":"v2:abc","signature":"abc","ops":[{"t":"group","id":"g","parent":null}]}"#,
    )
    .expect("parse");
    assert_eq!(
        bad_version.validate(),
        Err("Unknown model resource version")
    );
}

// --- theme snapshot（change: unify-application-theme-tokens，任务 3.3 / 3.4） ---

fn theme_json() -> String {
    let version = crate::theme_generated::APP_THEME_SCHEMA_VERSION;
    let mut tokens = String::new();
    for (index, (name, hex)) in crate::theme_generated::APP_THEME_DEFAULT_TOKENS
        .iter()
        .enumerate()
    {
        if index > 0 {
            tokens.push(',');
        }
        tokens.push_str(&format!("\"{name}\":\"{hex}\""));
    }
    format!(
        r#"{{"version":"{cv}","nodes":[],"edges":[],"theme":{{"id":"default","version":"{version}","fingerprint":"{fp}","tokens":{{{tokens}}}}}}}"#,
        cv = CANVAS_RENDER_SCENE_VERSION,
        fp = crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT
    )
}

#[test]
fn missing_theme_is_rejected_at_boundary() {
    // change: 2026-10-07-remove-residual-compatibility —— 不再回退 generated 默认；
    // 缺少 theme 的 scene 在接受点被拒绝（反序列化即失败）。
    let json = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[]}"#;
    assert!(serde_json::from_str::<Scene>(json).is_err());
}

#[test]
fn generated_default_preset_validates() {
    // 默认 preset 仍由 canonical token source 生成，供明确初始化/测试使用。
    let scene = parse(&scene_json(""));
    assert_eq!(
        scene.theme.fingerprint,
        crate::theme_generated::APP_THEME_DEFAULT_FINGERPRINT
    );
    assert!(scene.validate().is_ok());
}

#[test]
fn parses_full_theme_snapshot() {
    let scene = parse(&theme_json());
    assert_eq!(scene.theme.id, "default");
    assert_eq!(scene.theme.token("interactionAccent"), "#16846c");
    assert!(scene.validate().is_ok());
}

#[test]
fn rejects_unknown_theme_version() {
    let json = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"theme":{"id":"x","version":"woohaa-app-theme-v0","fingerprint":"00","tokens":{}}}"#;
    assert!(serde_json::from_str::<Scene>(json).is_err());
}

#[test]
fn rejects_malformed_or_injected_theme_colors() {
    for value in [
        "url(https://evil)",
        "var(--x)",
        "linear-gradient(red,blue)",
        "#fff",
        "red",
    ] {
        let json = r##"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"theme":{"id":"x","version":"__V__","fingerprint":"00","tokens":{"interactionAccent":"__C__"}}}"##
            .replace("__V__", crate::theme_generated::APP_THEME_SCHEMA_VERSION)
            .replace("__C__", value);
        assert!(
            serde_json::from_str::<Scene>(&json).is_err(),
            "应拒绝 {value}"
        );
    }
}

#[test]
fn rejects_unknown_theme_token() {
    let json = r##"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"theme":{"id":"x","version":"__V__","fingerprint":"00","tokens":{"bogusToken":"#ffffff"}}}"##
        .replace("__V__", crate::theme_generated::APP_THEME_SCHEMA_VERSION);
    assert!(serde_json::from_str::<Scene>(&json).is_err());
}

#[test]
fn theme_hex_parser_matches_contracts() {
    assert_eq!(parse_theme_hex("#16846c"), Some((0x16, 0x84, 0x6c, 255)));
    assert_eq!(parse_theme_hex("#16846c80"), Some((0x16, 0x84, 0x6c, 0x80)));
    assert_eq!(parse_theme_hex("#FFF"), None);
    assert_eq!(parse_theme_hex("16846c"), None);
    assert_eq!(parse_theme_hex("url(x)"), None);
}

fn focus_json(extra: &str) -> String {
    format!(
        r#"{{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelFocus":{{"version":"woohaa-model-focus-v1","nodeId":"n1","target":[0,1,0],"yaw":0.2,"pitch":-0.3,"distance":12.5,"fov":0.87{extra}}}}}"#
    )
}

#[test]
fn parses_model_focus_projection() {
    let scene: Scene = parse(&with_theme(&focus_json("")));
    let focus = scene.model_focus.expect("focus");
    assert_eq!(focus.node_id, "n1");
    assert!(focus.validate().is_ok());
}

#[test]
fn rejects_invalid_model_focus() {
    // 未知版本：解析通过但校验失败（防御校验在 validate）。
    let bad_version = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelFocus":{"version":"woohaa-model-focus-v0","nodeId":"n1","target":[0,1,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87}}"#;
    let parsed: Scene = parse(&with_theme(bad_version));
    assert!(parsed.validate().is_err());
    // 非有限 target。
    let ok = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelFocus":{"version":"woohaa-model-focus-v1","nodeId":"n1","target":[0,1,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87}}"#;
    let mut parsed: Scene = parse(&with_theme(ok));
    parsed.model_focus.as_mut().unwrap().target[0] = f32::NAN;
    assert!(parsed.validate().is_err());
    // 大模型取景距离与 Web 上限一致；只有超过上限才越界。
    let mut parsed: Scene = parse(&with_theme(ok));
    parsed.model_focus.as_mut().unwrap().distance = 10_000.0;
    assert!(parsed.validate().is_ok());
    parsed.model_focus.as_mut().unwrap().distance = 10_000_001.0;
    assert_eq!(parsed.validate(), Err("Invalid model focus distance"));
}

#[test]
fn scene_without_model_focus_keeps_normal_canvas() {
    // 缺省字段：普通正交画布（不报错、无聚焦）。
    let scene: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[]}"#,
    ));
    assert!(scene.model_focus.is_none());
    assert!(scene.model_editor.is_none());
    // 缺省即无框选（change: fix-group-and-marquee-preview）。
    assert!(scene.marquee.is_none());
    // 缺省即无拖动粘连操作条（change: add-drag-touch-connections）。
    assert!(scene.drag_attach.is_none());
    assert!(scene.validate().is_ok());
}

#[test]
fn parses_marquee() {
    let scene: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"marquee":{"x":10.0,"y":20.0,"width":100.0,"height":-50.0}}"#,
    ));
    let marquee = scene.marquee.as_ref().expect("marquee");
    assert_eq!((marquee.x, marquee.y), (10.0, 20.0));
    assert_eq!((marquee.width, marquee.height), (100.0, -50.0));
    assert!(scene.validate().is_ok());
}

#[test]
fn parses_and_validates_model_editor() {
    let json = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","cameraTool":"orbit","cameraId":"cam-a","focus":[0,1,0],"radius":2.0,"shot":{"position":[1,2,1],"focus":[0,1,0],"fov":0.87,"azimuth":0.4,"elevation":0.785,"distance":5.0,"aspect":"1:1"}}}"#;
    let scene: Scene = parse(&with_theme(json));
    assert!(scene.validate().is_ok());
    let editor = scene.model_editor.as_ref().expect("editor");
    assert_eq!(editor.tool_mode, "camera");
    assert_eq!(editor.camera_tool.as_deref(), Some("orbit"));
    assert_eq!(editor.shot.as_ref().unwrap().aspect, "1:1");
    // 缺省 aspect 兼容读取为 16:9。
    let legacy = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","focus":[0,1,0],"radius":2.0,"shot":{"position":[1,2,1],"focus":[0,1,0],"fov":0.87,"azimuth":0.4,"elevation":0.785,"distance":5.0}}}"#;
    let scene: Scene = parse(&with_theme(legacy));
    assert!(scene.validate().is_ok());
    assert_eq!(
        scene
            .model_editor
            .as_ref()
            .unwrap()
            .shot
            .as_ref()
            .unwrap()
            .aspect,
        "16:9"
    );
}

#[test]
fn accepts_expanded_shot_aspects() {
    // 与 Web `MODEL_CAMERA_ASPECTS` 并集一致：每个画幅都能通过边界校验并解析出正比例。
    for &aspect in crate::protocol::SUPPORTED_SHOT_ASPECTS {
        let json = format!(
            r#"{{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","focus":[0,1,0],"radius":2,"shot":{{"position":[1,2,1],"focus":[0,1,0],"fov":0.87,"azimuth":0,"elevation":0.785,"distance":5,"aspect":"{aspect}"}}}}}}"#
        );
        let scene: Scene = parse(&with_theme(&json));
        assert!(scene.validate().is_ok(), "aspect {aspect} 应通过校验");
        let ratio = crate::protocol::parse_shot_aspect_ratio(aspect).expect("应解析出比例");
        assert!(ratio.is_finite() && ratio > 0.0);
    }
    assert!(crate::protocol::parse_shot_aspect_ratio("7:3").is_none());
}

#[test]
fn rejects_invalid_model_editor() {
    // 未知版本。
    let bad = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v0","nodeId":"m1","toolMode":"model","focus":[0,1,0],"radius":2}}"#;
    let parsed: Scene = parse(&with_theme(bad));
    assert!(parsed.validate().is_err());
    // 未知工具模式。
    let bad_mode = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"scale","focus":[0,1,0],"radius":2}}"#;
    let parsed: Scene = parse(&with_theme(bad_mode));
    assert!(parsed.validate().is_err());
    // 未知镜头工具 / 未知画幅。
    let bad_tool = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","cameraTool":"roll","focus":[0,1,0],"radius":2}}"#;
    let parsed: Scene = parse(&with_theme(bad_tool));
    assert!(parsed.validate().is_err());
    let bad_aspect = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","focus":[0,1,0],"radius":2,"shot":{"position":[1,2,1],"focus":[0,1,0],"fov":0.87,"azimuth":0,"elevation":0.785,"distance":5,"aspect":"7:3"}}}"#;
    let parsed: Scene = parse(&with_theme(bad_aspect));
    assert!(parsed.validate().is_err());
    // 非有限几何。
    let ok = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"model","focus":[0,1,0],"radius":2}}"#;
    let mut parsed: Scene = parse(&with_theme(ok));
    parsed.model_editor.as_mut().unwrap().focus[1] = f32::NAN;
    assert!(parsed.validate().is_err());
    // 非法 shot 尺寸。
    let bad_shot = r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"modelEditor":{"version":"woohaa-model-editor-v2","nodeId":"m1","toolMode":"camera","focus":[0,1,0],"radius":2,"shot":{"position":[1,2,1],"focus":[0,1,0],"fov":0,"azimuth":0,"elevation":0.785,"distance":5}}}"#;
    let parsed: Scene = parse(&with_theme(bad_shot));
    assert!(parsed.validate().is_err());
}

#[test]
fn hover_defaults_to_absent_and_parses_when_present() {
    // 缺省：所有端点静止不绘制（change: add-node-endpoint-hover）。
    let scene: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[]}"#,
    ));
    assert!(scene.hover.is_none());
    assert!(scene.validate().is_ok());
    // 携带节点悬停但无端点侧：port 缺省为 None。
    let card: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"hover":{"nodeId":"n1"}}"#,
    ));
    let hover = card.hover.as_ref().expect("hover");
    assert_eq!(hover.node_id.as_deref(), Some("n1"));
    assert!(hover.port.is_none());
    assert!(hover.edge_id.is_none());
    assert!(card.validate().is_ok());
    // 携带端点侧。
    let port: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"hover":{"nodeId":"n1","port":"output"}}"#,
    ));
    assert_eq!(
        port.hover.as_ref().and_then(|h| h.port.as_deref()),
        Some("output")
    );
    assert!(port.validate().is_ok());
    // 连线悬停（change: add-edge-hover-delete）。
    let edge: Scene = parse(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v43","nodes":[],"edges":[],"hover":{"edgeId":"e1"}}"#,
    ));
    let hover = edge.hover.as_ref().expect("hover");
    assert_eq!(hover.edge_id.as_deref(), Some("e1"));
    assert!(hover.node_id.is_none());
    assert!(edge.validate().is_ok());
}

#[test]
fn capabilities_are_independent_of_palette_and_old_renderer_contract_is_rejected() {
    let mut scene = parse(&scene_json(""));
    // 旧客户端携带 `modelPreview`：v43 起该字段已删除，按未知字段忽略而不是部分渲染。
    scene.nodes = serde_json::from_value(serde_json::json!([
        {"id":"new","type":"node","x":0,"y":0,
        "modelPreview":{"azimuth":0,"elevation":0.5,"distanceScale":1}}
    ]))
    .unwrap();
    assert!(scene.validate().is_ok());
    // 旧场景版本按版本化边界整帧拒绝，不进入部分渲染。
    scene.version = "woohaa-canvas-render-scene-v26".into();
    assert!(scene.validate().is_err());
}


