//! 编辑内核的原生回归：不依赖浏览器、WASM 或 GPU。
//!
//! 这些用例锁定 React 前端依赖的行为：打开图片/工程、命令分派、撤销、合成预览像素、
//! 内容指纹在保存重开后保持一致。

use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
use photocraft_embed_editor::{Editor, EditorError};

/// 生成一张含背景层的示例 PNG。
fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let doc = Document::with_background(
        "sample",
        Size { width, height },
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default())
        .expect("export sample png")
        .bytes
}

#[test]
fn opening_an_image_builds_a_document_the_ui_can_read() {
    let mut editor = Editor::new();
    assert!(!editor.has_document());

    let state = editor.open_image("photo.png", Some("asset-1"), &sample_png(32, 24)).expect("open image");

    assert!(editor.has_document());
    let document = state.get("document").expect("document");
    assert_eq!(document.get("width").and_then(|v| v.as_u64()), Some(32));
    assert_eq!(document.get("height").and_then(|v| v.as_u64()), Some(24));
    let layers = document.get("layers").and_then(|v| v.as_array()).expect("layers");
    assert_eq!(layers.len(), 1, "背景层");
}

#[test]
fn commands_are_dispatched_through_the_single_engine_entry_point() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(16, 16)).expect("open image");

    let commands = editor.commands();
    let list = commands.as_array().expect("command list");
    let select_all = list
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some("select.all"))
        .expect("select.all in registry");
    assert_eq!(select_all.get("allowed").and_then(|v| v.as_bool()), Some(true));
    let subject = list
        .iter()
        .find(|c| c.get("id").and_then(|v| v.as_str()) == Some("select.subject"))
        .expect("select.subject in registry");
    assert_eq!(subject.get("allowed").and_then(|v| v.as_bool()), Some(false));

    editor.execute("select.all", serde_json::Value::Null).expect("select all");
    let selected = editor.state();
    assert_eq!(selected.pointer("/document/hasSelection"), Some(&serde_json::json!(true)));

    editor.undo().expect("undo");
    assert_eq!(editor.state().pointer("/document/hasSelection"), Some(&serde_json::json!(false)));
}

#[test]
fn commands_outside_the_first_phase_list_are_refused_at_the_dispatch_layer() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(16, 16)).expect("open image");

    let error = editor.execute("select.subject", serde_json::json!({})).expect_err("AI selection is closed");
    assert_eq!(error.code(), "capability-disabled");
    let error = editor.execute("edit.preferences.general", serde_json::Value::Null).expect_err("preferences are closed");
    assert_eq!(error.code(), "capability-disabled");

    let allowed = editor.allowed_command_ids();
    let ids = allowed.as_array().expect("ids");
    assert!(!ids.is_empty());
    assert!(ids.iter().all(|id| id.as_str() != Some("plugin.run")));
}

#[test]
fn unknown_or_disabled_commands_surface_a_stable_error_code() {
    let mut editor = Editor::new();
    let error = editor.execute("does.not.exist", serde_json::Value::Null).expect_err("unknown command");
    assert_eq!(error.code(), "capability-disabled");

    // 白名单内的命令仍由 engine 判定：没有文档时 `layer.delete` 失败。
    let error = editor.execute("layer.delete", serde_json::Value::Null).expect_err("no document");
    assert_eq!(error.code(), "command-failed");

    let error = Editor::new().render_preview(64).expect_err("no document");
    assert_eq!(error.code(), "no-document");
}

#[test]
fn preview_pixels_match_the_reported_size() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(40, 20)).expect("open image");

    let preview = editor.render_preview(64).expect("preview");
    assert_eq!(preview.width, 40);
    assert_eq!(preview.height, 20);
    assert_eq!(preview.pixels.len(), (preview.width * preview.height * 4) as usize);
}

#[test]
fn project_bytes_round_trip_and_keep_the_content_hash() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", Some("asset-1"), &sample_png(48, 32)).expect("open image");
    let before = editor.content_hash().expect("content hash");

    let bytes = editor.save_project().expect("save project");
    assert!(photocraft_format::is_pcraft(&bytes));

    let mut reopened = Editor::new();
    let state = reopened.open_project(&bytes, Some("asset-1")).expect("open project");
    assert_eq!(state.pointer("/document/width").and_then(|v| v.as_u64()), Some(48));
    assert_eq!(reopened.content_hash().expect("content hash"), before);
}

#[test]
fn export_bundle_pairs_one_revision_of_project_and_png() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", Some("asset-1"), &sample_png(48, 32)).expect("open image");
    let revision = editor.revision().expect("revision");

    let bundle = editor.export_bundle().expect("export bundle");
    assert_eq!(bundle.revision, revision);
    assert_eq!(bundle.canvas_width, 48);
    assert_eq!(bundle.canvas_height, 32);
    assert!(photocraft_format::is_pcraft(&bundle.project));
    // PNG 魔数。
    assert_eq!(&bundle.output[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    assert_eq!(bundle.document_content_hash, editor.content_hash().expect("hash"));

    // 写操作推进修订；再次冻结取到新修订。
    editor.execute("select.all", serde_json::Value::Null).expect("select all");
    let after = editor.export_bundle().expect("second bundle");
    assert!(after.revision > bundle.revision);
}

/// 生成一张**半透明**示例 PNG（alpha 直通），用于验证透明在合成/保存/重开后不丢失。
fn translucent_png(width: u32, height: u32, alpha: f32) -> Vec<u8> {
    let doc = Document::with_background(
        "translucent",
        Size { width, height },
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgba(1.0, 0.0, 0.0, alpha),
    );
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default())
        .expect("export translucent png")
        .bytes
}

#[test]
fn placed_layers_and_transparency_survive_a_project_round_trip() {
    let mut editor = Editor::new();
    editor
        .open_image("base.png", Some("asset-base"), &translucent_png(64, 48, 0.5))
        .expect("open translucent base");

    // 预览是直通 RGBA8：半透明来源的合成 alpha 必须小于 255。
    let before = editor.render_preview(64).expect("preview");
    assert_eq!(before.width, 64);
    assert_eq!(before.height, 48);
    assert_eq!(before.pixels.len(), (64 * 48 * 4) as usize);
    assert!(
        before.pixels.chunks_exact(4).all(|px| px[3] < 255),
        "半透明来源的合成 alpha 必须保留"
    );

    // 置入第二张图 → 背景层 + 置入层，且置入层登记了稳定资产 id（保存时写进描述符）。
    let placed = editor
        .place_image("overlay.png", Some("asset-overlay"), &sample_png(16, 16), &serde_json::json!({}))
        .expect("place overlay");
    let layers = placed.pointer("/document/layers").and_then(|v| v.as_array()).expect("layers");
    assert_eq!(layers.len(), 2, "置入后应有背景层 + 置入层");
    let ids = editor.asset_ids();
    assert_eq!(ids.pointer("/baseAssetId"), Some(&serde_json::json!("asset-base")));
    let placed_ids = ids.get("placed").and_then(|v| v.as_array()).expect("placed asset ids");
    assert_eq!(placed_ids.len(), 1);
    assert_eq!(placed_ids[0].get("assetId"), Some(&serde_json::json!("asset-overlay")));

    // 保存前的合成结果（含不透明置入层与半透明基底）。
    let composed = editor.render_preview(64).expect("composed preview");
    assert!(
        composed.pixels.chunks_exact(4).any(|px| px[3] < 255),
        "合成结果必须保留基底的透明区域"
    );

    // 保存 → 重开：图层结构与内容指纹不变，合成像素逐字节一致（透明与像素都无损）。
    let hash = editor.content_hash().expect("content hash");
    let bytes = editor.save_project().expect("save project");

    let mut reopened = Editor::new();
    let state = reopened.open_project(&bytes, Some("asset-base")).expect("reopen project");
    assert_eq!(
        state.pointer("/document/layers").and_then(|v| v.as_array()).map(Vec::len),
        Some(2),
        "重开后两个图层都必须还在"
    );
    assert_eq!(reopened.content_hash().expect("content hash"), hash);
    let after = reopened.render_preview(64).expect("preview after reopen");
    assert_eq!((after.width, after.height), (composed.width, composed.height));
    assert_eq!(after.pixels, composed.pixels, "重开后的合成像素必须与保存前逐字节一致");
}

#[test]
fn selection_commands_round_trip_through_the_view_model_shape() {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(64, 48)).expect("open image");

    // 矩形选区 → 羽化 → 反选，UI 用的就是这些参数形状。
    editor
        .execute(
            "select.rect",
            serde_json::json!({"x": 8, "y": 8, "width": 24, "height": 16, "mode": "replace", "feather": 2}),
        )
        .expect("rect selection");
    assert_eq!(editor.state().pointer("/document/hasSelection"), Some(&serde_json::json!(true)));

    editor
        .execute("select.modify.feather", serde_json::json!({"radius": 3}))
        .expect("feather");
    editor.execute("select.inverse", serde_json::Value::Null).expect("inverse");
    assert_eq!(editor.state().pointer("/document/hasSelection"), Some(&serde_json::json!(true)));

    editor.execute("select.deselect", serde_json::Value::Null).expect("deselect");
    assert_eq!(editor.state().pointer("/document/hasSelection"), Some(&serde_json::json!(false)));
}

#[test]
fn foreign_bytes_are_rejected_as_not_a_project() {
    let mut editor = Editor::new();
    let error = editor.open_project(b"not a project at all", None).expect_err("reject foreign bytes");
    assert_eq!(error, EditorError::NotAProject);
}

/// 只检查文档与历史 JSON；不合成像素或生成预览。
#[test]
fn history_json_retains_redo_steps_and_discards_the_abandoned_branch() {
    // 空文档（没有图层）不是合法工程：核验会以「工程缺少图层」拒绝。用带背景层的文档，
    // 保持本用例只验证历史分支与 redo 栈语义。
    let doc = Document::with_background(
        "history",
        Size::new(16, 16),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    let bytes = photocraft_format::save_to_bytes(&doc, &photocraft_format::SaveOptions::default()).expect("project bytes");
    let mut editor = Editor::new();
    editor.open_project(&bytes, None).expect("open blank project");
    editor.execute("layer.new.layer", serde_json::Value::Null).expect("new layer");
    editor.execute("layer.new.layer", serde_json::Value::Null).expect("second layer");
    let complete = editor.state()["document"]["history"].as_array().unwrap().clone();
    editor.undo().expect("undo second layer");
    editor.undo().expect("undo first layer");
    assert_eq!(editor.state()["document"]["redoHistory"], serde_json::json!(&complete[complete.len() - 2..]));
    editor.redo().expect("redo first layer");
    assert_eq!(editor.state()["document"]["redoHistory"], serde_json::json!(&complete[complete.len() - 1..]));
    editor.execute("layer.new.group", serde_json::Value::Null).expect("new history branch");
    assert_eq!(editor.state()["document"]["redoHistory"], serde_json::json!([]));
    assert_eq!(editor.state()["document"]["canRedo"], serde_json::json!(false));
}

/// 只读取选区和历史，不合成图像、生成预览或导出 PNG。
#[test]
fn selection_outline_tracks_mask_operations_and_history() {
    let doc = Document::with_background(
        "selection",
        Size::new(64, 48),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    let bytes = photocraft_format::save_to_bytes(&doc, &photocraft_format::SaveOptions::default()).unwrap();
    let mut editor = Editor::new();
    editor.open_project(&bytes, None).unwrap();
    editor.execute("select.rect", serde_json::json!({"x": 8, "y": 10, "width": 24, "height": 16})).unwrap();
    let rect = serde_json::json!([[8,10,32,10], [8,26,32,26], [8,10,8,26], [32,10,32,26]]);
    assert_eq!(editor.state()["document"]["selectionOutline"], rect);
    editor.execute("select.rect", serde_json::json!({"x": 16, "y": 14, "width": 8, "height": 4, "mode": "subtract"})).unwrap();
    let hole = editor.state()["document"]["selectionOutline"].clone();
    assert_eq!(hole.as_array().unwrap().len(), 8, "应保留内部孔洞");
    editor.undo().unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], rect);
    editor.redo().unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], hole);
    editor.execute("select.deselect", serde_json::Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], serde_json::json!([]));
    editor.execute("select.reselect", serde_json::Value::Null).unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], hole);
    editor.execute("select.rect", serde_json::json!({"x": 8, "y": 10, "width": 24, "height": 16, "ellipse": true})).unwrap();
    assert!(editor.state()["document"]["selectionOutline"].as_array().unwrap().len() > 4);
}

#[test]
fn selection_outline_bounds_large_masks_without_losing_rectangle_edges() {
    let doc = Document::with_background(
        "large selection",
        Size::new(4096, 2048),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    let bytes = photocraft_format::save_to_bytes(&doc, &photocraft_format::SaveOptions::default()).unwrap();
    let mut editor = Editor::new();
    editor.open_project(&bytes, None).unwrap();
    editor.execute("select.rect", serde_json::json!({"x": 3, "y": 5, "width": 2049, "height": 513})).unwrap();
    assert_eq!(editor.state()["document"]["selectionOutline"], serde_json::json!([
        [3,5,2052,5], [3,518,2052,518], [3,5,3,518], [2052,5,2052,518]
    ]));
}

#[test]
fn unsupported_placeholder_workflows_cannot_bypass_the_ui_or_modify_the_document() {
    let mut editor = Editor::new();
    editor.open_image("placeholder.png", None, &sample_png(8, 8)).unwrap();
    let before = editor.state();
    let hash = editor.content_hash().unwrap();
    for id in [
        "view.pixelArtPreview",
        "type.fontPreviewSize.small", "type.fontPreviewSize.medium", "type.fontPreviewSize.large",
        "type.fontPreviewSize.extraLarge", "type.fontPreviewSize.huge",
        "type.languageOptions.defaultFeatures", "type.languageOptions.eastAsianFeatures",
        "type.languageOptions.middleEasternFeatures", "type.languageOptions.middleEasternAndSouthAsianComposer",
        "file.import.videoFramesToLayers", "edit.presets.migratePresets",
        "file.print", "file.printOneCopy", "file.generate.imageAssets", "file.import.wiaSupport", "file.placeEmbedded", "file.placeLinked",
        "file.scripts.loadFilesIntoStack", "file.automate.contactSheetII", "file.automate.lensCorrection", "file.scripts.imageProcessor", "file.automate.createDroplet",
    ] {
        // Even valid-looking parameters must fail before path I/O or any engine edit.
        let error = editor.execute(id, serde_json::json!({"path":"placeholder-never-read","enabled":true})).unwrap_err();
        assert_eq!(error.code(), "capability-disabled", "{id}");
        assert_eq!(editor.state(), before, "{id}");
        assert_eq!(editor.content_hash().unwrap(), hash, "{id}");
    }
}

#[test]
fn internal_clipboard_geometry_is_read_only_and_does_not_require_a_document() {
    let mut editor=Editor::new();assert_eq!(editor.clipboard_bounds(),None);
    editor.open_image("clipboard.png",None,&sample_png(8,8)).unwrap();editor.execute("edit.copy",serde_json::json!({})).unwrap();
    let state=editor.state();let hash=editor.content_hash().unwrap();let bounds=editor.clipboard_bounds().unwrap();assert!(bounds[2]>bounds[0]&&bounds[3]>bounds[1]);assert_eq!(editor.state(),state);assert_eq!(editor.content_hash().unwrap(),hash);
}
