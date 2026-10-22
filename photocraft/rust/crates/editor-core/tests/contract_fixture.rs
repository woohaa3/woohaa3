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
fn build_info_reports_the_fixture_values_on_the_wire() {
    let fixture = fixture();
    let wire = serde_json::to_value(photocraft_embed_editor::build_info()).unwrap();
    assert_eq!(wire["engineVersion"], fixture["engineVersion"]);
    assert_eq!(wire["upstreamCommit"], fixture["upstreamCommit"]);
    assert_eq!(wire["upstreamVersion"], fixture["upstreamVersion"]);
    assert_eq!(wire["formatVersion"], fixture["formatVersion"]);
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
