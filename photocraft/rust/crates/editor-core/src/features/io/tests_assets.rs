//! U07 回归：按图层名称生成 Image Assets（语法、命名、尺寸、预算与失败定位）。

use serde_json::json;

use super::*;
use crate::features::io::tests_support;

fn names(document: &photocraft_doc::Document) -> Vec<String> {
    document.layers.iter().map(|layer| layer.name.clone()).collect()
}

#[test]
fn layer_names_are_expanded_into_asset_plans_with_real_sizes() {
    let document = tests_support::document();
    let plan = plan_assets(&document).unwrap();
    // 只有 `图标.png` 命中语法（其余图层名不是资产名）。
    assert_eq!(plan.assets.len(), 1, "{:?}", plan.assets.iter().map(|asset| &asset.delivered).collect::<Vec<_>>());
    let asset = &plan.assets[0];
    assert_eq!(asset.layer_name, "图标.png");
    assert_eq!(asset.delivered, "图标.png");
    assert_eq!(asset.format, "png");
    // 6×6 的可见像素。
    assert_eq!((asset.width, asset.height), (6, 6));
    assert!(asset.error.is_none());

    let report = plan_json(&plan);
    assert_eq!(report["kind"], "assets");
    assert_eq!(report["ok"], true);
    assert_eq!(report["assets"].as_array().unwrap().len(), 1);
}

#[test]
fn scale_size_quality_and_variant_syntax_are_honoured() {
    let mut document = tests_support::document();
    document.layers.push(tests_support::raster_layer(&document, "200% logo@2x.png", Some((2, 2, 10, 4)), Some([1.0, 0.0, 0.0, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "48x48 方形.jpg70%", Some((0, 0, 10, 10)), Some([0.2, 0.6, 1.0, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "default 50% low/, 200% @2x", None, None));

    let plan = plan_assets(&document).unwrap();
    let by_name = |needle: &str| plan.assets.iter().find(|asset| asset.layer_name.contains(needle)).unwrap();

    // `default` 变体会把每个资产再放大 2 倍：源边界 10×4 × 200%（名称）× 200%（变体）= 40×16。
    let logo_2x = plan
        .assets
        .iter()
        .find(|asset| asset.layer_name.contains("logo") && !asset.delivered.starts_with("low/"))
        .expect("2x 变体");
    assert_eq!((logo_2x.width, logo_2x.height), (40, 16), "名称缩放与 default 变体缩放都要作用在真实像素边界上");
    assert!(logo_2x.delivered.contains("@2x"));
    let logo_low = plan
        .assets
        .iter()
        .find(|asset| asset.layer_name.contains("logo") && asset.delivered.starts_with("low/"))
        .expect("低倍变体");
    assert_eq!((logo_low.width, logo_low.height), (10, 4), "50% 变体作用在名称缩放之后");

    let square_1x = plan
        .assets
        .iter()
        .find(|asset| asset.layer_name.contains("方形") && !asset.delivered.starts_with("low/"))
        .expect("2x 变体");
    // 名称里的显式尺寸优先于源比例，随后叠加变体缩放。
    assert_eq!((square_1x.width, square_1x.height), (96, 96));
    assert_eq!(square_1x.quality, Some(70));
    assert_eq!(square_1x.format, "jpg");
    let square_low = by_name("方形.jpg70%");
    assert_eq!((square_low.width, square_low.height), (24, 24));
    assert_eq!(square_low.quality, Some(70));
    assert_eq!(square_low.format, "jpg");

    // `default` 层为每个按名称命名的资产各展开一份（低倍目录前缀 + 2x 后缀），
    // 因此资产总数正好是「命名图层数 × 变体数」，且每个变体都能追到产生它的图层。
    let named_layers = ["图标.png", "200% logo@2x.png", "48x48 方形.jpg70%"];
    assert_eq!(plan.assets.len(), named_layers.len() * 2);
    for asset in &plan.assets {
        assert!(named_layers.contains(&asset.layer_name.as_str()), "{}", asset.layer_name);
    }
    let variants: Vec<&AssetTarget> = plan
        .assets
        .iter()
        .filter(|asset| asset.delivered.starts_with("low/") || asset.delivered.contains("@2x"))
        .collect();
    assert_eq!(variants.len(), plan.assets.len(), "每个资产都必须带变体标记");
    assert_eq!(plan.assets.iter().filter(|asset| asset.delivered.starts_with("low/")).count(), named_layers.len());
    assert!(plan.assets.iter().all(|asset| asset.error.is_none()), "语法展开不应产生失败项");
}

#[test]
fn unsafe_names_cannot_escape_the_bundle_and_duplicates_are_reported() {
    let mut document = tests_support::document();
    // 目录跳转 + Windows 保留名 + 非法字符。
    document.layers.push(tests_support::raster_layer(&document, "../../etc/passwd.png", Some((1, 1, 4, 4)), Some([0.1, 0.2, 0.3, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "icons/CON.png", Some((1, 1, 4, 4)), Some([0.3, 0.2, 0.1, 1.0])));
    // 同一交付路径出现两次。
    document.layers.push(tests_support::raster_layer(&document, "dup.png", Some((1, 1, 4, 4)), Some([0.5, 0.5, 0.5, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "dup.png", Some((2, 2, 4, 4)), Some([0.6, 0.5, 0.4, 1.0])));

    let plan = plan_assets(&document).unwrap();
    for asset in &plan.assets {
        assert!(!asset.delivered.contains(".."), "{}", asset.delivered);
        assert!(!asset.delivered.starts_with('/'), "{}", asset.delivered);
        assert!(!asset.delivered.split('/').any(|part| part.eq_ignore_ascii_case("con")), "{}", asset.delivered);
        assert!(asset.delivered.chars().count() <= crate::features::io::budgets::budgets().max_relative_path_length);
    }
    // 两个同名图层的交付路径必须不同（-2 序号），不会互相覆盖。
    let dups: Vec<&str> = plan.assets.iter().filter(|asset| asset.requested.starts_with("dup")).map(|asset| asset.delivered.as_str()).collect();
    assert_eq!(dups.len(), 2);
    assert_ne!(dups[0], dups[1]);

    let encoded = export_assets(&document, &plan, 2, "h").unwrap();
    let archive = photocraft_format::zip::ZipReader::new(&encoded.bytes).unwrap();
    let reported: Vec<&str> = archive.entries.iter().map(|entry| entry.name.as_str()).collect();
    for asset in plan.assets.iter().filter(|asset| asset.error.is_none()) {
        assert!(reported.contains(&asset.delivered.as_str()), "包内缺少 {}", asset.delivered);
    }
}

#[test]
fn assets_are_encoded_in_the_format_the_name_asked_for() {
    let mut document = tests_support::document();
    document.layers.push(tests_support::raster_layer(&document, "web.png", Some((0, 0, 12, 12)), Some([1.0, 0.2, 0.2, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "web.webp", Some((0, 0, 12, 12)), Some([0.2, 1.0, 0.2, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "web8.png8", Some((0, 0, 12, 12)), Some([0.2, 0.2, 1.0, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "webgif.gif", Some((0, 0, 12, 12)), Some([0.8, 0.8, 0.1, 1.0])));
    document.layers.push(tests_support::raster_layer(&document, "webj.webp", Some((0, 0, 12, 12)), Some([0.1, 0.8, 0.8, 1.0])));

    let plan = plan_assets(&document).unwrap();
    let encoded = export_assets(&document, &plan, 1, "h").unwrap();
    let archive = photocraft_format::zip::ZipReader::new(&encoded.bytes).unwrap();
    for asset in plan.assets.iter().filter(|asset| asset.error.is_none()) {
        let data = archive.read_by_name(&asset.delivered, 16 << 20).unwrap();
        let format = photocraft_codecs::detect(&data).expect("资产必须是真实栅格");
        let expected = match asset.delivered.rsplit_once('.').map(|(_, extension)| extension) {
            Some("webp") => "webp",
            Some("gif") => "gif",
            Some("png") => "png",
            other => panic!("未预期的资产扩展名：{other:?}"),
        };
        assert_eq!(format.extensions()[0], expected, "{}", asset.delivered);
    }
}

#[test]
fn documents_without_asset_names_are_rejected_with_an_explanation() {
    let document = tests_support::background_only();
    let error = plan_assets(&document).unwrap_err();
    assert!(error.message().contains("资产语法"), "{}", error.message());
    // 解析器对普通图层名保持沉默（不把每个图层都当资产）。
    assert!(web_cmds::parse_asset_name("背景", 72.0).is_empty());
    assert!(web_cmds::parse_asset_name("../etc/passwd.png", 72.0).len() == 1);
    // 解析出的候选名先经本域清理。
    let _ = names(&document);
}

#[test]
fn asset_pixel_budget_is_enforced_before_encoding() {
    let mut document = tests_support::document();
    // 名称要求一个超出单边预算的尺寸：计划阶段就标记为不可交付。
    document.layers.push(tests_support::raster_layer(&document, "100000x100000 big.png", Some((0, 0, 4, 4)), Some([0.5, 0.5, 0.5, 1.0])));
    let plan = plan_assets(&document).unwrap();
    let big = plan.assets.iter().find(|asset| asset.layer_name.starts_with("100000x")).unwrap();
    assert!(big.error.is_some(), "超预算尺寸必须在计划阶段失败");
    assert!(big.error.as_ref().unwrap().contains("预算"), "{:?}", big.error);
    // 其余资产仍可交付。
    assert!(plan.assets.iter().any(|asset| asset.error.is_none()));
}
