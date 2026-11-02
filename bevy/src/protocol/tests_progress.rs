//! protocol 节点进度起点单元测试
//! （change: 2026-10-31-unify-node-and-activity-progress）。
//!
//! 节点进度环按 `progressStartedAt`（与活动面板同一条记录的创建时刻）估算经过时间；缺省时
//! 退回渲染器本地时钟。只验证 wire 结构与边界校验，不创建 renderer。

use super::tests::theme_object;
use super::*;

fn parse(json: &str) -> Scene {
    let with_theme = json.replace(
        r#""edges":[]"#,
        &format!(r#""edges":[],"theme":{}"#, theme_object()),
    );
    serde_json::from_str(&with_theme).expect("valid scene json")
}

#[test]
fn node_progress_start_defaults_to_absent() {
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v36","nodes":[{"id":"n1","type":"image","x":0,"y":0,"busy":true,"progress":20.0}],"edges":[]}"#,
    );
    assert_eq!(scene.nodes[0].progress_started_at, None);
    assert!(scene.validate().is_ok());
}

#[test]
fn node_progress_start_parses_from_camel_case_field() {
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v36","nodes":[{"id":"n1","type":"image","x":0,"y":0,"busy":true,"progress":20.0,"progressStartedAt":1767225600000}],"edges":[]}"#,
    );
    assert_eq!(scene.nodes[0].progress_started_at, Some(1_767_225_600_000.0));
    assert!(scene.validate().is_ok());
}

#[test]
fn invalid_node_progress_start_rejects_frame() {
    // 负起点没有任何经过时间可算；整帧拒绝而不是静默夹取。
    let scene = parse(
        r#"{"version":"woohaa-canvas-render-scene-v36","nodes":[{"id":"n1","type":"image","x":0,"y":0,"busy":true,"progressStartedAt":-1}],"edges":[]}"#,
    );
    assert!(scene.validate().is_err());
}
