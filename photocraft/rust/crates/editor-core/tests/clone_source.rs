//! 克隆源面板的会话边界：五槽预设只属于会话，不进入工程内容、历史或内容指纹（I011）。

use photocraft_embed_editor::Editor;
use serde_json::json;

fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let doc = photocraft_doc::Document::with_background(
        "sample",
        photocraft_doc::Size { width, height },
        photocraft_doc::ColorMode::Rgb,
        photocraft_doc::SampleType::U8,
        photocraft_doc::Color::rgb(0.2, 0.4, 0.6),
    );
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default())
        .expect("export sample png")
        .bytes
}

#[test]
fn clone_source_slots_are_session_only_and_never_move_the_content_hash() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(24, 16)).expect("open image");
    let before_hash = editor.content_hash().expect("content hash");
    let before = editor.state();
    let before_history = before.pointer("/document/history").and_then(|value| value.as_array()).map(Vec::len).unwrap_or(0);

    // 五个槽位可依次选中并写入来源、变换与叠层。
    let list = editor.execute("cloneSource.list", json!({})).expect("list clone sources");
    assert_eq!(list["sources"].as_array().unwrap().len(), 5);
    editor.execute("cloneSource.select", json!({"index": 2})).expect("select");
    let slot = editor.execute("cloneSource.set", json!({"index": 2, "source": [4, 6]})).expect("set source");
    assert_eq!(slot["index"], 2);
    assert_eq!(slot["source"], json!([4.0, 6.0]));
    // 默认不链接：只给 width 时 height 保持 100%。
    let scaled = editor.execute("cloneSource.set", json!({"index": 2, "width": 150})).expect("scale");
    assert_eq!(scaled["width"], 150.0);
    assert_eq!(scaled["height"], 100.0);
    // 链接宽高：给出 width 时 height 按同比例跟随。
    let linked = editor.execute("cloneSource.set", json!({"index": 2, "linked": true, "width": 200})).expect("linked scale");
    assert_eq!(linked["height"], 200.0 / 1.5);
    let reset = editor.execute("cloneSource.resetTransform", json!({"index": 2})).expect("reset");
    assert_eq!(reset["width"], 100.0);
    assert_eq!(reset["rotation"], 0.0);
    let overlay = editor.execute("cloneSource.overlay", json!({"show": true, "opacity": 40, "blend": "darken"})).expect("overlay");
    assert_eq!(overlay["blend"], "darken");

    // 预设改动不影响内容身份、历史或文档修订。
    assert_eq!(editor.content_hash().expect("content hash"), before_hash);
    let after = editor.state();
    assert_eq!(after.pointer("/document/revision"), before.pointer("/document/revision"));
    assert_eq!(after.pointer("/document/history").and_then(|value| value.as_array()).map(Vec::len), Some(before_history));
    // 克隆源不是工程内容：保存并重开后内容身份仍与预设变更前一致。
    let saved = editor.save_project().expect("save");
    let mut reopened = Editor::new();
    reopened.open_project(&saved, None).expect("reopen");
    assert_eq!(reopened.content_hash().expect("reopened hash"), before_hash);
    // 重开的会话不保留上一个会话的克隆源槽位。
    let list = reopened.execute("cloneSource.list", json!({})).expect("list after reopen");
    assert_eq!(list["sources"][0]["source"], serde_json::Value::Null);
}

#[test]
fn clone_stroke_needs_a_source_and_refuses_bad_geometry_before_writing() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(32, 32)).expect("open image");
    let hash = editor.content_hash().expect("content hash");

    // 没有来源点时内核明确拒绝，而不是画一笔无来源的内容。
    let error = editor
        .execute("paint.cloneStamp", json!({"points": [[4, 4]], "size": 6, "hardness": 50}))
        .expect_err("no clone source");
    assert!(error.to_string().contains("source"), "错误信息应指出缺少来源：{error}");
    assert_eq!(editor.content_hash().expect("content hash"), hash);

    // 非法参数在写路由前拒绝。
    let error = editor
        .execute("paint.healingBrush", json!({"points": [[4, 4]], "size": 9000}))
        .expect_err("size out of range");
    assert_eq!(error.code(), "command-failed");

    // 设置来源后整笔提交，一步历史。
    editor.execute("cloneSource.set", json!({"index": 0, "source": [8, 8]})).expect("set source");
    let before = editor.state();
    let before_history = before.pointer("/document/history").and_then(|value| value.as_array()).map(Vec::len).unwrap_or(0);
    editor
        .execute("paint.cloneStamp", json!({"points": [[2, 2], [3, 3], [4, 4]], "size": 6, "hardness": 50, "aligned": true, "sampleLayer": "current"}))
        .expect("clone stroke");
    let after = editor.state();
    let after_history = after.pointer("/document/history").and_then(|value| value.as_array()).map(Vec::len).unwrap_or(0);
    assert_eq!(after_history, before_history + 1);

    // Healing Brush 走同一来源与整笔路径。
    editor
        .execute("paint.healingBrush", json!({"points": [[6, 6]], "size": 6, "hardness": 50, "aligned": false, "sampleLayer": "all"}))
        .expect("healing stroke");
}

#[test]
fn clone_source_commands_stay_available_without_an_open_document() {
    let mut editor = Editor::new();
    // 预设面板可在没有文档时读取与设置；绘制命令仍要求文档。
    let list = editor.execute("cloneSource.list", json!({})).expect("list without document");
    assert_eq!(list["sources"].as_array().unwrap().len(), 5);
    editor.execute("cloneSource.overlay", json!({"opacity": 30})).expect("overlay without document");
    let error = editor
        .execute("paint.cloneStamp", json!({"points": [[1, 1]], "source": [2, 2]}))
        .expect_err("stroke needs a document");
    // 引擎把「没有文档」报为命令前置条件失败；代码稳定即可，不伪造成 no-document。
    assert_eq!(error.code(), "command-failed");
    assert!(error.to_string().contains("document") || error.to_string().contains("文档"));
}
