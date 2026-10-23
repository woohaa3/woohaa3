use super::*;

fn open_editor() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
    editor
}

#[test]
fn brush_library_ships_programmatic_defaults_and_stays_out_of_document_content() {
    let editor = open_editor();
    let list = editor.brush_presets(true);
    let presets = list["presets"].as_array().unwrap();
    assert!(presets.len() >= 5);
    assert!(presets.iter().all(|preset| preset["origin"] == "builtin"));
    assert!(presets.iter().any(|preset| preset["sampled"] == true));
    // 库是工具状态：只读列举不改变文档修订与内容指纹。
    let state = editor.state();
    let hash = editor.content_hash().unwrap();
    let revision = editor.revision().unwrap();
    let _ = editor.brush_presets(false);
    assert_eq!(editor.state(), state);
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.revision().unwrap(), revision);
}

#[test]
fn brush_preset_writes_never_dirty_the_document_and_gate_on_drafts() {
    let mut editor = open_editor();
    let hash = editor.content_hash().unwrap();
    let revision = editor.revision().unwrap();
    let saved = editor
        .save_brush_preset(json!({"name":"我的笔","group":"自定义","brush":{"size":40,"hardness":0.3}}))
        .unwrap();
    assert_eq!(saved["name"], "我的笔");
    assert_eq!(editor.brush_preset("我的笔").unwrap()["group"], "自定义");
    editor.rename_brush_preset("我的笔", "改名后").unwrap();
    editor.move_brush_preset(json!({"name":"改名后","group":"另一组"})).unwrap();
    editor.delete_brush_preset("改名后").unwrap();
    assert!(editor.brush_preset("改名后").is_err());
    assert_eq!(editor.content_hash().unwrap(), hash);
    assert_eq!(editor.revision().unwrap(), revision);

    // 文字草稿期间改库被拒绝，草稿仍可提交。
    editor.execute("type.create", json!({"x":4,"y":4,"text":"草稿"})).unwrap();
    let layer = editor.active_layer_id().unwrap();
    editor.begin_text(json!({"layer":layer.0})).unwrap();
    assert!(editor.save_brush_preset(json!({"name":"被拒绝"})).is_err());
    editor.cancel_text();
}

#[test]
fn brush_preview_is_the_real_kernel_and_rejects_unknown_presets() {
    let editor = open_editor();
    let preview = editor.brush_preview(json!({"name":"Soft Round","side":64})).unwrap();
    assert_eq!((preview.width, preview.height), (64, 64));
    assert_eq!(preview.pixels.len(), 64 * 64 * 4);
    assert!(preview.pixels.chunks_exact(4).any(|pixel| pixel[3] > 0));
    // 「笔刷设置」面板用未保存的补丁预览，不写库也不写文档。
    let patched = editor
        .brush_preview(json!({"brush":{"size":12,"hardness":1.0},"side":32}))
        .unwrap();
    assert_eq!(patched.pixels.len(), 32 * 32 * 4);
    assert!(editor.brush_preview(json!({"name":"不存在"})).is_err());
}

#[test]
fn brush_library_snapshot_restores_and_rejects_corruption_without_touching_the_library() {
    let mut editor = open_editor();
    editor
        .save_brush_preset(json!({"name":"快照笔","group":"组","brush":{"size":18}}))
        .unwrap();
    let bytes = editor.brush_library_snapshot().unwrap();
    let before = editor.brush_presets(true);
    editor.delete_brush_preset("快照笔").unwrap();
    assert!(editor.brush_preset("快照笔").is_err());
    editor.restore_brush_library(&bytes).unwrap();
    assert_eq!(editor.brush_presets(true), before);
    // 坏字节不覆盖有效库。
    for prefix in [0usize, 9, 24, bytes.len() - 1] {
        assert!(editor.restore_brush_library(&bytes[..prefix]).is_err());
        assert_eq!(editor.brush_presets(true), before);
    }
}

#[test]
fn abr_inspection_is_non_destructive_and_commit_requires_the_report_choice() {
    let mut editor = open_editor();
    let before = editor.brush_presets(true);
    // 非 ABR 数据在预检阶段整批拒绝。
    assert!(editor.inspect_brush_abr(b"garbage", "导入").is_err());
    assert_eq!(editor.brush_presets(true), before);
    assert!(editor.commit_brush_abr(json!({"onlySupported":true})).is_err());
    assert_eq!(editor.cancel_brush_abr()["cancelled"], true);
}

#[test]
fn capability_handshake_matches_the_shared_contract_shape() {
    let editor = Editor::new();
    let handshake = editor.capability_handshake();
    let stages = handshake["stages"].as_array().unwrap();
    assert_eq!(stages.len(), crate::capability::DELIVERED_STAGES.len());
    let capabilities = handshake["capabilities"].as_array().unwrap();
    assert_eq!(capabilities.len(), crate::capability::delivered_capabilities().len());
    assert!(handshake["nonGoals"].as_array().unwrap().contains(&json!("format.psb")));
}

#[test]
fn image_tip_import_publishes_a_sampled_preset_without_document_writes() {
    let mut editor = open_editor();
    let hash = editor.content_hash().unwrap();
    // 生成 32×32 的不透明黑圆点 PNG（暗像素作画）。
    let mut document = photocraft_doc::Document::with_background(
        "tip",
        photocraft_doc::Size::new(32, 32),
        photocraft_doc::ColorMode::Rgb,
        photocraft_doc::SampleType::U8,
        photocraft_doc::Color::WHITE,
    );
    let surface = document.layers[0].surface_mut().unwrap();
    for y in 8..24 {
        for x in 8..24 {
            surface.write_pixel(x, y, &[0.0, 0.0, 0.0, 1.0]);
        }
    }
    let bytes = photocraft_io::export(&document, "png", &photocraft_io::ExportOptions::default())
        .unwrap()
        .bytes;
    let value = editor
        .import_brush_from_image("图片笔尖", &bytes, json!({"group":"采样"}))
        .unwrap();
    assert!(value["name"].as_str().unwrap().starts_with("图片笔尖"));
    assert!(editor.brush_preset("图片笔尖").is_ok());
    assert!(editor.brush_preview(json!({"name":"图片笔尖","side":48})).is_ok());
    assert_eq!(editor.content_hash().unwrap(), hash);
}
