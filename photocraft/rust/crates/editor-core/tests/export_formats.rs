//! 导出格式与控制的真实编码回归（I045）。
//!
//! 只验证字节层：每种格式都能从真实文档编码出可被固定解码器识别的文件，非法参数在编码前
//! 拒绝，缩放只影响导出结果而不改正式文档。不涉及 GPU 或视觉比较。

use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
use photocraft_embed_editor::export_request::ExportRequest;
use photocraft_embed_editor::Editor;
use serde_json::json;

fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let doc = Document::with_background("sample", Size { width, height }, ColorMode::Rgb, SampleType::U8, Color::rgb(0.2, 0.6, 0.9));
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default()).expect("export sample").bytes
}

fn editor() -> Editor {
    let mut editor = Editor::new();
    editor.open_image("photo.png", None, &sample_png(32, 24)).expect("open image");
    editor
}

#[test]
fn every_flat_format_encodes_real_bytes_for_the_current_revision() {
    let editor = editor();
    for format in ["png", "jpeg", "webp", "tiff", "tga", "bmp", "gif", "ico"] {
        let request = ExportRequest::parse(&json!({ "format": format })).expect("parse");
        let bundle = editor.export_image(request).expect("export");
        assert!(!bundle.output.is_empty(), "{format} 应产生字节");
        assert!(bundle.project.is_empty(), "按格式导出不应携带工程字节");
        assert_eq!((bundle.canvas_width, bundle.canvas_height), (32, 24));
        // 固定解码器能重新识别刚写出的字节。
        let reopened = photocraft_io::import(&format!("out.{}", format), &bundle.output);
        assert!(reopened.is_ok(), "{format} 写出的字节应可被解码：{:?}", reopened.err());
    }
}

#[test]
fn quality_controls_change_the_encoded_size_without_touching_the_document() {
    let editor = editor();
    let state = editor.state();
    let hash = editor.content_hash().expect("hash");
    let low = editor.export_image(ExportRequest::parse(&json!({"format":"jpeg","jpegQuality":10})).unwrap()).expect("low");
    let high = editor.export_image(ExportRequest::parse(&json!({"format":"jpeg","jpegQuality":100})).unwrap()).expect("high");
    assert!(low.output.len() < high.output.len(), "低质量应更小：{}/{}", low.output.len(), high.output.len());
    // 无损 WebP 与有损 WebP 都是合法字节。
    for params in [json!({"format":"webp","webpLossless":true}), json!({"format":"webp","webpLossless":false,"webpQuality":40})] {
        let bundle = editor.export_image(ExportRequest::parse(&params).unwrap()).expect("webp");
        assert!(photocraft_io::import("out.webp", &bundle.output).is_ok());
    }
    assert_eq!(editor.content_hash().expect("hash"), hash);
    assert_eq!(editor.state(), state, "导出不得改动正式文档");
}

#[test]
fn scaling_only_affects_the_exported_bytes() {
    let mut editor = editor();
    let hash = editor.content_hash().expect("hash");
    let state = editor.state();
    let half = editor.export_image(ExportRequest::parse(&json!({"format":"png","scale":0.5})).unwrap()).expect("half");
    assert_eq!((half.canvas_width, half.canvas_height), (16, 12));
    let reopened = photocraft_io::import("out.png", &half.output).expect("decode");
    assert_eq!((reopened.document.size.width, reopened.document.size.height), (16, 12));
    assert_eq!(editor.content_hash().expect("hash"), hash);
    assert_eq!(editor.state(), state);
    // 正式文档尺寸不变。
    assert_eq!(editor.state().pointer("/document/width").and_then(|v| v.as_u64()), Some(32));
}

#[test]
fn invalid_requests_are_refused_before_encoding() {
    let editor = editor();
    for params in [
        json!({"format":"psd"}), json!({"format":"pdf"}), json!({"jpegQuality":0}),
        json!({"jpegQuality":101}), json!({"webpQuality":-1}), json!({"scale":0}),
        json!({"scale":20}), json!({"pngCompression":"ultra"}), json!({"tiffCompression":"zip"}),
        json!({"unknown":true}), json!({"embedMetadata":"yes"}), json!(null), json!([]),
    ] {
        assert!(ExportRequest::parse(&params).is_err(), "必须拒绝：{params}");
    }
    // 没有文档时导出失败，而不是产生空文件。
    let empty = Editor::new();
    assert!(empty.export_image(ExportRequest::default()).is_err());
}
