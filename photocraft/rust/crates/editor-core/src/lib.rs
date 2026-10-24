//! WooHaa3 React 图像编辑器的编辑内核
//! （change: 2026-10-16-integrate-photocraft-image-editing，design D1/D3/D8）。
//!
//! 这里**只有功能，没有界面**：本 crate 不依赖 egui、eframe、wgpu 或任何宿主 UI，React 前端
//! 通过 wasm-bindgen 直接调用它。上游 `web/vendor/photocraft` 以路径依赖引用，源码与
//! `Cargo.lock` 保持只读可核对。
//!
//! 组成：
//! - [`editor`]：字节 + JSON 的编辑会话（打开/置入/保存/预览/命令分派）；
//! - [`error`]：稳定错误码；
//! - [`capability`]：首期能力清单（菜单、工具栏与命令入口共用同一份）；
//! - [`identity`]、[`document_content`]：与 `web/contracts` 逐字节一致的内容指纹；
//! - [`wasm`]（仅 wasm32）：wasm-bindgen 绑定。

pub mod capability;
pub mod document_content;
pub mod editor;
pub mod error;
pub mod identity;
mod selection_outline;
mod transform_preview;
mod layer_preview;
mod mask_commands;
mod text_preview;
mod text_commands;
mod text_find_replace;
mod text_spelling;
mod text_antialias;
mod text_orientation;
mod edge_stroke;
mod rasterize_commands;
mod flatten_masks_commands;
mod text_geometry;
mod font_preview;
mod adjustment_preview;
mod layer_properties_preview;
mod preview_history;
mod reorder_preview;
pub mod export_request;
mod brush_prefs_check;
mod layer_locks;
mod new_layer_options;
mod layer_layout;
mod layer_selection_commands;
mod layer_cleanup_commands;
mod layer_composite_commands;
mod image_geometry_commands;
mod image_extent_commands;
mod clipping_commands;
mod retouch_params;
mod adjust_params_check;
mod fill_commands;
mod general_fill;
mod clipboard_commands;
mod region_preview;
mod group_commands;
mod smart_identity;
pub mod smart_source_edit;
mod smart_source_render;
pub mod smart_copy;
mod smart_transform;
pub mod smart_convert;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use editor::{Editor, Preview};
pub use error::{EditorError, Result};

/// 本集成固定的上游提交（design D1；来源清单见 `web/vendor/photocraft/SOURCE.md`）。
pub const UPSTREAM_COMMIT: &str = "4e7a17cd5d5723313f459753663d0d155f047e19";

/// 上游应用版本（`web/vendor/photocraft/Cargo.toml` 的 workspace 版本）。
pub const UPSTREAM_VERSION: &str = "0.9.0";

/// 宿主能力版本；与 contracts 的当前写入版本一致，不等同于上游来源提交。
pub const HOST_ENGINE_VERSION: &str = "4e7a17cd5d5723313f459753663d0d155f047e19+woohaa-resolution-v1";

/// 上游 `.pcraft` 格式版本（`photocraft_format::FORMAT_VERSION`）。
pub const FORMAT_VERSION: u32 = 1;

/// 工程媒体类型（只在受控工程上传/读取链路使用）。
pub const IMAGE_PROJECT_CONTENT_TYPE: &str = "application/vnd.woohaa.photocraft-project";

/// 随包字体（固定、获许可的拉丁/中文字体；不依赖操作系统字体）。
pub const BUNDLED_FONTS: &[&str] = &[
    "fonts/Inter-Regular.ttf",
    "fonts/Inter-Medium.ttf",
    "fonts/Inter-SemiBold.ttf",
    "fonts/JetBrainsMono-Regular.ttf",
    "fonts/NotoSansSC-Regular.otf",
];

/// 随包许可文件。
pub const BUNDLED_LICENSES: &[&str] = &[
    "licenses/LICENSE-MIT",
    "licenses/LICENSE-APACHE",
    "licenses/ATTRIBUTION.md",
    "licenses/OFL-Inter.txt",
    "licenses/OFL-JetBrainsMono.txt",
    "fonts/OFL-NotoSansSC.txt",
];

/// build-info：宿主用它核对产物与自己的契约。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedBuildInfo {
    pub upstream_commit: String,
    pub upstream_version: String,
    pub engine_version: String,
    pub format_version: u32,
}

/// 当前构建的 build-info。
pub fn build_info() -> EmbedBuildInfo {
    EmbedBuildInfo {
        upstream_commit: UPSTREAM_COMMIT.into(),
        upstream_version: UPSTREAM_VERSION.into(),
        engine_version: HOST_ENGINE_VERSION.into(),
        format_version: FORMAT_VERSION,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_info_matches_the_fixed_source_pin() {
        let info = build_info();
        assert_eq!(info.upstream_commit, UPSTREAM_COMMIT);
        assert_eq!(info.engine_version, HOST_ENGINE_VERSION);
        assert_eq!(info.format_version, FORMAT_VERSION);
        assert_eq!(info.format_version, photocraft_format::FORMAT_VERSION);
    }

    #[test]
    fn build_info_matches_the_shared_contract_fixture() {
        // 迁移前此处 include_str! 读取宿主 `web/contracts/src/canvas/*.ts` 源码并做字符串
        // 包含断言，使内核测试依赖宿主目录形状（change: 2026-10-21-extract-photocraft-subproject，
        // 任务 2.3）。现在内核只核对自身常量自洽；与 TypeScript 协议的逐字段比较由
        // `tests/contract_fixture.rs` 读 `tests/fixtures/contract.json` 完成 —— 两侧都不再读对方源码。
        let wire = serde_json::to_value(build_info()).unwrap();
        assert_eq!(wire["engineVersion"], HOST_ENGINE_VERSION);
        assert_eq!(wire["upstreamCommit"], UPSTREAM_COMMIT);
        assert_eq!(wire["upstreamVersion"], UPSTREAM_VERSION);
        assert_eq!(wire["formatVersion"], photocraft_format::FORMAT_VERSION);
    }

    #[test]
    fn bundled_fonts_and_licenses_are_declared() {
        assert!(BUNDLED_FONTS.iter().any(|f| f.ends_with("NotoSansSC-Regular.otf")));
        assert!(BUNDLED_LICENSES.iter().any(|f| f.ends_with("LICENSE-MIT")));
    }
}

mod contour_presets;
pub mod pattern_presets;
mod pattern_library;

mod bucket_command;

mod painting_symmetry;

mod document_status;

mod history_commands;
mod history_follow;
