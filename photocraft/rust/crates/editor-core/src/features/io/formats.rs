//! U05：逐格式矩阵与可编辑打开（change: 2026-10-22-add-photocraft-raster-interchange，design D2）。
//!
//! ## 矩阵来自真实构建
//!
//! 每一行的读写、位深、通道布局、metadata 与 feature 结论都直接取自
//! `photocraft_codecs::caps()`（同一份编译产物），**不**手写第二套声明。因此
//! `pnpm -C photocraft run wasm` 关掉某个 feature 时，矩阵与 UI 会同时变化。
//!
//! ## 打开准入
//!
//! 本域只开放「解码结果是 RGB/U8（或 U8 灰度/带 alpha）」且容器在矩阵里可读的格式：
//! - 已由 U01 打开链覆盖的 PNG/JPEG/WebP 仍走原入口，但矩阵照样列出；
//! - TIFF/GIF/BMP/TGA/ICO/QOI/PNM/PCX/XPM/DDS 在预检通过后直接进入可编辑打开；
//! - 只读格式（PCX/XPM/DDS）明确标注「只读」，不承诺写回；
//! - HDR/高位深（EXR、Radiance HDR）与位深不是 U8 的（Cineon）明确列为暂缓；
//! - FITS/DPX 虽声明 U8 位深，但真实文件多为 16 位/多页/多部分，缺少无损 U8 往返路径，
//!   按「暂缓」给原因而不是偷偷降位深；
//! - AVIF/HEIF 以编译 feature 为准：本构建未编入解码器时保持关闭。
//!
//! 任何不满足准入的输入都返回带原因的拒绝，绝不降位深、不替换当前文档。

use photocraft_codecs::{ChannelLayout, Format, SampleType};
use serde::Serialize;

use super::budgets::budgets;
use crate::error::{EditorError, Result};

/// 打开准入结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenStatus {
    /// 可编辑打开（真实 WASM 解码 + 预检）。
    Open,
    /// 可读取，但本构建不支持写回（只读交换）。
    ReadOnly,
    /// 暂缓：给出具体原因，入口保持关闭。
    Deferred,
}

impl OpenStatus {
    fn label(self) -> &'static str {
        match self {
            OpenStatus::Open => "open",
            OpenStatus::ReadOnly => "read-only",
            OpenStatus::Deferred => "deferred",
        }
    }
}

/// 暂缓原因（与索引无关的稳定字符串）。
fn deferred_reason(format: Format) -> Option<&'static str> {
    match format {
        // 高位深 / HDR：文档模型只有 RGB/U8，自动降位深会丢真实信息。
        Format::OpenExr => Some("HDR/浮点位深（F16/F32）；本 change 不自动降位深"),
        Format::Hdr => Some("Radiance HDR 为浮点线性光；本 change 不自动降位深"),
        Format::Cineon => Some("Cineon 只有 U16 及以上编码；本 change 不自动降位深"),
        // U8 存在但真实文件形态（多页/多部分/校验）缺少无损 U8 路径。
        Format::Fits => Some("FITS 常见 16 位/多 HDU；缺少无损 U8 路径"),
        Format::Dpx => Some("DPX 常见 10/12/16 位；缺少无损 U8 路径"),
        // 特征门控：本构建未编入读取。
        Format::Avif | Format::Heif if !format.caps().read => Some("本构建未编入该解码器（feature 关闭）"),
        _ => None,
    }
}

/// 判断某格式能否进入本域可编辑打开链，以及原因。
pub fn open_status(format: Format) -> (OpenStatus, Option<&'static str>) {
    let caps = format.caps();
    if let Some(reason) = deferred_reason(format) {
        return (OpenStatus::Deferred, Some(reason));
    }
    if !caps.read {
        return (OpenStatus::Deferred, Some("本构建未编入该解码器"));
    }
    // 只接受 U8 样本：真实解码若给出 U16/F32，我们在打开时拒绝而不是降位深。
    if !caps.depths.contains(&SampleType::U8) {
        return (OpenStatus::Deferred, Some("只开放 RGB/U8 解码路径"));
    }
    if caps.write {
        (OpenStatus::Open, None)
    } else {
        (OpenStatus::ReadOnly, Some("只读交换格式；不写回该扩展名"))
    }
}

pub(crate) fn sample_label(sample: SampleType) -> &'static str {
    match sample {
        SampleType::U8 => "u8",
        SampleType::U16 => "u16",
        SampleType::F16 => "f16",
        SampleType::F32 => "f32",
    }
}

pub(crate) fn layout_label(layout: ChannelLayout) -> &'static str {
    match layout {
        ChannelLayout::Gray => "gray",
        ChannelLayout::GrayA => "gray-alpha",
        ChannelLayout::Rgb => "rgb",
        ChannelLayout::Rgba => "rgba",
        ChannelLayout::Cmyk => "cmyk",
        ChannelLayout::CmykA => "cmyk-alpha",
        ChannelLayout::Lab => "lab",
        ChannelLayout::LabA => "lab-alpha",
    }
}

/// 矩阵的一行：容器能力、位深/布局、metadata/feature、打开准入与原因。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRow {
    /// 稳定格式 id（小写，等于首选扩展名）。
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: Vec<&'static str>,
    pub mime: &'static str,
    pub read: bool,
    pub write: bool,
    pub depths: Vec<&'static str>,
    pub layouts: Vec<&'static str>,
    pub alpha: bool,
    pub icc: bool,
    pub exif: bool,
    pub xmp: bool,
    pub dpi: bool,
    pub text: bool,
    pub animation: bool,
    pub lossy: bool,
    /// `open` | `read-only` | `deferred`。
    pub status: &'static str,
    /// 打开准入/暂缓原因（`status = open` 时为 null）。
    pub reason: Option<&'static str>,
    /// 写入是否可作通用导出目标（本构建写 + 不是只读交换格式）。
    pub exportable: bool,
}

/// 本域关心并在矩阵中逐项列出的格式（顺序即 UI 顺序）。
pub const MATRIX_FORMATS: &[Format] = &[
    Format::Png,
    Format::Jpeg,
    Format::Tiff,
    Format::WebP,
    Format::Gif,
    Format::Bmp,
    Format::Tga,
    Format::Ico,
    Format::Qoi,
    Format::Pnm,
    Format::Pcx,
    Format::Xpm,
    Format::Dds,
    Format::Fits,
    Format::Dpx,
    Format::Cineon,
    Format::OpenExr,
    Format::Hdr,
    Format::Avif,
    Format::Heif,
];

fn matrix_row(format: Format) -> MatrixRow {
    let caps = format.caps();
    let (status, reason) = open_status(format);
    MatrixRow {
        id: format.extensions()[0],
        name: format.name(),
        extensions: format.extensions().to_vec(),
        mime: format.mime_type(),
        read: caps.read,
        write: caps.write,
        depths: caps.depths.iter().map(|d| sample_label(*d)).collect(),
        layouts: caps.layouts.iter().map(|l| layout_label(*l)).collect(),
        alpha: caps.alpha,
        icc: caps.icc,
        exif: caps.exif,
        xmp: caps.xmp,
        dpi: caps.dpi,
        text: caps.text,
        animation: caps.animation,
        lossy: caps.lossy,
        status: status.label(),
        reason,
        exportable: caps.write && status != OpenStatus::Deferred,
    }
}

/// 逐格式矩阵（真实构建能力，不手写第二套声明）。
pub fn compatibility_matrix() -> Vec<MatrixRow> {
    MATRIX_FORMATS.iter().copied().map(matrix_row).collect()
}

/// 可编辑打开链接受的扩展名（UI 的 `accept` 与预检共用同一份）。
pub fn openable_extensions() -> Vec<&'static str> {
    MATRIX_FORMATS
        .iter()
        .copied()
        .filter(|f| open_status(*f).0 != OpenStatus::Deferred)
        .flat_map(|f| f.extensions().iter().copied())
        .collect()
}

/// 通用导出的可选格式（本构建可写，且不是只读交换格式）。
pub fn exportable_formats() -> Vec<Format> {
    MATRIX_FORMATS
        .iter()
        .copied()
        .filter(|f| f.caps().write && open_status(*f).0 != OpenStatus::Deferred)
        .collect()
}

/// 扩展名 → 格式（不接受空扩展名与未知扩展名）。
pub fn format_for_extension(extension: &str) -> Option<Format> {
    let extension = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    if extension.is_empty() {
        return None;
    }
    Format::ALL.into_iter().find(|f| f.extensions().contains(&extension.as_str()))
}

/// 预检结论：真实解码结果前先核对容器与准入。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RasterInspection {
    pub format: &'static str,
    pub name: &'static str,
    pub mime: &'static str,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub status: &'static str,
    pub read_only: bool,
    pub animated: bool,
    pub reason: Option<&'static str>,
    /// 文件声明的位深（未解码时为 null）。
    pub depth: Option<&'static str>,
    pub layout: Option<&'static str>,
}

/// 打开前预检：先按签名识别真实格式，再看矩阵准入。
///
/// 伪扩展名（`.tif` 里其实是 PNG）以**签名**为准；未知签名直接拒绝，不猜扩展名。
pub fn inspect_raster(bytes: &[u8]) -> Result<RasterInspection> {
    if bytes.is_empty() {
        return Err(EditorError::ImportFailed("空文件".into()));
    }
    let format = photocraft_codecs::detect(bytes)
        .ok_or_else(|| EditorError::ImportFailed("无法识别的栅格签名（扩展名不作为依据）".into()))?;
    let (status, reason) = open_status(format);
    if status == OpenStatus::Deferred {
        return Err(EditorError::ImportFailed(format!(
            "{} 暂不支持打开：{}",
            format.name(),
            reason.unwrap_or("缺少可用解码路径")
        )));
    }
    let caps = format.caps();
    Ok(RasterInspection {
        format: format.extensions()[0],
        name: format.name(),
        mime: format.mime_type(),
        width: None,
        height: None,
        status: status.label(),
        read_only: status == OpenStatus::ReadOnly,
        animated: caps.animation,
        reason,
        depth: None,
        layout: None,
    })
}

/// 打开预检 + 真实解码，返回可直接进入文档的结论。
///
/// 只解码一次：解码结果同时用于尺寸、位深、布局与后续建文档，避免预检与打开之间出现
/// 「预检说可以、打开却降位深」的两套判断。
pub fn inspect_raster_decoded(bytes: &[u8]) -> Result<(RasterInspection, photocraft_codecs::Image)> {
    let mut inspection = inspect_raster(bytes)?;
    let format = photocraft_codecs::detect(bytes).ok_or_else(|| EditorError::ImportFailed("无法识别的栅格签名".into()))?;
    let limits = open_decode_limits();
    let image = photocraft_codecs::decode_as_with(format, bytes, &photocraft_codecs::DecodeOptions { limits, ..Default::default() })
        .map_err(|e| EditorError::ImportFailed(e.to_string()))?;
    // 不自动降位深：真实样本是 U16/F32 时拒绝并说明。
    if image.sample_type() != SampleType::U8 {
        return Err(EditorError::ImportFailed(format!(
            "{} 的真实位深是 {}；本 change 只开放 RGB/U8，不自动降位深",
            format.name(),
            sample_label(image.sample_type())
        )));
    }
    inspection.width = Some(image.width());
    inspection.height = Some(image.height());
    inspection.depth = Some(sample_label(image.sample_type()));
    inspection.layout = Some(layout_label(image.layout()));
    Ok((inspection, image))
}

/// 本域打开链使用的解码上限（与工程单边/像素预算一致，不抬高）。
pub(crate) fn open_decode_limits() -> photocraft_codecs::Limits {
    let budgets = budgets();
    photocraft_codecs::Limits {
        max_width: budgets.max_export_dimension.min(photocraft_project_verify::MAX_CANVAS_SIDE),
        max_height: budgets.max_export_dimension.min(photocraft_project_verify::MAX_CANVAS_SIDE),
        max_pixels: budgets.max_export_pixels.min(photocraft_project_verify::MAX_CANVAS_PIXELS),
        max_alloc: 256 * 1024 * 1024,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_is_derived_from_the_real_build_and_covers_every_deferred_group() {
        let rows = compatibility_matrix();
        assert_eq!(rows.len(), MATRIX_FORMATS.len());
        assert!(rows.iter().all(|row| row.id == row.extensions[0]));
        // 已接包装的 U8 格式在真实构建里可写。
        let tiff = rows.iter().find(|row| row.id == "tif").expect("TIFF 行");
        assert!(tiff.read && tiff.write && tiff.exportable);
        // 只读交换格式明确只读。
        for id in ["pcx", "xpm", "dds"] {
            let row = rows.iter().find(|row| row.id == id).expect(id);
            assert_eq!(row.status, "read-only", "{id}");
            assert!(!row.exportable, "{id}");
        }
        // 暂缓组逐项有原因，且不进入打开/导出入口。
        for id in ["exr", "hdr", "cin", "fits", "dpx"] {
            let row = rows.iter().find(|row| row.id == id).expect(id);
            assert_eq!(row.status, "deferred", "{id}");
            assert!(row.reason.is_some(), "{id} 必须有暂缓原因");
            assert!(!row.exportable, "{id}");
        }
        assert!(!openable_extensions().contains(&"exr"));
        assert!(openable_extensions().contains(&"tif"));
    }

    #[test]
    fn pseudo_extensions_are_rejected_by_signature_not_by_name() {
        // 真实 PNG 签名：即使调用方说是 TIFF，也按 PNG 判断。
        let png = b"\x89PNG\r\n\x1a\n";
        let inspection = inspect_raster(png).unwrap();
        assert_eq!(inspection.format, "png");
        // 未知签名不猜扩展名。
        assert!(inspect_raster(b"not a raster at all").is_err());
        assert!(inspect_raster(b"").is_err());
        // PNG 头不完整：预检通过、真实解码拒绝（不得把损坏文件当成可打开）。
        assert!(inspect_raster_decoded(png).is_err());
    }

    #[test]
    fn exportable_formats_are_writable_in_this_build() {
        let formats = exportable_formats();
        for format in [Format::Jpeg, Format::WebP, Format::Tiff, Format::Png] {
            assert!(formats.contains(&format), "{} 必须可导出", format.name());
        }
        assert!(formats.iter().all(|format| format.caps().write));
    }
}
