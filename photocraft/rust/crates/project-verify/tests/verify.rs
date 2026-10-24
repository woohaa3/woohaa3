//! 核验工具回归：与编辑器共用同一解析实现，验收「正常往返、结构缺失、越界、能力边界」。
//!
//! 测试只在 CPU 上解析/序列化，不渲染（change: 2026-10-16-integrate-photocraft-image-editing）。

use std::sync::Arc;

use photocraft_doc::{BlendMode, Color, ColorMode, SampleType};
use photocraft_doc::{
    Adjustment, Affine, Document, Fill, Layer, LayerContent, Size, SmartContentsId, SmartObject, SmartSource, TextLayer,
};
use photocraft_format::SaveOptions;
use photocraft_project_verify::{VerifyErrorCode, limits, verify};

fn doc(layers: Vec<Layer>) -> Document {
    let mut d = Document::new("工程", Size::new(64, 48), ColorMode::Rgb, SampleType::U8);
    d.layers = layers;
    d
}

fn raster(name: &str) -> Layer {
    let format = Document::new("t", Size::new(1, 1), ColorMode::Rgb, SampleType::U8).pixel_format();
    let mut layer = Layer::raster(name, format);
    layer.blend = BlendMode::Normal;
    layer
}

fn bytes(document: &Document) -> Vec<u8> {
    photocraft_format::save_to_bytes(document, &SaveOptions::default()).expect("保存合成工程")
}

#[test]
fn accepts_a_first_phase_document_and_reports_the_summary() {
    let text = Layer::new(
        "标题",
        LayerContent::Text(TextLayer {
            text: "标题".into(),
            font_family: "Inter".into(),
            size_pt: 24.0,
            color: Color::WHITE,
            ..TextLayer::default()
        }),
    );
    let document = doc(vec![
        raster("背景"),
        raster("标注 1"),
        text,
        Layer::new(
            "亮度/对比度",
            LayerContent::Adjustment(Adjustment::BrightnessContrast { brightness: 0.0, contrast: 0.0, legacy: false }),
        ),
        Layer::new("色相/饱和度", LayerContent::Adjustment(Adjustment::default_hue_saturation())),
        Layer::new("曲线", LayerContent::Adjustment(Adjustment::identity_curves())),
    ]);
    let summary = verify(&bytes(&document)).expect("首期文档应通过核验");
    assert_eq!(summary.format_version, 1);
    assert_eq!(summary.canvas_width, 64);
    assert_eq!(summary.canvas_height, 48);
    assert_eq!(summary.layer_count, 6);
    assert_eq!(summary.depth, 1);
    assert!(summary.entry_count >= 1);
    assert_eq!(summary.object_kinds, vec!["adjustment", "raster", "text"]);
    assert_eq!(summary.bridge_protocol, limits::BRIDGE_PROTOCOL_VERSION);
    assert_eq!(summary.supported_format_versions, &[1]);
}

#[test]
fn round_trips_through_the_editor_shared_parser() {
    let document = doc(vec![raster("背景"), raster("层")]);
    let saved = bytes(&document);
    let loaded = photocraft_format::load_from_bytes(&saved).expect("编辑器共用解析器可读");
    assert_eq!(loaded.layers.len(), 2);
    assert_eq!(loaded.size.width, 64);
}

#[test]
fn rejects_non_zip_and_empty_input() {
    assert_eq!(verify(&[]).unwrap_err().code, VerifyErrorCode::Empty);
    assert_eq!(verify(b"not a zip at all").unwrap_err().code, VerifyErrorCode::NotAZip);
    assert_eq!(verify(&[0u8; 4096]).unwrap_err().code, VerifyErrorCode::NotAZip);
}

#[test]
fn rejects_path_traversal_entry_names() {
    let mut zip = photocraft_format::zip::ZipWriter::new();
    zip.add("../escape", b"x").expect("写入条目");
    zip.add("manifest.json", b"{}").expect("写入条目");
    let bytes = zip.finish().expect("完成 ZIP");
    assert_eq!(verify(&bytes).unwrap_err().code, VerifyErrorCode::PathTraversal);

    let mut zip = photocraft_format::zip::ZipWriter::new();
    zip.add("C:\\windows\\evil", b"x").expect("写入条目");
    let bytes = zip.finish().expect("完成 ZIP");
    assert_eq!(verify(&bytes).unwrap_err().code, VerifyErrorCode::PathTraversal);
}

#[test]
fn rejects_an_empty_layer_list() {
    let document = doc(Vec::new());
    assert_eq!(verify(&bytes(&document)).unwrap_err().code, VerifyErrorCode::InvalidManifest);
}

#[test]
fn rejects_unsupported_object_kinds_not_just_hides_them() {
    // 普通组已支持，画板仍不开放。
    let mut group = Layer::group("画板", vec![raster("子层")]);
    if let LayerContent::Group(group) = &mut group.content {
        group.artboard = Some(photocraft_doc::Artboard::new(Default::default()));
    }
    assert_eq!(
        verify(&bytes(&doc(vec![raster("背景"), group]))).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject
    );

    // 填充层：首期能力清单外。
    let fill = Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::WHITE)));
    assert_eq!(
        verify(&bytes(&doc(vec![raster("背景"), fill]))).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject
    );

    // 智能对象：可指向上游行为或外部文件。
    let embedded = bytes(&doc(vec![raster("内层")]));
    let smart = Layer::new(
        "智能对象",
        LayerContent::Smart(SmartObject {
            contents_id: SmartContentsId::fresh(),
            source: SmartSource::Embedded { file_name: "inner.pcraft".into(), bytes: Arc::new(embedded) },
            transform: Affine::IDENTITY,
            smart_filters: Vec::new(),
            cache: None,
            psd_raw: None,
            filters_enabled: true,
            filter_mask: None,
            warp: None,
            stack_mode: None,
            perspective: None,
        }),
    );
    assert_eq!(
        verify(&bytes(&doc(vec![raster("背景"), smart]))).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject
    );
}

#[test]
fn accepts_nested_groups_and_counts_the_entire_tree() {
    let document = doc(vec![raster("背景"), Layer::group("组", vec![raster("子层"), Layer::group("空组", vec![])])]);
    let summary = verify(&bytes(&document)).unwrap();
    assert_eq!(summary.layer_count, 4);
    assert_eq!(summary.depth, 2);
    assert_eq!(summary.object_kinds, vec!["group", "raster"]);
    let loaded = photocraft_format::load_from_bytes(&bytes(&document)).unwrap();
    assert_eq!(loaded.layers[1].children().unwrap().len(), 2);
}

#[test]
fn groups_cannot_hide_unsupported_children_or_bypass_tree_limits() {
    let fill = Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::WHITE)));
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", vec![fill])]))).unwrap_err().code, VerifyErrorCode::UnsupportedObject);
    let children = (0..limits::MAX_LAYERS).map(|_| raster("层")).collect();
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", children)]))).unwrap_err().code, VerifyErrorCode::TooManyLayers);
    let mut nested = Layer::group("空组", vec![]);
    for _ in 1..limits::MAX_DOCUMENT_DEPTH { nested = Layer::group("组", vec![nested]); }
    assert_eq!(verify(&bytes(&doc(vec![nested.clone()]))).unwrap().depth, limits::MAX_DOCUMENT_DEPTH);
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", vec![nested])]))).unwrap_err().code, VerifyErrorCode::TooDeep);
}

#[test]
fn rejects_unsupported_adjustments() {
    // 色阶是真实的上游调整层，但不在首期三类（亮度/对比度、色相/饱和度、RGB 曲线）之内。
    let levels = Layer::new("色阶", LayerContent::Adjustment(Adjustment::identity_levels()));
    assert_eq!(
        verify(&bytes(&doc(vec![raster("背景"), levels]))).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject
    );
}

#[test]
fn rejects_too_many_layers() {
    let layers: Vec<Layer> = (0..limits::MAX_LAYERS + 1).map(|i| raster(&format!("层 {i}"))).collect();
    assert_eq!(verify(&bytes(&doc(layers))).unwrap_err().code, VerifyErrorCode::TooManyLayers);
}

#[test]
fn rejects_canvas_beyond_the_first_phase_side_limit() {
    let mut document =
        Document::new("大画布", Size::new(limits::MAX_CANVAS_SIDE + 1, 1), ColorMode::Rgb, SampleType::U8);
    document.layers = vec![raster("背景")];
    assert_eq!(verify(&bytes(&document)).unwrap_err().code, VerifyErrorCode::CanvasTooLarge);
}

/// 声明过新的格式版本：把已保存工程的 `manifest.json` 改写为 `format_version: 9`，
/// 其余条目原样复制（重新计算 CRC），核验必须报告 `UnsupportedFormatVersion`。
#[test]
fn rejects_declared_format_versions_outside_the_supported_set() {
    let saved = bytes(&doc(vec![raster("背景")]));
    let archive = photocraft_format::zip::ZipReader::new(&saved).expect("读取已保存工程");
    let mut rewritten = photocraft_format::zip::ZipWriter::new();
    for entry in &archive.entries {
        let data = archive.read(entry, 64 << 20).expect("读取条目");
        if entry.name == "manifest.json" {
            let text = String::from_utf8(data).expect("manifest 是 UTF-8");
            let mut value: serde_json::Value = serde_json::from_str(&text).expect("manifest 是 JSON");
            value["format_version"] = serde_json::Value::from(9);
            let mutated = serde_json::to_string(&value).expect("重新序列化 manifest");
            assert!(mutated.contains("\"format_version\":9"), "改写成功");
            rewritten.add("manifest.json", mutated.as_bytes()).expect("写入 manifest");
        } else {
            rewritten.add(&entry.name, &data).expect("复制条目");
        }
    }
    let doctored = rewritten.finish().expect("完成 ZIP");
    assert_eq!(verify(&doctored).unwrap_err().code, VerifyErrorCode::UnsupportedFormatVersion);
}

#[test]
fn rejects_non_photoshop_blends_and_pixel_passthrough_without_rendering() {
    for mode in BlendMode::PAINT_NET_MODES.into_iter().chain([BlendMode::PassThrough]) {
        let mut layer=raster("层"); layer.blend=mode;
        assert_eq!(verify(&bytes(&doc(vec![layer]))).unwrap_err().code,VerifyErrorCode::UnsupportedObject);
    }
}

#[test]
fn fill_opacity_is_preserved_and_invalid_ranges_are_rejected_without_rendering() {
    for fill in [0.0,0.4,1.0] {
        let mut layer=raster("层"); layer.fill_opacity=fill;
        assert!(verify(&bytes(&doc(vec![layer]))).is_ok());
    }
    for fill in [-0.1,1.1] {
        let mut layer=raster("层"); layer.fill_opacity=fill;
        assert!(verify(&bytes(&doc(vec![layer]))).is_err());
    }
}


#[test]
fn pattern_resources_are_checked_before_tile_decode() {
    use photocraft_doc::{Pattern,Surface};
    let mut document=doc(vec![raster("背景")]);
    document.patterns=vec![Pattern{id:"pattern-1".into(),name:"图案".into(),width:16,height:16,surface:Surface::new(document.pixel_format())}];
    let saved=bytes(&document);assert!(verify(&saved).is_ok());
    let original=photocraft_format::read_manifest(&saved).unwrap();
    for case in 0..7 {
        let mut manifest=original.clone();let p=&mut manifest.document.patterns[0];
        match case {
            0=>p.width=0,
            1=>p.width=1025,
            2=>p.id=" ".into(),
            3=>p.surface.default="bad".into(),
            4=>p.surface.tiles.push(photocraft_format::manifest::TileRef{tx:99,ty:0,hash:"missing-resource".into()}),
            5=>{let p=p.clone();manifest.document.patterns.push(p);},
            _=>{p.width=1024;p.height=1024;let p=p.clone();manifest.document.patterns=(0..5).map(|i|{let mut next=p.clone();next.id=i.to_string();next}).collect();},
        }
        let mut archive=photocraft_format::zip::ZipWriter::new();
        archive.add("manifest.json",&serde_json::to_vec(&manifest).unwrap()).unwrap();
        // 无效资源即使声明了缺失的 tile，也须先以资源边界拒绝。
        assert_eq!(verify(&archive.finish().unwrap()).unwrap_err().code,VerifyErrorCode::UnsupportedObject,"case {case}");
    }
}

#[test]
fn layer_metadata_accepts_labels_but_refuses_zero_and_unsafe_link_groups_without_rendering() {
    let mut document=doc(vec![raster("元数据")]);document.layers[0].label=photocraft_doc::LabelColor::Red;document.layers[0].link_group=Some(1);verify(&bytes(&document)).unwrap();
    for group in [0,9_007_199_254_740_992,u64::MAX] {document.layers[0].link_group=Some(group);assert_eq!(verify(&bytes(&document)).unwrap_err().code,VerifyErrorCode::UnsupportedObject);}
}

#[test]
fn resolution_limits_are_checked_before_document_loading() {
    for dpi in [1.,72.,300.1,10000.] {let mut d=doc(vec![raster("像素")]);d.resolution_dpi=dpi;verify(&bytes(&d)).unwrap();}
    for dpi in [0.,-1.,10001.] {let mut d=doc(vec![raster("像素")]);d.resolution_dpi=dpi;assert_eq!(verify(&bytes(&d)).unwrap_err().code,VerifyErrorCode::UnsupportedObject);}
}
