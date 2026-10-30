//! protocol 通用呈现原语单元测试：预览卡片、归属线与 `shot-node-preview` 模式
//! （change: 2026-10-15-add-film-set-shooting-shot-previews；
//!  change: 2026-10-28-generic-extension-content-ownership 任务 4.3 通用化）。
//!
//! 只验证 wire 结构与边界校验，不创建 renderer 或冒充画面验证（真实 GPU 验收另见
//! notes/verification.md）。

use super::tests::theme_object;
use super::*;

const VERSION: &str = r#""version":"woohaa-canvas-render-scene-v32""#;

fn with_theme(json: &str) -> String {
    json.replace(
        r#""edges":[]"#,
        &format!(r#""edges":[],"theme":{}"#, theme_object()),
    )
}

fn parse(json: &str) -> Scene {
    let mut scene: Scene =
        serde_json::from_str(&with_theme(json)).expect("valid generic primitive scene json");
    scene.index_primitives();
    scene
}

fn owner_and_card(card: &str) -> String {
    format!(
        r#"{{{VERSION},"nodes":[{{"id":"film","type":"node","x":0,"y":0}},{{"id":"p1","type":"node","x":480,"y":50}}],"edges":[],"previewCards":[{card}]}}"#
    )
}

fn card(body: &str) -> String {
    format!(
        r#"{{"nodeId":"p1","ownerNodeId":"film","entityId":"clip-1","animated":true,"title":"运镜","aspect":1.7778,"duration":4.0,"coverCamera":{{"azimuth":0.0,"elevation":0.785398,"distance":6.0,"focusOffset":[0,0,0]}},"state":"ready"{body}}}"#
    )
}

#[test]
fn preview_card_defaults_to_absent_and_parses_when_present() {
    // 缺省：不绘制预览内容（未知/停用扩展或非法帧）。
    let plain = parse(&format!(
        r#"{{{VERSION},"nodes":[{{"id":"n1","type":"node","x":0,"y":0}}],"edges":[]}}"#
    ));
    assert!(plain.nodes[0].preview_card.is_none());
    assert!(plain.validate().is_ok());

    // 携带动态卡片呈现：身份/标题/画幅/时长/状态与本地播放进度。
    let scene = parse(&owner_and_card(&card(
        r#","typeLabel":"动态镜头","progress":0.25,"playing":true"#,
    )));
    let card = scene.nodes[1].preview_card.as_ref().expect("previewCard");
    assert_eq!(card.node_id, "p1");
    assert_eq!(card.owner_node_id, "film");
    assert_eq!(card.entity_id, "clip-1");
    assert!(card.animated);
    assert!(!card.hidden);
    assert_eq!(card.title, "运镜");
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
fn preview_card_requires_valid_cover_camera() {
    // 缺失 coverCamera：serde 拒绝整帧（不静默回退到另一套取景公式）。
    let missing = format!(
        r#"{{{VERSION},"nodes":[{{"id":"film","type":"node","x":0,"y":0}},{{"id":"p1","type":"node","x":0,"y":0}}],"edges":[],"previewCards":[{{"nodeId":"p1","ownerNodeId":"film","entityId":"c","aspect":1.0,"state":"ready"}}]}}"#
    );
    assert!(serde_json::from_str::<Scene>(&missing).is_err());

    // 非有限/非正距离/共线仰角：整帧拒绝（保留最近合法 scene）。
    for camera in [
        r#"{"azimuth":0.0,"elevation":0.5,"distance":0.0,"focusOffset":[0,0,0]}"#,
        r#"{"azimuth":0.0,"elevation":1.5707964,"distance":4.0,"focusOffset":[0,0,0]}"#,
        r#"{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,1e40]}"#,
    ] {
        let scene = parse(&owner_and_card(&format!(
            r#"{{"nodeId":"p1","ownerNodeId":"film","entityId":"c","aspect":1.0,"duration":0.0,"coverCamera":{camera},"state":"ready"}}"#
        )));
        assert!(
            scene.validate().is_err(),
            "非法 coverCamera 必须拒绝: {camera}"
        );
    }
}

#[test]
fn preview_card_rejects_invalid_state_aspect_and_progress() {
    let bad_state = parse(&owner_and_card(&format!(
        r#"{{"nodeId":"p1","ownerNodeId":"film","entityId":"c","aspect":1.0,"coverCamera":{{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]}},"state":"unknown"}}"#
    )));
    assert!(bad_state.validate().is_err());

    let bad_aspect = parse(&owner_and_card(&format!(
        r#"{{"nodeId":"p1","ownerNodeId":"film","entityId":"c","aspect":0.0,"coverCamera":{{"azimuth":0.0,"elevation":0.5,"distance":4.0,"focusOffset":[0,0,0]}},"state":"ready"}}"#
    )));
    assert!(bad_aspect.validate().is_err());

    let bad_progress = parse(&owner_and_card(&card(r#","progress":1.5"#)));
    assert!(bad_progress.validate().is_err());
}

#[test]
fn ownership_links_parse_validate_and_keep_unknown_payload() {
    // 缺省：无派生归属线。
    let none = parse(&format!(r#"{{{VERSION},"nodes":[],"edges":[]}}"#));
    assert!(none.ownership_links.is_empty());
    assert!(none.validate().is_ok());

    // 携带归属线：起点由宿主投影给出，目标为卡片节点集合。
    let scene = parse(&format!(
        r#"{{{VERSION},"nodes":[{{"id":"film","type":"node","x":0,"y":0}},{{"id":"p1","type":"node","x":480,"y":50}}],"edges":[],"ownershipLinks":[{{"id":"link:film:clip-1","ownerNodeId":"film","start":{{"x":120,"y":80}},"targetNodeIds":["p1"],"payload":{{"extensionId":"example.future","schemaVersion":"v9","data":{{"opaque":true}}}}}}]}}"#
    ));
    assert_eq!(scene.ownership_links.len(), 1);
    let link = &scene.ownership_links[0];
    assert_eq!(link.owner_node_id, "film");
    assert_eq!(link.target_node_ids, vec!["p1".to_owned()]);
    assert_eq!(link.start.as_ref().unwrap().x, 120.0);
    // 未知扩展载荷完全透传，Rust 不读取、也不因未知版本拒绝整帧。
    assert_eq!(
        link.payload.as_ref().map(|payload| payload.extension_id.as_str()),
        Some("example.future")
    );
    assert!(scene.validate().is_ok());

    // 非法：空身份或空目标集合被拒绝整帧（保留最近合法 scene）。
    let bad = parse(&format!(
        r#"{{{VERSION},"nodes":[{{"id":"p1","type":"node","x":0,"y":0}}],"edges":[],"ownershipLinks":[{{"id":"link","ownerNodeId":"","start":{{"x":0,"y":0}},"targetNodeIds":["p1"]}}]}}"#
    ));
    assert!(bad.validate().is_err());

    let no_target = parse(&format!(
        r#"{{{VERSION},"nodes":[{{"id":"film","type":"node","x":0,"y":0}}],"edges":[],"ownershipLinks":[{{"id":"link","ownerNodeId":"film","start":{{"x":0,"y":0}},"targetNodeIds":[]}}]}}"#
    ));
    assert!(no_target.validate().is_err());
}

#[test]
fn shot_node_preview_view_mode_parses_with_target_card() {
    // `shot-node-preview` 模式：明确目标预览卡片，不复用默认片段/地面资格。
    let scene = parse(&format!(
        r#"{{{VERSION},"nodes":[],"edges":[],"animationPlayback":{{"viewMode":"shot-node-preview","targetPreviewNodeId":"shot-preview:AAAA","nodeId":"film","version":"woohaa-motion-ir-v1","time":0.0,"duration":4.0,"playing":true,"initialCamera":{{"azimuth":0,"elevation":0.5,"distance":4,"focusOffset":[0,0,0]}},"cameraMotion":[],"modelMotion":[]}}}}"#
    ));
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
