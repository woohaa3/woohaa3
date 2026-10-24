//! 图层重排画布预览的内核边界（I218）：候选只读，正式文档/历史/指纹不变。

use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
use photocraft_embed_editor::Editor;
use serde_json::{json, Value};

fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let doc = Document::with_background("sample", Size { width, height }, ColorMode::Rgb, SampleType::U8, Color::rgb(0.2, 0.4, 0.6));
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default()).expect("export sample png").bytes
}

/// 图层顺序、历史长度与内容指纹：重排预览必须全部保持不变。
fn invariant(editor: &Editor) -> (Vec<u64>, usize, String) {
    let state: Value = editor.state();
    let ids = state
        .pointer("/document/layers")
        .and_then(Value::as_array)
        .expect("layers")
        .iter()
        .map(|layer| layer["id"].as_u64().expect("id"))
        .collect();
    let history = state.pointer("/document/history").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    (ids, history, editor.content_hash().expect("content hash"))
}

/// 返回 (编辑器, 最上面的普通图层 id, 最下面的普通图层 id)。
///
/// `document.layers` 自上而下排列，背景层固定留在最后；把最上层移到最下层之下才会真正改变顺序。
fn editor_with_layers() -> (Editor, u64, u64) {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(32, 24)).expect("open image");
    editor.execute("layer.new.layer", json!({"name":"底"})).expect("layer");
    editor.execute("layer.new.layer", json!({"name":"顶"})).expect("layer");
    let state: Value = editor.state();
    let layers = state.pointer("/document/layers").and_then(Value::as_array).expect("layers");
    let top = layers.first().expect("top")["id"].as_u64().expect("id");
    let bottom = layers[layers.len() - 2]["id"].as_u64().expect("bottom normal layer");
    (editor, top, bottom)
}

#[test]
fn preview_changes_the_candidate_only_and_never_the_document_or_history() {
    let (mut editor, top, bottom) = editor_with_layers();
    let before = invariant(&editor);
    let preview_before = editor.render_preview(32).expect("preview");

    let begun = editor.begin_reorder_preview().expect("begin");
    assert_eq!(begun["active"], false);
    let moved = editor.preview_reorder(json!({"layers":[top],"target":bottom,"position":"below"})).expect("preview");
    assert_eq!(moved["position"], "below");
    assert_eq!(moved["layers"], json!([top]));
    // 候选已经生效，但正式图层顺序、历史与指纹完全不变。
    assert_eq!(invariant(&editor), before);
    let preview_after = editor.render_preview(32).expect("preview");
    assert_eq!((preview_after.width, preview_after.height), (preview_before.width, preview_before.height));

    // 结束候选后回到正式文档；不产生历史步骤。
    assert_eq!(editor.end_reorder_preview()["active"], true);
    assert_eq!(invariant(&editor), before);
    assert_eq!(editor.render_preview(32).expect("preview"), preview_before);

    // 真正提交仍是独立的 `layer.moveTo`，只记一步历史，且可撤销回原顺序。
    editor.execute("layer.moveTo", json!({"layers":[top],"target":bottom,"position":"below"})).expect("move");
    let (order, history, hash) = invariant(&editor);
    assert_ne!(order, before.0);
    assert_eq!(history, before.1 + 1);
    assert_ne!(hash, before.2);
    editor.execute("edit.undo", Value::Null).expect("undo");
    let (order, history, _) = invariant(&editor);
    assert_eq!(order, before.0);
    assert_eq!(history, before.1);
}

#[test]
fn invalid_candidates_are_refused_and_keep_the_last_valid_preview() {
    let (mut editor, top, bottom) = editor_with_layers();
    let before = invariant(&editor);
    assert!(editor.preview_reorder(json!({"layers":[top],"target":bottom})).is_err(), "没有 begin 时拒绝");
    editor.begin_reorder_preview().expect("begin");
    assert!(editor.preview_reorder(json!({"layers":[top],"target":999999,"position":"below"})).is_err());
    assert!(editor.preview_reorder(json!({"layers":[top],"target":bottom,"position":"beside"})).is_err());
    assert!(editor.preview_reorder(json!({"layers":[top],"target":bottom,"animate":true})).is_err());
    editor.preview_reorder(json!({"layers":[top],"target":bottom,"position":"below"})).expect("valid");
    // 之后一次非法落点不得清掉上一次有效候选。
    assert!(editor.preview_reorder(json!({"layers":[top],"target":bottom,"position":"beside"})).is_err());
    assert_eq!(editor.end_reorder_preview()["active"], true);
    assert_eq!(invariant(&editor), before);
}

#[test]
fn preview_requires_an_open_document_and_an_idle_stroke() {
    let mut editor = Editor::new();
    assert!(editor.begin_reorder_preview().is_err());
    editor.open_image("photo.png", None, &sample_png(16, 16)).expect("open");
    let before = invariant(&editor);
    editor.begin_reorder_preview().expect("begin with document");
    // begin 不会被记录为一条命令或历史。
    assert_eq!(invariant(&editor), before);
    // 没有落点时结束报告「没有有效候选」。
    assert_eq!(editor.end_reorder_preview()["active"], false);
}
