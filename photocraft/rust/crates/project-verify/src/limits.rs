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

// ---------------------------------------------------------------------------
// 交换与资源预算（change: 2026-10-22-complete-photocraft-webui-editing，任务 1.4）。
//
// 这些上限**不抬高**既有工程预算：它们只约束导入／导出与笔刷库，候选工程仍须满足上面的
// 工程上限。数值与 `rust/project-limits.json` 逐字段一致，由 `tests/limits_agree.rs` 核对。
// ---------------------------------------------------------------------------

/// PSD 原始输入字节上限（64 MiB）。
pub const MAX_PSD_INPUT_BYTES: usize = 67_108_864;
/// 单次 PSD 导出载荷字节上限（64 MiB）。
pub const MAX_PSD_OUTPUT_BYTES: usize = 67_108_864;
/// 跨文档图层载荷（`LayerTransferBundle`）原始字节上限（64 MiB）。
pub const MAX_LAYER_TRANSFER_BYTES: usize = 67_108_864;
/// 跨文档载荷可携带的图层数上限。
pub const MAX_LAYER_TRANSFER_LAYERS: usize = 64;
/// ABR 单文件字节上限（32 MiB）。
pub const MAX_ABR_FILE_BYTES: usize = 33_554_432;
/// 单次 ABR 导入可接受的预设数上限。
pub const MAX_ABR_PRESETS_PER_IMPORT: usize = 256;
/// 笔刷库预设总数上限。
pub const MAX_BRUSH_LIBRARY_PRESETS: usize = 256;
/// 采样笔尖单边像素上限。
pub const MAX_BRUSH_TIP_SIDE: u32 = 1024;
/// 库内采样笔尖与纹理累计像素上限。
pub const MAX_BRUSH_RESOURCE_PIXELS: u64 = 16_777_216;
/// 笔刷资源解码累计字节上限（128 MiB）。
pub const MAX_BRUSH_DECODED_BYTES: u64 = 134_217_728;
/// 参数滤镜半径上限（源像素）。
pub const MAX_FILTER_RADIUS: u32 = 1000;
/// 选区修改半径上限（源像素）。
pub const MAX_SELECTION_RADIUS: u32 = 500;
/// 直方图采样像素上限。
pub const MAX_HISTOGRAM_SAMPLES: u64 = 67_108_864;
/// 工作区同时打开的文档数（含子文档）；运行政策，不写入工程格式。
pub const MAX_OPEN_DOCUMENTS: usize = 8;
/// 已存命名路径数量上限（矢量域；`change: 2026-10-22-add-photocraft-vector-canvas-tools`，任务 3.2）。
pub const MAX_VECTOR_SAVED_PATHS: usize = 256;
/// 单条路径的子路径数量上限。
pub const MAX_VECTOR_SUBPATHS: usize = 4096;
/// 单个子路径的锚点数量上限。
pub const MAX_VECTOR_KNOTS_PER_SUBPATH: usize = 4_096;
/// 一份工程内所有矢量路径（形状、蒙版、工作/已存/裁切）的锚点累计上限：
/// **解码前**按 manifest 计数累计，超限整份拒绝，而不是逐条放过再指望渲染期夹取。
pub const MAX_VECTOR_PATH_POINTS: u64 = 32_768;

/// 按共享预算累加字节：超出返回 `false`，供「后续记录超限则整批拒绝」使用。
pub fn charge_bytes(used: &mut u64, add: u64, limit: u64) -> bool {
    match used.checked_add(add) {
        Some(next) if next <= limit => {
            *used = next;
            true
        }
        _ => false,
    }
}

/// 按共享预算累加像素（笔尖／纹理）：超出返回 `false`。
pub fn charge_pixels(used: &mut u64, add: u64) -> bool {
    charge_bytes(used, add, MAX_BRUSH_RESOURCE_PIXELS)
}
