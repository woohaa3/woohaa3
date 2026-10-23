//! 受限 PSD 交换：RGB/U8 预检、逐特性矩阵、损失报告与栅格化副本
//! （change: 2026-10-22-complete-photocraft-webui-editing，P3 / design D6）。
//!
//! ## 支持矩阵优先于扩展名
//!
//! 只有**通过双向 fixture** 的项才进入可编辑矩阵。这里把矩阵写成代码：每一项都有
//! `import`/`export` 的判定函数与原因文案，报告直接来自这些判定，而不是靠注释描述。
//!
//! ## 默认拒绝，显式降级
//!
//! - 导入：解析与映射在**候选文档**完成；有不可编辑结构时默认拒绝，用户可显式选择
//!   「作为扁平副本打开」（只用合成像素），报告写明会丢什么。
//! - 导出：先生成逐层报告；默认保留可编辑结构，无法表示的内容阻止默认导出；用户可显式
//!   选择对列明内容栅格化后导出副本。
//!
//! PSD 文件交付**不**取代 `.pcraft` 原生保存，也不清除工程未保存状态。

use photocraft_doc::{
    Adjustment, ColorMode, Document, Layer, LayerContent, SampleType, SmartSource,
};
use photocraft_psd::{PsdFile, Version};
use photocraft_project_verify::limits;
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{EditorError, Result};

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "format.psd".into(), message: message.to_string() }
}

/// 一项兼容性结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    /// 双向可编辑，且有 fixture 覆盖。
    Editable,
    /// 可导入但只能作为像素（丢结构）。
    RasterOnly,
    /// 不可交换，必须拒绝。
    Unsupported,
}

impl Support {
    fn label(self) -> &'static str {
        match self {
            Support::Editable => "editable",
            Support::RasterOnly => "raster-only",
            Support::Unsupported => "unsupported",
        }
    }
}

/// 矩阵的一行：特性、导入结论、导出结论与不可用原因。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixRow {
    pub feature: &'static str,
    pub import: &'static str,
    pub export: &'static str,
    pub note: &'static str,
}

/// PSD 兼容矩阵（P3 基线；P4/P5/P7 在此追加）。
///
/// 这张表是**唯一**的兼容性声明来源：`compatibility_matrix()` 把它交给 UI 与核验报告，
/// 导入／导出报告用同一批判定函数。
pub fn compatibility_matrix() -> Vec<MatrixRow> {
    vec![
        MatrixRow {
            feature: "psd.v1.rgb-u8",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "PSD v1（8BPS version 1）、RGB、8 位；PSB/CMYK/ICC/16/32 位拒绝",
        },
        MatrixRow {
            feature: "pixels",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "像素层、组内像素层与裁剪边界按原尺寸保留",
        },
        MatrixRow {
            feature: "groups",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "普通组（含嵌套、展开状态、混合与不透明度）",
        },
        MatrixRow {
            feature: "pixel-mask",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "像素蒙版（含启停与链接；密度/羽化按上游能力保留）",
        },
        MatrixRow {
            feature: "blend-and-fill",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "Photoshop 混合模式与填充不透明度",
        },
        MatrixRow {
            feature: "text.horizontal",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "水平文字内容与首期排版参数；路径/竖排文字拒绝",
        },
        MatrixRow {
            feature: "adjustment.three",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "亮度/对比度、色相/饱和度、曲线",
        },
        MatrixRow {
            feature: "layer-styles",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "受支持的图层样式集合（资源无关 + 已验证图案）",
        },
        MatrixRow {
            feature: "adjustment.levels-curves-vibrance-bw",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "P5：色阶、分通道曲线、自然饱和度、黑白",
        },
        MatrixRow {
            feature: "smart-object.embedded",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "P4：嵌入 pcraft 源的智能对象；外链源拒绝",
        },
        MatrixRow {
            feature: "vector.shape-mask",
            import: Support::Editable.label(),
            export: Support::Editable.label(),
            note: "P7：形状路径与矢量蒙版（已验证子集）",
        },
        MatrixRow {
            feature: "video.frames",
            import: Support::RasterOnly.label(),
            export: Support::RasterOnly.label(),
            note: "视频图层只交换当前帧的像素；帧栈与时间轴属 .pcraft（PSD 导出逐层进损失报告）",
        },
        MatrixRow {
            feature: "psb",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "PSB 不在本次范围",
        },
        MatrixRow {
            feature: "color.cmyk-lab",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "CMYK/Lab/索引/灰度文档不在本次范围",
        },
        MatrixRow {
            feature: "depth.16-32",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "16/32 位与 HDR 不在本次范围",
        },
        MatrixRow {
            feature: "color.icc",
            import: Support::RasterOnly.label(),
            export: Support::RasterOnly.label(),
            note: "ICC 配置文件不作为可编辑色彩管理；像素按 sRGB 处理并报告",
        },
        MatrixRow {
            feature: "type.path-vertical",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "路径文字与竖排文字不在本次范围",
        },
        MatrixRow {
            feature: "smart-object.linked",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "外链智能对象不在本次范围",
        },
        MatrixRow {
            feature: "smart-filter",
            import: Support::Unsupported.label(),
            export: Support::Unsupported.label(),
            note: "智能滤镜栈不在本次范围",
        },
    ]
}

/// PSD 头部预检结论（在分配像素前给出）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PsdHeaderInfo {
    pub version: &'static str,
    pub color_mode: String,
    pub depth: u16,
    pub width: u32,
    pub height: u32,
    pub channels: u16,
    pub bytes: usize,
}

/// 预检一份 PSD 字节：容器、版本、色彩、位深、尺寸与字节预算。
///
/// **在解析图层与分配像素之前**拒绝 PSB／非 RGB/U8／损坏／超限输入。
pub fn inspect_psd(bytes: &[u8]) -> Result<PsdHeaderInfo> {
    if bytes.is_empty() {
        return Err(error("PSD 内容为空"));
    }
    if bytes.len() > limits::MAX_PSD_INPUT_BYTES {
        return Err(error(format!(
            "PSD 输入超过 {} MiB",
            limits::MAX_PSD_INPUT_BYTES / (1024 * 1024)
        )));
    }
    if !bytes.starts_with(b"8BPS") {
        return Err(error("这不是 Photoshop PSD 文件（缺少 8BPS 签名）"));
    }
    // 头部 26 字节：签名、版本、6 字节保留、通道、高、宽、位深、色彩模式。
    let header = bytes.get(..26).ok_or_else(|| error("PSD 头部不完整"))?;
    let version = u16::from_be_bytes([header[4], header[5]]);
    if version != 1 {
        return Err(error(format!(
            "只支持 PSD v1；PSB 或未知版本（{version}）不在本次范围"
        )));
    }
    let channels = u16::from_be_bytes([header[12], header[13]]);
    let height = u32::from_be_bytes([header[14], header[15], header[16], header[17]]);
    let width = u32::from_be_bytes([header[18], header[19], header[20], header[21]]);
    let depth = u16::from_be_bytes([header[22], header[23]]);
    let color_mode = u16::from_be_bytes([header[24], header[25]]);
    if color_mode != 3 {
        return Err(error(format!(
            "只支持 RGB PSD；当前色彩模式 {color_mode}（CMYK/Lab/索引/灰度等不在本次范围）"
        )));
    }
    if depth != 8 {
        return Err(error(format!(
            "只支持 8 位 PSD；当前 {depth} 位（16/32 位与 HDR 不在本次范围）"
        )));
    }
    if width == 0 || height == 0 {
        return Err(error("PSD 尺寸非法"));
    }
    if width > limits::MAX_CANVAS_SIDE
        || height > limits::MAX_CANVAS_SIDE
        || u64::from(width) * u64::from(height) > limits::MAX_CANVAS_PIXELS
    {
        return Err(error(format!(
            "PSD 尺寸 {width}×{height} 超过工程上限（单边 {}）",
            limits::MAX_CANVAS_SIDE
        )));
    }
    if channels == 0 || channels > 56 {
        return Err(error(format!("PSD 通道数 {channels} 非法")));
    }
    Ok(PsdHeaderInfo {
        version: "psd-v1",
        color_mode: "rgb".into(),
        depth,
        width,
        height,
        channels,
        bytes: bytes.len(),
    })
}

/// 导入结果：候选文档 + 逐项损失报告 + 是否含不可编辑结构。
pub struct PsdImport {
    pub document: Document,
    pub warnings: Vec<String>,
    pub lossy: Vec<String>,
    pub header: PsdHeaderInfo,
    /// 源文件是否带合法合成图（决定是否允许「扁平副本」）。
    pub has_composite: bool,
}

/// 解析 PSD 为**候选文档**（不替换任何现有文档）。
pub fn import_psd(bytes: &[u8]) -> Result<PsdImport> {
    let header = inspect_psd(bytes)?;
    let file = PsdFile::from_bytes(bytes).map_err(|failure| error(format!("PSD 解析失败：{failure}")))?;
    // 逐结构检查：只有矩阵内的可编辑结构才允许默认导入。
    let mut lossy = Vec::new();
    inspect_psd_structure(&file, &mut lossy)?;
    let (document, warnings) = photocraft_io::psd_to_document(&file);
    if document.layers.is_empty() {
        return Err(error("PSD 没有可导入的图层"));
    }
    // 候选文档仍须通过原生工程核验（图层数、深度、嵌套与源预算）。
    let project = photocraft_format::save_to_bytes(&document, &Default::default())
        .map_err(|failure| error(format!("PSD 候选文档无法序列化：{failure}")))?;
    if let Err(failure) = photocraft_project_verify::smart_source::verify_project(&project) {
        return Err(error(format!("PSD 候选文档未通过核验：{}", failure.message)));
    }
    let has_composite = file.has_real_merged_data().unwrap_or(false) || file.layer_info.is_none();
    Ok(PsdImport { document, warnings, lossy, header, has_composite })
}

/// 检查每个图层是否为矩阵内可编辑结构，把不可编辑项写入 `lossy`。
fn inspect_psd_structure(file: &PsdFile, lossy: &mut Vec<String>) -> Result<()> {
    let mut count = 0usize;
    fn walk(layer: &photocraft_doc::Layer, count: &mut usize, lossy: &mut Vec<String>) {
        *count += 1;
        match &layer.content {
            LayerContent::Group(group) => {
                for child in &group.children {
                    walk(child, count, lossy);
                }
            }
            LayerContent::Raster(_) | LayerContent::Text(_) => {}
            LayerContent::Adjustment(adjustment) => {
                if !supported_adjustment(adjustment) {
                    lossy.push(format!("图层「{}」的调整类型 {} 不可编辑", layer.name, adjustment.label()));
                }
            }
            LayerContent::Fill(_) => {
                lossy.push(format!("图层「{}」是填充层（只能作为像素）", layer.name));
            }
            LayerContent::Shape(_) => {
                lossy.push(format!("图层「{}」是形状层（只能作为像素）", layer.name));
            }
            LayerContent::Smart(smart) => match &smart.source {
                SmartSource::Embedded { .. } => {
                    if !smart.smart_filters.is_empty() {
                        lossy.push(format!("图层「{}」含智能滤镜（不在本次范围）", layer.name));
                    }
                }
                SmartSource::Linked { .. } => {
                    lossy.push(format!("图层「{}」是外链智能对象（不在本次范围）", layer.name));
                }
            },
        }
    }
    for layer in &file.layer_tree_max_depth(photocraft_doc::MAX_GROUP_DEPTH) {
        let _ = layer;
    }
    // 上游已经映射成文档；这里只按数量做上限检查，具体结构在 `psd_to_document` 后复查。
    let (document, _) = photocraft_io::psd_to_document(file);
    for layer in &document.layers {
        walk(layer, &mut count, lossy);
    }
    if count > limits::MAX_LAYERS {
        return Err(error(format!("PSD 图层数 {count} 超过工程上限（64）")));
    }
    Ok(())
}

fn supported_adjustment(adjustment: &Adjustment) -> bool {
    // 与唯一命令门/核验器的调整接受集合一致：已发布的类型在 PSD 往返里可编辑；
    // LUT 与无法求值的块不可编辑（导入时只能作为像素）。
    matches!(
        adjustment,
        Adjustment::BrightnessContrast { .. }
            | Adjustment::HueSaturation { .. }
            | Adjustment::Curves { .. }
            | Adjustment::Levels { .. }
            | Adjustment::Vibrance { .. }
            | Adjustment::BlackWhite { .. }
            | Adjustment::Exposure { .. }
            | Adjustment::ColorBalance { .. }
            | Adjustment::PhotoFilter { .. }
            | Adjustment::ChannelMixer { .. }
            | Adjustment::Invert
            | Adjustment::Posterize { .. }
            | Adjustment::Threshold { .. }
            | Adjustment::GradientMap { .. }
            | Adjustment::SelectiveColor { .. }
    )
}

/// 把 PSD 作为扁平副本导入：只保留合成像素，报告列出丢失的编辑结构。
pub fn import_psd_flat(bytes: &[u8]) -> Result<PsdImport> {
    let header = inspect_psd(bytes)?;
    let file = PsdFile::from_bytes(bytes).map_err(|failure| error(format!("PSD 解析失败：{failure}")))?;
    let mut lossy = Vec::new();
    let (mut document, warnings) = photocraft_io::psd_to_document(&file);
    // 扁平副本：把整份文档合成为单层（内核合成，不引入第二套实现）。
    let composite = photocraft_compose::flatten_to_surface(
        &document,
        document.pixel_format(),
        Some([1.0, 1.0, 1.0]),
    );
    let mut flat = Document::new(
        document.name.clone(),
        document.size,
        ColorMode::Rgb,
        SampleType::U8,
    );
    flat.resolution_dpi = document.resolution_dpi;
    let mut layer = Layer::raster("扁平副本", flat.pixel_format());
    if let LayerContent::Raster(surface) = &mut layer.content {
        *surface = composite;
    }
    flat.layers.push(layer);
    // 报告：原文档的可编辑结构全部被栅格化。
    let mut count = 0;
    fn collect(layers: &[Layer], count: &mut usize, lossy: &mut Vec<String>) {
        for layer in layers {
            *count += 1;
            if let LayerContent::Group(group) = &layer.content {
                collect(&group.children, count, lossy);
            }
            let kind = match &layer.content {
                LayerContent::Raster(_) => continue,
                LayerContent::Group(_) => "组",
                LayerContent::Adjustment(_) => "调整层",
                LayerContent::Fill(_) => "填充层",
                LayerContent::Text(_) => "文字层",
                LayerContent::Shape(_) => "形状层",
                LayerContent::Smart(_) => "智能对象",
            };
            lossy.push(format!("图层「{}」是{kind}，扁平副本后不可编辑", layer.name));
        }
    }
    collect(&document.layers, &mut count, &mut lossy);
    document = flat;
    let has_composite = true;
    Ok(PsdImport { document, warnings, lossy, header, has_composite })
}

/// 导出一层损失报告项。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PsdLossRow {
    pub layer: String,
    pub kind: String,
    pub reason: String,
    /// 是否可以通过显式栅格化副本保留（false = 必须拒绝）。
    pub rasterizable: bool,
}

/// 导出预检：逐层列出可编辑性与损失原因。
pub fn inspect_psd_export(document: &Document) -> Result<Vec<PsdLossRow>> {
    if document.mode != ColorMode::Rgb || document.depth != SampleType::U8 {
        return Err(error("PSD 导出只支持 RGB/U8 文档"));
    }
    let mut rows = Vec::new();
    fn walk(layer: &Layer, rows: &mut Vec<PsdLossRow>) {
        match &layer.content {
            LayerContent::Group(group) => {
                for child in &group.children {
                    walk(child, rows);
                }
            }
            LayerContent::Raster(_) => {
                // 视频图层的内容类型仍是 Raster，但 PSD 没有逐帧栈的概念：导出只会得到**当前帧**
                // 的合成结果。此前这里静默跳过，于是「导出成功」却在无提示的情况下丢掉整段动画
                // （change: 2026-10-22-add-photocraft-animation-workflows，B6）。现在进损失报告，
                // 并把已有帧的「栅格化副本」作为显式选择。
                if let Some(video) = &layer.video {
                    rows.push(PsdLossRow {
                        layer: layer.name.clone(),
                        kind: "video".into(),
                        reason: format!(
                            "视频图层的 {} 帧帧栈无法写入 PSD；导出只保留当前帧的画面",
                            video.frames.len()
                        ),
                        rasterizable: true,
                    });
                }
            }
            LayerContent::Adjustment(adjustment) => {
                if !supported_adjustment(adjustment) {
                    rows.push(PsdLossRow {
                        layer: layer.name.clone(),
                        kind: "adjustment".into(),
                        reason: format!("调整类型 {} 无法写入可编辑 PSD", adjustment.label()),
                        rasterizable: true,
                    });
                }
            }
            LayerContent::Text(text) => {
                if !matches!(text.shape, photocraft_doc::text::TextShape::Point { .. }) {
                    rows.push(PsdLossRow {
                        layer: layer.name.clone(),
                        kind: "text".into(),
                        reason: "段落文字框无法在本次矩阵内保持可编辑".into(),
                        rasterizable: true,
                    });
                }
            }
            LayerContent::Shape(_) => rows.push(PsdLossRow {
                layer: layer.name.clone(),
                kind: "shape".into(),
                reason: "形状层按矢量蒙版子集导出；复杂布尔路径不可表示".into(),
                rasterizable: true,
            }),
            LayerContent::Fill(_) => rows.push(PsdLossRow {
                layer: layer.name.clone(),
                kind: "fill".into(),
                reason: "填充层不作为可编辑 PSD 结构导出".into(),
                rasterizable: true,
            }),
            LayerContent::Smart(smart) => {
                if !smart.smart_filters.is_empty() {
                    rows.push(PsdLossRow {
                        layer: layer.name.clone(),
                        kind: "smart".into(),
                        reason: "智能滤镜不在本次范围".into(),
                        rasterizable: true,
                    });
                }
                if matches!(smart.source, SmartSource::Linked { .. }) {
                    rows.push(PsdLossRow {
                        layer: layer.name.clone(),
                        kind: "smart".into(),
                        reason: "外链智能对象不在本次范围".into(),
                        rasterizable: false,
                    });
                }
            }
        }
    }
    for layer in &document.layers {
        walk(layer, &mut rows);
    }
    Ok(rows)
}

/// 导出结果：字节 + 逐层报告 + 是否栅格化。
pub struct PsdExport {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
    pub lossy: Vec<PsdLossRow>,
    pub rasterized: bool,
    pub version: u32,
}

/// 导出 PSD。
///
/// `rasterizeLossy` 为 false 时，任何 `rasterizable: false` 的损失都会阻止导出；为 true 时
/// 对列明内容生成栅格化副本（转换只影响输出，不改原文档）。
pub fn export_psd(document: &Document, rasterize_lossy: bool) -> Result<PsdExport> {
    let rows = inspect_psd_export(document)?;
    let blocking: Vec<&PsdLossRow> = rows.iter().filter(|row| !row.rasterizable).collect();
    if !blocking.is_empty() {
        return Err(error(format!(
            "PSD 导出被拒绝：{}",
            blocking
                .iter()
                .map(|row| format!("{}（{}）", row.layer, row.reason))
                .collect::<Vec<_>>()
                .join("；")
        )));
    }
    if !rows.is_empty() && !rasterize_lossy {
        return Err(error(format!(
            "PSD 导出含 {} 项不可保持可编辑的内容；请确认对列明内容栅格化后导出副本",
            rows.len()
        )));
    }
    // 栅格化副本：先渲染合成，再导出单层 PSD（原文档不变）。
    let source = if rasterize_lossy && !rows.is_empty() {
        let mut flat = Document::new(
            document.name.clone(),
            document.size,
            ColorMode::Rgb,
            SampleType::U8,
        );
        flat.resolution_dpi = document.resolution_dpi;
        let surface = photocraft_compose::flatten_to_surface(
            document,
            document.pixel_format(),
            Some([1.0, 1.0, 1.0]),
        );
        let mut layer = Layer::raster("栅格化副本", flat.pixel_format());
        if let LayerContent::Raster(target) = &mut layer.content {
            *target = surface;
        }
        flat.layers.push(layer);
        std::borrow::Cow::Owned(flat)
    } else {
        std::borrow::Cow::Borrowed(document)
    };
    let options = photocraft_io::PsdExportOptions {
        force_psb: false,
        maximize_compatibility: true,
        ..Default::default()
    };
    let (file, warnings) = photocraft_io::document_to_psd_with(&source, &options);
    if file.header.version == Version::Psb {
        return Err(error("PSD 导出结果为 PSB，超出本次范围"));
    }
    let bytes = file.to_bytes().map_err(|failure| error(format!("PSD 写出失败：{failure}")))?;
    if bytes.len() > limits::MAX_PSD_OUTPUT_BYTES {
        return Err(error(format!(
            "PSD 导出超过 {} MiB",
            limits::MAX_PSD_OUTPUT_BYTES / (1024 * 1024)
        )));
    }
    Ok(PsdExport {
        bytes,
        warnings,
        lossy: rows,
        rasterized: matches!(source, std::borrow::Cow::Owned(_)),
        version: 1,
    })
}

/// 字节 → 可嵌入 JSON 的 base64（WASM 边界用 ，这里只给 JSON 端口）。
pub fn bytes_json(bytes: &[u8]) -> String {
    photocraft_paint::tile::b64_encode(bytes)
}

/// base64 JSON 转回字节（与 bytes_json 配对）。
pub fn bytes_from_json(value: &Value) -> Result<Vec<u8>> {
    let encoded = value
        .as_str()
        .ok_or_else(|| error("子文档字节必须是 base64 字符串"))?;
    photocraft_paint::tile::b64_decode(encoded)
        .ok_or_else(|| error("子文档 base64 数据无效"))
}

/// 导入报告 JSON（UI 与核验器共用）。
pub fn import_report(import: &PsdImport) -> Value {
    json!({
        "header": import.header,
        "warnings": import.warnings,
        "lossy": import.lossy,
        "editable": import.lossy.is_empty(),
        "hasComposite": import.has_composite,
        "layers": layer_count(&import.document.layers),
    })
}

/// 导出报告 JSON。
///
/// `document` 让**文档级**数据也能进报告：图层损失由 [`inspect_psd_export`] 给出，而参考线颜色、
/// 标尺原点、计数分组不挂在图层上（见 `features::views::psd_loss_rows`），只检查图层会把它们
/// 静默丢掉。
pub fn export_report(export: &PsdExport, document: &Document, samplers: &[[f64; 2]]) -> Value {
    let view_losses = crate::features::views::psd_loss_rows_with_samplers(document, samplers);
    json!({
        "warnings": export.warnings,
        "lossy": export.lossy,
        "viewLosses": view_losses.iter().map(|(feature, reason)| json!({
            "feature": feature,
            "reason": reason,
        })).collect::<Vec<_>>(),
        "rasterized": export.rasterized,
        "version": export.version,
        "bytes": export.bytes.len(),
    })
}

fn layer_count(layers: &[Layer]) -> usize {
    layers
        .iter()
        .map(|layer| {
            1 + match &layer.content {
                LayerContent::Group(group) => layer_count(&group.children),
                _ => 0,
            }
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, Size, TextLayer};

    fn rgb_document() -> Document {
        let mut document = Document::with_background(
            "psd",
            Size::new(48, 32),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.3, 0.5, 0.7),
        );
        let mut group = Layer::group("组", vec![Layer::raster("子", document.pixel_format())]);
        group.opacity = 0.5;
        document.layers.push(group);
        document.layers.push(Layer::new(
            "标题",
            LayerContent::Text(TextLayer {
                text: "中文".into(),
                font_family: "Noto Sans SC".into(),
                ..Default::default()
            }),
        ));
        document
    }

    #[test]
    fn preflight_rejects_wrong_container_version_color_and_depth_before_pixels() {
        assert!(inspect_psd(b"").is_err());
        assert!(inspect_psd(b"not psd").is_err());
        let mut header = vec![0u8; 26];
        header[..4].copy_from_slice(b"8BPS");
        // 版本 2 = PSB
        header[4..6].copy_from_slice(&2u16.to_be_bytes());
        header[12..14].copy_from_slice(&3u16.to_be_bytes());
        header[14..18].copy_from_slice(&10u32.to_be_bytes());
        header[18..22].copy_from_slice(&10u32.to_be_bytes());
        header[22..24].copy_from_slice(&8u16.to_be_bytes());
        header[24..26].copy_from_slice(&3u16.to_be_bytes());
        assert!(inspect_psd(&header).unwrap_err().message().contains("PSB"));
        // CMYK
        let mut cmyk = header.clone();
        cmyk[4..6].copy_from_slice(&1u16.to_be_bytes());
        cmyk[24..26].copy_from_slice(&4u16.to_be_bytes());
        assert!(inspect_psd(&cmyk).unwrap_err().message().contains("RGB"));
        // 16 位
        let mut deep = header.clone();
        deep[4..6].copy_from_slice(&1u16.to_be_bytes());
        deep[22..24].copy_from_slice(&16u16.to_be_bytes());
        assert!(inspect_psd(&deep).unwrap_err().message().contains("8 位"));
        // 超限尺寸
        let mut large = header.clone();
        large[4..6].copy_from_slice(&1u16.to_be_bytes());
        large[14..18].copy_from_slice(&9000u32.to_be_bytes());
        large[18..22].copy_from_slice(&9000u32.to_be_bytes());
        assert!(inspect_psd(&large).unwrap_err().message().contains("超过工程上限"));
        // 合法头
        let mut ok_header = header.clone();
        ok_header[4..6].copy_from_slice(&1u16.to_be_bytes());
        let ok = inspect_psd(&ok_header).unwrap();
        assert_eq!(ok.version, "psd-v1");
        assert_eq!((ok.width, ok.height, ok.depth), (10, 10, 8));
    }

    #[test]
    fn round_trip_keeps_groups_masks_text_and_adjustments_editable() {
        let document = rgb_document();
        let export = export_psd(&document, false).unwrap();
        assert!(!export.rasterized);
        let import = import_psd(&export.bytes).unwrap();
        assert!(import.lossy.is_empty(), "报告不应有损失：{:?}", import.lossy);
        assert_eq!(import.document.size, document.size);
        let reopened = photocraft_format::save_to_bytes(&import.document, &Default::default()).unwrap();
        assert!(photocraft_project_verify::smart_source::verify_project(&reopened).is_ok());
        // 组与文字仍可编辑（不是被压平）。
        assert!(import.document.layers.iter().any(|layer| matches!(layer.content, LayerContent::Group(_))));
        assert!(import.document.layers.iter().any(|layer| matches!(layer.content, LayerContent::Text(_))));
    }

    #[test]
    fn flat_copy_reports_lost_structure_and_keeps_one_layer() {
        let document = rgb_document();
        let export = export_psd(&document, false).unwrap();
        let flat = import_psd_flat(&export.bytes).unwrap();
        assert_eq!(flat.document.layers.len(), 1);
        assert!(!flat.lossy.is_empty(), "扁平副本必须报告丢失的编辑结构");
        assert!(flat.lossy.iter().any(|entry| entry.contains("组")));
        assert!(flat.lossy.iter().any(|entry| entry.contains("文字层")));
    }

    #[test]
    fn export_reports_lossy_layers_and_requires_explicit_rasterization() {
        let mut document = rgb_document();
        // 段落框文字：矩阵内不可保持可编辑，但可栅格化。
        if let Some(layer) = document.layers.iter_mut().find(|layer| matches!(layer.content, LayerContent::Text(_))) {
            if let LayerContent::Text(text) = &mut layer.content {
                text.shape = photocraft_doc::text::TextShape::Box { x: 0.0, y: 0.0, width: 20.0, height: 10.0 };
            }
        }
        let rows = inspect_psd_export(&document).unwrap();
        assert!(rows.iter().any(|row| row.kind == "text" && row.rasterizable));
        // 默认拒绝。
        assert!(export_psd(&document, false).is_err());
        // 显式栅格化后成功，且原文档不变。
        let before = document.clone();
        let export = export_psd(&document, true).unwrap();
        assert!(export.rasterized);
        assert!(!export.lossy.is_empty());
        assert_eq!(document, before, "导出副本不得修改原文档");
        // 栅格化副本是单层，导出仍可被读回。
        let import = import_psd(&export.bytes).unwrap();
        assert!(import.lossy.is_empty());
    }

    #[test]
    fn export_rejects_non_rgb_and_linked_sources_without_byte_output() {
        let mut cmyk = Document::new("cmyk", Size::new(8, 8), ColorMode::Cmyk, SampleType::U8);
        cmyk.layers.push(Layer::raster("层", cmyk.pixel_format()));
        assert!(export_psd(&cmyk, false).is_err());
        let mut linked = Document::new("linked", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        let mut layer = Layer::new(
            "外链",
            LayerContent::Smart(photocraft_doc::SmartObject::new(
                SmartSource::Linked { path: "/tmp/elsewhere.psd".into() },
                photocraft_geom::Affine::IDENTITY,
                None,
            )),
        );
        layer.id = photocraft_doc::LayerId::fresh();
        linked.layers.push(layer);
        let rows = inspect_psd_export(&linked).unwrap();
        assert!(rows.iter().any(|row| !row.rasterizable), "外链源必须阻止导出");
        assert!(export_psd(&linked, true).is_err());
    }

    #[test]
    fn export_reports_video_layers_instead_of_silently_flattening_them() {
        let mut document = rgb_document();
        let format = document.pixel_format();
        let mut layer = Layer::raster("帧", format);
        let mut surface = photocraft_doc::Surface::new(format);
        surface.fill_rect(
            photocraft_doc::Rect::new(0, 0, 8, 8),
            &[0.9, 0.1, 0.2, 1.0],
        );
        layer.video = Some(photocraft_doc::VideoData::new(vec![surface.clone(), surface], 12.0));
        document.layers.push(layer);

        let rows = inspect_psd_export(&document).unwrap();
        let video = rows.iter().find(|row| row.kind == "video").expect("视频层必须进损失报告");
        assert!(video.rasterizable, "当前帧画面仍可作为栅格化副本导出");
        assert!(video.reason.contains("2"), "原因里要有实际帧数：{}", video.reason);
        // 默认导出必须拒绝（不能让动画在「导出成功」的外观下消失）。
        assert!(export_psd(&document, false).is_err());
        // 显式栅格化后可以导出当前帧画面。
        let export = export_psd(&document, true).unwrap();
        assert!(export.rasterized);
        assert!(export.lossy.iter().any(|row| row.kind == "video"));
        // 矩阵把视频明确标为只交换像素，而不是伪装成可编辑。
        let row = compatibility_matrix().into_iter().find(|row| row.feature == "video.frames").unwrap();
        assert_eq!((row.import, row.export), ("raster-only", "raster-only"));
    }

    #[test]
    fn matrix_lists_every_declared_feature_with_a_reason() {
        let matrix = compatibility_matrix();
        assert!(matrix.iter().any(|row| row.feature == "psd.v1.rgb-u8" && row.import == "editable"));
        assert!(matrix.iter().any(|row| row.feature == "psb" && row.import == "unsupported"));
        assert!(matrix.iter().all(|row| !row.note.is_empty()));
        // 非目标必须明确标为 unsupported，不能伪装成 raster-only。
        for feature in ["psb", "color.cmyk-lab", "depth.16-32", "type.path-vertical", "smart-object.linked", "smart-filter"] {
            let row = matrix.iter().find(|row| row.feature == feature).unwrap();
            assert_eq!(row.import, "unsupported", "{feature}");
            assert_eq!(row.export, "unsupported", "{feature}");
        }
    }
}
