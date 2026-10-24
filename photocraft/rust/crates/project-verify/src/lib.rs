//! 无 UI 的 `.pcraft` 工程核验
//! （change: 2026-10-16-integrate-photocraft-image-editing，任务 1.2/2.3 / design D5）。
//!
//! 与编辑器**共用同一固定文档解析实现**（`photocraft-format` 的 `store::load`），只收紧
//! `LoadOptions` 并追加首期能力检查。因此这里没有第二套 ZIP/manifest 解析器：
//! - 结构/解压上限由上游解析器执行（条目、清单、blob、tile、总量、画布）；
//! - 首期能力（对象类型、调整类型、外链、分组）由本 crate 检查；
//! - 补一层 ZIP 条目名检查（穿越、绝对路径、反斜杠）。
//!
//! 关键约束：
//! - 只读内存字节，不落盘、不访问网络、不执行工程内任何内容；
//! - 对任意输入返回 `Err`，绝不 panic（调用方按稳定 code 判定）；
//! - 不链接 UI（本 crate 只依赖 `photocraft-format`，不依赖 `ui-egui`/`egui`/`eframe`）。

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod limits;
pub mod blend_modes;
pub mod style_support;
pub mod pattern_support;
pub mod smart_source;

pub use limits::{
    BRIDGE_PROTOCOL_VERSION, IMAGE_PROJECT_CONTENT_TYPE, MAX_CANVAS_PIXELS, MAX_CANVAS_SIDE,
    MAX_DECOMPRESSED_RESOURCE_BYTES, MAX_DOCUMENT_DEPTH, MAX_ENTRIES, MAX_ENTRY_DECOMPRESSED_BYTES,
    MAX_LAYERS, MAX_PROJECT_BYTES, SUPPORTED_FORMAT_VERSIONS, UPSTREAM_COMMIT,
};

use photocraft_doc::{Adjustment, LayerContent};
use photocraft_format::{LoadOptions, zip::ZipReader};
use serde::Serialize;

/// 稳定核验失败原因（与 TS `ProjectVerificationErrorCode` 同族；跨进程按字符串判定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerifyErrorCode {
    Empty,
    CompressedTooLarge,
    NotAZip,
    CorruptContainer,
    TooManyEntries,
    EntryTooLarge,
    DecompressedTooLarge,
    PathTraversal,
    InvalidManifest,
    UnsupportedFormatVersion,
    CanvasTooLarge,
    TooManyLayers,
    TooDeep,
    UnsupportedObject,
    ExternalReference,
    MissingResource,
}

/// 核验失败（稳定 code + 原因）。
#[derive(Debug, Clone, Serialize)]
pub struct VerifyError {
    pub code: VerifyErrorCode,
    pub message: String,
}

/// 核验通过后的安全摘要（不含文档内容与像素）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub format_version: u32,
    pub generator: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub layer_count: usize,
    pub depth: usize,
    pub entry_count: usize,
    pub decompressed_bytes: u64,
    pub object_kinds: Vec<String>,
    pub bridge_protocol: &'static str,
    pub upstream_commit: &'static str,
    pub supported_format_versions: &'static [u32],
}

/// 有界核验一份工程字节。失败返回稳定 code。
pub fn verify(bytes: &[u8]) -> Result<ProjectSummary, VerifyError> {
    verify_container(bytes,false).map(|(summary,_)|summary)
}
/// 仅供本机图案库：复用有界资源核验，要求 1×1、无图层的资源容器。
/// 工程上传与 CLI 继续使用 verify，不能接受无图层工程。
pub fn load_pattern_library(bytes:&[u8])->Result<photocraft_doc::Document,VerifyError> {
    verify_container(bytes,true).map(|(_,document)|document)
}
fn verify_container(bytes:&[u8],pattern_library:bool)->Result<(ProjectSummary,photocraft_doc::Document),VerifyError> {
    verify_container_with(bytes,pattern_library,None)
}
fn verify_container_with(bytes:&[u8],pattern_library:bool,source_scope:Option<smart_source::Scope<'_>>)->Result<(ProjectSummary,photocraft_doc::Document),VerifyError> {
    if bytes.is_empty() {
        return Err(err(VerifyErrorCode::Empty, "工程内容为空"));
    }
    if bytes.len() > limits::MAX_PROJECT_BYTES {
        return Err(err(
            VerifyErrorCode::CompressedTooLarge,
            format!("工程压缩字节超过上限：{} > {}", bytes.len(), limits::MAX_PROJECT_BYTES),
        ));
    }
    let archive = ZipReader::new(bytes).map_err(|_| err(VerifyErrorCode::NotAZip, "工程不是合法的 ZIP 容器"))?;
    if archive.entries.len() > limits::MAX_ENTRIES {
        return Err(err(
            VerifyErrorCode::TooManyEntries,
            format!("工程条目超过上限：{} > {}", archive.entries.len(), limits::MAX_ENTRIES),
        ));
    }
    for entry in &archive.entries {
        assert_safe_entry_name(&entry.name)?;
    }
    if let Some(scope)=source_scope {scope.admit_archive(archive.entries.len())?;}
    // 有界读取每个条目（上游 `read` 已做 CRC/方法/单条目上限检查），据此报告解压总量。
    let mut decompressed_bytes: u64 = 0;
    for entry in &archive.entries {
        let max_read=source_scope.map_or(limits::MAX_ENTRY_DECOMPRESSED_BYTES,|scope|scope.archive_allowance());
        let data = archive
            .read(entry, max_read)
            .map_err(|error| {
                let code=if max_read<limits::MAX_ENTRY_DECOMPRESSED_BYTES && matches!(error,photocraft_format::FormatError::LimitExceeded(_)) {VerifyErrorCode::DecompressedTooLarge} else {VerifyErrorCode::EntryTooLarge};
                err(code, format!("工程条目无法在剩余预算内读取：{}", entry.name))
            })?;
        if let Some(scope)=source_scope {scope.account_archive(data.len() as u64)?;}
        decompressed_bytes = decompressed_bytes.saturating_add(data.len() as u64);
        if decompressed_bytes > limits::MAX_DECOMPRESSED_RESOURCE_BYTES {
            return Err(err(
                VerifyErrorCode::DecompressedTooLarge,
                format!("工程解压总量超过上限：{}", limits::MAX_DECOMPRESSED_RESOURCE_BYTES),
            ));
        }
    }
    // 先核验 manifest 中的图案资源，避免尺寸或稀疏坐标超限后才分配 tile。
    let manifest_entry=archive.entries.iter().find(|entry|entry.name=="manifest.json")
        .ok_or_else(||err(VerifyErrorCode::InvalidManifest,"工程缺少 manifest.json"))?;
    archive.read(manifest_entry,16 << 20).map_err(|_|err(VerifyErrorCode::InvalidManifest,"工程清单超限或损坏"))?;
    let manifest=photocraft_format::read_manifest(bytes).map_err(map_load_error)?;
    if !limits::SUPPORTED_FORMAT_VERSIONS.contains(&manifest.format_version) {
        return Err(err(VerifyErrorCode::UnsupportedFormatVersion,format!("工程格式版本不受支持：{}",manifest.format_version)));
    }
    if source_scope.is_some() && (manifest.document.mode!=photocraft_doc::ColorMode::Rgb || manifest.document.depth!=photocraft_doc::SampleType::U8) {
        return Err(err(VerifyErrorCode::UnsupportedObject,"智能对象源仅支持 RGB/U8 原生工程"));
    }
    if !manifest.document.resolution_dpi.is_finite() || !(1.0..=10000.0).contains(&manifest.document.resolution_dpi) {return Err(err(VerifyErrorCode::UnsupportedObject,"工程分辨率须为 1–10000 DPI"));}
    if !pattern_support::supported_manifest(&manifest.document.patterns) {
        return Err(err(VerifyErrorCode::UnsupportedObject,"工程图案资源超限或格式不受支持"));
    }
    if pattern_library && (!manifest.document.layers.is_empty() || manifest.document.size!=photocraft_doc::Size::new(1,1)) {
        return Err(err(VerifyErrorCode::InvalidManifest,"本机图案库须为 1×1、无图层的资源容器"));
    }
    if let Some(scope)=source_scope {scope.admit_manifest(&manifest.document.layers)?;}
    // 与编辑器共享同一解析实现；上限收紧到首期范围。
    let options = LoadOptions {
        max_manifest_bytes: 16 << 20,
        max_blob_bytes: limits::MAX_ENTRY_DECOMPRESSED_BYTES,
        max_total_bytes: limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
        preserve_ids: true,
        max_canvas_side: limits::MAX_CANVAS_SIDE,
        max_canvas_pixels: limits::MAX_CANVAS_PIXELS,
    };
    let document = if let Some(scope)=source_scope {
        scope.load_document(&archive,&options)?
    } else {photocraft_format::load_from_bytes_with(bytes, &options).map_err(map_load_error)?};
    let canvas_width = document.size.width;
    let canvas_height = document.size.height;
    if canvas_width == 0 || canvas_height == 0 {
        return Err(err(VerifyErrorCode::InvalidManifest, "工程画布尺寸非法"));
    }
    if canvas_width > limits::MAX_CANVAS_SIDE || canvas_height > limits::MAX_CANVAS_SIDE {
        return Err(err(
            VerifyErrorCode::CanvasTooLarge,
            format!("工程画布单边超过上限：{canvas_width}x{canvas_height}"),
        ));
    }
    if u64::from(canvas_width) * u64::from(canvas_height) > limits::MAX_CANVAS_PIXELS {
        return Err(err(
            VerifyErrorCode::CanvasTooLarge,
            format!("工程画布像素超过上限：{canvas_width}x{canvas_height}"),
        ));
    }
    if !pattern_library && document.layers.is_empty() {
        return Err(err(VerifyErrorCode::InvalidManifest, "工程缺少图层"));
    }
    let mut inspection = LayerInspection::default();
    inspect_layers(&document.layers, source_scope.map_or(1,|s|s.depth), &mut inspection,source_scope.is_some())?;
    if let Some(scope)=source_scope {scope.inspect_document(&document)?;}
    if inspection.count > limits::MAX_LAYERS {
        return Err(err(
            VerifyErrorCode::TooManyLayers,
            format!("工程层数超过上限：{} > {}", inspection.count, limits::MAX_LAYERS),
        ));
    }
    if inspection.depth > limits::MAX_DOCUMENT_DEPTH {
        return Err(err(
            VerifyErrorCode::TooDeep,
            format!("工程文档层级超过上限：{} > {}", inspection.depth, limits::MAX_DOCUMENT_DEPTH),
        ));
    }
    if !style_support::supported_document(&document) {
        return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含未开放或超限的图层样式"));
    }
    let mut object_kinds: Vec<String> = inspection.kinds.iter().cloned().collect();
    object_kinds.sort();
    Ok((ProjectSummary {
        format_version: manifest.format_version,
        generator: manifest.generator.chars().take(200).collect(),
        canvas_width,
        canvas_height,
        layer_count: inspection.count,
        depth: inspection.depth,
        entry_count: archive.entries.len(),
        decompressed_bytes,
        object_kinds,
        bridge_protocol: limits::BRIDGE_PROTOCOL_VERSION,
        upstream_commit: limits::UPSTREAM_COMMIT,
        supported_format_versions: limits::SUPPORTED_FORMAT_VERSIONS,
    },document))
}

#[derive(Default)]
struct LayerInspection {
    count: usize,
    depth: usize,
    kinds: std::collections::BTreeSet<String>,
}

fn inspect_layers(
    layers: &[photocraft_doc::Layer],
    depth: usize,
    out: &mut LayerInspection,
    embedded_smart:bool,
) -> Result<(), VerifyError> {
    if depth > limits::MAX_DOCUMENT_DEPTH {
        return Err(err(VerifyErrorCode::TooDeep, "工程文档层级超过上限"));
    }
    out.depth = out.depth.max(depth);
    for layer in layers {
        if !layer.fill_opacity.is_finite() || !(0.0..=1.0).contains(&layer.fill_opacity) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "工程填充不透明度无效"));
        }
        if blend_modes::canonical_blend_name(layer.blend).is_none()
            || (layer.blend == photocraft_doc::BlendMode::PassThrough && !layer.is_group()) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含未开放的混合模式"));
        }
        out.count += 1;
        if out.count > limits::MAX_LAYERS {
            return Err(err(
                VerifyErrorCode::TooManyLayers,
                format!("工程层数超过上限：{}", limits::MAX_LAYERS),
            ));
        }
        if layer.link_group.is_some_and(|group|group==0 || group>9_007_199_254_740_991) {return Err(err(VerifyErrorCode::UnsupportedObject,"链接组编号必须为安全正整数"));}
        if let Some(mask)=&layer.mask {
            if !mask.density.is_finite() || !(0.0..=1.0).contains(&mask.density) || !mask.feather.is_finite() || !(0.0..=1000.0).contains(&mask.feather) {return Err(err(VerifyErrorCode::UnsupportedObject,"蒙版密度或羽化超出范围"));}
        }
        if layer.mask.is_some() || layer.vector_mask.is_some() {
            // 蒙版本身是首期能力；但矢量蒙版不在首期范围。
            if layer.vector_mask.is_some() {
                return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含矢量路径"));
            }
        }
        match &layer.content {
            LayerContent::Raster(_) => {
                out.kinds.insert("raster".into());
            }
            LayerContent::Text(_) => {
                out.kinds.insert("text".into());
            }
            LayerContent::Adjustment(adjustment) => {
                out.kinds.insert("adjustment".into());
                inspect_adjustment(adjustment)?;
            }
            LayerContent::Group(group) => {
                if group.artboard.is_some() {
                    return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含画板"));
                }
                out.kinds.insert("group".into());
                if !group.children.is_empty() {
                    inspect_layers(&group.children, depth + 1, out,embedded_smart)?;
                }
            }
            LayerContent::Fill(_) => {
                return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含填充图层"));
            }
            LayerContent::Shape(_) => {
                return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含矢量形状层"));
            }
            LayerContent::Smart(smart) => {
                let _ = smart;
                if !embedded_smart {return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含智能对象"));}
                out.kinds.insert("smart".into());
            }
        }
    }
    Ok(())
}

fn inspect_adjustment(adjustment: &Adjustment) -> Result<(), VerifyError> {
    match adjustment {
        Adjustment::BrightnessContrast { .. } | Adjustment::HueSaturation { .. } | Adjustment::Curves { .. } => Ok(()),
        _ => Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("工程包含首期未开放的调整类型：{}", adjustment.label()),
        )),
    }
}

fn assert_safe_entry_name(name: &str) -> Result<(), VerifyError> {
    if name.is_empty() || name.len() > 1024 {
        return Err(err(VerifyErrorCode::CorruptContainer, "工程条目名非法"));
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return Err(err(VerifyErrorCode::PathTraversal, format!("工程条目使用绝对路径：{name}")));
    }
    if name.len() >= 2
        && name.as_bytes().get(1) == Some(&b':')
        && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
    {
        return Err(err(VerifyErrorCode::PathTraversal, format!("工程条目使用盘符路径：{name}")));
    }
    if name.contains('\\') {
        return Err(err(VerifyErrorCode::PathTraversal, format!("工程条目包含反斜杠路径：{name}")));
    }
    if name.split('/').any(|segment| segment == "..") {
        return Err(err(VerifyErrorCode::PathTraversal, format!("工程条目包含路径穿越：{name}")));
    }
    Ok(())
}

fn map_load_error(error: photocraft_format::FormatError) -> VerifyError {
    use photocraft_format::FormatError;
    match error {
        FormatError::TooNew { found, supported } => err(
            VerifyErrorCode::UnsupportedFormatVersion,
            format!("工程格式版本过新：{found}（本构建最高 {supported}）"),
        ),
        FormatError::Unsupported(message) => err(VerifyErrorCode::UnsupportedObject, message),
        FormatError::LimitExceeded(message) => err(VerifyErrorCode::CanvasTooLarge, message),
        FormatError::Corrupt(message) => {
            if message.contains("missing") {
                err(VerifyErrorCode::MissingResource, message)
            } else {
                err(VerifyErrorCode::CorruptContainer, message)
            }
        }
        other => err(VerifyErrorCode::InvalidManifest, other.to_string()),
    }
}

fn err(code: VerifyErrorCode, message: impl Into<String>) -> VerifyError {
    VerifyError { code, message: message.into() }
}
