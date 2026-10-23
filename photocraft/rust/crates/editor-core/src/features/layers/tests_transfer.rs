use super::*;

/// 一个 32×24 的文档，带背景层与一个可复制的像素层。
fn seeded_editor() -> (Editor, u64) {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":32,"height":24})).unwrap();
    editor.execute("layer.new.layer", json!({"name":"素材"})).unwrap();
    let layer = editor.active_layer_id().unwrap().0;
    // 用填充命令制造非空像素，避免依赖绘画或合成器。
    editor.execute("edit.fillForeground", json!({"color":"#3366cc"})).unwrap();
    (editor, layer)
}

#[test]
fn transfer_round_trip_between_editors_keeps_content_and_one_history_step() {
    let (source, layer) = seeded_editor();
    let bytes = source
        .export_layer_transfer(json!({"layers":[layer]}))
        .unwrap();
    // 源文档关闭后载荷仍可解码与预检（自包含）。
    drop(source);

    let mut target = Editor::new();
    target.execute("file.new", json!({"width":48,"height":40})).unwrap();
    let before = target.state();
    let preview = target.inspect_layer_transfer(&bytes).unwrap();
    assert_eq!(preview["layers"], 1);
    assert_eq!(preview["sourceWidth"], 32);
    assert!(preview["digest"].as_str().unwrap().len() == 64);
    assert_eq!(target.state(), before, "预检不得修改状态");
    assert_eq!(target.can_paste_layer_transfer(&bytes).unwrap()["ok"], true);
    assert_eq!(target.state(), before);

    let result = target.paste_layer_transfer(&bytes, json!({"placement":"center"})).unwrap();
    assert_eq!(result["count"], 1);
    let pasted = target.state();
    assert_ne!(pasted["document"]["layers"].as_array().unwrap().len(), before["document"]["layers"].as_array().unwrap().len());
    target.execute("edit.undo", Value::Null).unwrap();
    // 撤销后：图层结构与内容指纹回到粘贴前（撤销自身会留下 redo 分支，不属于内容）。
    assert_eq!(
        target.state()["document"]["layers"].as_array().unwrap().len(),
        before["document"]["layers"].as_array().unwrap().len()
    );
    assert_eq!(
        target.state()["document"]["layers"].as_array().unwrap()[0]["name"],
        before["document"]["layers"].as_array().unwrap()[0]["name"]
    );
}

#[test]
fn corrupt_or_oversized_transfer_payloads_do_not_change_the_target() {
    let (source, layer) = seeded_editor();
    let bytes = source.export_layer_transfer(json!({"layers":[layer]})).unwrap();
    let mut target = Editor::new();
    target.execute("file.new", json!({"width":16,"height":16})).unwrap();
    let before = target.state();
    for prefix in [0usize, 3, 9, 30, bytes.len() - 1] {
        assert!(target.paste_layer_transfer(&bytes[..prefix], json!({})).is_err());
        assert!(target.inspect_layer_transfer(&bytes[..prefix]).is_err());
        assert_eq!(target.state(), before);
    }
    let mut tampered = bytes.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    assert!(target.paste_layer_transfer(&tampered, json!({})).is_err());
    assert_eq!(target.state(), before);
    // 非法布局参数在解码后被拒绝，仍不落任何改动。
    assert!(target
        .paste_layer_transfer(&bytes, json!({"placement":"nowhere"}))
        .is_err());
    assert!(target
        .paste_layer_transfer(&bytes, json!({"placement":"center","center":[1]}))
        .is_err());
    assert_eq!(target.state(), before);
}

#[test]
fn export_requires_a_selection_and_rejects_unknown_layer_ids() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":16,"height":16})).unwrap();
    // 默认活动层是背景；显式给出不存在的 id 必须拒绝。
    assert!(editor.export_layer_transfer(json!({"layers":[u64::MAX]})).is_err());
    // 无选择且文档只有背景时，复制背景是合法操作。
    let layer = editor.active_layer_id().unwrap().0;
    assert!(editor.export_layer_transfer(json!({"layers":[layer]})).is_ok());
}

#[test]
fn place_asset_validates_real_decoding_and_writes_one_layer() {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width":64,"height":64})).unwrap();
    let mut document = photocraft_doc::Document::with_background(
        "asset",
        photocraft_doc::Size::new(20, 16),
        photocraft_doc::ColorMode::Rgb,
        photocraft_doc::SampleType::U8,
        photocraft_doc::Color::rgb(0.4, 0.2, 0.8),
    );
    let _ = &mut document;
    let bytes = photocraft_io::export(&document, "png", &photocraft_io::ExportOptions::default())
        .unwrap()
        .bytes;
    let preview = editor.inspect_place_asset(&bytes).unwrap();
    assert_eq!(preview["width"], 20);
    assert_eq!(preview["height"], 16);
    assert_eq!(preview["format"], "Png");
    let before = editor.state();
    let result = editor
        .place_asset(json!({"name":"素材.png","assetId":"placed-1"}), &bytes)
        .unwrap();
    assert_eq!(result["mode"], "pixel");
    assert_eq!(result["width"], 20);
    assert!(result["placedLayer"].as_u64().is_some());
    assert_ne!(editor.state(), before);
    // 坏字节不新增图层。
    let count = editor.state()["document"]["layers"].as_array().unwrap().len();
    assert!(editor.place_asset(json!({"name":"坏.png"}), b"not an image").is_err());
    assert_eq!(editor.state()["document"]["layers"].as_array().unwrap().len(), count);
    // 嵌入智能对象模式已开放（P4）。
    let smart = editor
        .place_asset(json!({"name":"智能.png","mode":"smartObject"}), &bytes)
        .unwrap();
    assert_eq!(smart["mode"], "smartObject");
}
