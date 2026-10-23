//! U40–U44 直接作用于像素的调整：目标选择、参数白名单与命令选择
//! （change: 2026-10-22-add-photocraft-adjustment-workflows）。
//!
//! 直接调整与调整图层的区别只在**目标**：直接调整把参数作用到可写像素层，确认后只增加一步
//! 历史、不新增图层；调整层走调整层草稿。草稿本身由
//! [`crate::adjustment_preview::AdjustmentPreview`] 统一持有，这里只提供它需要的目标判定、
//! 参数校验与命令选择，不另建第二份草稿状态。
//!
//! 复用上游生产算法，不修改 vendor：
//! - 逐类调整 → `image.adjustments.<kind>`（同一参数解析、同一选区混合）；
//! - 自动校正与匹配/替换颜色 → `image.autoTone` / `image.autoContrast` / `image.autoColor` /
//!   `image.adjustments.desaturate|equalize|shadowsHighlights|replaceColor|matchColor`。
//!
//! **开放与否由唯一命令门决定**（[`crate::capability::command_allowed`]）：本模块把全部已实现
//! 类型和命令都列出来，只有命令白名单里已声明的条目才能开始草稿，界面也只渲染这门报告的入口。
//! 本域自己的 `CONTRIBUTION`（`features/adjustments/mod.rs`）已把这些 id 发布进门；因此这里不再
//! 保存任何「待放开」清单，也不在本地复制一份白名单。
//!
//! 跨文档匹配（`matchColor.source`/`sourceLayer` 指向别的文档或图层）由草稿按**会话文档索引冻结
//! 快照**实现：`directAdjustmentTargets()` 报告 `documents[]`，草稿把全部其它文档按原索引冻结成
//! `Arc`，并对着快照核对来源是否存在（见 [`crate::adjustment_preview`]）。显式来源不会静默按
//! 「同文档」处理；多文档会话里 `source: i` 就是第 i 份文档。

use photocraft_doc::{Document, LayerId};
use serde_json::Value;

use crate::error::{EditorError, Result};

/// 已实现的逐类调整（命令后缀）；是否可写由命令门决定。
pub const ADJUSTMENT_KINDS: &[&str] = &[
    "brightnessContrast",
    "hueSaturation",
    "curves",
    "levels",
    "vibrance",
    "blackWhite",
    "exposure",
    "colorBalance",
    "photoFilter",
    "channelMixer",
    "invert",
    "posterize",
    "threshold",
    "gradientMap",
    "selectiveColor",
];

/// 已实现的自动校正与匹配/替换颜色命令（整条命令 id）。
pub const ADJUSTMENT_COMMANDS: &[&str] = &[
    "image.autoTone",
    "image.autoContrast",
    "image.autoColor",
    "image.adjustments.desaturate",
    "image.adjustments.equalize",
    "image.adjustments.shadowsHighlights",
    "image.adjustments.replaceColor",
    "image.adjustments.matchColor",
];

/// 六个色域（Hue/Saturation）与九个范围（Selective Color）的键，供界面与核验共用。
pub const HUE_RANGES: [&str; 6] = ["reds", "yellows", "greens", "cyans", "blues", "magentas"];
pub const SELECTIVE_RANGES: [&str; 9] =
    ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"];

pub(crate) fn error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 逐类调整对应的命令 id。
pub fn adjustment_command(kind: &str) -> String {
    format!("image.adjustments.{kind}")
}

/// 直接调整的请求：逐类调整（命令后缀）或一条完整的自动/匹配命令 id。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Kind(String),
    Command(String),
}

impl Request {
    /// 解析请求：`image.` 开头的是完整命令，其余是逐类调整的类型后缀。
    pub fn parse(target: &str) -> Result<Self> {
        if target.trim().is_empty() {
            return Err(error("image.adjustments", "调整目标不能为空"));
        }
        if target.starts_with("image.") {
            if command_allowed_keys(target).is_none() {
                return Err(error("image.adjustments", format!("{target} 不是本域实现的调整命令")));
            }
            return Ok(Request::Command(target.to_string()));
        }
        if allowed_keys(target).is_none() {
            return Err(error("image.adjustments", format!("{target} 不是本域实现的调整类型")));
        }
        Ok(Request::Kind(target.to_string()))
    }

    /// 真正执行的命令 id。
    pub fn command(&self) -> String {
        match self {
            Request::Kind(kind) => adjustment_command(kind),
            Request::Command(id) => id.clone(),
        }
    }

    /// 类型名（完整命令用命令 id 的最后一段），供界面与信息回传。
    pub fn kind(&self) -> String {
        match self {
            Request::Kind(kind) => kind.clone(),
            Request::Command(id) => id.rsplit('.').next().unwrap_or(id).to_string(),
        }
    }

    /// 参数键白名单。
    pub fn allowed_keys(&self) -> &'static [&'static str] {
        match self {
            Request::Kind(kind) => allowed_keys(kind).unwrap_or(&[]),
            Request::Command(id) => command_allowed_keys(id).unwrap_or(&[]),
        }
    }

    /// 校验参数。
    pub fn validate(&self, params: &Value) -> Result<()> {
        match self {
            Request::Kind(kind) => validate(kind, params),
            Request::Command(id) => validate_command(id, params),
        }
    }

    /// 命令是否已由唯一命令门开放（未开放的类型不能被草稿或参数验证绕过）。
    pub fn is_open(&self) -> bool {
        is_open(&self.command())
    }
}

/// 命令是否已由唯一命令门开放。
pub fn is_open(command: &str) -> bool {
    crate::capability::command_allowed(command)
}

/// 当前可开始的逐类调整（只含已开放命令）。
pub fn open_kinds() -> Vec<&'static str> {
    ADJUSTMENT_KINDS.iter().copied().filter(|kind| is_open(&adjustment_command(kind))).collect()
}

/// 当前可开始的自动/匹配命令（只含已开放命令）。
pub fn open_commands() -> Vec<&'static str> {
    ADJUSTMENT_COMMANDS.iter().copied().filter(|id| is_open(id)).collect()
}

/// 目标是可写像素层：文字/智能对象必须先显式栅格化，锁定像素的层直接拒绝。
pub fn writable_target(document: &Document, layer: LayerId) -> Result<()> {
    crate::adjustment_ext::writable_pixel_layer(document, layer).map_err(|failure| {
        // 保留上游判定的具体原因（文字/智能对象/锁定/类型），只把命令 id 归到直接调整。
        let message = match failure {
            EditorError::CommandFailed { message, .. } => message,
            other => other.to_string(),
        };
        error("image.adjustments", message)
    })
}

/// 直接调整要作用的目标层：显式 `layer` 优先，否则活动层。
pub fn target_layer(document: &Document, requested: Option<u64>, active: Option<LayerId>) -> Result<LayerId> {
    let layer = requested
        .map(LayerId)
        .or(active)
        .ok_or_else(|| error("image.adjustments", "没有可调整的像素图层"))?;
    if document.layer(layer).is_none() {
        return Err(error("image.adjustments", format!("目标图层 {} 不存在", layer.0)));
    }
    Ok(layer)
}

/// 每种逐类调整允许的参数键（含分通道、铅笔曲线、输出端点、色域、Tint）。
pub fn allowed_keys(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "brightnessContrast" => &["brightness", "contrast", "legacy"],
        "hueSaturation" => &[
            "hue", "saturation", "lightness", "colorize", "reds", "yellows", "greens", "cyans", "blues", "magentas",
        ],
        "curves" => &["points", "red", "green", "blue", "pencil", "smooth", "eyedropper"],
        "levels" => &["inBlack", "gamma", "inWhite", "outBlack", "outWhite", "red", "green", "blue", "eyedropper"],
        "vibrance" => &["vibrance", "saturation"],
        "blackWhite" => &["reds", "yellows", "greens", "cyans", "blues", "magentas", "tint", "tintColor"],
        "exposure" => &["exposure", "offset", "gamma"],
        "colorBalance" => &["shadows", "midtones", "highlights", "preserveLuminosity"],
        "photoFilter" => &["filter", "color", "density", "preserveLuminosity"],
        "channelMixer" => &["red", "green", "blue", "gray", "monochrome"],
        "invert" => &[],
        "posterize" => &["levels"],
        "threshold" => &["level"],
        "gradientMap" => &["stops", "reverse", "dither"],
        "selectiveColor" => &[
            "method", "colors", "cyan", "magenta", "yellow", "black", "reds", "yellows", "greens", "cyans", "blues",
            "magentas", "whites", "neutrals", "blacks",
        ],
        _ => return None,
    })
}

/// 自动校正与匹配/替换颜色允许的参数键。
pub fn command_allowed_keys(id: &str) -> Option<&'static [&'static str]> {
    Some(match id {
        "image.autoTone" | "image.autoContrast" | "image.autoColor" | "image.adjustments.desaturate"
        | "image.adjustments.equalize" => &[],
        "image.adjustments.shadowsHighlights" => &[
            "shadowAmount",
            "shadowTone",
            "shadowRadius",
            "highlightAmount",
            "highlightTone",
            "highlightRadius",
            "color",
            "midtone",
            "blackClip",
            "whiteClip",
        ],
        "image.adjustments.replaceColor" => {
            &["localized", "color", "fuzziness", "range", "hue", "saturation", "lightness", "points"]
        }
        "image.adjustments.matchColor" => &[
            "source",
            "sourceLayer",
            "luminance",
            "intensity",
            "fade",
            "neutralize",
            "useSelectionInSource",
            "useSelectionInTarget",
        ],
        _ => return None,
    })
}

/// 校验逐类调整参数（键、结构、曲线几何、吸管）。
///
/// 键白名单、曲线/吸管/渐变/可选颜色结构由本域把关；**标量的类型与取值**交给上游生产解析器
/// [`photocraft_engine::adjust_params::from_params`]，不在这里复制第二份范围表（上游按
/// Photoshop 字段语义夹紧越界值，类型不对才是错误）。文档色彩模式只影响色阶/曲线的通道空间，
/// 而通道空间已由参数里出现的通道键唯一确定，因此校验用一个固定模式即可。
pub fn validate(kind: &str, params: &Value) -> Result<()> {
    let allowed = allowed_keys(kind).ok_or_else(|| error("image.adjustments", format!("{kind} 不是已实现的调整类型")))?;
    validate_object(kind, params, allowed, true)?;
    let Some(object) = params.as_object() else { return Ok(()) };
    if kind == "curves" {
        // 曲线几何可出现在总曲线与三个分通道上；铅笔模式额外带 256 级映射。
        for key in ["points", "red", "green", "blue"] {
            if let Some(points) = object.get(key) {
                validate_curve(points, key)?;
            }
        }
    }
    if let Some(eyedropper) = object.get("eyedropper") {
        validate_eyedropper(eyedropper)?;
    }
    if let Some(stops) = object.get("stops") {
        validate_gradient_stops(stops)?;
    }
    if kind == "selectiveColor" {
        validate_selective(object)?;
    }
    photocraft_engine::adjust_params::from_params(kind, params, None, photocraft_doc::ColorMode::Rgb)
        .map_err(|failure| error("image.adjustments", failure))?;
    Ok(())
}

/// 校验自动/匹配命令参数（键、类型、取值范围；这些命令没有独立的参数解析器）。
pub fn validate_command(id: &str, params: &Value) -> Result<()> {
    let allowed = command_allowed_keys(id).ok_or_else(|| error("image.adjustments", format!("{id} 不是已实现的调整命令")))?;
    validate_object("image.adjustments", params, allowed, false)?;
    let Some(object) = params.as_object() else { return Ok(()) };
    match id {
        "image.adjustments.shadowsHighlights" => {
            for (key, lo, hi) in [
                ("shadowAmount", 0.0, 100.0),
                ("shadowTone", 0.0, 100.0),
                ("shadowRadius", 0.0, 2500.0),
                ("highlightAmount", 0.0, 100.0),
                ("highlightTone", 0.0, 100.0),
                ("highlightRadius", 0.0, 2500.0),
                ("color", -100.0, 100.0),
                ("midtone", -100.0, 100.0),
                ("blackClip", 0.0, 50.0),
                ("whiteClip", 0.0, 50.0),
            ] {
                validate_number(object, key, lo, hi)?;
            }
        }
        "image.adjustments.replaceColor" => {
            validate_flag(object, "localized")?;
            validate_color(object, "color")?;
            for (key, lo, hi) in [
                ("fuzziness", 0.0, 200.0),
                ("range", 0.0, 100.0),
                ("hue", -180.0, 180.0),
                ("saturation", -100.0, 100.0),
                ("lightness", -100.0, 100.0),
            ] {
                validate_number(object, key, lo, hi)?;
            }
            if let Some(points) = object.get("points") {
                validate_sample_points(points)?;
            }
            // 局部化颜色聚类没有取色点就无从限定范围，上游命令会直接报错。
            if object.get("localized").and_then(Value::as_bool) == Some(true) && object.get("points").is_none() {
                return Err(error("image.adjustments", "局部化颜色聚类需要取色点 points"));
            }
        }
        "image.adjustments.matchColor" => {
            for (key, lo, hi) in [("luminance", 1.0, 200.0), ("intensity", 1.0, 200.0), ("fade", 0.0, 100.0)] {
                validate_number(object, key, lo, hi)?;
            }
            for key in ["neutralize", "useSelectionInSource", "useSelectionInTarget"] {
                validate_flag(object, key)?;
            }
            // 来源是**会话文档索引**与图层 id；这里只校验结构，存在性由草稿按冻结快照核对
            // （草稿是唯一知道打开列表的地方，这里不复制一份文档表）。
            if let Some(source) = object.get("source")
                && !source.as_i64().is_some_and(|index| index >= 0) {
                return Err(error("image.adjustments", "匹配来源 source 必须是非负文档索引"));
            }
            if let Some(layer) = object.get("sourceLayer")
                && !layer.as_u64().is_some_and(|id| id > 0) {
                return Err(error("image.adjustments", "匹配来源层 sourceLayer 必须是图层 id"));
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_number(object: &serde_json::Map<String, Value>, key: &str, lo: f64, hi: f64) -> Result<()> {
    let Some(value) = object.get(key) else { return Ok(()) };
    if value.as_f64().is_some_and(|value| value.is_finite() && (lo..=hi).contains(&value)) {
        return Ok(());
    }
    Err(error("image.adjustments", format!("{key} 必须是 {lo}–{hi} 之间的数值")))
}

fn validate_flag(object: &serde_json::Map<String, Value>, key: &str) -> Result<()> {
    let Some(value) = object.get(key) else { return Ok(()) };
    if value.is_boolean() {
        return Ok(());
    }
    Err(error("image.adjustments", format!("{key} 必须是 true 或 false")))
}

/// 颜色：`"#rrggbb"` 或 `[r, g, b]`（0–1）。
fn validate_color(object: &serde_json::Map<String, Value>, key: &str) -> Result<()> {
    let Some(value) = object.get(key) else { return Ok(()) };
    if let Some(text) = value.as_str() {
        if is_hex_color(text) {
            return Ok(());
        }
    }
    if let Some(triple) = value.as_array().filter(|triple| triple.len() == 3) {
        if triple.iter().all(|value| value.as_f64().is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))) {
            return Ok(());
        }
    }
    Err(error("image.adjustments", format!("{key} 必须是 #rrggbb 或 [r, g, b]（0–1）")))
}

/// 取色点：`[[x, y], …]`，坐标有限。
fn validate_sample_points(value: &Value) -> Result<()> {
    let points = value.as_array().ok_or_else(|| error("image.adjustments", "points 必须是 [[x, y], …]"))?;
    for point in points {
        let pair = point
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| error("image.adjustments", "points 的每一项必须是 [x, y]"))?;
        if !pair.iter().all(|value| value.as_f64().is_some_and(f64::is_finite)) {
            return Err(error("image.adjustments", "points 的坐标必须是有限数值"));
        }
    }
    Ok(())
}

fn validate_object(command: &str, params: &Value, allowed: &[&str], require_fields: bool) -> Result<()> {
    let Some(object) = params.as_object() else {
        return Err(error("image.adjustments", format!("{command} 参数必须是对象")));
    };
    // 有参数的调整必须给出非空对象；invert/自动校正这类无参数调整只接受空对象。
    if require_fields && !allowed.is_empty() && object.is_empty() {
        return Err(error("image.adjustments", "调整参数必须是非空对象"));
    }
    for (key, value) in object {
        if !allowed.contains(&key.as_str()) {
            // `layer`、`target` 等都不接受：目标属于草稿起始信息，不能由参数改写。
            return Err(error("image.adjustments", format!("{command} 不接受参数 {key}")));
        }
        if value.is_null() {
            return Err(error("image.adjustments", format!("{key} 不能为空")));
        }
    }
    Ok(())
}

/// 曲线几何：点模式 2–19 个严格递增的 `[in, out]`；铅笔模式 256 个输出级。
pub(crate) fn validate_curve(value: &Value, key: &str) -> Result<()> {
    let items = value.as_array().ok_or_else(|| error("image.adjustments", format!("{key} 必须是曲线数组")))?;
    if items.len() == photocraft_doc::adjust::CURVE_MAP_LEN {
        for item in items {
            if !item.as_f64().is_some_and(|v| v.is_finite() && (0.0..=255.0).contains(&v)) {
                return Err(error("image.adjustments", format!("{key} 的铅笔曲线输出必须在 0–255")));
            }
        }
        return Ok(());
    }
    if !(2..=photocraft_engine::adjust_params::MAX_CURVE_POINTS).contains(&items.len()) {
        return Err(error("image.adjustments", format!("{key} 需要 2–19 个控制点")));
    }
    let mut previous = -1.0;
    for point in items {
        let pair = point
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| error("image.adjustments", format!("{key} 的控制点需要输入和输出值")))?;
        let coordinate = |value: &Value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && (0.0..=255.0).contains(value))
                .ok_or_else(|| error("image.adjustments", format!("{key} 的坐标必须在 0–255")))
        };
        let x = coordinate(&pair[0])?;
        coordinate(&pair[1])?;
        if x <= previous {
            return Err(error("image.adjustments", format!("{key} 的输入值必须严格递增")));
        }
        previous = x;
    }
    // 上游解析会把间距过小的相邻点折叠；折叠后点数变化说明这组几何无法原样成立。
    let parsed = photocraft_engine::adjust_params::parse_curve("layer.setAdjustment", key, value)
        .map_err(|failure| error("image.adjustments", failure))?;
    if parsed.len() != items.len() {
        return Err(error("image.adjustments", format!("{key} 的控制点间距过小，请分开")));
    }
    Ok(())
}

/// 吸管：`{"point":"black|gray|white","at":[x,y],"size":1..101}` 或 `{…,"color":[r,g,b] 0..1}`。
fn validate_eyedropper(value: &Value) -> Result<()> {
    let object = value.as_object().ok_or_else(|| error("image.adjustments", "吸管必须是对象"))?;
    match object.get("point").and_then(Value::as_str) {
        Some("black" | "gray" | "white") => {}
        _ => return Err(error("image.adjustments", "吸管 point 必须是 black、gray 或 white")),
    }
    if let Some(color) = object.get("color") {
        let triple = color
            .as_array()
            .filter(|values| values.len() == 3)
            .ok_or_else(|| error("image.adjustments", "吸管 color 必须是 [r, g, b]"))?;
        if !triple.iter().all(|value| value.as_f64().is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v))) {
            return Err(error("image.adjustments", "吸管 color 必须在 0–1"));
        }
        return Ok(());
    }
    let Some(at) = object.get("at") else {
        return Err(error("image.adjustments", "吸管需要 at 或 color"));
    };
    let pair = at
        .as_array()
        .filter(|values| values.len() == 2)
        .ok_or_else(|| error("image.adjustments", "吸管 at 必须是 [x, y]"))?;
    if !pair.iter().all(|value| value.as_f64().is_some_and(f64::is_finite)) {
        return Err(error("image.adjustments", "吸管 at 必须是有限数值"));
    }
    if let Some(size) = object.get("size") {
        if !size.as_u64().is_some_and(|size| (1..=101).contains(&size)) {
            return Err(error("image.adjustments", "吸管 size 必须在 1–101"));
        }
    }
    Ok(())
}

/// 渐变映射站点：2–64 个 `[位置 0..1, "#rrggbb"]`，位置严格递增。
fn validate_gradient_stops(value: &Value) -> Result<()> {
    let stops = value.as_array().filter(|stops| (2..=64).contains(&stops.len())).ok_or_else(|| {
        error("image.adjustments", "渐变映射需要 2–64 个站点")
    })?;
    let mut previous = f64::NEG_INFINITY;
    for stop in stops {
        let pair = stop
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or_else(|| error("image.adjustments", "渐变站点需要位置和颜色"))?;
        let position = pair[0]
            .as_f64()
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .ok_or_else(|| error("image.adjustments", "渐变位置必须在 0–1"))?;
        if position <= previous {
            return Err(error("image.adjustments", "渐变位置必须严格递增"));
        }
        let color = pair[1].as_str().ok_or_else(|| error("image.adjustments", "渐变颜色必须是 #rrggbb"))?;
        if !is_hex_color(color) {
            return Err(error("image.adjustments", "渐变颜色必须是 #rrggbb"));
        }
        previous = position;
    }
    Ok(())
}

/// 可选颜色：范围键必须是九个之一，值是与范围对齐的 [c,m,y,k] 数组。
fn validate_selective(object: &serde_json::Map<String, Value>) -> Result<()> {
    if let Some(method) = object.get("method") {
        if !matches!(method.as_str(), Some("relative" | "absolute")) {
            return Err(error("image.adjustments", "method 必须是 relative 或 absolute"));
        }
    }
    for range in SELECTIVE_RANGES {
        if let Some(value) = object.get(range) {
            let values = value
                .as_array()
                .filter(|values| values.len() == 4)
                .ok_or_else(|| error("image.adjustments", format!("{range} 需要 4 个百分比")))?;
            if !values.iter().all(|value| value.as_f64().is_some_and(|v| v.is_finite() && (-100.0..=100.0).contains(&v))) {
                return Err(error("image.adjustments", format!("{range} 的百分比必须在 -100–100")));
            }
        }
    }
    Ok(())
}

pub(crate) fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_implemented_kind_and_command_has_a_parameter_table() {
        for kind in ADJUSTMENT_KINDS {
            assert!(allowed_keys(kind).is_some(), "{kind}");
            assert_eq!(adjustment_command(kind), format!("image.adjustments.{kind}"));
        }
        for command in ADJUSTMENT_COMMANDS {
            assert!(command_allowed_keys(command).is_some(), "{command}");
        }
        // LUT 不在本次范围：既不是类型也不是命令。
        assert!(allowed_keys("colorLookup").is_none());
        assert!(command_allowed_keys("image.adjustments.colorLookup").is_none());
        assert!(command_allowed_keys("image.adjustments.hdrToning").is_none());
    }

    #[test]
    fn publication_follows_the_single_command_gate() {
        // 本域列出全部实现，但「可开始」只由唯一命令门决定。
        for kind in open_kinds() {
            assert!(is_open(&adjustment_command(kind)), "{kind}");
        }
        for command in open_commands() {
            assert!(is_open(command), "{command}");
        }
        for kind in ADJUSTMENT_KINDS.iter().filter(|kind| !open_kinds().contains(kind)) {
            assert!(!is_open(&adjustment_command(kind)), "{kind} 未进白名单时必须关闭");
        }
    }

    #[test]
    fn level_targets_must_exist_and_be_pixel_layers() {
        let mut document = photocraft_doc::Document::with_background(
            "doc",
            photocraft_geom::Size::new(8, 8),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
            photocraft_doc::Color::rgb(0.5, 0.5, 0.5),
        );
        let raster = document.layers[0].id;
        let text = photocraft_doc::Layer::new("文字", photocraft_doc::LayerContent::Text(photocraft_doc::TextLayer::default()));
        let text_id = text.id;
        document.layers.push(text);
        assert_eq!(target_layer(&document, Some(raster.0), None).unwrap(), raster);
        assert_eq!(target_layer(&document, None, Some(raster)).unwrap(), raster);
        assert!(target_layer(&document, None, None).is_err());
        assert!(target_layer(&document, Some(u64::MAX), None).is_err());
        assert!(writable_target(&document, text_id).is_err());
        assert!(writable_target(&document, raster).is_ok());
        document.layer_mut(raster).unwrap().locks.pixels = true;
        assert!(writable_target(&document, raster).is_err());
    }

    #[test]
    fn parameter_tables_reject_unknown_keys_and_structural_breakage() {
        assert!(validate("invert", &json!({})).is_ok());
        assert!(validate("invert", &json!({"amount": 1})).is_err());
        assert!(validate("brightnessContrast", &json!({"brightness": 10})).is_ok());
        assert!(validate("brightnessContrast", &json!({"layer": 1})).is_err());
        assert!(validate("brightnessContrast", &json!({})).is_err());
        // 类型交给上游解析器：字符串不是数值，越界值则按上游字段语义夹紧。
        assert!(validate("brightnessContrast", &json!({"brightness": "10"})).is_err());
        assert!(validate("brightnessContrast", &json!({"legacy": "yes"})).is_err());
        assert!(validate("curves", &json!({"points": [[0,0],[255,255]], "red": [[0,0],[255,255]]})).is_ok());
        assert!(validate("curves", &json!({"points": [[0,0],[0,255]]})).is_err());
        let map: Vec<f64> = (0..256).map(|index| 255.0 - index as f64).collect();
        assert!(validate("curves", &json!({"points": map, "pencil": true})).is_ok());
        assert!(validate("curves", &json!({"points": [255,254,253]})).is_err());
        assert!(validate("gradientMap", &json!({"stops": [[0.0,"#000000"],[1.0,"#ffffff"]]})).is_ok());
        assert!(validate("gradientMap", &json!({"stops": [[0.0,"#000000"]]})).is_err());
        assert!(validate("gradientMap", &json!({"stops": [[1.0,"#000000"],[0.0,"#ffffff"]]})).is_err());
        assert!(validate("gradientMap", &json!({"stops": [[0.0,"#000000"],[1.0,"not-a-color"]]})).is_err());
        assert!(validate("selectiveColor", &json!({"method": "absolute", "reds": [10,-5,0,0]})).is_ok());
        assert!(validate("selectiveColor", &json!({"reds": [10,0]})).is_err());
        assert!(validate("selectiveColor", &json!({"method": "guess"})).is_err());
        // 新类型同样走白名单：错误的键与错误的类型都要拒。
        assert!(validate("exposure", &json!({"exposure": 1.5, "offset": 0.1, "gamma": 1.1})).is_ok());
        assert!(validate("exposure", &json!({"exposure": "2"})).is_err());
        assert!(validate("posterize", &json!({"levels": 6})).is_ok());
        assert!(validate("channelMixer", &json!({"red": [40,40,20,0], "monochrome": true})).is_ok());
        assert!(validate("channelMixer", &json!({"red": [40,40]})).is_err());
        assert!(validate("photoFilter", &json!({"filter": "warming85", "density": 25})).is_ok());
        assert!(validate("photoFilter", &json!({"filter": "nope"})).is_err());
        assert!(validate("colorBalance", &json!({"shadows": [10,-5,0], "preserveLuminosity": true})).is_ok());
        assert!(validate("blackWhite", &json!({"reds": 40, "tint": true, "tintColor": "#c8a06a"})).is_ok());
        assert!(validate("blackWhite", &json!({"tint": true, "tintColor": 168 })).is_err());
    }

    #[test]
    fn auto_and_matcher_parameters_are_bounded_and_source_indices_are_structural() {
        for command in ["image.autoTone", "image.autoContrast", "image.autoColor"] {
            assert!(validate_command(command, &json!({})).is_ok(), "{command}");
            assert!(validate_command(command, &json!({"radius": 2})).is_err(), "{command}");
        }
        assert!(validate_command("image.adjustments.shadowsHighlights", &json!({"shadowAmount": 40})).is_ok());
        assert!(validate_command("image.adjustments.replaceColor", &json!({"color": "#ff0000", "fuzziness": 40})).is_ok());
        assert!(validate_command("image.adjustments.replaceColor", &json!({"target": "mask"})).is_err());
        assert!(validate_command("image.adjustments.matchColor", &json!({"neutralize": true})).is_ok());
        // 来源只在这里校验结构；文档/图层是否存在由草稿对着冻结快照判定（见 `tests_direct_workflow`）。
        assert!(validate_command("image.adjustments.matchColor", &json!({"source": 0})).is_ok());
        assert!(validate_command("image.adjustments.matchColor", &json!({"source": 2, "sourceLayer": 7})).is_ok());
        assert!(validate_command("image.adjustments.matchColor", &json!({"source": -1})).is_err());
        assert!(validate_command("image.adjustments.matchColor", &json!({"source": "0"})).is_err());
        // 显式 null 与其它键一样按「不能为空」拒绝，避免把空值当成「同文档」。
        assert!(validate_command("image.adjustments.matchColor", &json!({"source": null})).is_err());
        assert!(validate_command("image.adjustments.matchColor", &json!({"sourceLayer": 3})).is_ok());
        assert!(validate_command("image.adjustments.matchColor", &json!({"useSelectionInSource": true})).is_ok());
        assert!(validate_command("image.adjustments.desaturate", &json!({})).is_ok());
        assert!(validate_command("image.adjustments.equalize", &json!({})).is_ok());
    }
}
