//! 会话级回归：本域入口不改文档、不产生历史、拒绝半成品，且预览与交付同源。

use serde_json::{json, Value};

use crate::editor::Editor;

/// 新建 32×24 文档，再加一个按资产语法命名的像素层并填充。
fn seeded() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 32, "height": 24})).unwrap();
    editor.execute("layer.new.layer", json!({"name": "图标.png"})).unwrap();
    editor.execute("edit.fillForeground", json!({"color": "#3366cc"})).unwrap();
    editor
}

fn snapshot(editor: &Editor) -> (Value, String) {
    (editor.state(), editor.content_hash().unwrap())
}

#[test]
fn open_raster_accepts_a_real_png_and_keeps_the_matrix_honest() {
    let mut source = Editor::new();
    source.execute("file.new", json!({"width": 12, "height": 9})).unwrap();
    source.execute("edit.fillForeground", json!({"color": "#22aa66"})).unwrap();
    let png = source.export_bundle().unwrap().output;
    assert!(!png.is_empty());

    let mut target = Editor::new();
    // 预检在前：真实动过解码，仍未创建文档。
    let inspection = target.inspect_raster(&png).unwrap();
    assert_eq!(inspection["format"], "png");
    assert_eq!(inspection["width"], 12);
    assert_eq!(inspection["height"], 9);
    assert_eq!(inspection["documentChanged"], false);
    assert!(!target.has_document(), "预检不得创建文档");

    let opened = target.open_raster("图.png", &png).unwrap();
    assert!(target.has_document());
    assert_eq!(opened["raster"]["format"], "png");
    assert_eq!(opened["raster"]["readOnly"], false);
    assert_eq!(opened["raster"]["documentChanged"], true);

    // 伪扩展名以签名判定：同一份 PNG 换个名字也照样按 PNG 打开。
    let mut pseudo = Editor::new();
    pseudo.open_raster("伪装.tif", &png).unwrap();
    // 非栅格签名与空字节一律拒绝，且不替换当前文档。
    let before = pseudo.state();
    assert!(pseudo.open_raster("x.png", b"not an image").is_err());
    assert_eq!(pseudo.state(), before);
    assert!(pseudo.inspect_raster(b"").is_err());
}

/// 构造一份真实可解码、但样本是 U16 的 PNG（用上游编码器，不写假字节）。
fn sixteen_bit_png() -> Vec<u8> {
    let pixels: Vec<u16> = (0..4u16 * 3).map(|index| index * 1000).collect();
    let image = photocraft_codecs::Image::from_u16(2, 2, photocraft_codecs::ChannelLayout::Rgb, &pixels).unwrap();
    assert_eq!(image.sample_type(), photocraft_codecs::SampleType::U16);
    photocraft_codecs::encode(&image, photocraft_codecs::Format::Png, &photocraft_codecs::EncodeOptions::default()).unwrap()
}

#[test]
fn opening_refuses_to_downconvert_what_the_preflight_refuses() {
    // 预检与打开必须是同一套准入：只按签名过预检、真解码却降位深，等于绕过 D2「不自动降位深」。
    let png16 = sixteen_bit_png();
    let mut editor = Editor::new();
    let inspected = editor.inspect_raster(&png16);
    assert!(inspected.is_err(), "16 位 PNG 预检必须拒绝");
    assert!(format!("{}", inspected.unwrap_err()).contains("u16"));

    let opened = editor.open_raster("deep.png", &png16);
    assert!(opened.is_err(), "预检拒绝的字节不能被 open_raster 接受");
    let message = format!("{}", opened.unwrap_err());
    assert!(message.contains("u16"), "拒绝原因要写清真实位深：{message}");
    assert!(!editor.has_document(), "拒绝时不得留下文档");
}

#[test]
fn truncated_and_oversized_inputs_are_rejected_before_replacing_the_document() {
    let mut source = Editor::new();
    source.execute("file.new", json!({"width": 64, "height": 48})).unwrap();
    source.execute("edit.fillForeground", json!({"color": "#3366cc"})).unwrap();
    let png = source.export_bundle().unwrap().output;

    let mut target = seeded();
    let before = target.state();

    // 数据截断：签名正确但像素流不完整。
    let truncated = &png[..png.len() * 3 / 5];
    assert!(target.inspect_raster(truncated).is_err(), "截断数据预检必须拒绝");
    assert!(target.open_raster("截断.png", truncated).is_err(), "截断数据不能打开");
    assert_eq!(target.state(), before, "拒绝时当前文档必须原样保留");

    // 解压/尺寸超限：声称 100000×100000 的真实容器头。
    let mut huge = png.clone();
    huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&100_000u32.to_be_bytes());
    assert!(target.inspect_raster(&huge).is_err(), "超预算尺寸预检必须拒绝");
    assert!(target.open_raster("超大.png", &huge).is_err(), "超预算尺寸不能打开");
    assert_eq!(target.state(), before, "拒绝时当前文档必须原样保留");
}

#[test]
fn export_and_preview_share_one_snapshot_and_never_touch_the_document() {
    let editor = seeded();
    let (before, hash) = snapshot(&editor);

    // 预览与交付必须给出同一字节。
    for params in [
        json!({"format": "jpg", "quality": 70}),
        json!({"format": "webp", "webpQuality": 40, "webpLossless": false}),
        json!({"format": "tif"}),
        json!({"mode": "web", "format": "gif", "colors": 8}),
    ] {
        let (preview, preview_report) = editor.preview_export(params.clone()).unwrap();
        let (delivery, delivery_report) = editor.export_raster(params.clone()).unwrap();
        assert_eq!(preview, delivery, "{params}");
        assert!(!preview.is_empty());
        assert_eq!(preview_report["preview"], true);
        assert_eq!(delivery_report["preview"], false);
        assert_eq!(preview_report["documentContentHash"], hash.as_str());
        assert_eq!(preview_report["documentChanged"], false);
        // 真实编码结果自带可解码的签名。
        assert!(photocraft_codecs::detect(&preview).is_some(), "{params}");
    }
    // 文档、内容指纹、修订都没有变。
    let (after, hash_after) = snapshot(&editor);
    assert_eq!(before, after);
    assert_eq!(hash, hash_after);
}

#[test]
fn inspect_export_reports_the_real_target_size_without_encoding() {
    let editor = seeded();
    let info = editor.inspect_export(json!({"format": "png", "percent": 50})).unwrap();
    assert_eq!(info["width"], 16);
    assert_eq!(info["height"], 12);
    assert_eq!(info["sourceWidth"], 32);
    assert_eq!(info["sourceHeight"], 24);
    assert_eq!(info["documentChanged"], false);
    // 非法设置与超预算目标在预检阶段就失败（不会拿旧预览去提交）。
    assert!(editor.inspect_export(json!({"format": "jpg", "transparency": true})).is_err());
    assert!(editor.inspect_export(json!({"format": "pcx"})).is_err());
    assert!(editor.inspect_export(json!({"format": "png", "width": 100_000})).is_err());
}

#[test]
fn layer_bundle_delivers_each_selected_layer_with_a_report() {
    let mut editor = seeded();
    editor.execute("layer.new.layer", json!({"name": "背景色"} )).unwrap();
    editor.execute("edit.fillForeground", json!({"color": "#ff8844"})).unwrap();

    // 显式给出两层：缺省只导出当前选择（这里是刚填充的活动层）。
    let all: Vec<u64> = editor.state()["document"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|layer| layer["id"].as_u64())
        .collect();
    assert!(all.len() >= 2);
    let plan = editor.inspect_layer_export(json!({"format": "png", "layers": all})).unwrap();
    assert_eq!(plan["kind"], "layers");
    assert!(plan["ok"].as_bool().unwrap());
    let files = plan["layers"].as_array().unwrap();
    assert!(files.len() >= 2, "至少应包含两个像素层");

    let (bytes, report) = editor.export_layer_bundle(json!({"format": "png", "layers": all})).unwrap();
    assert_eq!(report["kind"], "layers");
    assert!(report["okCount"].as_u64().unwrap() >= 2);
    assert_eq!(report["documentChanged"], false);

    let inspected = editor.inspect_io_bundle(&bytes).unwrap();
    assert_eq!(inspected["report"]["kind"], "layers");
    let names: Vec<&str> = inspected["files"].as_array().unwrap().iter().map(|file| file["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"report.json"));
    // 只读/暂缓格式在计划阶段就拒绝。
    assert!(editor.inspect_layer_export(json!({"format": "exr"})).is_err());
}

#[test]
fn single_layer_export_defaults_to_png_and_uses_isolated_pixels() {
    let editor = seeded();
    let state = editor.state();
    let active = state["document"]["activeLayer"].as_u64().unwrap();

    let (bytes, report) = editor.export_layer_as(json!({})).unwrap();
    assert_eq!(report["format"], "png");
    assert_eq!(report["kind"], "layer-export");
    assert_eq!(report["layerId"], active);
    assert_eq!(report["layerName"], "图标.png");
    assert_eq!(report["documentChanged"], false);
    let format = photocraft_codecs::detect(&bytes).expect("单层导出必须是真实 PNG");
    let image = photocraft_codecs::decode_as_with(format, &bytes, &photocraft_codecs::DecodeOptions::default()).unwrap();
    // 隔离图层是 32×24 的填充层，交付尺寸与图层像素边界一致（不是整包画布裁剪错误）。
    assert_eq!((image.width(), image.height()), (32, 24));

    // 明确选择格式与缩放。
    let (jpeg, report) = editor.export_layer_as(json!({"format": "jpg", "percent": 50})).unwrap();
    assert_eq!(report["format"], "jpg");
    let jpeg_image = photocraft_codecs::decode_as_with(
        photocraft_codecs::Format::Jpeg,
        &jpeg,
        &photocraft_codecs::DecodeOptions::default(),
    )
    .unwrap();
    assert_eq!((jpeg_image.width(), jpeg_image.height()), (16, 12));

    // 失效图层 id 与未知格式都拒绝。
    assert!(editor.export_layer_as(json!({"layer": 999_999})).is_err());
    assert!(editor.export_layer_as(json!({"format": "nope"})).is_err());
}

#[test]
fn image_assets_are_planned_and_delivered_only_from_asset_names() {
    let editor = seeded();
    let plan = editor.inspect_image_assets().unwrap();
    assert_eq!(plan["kind"], "assets");
    assert!(plan["ok"].as_bool().unwrap());
    assert_eq!(plan["assets"].as_array().unwrap().len(), 1);

    let (bytes, report) = editor.export_image_assets().unwrap();
    assert_eq!(report["kind"], "assets");
    assert_eq!(report["okCount"], 1);
    assert_eq!(report["documentChanged"], false);
    let inspected = editor.inspect_io_bundle(&bytes).unwrap();
    let names: Vec<&str> = inspected["files"].as_array().unwrap().iter().map(|file| file["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"图标.png"), "{names:?}");
    assert!(names.contains(&"report.json"));

    // 没有资产语法命名的文档明确拒绝，而不是交付空包。
    let mut plain = Editor::new();
    plain.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    assert!(plain.inspect_image_assets().is_err());
    assert!(plain.export_image_assets().is_err());
}

#[test]
fn no_document_and_drafts_are_rejected_with_stable_codes() {
    let mut empty = Editor::new();
    let error = empty.export_raster(json!({"format": "png"})).unwrap_err();
    assert_eq!(error.code(), "no-document");
    assert!(empty.inspect_layer_export(json!({})).is_err());
    assert!(empty.inspect_image_assets().is_err());

    // 有活动笔迹时不得导出半成品。
    let mut editor = seeded();
    editor.begin_stroke(json!({"points": [[4.0, 4.0, 1.0]]})).unwrap();
    for result in [
        editor.export_raster(json!({"format": "png"})).map(|_| ()),
        editor.export_layer_bundle(json!({"format": "png"})).map(|_| ()),
        editor.inspect_export(json!({"format": "png"})).map(|_| ()),
    ] {
        let error = result.unwrap_err();
        assert!(error.message().contains("笔迹"), "{}", error.message());
    }
    // 结束笔迹后同一入口恢复可用（不是永久禁用）。
    editor.commit_stroke().unwrap();
    assert!(editor.export_raster(json!({"format": "png"})).is_ok());
}
