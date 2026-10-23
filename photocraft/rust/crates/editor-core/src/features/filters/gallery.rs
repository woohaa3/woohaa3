//! 滤镜库（Filter Gallery）组合：目录、效果栈校验与规范化。
//!
//! 目录直接取上游画廊清单（分类、名称、参数记法），本模块只做三件事：
//! 1. 把目录折成面板需要的形状（`key/name/category/command/params`）；
//! 2. 校验并规范化效果栈：最多 [`MAX_EFFECTS`] 层、未知滤镜与非法参数明确拒绝；
//! 3. 给「切画廊组合」提供稳定的默认效果，使面板一打开就有真实候选图。

use serde_json::{Value, json};

use super::catalog::{self, MAX_EFFECTS, ParamKind, bad};
use crate::Result;

/// 面板默认的首次组合：两个方向相反的经典效果，直接可见差异。
pub const DEFAULT_STACK: &[(&str, &str)] = &[("cutout", "3"), ("filmGrain", "1")];

/// 画廊目录：分类 + 每个滤镜的键、名称、命令 id 与参数 schema。
pub fn catalogue() -> Value {
    let upstream = photocraft_engine::gallery_cmds::catalogue();
    let categories = upstream.get("categories").cloned().unwrap_or_else(|| json!([]));
    let filters: Vec<Value> = upstream
        .get("filters")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|filter| {
            let key = filter.get("key").and_then(Value::as_str)?;
            Some(json!({
                "key": key,
                "name": filter.get("name").cloned().unwrap_or(Value::Null),
                "category": filter.get("category").cloned().unwrap_or(Value::Null),
                "command": filter.get("command").cloned().unwrap_or(Value::Null),
                "params": catalog::gallery_params(key)
                    .unwrap_or_default()
                    .iter()
                    .map(catalog::ParamSpec::to_json)
                    .collect::<Vec<_>>(),
            }))
        })
        .collect();
    json!({ "categories": categories, "filters": filters })
}

/// 画廊滤镜是否已登记。
pub fn known(key: &str) -> bool {
    photocraft_algo::GalleryFilter::from_key(key).is_some()
}

/// 已登记的画廊滤镜键（按上游顺序）。
pub fn keys() -> impl Iterator<Item = &'static str> {
    photocraft_algo::GalleryFilter::ALL.iter().map(|filter| filter.key())
}

/// 校验单个效果层的参数：数量、未知滤镜、范围、选项与布尔。
fn validate_effect(index: usize, key: &str, params: &Value) -> Result<()> {
    let Some(schema) = catalog::gallery_params(key) else {
        return Err(bad(format!("效果 {}：未知滤镜 {key}", index + 1)));
    };
    let carries_colours = photocraft_algo::GalleryFilter::from_key(key).is_some_and(|filter| filter.uses_colours());
    if let Some(object) = params.as_object() {
        for (field, value) in object {
            if matches!(field.as_str(), "visible" | "filter" | "params")
                || (carries_colours && matches!(field.as_str(), "foreground" | "background"))
            {
                continue;
            }
            let Some(spec) = schema.iter().find(|spec| spec.key == *field) else {
                return Err(bad(format!("效果 {}：{key} 没有参数 {field}", index + 1)));
            };
            match spec.kind {
                ParamKind::Number | ParamKind::Integer => {
                    let Some(number) = value.as_f64().filter(|value| value.is_finite()) else {
                        return Err(bad(format!("效果 {}：{field} 必须是有限数值", index + 1)));
                    };
                    let (min, max) = (spec.min.unwrap_or(f64::MIN), spec.max.unwrap_or(f64::MAX));
                    if number < min || number > max {
                        return Err(bad(format!("效果 {}：{field} 必须在 {min}–{max} 之间", index + 1)));
                    }
                }
                ParamKind::Choice => {
                    let Some(name) = value.as_str() else {
                        return Err(bad(format!("效果 {}：{field} 必须是选项名", index + 1)));
                    };
                    if !spec.choices.iter().any(|choice| choice == name) {
                        return Err(bad(format!("效果 {}：{field} 必须是 {} 之一", index + 1, spec.choices.join("/"))));
                    }
                }
                ParamKind::Bool => {
                    if !value.is_boolean() {
                        return Err(bad(format!("效果 {}：{field} 必须是布尔值", index + 1)));
                    }
                }
                ParamKind::Color => {
                    let ok = match value {
                        Value::String(text) => {
                            text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
                        }
                        Value::Array(items) => (3..=4).contains(&items.len()),
                        _ => false,
                    };
                    if !ok {
                        return Err(bad(format!("效果 {}：{field} 必须是 #rrggbb", index + 1)));
                    }
                }
                ParamKind::Resource => super::geometry::validate_resource(
                    catalog::entry("filter.filterGallery").expect("gallery entry"),
                    field,
                    value,
                )?,
            }
        }
    }
    Ok(())
}

/// 校验 `filter.filterGallery` 的效果栈。
pub(super) fn validate_stack(params: &Value) -> Result<()> {
    let Some(effects) = params.get("effects") else {
        return Err(bad("滤镜库需要至少一个效果"));
    };
    let effects = effects.as_array().ok_or_else(|| bad("effects 必须是数组"))?;
    // 组合级的前景/背景色是每个效果的颜色兜底，校验必须与内核读数同源。
    if let Some(entry) = catalog::entry("filter.filterGallery") {
        for key in ["foreground", "background"] {
            if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
                super::geometry::validate_resource(entry, key, value)?;
            }
        }
    }
    if effects.is_empty() {
        return Err(bad("滤镜库需要至少一个效果"));
    }
    if effects.len() > MAX_EFFECTS {
        return Err(bad(format!("滤镜库最多 {MAX_EFFECTS} 个效果")));
    }
    let mut visible = 0usize;
    for (index, effect) in effects.iter().enumerate() {
        let Some(object) = effect.as_object() else {
            return Err(bad(format!("效果 {} 必须是对象", index + 1)));
        };
        let Some(key) = object.get("filter").and_then(Value::as_str) else {
            return Err(bad(format!("效果 {} 缺少 filter", index + 1)));
        };
        let nested = object.get("params").filter(|value| value.is_object());
        validate_effect(index, key, nested.unwrap_or(effect))?;
        if object.get("visible").and_then(Value::as_bool) != Some(false) {
            visible += 1;
        }
    }
    if visible == 0 {
        return Err(bad("滤镜库至少要有一个可见效果"));
    }
    Ok(())
}

/// 规范化效果栈：去掉未知字段，补齐 `params`/`visible`，供草稿与「重复上次」保存。
pub fn normalize_stack(params: &Value) -> Result<Value> {
    validate_stack(params)?;
    let effects = params
        .get("effects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(effects.len());
    for effect in effects {
        let key = effect.get("filter").and_then(Value::as_str).unwrap_or_default().to_string();
        let given = effect
            .get("params")
            .filter(|value| value.is_object())
            .unwrap_or(&effect);
        let mut params = serde_json::Map::new();
        for spec in catalog::gallery_params(&key).unwrap_or_default() {
            let value = given.get(&spec.key).cloned().or(spec.default);
            if let Some(value) = value {
                params.insert(spec.key, value);
            }
        }
        out.push(json!({
            "filter": key,
            "params": Value::Object(params),
            "visible": effect.get("visible").and_then(Value::as_bool).unwrap_or(true),
        }));
    }
    let mut object = serde_json::Map::new();
    for key in ["foreground", "background"] {
        if let Some(value) = params.get(key) {
            object.insert(key.into(), value.clone());
        }
    }
    object.insert("effects".into(), Value::Array(out));
    Ok(Value::Object(object))
}

/// 默认组合（面板首次打开就有效，可立即预览）。
pub fn default_stack() -> Value {
    let effects: Vec<Value> = DEFAULT_STACK
        .iter()
        .filter_map(|(key, index)| {
            let schema = catalog::gallery_params(key)?;
            let mut params = serde_json::Map::new();
            for spec in schema {
                params.insert(spec.key.clone(), spec.default?);
            }
            // 每个默认效果换一个非默认值，避免「组合和单层完全一样」看不出差异。
            if let Some(last) = params.keys().next().cloned()
                && let Some(spec) = catalog::gallery_params(key)?.into_iter().find(|spec| spec.key == last)
                && spec.kind == ParamKind::Choice
                && spec.choices.len() > 1
            {
                params.insert(last, Value::String(spec.choices[1].clone()));
            }
            let _ = index;
            Some(json!({ "filter": key, "params": Value::Object(params), "visible": true }))
        })
        .collect();
    json!({ "effects": effects })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_matches_the_upstream_gallery() {
        let catalogue = catalogue();
        let filters = catalogue["filters"].as_array().expect("filters");
        assert_eq!(filters.len(), photocraft_algo::GalleryFilter::ALL.len());
        for filter in filters {
            let key = filter["key"].as_str().expect("key");
            assert!(known(key));
            assert!(filter["command"].as_str().expect("command").starts_with("filter.gallery."));
            assert!(!filter["params"].as_array().expect("params").is_empty(), "{key} 无参数 schema");
        }
        assert!(catalogue["categories"].as_array().expect("categories").len() >= 6);
    }

    #[test]
    fn stacks_are_bounded_and_explicit() {
        assert!(validate_stack(&json!({})).is_err());
        assert!(validate_stack(&json!({"effects": []})).is_err());
        let too_many: Vec<Value> = (0..33).map(|_| json!({"filter": "cutout"})).collect();
        assert!(validate_stack(&json!({"effects": too_many})).is_err());
        assert!(validate_stack(&json!({"effects": [{"filter": "nope"}]})).is_err());
        assert!(validate_stack(&json!({"effects": [{"filter": "cutout", "visible": false}]})).is_err());
        assert!(validate_stack(&json!({"effects": [{"filter": "cutout"}]})).is_ok());
        assert!(validate_stack(&json!({"effects": [{"filter": "cutout", "numberOfLevels": 99}]})).is_err());
        assert!(validate_stack(&json!({"effects": [{"filter": "cutout", "edgeFidelity": "2"}]})).is_err());
    }

    #[test]
    fn stacks_accept_the_colour_fallback_but_reject_non_colours() {
        assert!(validate_stack(&json!({"foreground": "#3366cc", "effects": [{"filter": "cutout"}]})).is_ok());
        assert!(validate_stack(&json!({"foreground": "blue", "effects": [{"filter": "cutout"}]})).is_err());
        // 只有读取颜色的画廊滤镜接受 per-effect 颜色；其余仍按未知参数拒绝。
        assert!(validate_stack(&json!({"effects": [{"filter": "basRelief", "params": {"foreground": "#3366cc"}}]})).is_ok());
        assert!(validate_stack(&json!({"effects": [{"filter": "cutout", "params": {"foreground": "#3366cc"}}]})).is_err());
    }

    #[test]
    fn normalization_fills_every_documented_param() {
        let normalized = normalize_stack(&json!({"effects": [{"filter": "cutout", "params": {"numberOfLevels": 5}}]}))
            .expect("normalized");
        let effect = &normalized["effects"][0];
        assert_eq!(effect["filter"], json!("cutout"));
        assert_eq!(effect["visible"], json!(true));
        assert_eq!(effect["params"]["numberOfLevels"].as_f64(), Some(5.0));
        assert!(effect["params"]["edgeFidelity"].is_number());
        assert!(effect["params"]["edgeSimplicity"].is_number());
    }

    #[test]
    fn default_stack_is_valid_and_previewable() {
        let stack = default_stack();
        assert!(validate_stack(&stack).is_ok());
        assert_eq!(stack["effects"].as_array().expect("effects").len(), DEFAULT_STACK.len());
        assert!(stack["effects"].as_array().expect("effects").iter().all(|effect| effect["visible"] == json!(true)));
    }

    #[test]
    fn every_gallery_key_is_catalogued() {
        for key in keys() {
            assert!(catalog::contains(&format!("filter.gallery.{key}")), "{key} 未登记");
        }
    }
}
