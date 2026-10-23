//! U07 回归：逐层计划与交付、命名/预算、包内报告与独立复核。

use photocraft_doc::LayerId;
use serde_json::json;

use super::*;
use crate::features::io::tests_support;

fn layer_ids(document: &photocraft_doc::Document) -> Vec<LayerId> {
    document.layers.iter().map(|layer| layer.id).collect()
}

#[test]
fn plan_matches_the_selection_with_bounded_names_and_bounds() {
    let document = tests_support::document();
    let ids = layer_ids(&document);
    let plan = plan_layers(&document, Some(ids[1]), &ids, &json!({"format": "png"})).unwrap();
    assert_eq!(plan.layers.len(), ids.len(), "计划必须逐层列出所选层");
    assert_eq!(plan.format, "png");
    // 报告与计划同源。
    let json = plan_json(&plan);
    assert_eq!(json["layers"].as_array().unwrap().len(), ids.len());
    assert_eq!(json["kind"], "layers");
    // 名称里的路径分隔符与 Windows 保留名被清理，包内不会出现目录跳转。
    let names: Vec<&str> = plan.layers.iter().map(|layer| layer.file_name.as_str()).collect();
    assert!(names.iter().all(|name| !name.contains('/') && !name.contains('\\') && !name.contains("..")));
    assert!(names.contains(&"半透明.png"), "{names:?}");
    assert!(
        names.iter().any(|name| name.contains("_CON") || name.contains("CON")),
        "保留名必须被改写：{names:?}"
    );
    // 每个非空层都有真实像素边界（40×30 内的子矩形）。
    let translucent = plan.layers.iter().find(|layer| layer.name == "半透明").unwrap();
    assert!(!translucent.empty);
    assert_eq!((translucent.width, translucent.height), (12, 8));
    // 报告把「原名 → 交付名」逐条列出，UI 才能说明改写原因。
    let renamed = plan
        .renames
        .iter()
        .find(|(original, delivered, _)| original.contains('/') && delivered.starts_with("_CON"))
        .expect("带路径与保留名的图层必须有改写记录");
    assert!(!renamed.2.is_empty(), "改写必须带原因");
}

#[test]
fn empty_layers_are_reported_per_item_and_do_not_block_the_rest() {
    let mut document = tests_support::document();
    document.layers.push(tests_support::empty_layer(&document, "全透明"));
    let ids = layer_ids(&document);
    let plan = plan_layers(&document, None, &ids, &json!({"format": "png"})).unwrap();
    let empty = plan.layers.iter().find(|layer| layer.name == "全透明").unwrap();
    assert!(empty.empty);
    assert!(empty.error.is_some());

    let encoded = export_layers(&document, &plan, 5, "hash").unwrap();
    let archive = photocraft_format::zip::ZipReader::new(&encoded.bytes).unwrap();
    let report: serde_json::Value =
        serde_json::from_slice(&archive.read_by_name("report.json", 4 << 20).unwrap()).unwrap();
    // 失败项在报告里可定位，且没有为它写空文件。
    let failed = report["files"].as_array().unwrap().iter().find(|file| file["name"] == "全透明").unwrap();
    assert_eq!(failed["ok"], false);
    assert!(failed["error"].as_str().unwrap().contains("可见像素"));
    assert!(archive.entries.iter().all(|entry| entry.name != "全透明.png"));
    // 其余图层照常交付。
    assert!(report["okCount"].as_u64().unwrap() >= 3);
    assert_eq!(report["failedCount"], 1);
    assert_eq!(report["documentChanged"], false);
    assert_eq!(report["revision"], 5);
    assert_eq!(report["documentContentHash"], "hash");
}

#[test]
fn bundle_pixels_and_names_match_the_plan_and_can_be_reinspected() {
    let document = tests_support::document();
    let ids = layer_ids(&document);
    let plan = plan_layers(&document, Some(ids[1]), &ids, &json!({"format": "png"})).unwrap();
    let encoded = export_layers(&document, &plan, 1, "h").unwrap();

    // 独立复核包内容（不依赖导出时的内存状态）。
    let inspected = inspect_bundle(&encoded.bytes).unwrap();
    let report = &inspected["report"];
    assert_eq!(report["kind"], "layers");
    let files = inspected["files"].as_array().unwrap();
    assert!(files.iter().any(|file| file["name"] == "report.json"));
    for target in plan.layers.iter().filter(|layer| !layer.empty) {
        let entry = files
            .iter()
            .find(|file| file["name"] == target.file_name.as_str())
            .unwrap_or_else(|| panic!("包内缺少 {}", target.file_name));
        assert!(entry["bytes"].as_u64().unwrap() > 0);
        // 包内文件的真实像素尺寸与计划边界一致。
        let archive = photocraft_format::zip::ZipReader::new(&encoded.bytes).unwrap();
        let data = archive.read_by_name(&target.file_name, 32 << 20).unwrap();
        let format = photocraft_codecs::detect(&data).expect("包内文件必须是真实栅格");
        let image = photocraft_codecs::decode_as_with(format, &data, &photocraft_codecs::DecodeOptions::default()).unwrap();
        assert_eq!((image.width(), image.height()), (target.width, target.height), "{}", target.file_name);
    }
    // 报告逐项与计划同名，文件数一致。
    assert_eq!(report["files"].as_array().unwrap().len(), plan.layers.len());
}

#[test]
fn unsupported_or_invalid_targets_are_rejected_before_anything_is_written() {
    let document = tests_support::document();
    let ids = layer_ids(&document);
    // 只读/暂缓格式不能作为交付格式。
    for format in ["pcx", "exr", "cin"] {
        assert!(plan_layers(&document, None, &ids, &json!({ "format": format })).is_err(), "{format}");
    }
    // 失效图层 id 明确拒绝，不静默丢弃。
    assert!(plan_layers(&document, None, &[LayerId(999_999)], &json!({"format": "png"})).is_err());
    // 空选择。
    assert!(plan_layers(&document, None, &[], &json!({"format": "png"})).is_err());
    // 超过逐层文件预算。
    let too_many: Vec<serde_json::Value> = (0..crate::features::io::budgets::budgets().max_layer_bundle_files + 1).map(|id| json!(id)).collect();
    assert!(plan_layers(&document, None, &ids, &json!({ "format": "png", "layers": too_many })).is_err());
}

#[test]
fn names_can_come_from_the_layer_and_stay_unique() {
    let mut document = tests_support::document();
    document.layers.push(tests_support::raster_layer(&document, "图标.png", Some((1, 1, 3, 3)), Some([0.4, 0.2, 0.9, 1.0])));
    let ids = layer_ids(&document);
    let plan = plan_layers(&document, None, &ids, &json!({"format": "png"})).unwrap();
    let names: Vec<&str> = plan.layers.iter().map(|layer| layer.file_name.as_str()).collect();
    // 两个同名图层不能互相覆盖。
    let unique: std::collections::BTreeSet<&&str> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "{names:?}");
    assert!(names.iter().filter(|name| name.starts_with("图标")).count() >= 2);
    // 图层名自带可写扩展名时以它为准。
    assert!(names.iter().any(|name| name == &"图标.png"));
}

#[test]
fn bundle_inspection_rejects_non_archives_and_oversized_input() {
    assert!(inspect_bundle(b"not a zip").is_err());
    let oversized = vec![0u8; crate::features::io::budgets::budgets().max_layer_bundle_bytes + 1];
    assert!(inspect_bundle(&oversized).is_err());
}
