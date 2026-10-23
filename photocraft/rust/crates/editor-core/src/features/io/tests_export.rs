//! U06 回归：设置归一化、唯一编码入口、预览/交付同源、矩阵与拒绝条件。

use photocraft_codecs::Format;
use serde_json::json;

use super::*;
use crate::features::io::tests_support;

fn settings(value: serde_json::Value) -> ExportSettings {
    parse_settings(&value).unwrap_or_else(|error| panic!("设置应当合法：{error}"))
}

fn decode(bytes: &[u8]) -> photocraft_codecs::Image {
    let format = photocraft_codecs::detect(bytes).expect("交付字节必须能被识别");
    photocraft_codecs::decode_as_with(format, bytes, &photocraft_codecs::DecodeOptions::default())
        .unwrap_or_else(|error| panic!("交付字节必须能解码：{error}"))
}

#[test]
fn export_matrix_covers_the_required_formats_and_only_lists_writable_ones() {
    let matrix = export_matrix();
    let rows = matrix.as_array().expect("矩阵是数组");
    let ids: Vec<&str> = rows.iter().map(|row| row["format"].as_str().unwrap()).collect();
    for required in ["jpg", "webp", "tif", "png"] {
        assert!(ids.contains(&required), "矩阵必须包含 {required}");
    }
    // 只读交换格式与暂缓格式都不出现在导出矩阵里。
    for absent in ["pcx", "xpm", "dds", "exr", "hdr", "cin", "fits", "dpx"] {
        assert!(!ids.contains(&absent), "{absent} 不应可导出");
    }
    // 每个可写格式都声明了自己的参数集合，JPEG 必须给出质量。
    let jpeg = rows.iter().find(|row| row["format"] == "jpg").unwrap();
    assert!(jpeg["options"].as_array().unwrap().iter().any(|option| option == "quality"));
    assert_eq!(jpeg["webFormats"], json!(["jpeg"]));
    // Save for Web 的格式词只出现在能走该路径的格式上。
    let webp = rows.iter().find(|row| row["format"] == "webp").unwrap();
    assert_eq!(webp["webFormats"], json!([]));
}

#[test]
fn settings_reject_unknown_deferred_and_alpha_mismatched_targets() {
    // 未知格式。
    assert!(parse_settings(&json!({"format": "nope"})).is_err());
    // 只读交换格式与暂缓格式不能当导出目标。
    for format in ["pcx", "xpm", "dds", "exr", "hdr", "cin", "fits", "dpx"] {
        let error = parse_settings(&json!({ "format": format })).unwrap_err();
        assert!(error.message().contains("不可写") || error.message().contains("暂不支持"), "{format}: {}", error.message());
    }
    // 缺 format。
    assert!(parse_settings(&json!({})).is_err());
    // 无 alpha 的格式不允许显式要求透明（不静默合成到白底）。
    let error = parse_settings(&json!({"format": "jpg", "transparency": true})).unwrap_err();
    assert!(error.message().contains("不支持透明"), "{}", error.message());
    // JPEG 默认关闭透明。
    assert!(!settings(json!({"format": "jpg"})).transparency);
    // PNG 默认保留透明。
    assert!(settings(json!({"format": "png"})).transparency);
    // 尺寸参数互斥且必须在范围内。
    assert!(parse_settings(&json!({"format": "png", "percent": 50, "width": 10})).is_err());
    assert!(parse_settings(&json!({"format": "png", "percent": 0})).is_err());
    assert!(parse_settings(&json!({"format": "png", "width": 0})).is_err());
    assert!(parse_settings(&json!({"format": "png", "quality": 0})).is_err());
    assert!(parse_settings(&json!({"format": "png", "metadata": "everything"})).is_err());
    assert!(parse_settings(&json!({"mode": "web", "format": "tiff"})).is_err());
    assert!(parse_settings(&json!({"mode": "web", "format": "wbmp"})).is_err());
}

#[test]
fn required_formats_encode_real_decodable_bytes_at_the_requested_size() {
    let document = tests_support::document();
    for (format, expected_width, expected_height) in [("jpg", 40, 30), ("webp", 40, 30), ("tif", 40, 30), ("png", 40, 30)] {
        let settings = settings(json!({ "format": format }));
        let encoded = encode_export(&document, &settings, 7, "abc", false).unwrap();
        let decoded = decode(&encoded.bytes);
        assert_eq!((decoded.width(), decoded.height()), (expected_width, expected_height), "{format}");
        assert_eq!(encoded.report["format"], settings.extension);
        assert_eq!(encoded.report["bytes"].as_u64().unwrap() as usize, encoded.bytes.len());
        assert_eq!(encoded.report["documentChanged"], false, "导出不得改文档");
        assert_eq!(encoded.report["revision"], 7);
        assert_eq!(encoded.report["documentContentHash"], "abc");
    }
    // 百分比缩放走同一重采样器，报告与真实像素尺寸一致。
    let half = settings(json!({"format": "png", "percent": 50}));
    let encoded = encode_export(&document, &half, 1, "h", false).unwrap();
    assert_eq!((encoded.report["width"].as_u64(), encoded.report["height"].as_u64()), (Some(20), Some(15)));
    let decoded = decode(&encoded.bytes);
    assert_eq!((decoded.width(), decoded.height()), (20, 15));
}

#[test]
fn preview_and_delivery_share_one_encoder_and_are_byte_identical() {
    let document = tests_support::document();
    for params in [
        json!({"format": "jpg", "quality": 72}),
        json!({"format": "webp", "webpQuality": 55, "webpLossless": false}),
        json!({"format": "tif", "tiffCompression": "lzw"}),
        json!({"format": "png", "pngCompression": "best"}),
        json!({"mode": "web", "format": "png8", "colors": 32}),
        json!({"mode": "web", "format": "gif"}),
        json!({"mode": "web", "format": "jpeg", "quality": 60}),
    ] {
        let settings = settings(params.clone());
        let preview = encode_export(&document, &settings, 3, "h", true).unwrap();
        let delivery = encode_export(&document, &settings, 3, "h", false).unwrap();
        // 同一设置、同一快照 ⇒ 同一字节；预览不是「另一份设置」。
        assert_eq!(preview.bytes, delivery.bytes, "{params}");
        assert_eq!(preview.report["settings"], delivery.report["settings"], "{params}");
        assert_eq!(preview.report["preview"], true);
        assert_eq!(delivery.report["preview"], false);
        // 真实编码的预览本身就应当可解码。
        decode(&preview.bytes);
    }
}

#[test]
fn save_for_web_reports_the_real_web_format_and_palette() {
    let document = tests_support::document();
    let gif = encode_export(&document, &settings(json!({"mode": "web", "format": "gif", "colors": 16})), 1, "h", false).unwrap();
    assert_eq!(gif.report["format"], "gif");
    assert_eq!(gif.report["mime"], "image/gif");
    assert_eq!(gif.report["lossy"], true);
    let colors = gif.report["colors"].as_u64().expect("调色板颜色数");
    assert!(colors <= 16, "{colors}");
    assert_eq!(decode(&gif.bytes).width(), 40);

    let png24 = encode_export(&document, &settings(json!({"mode": "web", "format": "png24"})), 1, "h", false).unwrap();
    assert_eq!(png24.report["format"], "png");
    assert_eq!(png24.report["lossy"], false);

    // 预设与所选格式冲突时拒绝，而不是让两套格式互相覆盖。
    let conflict = parse_settings(&json!({"mode": "web", "format": "gif", "preset": "JPEG High"}));
    assert!(conflict.is_err(), "预设格式不一致必须拒绝");
}

#[test]
fn save_for_web_quality_settings_reach_the_encoder() {
    // 真实多色渐变：单色块会被调色板压成 1 色，量化/抖动就没有可观察差异。
    let document = tests_support::gradient_document();
    let encode = |params: serde_json::Value| encode_export(&document, &settings(params), 1, "h", false).unwrap();

    // 颜色数：报告的调色板大小跟随设置，字节也确实不同。
    let small = encode(json!({"mode": "web", "format": "png8", "colors": 2}));
    let large = encode(json!({"mode": "web", "format": "png8", "colors": 128}));
    assert_eq!(small.report["colors"], 2, "颜色数必须被真实执行");
    assert!(large.report["colors"].as_u64().unwrap() > 2);
    assert_ne!(small.bytes, large.bytes, "颜色数必须真的影响编码");

    // 抖动方式与强度：都必须进入编码器，而不是被解析后丢掉。
    let no_dither = encode(json!({"mode": "web", "format": "gif", "colors": 16, "dither": "none"}));
    let diffusion = encode(json!({"mode": "web", "format": "gif", "colors": 16, "dither": "diffusion"}));
    assert_ne!(no_dither.bytes, diffusion.bytes, "抖动方式必须真的影响编码");
    let weak = encode(json!({"mode": "web", "format": "gif", "colors": 16, "ditherAmount": 0}));
    let strong = encode(json!({"mode": "web", "format": "gif", "colors": 16, "ditherAmount": 100}));
    assert_ne!(weak.bytes, strong.bytes, "抖动强度必须真的影响编码");

    // 预检回显同一批设置，界面显示的与交付用的是同一份。
    let inspected = crate::features::io::export::parse_settings(
        &json!({"mode": "web", "format": "png8", "colors": 32, "dither": "noise", "ditherAmount": 55}),
    )
    .unwrap();
    let echo = inspected.inspect_json();
    assert_eq!(echo["web"]["colors"], 32);
    assert_eq!(echo["web"]["dither"], "noise");
    // 上游把 `ditherAmount` 归一成 f32 百分比后回显，因此这里是浮点数而不是整数。
    assert_eq!(echo["web"]["ditherAmount"].as_f64(), Some(55.0));
}

#[test]
fn format_option_table_is_the_single_authority_for_the_panel() {
    // 面板只显示内核声明的参数：这里的表就是界面控件的唯一来源。
    let matrix = export_matrix();
    let rows = matrix.as_array().expect("数组");
    let options = |format: &str| {
        rows.iter()
            .find(|row| row["format"] == format)
            .map(|row| row["options"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let jpeg = options("jpg");
    assert!(jpeg.contains(&"chromaSubsampling".to_string()));
    assert!(!jpeg.contains(&"transparency".to_string()), "JPEG 没有 alpha，不该声明透明参数");
    let png = options("png");
    assert!(png.contains(&"interlaced".to_string()));
    assert!(png.contains(&"transparency".to_string()));
    let webp = options("webp");
    assert!(webp.contains(&"webpLossless".to_string()));
    assert!(webp.contains(&"transparency".to_string()));

    // 声明了参数就必须真的能编码（否则面板会给出必然失败的控件）。
    let document = tests_support::document();
    for row in rows {
        let format = row["format"].as_str().unwrap();
        let encoded = encode_export(&document, &settings(json!({"format": format})), 1, "h", false).unwrap();
        assert!(!encoded.bytes.is_empty(), "{format}");
    }
}

#[test]
fn oversized_targets_are_rejected_instead_of_downscaled() {
    let document = tests_support::document();
    let budgets = crate::features::io::budgets::budgets();
    let too_wide = settings(json!({"format": "png", "width": budgets.max_export_dimension + 1}));
    let error = encode_export(&document, &too_wide, 1, "h", false).unwrap_err();
    assert!(error.message().contains("超过单边上限"), "{}", error.message());
    // 文档本身未被改动（尺寸仍是 40×30）。
    assert_eq!((document.size.width, document.size.height), (40, 30));
}

#[test]
fn encode_options_follow_the_requested_format() {
    let jpeg = settings(json!({"format": "jpg", "quality": 42, "chromaSubsampling": false, "metadata": "copyright"}));
    let options = jpeg.encode_options();
    assert_eq!(options.jpeg_quality, 42);
    assert!(!options.jpeg_chroma_subsampling);
    assert!(options.embed_metadata, "copyright 要求写入元数据");
    let none = settings(json!({"format": "jpg", "metadata": "none"})).encode_options();
    assert!(!none.embed_metadata);
    let tiff = settings(json!({"format": "tif", "tiffCompression": "deflate"})).encode_options();
    assert_eq!(tiff.tiff_compression, photocraft_codecs::TiffCompression::Deflate);
    let png = settings(json!({"format": "png", "interlaced": true, "pngCompression": "fast"})).encode_options();
    assert!(png.png_interlaced);
    assert_eq!(png.png_compression, photocraft_codecs::PngCompression::Fast);
    // 通用导出的 WebP 默认有损（与 Save for Web 之外的默认值一致，用户可显式要无损）。
    let webp = settings(json!({"format": "webp"})).encode_options();
    assert!(!webp.webp_lossless);
    assert_eq!(format_for_extension("jpg"), Some(Format::Jpeg));
}

#[test]
fn save_for_web_reports_the_losses_it_actually_performs() {
    // 优化器不产出损失清单，但量化/有损确实发生了。报告必须说出来：
    // 否则「预览成功」会把不可逆损失藏起来（Export As 路径一直有这些 warnings）。
    let document = tests_support::gradient_document();
    let encode = |params: serde_json::Value| encode_export(&document, &settings(params), 1, "h", false).unwrap();

    // 索引格式：量化到真实调色板大小，而不是一句「支持」。
    let gif = encode(json!({"mode": "web", "format": "gif", "colors": 16}));
    let warnings: Vec<String> = gif.report["warnings"]
        .as_array()
        .expect("warnings 数组")
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    assert!(
        warnings.iter().any(|warning| warning.contains("quantized") && warning.contains("16")),
        "量化必须带真实颜色数：{warnings:?}"
    );
    // 报告的调色板大小与警告里的数字一致（不是前端猜的）。
    assert_eq!(gif.report["colors"], 16);

    // JPEG：有损压缩本身就是损失，必须出现在 warnings 里。
    let jpeg = encode(json!({"mode": "web", "format": "jpeg", "quality": 60}));
    let jpeg_warnings = jpeg.report["warnings"].as_array().unwrap();
    assert!(jpeg_warnings.iter().any(|warning| warning == "lossy compression"), "{jpeg_warnings:?}");

    // PNG-24 无损且不量化：不给假警告。
    let png24 = encode(json!({"mode": "web", "format": "png24"}));
    assert_eq!(png24.report["warnings"], json!([]), "无损路径不该有损失提示");

    // Export As 与 Save for Web 对同一格式的量化结论必须一致（两条路径不能各说一套）。
    let export_gif = encode(json!({"format": "gif"}));
    let export_warnings = export_gif.report["warnings"].as_array().unwrap();
    assert!(
        export_warnings.iter().any(|warning| warning.as_str().unwrap().contains("quantized")),
        "{export_warnings:?}"
    );
}
