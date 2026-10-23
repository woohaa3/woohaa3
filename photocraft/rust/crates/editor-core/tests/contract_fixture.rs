//! 跨语言语义 fixture 核对（change: 2026-10-21-extract-photocraft-subproject，任务 2.3 / design D2）。
//!
//! 迁移前这里 `include_str!` 读宿主 `web/contracts/src/canvas/*.ts` 源码并做字符串包含断言，
//! 使 Rust 测试依赖宿主目录形状。现在改为读子项目内的**唯一一份**语义 fixture：
//! `photocraft/tests/fixtures/contract.json`，与 TypeScript 协议包的
//! `packages/protocol/src/contract-fixture.test.ts` 指向同一文件。
//!
//! 这样 Rust 与 TS 两侧都不需要读取对方或宿主的源码，隔离副本里也能核对；
//! 而两端仍对同一份语义数据断言，漂移会立刻失败。

use std::path::PathBuf;

fn fixture_path() -> PathBuf {
    // CARGO_MANIFEST_DIR = rust/crates/editor-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/contract.json")
}

fn fixture() -> serde_json::Value {
    let text = std::fs::read_to_string(fixture_path()).expect("读取 tests/fixtures/contract.json");
    serde_json::from_str(&text).expect("解析 contract.json")
}

#[test]
fn upstream_pin_and_engine_version_match_the_shared_fixture() {
    let fixture = fixture();
    assert_eq!(
        fixture["upstreamCommit"].as_str().unwrap(),
        photocraft_embed_editor::UPSTREAM_COMMIT,
        "契约 fixture 的上游提交与内核常量不一致"
    );
    assert_eq!(
        fixture["upstreamVersion"].as_str().unwrap(),
        photocraft_embed_editor::UPSTREAM_VERSION
    );
    assert_eq!(
        fixture["engineVersion"].as_str().unwrap(),
        photocraft_embed_editor::HOST_ENGINE_VERSION,
        "契约 fixture 的引擎版本与内核常量不一致"
    );
    assert_eq!(
        fixture["formatVersion"].as_u64().unwrap(),
        u64::from(photocraft_embed_editor::FORMAT_VERSION)
    );
    assert_eq!(
        fixture["contentType"].as_str().unwrap(),
        photocraft_embed_editor::IMAGE_PROJECT_CONTENT_TYPE
    );
}

#[test]
fn capability_stages_and_non_goals_match_the_shared_fixture() {
    let fixture = fixture();
    let stages: Vec<&str> = fixture["capabilityStages"]
        .as_array()
        .expect("capabilityStages")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert_eq!(stages, photocraft_embed_editor::capability::STAGES);
    let non_goals: Vec<&str> = fixture["nonGoals"]
        .as_array()
        .expect("nonGoals")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert_eq!(non_goals, photocraft_embed_editor::capability::NON_GOALS);
    let capabilities: Vec<&str> = fixture["capabilities"]
        .as_array()
        .expect("capabilities")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert_eq!(
        capabilities,
        photocraft_embed_editor::capability::delivered_capabilities()
    );
    // 已交付阶段 = fixture 的阶段清单（本 change 全阶段交付）。
    assert_eq!(
        photocraft_embed_editor::capability::DELIVERED_STAGES,
        stages.as_slice()
    );
}

#[test]
fn build_info_reports_the_fixture_values_on_the_wire() {    let fixture = fixture();
    let wire = serde_json::to_value(photocraft_embed_editor::build_info()).unwrap();
    assert_eq!(wire["engineVersion"], fixture["engineVersion"]);
    assert_eq!(wire["upstreamCommit"], fixture["upstreamCommit"]);
    assert_eq!(wire["upstreamVersion"], fixture["upstreamVersion"]);
    assert_eq!(wire["formatVersion"], fixture["formatVersion"]);
}

/// 排版内容的跨语言基线（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
///
/// 这一条覆盖本 change 新增的内容面：逐字符 run、段落选项、OpenType、Warp、抗锯齿、样式表引用。
/// TS 侧同名断言在 `packages/protocol/src/contract-fixture.test.ts`，两边读同一份 fixture，
/// 任何一侧少写一个字段都会立刻失败——宿主与内核「是否净变化」的结论因此不会分叉。
#[test]
fn typography_content_reproduces_the_cross_language_baseline() {
    let fixture = fixture();
    let hashes = &fixture["contentHashes"];
    let content = &hashes["typographyContent"];
    let canonical = photocraft_embed_editor::identity::canonicalize(content)
        .expect("排版基线内容必须可规范化");
    assert_eq!(
        canonical,
        hashes["typographyCanonical"].as_str().unwrap(),
        "排版内容的规范文本与 TS 侧不一致"
    );
    assert_eq!(
        photocraft_embed_editor::identity::content_hash(content).unwrap(),
        hashes["typographyHash"].as_str().unwrap(),
        "排版内容的指纹与 TS 侧不一致"
    );
}

#[test]
fn typography_runs_and_style_table_reproduce_the_cross_language_baseline() {
    let fixture = fixture();
    let hashes = &fixture["contentHashes"];
    let content = &hashes["typographyRunsContent"];
    let canonical = photocraft_embed_editor::identity::canonicalize(content)
        .expect("逐 run 基线内容必须可规范化");
    assert_eq!(
        canonical,
        hashes["typographyRunsCanonical"].as_str().unwrap(),
        "逐 run 摘要的规范文本与 TS 侧不一致"
    );
    assert_eq!(
        photocraft_embed_editor::identity::content_hash(content).unwrap(),
        hashes["typographyRunsHash"].as_str().unwrap(),
        "逐 run 摘要的指纹与 TS 侧不一致"
    );
}

#[test]
fn bundled_fonts_and_licenses_are_declared() {
    assert!(
        photocraft_embed_editor::BUNDLED_FONTS
            .iter()
            .any(|f| f.ends_with("NotoSansSC-Regular.otf"))
    );
    assert!(
        photocraft_embed_editor::BUNDLED_LICENSES
            .iter()
            .any(|f| f.ends_with("LICENSE-MIT"))
    );
    // 字体与许可必须真的在子项目内，且可从校验收缩到 assets/fonts。
    let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../assets/fonts");
    assert!(
        assets.join("NotoSansSC-Regular.otf").is_file(),
        "缺少随包中文字体 photocraft/assets/fonts/NotoSansSC-Regular.otf"
    );
    assert!(
        assets.join("OFL-NotoSansSC.txt").is_file(),
        "缺少随包字体许可 photocraft/assets/fonts/OFL-NotoSansSC.txt"
    );
}

/// 矢量路径内容身份的跨语言固定值（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
///
/// 已存命名路径 / 工作路径 / 裁切路径是持久字段：TS 协议包与 Rust 内核必须得到同一规范文本与
/// 同一指纹，否则宿主「是否净变化」会两端不一致（例如只改一条路径被判成无变化而丢工作）。
#[test]
fn vector_path_content_identity_matches_the_shared_fixture() {
    let fixture = fixture();
    let mut content = serde_json::json!({
        "canvasWidth": 800,
        "canvasHeight": 600,
        "layers": [{
            "id": "background", "name": "背景", "kind": "pixel", "visible": true,
            "opacity": 1, "blend": "normal",
            "transform": {
                "translateX": 0, "translateY": 0, "scale": 1,
                "rotationDegrees": 0, "flipHorizontal": false, "flipVertical": false
            },
            "mask": null,
            "pixel": { "sourceAssetId": "asset-base", "contentHash": "0123456789abcdef" },
            "text": null, "adjustment": null
        }]
    });
    // 旧工程（无路径字段）保持原指纹。
    assert_eq!(
        photocraft_embed_editor::identity::canonicalize(&content).as_deref(),
        fixture["contentHashes"]["projectContentCanonical"].as_str()
    );
    content["paths"] = serde_json::json!([
        { "name": "中文", "contentHash": "1111111111111111" },
        { "name": "A", "contentHash": "2222222222222222" }
    ]);
    content["workPath"] = serde_json::json!({ "contentHash": "3333333333333333" });
    content["clippingPath"] = serde_json::json!({ "name": "A", "flatness": 2.5 });
    assert_eq!(
        photocraft_embed_editor::identity::canonicalize(&content).as_deref(),
        fixture["contentHashes"]["vectorPathCanonical"].as_str()
    );
    assert_eq!(
        photocraft_embed_editor::identity::content_hash(&content).as_deref(),
        fixture["contentHashes"]["vectorPathHash"].as_str()
    );
}

/// 形状外观（填充/描边/规范参数）与矢量蒙版密度/羽化也进入内容身份，且两端逐字节一致。
///
/// 这些字段是持久内容（保存重开逐字段还原），但此前只把路径几何算进指纹：只改描边或
/// 填充会被宿主判成「无净变化」而丢工作
/// （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
#[test]
fn shape_appearance_and_mask_appearance_match_the_shared_fixture() {
    let fixture = fixture();
    let background = serde_json::json!({
        "id": "background", "name": "背景", "kind": "pixel", "visible": true,
        "opacity": 1, "blend": "normal",
        "transform": {
            "translateX": 0, "translateY": 0, "scale": 1,
            "rotationDegrees": 0, "flipHorizontal": false, "flipVertical": false
        },
        "mask": null,
        "pixel": { "sourceAssetId": "asset-base", "contentHash": "0123456789abcdef" },
        "text": null, "adjustment": null
    });
    let mut with_shape = serde_json::json!({
        "canvasWidth": 800,
        "canvasHeight": 600,
        "layers": [background.clone(), {
            "id": "layer-2", "name": "形状", "kind": "shape", "visible": true,
            "opacity": 1, "blend": "normal",
            "transform": {
                "translateX": 0, "translateY": 0, "scale": 1,
                "rotationDegrees": 0, "flipHorizontal": false, "flipVertical": false
            },
            "mask": null,
            "pixel": null, "text": null, "adjustment": null,
            "shape": { "contentHash": "4444444444444444", "appearanceHash": "5555555555555555" }
        }]
    });
    assert_eq!(
        photocraft_embed_editor::identity::canonicalize(&with_shape).as_deref(),
        fixture["contentHashes"]["shapeAppearanceCanonical"].as_str()
    );
    assert_eq!(
        photocraft_embed_editor::identity::content_hash(&with_shape).as_deref(),
        fixture["contentHashes"]["shapeAppearanceHash"].as_str()
    );
    // 省略外观摘要只按几何比较：旧内容描述的指纹逐字节不变。
    with_shape["layers"][1]["shape"] = serde_json::json!({ "contentHash": "4444444444444444" });
    assert_ne!(
        photocraft_embed_editor::identity::content_hash(&with_shape).as_deref(),
        fixture["contentHashes"]["shapeAppearanceHash"].as_str()
    );

    let mut with_mask = serde_json::json!({
        "canvasWidth": 800,
        "canvasHeight": 600,
        "layers": [background]
    });
    with_mask["layers"][0]["vectorMask"] = serde_json::json!({
        "enabled": true, "contentHash": "6666666666666666", "density": 0.4, "feather": 6
    });
    assert_eq!(
        photocraft_embed_editor::identity::canonicalize(&with_mask).as_deref(),
        fixture["contentHashes"]["maskDensityCanonical"].as_str()
    );
    assert_eq!(
        photocraft_embed_editor::identity::content_hash(&with_mask).as_deref(),
        fixture["contentHashes"]["maskDensityHash"].as_str()
    );
    // 越界密度/羽化是非法内容，不能靠渲染期夹取。
    with_mask["layers"][0]["vectorMask"]["density"] = serde_json::json!(1.5);
    assert!(photocraft_embed_editor::identity::canonicalize(&with_mask).is_none());
    with_mask["layers"][0]["vectorMask"]["density"] = serde_json::json!(0.4);
    with_mask["layers"][0]["vectorMask"]["feather"] = serde_json::json!(1001);
    assert!(photocraft_embed_editor::identity::canonicalize(&with_mask).is_none());
}
