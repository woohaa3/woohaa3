//! protocol 拍摄镜头预览单元测试：卡片呈现、归属线与 `shot-node-preview` 模式
//! （change: 2026-10-15-add-film-set-shooting-shot-previews）。
//!
//! 只验证 wire 结构与边界校验，不创建 renderer 或冒充画面验证（真实 GPU 验收另见
//! notes/verification.md）。

use super::tests::theme_object;
use super::*;

fn with_theme(json: &str) -> String {
    json.replace(
        r#""edges":[]"#,
        &format!(r#""edges":[],"theme":{}"#, theme_object()),
    )
}

fn parse(json: &str) -> Scene {
    serde_json::from_str(&with_theme(json)).expect("valid shot preview scene json")
}

#[test]
fn shot_preview_defaults_to_absent_and_parses_when_present() {
    // 缺省：不绘制预览内容（未知/停用扩展或非法帧）。
    let plain = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"n1","type":"node","x":0,"y":0}],"edges":[]}"#,
    );
    assert!(plain.nodes[0].shot_preview.is_none());
    assert!(plain.validate().is_ok());

    // 携带动态镜头卡片呈现：标题/类型/画幅/时长/状态与本地播放进度。
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":480,"y":50,"shotPreview":{"filmSetNodeId":"film","clipId":"clip-1","kind":"dynamic","name":"运镜","aspect":1.7778,"duration":4.0,"coverCamera":{"azimuth":0.0,"elevation":0.785398,"distance":6.0,"focusOffset":[0,0,0]},"state":"ready","progress":0.25,"playing":true}}],"edges":[]}"#,
    );
    let card = scene.nodes[0].shot_preview.as_ref().expect("shotPreview");
    assert_eq!(card.film_set_node_id, "film");
    assert_eq!(card.clip_id, "clip-1");
    assert_eq!(card.kind, "dynamic");
    assert!(!card.hidden);
    assert_eq!(card.name, "运镜");
    assert!((card.aspect - 1.7778).abs() < 1e-3);
    assert_eq!(card.state, "ready");
    assert_eq!(card.progress, Some(0.25));
    assert_eq!(card.playing, Some(true));
    assert!(
        (card.cover_camera.distance - 6.0).abs() < 1e-6,
        "零点封面相机随卡片下发"
    );
    assert!(scene.validate().is_ok());
}

#[test]
fn shot_preview_requires_valid_cover_camera() {
    // 缺失 coverCamera：serde 拒绝整帧（不静默回退到另一套取景公式）。
    let missing = r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{"filmSetNodeId":"film","clipId":"c","kind":"static","name":"x","aspect":1.0,"duration":0.0,"state":"ready"}}],"edges":[]}"#;
    assert!(serde_json::from_str::<Scene>(&missing).is_err());

    // 非有限/非正距离/共线仰角：整帧拒绝（保留最近合法 scene）。
    for camera in [
        r#""coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":0.0,"focusOffset":[0,0,0]}"#,
        r#""coverCamera":{"azimuth":0.0,"elevation":1.5707964,"distance":4.0,"focusOffset":[0,0,0]}"#,
        r#""coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,1e40]}"#,
    ] {
        let scene = parse(&format!(
            r#"{{"version":"woohaa-canvas-render-scene-v34","nodes":[{{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{{"filmSetNodeId":"film","clipId":"c","kind":"static","name":"x","aspect":1.0,"duration":0.0,{camera},"state":"ready"}}}}],"edges":[]}}"#
        ));
        assert!(
            scene.validate().is_err(),
            "非法 coverCamera 必须拒绝: {camera}"
        );
    }
}

#[test]
fn shot_preview_rejects_invalid_kind_state_aspect_and_progress() {
    let bad_kind = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{"filmSetNodeId":"film","clipId":"c","kind":"loop","name":"x","aspect":1.0,"duration":1.0,"coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]},"state":"ready"}}],"edges":[]}"#,
    );
    assert!(bad_kind.validate().is_err());

    let bad_state = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{"filmSetNodeId":"film","clipId":"c","kind":"static","name":"x","aspect":1.0,"duration":0.0,"coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]},"state":"unknown"}}],"edges":[]}"#,
    );
    assert!(bad_state.validate().is_err());

    let bad_aspect = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{"filmSetNodeId":"film","clipId":"c","kind":"static","name":"x","aspect":0.0,"duration":0.0,"coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]},"state":"ready"}}],"edges":[]}"#,
    );
    assert!(bad_aspect.validate().is_err());

    let bad_progress = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[{"id":"p1","type":"node","x":0,"y":0,"shotPreview":{"filmSetNodeId":"film","clipId":"c","kind":"dynamic","name":"x","aspect":1.0,"duration":2.0,"coverCamera":{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]},"state":"ready","progress":1.5}}],"edges":[]}"#,
    );
    assert!(bad_progress.validate().is_err());
}

#[test]
fn shot_preview_links_parse_and_validate() {
    // 缺省：无可见拍摄镜头（不派生归属线）。
    let none = parse(r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[],"edges":[]}"#);
    assert!(none.shot_preview_links.is_empty());
    assert!(none.validate().is_ok());

    // 携带归属线：起点/终点身份与卡片接口。
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[],"edges":[],"shotPreviewLinks":[{"id":"link:film:clip-1","ownerNodeId":"film","previewNodeId":"shot-preview:AAAA","clipId":"clip-1","start":{"x":120,"y":80}}]}"#,
    );
    assert_eq!(scene.shot_preview_links.len(), 1);
    let link = &scene.shot_preview_links[0];
    assert_eq!(link.owner_node_id, "film");
    assert_eq!(link.preview_node_id, "shot-preview:AAAA");
    assert_eq!(link.clip_id, "clip-1");
    assert_eq!(link.start.x, 120.0);
    assert!(scene.validate().is_ok());

    // 非法：空身份或非有限起点被拒绝整帧（保留最近合法 scene）。
    let bad = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[],"edges":[],"shotPreviewLinks":[{"id":"link:film:clip-1","ownerNodeId":"","previewNodeId":"shot-preview:AAAA","clipId":"clip-1","start":{"x":0,"y":0}}]}"#,
    );
    assert!(bad.validate().is_err());
}

#[test]
fn shot_node_preview_view_mode_parses_with_target_card() {
    // `shot-node-preview` 模式：明确目标预览卡片，不复用默认片段/地面资格。
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v34","nodes":[],"edges":[],"animationPlayback":{"viewMode":"shot-node-preview","targetPreviewNodeId":"shot-preview:AAAA","nodeId":"film","version":"woohaa-motion-ir-v1","time":0.0,"duration":4.0,"playing":true,"initialCamera":{"azimuth":0,"elevation":0.5,"distance":4,"focusOffset":[0,0,0]},"cameraMotion":[],"modelMotion":[]}}"#,
    );
    let playback = scene
        .animation_playback
        .as_ref()
        .expect("animationPlayback");
    assert_eq!(playback.view_mode, "shot-node-preview");
    assert_eq!(
        playback.target_preview_node_id.as_deref(),
        Some("shot-preview:AAAA")
    );
    assert!(scene.validate().is_ok());
}
