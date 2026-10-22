//! 首期上限的**单源核对**：`project-limits.json` 是唯一权威来源，Rust 常量必须逐字段一致。
//!
//! TypeScript 协议包（`IMAGE_PROJECT_LIMITS`）读同一份文件，由子项目 protocol 包的
//! `packages/protocol/src/image-project.test.ts` 交叉核对，避免两端漂移
//! （change: 2026-10-16-integrate-photocraft-image-editing，任务 1.1/2.3）。

use std::collections::BTreeMap;

use photocraft_project_verify::limits;

fn read_limits() -> BTreeMap<String, u64> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../project-limits.json"))
        .expect("读取 project-limits.json");
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("解析 project-limits.json");
    let mut out = BTreeMap::new();
    for (key, value) in parsed.as_object().expect("对象") {
        if key.starts_with('$') {
            continue;
        }
        out.insert(key.clone(), value.as_u64().expect("上限是整数"));
    }
    out
}

#[test]
fn rust_constants_match_the_authoritative_json() {
    let json = read_limits();
    let expected: Vec<(&str, u64)> = vec![
        ("maxPatterns", limits::MAX_PATTERNS as u64),
        ("maxPatternSide", u64::from(limits::MAX_PATTERN_SIDE)),
        ("maxPatternPixels", limits::MAX_PATTERN_PIXELS),
        ("maxCanvasSide", u64::from(limits::MAX_CANVAS_SIDE)),
        ("maxCanvasPixels", limits::MAX_CANVAS_PIXELS),
        ("maxLayers", limits::MAX_LAYERS as u64),
        ("maxProjectBytes", limits::MAX_PROJECT_BYTES as u64),
        ("maxDecompressedResourceBytes", limits::MAX_DECOMPRESSED_RESOURCE_BYTES),
        ("maxEntries", limits::MAX_ENTRIES as u64),
        ("maxDocumentDepth", limits::MAX_DOCUMENT_DEPTH as u64),
        ("maxEntryDecompressedBytes", limits::MAX_ENTRY_DECOMPRESSED_BYTES as u64),
    ];
    for (key, value) in expected {
        assert_eq!(json.get(key), Some(&value), "project-limits.json 的 {key} 与 Rust 常量不一致");
    }
    // 其余字段由 TS 契约核对；这里只保证 JSON 覆盖了这些键。
    for key in [
        "maxSourceAssetIds",
        "maxFeatherSourcePixels",
        "minBrushSizeSourcePixels",
        "maxBrushSizeSourcePixels",
        "maxSerializedBytes",
    ] {
        assert!(json.contains_key(key), "project-limits.json 缺少 {key}");
    }
}
