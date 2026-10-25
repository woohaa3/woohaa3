//! protocol 瞬时投影单元测试：拖动粘连与多选聚合
//! （change: add-drag-touch-connections / add-multi-select-aggregate-connect）。

use super::tests::theme_object;
use super::*;

/// 给不含 theme 的 scene JSON 注入完整合法 theme
/// （change: 2026-10-07-remove-residual-compatibility）。
fn with_theme(json: &str) -> String {
    json.replace(
        r#""edges":[]"#,
        &format!(r#""edges":[],"theme":{}"#, theme_object()),
    )
}

#[test]
fn rejects_previous_v6_scene_version() {
    // change: add-drag-touch-connections —— 旧 v6 Frontend/WASM 组合必须被稳定拒绝，
    // 不静默忽略 dragAttach 字段。
    let v6 = r#"{"version":"woohaa-canvas-render-scene-v6","nodes":[],"edges":[]}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(v6)).expect("parse");
    assert_eq!(
        parsed.validate(),
        Err("Unsupported canvas render scene version")
    );
}

#[test]
fn drag_attach_defaults_to_absent_and_parses_when_present() {
    // 缺省：不绘制操作条（change: add-drag-touch-connections）。
    let scene: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[]}"#,
    ))
    .expect("parse");
    assert!(scene.drag_attach.is_none());
    assert!(scene.validate().is_ok());
    // 携带模式、接触目标与待提交边。
    let attach: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"dragAttach":{"nodeId":"n1","mode":"successor","contactNodeId":"n2","pendingEdges":[{"id":"e1","source":"n1","target":"n2"}]}}"#,
    ))
    .expect("parse");
    let attach = attach.drag_attach.as_ref().expect("dragAttach");
    assert_eq!(attach.node_id, "n1");
    assert_eq!(attach.mode.as_deref(), Some("successor"));
    assert_eq!(attach.contact_node_id.as_deref(), Some("n2"));
    assert_eq!(attach.pending_edges.len(), 1);
    assert_eq!(attach.pending_edges[0].target, "n2");
    assert!(scene.validate().is_ok());
    // 仅显示操作条（未按住 Q/E）：mode 缺省、无待提交边。
    let bar: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"dragAttach":{"nodeId":"n1"}}"#,
    ))
    .expect("parse");
    let bar = bar.drag_attach.as_ref().expect("dragAttach");
    assert!(bar.mode.is_none());
    assert!(bar.contact_node_id.is_none());
    assert!(bar.pending_edges.is_empty());
    assert!(bar.validate().is_ok());
}

#[test]
fn rejects_invalid_drag_attach() {
    // 未知粘连方向：解析通过但校验失败（防御校验在 validate）。
    let bad_mode = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"dragAttach":{"nodeId":"n1","mode":"bidirectional"}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_mode)).expect("parse");
    assert!(parsed.validate().is_err());
    // 自身连线待提交边。
    let self_edge = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"dragAttach":{"nodeId":"n1","pendingEdges":[{"id":"e1","source":"n1","target":"n1"}]}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(self_edge)).expect("parse");
    assert!(parsed.validate().is_err());
    // 空 nodeId。
    let empty = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"dragAttach":{"nodeId":"","mode":"predecessor"}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(empty)).expect("parse");
    assert!(parsed.validate().is_err());
}

#[test]
fn rejects_previous_v7_scene_version() {
    // change: add-multi-select-aggregate-connect —— 旧 v7 Frontend/WASM 组合必须被稳定拒绝，
    // 不静默忽略 aggregateConnect 字段。
    let v7 = r#"{"version":"woohaa-canvas-render-scene-v7","nodes":[],"edges":[]}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(v7)).expect("parse");
    assert_eq!(
        parsed.validate(),
        Err("Unsupported canvas render scene version")
    );
}

#[test]
fn aggregate_connect_defaults_to_absent_and_parses_when_present() {
    // 缺省：不绘制聚合把手（change: add-multi-select-aggregate-connect）。
    let scene: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[]}"#,
    ))
    .expect("parse");
    assert!(scene.aggregate_connect.is_none());
    assert!(scene.validate().is_ok());
    // 仅显示把手（未拖拽）：direction 缺省、无 cursor/pending。
    let handles: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"aggregateConnect":{"direction":null,"pendingEdges":[]}}"#,
    ))
    .expect("parse");
    let handles = handles
        .aggregate_connect
        .as_ref()
        .expect("aggregateConnect");
    assert!(handles.direction.is_none());
    assert!(handles.cursor.is_none());
    assert!(handles.pending_edges.is_empty());
    assert!(handles.validate().is_ok());
    // 拖拽输出：方向 + cursor + 预览边。
    let dragging: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"aggregateConnect":{"direction":"output","cursor":{"x":12.0,"y":34.0},"pendingEdges":[{"id":"e1","source":"a","target":"b"}]}}"#,
    ))
    .expect("parse");
    let dragging = dragging
        .aggregate_connect
        .as_ref()
        .expect("aggregateConnect");
    assert_eq!(dragging.direction.as_deref(), Some("output"));
    assert_eq!(dragging.cursor.map(|c| (c.x, c.y)), Some((12.0, 34.0)));
    assert_eq!(dragging.pending_edges.len(), 1);
    assert!(dragging.validate().is_ok());
}

#[test]
fn rejects_invalid_aggregate_connect() {
    // 未知方向。
    let bad_dir = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"aggregateConnect":{"direction":"sideways"}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_dir)).expect("parse");
    assert!(parsed.validate().is_err());
    // 非有限 cursor。
    let bad_cursor = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"aggregateConnect":{"direction":"input","cursor":{"x":0.0,"y":1e40}}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_cursor)).expect("parse");
    assert!(parsed.validate().is_err());
    // 自身预览边。
    let self_edge = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"aggregateConnect":{"direction":"output","pendingEdges":[{"id":"e1","source":"a","target":"a"}]}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(self_edge)).expect("parse");
    assert!(parsed.validate().is_err());
}

#[test]
fn image_focus_defaults_to_absent_and_parses_when_present() {
    // 缺省：普通画布（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
    let scene: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[]}"#,
    ))
    .expect("parse");
    assert!(scene.image_focus.is_none());
    assert!(scene.validate().is_ok());
    // 携带合法投影。
    let focus: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"imageFocus":{"version":"woohaa-image-focus-v1","nodeId":"img1","viewport":{"x":12.5,"y":-8.0,"zoom":2.0},"sourceWidth":1024.0,"sourceHeight":768.0}}"#,
    ))
    .expect("parse");
    let focus = focus.image_focus.as_ref().expect("imageFocus");
    assert_eq!(focus.node_id, "img1");
    assert_eq!(focus.viewport.zoom, 2.0);
    assert_eq!(focus.source_width, 1024.0);
    assert_eq!(focus.source_height, 768.0);
    assert!(focus.validate().is_ok());
}

#[test]
fn rejects_invalid_image_focus() {
    // 未知版本。
    let bad_version = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"imageFocus":{"version":"woohaa-image-focus-v0","nodeId":"img1","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_version)).expect("parse");
    assert_eq!(parsed.validate(), Err("Unknown image focus version"));
    // 空 nodeId。
    let empty = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"imageFocus":{"version":"woohaa-image-focus-v1","nodeId":"","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(empty)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid image focus node id"));
    // 非有限取景。
    let bad_viewport = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"imageFocus":{"version":"woohaa-image-focus-v1","nodeId":"img1","viewport":{"x":1e40,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_viewport)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid image focus viewport"));
    // 非正源尺寸。
    let bad_source = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"imageFocus":{"version":"woohaa-image-focus-v1","nodeId":"img1","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":0.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_source)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid image focus source size"));
}

#[test]
fn video_focus_defaults_to_absent_and_parses_when_present() {
    // 缺省：普通画布（change: 2026-10-10-add-video-node-focus-workspace）。
    let scene: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[]}"#,
    ))
    .expect("parse");
    assert!(scene.video_focus.is_none());
    assert!(scene.validate().is_ok());
    // 携带合法投影。
    let focus: Scene = serde_json::from_str(&with_theme(
        r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"videoFocus":{"version":"woohaa-video-focus-v1","nodeId":"vid1","viewport":{"x":12.5,"y":-8.0,"zoom":2.0},"sourceWidth":1920.0,"sourceHeight":1080.0}}"#,
    ))
    .expect("parse");
    let focus = focus.video_focus.as_ref().expect("videoFocus");
    assert_eq!(focus.node_id, "vid1");
    assert_eq!(focus.viewport.zoom, 2.0);
    assert_eq!(focus.source_width, 1920.0);
    assert_eq!(focus.source_height, 1080.0);
    assert!(focus.validate().is_ok());
}

#[test]
fn rejects_invalid_video_focus() {
    // 未知版本。
    let bad_version = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"videoFocus":{"version":"woohaa-video-focus-v0","nodeId":"vid1","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_version)).expect("parse");
    assert_eq!(parsed.validate(), Err("Unknown video focus version"));
    // 空 nodeId。
    let empty = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"videoFocus":{"version":"woohaa-video-focus-v1","nodeId":"","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(empty)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid video focus node id"));
    // 非有限取景。
    let bad_viewport = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"videoFocus":{"version":"woohaa-video-focus-v1","nodeId":"vid1","viewport":{"x":1e40,"y":0.0,"zoom":1.0},"sourceWidth":10.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_viewport)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid video focus viewport"));
    // 非正源尺寸。
    let bad_source = r#"{"version":"woohaa-canvas-render-scene-v29","nodes":[],"edges":[],"videoFocus":{"version":"woohaa-video-focus-v1","nodeId":"vid1","viewport":{"x":0.0,"y":0.0,"zoom":1.0},"sourceWidth":0.0,"sourceHeight":10.0}}"#;
    let parsed: Scene = serde_json::from_str(&with_theme(bad_source)).expect("parse");
    assert_eq!(parsed.validate(), Err("Invalid video focus source size"));
}
