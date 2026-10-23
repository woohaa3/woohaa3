//! 内容身份共享折叠的回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
//!
//! 这一层断言的是**共享入口**而不是本域贡献：`document_content::project_content` 必须写入
//! `mode`，`identity::canonicalize` 必须追加模式行，且缺省 RGB/8 位工程的身份逐字节不变。
//! 本域贡献的规范文本见 `features/modes/tests_content.rs`。

use super::*;
use crate::{identity, Editor};

fn open() -> Editor {
    let mut editor = Editor::new();
    editor
        .execute("file.new", serde_json::json!({"width": 8, "height": 6, "mode": "rgb"}))
        .unwrap();
    editor
}

fn doc_of(editor: &Editor) -> &Document {
    &editor.session.active().expect("document").doc
}

fn content_of(editor: &Editor) -> Value {
    project_content(doc_of(editor), &AssetRegistry::default())
}

#[test]
fn default_rgb_documents_keep_their_historical_identity_byte_for_byte() {
    // 旧工程兼容的硬约束：缺省模式不得新增字段，也不得改变规范文本。
    let editor = open();
    let content = content_of(&editor);
    assert!(content.get("mode").is_none(), "缺省 RGB/8 位不应写入 mode 字段");
    let text = identity::canonicalize(&content).expect("规范文本");
    assert!(!text.contains("mode:"), "缺省模式不应追加身份行：{text}");
    assert!(text.starts_with("canvas:8x6\nlayer"), "{text}");
}

#[test]
fn explicit_default_mode_serializes_like_an_omitted_one() {
    // 显式写入 `{"mode":"rgb"}` 与省略等价，否则序列化差异会改变旧工程指纹。
    let editor = open();
    let mut content = content_of(&editor);
    content["mode"] = serde_json::json!({"mode": "rgb"});
    let text = identity::canonicalize(&content).expect("规范文本");
    assert!(!text.contains("mode:"), "{text}");
    assert_eq!(text, identity::canonicalize(&content_of(&editor)).unwrap());
}

#[test]
fn conversions_write_the_mode_field_and_append_one_identity_line() {
    let mut editor = open();
    let before = editor.content_hash().unwrap();
    let before_text = identity::canonicalize(&content_of(&editor)).unwrap();

    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    let content = content_of(&editor);
    assert_eq!(content["mode"]["mode"], "grayscale");
    let text = identity::canonicalize(&content).unwrap();
    assert_eq!(text.lines().filter(|line| line.starts_with("mode:")).count(), 1, "{text}");
    assert!(text.contains("\nmode:grayscale"), "{text}");
    assert_ne!(editor.content_hash().unwrap(), before);
    assert_ne!(text, before_text);
}

#[test]
fn color_table_and_ink_edits_move_the_shared_content_hash() {
    // 这里锁定的正是此前实测的缺口：改颜色表/改油墨必须让 `contentHash` 变化，
    // 否则文档不会被标脏、保存会漏掉这类修改。
    let mut editor = open();
    editor
        .apply_mode("indexed", serde_json::json!({"colors": 4, "dither": "none"}))
        .unwrap();
    let before = editor.content_hash().unwrap();
    editor
        .apply_color_table(serde_json::json!({"entries": {"0": "#00ff00"}}))
        .unwrap();
    assert_ne!(editor.content_hash().unwrap(), before, "改颜色表必须改变内容指纹");

    let mut editor = open();
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    editor
        .apply_mode("duotone", serde_json::json!({"type": "monotone"}))
        .unwrap();
    let before = editor.content_hash().unwrap();
    let params = serde_json::json!({"type": "duotone", "inks": [
        {"name": "Iron", "color": "#101010", "curve": []},
        {"name": "Gold", "color": "#aa5522", "curve": []}
    ]});
    editor.apply_mode("duotone", params).unwrap();
    assert_ne!(editor.content_hash().unwrap(), before, "改油墨必须改变内容指纹");
}

#[test]
fn the_grayscale_to_duotone_step_itself_moves_the_hash() {
    // 实测发现的第二处缺口：这一步不改变像素通道布局，所以以前指纹不动。
    let mut editor = open();
    editor.apply_mode("grayscale", serde_json::json!({})).unwrap();
    let before = editor.content_hash().unwrap();
    editor
        .apply_mode("duotone", serde_json::json!({"type": "monotone"}))
        .unwrap();
    assert_ne!(editor.content_hash().unwrap(), before);
}

#[test]
fn mode_identity_survives_save_and_reload() {
    let mut editor = open();
    editor
        .apply_mode("indexed", serde_json::json!({"colors": 4, "dither": "none"}))
        .unwrap();
    let hash = editor.content_hash().unwrap();
    let saved = editor.save_project().unwrap();
    let loaded = photocraft_format::load_from_bytes(&saved).unwrap();
    assert_eq!(
        document_content_hash(&loaded, &AssetRegistry::default()).unwrap(),
        hash,
        "重开后模式身份必须与保存前一致"
    );
}

#[test]
fn undecidable_mode_data_makes_the_whole_content_undecidable() {
    // 结构错误不能被当作「无变化」：整份内容指纹应为 `None`。
    let editor = open();
    let mut content = content_of(&editor);
    content["mode"] = serde_json::json!({"mode": "indexed"}); // 索引色缺颜色表
    assert!(identity::canonicalize(&content).is_none());
    let mut content = content_of(&editor);
    content["mode"] = serde_json::json!({"mode": "cmyk"});
    assert!(identity::canonicalize(&content).is_none());
}

#[test]
fn colour_models_outside_the_change_scope_still_have_a_content_hash() {
    // 回归（本次改动引入过）：曾把 CMYK/Lab 折成 `{"mode":"other"}`，`canonicalize_mode`
    // 判为不可判定 → 整份指纹为 `None` → `modeInfo`/`contentHash` 直接报 no-document。
    // 范围外颜色模型本域不判定，必须完全不产生模式行。
    for mode in ["cmyk", "lab"] {
        let mut editor = Editor::new();
        editor
            .execute("file.new", serde_json::json!({"width": 8, "height": 6, "mode": mode}))
            .unwrap();
        let content = content_of(&editor);
        assert!(
            content.get("mode").is_none(),
            "{mode} 不应写入模式字段：{content}"
        );
        assert!(identity::canonicalize(&content).is_some(), "{mode} 必须仍有规范文本");
        let hash = editor.content_hash().unwrap_or_else(|error| panic!("{mode}: {error}"));
        assert_eq!(hash.len(), 16, "{mode}");
        // 面板读的只读信息同样必须可用，否则 CMYK/Lab 文档一打开就报错。
        let info = editor.mode_info().unwrap_or_else(|error| panic!("{mode}: {error}"));
        assert_eq!(info["rawMode"], serde_json::json!(if mode == "cmyk" { "Cmyk" } else { "Lab" }));
        assert!(info["targets"].as_array().is_some_and(|targets| targets.len() > 1), "{mode}");
    }
}
