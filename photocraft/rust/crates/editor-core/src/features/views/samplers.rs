//! 持久颜色采样点（U73）。
//!
//! ## 为什么需要这一层
//!
//! 上游 `view.colorSamplers.*` 是**会话视图状态**（`DocState::color_samplers`），代码注释
//! 明确写「not saved to `.pcraft` or PSD」。但 U73 的要求是「保存的点可重开」，所以本域必须
//! 自己给这些点一个持久位置。
//!
//! 不改 vendor 文档格式：`Document::metadata.text` 是上游已有的、随 `.pcraft` 清单往返的
//! 自由文本键值表（PNG tEXt / TIFF ASCII 用的同一个结构），本域在其中用一个**命名空间键**
//! `photocraft.views.colorSamplers` 存 JSON。
//!
//! ## 为什么不是「随便塞个字段」
//!
//! - **有界**：写入前逐点校验数量（[`MAX_SAMPLERS`]）、坐标有限且在文档内；读回时同样校验，
//!   超限或坏数据只当作「没有持久采样点」，绝不让一份工程因为视图数据打不开。
//! - **向后兼容**：键不存在 = 旧工程，什么都不做；其它工具写的同名键若不合法也忽略。
//! - **不改内容身份**：`metadata` 不参与内容指纹（`document_content::project_content` 只覆盖
//!   图层与画布），所以增删采样点仍不改 `contentHash`、不造 dirty——与会话语义一致。
//! - **不污染像素**：只写元数据，不碰任何图层内容。
//!
//! ## 与会话状态的关系
//!
//! 载入时把持久点灌回 `color_samplers`（下游命令、`samplerReadout`、面板都照旧读会话状态）；
//! 保存前把当前会话点写回元数据。两者是**同一份数据的两个投影**，不是两套独立真值。
//!
//! 工程字节的校验在 `photocraft-project-verify`：那里有一份同样的边界判断（两个 crate 不能
//! 互相依赖），`tests_views.rs` 用同一批样例交叉核对两边的结论一致。

use photocraft_doc::Document;
use serde_json::{json, Value};

/// metadata 里的键名。带命名空间前缀，避免与用户/其它工具的 tEXt 键冲突。
pub const SAMPLERS_KEY: &str = "photocraft.views.colorSamplers";

/// 每个文档最多多少个持久采样点（与上游 `MAX_SAMPLERS` 一致）。
pub const MAX_SAMPLERS: usize = 10;

/// 坐标绝对上限（与参考线同量级：远超任何真实画布，但排除 `1e300` 这类溢出值）。
pub const MAX_COORD: f64 = 1.0e7;

/// 把会话里的采样点写成文档元数据项。
///
/// `None` 表示**删除**这个键（没有采样点时不留下空数组，保持旧工程的字节形状）。
pub fn samplers_value(points: &[[f64; 2]]) -> Option<String> {
    if points.is_empty() || points.len() > MAX_SAMPLERS {
        return None;
    }
    if !points.iter().all(|point| {
        point[0].is_finite() && point[1].is_finite()
            && point[0].abs() <= MAX_COORD && point[1].abs() <= MAX_COORD
    }) {
        return None;
    }
    let list: Vec<Value> = points.iter().map(|point| json!([point[0], point[1]])).collect();
    Some(json!({ "points": list }).to_string())
}

/// 把文档元数据里的采样点读回来。
///
/// 任何不自洽的输入都返回空列表：旧工程没有这个键、被别的工具改写、超过上限、坐标非法，
/// 都按「这份工程没有持久采样点」处理，而不是让工程打不开或灌进越界坐标。
pub fn samplers_from_metadata(entries: &[(String, String)]) -> Vec<[f64; 2]> {
    let Some(raw) = entries.iter().find(|(key, _)| key == SAMPLERS_KEY).map(|(_, value)| value) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(points) = parsed.get("points").and_then(Value::as_array) else {
        return Vec::new();
    };
    if points.len() > MAX_SAMPLERS {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(points.len());
    for point in points {
        let Some(pair) = point.as_array().filter(|pair| pair.len() == 2) else {
            return Vec::new();
        };
        let (Some(x), Some(y)) = (pair[0].as_f64(), pair[1].as_f64()) else {
            return Vec::new();
        };
        if !x.is_finite() || !y.is_finite() || x.abs() > MAX_COORD || y.abs() > MAX_COORD {
            return Vec::new();
        }
        out.push([x, y]);
    }
    out
}

/// 把当前会话的采样点写进文档元数据（幂等）。
///
/// 只改 `metadata.text` 里本域的那一条，其它键原样保留、顺序不变——采样点是可选附加数据，
/// 不该重排用户/其它工具写入的元数据。
pub fn apply_metadata(document: &mut Document, points: &[[f64; 2]]) {
    let value = samplers_value(points);
    let entries = &mut document.metadata.text;
    let position = entries.iter().position(|(key, _)| key == SAMPLERS_KEY);
    match (value, position) {
        (Some(value), Some(index)) => entries[index].1 = value,
        (Some(value), None) => entries.push((SAMPLERS_KEY.to_string(), value)),
        (None, Some(index)) => {
            entries.remove(index);
        }
        (None, None) => {}
    }
}
