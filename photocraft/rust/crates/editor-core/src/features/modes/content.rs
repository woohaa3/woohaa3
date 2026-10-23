//! 图像模式与调色板的内容身份贡献
//! （change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2 / design D1b）。
//!
//! ## 为什么需要这一块
//!
//! `document_content::project_content` 只折叠画布、图层与图案，不含 `mode`/`depth`/`color_table`/
//! `duotone`。实测后果：模式转换会顺带改变内容指纹（像素通道布局变了），但**改颜色表或改油墨
//! 不会**——文档不会被标脏，保存会漏掉这类修改。
//!
//! 本模块提供该缺口所需的全部**本域**部分：把模式数据折叠成确定性文本，供集成方在
//! `document_content::project_content` 里追加一行（`content["mode"] = ...`）并在
//! `identity::canonicalize` 里追加 `mode` 行。写在这一侧而不是共享文件，是因为
//! `parallel-work.md` 明确把「内容描述/身份贡献」划归本域；共享的折叠入口仍由集成负责人按序合入。
//!
//! ## 旧工程兼容
//!
//! 缺省值（RGB、8 位、无颜色表、无油墨）**不产生任何行**，返回 `Some(String::new())`。这样
//! 旧工程、以及本次未改模式的工程，指纹逐字节不变；只有真正使用了灰度/位图/索引色/双色调的
//! 工程才新增一行。
//!
//! ## 跨语言一致
//!
//! 文本格式与 `packages/protocol/src/features/modes/content.ts::canonicalizeMode` 逐字节一致，
//! 由两端共读 `packages/protocol/src/features/modes/content-fixtures.json` 保证；数值一律用
//! **整数**表示（8 位色 `0..=255`，油墨分量与曲线 `0..=10000`），避免浮点格式化差异。

use photocraft_doc::{ColorMode, Document, SampleType};
use serde_json::{json, Value};

use super::mode;

/// 油墨分量与曲线控制点的整数精度（`0..=10000` 对应 `0.0..=1.0`）。
const INK_SCALE: f64 = 10_000.0;

fn hex_of(color: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2])
}

fn hex_of_unit(color: [f32; 3]) -> Option<String> {
    let to = |value: f32| {
        let scaled = (f64::from(value) * 255.0).round();
        if !scaled.is_finite() || !(0.0..=255.0).contains(&scaled) {
            None
        } else {
            Some(scaled as u8)
        }
    };
    Some(hex_of([to(color[0])?, to(color[1])?, to(color[2])?]))
}

/// 模式数据的 JSON 侧写法（集成时写进 `project_content` 的 `mode` 字段）。
///
/// 返回 `None` 表示缺省（RGB/8 位/无表/无油墨），调用方不应写入任何字段。
pub fn mode_json(doc: &Document) -> Option<Value> {
    // 范围外的颜色模型（CMYK/Lab/多通道）本域不判定，也不产生任何行：一旦写成 `"other"`，
    // `canonicalize_mode` 会判为不可判定，整份内容指纹随之算不出来（实测 `modeInfo`/
    // `contentHash` 直接报 no-document，是本次改动引入的真实回归）。
    let mode = mode::mode_id(doc.mode)?;
    let mut value = serde_json::Map::new();
    value.insert("mode".into(), json!(mode));
    if doc.depth != SampleType::U8 {
        value.insert("depthBits".into(), json!(doc.depth.bits()));
    }
    if let Some(table) = doc.color_table.as_ref() {
        value.insert(
            "colorTable".into(),
            json!({
                "colors": table.colors.iter().map(|entry| hex_of(*entry)).collect::<Vec<_>>(),
                "transparent": table.transparent
            }),
        );
    }
    if let Some(duotone) = doc.duotone.as_ref() {
        value.insert(
            "duotone".into(),
            json!({
                "inks": duotone
                    .inks
                    .iter()
                    .map(|ink| json!({
                        "name": ink.name,
                        "color": hex_of_unit(ink.color),
                        "curve": ink
                            .curve
                            .iter()
                            .map(|point| json!([f64::from(point.input), f64::from(point.output)]))
                            .collect::<Vec<_>>()
                    }))
                    .collect::<Vec<_>>()
            }),
        );
    }
    if value.len() == 1 && value["mode"] == json!("rgb") {
        return None;
    }
    Some(Value::Object(value))
}

/// 把模式数据规范化为确定性文本；缺省返回 `Some("")`，非法结构返回 `None`。
pub fn canonicalize_mode(content: Option<&Value>) -> Option<String> {
    let Some(value) = content.filter(|value| !value.is_null()) else {
        return Some(String::new());
    };
    let object = value.as_object()?;
    // 未知键意味着调用方与内核的理解不一致：不可判定，绝不当作「无变化」。
    if object.keys().any(|key| !matches!(key.as_str(), "mode" | "depthBits" | "colorTable" | "duotone")) {
        return None;
    }
    let mode = object.get("mode")?.as_str()?;
    if !mode::TARGETS.contains(&mode) {
        return None;
    }
    let depth = match object.get("depthBits") {
        None => 8,
        Some(value) => match value.as_u64()? {
            8 | 16 | 32 => value.as_u64()?,
            _ => return None,
        },
    };
    let mut text = if depth == 8 { format!("mode:{mode}") } else { format!("mode:{mode}:{depth}") };
    // 显式写出的缺省值（RGB/8 位/无表/无油墨）与省略等价：旧工程身份不因序列化差异而变。
    if mode == "rgb"
        && depth == 8
        && object.get("colorTable").is_none_or(Value::is_null)
        && object.get("duotone").is_none_or(Value::is_null)
    {
        return Some(String::new());
    }
    match object.get("colorTable") {
        None | Some(Value::Null) => {
            if mode == "indexed" {
                return None; // 索引色必须带颜色表，否则结构不可判定。
            }
        }
        Some(table) => {
            if mode != "indexed" {
                return None;
            }
            let table = table.as_object()?;
            if table.keys().any(|key| !matches!(key.as_str(), "colors" | "transparent")) {
                return None;
            }
            let colors = table.get("colors")?.as_array()?;
            if colors.is_empty() || colors.len() > mode::MAX_TABLE_COLORS {
                return None;
            }
            let mut entries = Vec::with_capacity(colors.len());
            for color in colors {
                let color = color.as_str()?;
                if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
                    return None;
                }
                entries.push(color.to_ascii_lowercase());
            }
            text.push_str(&format!("|table:{}:{}", entries.len(), entries.join(",")));
            match table.get("transparent") {
                None | Some(Value::Null) => {}
                Some(value) => {
                    let index = value.as_u64()?;
                    if index >= entries.len() as u64 {
                        return None;
                    }
                    text.push_str(&format!("|transparent:{index}"));
                }
            }
        }
    }

    match object.get("duotone") {
        None | Some(Value::Null) => {
            if mode == "duotone" {
                return None; // 双色调必须带油墨。
            }
        }
        Some(duotone) => {
            if mode != "duotone" {
                return None;
            }
            let duotone = duotone.as_object()?;
            if duotone.keys().any(|key| !matches!(key.as_str(), "inks")) {
                return None;
            }
            let inks = duotone.get("inks")?.as_array()?;
            if inks.is_empty() || inks.len() > mode::MAX_INKS {
                return None;
            }
            let mut encoded = Vec::with_capacity(inks.len());
            for ink in inks {
                let ink = ink.as_object()?;
                if ink.keys().any(|key| !matches!(key.as_str(), "name" | "color" | "curve")) {
                    return None;
                }
                let name = ink.get("name")?.as_str()?;
                if name.is_empty() || name.encode_utf16().count() > mode::MAX_INK_NAME || name.chars().any(char::is_control) {
                    return None;
                }
                let color = ink.get("color")?.as_str()?.to_ascii_lowercase();
                if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
                    return None;
                }
                let points = ink.get("curve")?.as_array()?;
                if points.len() > mode::MAX_INK_CURVE_POINTS {
                    return None;
                }
                let mut curve = Vec::with_capacity(points.len());
                for point in points {
                    let point = point.as_array().filter(|point| point.len() == 2)?;
                    let input = ink_coordinate(&point[0])?;
                    let output = ink_coordinate(&point[1])?;
                    curve.push(format!("{input},{output}"));
                }
                // 名字可变长且可能含分隔符：按既有规范化的做法带 UTF-16 长度前缀。
                encoded.push(format!(
                    "{}:{name}{color}#{}:{}",
                    name.encode_utf16().count(),
                    curve.len(),
                    curve.join(";")
                ));
            }
            text.push_str(&format!("|inks:{}:{}", encoded.len(), encoded.join(",")));
        }
    }
    Some(text)
}

fn ink_coordinate(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || !(0.0..=1.0).contains(&number) {
        return None;
    }
    Some((number * INK_SCALE).round() as i64)
}

/// 文档 → 身份行；`Some("")` 表示缺省（不追加行），`None` 表示不可判定。
pub fn mode_line(doc: &Document) -> Option<String> {
    canonicalize_mode(mode_json(doc).as_ref())
}

/// 该文档的模式数据是否缺省（集成方据此决定是否写 `mode` 字段）。
pub fn is_default_mode(doc: &Document) -> bool {
    doc.mode == ColorMode::Rgb && doc.depth == SampleType::U8 && doc.color_table.is_none() && doc.duotone.is_none()
}

#[cfg(test)]
#[path = "tests_content.rs"]
mod tests;
