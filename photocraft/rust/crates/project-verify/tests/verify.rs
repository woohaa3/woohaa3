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
    // 画板已开放（U56）：结构与子层内容都要核验，不能被整体拒绝。
    let mut artboard = Layer::group("画板", vec![raster("子层")]);
    if let LayerContent::Group(group) = &mut artboard.content {
        group.artboard = Some(photocraft_doc::Artboard::new(Default::default()));
    }
    let report = verify(&bytes(&doc(vec![raster("背景"), artboard]))).expect("画板工程应通过核验");
    assert!(report.object_kinds.iter().any(|kind| kind == "artboard"), "{:?}", report.object_kinds);
    // 子层被计入核验，而不是因为画板标记被跳过。
    assert!(report.layer_count >= 2, "{}", report.layer_count);

    // 填充层：U57 起是可重编内容，合法填充必须通过；无效/超限填充仍拒绝。
    let fill = Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::WHITE)));
    assert!(verify(&bytes(&doc(vec![raster("背景"), fill]))).is_ok(), "合法纯色填充层应通过核验");
    let bad = Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::rgba(0.0, 0.0, 0.0, 2.0))));
    assert_eq!(
        verify(&bytes(&doc(vec![raster("背景"), bad]))).unwrap_err().code,
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
    // 组合交付后画板已开放；嵌套组必须保留画板身份，仍拒绝非法填充。
    let mut artboard = Layer::group("画板", vec![raster("子层")]);
    if let LayerContent::Group(group) = &mut artboard.content {
        group.artboard = Some(photocraft_doc::Artboard::new(Default::default()));
    }
    let summary = verify(&bytes(&doc(vec![Layer::group("组", vec![artboard])]))).unwrap();
    assert_eq!(summary.object_kinds, vec!["artboard", "group", "raster"]);
    let bad_fill = Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::rgba(0.0, 0.0, 0.0, 2.0))));
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", vec![bad_fill])]))).unwrap_err().code, VerifyErrorCode::UnsupportedObject);
    let children = (0..limits::MAX_LAYERS).map(|_| raster("层")).collect();
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", children)]))).unwrap_err().code, VerifyErrorCode::TooManyLayers);
    let mut nested = Layer::group("空组", vec![]);
    for _ in 1..limits::MAX_DOCUMENT_DEPTH { nested = Layer::group("组", vec![nested]); }
    assert_eq!(verify(&bytes(&doc(vec![nested.clone()]))).unwrap().depth, limits::MAX_DOCUMENT_DEPTH);
    assert_eq!(verify(&bytes(&doc(vec![Layer::group("组", vec![nested])]))).unwrap_err().code, VerifyErrorCode::TooDeep);
}

#[test]
fn accepts_delivered_adjustments_and_rejects_undelivered_ones() {
    // P0 三类 + P5 四类（change: 2026-10-22）+ U43 九类（本 change）：合法且可编辑。
    for (name, adjustment) in [
        ("亮度/对比度", Adjustment::BrightnessContrast { brightness: 0.0, contrast: 0.0, legacy: false }),
        ("色相/饱和度", Adjustment::default_hue_saturation()),
        ("曲线", Adjustment::identity_curves()),
        ("色阶", Adjustment::identity_levels()),
        ("自然饱和度", Adjustment::Vibrance { vibrance: 10.0, saturation: 0.0 }),
        ("黑白", Adjustment::BlackWhite { weights: [40.0, 60.0, 40.0, 60.0, 20.0, 80.0], tint: None }),
        ("曝光", Adjustment::Exposure { exposure: 0.5, offset: 0.0, gamma: 1.0 }),
        (
            "色彩平衡",
            Adjustment::ColorBalance { shadows: [0.0; 3], midtones: [0.0; 3], highlights: [0.0; 3], preserve_luminosity: true },
        ),
        ("照片滤镜", Adjustment::PhotoFilter { color: [1.0, 0.5, 0.0], density: 0.25, preserve_luminosity: true }),
        (
            "通道混合器",
            Adjustment::ChannelMixer { matrix: [[0.4, 0.4, 0.2, 0.0], [0.3, 0.6, 0.1, 0.0], [0.2, 0.2, 0.6, 0.0]], monochrome: false },
        ),
        ("反相", Adjustment::Invert),
        ("色调分离", Adjustment::Posterize { levels: 6 }),
        ("阈值", Adjustment::Threshold { level: 0.5 }),
        (
            "渐变映射",
            Adjustment::GradientMap { stops: vec![(0.0, [0.0, 0.0, 0.0]), (1.0, [1.0, 1.0, 1.0])], reverse: false, dither: true },
        ),
        ("可选颜色", Adjustment::SelectiveColor { relative: true, adjustments: [[0.0; 4]; 9] }),
    ] {
        let layer = Layer::new(name, LayerContent::Adjustment(adjustment));
        let summary = verify(&bytes(&doc(vec![raster("背景"), layer])))
            .unwrap_or_else(|failure| panic!("{name} 应通过核验：{}", failure.message));
        assert!(summary.object_kinds.contains(&"adjustment".into()));
    }
    // 范围外/无法求值的调整（LUT、PSD 未知块）仍必须拒绝：`adjust.lut` 是永久非目标，
    // 放行会让「核验通过、运行时拒绝」同时成立。
    for (name, adjustment) in [
        (
            "LUT",
            Adjustment::ColorLookup { name: "Look.cube".into(), lut: None, size: 2, tetrahedral: false, dither: false },
        ),
        ("未知 PSD 块", Adjustment::Unsupported { psd_key: "grdm".into(), raw: vec![1, 2, 3] }),
    ] {
        let layer = Layer::new(name, LayerContent::Adjustment(adjustment));
        assert_eq!(
            verify(&bytes(&doc(vec![raster("背景"), layer]))).unwrap_err().code,
            VerifyErrorCode::UnsupportedObject,
            "{name} 必须被拒绝"
        );
    }
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

/// 通道是文档级资源：核验入口必须在真实工程字节上核验通道，而不是只在域内函数里通过。
#[test]
fn channels_are_verified_from_real_project_bytes() {
    use photocraft_doc::{AlphaChannel, Color, ColorIndicates, Surface};

    let mut document = doc(vec![raster("背景")]);
    assert!(verify(&bytes(&document)).is_ok(), "无通道的旧工程必须继续通过");

    let format = photocraft_doc::PixelFormat::new(ColorMode::Grayscale, SampleType::U8, false);
    document.channels.push(AlphaChannel {
        indicates: ColorIndicates::SelectedAreas,
        opacity: 0.4,
        ..AlphaChannel::new("Alpha 1", Surface::new(format))
    });
    document.channels.push(AlphaChannel {
        spot: Some((Color::rgb(0.0, 1.0, 0.0), 0.6)),
        ..AlphaChannel::new("专色绿", Surface::new(format))
    });
    let saved = bytes(&document);
    assert!(verify(&saved).is_ok(), "合法 Alpha/专色通道必须通过核验");

    // 通道名非法（空白）：整份工程必须在核验阶段被拒绝，而不是等到打开编辑器。
    let mut broken = document.clone();
    broken.channels[0].name = "  ".into();
    assert_eq!(
        verify(&bytes(&broken)).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject,
        "空白通道名必须在核验阶段拒绝"
    );

    // 不透明度越界同样拒绝：这类字节在核验里必须报错，不能静默夹取。
    let mut broken = document.clone();
    broken.channels[1].opacity = 2.0;
    assert_eq!(
        verify(&bytes(&broken)).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject,
    );

    // 通道平面格式与文档深度不符：核验拒绝（否则重开后通道命令组无法工作）。
    let mut broken = document;
    broken.channels[0].surface = Surface::new(photocraft_doc::PixelFormat::new(ColorMode::Rgb, SampleType::U8, true));
    assert_eq!(
        verify(&bytes(&broken)).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject,
    );
}

#[test]
fn variables_are_checked_at_document_level_not_per_layer() {
    use photocraft_doc::variables::{DataSet, DataValue, Value as VarValue, VarKind, VariableDef};
    let text = Layer::new(
        "标题",
        LayerContent::Text(TextLayer { text: "旧标题".into(), font_family: "Inter".into(), size_pt: 12.0, color: Color::WHITE, ..TextLayer::default() }),
    );
    let background = raster("背景");
    let text_id = text.id;
    let raster_id = background.id;
    let mut document = doc(vec![background, text]);
    // 合法：可见性可绑任意层，文字替换绑文字层，像素替换绑像素层。
    document.variables.defs = vec![
        VariableDef { name: "show".into(), layer: raster_id, kind: VarKind::Visibility },
        VariableDef { name: "title".into(), layer: text_id, kind: VarKind::TextReplacement },
        VariableDef { name: "photo".into(), layer: raster_id, kind: VarKind::PixelReplacement { method: Default::default(), align: Default::default(), clip: false } },
    ];
    document.variables.data_sets = vec![DataSet {
        name: "一".into(),
        values: vec![
            DataValue { variable: "show".into(), value: VarValue::Visibility(false) },
            DataValue { variable: "title".into(), value: VarValue::Text("新标题".into()) },
            DataValue { variable: "photo".into(), value: VarValue::Pixels("asset-key".into()) },
        ],
    }];
    assert!(verify(&bytes(&document)).is_ok(), "合法变量/数据集应通过");

    // 文字替换绑到像素层：上游只查图层存在，应用时静默跳过；核验器必须拦住。
    let mut wrong = document.clone();
    wrong.variables.defs[1].layer = raster_id;
    assert_eq!(verify(&bytes(&wrong)).unwrap_err().code, VerifyErrorCode::UnsupportedObject);

    // 指向不存在的图层。
    let mut dangling = document.clone();
    dangling.variables.defs[0].layer = photocraft_doc::LayerId(u64::MAX - 1);
    assert_eq!(verify(&bytes(&dangling)).unwrap_err().code, VerifyErrorCode::InvalidManifest);

    // 数据集引用未定义变量。
    let mut orphan = document.clone();
    orphan.variables.data_sets[0].values.push(DataValue { variable: "未定义".into(), value: VarValue::Visibility(true) });
    assert_eq!(verify(&bytes(&orphan)).unwrap_err().code, VerifyErrorCode::InvalidManifest);

    // 变量重名。
    let mut duplicate = document.clone();
    duplicate.variables.defs.push(duplicate.variables.defs[0].clone());
    assert_eq!(verify(&bytes(&duplicate)).unwrap_err().code, VerifyErrorCode::InvalidManifest);
    // 没有变量的工程照常通过（旧工程兼容）。
    assert!(verify(&bytes(&doc(vec![raster("背景")]))).is_ok());
}


/// 矢量载荷的**解码前**预算必须在公开入口生效
/// （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
///
/// 这里不走域内单测，而是造真实工程字节再交给 `verify`：已存路径超量、单路径锚点超量、
/// 全文档锚点累计超量都必须被拒；同时验证「旧工程没有路径字段」照常通过。
#[test]
fn vector_payload_budgets_are_enforced_before_decoding() {
    use photocraft_doc::vector::{NamedPath, Path, Subpath};

    fn square(offset: f64) -> Path {
        Path::new(vec![Subpath::polygon(&[
            (offset, offset),
            (offset + 4.0, offset),
            (offset + 4.0, offset + 4.0),
        ])])
    }

    // 没有矢量路径的工程照常通过（旧工程兼容）。
    let plain = doc(vec![raster("背景")]);
    assert!(verify(&bytes(&plain)).is_ok());

    // 已存路径数量超限。
    let mut many = doc(vec![raster("背景")]);
    for index in 0..=limits::MAX_VECTOR_SAVED_PATHS {
        many.paths.push(NamedPath { name: format!("P{index}"), path: square(index as f64), psd_raw: None });
    }
    assert_eq!(
        verify(&bytes(&many)).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject,
        "已存路径数量必须有界"
    );

    // 全文档锚点累计超限：每条路径都在子路径/锚点单项预算内，但总账必须拒绝。
    let mut deep = doc(vec![raster("背景")]);
    let mut subpaths: Vec<Subpath> = Vec::new();
    let knots: Vec<(f64, f64)> = (0..32).map(|knot| (knot as f64, (knot % 7) as f64)).collect();
    while (subpaths.len() as u64) * (knots.len() as u64) <= limits::MAX_VECTOR_PATH_POINTS {
        subpaths.push(Subpath::polygon(&knots));
    }
    assert!(subpaths.len() <= limits::MAX_VECTOR_SUBPATHS + 1, "先保证单路径子路径数仍在预算内");
    deep.paths.push(NamedPath { name: "深".into(), path: Path::new(subpaths), psd_raw: None });
    assert_eq!(
        verify(&bytes(&deep)).unwrap_err().code,
        VerifyErrorCode::UnsupportedObject,
        "锚点累计必须按全文档求和"
    );
}

#[test]
fn refuses_view_data_that_exceeds_the_domain_budget() {
    // 端到端：域内评审过的视图数据上限经 `features::views::inspect_document` 在文档级生效，
    // 恶意/超预算的 `.pcraft` 在加载阶段被拒，而不是进了编辑器才炸。
    let mut document = doc(vec![raster("paint")]);
    document.guides.vertical = (0..4097).map(|index| f64::from(index)).collect();
    let error = verify(&bytes(&document)).expect_err("参考线超过每轴上限必须拒绝");
    assert_eq!(error.code, VerifyErrorCode::UnsupportedObject, "超预算视图数据用稳定 code 拒绝");

    // 非有限坐标在写入端就被拒（序列化不产生 NaN 参考线），核验端另有一道同样的判定，
    // 因此恶意构造的字节流也进不来。
    let mut document = doc(vec![raster("paint")]);
    document.guides.horizontal = vec![f64::NAN];
    assert!(
        photocraft_format::save_to_bytes(&document, &SaveOptions::default()).is_err(),
        "NaN 参考线不能写入工程"
    );

    // 边界内的正常数据照常通过，证明拦截不是一刀切。
    let mut document = doc(vec![raster("paint")]);
    document.guides.vertical = vec![10.0, 20.0];
    document.ruler_origin = [5.0, 6.0];
    verify(&bytes(&document)).expect("有界视图数据必须通过");
}
