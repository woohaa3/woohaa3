//! U06：通用导出与 Save for Web（change: 2026-10-22-add-photocraft-raster-interchange，design D2/D3）。
//!
//! ## 一次编码，预览与交付同源
//!
//! [`encode_export`] 是**唯一**编码入口：预览与最终交付都用它，并且都在同一个同步调用里取
//! 文档快照（修订号 + 内容指纹），因此不存在「预览是一份设置、交付是另一份」的可能。预览返回
//! 的就是真实编码出的字节（不是估算图），调用方直接把它当图片显示。
//!
//! ## 两条真实路径
//!
//! - `mode = "export"`：逐格式通用导出，走上游 `photocraft_io::export`，支持 JPEG/WebP/TIFF/
//!   PNG（以及本构建可写的其他 U8 格式），参数映射到 `EncodeOptions`。
//! - `mode = "web"`：Save for Web，走上游 `engine::web_cmds` 的真实量化/调色板/抖动/交错编码，
//!   支持 GIF、PNG-8、PNG-24、JPEG。
//!
//! ## 拒绝而不是降级
//!
//! - 目标格式不可写或属于只读交换格式：拒绝；
//! - 请求透明但目标格式无 alpha：拒绝并给出可选格式（不静默合成到白底）；
//! - 尺寸/百分比越出本域预算：拒绝；不自动降位深、不改动文档；
//! - 导出**不**推进工程保存基线、不产生历史、不刷新编辑器内容。

use photocraft_codecs::{EncodeOptions, Format, PngCompression, TiffCompression};
use photocraft_doc::Document;
use photocraft_engine::web_cmds::{self, WebFormat, WebSettings};
use serde_json::{Value, json};

use super::budgets::budgets;
use super::formats::{exportable_formats, format_for_extension, open_status, OpenStatus};
use crate::error::{EditorError, Result};

fn bad(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "format.export".into(), message: message.to_string() }
}

/// 编码产物：字节就是交付字节，报告随同返回。
#[derive(Clone, Debug)]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    pub report: Value,
}

/// 导出模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportMode {
    /// 逐格式通用导出（File ▸ Export As）。
    Export,
    /// Save for Web（量化/调色板/抖动路径）。
    Web,
}

impl ExportMode {
    fn parse(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("export") {
            "export" | "exportAs" | "as" => Ok(ExportMode::Export),
            "web" | "saveForWeb" => Ok(ExportMode::Web),
            other => Err(bad(format!("未知导出模式 `{other}`（export|web）"))),
        }
    }
}

/// 归一化后的尺寸请求。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SizeRequest {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub percent: Option<f64>,
}

fn u32_param(params: &Value, key: &str) -> Result<Option<u32>> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value.as_f64().ok_or_else(|| bad(format!("`{key}` 必须是数字")))?;
            if !number.is_finite() || number < 1.0 || number > f64::from(u32::MAX) {
                return Err(bad(format!("`{key}` 必须是 1 以上的整数")));
            }
            Ok(Some(number.round() as u32))
        }
    }
}

impl SizeRequest {
    fn parse(params: &Value) -> Result<Self> {
        let percent = match params.get("percent") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let number = value.as_f64().ok_or_else(|| bad("`percent` 必须是数字"))?;
                if !number.is_finite() || !(1.0..=1000.0).contains(&number) {
                    return Err(bad("`percent` 必须在 1–1000 之间"));
                }
                Some(number)
            }
        };
        let width = u32_param(params, "width")?;
        let height = u32_param(params, "height")?;
        if percent.is_some() && (width.is_some() || height.is_some()) {
            return Err(bad("`percent` 与 `width`/`height` 只能给一组"));
        }
        Ok(SizeRequest { width, height, percent })
    }

    fn is_identity(&self) -> bool {
        self.percent.is_none() && self.width.is_none() && self.height.is_none()
    }

    /// 目标尺寸（保持纵横比；缺失的一边按源比例换算）。
    pub fn target(&self, source_width: u32, source_height: u32) -> (u32, u32) {
        let (w0, h0) = (f64::from(source_width.max(1)), f64::from(source_height.max(1)));
        let (w, h) = match (self.percent, self.width, self.height) {
            (Some(percent), _, _) => (w0 * percent / 100.0, h0 * percent / 100.0),
            (_, Some(width), Some(height)) => (f64::from(width), f64::from(height)),
            (_, Some(width), None) => (f64::from(width), h0 * f64::from(width) / w0),
            (_, None, Some(height)) => (w0 * f64::from(height) / h0, f64::from(height)),
            _ => (w0, h0),
        };
        (w.round().max(1.0) as u32, h.round().max(1.0) as u32)
    }
}

/// 归一化后的导出设置（预览与交付共用）。
#[derive(Clone, Debug)]
pub struct ExportSettings {
    pub mode: ExportMode,
    pub format: Format,
    pub extension: &'static str,
    /// Save for Web 的精确格式词（gif|png8|png24|jpeg）；通用导出为 None。
    pub web_format: Option<&'static str>,
    pub size: SizeRequest,
    pub jpeg_quality: u8,
    pub jpeg_chroma_subsampling: bool,
    pub png_compression: PngCompression,
    pub png_interlaced: bool,
    pub webp_lossless: bool,
    pub webp_quality: u8,
    pub tiff_compression: TiffCompression,
    pub transparency: bool,
    /// 请求的元数据策略：`none` | `copyright` | `all`。
    pub metadata: String,
    pub embed_icc: bool,
    /// 仅 Save for Web：调色板与抖动。
    pub web: Option<WebSettings>,
}

fn parse_png_compression(params: &Value) -> Result<PngCompression> {
    match params.get("pngCompression").and_then(Value::as_str) {
        None => Ok(PngCompression::Default),
        Some("none") => Ok(PngCompression::None),
        Some("fast") => Ok(PngCompression::Fast),
        Some("default") => Ok(PngCompression::Default),
        Some("best") => Ok(PngCompression::Best),
        Some(other) => Err(bad(format!("未知 PNG 压缩 `{other}`（none|fast|default|best）"))),
    }
}

fn parse_tiff_compression(params: &Value) -> Result<TiffCompression> {
    match params.get("tiffCompression").and_then(Value::as_str) {
        None => Ok(TiffCompression::None),
        Some("none") => Ok(TiffCompression::None),
        Some("lzw") => Ok(TiffCompression::Lzw),
        Some("deflate") => Ok(TiffCompression::Deflate),
        Some("packbits") => Ok(TiffCompression::PackBits),
        Some(other) => Err(bad(format!("未知 TIFF 压缩 `{other}`（none|lzw|deflate|packbits）"))),
    }
}

fn quality(value: Option<&Value>, key: &str, fallback: u8) -> Result<u8> {
    match value {
        None | Some(Value::Null) => Ok(fallback),
        Some(value) => {
            let number = value.as_f64().ok_or_else(|| bad(format!("`{key}` 必须是数字")))?;
            if !number.is_finite() || !(1.0..=100.0).contains(&number) {
                return Err(bad(format!("`{key}` 必须在 1–100 之间")));
            }
            Ok(number.round() as u8)
        }
    }
}

fn flag(params: &Value, key: &str, fallback: bool) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

/// Save for Web 的格式词（UI 显示与报告回显用）。
fn web_format_token(format: WebFormat) -> &'static str {
    match format {
        WebFormat::Gif => "gif",
        WebFormat::Png8 => "png8",
        WebFormat::Png24 => "png24",
        WebFormat::Jpeg => "jpeg",
        WebFormat::Wbmp => "wbmp",
    }
}

/// 解析并校验导出设置；任何非法参数都在编码前拒绝（不会拿旧预览去提交）。
pub fn parse_settings(params: &Value) -> Result<ExportSettings> {
    let mode = ExportMode::parse(params.get("mode").and_then(Value::as_str))?;
    let requested = params
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("缺少 `format`（例如 jpeg、webp、tiff、png）"))?;
    // Save for Web 的 `format` 是 WebFormat 词（gif|png8|png24|jpeg），通用导出是扩展名。
    let (format, web_token) = if mode == ExportMode::Web {
        let web_format = WebFormat::from_id(requested)
            .ok_or_else(|| bad(format!("Save for Web 不支持格式 `{requested}`（gif|png8|png24|jpeg）")))?;
        let format = match web_format {
            WebFormat::Gif => Format::Gif,
            WebFormat::Png8 | WebFormat::Png24 => Format::Png,
            WebFormat::Jpeg => Format::Jpeg,
            WebFormat::Wbmp => return Err(bad("WBMP 不在本 change 的交付范围")),
        };
        (format, Some(web_format))
    } else {
        (
            format_for_extension(requested).ok_or_else(|| bad(format!("未知导出格式 `{requested}`")))?,
            None,
        )
    };
    let (status, reason) = open_status(format);
    if status == OpenStatus::Deferred {
        return Err(bad(format!("{} 暂不支持导出：{}", format.name(), reason.unwrap_or("缺少编码路径"))));
    }
    if !format.caps().write || !exportable_formats().contains(&format) {
        return Err(bad(format!("{} 在本构建中不可写", format.name())));
    }
    let extension = format.extensions()[0];
    let size = SizeRequest::parse(params)?;
    // 默认值跟随格式能力：无 alpha 的格式默认关闭透明，用户显式要求时才拒绝而不是静默合成。
    let transparency = flag(params, "transparency", format.caps().alpha);
    if transparency && !format.caps().alpha {
        return Err(bad(format!(
            "{} 不支持透明；请关闭「透明」或选择 {}",
            format.name(),
            exportable_formats()
                .iter()
                .filter(|candidate| candidate.caps().alpha)
                .map(|candidate| candidate.name())
                .collect::<Vec<_>>()
                .join(" / ")
        )));
    }
    let metadata = match params.get("metadata").and_then(Value::as_str) {
        None => "none".to_string(),
        Some(value @ ("none" | "copyright" | "copyrightAndContact" | "all")) => value.to_string(),
        Some(other) => return Err(bad(format!("未知元数据策略 `{other}`（none|copyright|copyrightAndContact|all）"))),
    };
    let web = if mode == ExportMode::Web {
        // 预设名自带格式（"JPEG High" 等）。选中预设又选了别的格式时明确拒绝：上游的
        // `from_params` 会让 `format` 覆盖预设格式，那样两套格式会静默互相覆盖。
        if let Some(preset) = params.get("preset").and_then(Value::as_str) {
            let expected = web_token.ok_or_else(|| bad("Save for Web 缺少格式"))?;
            let preset_format = web_cmds::preset_settings(preset)
                .ok_or_else(|| bad(format!("未知 Save for Web 预设 `{preset}`")))?
                .format;
            if preset_format != expected {
                return Err(bad(format!(
                    "预设 `{preset}` 的格式与所选格式不一致；请清空预设或选择匹配的格式"
                )));
            }
        }
        let mut settings = WebSettings::from_params(params, "file.export.saveForWeb")
            .map_err(|error| bad(format!("Save for Web 参数无效：{error}")))?;
        // 参数里给的格式必须与解析出的 WebFormat 一致，避免两套格式互相覆盖。
        let expected = web_token.ok_or_else(|| bad("Save for Web 缺少格式"))?;
        if settings.format != expected {
            return Err(bad("Save for Web 的预设格式与所选格式不一致；请清空预设或选择匹配的格式"));
        }
        settings.transparency = transparency;
        if !transparency {
            settings.matte = Some([1.0, 1.0, 1.0]);
        }
        Some(settings)
    } else {
        None
    };
    Ok(ExportSettings {
        mode,
        format,
        extension,
        web_format: web_token.map(web_format_token),
        size,
        jpeg_quality: quality(params.get("quality"), "quality", 90)?,
        jpeg_chroma_subsampling: flag(params, "chromaSubsampling", true),
        png_compression: parse_png_compression(params)?,
        png_interlaced: flag(params, "interlaced", false),
        webp_lossless: flag(params, "webpLossless", false),
        webp_quality: quality(params.get("webpQuality").or_else(|| params.get("quality")), "webpQuality", 80)?,
        tiff_compression: parse_tiff_compression(params)?,
        transparency,
        metadata,
        embed_icc: flag(params, "embedIcc", false),
        web,
    })
}

impl ExportSettings {
    fn encode_options(&self) -> EncodeOptions {
        EncodeOptions {
            jpeg_quality: self.jpeg_quality,
            jpeg_chroma_subsampling: self.jpeg_chroma_subsampling,
            png_compression: self.png_compression,
            png_interlaced: self.png_interlaced,
            webp_lossless: self.webp_lossless,
            webp_quality: self.webp_quality,
            tiff_compression: self.tiff_compression,
            embed_icc: self.embed_icc,
            embed_metadata: self.metadata != "none",
            ..EncodeOptions::default()
        }
    }

    /// 设置回显（报告用；不含字节，便于 UI 与解码后的报告逐项对照）。
    fn echo(&self, size: (u32, u32)) -> Value {
        let mut value = json!({
            "mode": match self.mode { ExportMode::Export => "export", ExportMode::Web => "web" },
            "format": self.extension,
            "width": size.0,
            "height": size.1,
            "transparency": self.transparency,
            "metadata": self.metadata,
            "embedIcc": self.embed_icc,
        });
        if let Some(percent) = self.size.percent {
            value["percent"] = json!(percent);
        }
        match self.format {
            Format::Jpeg => {
                value["quality"] = json!(self.jpeg_quality);
                value["chromaSubsampling"] = json!(self.jpeg_chroma_subsampling);
            }
            Format::WebP => {
                value["lossless"] = json!(self.webp_lossless);
                value["quality"] = json!(self.webp_quality);
            }
            Format::Tiff => value["compression"] = json!(match self.tiff_compression {
                TiffCompression::None => "none",
                TiffCompression::Lzw => "lzw",
                TiffCompression::Deflate => "deflate",
                TiffCompression::PackBits => "packbits",
            }),
            Format::Png => {
                value["compression"] = json!(match self.png_compression {
                    PngCompression::None => "none",
                    PngCompression::Fast => "fast",
                    PngCompression::Default => "default",
                    PngCompression::Best => "best",
                });
                value["interlaced"] = json!(self.png_interlaced);
            }
            _ => {}
        }
        if let Some(web) = &self.web {
            value["web"] = web.to_params();
        }
        value
    }
}

impl ExportSettings {
    /// 预检回显（不含字节；`echo` 需要一个已算出的目标尺寸）。
    pub fn inspect_json(&self) -> Value {
        let mut value = json!({
            "mode": match self.mode { ExportMode::Export => "export", ExportMode::Web => "web" },
            "format": self.extension,
            "transparency": self.transparency,
            "metadata": self.metadata,
            "embedIcc": self.embed_icc,
            "size": {
                "width": self.size.width,
                "height": self.size.height,
                "percent": self.size.percent,
            },
        });
        match self.format {
            Format::Jpeg => {
                value["quality"] = json!(self.jpeg_quality);
                value["chromaSubsampling"] = json!(self.jpeg_chroma_subsampling);
            }
            Format::WebP => {
                value["lossless"] = json!(self.webp_lossless);
                value["quality"] = json!(self.webp_quality);
            }
            Format::Tiff => value["compression"] = json!(match self.tiff_compression {
                TiffCompression::None => "none",
                TiffCompression::Lzw => "lzw",
                TiffCompression::Deflate => "deflate",
                TiffCompression::PackBits => "packbits",
            }),
            Format::Png => {
                value["compression"] = json!(match self.png_compression {
                    PngCompression::None => "none",
                    PngCompression::Fast => "fast",
                    PngCompression::Default => "default",
                    PngCompression::Best => "best",
                });
                value["interlaced"] = json!(self.png_interlaced);
            }
            _ => {}
        }
        if let Some(web) = &self.web {
            value["web"] = web.to_params();
        }
        value
    }
}

/// 预检与编码共用的尺寸/格式校验（不编码）。
pub fn validate_target(settings: &ExportSettings, target: (u32, u32)) -> Result<()> {
    let (status, reason) = open_status(settings.format);
    if status == OpenStatus::Deferred {
        return Err(bad(format!("{} 暂不支持导出：{}", settings.format.name(), reason.unwrap_or("缺少编码路径"))));
    }
    if !exportable_formats().contains(&settings.format) {
        return Err(bad(format!("{} 在本构建中不可写", settings.format.name())));
    }
    check_size(target.0, target.1)
}

/// 尺寸预算校验：越界即拒绝，不自动缩小或降位深。
fn check_size(width: u32, height: u32) -> Result<()> {
    let budgets = budgets();
    if width == 0 || height == 0 {
        return Err(bad("目标尺寸必须大于 0"));
    }
    let max_side = budgets.max_export_dimension.min(photocraft_project_verify::MAX_CANVAS_SIDE);
    if width > max_side || height > max_side {
        return Err(bad(format!("目标尺寸 {width}×{height} 超过单边上限 {max_side}")));
    }
    if u64::from(width) * u64::from(height) > budgets.max_export_pixels {
        return Err(bad(format!("目标像素 {width}×{height} 超过本次导出预算")));
    }
    Ok(())
}

/// 按尺寸请求生成待编码文档；无缩放时直接克隆，缩放走上游 `image.imageSize`（同一重采样器）。
fn sized_document(doc: &Document, size: &SizeRequest) -> Result<(Document, (u32, u32))> {
    let target = size.target(doc.size.width, doc.size.height);
    check_size(target.0, target.1)?;
    if size.is_identity() || target == (doc.size.width, doc.size.height) {
        return Ok((doc.clone(), target));
    }
    let mut session = photocraft_engine::Session::new();
    session.add_document(doc.clone(), None);
    session
        .execute("image.imageSize", json!({ "width": target.0, "height": target.1, "resample": "bicubic" }))
        .map_err(|error| bad(format!("无法缩放到 {target:?}：{error}")))?;
    let sized = session.active().map(|state| (*state.doc).clone()).ok_or_else(|| bad("缩放后没有文档"))?;
    Ok((sized, target))
}

/// 编码一次（预览与交付共用）。
pub fn encode_export(doc: &Document, settings: &ExportSettings, revision: u64, content_hash: &str, preview: bool) -> Result<EncodedImage> {
    let (sized, target) = sized_document(doc, &settings.size)?;
    let echo = settings.echo(target);
    let (bytes, warnings, lossy, colors, transparent_index) = match settings.mode {
        ExportMode::Web => {
            let web = settings.web.clone().ok_or_else(|| bad("Save for Web 缺少设置"))?;
            let (web_doc, _, _) = web_cmds::web_document(&sized, &json!({}), &web)
                .map_err(|error| bad(format!("Save for Web 缩放失败：{error}")))?;
            let buffer = photocraft_compose::flatten(&web_doc);
            if buffer.rect.is_empty() {
                return Err(bad("画布为空，无法编码"));
            }
            let icc = web_doc.icc_profile.as_deref().map(|profile| profile.as_slice());
            let xmp = web_cmds::web_xmp(&web_doc, web.metadata);
            let optimized = web_cmds::optimize(
                &buffer.px,
                buffer.rect.width() as usize,
                buffer.rect,
                &web,
                if web.embed_icc { icc } else { None },
                xmp.as_deref(),
                web_doc.resolution_dpi,
                preview,
            )
            .map_err(|error| bad(format!("Save for Web 编码失败：{error}")))?;
            // Save for Web 的优化器不产出损失清单（`optimize()` 只返回字节与调色板），
            // 但损失确实发生了。这里从**真实编码结果**推导，不凭空猜：
            // - JPEG 是有损压缩；
            // - GIF/PNG-8 走索引调色板，颜色被量化到 `colors` 个；
            // - 索引格式的透明是单索引（开/关），做不到半透明。
            // 与 `mode = "export"` 的 warnings 一样，这些必须显示在预览和交付提示里，
            // 否则「预览成功」会掩盖不可逆损失。
            let mut web_warnings: Vec<String> = Vec::new();
            if web.format == WebFormat::Jpeg {
                web_warnings.push("lossy compression".into());
            }
            if web.format.indexed() {
                match optimized.colors {
                    Some(colors) => web_warnings.push(format!("colours will be quantized to a {colors}-colour palette")),
                    None => web_warnings.push("colours will be quantized to an indexed palette".into()),
                }
                let has_alpha = buffer.px.iter().any(|pixel| pixel[3] < 1.0);
                if has_alpha {
                    web_warnings.push("alpha will be reduced to on/off transparency".into());
                }
            }
            (
                optimized.bytes,
                web_warnings,
                web.format.indexed() || web.format == WebFormat::Jpeg,
                optimized.colors,
                optimized.transparent_index,
            )
        }
        ExportMode::Export => {
            let options = photocraft_io::ExportOptions {
                encode: settings.encode_options(),
                force_psb: false,
                tiff_layers: false,
                // Export As 默认不写整包 XMP/自由文本（与上游 Export As 的 Metadata: None 一致）。
                xmp: if settings.metadata == "none" { photocraft_io::XmpEmbed::None } else { photocraft_io::XmpEmbed::All },
                tga_bits: None,
                image_previews: false,
                psd_maximize_compatibility: false,
            };
            let exported = photocraft_io::export(&sized, settings.extension, &options)
                .map_err(|error| bad(format!("{} 编码失败：{error}", settings.format.name())))?;
            let lossy = settings.format.caps().lossy || matches!(settings.format, Format::WebP) && !settings.webp_lossless;
            (exported.bytes, exported.warnings, lossy, None, None)
        }
    };
    if bytes.is_empty() {
        return Err(bad("编码结果为空"));
    }
    let report = json!({
        "kind": "export",
        "mode": match settings.mode { ExportMode::Export => "export", ExportMode::Web => "web" },
        "format": settings.extension,
        "mime": settings.format.mime_type(),
        "width": target.0,
        "height": target.1,
        "bytes": bytes.len(),
        "revision": revision,
        "documentContentHash": content_hash,
        "settings": echo,
        "warnings": warnings,
        "lossy": lossy,
        "colors": colors,
        "transparentIndex": transparent_index,
        "preview": preview,
        // 导出不改文档：报告明确本次没有任何内容写入。
        "documentChanged": false,
    });
    Ok(EncodedImage { bytes, report })
}

/// 通用导出可选格式（UI 选项与参数校验同源）。
pub fn export_matrix() -> Value {
    Value::Array(
        exportable_formats()
            .into_iter()
            .map(|format| {
                let caps = format.caps();
                json!({
                    "format": format.extensions()[0],
                    "name": format.name(),
                    "extensions": format.extensions(),
                    "mime": format.mime_type(),
                    "alpha": caps.alpha,
                    "lossy": caps.lossy,
                    "animation": caps.animation,
                    "depths": caps.depths.iter().map(|depth| super::formats::sample_label(*depth)).collect::<Vec<_>>(),
                    "options": options_for(format),
                    "webFormats": web_formats_for(format),
                })
            })
            .collect(),
    )
}

fn options_for(format: Format) -> Vec<&'static str> {
    match format {
        Format::Jpeg => vec!["quality", "chromaSubsampling", "metadata", "embedIcc", "width", "height", "percent"],
        Format::WebP => vec!["webpLossless", "webpQuality", "metadata", "embedIcc", "width", "height", "percent", "transparency"],
        Format::Tiff => vec!["tiffCompression", "metadata", "embedIcc", "width", "height", "percent", "transparency"],
        Format::Png => vec!["pngCompression", "interlaced", "metadata", "embedIcc", "width", "height", "percent", "transparency"],
        _ => vec!["metadata", "width", "height", "percent", "transparency"],
    }
}

pub fn web_formats_for(format: Format) -> Vec<&'static str> {
    match format {
        Format::Jpeg => vec!["jpeg"],
        Format::Gif => vec!["gif"],
        Format::Png => vec!["png8", "png24"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "tests_export.rs"]
mod tests;
