//! 模式数据内容身份的回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
//!
//! 与 `packages/protocol/src/features/modes/content.test.ts` 共读
//! `packages/protocol/src/features/modes/content-fixtures.json`：任一侧的规范文本漂移都会失败。

use serde_json::Value;

use super::{canonicalize_mode, is_default_mode, mode_json, mode_line};
use crate::Editor;

fn fixtures() -> Value {
    // CARGO_MANIFEST_DIR = rust/crates/editor-core
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/protocol/src/features/modes/content-fixtures.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读取 {}: {error}", path.display()));
    serde_json::from_str(&text).expect("解析 content-fixtures.json")
}

fn open(width: u32, height: u32) -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", serde_json::json!({"width": width, "height": height, "mode": "rgb"})).unwrap();
    editor
}

fn doc_line(editor: &Editor) -> String {
    mode_line(&editor.session.active().expect("document").doc).expect("identity line")
}

#[test]
fn fixture_cases_canonicalize_to_the_shared_expected_text() {
    let fixture = fixtures();
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let expected = case["canonical"].as_str().expect("canonical");
        let input = if case["mode"].is_null() { None } else { Some(&case["mode"]) };
        assert_eq!(
            canonicalize_mode(input).as_deref(),
            Some(expected),
            "fixture 用例「{name}」的规范文本不一致"
        );
    }
}

#[test]
fn fixture_rejections_are_never_treated_as_unchanged() {
    let fixture = fixtures();
    let rejections = fixture["rejections"].as_array().expect("rejections");
    assert!(!rejections.is_empty());
    for case in rejections {
        let name = case["name"].as_str().expect("name");
        assert_eq!(canonicalize_mode(Some(&case["mode"])), None, "用例「{name}」应判为不可判定");
    }
}

#[test]
fn default_rgb_document_contributes_no_identity_line() {
    let editor = open(8, 6);
    let doc = &editor.session.active().expect("document").doc;
    assert!(is_default_mode(doc));
    assert_eq!(mode_json(doc), None, "缺省模式不应写入内容字段");
    assert_eq!(mode_line(doc).as_deref(), Some(""), "缺省模式不应追加身份行");
}

#[test]
fn conversions_produce_stable_identity_lines() {
    let mut editor = open(8, 6);
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    assert_eq!(doc_line(&editor), "mode:grayscale");

    editor.apply_mode("indexed", serde_json::json!({"colors": 4, "dither": "none"})).unwrap();
    let line = doc_line(&editor);
    assert!(line.starts_with("mode:indexed|table:"), "{line}");
    assert_eq!(doc_line(&editor), line, "同一文档两次规范化必须一致");
}

/// 任务 3.2 的核心断言：本域身份贡献必须能区分颜色表与油墨编辑。
/// 共享折叠入口尚未接入（见 change 的交接清单），这里直接验证贡献文本本身。
#[test]
fn color_table_and_ink_edits_change_the_identity_contribution() {
    let mut editor = open(8, 6);
    editor.apply_mode("indexed", serde_json::json!({"colors": 4, "dither": "none"})).unwrap();
    let before = doc_line(&editor);
    assert_eq!(editor.plan_color_table(serde_json::json!({"entries": {"0": "#00ff00"}})).unwrap()["changed"], true);
    editor.apply_color_table(serde_json::json!({"entries": {"0": "#00ff00"}})).unwrap();
    let after = doc_line(&editor);
    assert_ne!(after, before);
    assert_ne!(crate::identity::fnv1a64_hex(&after), crate::identity::fnv1a64_hex(&before));

    let mut editor = open(8, 6);
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    editor.apply_mode("duotone", serde_json::json!({"type": "monotone"})).unwrap();
    let before = doc_line(&editor);
    let params = serde_json::json!({"type": "tritone", "inks": [
        {"name": "Black", "color": "#101010", "curve": []},
        {"name": "Warm", "color": "#aa5522", "curve": []},
        {"name": "Blue", "color": "#2244aa", "curve": []}
    ]});
    assert_eq!(editor.plan_mode("duotone", params.clone()).unwrap()["changed"], true);
    editor.apply_mode("duotone", params).unwrap();
    let after = doc_line(&editor);
    assert!(after.starts_with("mode:duotone|inks:3:"), "{after}");
    assert!(after.contains("5:Black#101010#2:0,0;10000,10000"), "{after}");
    assert_ne!(after, before);
}

/// 改油墨名只影响身份、不影响像素；但名字属持久内容，必须计入。
#[test]
fn ink_names_participate_in_identity() {
    let mut editor = open(8, 6);
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    editor.apply_mode("duotone", serde_json::json!({"type": "monotone"})).unwrap();
    let first = doc_line(&editor);

    let mut editor = open(8, 6);
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    editor
        .apply_mode(
            "duotone",
            serde_json::json!({"type": "duotone", "inks": [
                {"name": "Iron", "color": "#000000", "curve": []},
                {"name": "Gold", "color": "#aaaa33", "curve": []}
            ]}),
        )
        .unwrap();
    let second = doc_line(&editor);
    assert_ne!(first, second);
    assert!(second.contains("4:Iron"), "{second}");
}
