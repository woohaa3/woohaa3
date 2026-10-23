//! U45：灰度／位图／索引色／双色调模式与颜色表
//! （change: 2026-10-22-add-photocraft-image-mode-workflows，design D1/D3）。
//!
//! ## 真实模式，不是黑白调整层
//!
//! 转换走上游 `engine::{image_cmds,color_cmds,mode_cmds}` 的生产算法（`image.mode.grayscale`、
//! `image.mode.rgb`、`image.mode.indexedColor`、`image.mode.bitmap`、`image.mode.duotone`、
//! `image.mode.colorTable`）。模式字段、颜色表与油墨数据由 `photocraft_doc::Document` 持有，
//! `.pcraft` 工程本身已持久化它们，因此保存重开仍保留真实模式；这里不新增另一套内容状态。
//!
//! ## 为什么是「计划 → 应用」而不是长草稿
//!
//! 预览在**独立 scratch 会话**上跑完整个转换，正式文档、修订、历史都不动；客户端拿到的是一份
//! 报告加一张源像素预览。应用时重新校验参数并在同一 scratch 上重算候选，再用一次
//! `preview_history::commit` 提交一步历史。这样：
//!
//! - 预览不可能污染正式文档，取消只是丢弃报告；
//! - 内核不需要在 `Editor` 上新增草稿字段，因而不必修改共享的草稿门禁；
//! - `base.revision`/`base.contentHash` 不一致即拒绝，晚到的计划不会写到已经变化的文档上；
//! - 转换结果是确定性的，重算候选即证据，不需要把候选像素缓存在内核里。
//!
//! 与 Channels 的规范通道表示对齐（design D2）仍属同级依赖；索引色与双色调的全链路发布
//! 由集成方在通道端口落地后再开放，本次只保证本域数据、转换、报告与核验是真实的。

use std::collections::BTreeMap;
use std::sync::Arc;

use photocraft_doc::{ColorMode, Document, DuotoneInk, Layer, LayerContent, LayerId, SampleType};
use photocraft_engine::{DocState, Session};
use serde_json::{json, Map, Value};

use crate::document_content::{self, AssetRegistry};
use crate::editor::Preview;
use crate::error::{EditorError, Result};

/// 预览单边上限（与前端 `MAX_MODE_PREVIEW_SIDE` 一致）。
pub const MAX_PREVIEW_SIDE: u32 = 1024;

/// 颜色表条目上限（上游与 PSD 的颜色表上限）。
pub const MAX_TABLE_COLORS: usize = 256;
/// 双色调油墨数上限（Monotone…Quadtone）。
pub const MAX_INKS: usize = 4;
/// 单条油墨曲线的最多控制点。
pub const MAX_INK_CURVE_POINTS: usize = 64;
/// 油墨名最大长度。
pub const MAX_INK_NAME: usize = 64;

/// 本域包装的上游命令（只有这些走模式转换）。
pub const MODE_COMMANDS: &[&str] = &[
    "image.mode.rgb",
    "image.mode.grayscale",
    "image.mode.indexedColor",
    "image.mode.bitmap",
    "image.mode.duotone",
    "image.mode.colorTable",
];

/// 模式目标 id（与前端 `IMAGE_MODE_TARGETS` 一致）。
pub const TARGETS: &[&str] = &["rgb", "grayscale", "bitmap", "indexed", "duotone"];

pub fn error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 模式目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeTarget {
    Rgb,
    Grayscale,
    Bitmap,
    Indexed,
    Duotone,
}

impl ModeTarget {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "rgb" => Ok(ModeTarget::Rgb),
            "grayscale" => Ok(ModeTarget::Grayscale),
            "bitmap" => Ok(ModeTarget::Bitmap),
            "indexed" => Ok(ModeTarget::Indexed),
            "duotone" => Ok(ModeTarget::Duotone),
            other => Err(error("image.mode", format!("未知图像模式目标：{other}"))),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            ModeTarget::Rgb => "rgb",
            ModeTarget::Grayscale => "grayscale",
            ModeTarget::Bitmap => "bitmap",
            ModeTarget::Indexed => "indexed",
            ModeTarget::Duotone => "duotone",
        }
    }

    fn command(self) -> &'static str {
        match self {
            ModeTarget::Rgb => "image.mode.rgb",
            ModeTarget::Grayscale => "image.mode.grayscale",
            ModeTarget::Bitmap => "image.mode.bitmap",
            ModeTarget::Indexed => "image.mode.indexedColor",
            ModeTarget::Duotone => "image.mode.duotone",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ModeTarget::Rgb => "RGB Color",
            ModeTarget::Grayscale => "Grayscale",
            ModeTarget::Bitmap => "Bitmap",
            ModeTarget::Indexed => "Indexed Color",
            ModeTarget::Duotone => "Duotone",
        }
    }

    fn note(self, from: ColorMode) -> Vec<&'static str> {
        match self {
            ModeTarget::Rgb => match from {
                ColorMode::Indexed => vec!["离开索引色后颜色表被丢弃，像素保持已经量化的结果。"],
                ColorMode::Duotone => vec!["双色调按当前油墨渲染为 RGB，像素不再保持灰度。"],
                _ => vec![],
            },
            ModeTarget::Grayscale => match from {
                ColorMode::Duotone => vec!["灰度转换丢弃双色调油墨，只保留灰度像素。"],
                _ => vec!["转换为灰度合并颜色通道，图层与蒙版保留。"],
            },
            ModeTarget::Bitmap => vec!["位图模式只有黑白两点，会拼合图层并按阈值／抖动／半调量化。"],
            ModeTarget::Indexed => vec!["索引色最多 256 色，会拼合图层并量化像素；颜色表可随后编辑。"],
            ModeTarget::Duotone => vec!["双色调用 1–4 种油墨渲染灰度；像素保持灰度，油墨影响显示与导出。"],
        }
    }
}

/// 模式 id（内核 `ColorMode` → 前端 id；不在本域范围的颜色模型回 `None`）。
pub fn mode_id(mode: ColorMode) -> Option<&'static str> {
    match mode {
        ColorMode::Rgb => Some("rgb"),
        ColorMode::Grayscale => Some("grayscale"),
        ColorMode::Bitmap => Some("bitmap"),
        ColorMode::Indexed => Some("indexed"),
        ColorMode::Duotone => Some("duotone"),
        _ => None,
    }
}

/// 目标是否可从当前模式开始；`Some(reason)` 表示不可用。
pub fn unavailable_reason(current: ColorMode, depth: SampleType, target: ModeTarget) -> Option<String> {
    if depth != SampleType::U8 {
        return Some("本次范围只支持 8 位/通道，16/32 位不在范围内".into());
    }
    match (target, current) {
        (ModeTarget::Rgb, ColorMode::Rgb) => Some("当前已是 RGB 颜色".into()),
        (ModeTarget::Grayscale, ColorMode::Grayscale) => Some("当前已是灰度".into()),
        (ModeTarget::Bitmap, ColorMode::Grayscale) => None,
        // 上游只允许从灰度转位图；位图文档再转位图会被内核拒绝，这里必须同样报不可用，
        // 否则面板会给出一个能点、点了必然失败的入口（实测 `modeInfo` 曾与内核不一致）。
        (ModeTarget::Bitmap, ColorMode::Bitmap) => Some("当前已是位图；重做位图请先转换为灰度".into()),
        (ModeTarget::Bitmap, _) => Some("位图模式需要先转换为灰度（图像 › 模式 › 灰度）".into()),
        (ModeTarget::Indexed, ColorMode::Rgb | ColorMode::Grayscale | ColorMode::Duotone) => None,
        (ModeTarget::Indexed, ColorMode::Indexed) => Some("当前已是索引色；请直接编辑颜色表".into()),
        (ModeTarget::Indexed, _) => Some("索引色需要 RGB 或灰度图像（位图请先转换为灰度）".into()),
        (ModeTarget::Duotone, ColorMode::Grayscale | ColorMode::Duotone) => None,
        (ModeTarget::Duotone, _) => Some("双色调需要灰度图像（图像 › 模式 › 灰度）".into()),
        (ModeTarget::Rgb, _) => None,
        (ModeTarget::Grayscale, _) => None,
    }
}

// ------------------------------------------------------------------ 参数校验

/// 计划/应用共用的传输字段：不属于模式参数，校验时忽略。
pub const TRANSPORT_KEYS: &[&str] = &["maxSide", "baseRevision", "baseContentHash"];

fn reject_unknown(params: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<()> {
    if let Some(key) = params
        .keys()
        .find(|key| !allowed.contains(&key.as_str()) && !TRANSPORT_KEYS.contains(&key.as_str()))
    {
        return Err(error("image.mode", format!("{what} 不接受参数 `{key}`")));
    }
    Ok(())
}

fn enum_param<'a>(params: &'a Map<String, Value>, key: &str, allowed: &[&'a str], default: &'a str, what: &str) -> Result<&'a str> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let text = value
                .as_str()
                .ok_or_else(|| error("image.mode", format!("{what} 的 `{key}` 必须是字符串")))?;
            allowed
                .iter()
                .copied()
                .find(|candidate| *candidate == text)
                .ok_or_else(|| error("image.mode", format!("{what} 的 `{key}` 无效：{text}（可选 {}）", allowed.join("|"))))
        }
    }
}

fn range_param(params: &Map<String, Value>, key: &str, range: (f64, f64), default: f64, what: &str) -> Result<f64> {
    let value = match params.get(key) {
        None | Some(Value::Null) => default,
        Some(value) => value
            .as_f64()
            .filter(|number| number.is_finite())
            .ok_or_else(|| error("image.mode", format!("{what} 的 `{key}` 必须是有限数值")))?,
    };
    if value < range.0 || value > range.1 {
        return Err(error("image.mode", format!("{what} 的 `{key}` 必须在 {}–{} 之间", range.0, range.1)));
    }
    Ok(value)
}

fn hex_color(value: &str) -> Option<[u8; 3]> {
    let text = value.strip_prefix('#')?;
    if text.len() != 6 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&text[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

fn hex_of(color: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2])
}

fn color_of(rgb: [f32; 3]) -> String {
    let to = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    hex_of([to(rgb[0]), to(rgb[1]), to(rgb[2])])
}

/// 校验并规范化参数：只保留本目标认识的键，未知键显式拒绝（不静默忽略拼写错误）。
pub fn normalize(target: ModeTarget, params: &Value) -> Result<Value> {
    let object = match params {
        Value::Null => Map::new(),
        Value::Object(object) => object.clone(),
        _ => return Err(error("image.mode", "模式参数必须是对象")),
    };
    match target {
        ModeTarget::Rgb | ModeTarget::Grayscale => {
            reject_unknown(&object, &[], target.id())?;
            Ok(json!({}))
        }
        ModeTarget::Bitmap => {
            let what = "位图";
            reject_unknown(&object, &["method", "frequency", "angle", "shape"], what)?;
            let method = enum_param(&object, "method", &["diffusion", "threshold", "pattern", "halftone"], "diffusion", what)?;
            let shape = enum_param(&object, "shape", &["round", "ellipse", "line", "square", "diamond", "cross"], "round", what)?;
            let frequency = range_param(&object, "frequency", (1.0, 999.0), 53.0, what)?;
            let angle = range_param(&object, "angle", (-180.0, 180.0), 45.0, what)?;
            Ok(json!({ "method": method, "frequency": frequency, "angle": angle, "shape": shape }))
        }
        ModeTarget::Indexed => {
            let what = "索引色";
            reject_unknown(&object, &["palette", "colors", "forced", "dither", "amount", "transparency"], what)?;
            let palette = enum_param(
                &object,
                "palette",
                &["selective", "perceptual", "adaptive", "exact", "systemMac", "systemWindows", "web", "uniform"],
                "selective",
                what,
            )?;
            let forced = enum_param(&object, "forced", &["blackWhite", "none", "primaries", "web"], "blackWhite", what)?;
            let dither = enum_param(&object, "dither", &["diffusion", "none", "pattern", "noise"], "diffusion", what)?;
            let colors = match object.get("colors") {
                None | Some(Value::Null) => 256,
                Some(value) => {
                    let number = value
                        .as_f64()
                        .filter(|number| number.is_finite() && number.fract() == 0.0)
                        .ok_or_else(|| error("image.mode", "索引色的 `colors` 必须是 2–256 的整数"))?;
                    if !(2.0..=256.0).contains(&number) {
                        return Err(error("image.mode", "索引色的 `colors` 必须是 2–256 的整数"));
                    }
                    number as u32
                }
            };
            let amount = range_param(&object, "amount", (0.0, 100.0), 75.0, what)?;
            let transparency = object.get("transparency").and_then(Value::as_bool).unwrap_or(true);
            Ok(json!({
                "palette": palette,
                "colors": colors,
                "forced": forced,
                "dither": dither,
                "amount": amount,
                "transparency": transparency
            }))
        }
        ModeTarget::Duotone => {
            let what = "双色调";
            reject_unknown(&object, &["type", "inks"], what)?;
            let kind = enum_param(&object, "type", &["monotone", "duotone", "tritone", "quadtone"], "duotone", what)?;
            let inks = match object.get("inks") {
                // 不给油墨就用内核按 `type` 生成的默认油墨：这里必须**省略**该键，
                // 传 `null` 会被上游当成「非法油墨数组」而拒绝。
                None | Some(Value::Null) => None,
                Some(Value::Array(list)) => {
                    if list.len() > MAX_INKS {
                        return Err(error("image.mode", format!("双色调最多 {MAX_INKS} 种油墨")));
                    }
                    let mut out = Vec::with_capacity(list.len());
                    for ink in list {
                        let fields = ink
                            .as_object()
                            .ok_or_else(|| error("image.mode", "每种油墨必须是对象：{name, color, curve}"))?;
                        reject_unknown(fields, &["name", "color", "curve"], "油墨")?;
                        let name = fields.get("name").and_then(Value::as_str).unwrap_or("Ink").to_string();
                        if name.is_empty() || name.chars().count() > MAX_INK_NAME || name.chars().any(char::is_control) {
                            return Err(error("image.mode", format!("油墨名必须是 1–{MAX_INK_NAME} 个字符")));
                        }
                        let color = match fields.get("color") {
                            None | Some(Value::Null) => "#000000".to_string(),
                            Some(value) => {
                                let text = value
                                    .as_str()
                                    .ok_or_else(|| error("image.mode", "油墨颜色必须是 #rrggbb"))?;
                                if hex_color(text).is_none() {
                                    return Err(error("image.mode", format!("油墨颜色必须是 #rrggbb：{text}")));
                                }
                                text.to_ascii_lowercase()
                            }
                        };
                        let curve = match fields.get("curve") {
                            None | Some(Value::Null) => Value::Null,
                            Some(Value::Array(points)) => {
                                if points.len() > MAX_INK_CURVE_POINTS {
                                    return Err(error("image.mode", format!("油墨曲线最多 {MAX_INK_CURVE_POINTS} 个控制点")));
                                }
                                let mut normalized = Vec::with_capacity(points.len());
                                for point in points {
                                    let pair = point
                                        .as_array()
                                        .filter(|pair| pair.len() == 2)
                                        .ok_or_else(|| error("image.mode", "油墨曲线控制点必须是 [输入, 输出]"))?;
                                    let input = pair[0]
                                        .as_f64()
                                        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                                        .ok_or_else(|| error("image.mode", "油墨曲线输入必须在 0–100"))?;
                                    let output = pair[1]
                                        .as_f64()
                                        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
                                        .ok_or_else(|| error("image.mode", "油墨曲线输出必须在 0–100"))?;
                                    normalized.push(json!([input, output]));
                                }
                                Value::Array(normalized)
                            }
                            Some(_) => return Err(error("image.mode", "油墨曲线必须是控制点数组")),
                        };
                        out.push(json!({ "name": name, "color": color, "curve": curve }));
                    }
                    Some(Value::Array(out))
                }
                Some(_) => return Err(error("image.mode", "`inks` 必须是油墨数组")),
            };
            let mut normalized = Map::new();
            normalized.insert("type".into(), json!(kind));
            if let Some(inks) = inks {
                normalized.insert("inks".into(), inks);
            }
            Ok(Value::Object(normalized))
        }
    }
}

// ------------------------------------------------------------------ 转换

fn scratch_from(base: &DocState) -> Session {
    let mut session = Session::new();
    session.add_document((*base.doc).clone(), None);
    if let Some(slot) = session.active_mut() {
        *slot = base.clone();
    }
    session
}

fn run(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    session.execute(id, params).map_err(|failure| error("image.mode", failure))
}

fn kind_counts(layers: &[Layer], out: &mut BTreeMap<&'static str, usize>) {
    for layer in layers {
        let kind = match &layer.content {
            LayerContent::Raster(_) => "raster",
            LayerContent::Group(_) => "group",
            LayerContent::Adjustment(_) => "adjustment",
            LayerContent::Fill(_) => "fill",
            LayerContent::Text(_) => "text",
            LayerContent::Shape(_) => "shape",
            LayerContent::Smart(_) => "smart",
        };
        *out.entry(kind).or_default() += 1;
        if let LayerContent::Group(group) = &layer.content {
            kind_counts(&group.children, out);
        }
    }
}

fn layer_count(layers: &[Layer]) -> usize {
    layers
        .iter()
        .map(|layer| 1 + layer.children().map_or(0, layer_count))
        .sum()
}

/// 标准 base64（预览像素以字符串过 JSON，避免把几十万个数组成员塞进状态响应）。
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(packed >> 18) as usize & 63] as char);
        out.push(TABLE[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[packed as usize & 63] as char } else { '=' });
    }
    out
}

fn preview_of(doc: &Document, max_side: u32) -> Preview {
    let side = max_side.clamp(16, MAX_PREVIEW_SIDE);
    let shown = photocraft_engine::mode_cmds::display_document(doc).unwrap_or_else(|| doc.clone());
    let image = photocraft_compose::thumbnail(&shown, side);
    Preview { width: image.width, height: image.height, pixels: image.pixels }
}

/// 一次候选转换：报告 + 源像素预览 + 候选文档。
pub struct ModePlan {
    pub report: Value,
    pub preview: Preview,
    pub candidate: Arc<Document>,
    pub active: Option<LayerId>,
    pub base_revision: u64,
    pub base_hash: String,
    pub changed: bool,
}

fn content_hash(doc: &Document, registry: &AssetRegistry) -> Result<String> {
    document_content::document_content_hash(doc, registry)
        .ok_or_else(|| error("image.mode", "无法计算文档内容指纹"))
}

fn same_visual_state(base: &Document, candidate: &Document, base_hash: &str, candidate_hash: &str) -> bool {
    base_hash == candidate_hash
        && base.mode == candidate.mode
        && base.depth == candidate.depth
        && base.color_table == candidate.color_table
        && base.duotone == candidate.duotone
}

fn loss_report(base: &Document, candidate: &Document, target: ModeTarget) -> Value {
    let mut before = BTreeMap::new();
    let mut after = BTreeMap::new();
    kind_counts(&base.layers, &mut before);
    kind_counts(&candidate.layers, &mut after);
    let mut dropped = Map::new();
    for (kind, count) in &before {
        let lost = count.saturating_sub(*after.get(*kind).unwrap_or(&0));
        if lost > 0 {
            dropped.insert((*kind).to_string(), json!(lost));
        }
    }
    let layers_before = layer_count(&base.layers);
    let layers_after = layer_count(&candidate.layers);
    let flattened = layers_after < layers_before;
    let mut notes: Vec<String> = target.note(base.mode).into_iter().map(str::to_string).collect();
    if flattened {
        notes.push(format!("图层结构从 {layers_before} 层拼合为 {layers_after} 层，拼合不可逆。"));
    }
    let color_count = candidate.color_table.as_ref().map(|table| table.colors.len());
    let colors: Option<Vec<String>> = candidate
        .color_table
        .as_ref()
        .map(|table| table.colors.iter().map(|entry| hex_of(*entry)).collect());
    let transparent = candidate.color_table.as_ref().and_then(|table| table.transparent).map(u32::from);
    let inks: Option<Vec<Value>> = candidate.duotone.as_ref().map(|duotone| {
        duotone
            .inks
            .iter()
            .map(|ink| json!({"name": ink.name, "color": color_of(ink.color)}))
            .collect()
    });
    json!({
        "fromMode": mode_id(base.mode),
        "toMode": mode_id(candidate.mode),
        "depth": candidate.depth.bits(),
        "layersBefore": layers_before,
        "layersAfter": layers_after,
        "flattened": flattened,
        "dropped": dropped,
        "lossy": flattened || !matches!(target, ModeTarget::Rgb | ModeTarget::Grayscale),
        "colorCount": color_count,
        "colors": colors,
        "transparentIndex": transparent,
        "inks": inks,
        "notes": notes
    })
}

/// 计算一次模式转换（不触碰正式文档）。
pub fn plan_mode(base: &DocState, registry: &AssetRegistry, target: ModeTarget, params: &Value, max_side: u32) -> Result<ModePlan> {
    let normalized = normalize(target, params)?;
    if let Some(reason) = unavailable_reason(base.doc.mode, base.doc.depth, target) {
        return Err(error(target.command(), reason));
    }
    let base_hash = content_hash(&base.doc, registry)?;
    let mut scratch = scratch_from(base);
    let result = run(&mut scratch, target.command(), normalized)?;
    let state = scratch.active().ok_or(EditorError::NoDocument)?;
    let candidate = state.doc.clone();
    let candidate_hash = content_hash(&candidate, registry)?;
    let changed = !same_visual_state(&base.doc, &candidate, &base_hash, &candidate_hash);
    let mut report = loss_report(&base.doc, &candidate, target);
    if let Some(object) = report.as_object_mut() {
        object.insert("target".into(), json!(target.id()));
        object.insert("label".into(), json!(target.label()));
        object.insert("changed".into(), json!(changed));
        if let Some(colors) = result.get("colors") {
            object.insert("reportedColors".into(), colors.clone());
        }
        if let Some(index) = result.get("transparentIndex") {
            object.insert("reportedTransparent".into(), index.clone());
        }
    }
    let preview = preview_of(&candidate, max_side);
    Ok(ModePlan {
        report,
        preview,
        active: state.active_layer,
        candidate,
        base_revision: base.revision,
        base_hash,
        changed,
    })
}

// ------------------------------------------------------------------ 颜色表

/// 颜色表参数校验（`entries` 只允许已有索引，`transparent` 只允许表内索引）。
pub fn normalize_color_table(params: &Value) -> Result<Value> {
    let object = match params {
        Value::Object(object) => object.clone(),
        _ => return Err(error("image.mode.colorTable", "颜色表参数必须是对象")),
    };
    reject_unknown(&object, &["table", "colors", "entries", "transparent"], "颜色表")?;
    let table = enum_param(
        &object,
        "table",
        &["custom", "blackBody", "grayscale", "spectrum", "systemMac", "systemWindows", "web"],
        "custom",
        "颜色表",
    )?;
    let colors = match object.get("colors") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Array(list)) => {
            if list.is_empty() || list.len() > MAX_TABLE_COLORS {
                return Err(error("image.mode.colorTable", "颜色表必须有 1–256 个条目"));
            }
            let mut out = Vec::with_capacity(list.len());
            for entry in list {
                let text = entry
                    .as_str()
                    .ok_or_else(|| error("image.mode.colorTable", "颜色表条目必须是 #rrggbb"))?;
                if hex_color(text).is_none() {
                    return Err(error("image.mode.colorTable", format!("颜色表条目必须是 #rrggbb：{text}")));
                }
                out.push(json!(text.to_ascii_lowercase()));
            }
            Value::Array(out)
        }
        Some(_) => return Err(error("image.mode.colorTable", "`colors` 必须是颜色数组")),
    };
    let entries = match object.get("entries") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(map)) => {
            if map.len() > MAX_TABLE_COLORS {
                return Err(error("image.mode.colorTable", "颜色表最多 256 个条目"));
            }
            let mut out = Map::new();
            for (key, value) in map {
                let index: usize = key
                    .parse()
                    .map_err(|_| error("image.mode.colorTable", format!("颜色表索引非法：{key}")))?;
                if index >= MAX_TABLE_COLORS {
                    return Err(error("image.mode.colorTable", format!("颜色表索引越界：{index}")));
                }
                let text = value
                    .as_str()
                    .ok_or_else(|| error("image.mode.colorTable", format!("条目 {index} 的颜色必须是 #rrggbb")))?;
                if hex_color(text).is_none() {
                    return Err(error("image.mode.colorTable", format!("条目 {index} 的颜色必须是 #rrggbb")));
                }
                out.insert(index.to_string(), json!(text.to_ascii_lowercase()));
            }
            Value::Object(out)
        }
        Some(_) => return Err(error("image.mode.colorTable", "`entries` 必须是索引到颜色的对象")),
    };
    let transparent = match object.get("transparent") {
        None => Value::Null,
        Some(Value::Null) => Value::Null,
        Some(value) => {
            let index = value
                .as_u64()
                .filter(|index| *index < MAX_TABLE_COLORS as u64)
                .ok_or_else(|| error("image.mode.colorTable", "透明索引必须是 0–255 的整数或 null"))?;
            json!(index)
        }
    };
    Ok(json!({ "table": table, "colors": colors, "entries": entries, "transparent": transparent }))
}

fn color_table_report(base: &Document, candidate: &Document) -> Value {
    let table = candidate.color_table.as_ref();
    let inks: Option<Vec<Value>> = candidate.duotone.as_ref().map(|duotone| {
        duotone
            .inks
            .iter()
            .map(|ink| json!({"name": ink.name, "color": color_of(ink.color)}))
            .collect()
    });
    // 与模式转换报告同一形状：前端只用一个解码器，颜色表计划不会被判成非法结构。
    // 颜色表编辑不拼合、不丢弃图层，也不改位深，因此损失字段都是空值。
    json!({
        "fromMode": mode_id(base.mode),
        "toMode": mode_id(candidate.mode),
        "colors": table.map(|table| table.colors.iter().map(|entry| hex_of(*entry)).collect::<Vec<_>>()),
        "transparent": table.and_then(|table| table.transparent).map(u32::from),
        "entries": table.map_or(0, |table| table.colors.len()),
        "fromEntries": base.color_table.as_ref().map_or(0, |table| table.colors.len()),
        "depth": candidate.depth.bits(),
        "layersBefore": layer_count(&base.layers),
        "layersAfter": layer_count(&candidate.layers),
        "flattened": false,
        "dropped": {},
        "lossy": false,
        "colorCount": table.map(|table| table.colors.len()),
        "transparentIndex": table.and_then(|table| table.transparent).map(u32::from),
        "inks": inks
    })
}

/// 计算一次颜色表编辑（不触碰正式文档）。
pub fn plan_color_table(base: &DocState, registry: &AssetRegistry, params: &Value, max_side: u32) -> Result<ModePlan> {
    if base.doc.mode != ColorMode::Indexed {
        return Err(error("image.mode.colorTable", "颜色表只在索引色模式可用（图像 › 模式 › 索引色）"));
    }
    if base.doc.depth != SampleType::U8 {
        return Err(error("image.mode.colorTable", "本次范围只支持 8 位/通道"));
    }
    let normalized = normalize_color_table(params)?;
    let base_hash = content_hash(&base.doc, registry)?;
    let mut scratch = scratch_from(base);
    run(&mut scratch, "image.mode.colorTable", normalized)?;
    let state = scratch.active().ok_or(EditorError::NoDocument)?;
    let candidate = state.doc.clone();
    let candidate_hash = content_hash(&candidate, registry)?;
    let changed = !same_visual_state(&base.doc, &candidate, &base_hash, &candidate_hash);
    let mut report = color_table_report(&base.doc, &candidate);
    if let Some(object) = report.as_object_mut() {
        object.insert("target".into(), json!("color-table"));
        object.insert("label".into(), json!("Color Table"));
        object.insert("changed".into(), json!(changed));
        object.insert("notes".into(), json!(["颜色表修改保持已有索引，像素颜色随表变化。"]));
    }
    let preview = preview_of(&candidate, max_side);
    Ok(ModePlan {
        report,
        preview,
        active: state.active_layer,
        candidate,
        base_revision: base.revision,
        base_hash,
        changed,
    })
}

// ------------------------------------------------------------------ 只读信息

fn duotone_json(doc: &Document) -> Value {
    let Some(duotone) = doc.duotone.as_ref() else {
        return Value::Null;
    };
    json!({
        "inks": duotone.inks.iter().map(|ink: &DuotoneInk| json!({
            "name": ink.name,
            "color": color_of(ink.color),
            "curve": ink.curve.iter().map(|point| json!([
                f64::from(point.input) * 100.0,
                f64::from(point.output) * 100.0
            ])).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    })
}

fn color_table_json(doc: &Document) -> Value {
    let Some(table) = doc.color_table.as_ref() else {
        return Value::Null;
    };
    json!({
        "colors": table.colors.iter().map(|entry| hex_of(*entry)).collect::<Vec<_>>(),
        "transparent": table.transparent.map(u32::from)
    })
}

/// 只读模式信息：当前模式、颜色表、油墨、目标可用性与陷印状态。
///
/// 只读采样不改变文档、历史或内容指纹；工具支持矩阵由前端协议域解释。
pub fn info(doc: &Document, revision: u64, content_hash: &str, read_only: bool) -> Value {
    let targets: Vec<Value> = TARGETS
        .iter()
        .filter_map(|id| ModeTarget::parse(id).ok())
        .map(|target| {
            let reason = unavailable_reason(doc.mode, doc.depth, target)
                .or_else(|| read_only.then(|| "文档来自只读来源，不能修改模式".to_string()));
            json!({
                "id": target.id(),
                "label": target.label(),
                "available": reason.is_none(),
                "reason": reason
            })
        })
        .collect();
    json!({
        "mode": mode_id(doc.mode),
        "rawMode": format!("{:?}", doc.mode),
        "depth": doc.depth.bits(),
        "colorTable": color_table_json(doc),
        "duotone": duotone_json(doc),
        "layers": layer_count(&doc.layers),
        "targets": targets,
        "revision": revision,
        "contentHash": content_hash,
        "readOnly": read_only,
        "trap": trap_status()
    })
}

/// 陷印状态：印前陷印需要 CMYK，本次范围排除 ICC/CMYK，入口保持关闭并说明原因。
pub fn trap_status() -> Value {
    json!({
        "available": false,
        "requires": "cmyk",
        "reason": "陷印是 CMYK 印前步骤；本次范围排除 ICC/CMYK，入口保持关闭"
    })
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
