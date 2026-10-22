//! 首期图片工程上限（与 `photocraft/rust/project-limits.json` 一致）。
//!
//! 这些常量是 notes/scope.md「首期资源上限」的 Rust 副本；`tests/limits_agree.rs` 逐字段核对
//! JSON，避免两端漂移（change: 2026-10-16-integrate-photocraft-image-editing，任务 1.1/2.3）。

/// 单个编辑画布/置入图单边上限。
pub const MAX_CANVAS_SIDE: u32 = 8192;
/// 画布/置入图像素总量上限。
pub const MAX_CANVAS_PIXELS: u64 = 67_108_864;
/// 文档层数上限（含背景、文字与调整层）。
pub const MAX_LAYERS: usize = 64;
/// 单工程压缩字节上限（64 MiB）。
pub const MAX_PROJECT_BYTES: usize = 67_108_864;
/// 工程解压后资源字节上限（256 MiB）。
pub const MAX_DECOMPRESSED_RESOURCE_BYTES: u64 = 268_435_456;
/// 工程结构条目上限。
pub const MAX_ENTRIES: usize = 4096;
/// 文档层级上限。
pub const MAX_DOCUMENT_DEPTH: usize = 16;
/// 单条目解压后字节上限（128 MiB）。
pub const MAX_ENTRY_DECOMPRESSED_BYTES: usize = 134_217_728;

/// 桥协议 id（宿主与编辑器共用；见 contracts `PHOTOCRAFT_BRIDGE_PROTOCOL_VERSION`）。
pub const BRIDGE_PROTOCOL_VERSION: &str = "woohaa-photocraft-embed-v1";
/// 工程媒体类型（只在受控工程上传/读取链路使用）。
pub const IMAGE_PROJECT_CONTENT_TYPE: &str = "application/vnd.woohaa.photocraft-project";
/// 受支持的 `.pcraft` 格式版本（上游 `photocraft_format::FORMAT_VERSION`）。
pub const SUPPORTED_FORMAT_VERSIONS: &[u32] = &[1];
/// 本集成固定的上游提交（产物 manifest 与工程定义核对）。
pub const UPSTREAM_COMMIT: &str = "4e7a17cd5d5723313f459753663d0d155f047e19";

/// 图案资源数量、单边与所有图案累计像素上限。
pub const MAX_PATTERNS: usize = 64;
pub const MAX_PATTERN_SIDE: u32 = 1024;
pub const MAX_PATTERN_PIXELS: u64 = 4_194_304;
