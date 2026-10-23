//! U63：图层过滤的剩余入口——种类、混合模式、「只显示选中层」与名称的组合条件。
//!
//! 过滤只改变图层列表的可见行，不改内容、选择或可见合成；它也不进入内容身份。
//! 与上游 0.9.0 的组合规则对齐：
//! - `by` 决定主条件（`kind` / `name` / `mode`），空值表示不过滤；
//! - `kinds` 与 `name` 可同时生效（AND），`onlySelected` 再与它们取交集；
//! - `mode` 只在 `by: "mode"` 时生效，且 `Pass Through` 只匹配组。
use photocraft_doc::{BlendMode, LayerContent};

use crate::error::{EditorError, Result};

/// 面板可选的种类 id（与上游 `KINDS` 一致，另含组的单独开关）。
pub(crate) const KINDS: [&str; 6] = ["raster", "adjustment", "text", "shape", "smart", "group"];

/// 主条件。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum FilterBy {
    #[default]
    Kind,
    Name,
    Mode,
}

impl FilterBy {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "kind" => Some(Self::Kind),
            "name" => Some(Self::Name),
            "mode" => Some(Self::Mode),
            _ => None,
        }
    }
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Kind => "kind",
            Self::Name => "name",
            Self::Mode => "mode",
        }
    }
}

/// 界面种类 id ↔ 内核种类：两边都接受，避免旧调用点失效。
pub(crate) fn canonical_kind(content: &LayerContent) -> &'static str {
    match content {
        LayerContent::Raster(_) => "raster",
        LayerContent::Group(_) => "group",
        LayerContent::Adjustment(_) | LayerContent::Fill(_) => "adjustment",
        LayerContent::Text(_) => "text",
        LayerContent::Shape(_) => "shape",
        LayerContent::Smart(_) => "smart",
    }
}

/// 一项过滤条件：全部字段同时成立（AND）。
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LayerListFilter {
    pub by: FilterBy,
    /// 名称子串（忽略大小写），空串表示不按名称过滤。
    pub name: String,
    /// 种类集合；空集表示不按种类过滤。
    pub kinds: Vec<String>,
    /// 混合模式主条件（`by: mode` 时生效）。
    pub mode: Option<BlendMode>,
    /// 只显示选中层（包含其父组，保证树形结构可读）。
    pub only_selected: bool,
}

impl LayerListFilter {
    /// 是否在过滤（未过滤时面板显示全部行）。
    pub fn active(&self) -> bool {
        self.by == FilterBy::Mode || !self.name.trim().is_empty() || !self.kinds.is_empty() || self.only_selected
    }

    /// 是否隐藏该行；`in_selected_branch` 表示该行是选中层的祖先（组），必须一起显示。
    pub fn hides(&self, name: &str, kind: &str, blend: BlendMode, selected: bool, in_selected_branch: bool) -> bool {
        if self.only_selected && !selected && !in_selected_branch {
            return true;
        }
        if !self.name.trim().is_empty() && !name.to_lowercase().contains(&self.name.trim().to_lowercase()) {
            return true;
        }
        if !self.kinds.is_empty() && !self.kinds.iter().any(|candidate| same_kind(candidate, kind)) {
            return true;
        }
        if self.by == FilterBy::Mode && self.mode.is_some_and(|mode| mode != blend) {
            return true;
        }
        false
    }
}

fn same_kind(a: &str, b: &str) -> bool {
    fn normalize(value: &str) -> String {
        match value.trim().to_ascii_lowercase().as_str() {
            "pixel" => "raster".to_string(),
            "type" => "text".to_string(),
            "smart object" => "smart".to_string(),
            other => other.to_string(),
        }
    }
    normalize(a) == normalize(b)
}

/// 解析面板参数；未知值一律拒绝并说明具体字段（不做静默降级）。
pub(crate) fn parse(params: &serde_json::Value) -> Result<LayerListFilter> {
    const ID: &str = "layer.filter-list";
    let object = params.as_object().ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "过滤参数必须为对象".into() })?;
    if let Some(key) = object.keys().find(|key| !["by", "name", "kinds", "mode", "onlySelected"].contains(&key.as_str())) {
        return Err(EditorError::CommandFailed { id: ID.into(), message: format!("过滤参数不接受 {key}") });
    }
    let by = match object.get("by") {
        None | Some(serde_json::Value::Null) => FilterBy::Kind,
        Some(value) => value.as_str().and_then(FilterBy::parse)
            .ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "by 只接受 kind、name 或 mode".into() })?,
    };
    let name = match object.get("name") {
        None | Some(serde_json::Value::Null) => String::new(),
        Some(value) => value.as_str().filter(|name| name.encode_utf16().count() <= 200)
            .ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "name 必须是 200 字符以内的字符串".into() })?
            .to_string(),
    };
    let mut kinds = Vec::new();
    if let Some(list) = object.get("kinds").filter(|value| !value.is_null()) {
        let list = list.as_array().ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "kinds 必须是数组".into() })?;
        for value in list {
            let kind = value.as_str().filter(|kind| KINDS.contains(kind))
                .ok_or_else(|| EditorError::CommandFailed {
                    id: ID.into(),
                    message: format!("kinds 只接受 {}（收到 {value}）", KINDS.join("、")),
                })?;
            if !kinds.iter().any(|have: &String| have == kind) {
                kinds.push(kind.to_string());
            }
        }
    }
    let mode = match object.get("mode").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => {
            let name = value.as_str().ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "mode 必须是混合模式名称".into() })?;
            let mode = photocraft_engine::commands::blend_from_str(name)
                .filter(|mode| *mode == BlendMode::PassThrough || BlendMode::LAYER_MODES.contains(mode))
                .ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: format!("mode 不是已开放的混合模式：{name}") })?;
            Some(mode)
        }
    };
    let only_selected = match object.get("onlySelected") {
        None | Some(serde_json::Value::Null) => false,
        Some(value) => value.as_bool().ok_or_else(|| EditorError::CommandFailed { id: ID.into(), message: "onlySelected 必须是布尔值".into() })?,
    };
    Ok(LayerListFilter { by, name, kinds, mode, only_selected })
}

/// 过滤结果里的一行；`hidden` 只表示列表显示，不表示内容或合成变化。
pub(crate) fn row(layer: &photocraft_doc::Layer, hidden: bool) -> serde_json::Value {
    serde_json::json!({
        "layer": layer.id.0,
        "name": layer.name,
        "kind": canonical_kind(&layer.content),
        "blend": layer.blend.label(),
        "labelColor": layer.label.id(),
        "hidden": hidden,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn combined_conditions_are_intersection_and_default_shows_everything() {
        let none = LayerListFilter::default();
        assert!(!none.active());
        assert!(!none.hides("背景", "raster", BlendMode::Normal, false, false));

        let filter = LayerListFilter { name: "标题".into(), kinds: vec!["text".into()], ..Default::default() };
        assert!(filter.active());
        assert!(!filter.hides("标题 1", "text", BlendMode::Normal, false, false));
        assert!(filter.hides("标题 1", "raster", BlendMode::Normal, false, false));
        assert!(filter.hides("段落", "text", BlendMode::Normal, false, false));
        // 像素层的旧调用点（Pixel / pixel）仍按种类匹配。
        let pixel = LayerListFilter { kinds: vec!["raster".into()], ..Default::default() };
        assert!(!pixel.hides("背景", "raster", BlendMode::Normal, false, false));
    }

    #[test]
    fn only_selected_keeps_ancestors_and_never_hides_the_branch() {
        let filter = LayerListFilter { only_selected: true, ..Default::default() };
        assert!(filter.active());
        assert!(filter.hides("未选", "raster", BlendMode::Normal, false, false));
        assert!(!filter.hides("已选", "raster", BlendMode::Normal, true, false));
        assert!(!filter.hides("父组", "group", BlendMode::Normal, false, true));
    }

    #[test]
    fn mode_filter_matches_blend_and_only_groups_pass_through() {
        let filter = LayerListFilter { by: FilterBy::Mode, mode: Some(BlendMode::Multiply), ..Default::default() };
        assert!(filter.active(), "mode 主条件总是过滤");
        assert!(!filter.hides("正片叠底", "raster", BlendMode::Multiply, false, false));
        assert!(filter.hides("正常", "raster", BlendMode::Normal, false, false));
        let pass = LayerListFilter { by: FilterBy::Mode, mode: Some(BlendMode::PassThrough), ..Default::default() };
        assert!(!pass.hides("组", "group", BlendMode::PassThrough, false, false));
        assert!(pass.hides("层", "raster", BlendMode::Normal, false, false));
    }

    #[test]
    fn params_are_validated_and_unknown_values_are_rejected() {
        assert!(parse(&json!({})).unwrap().kinds.is_empty());
        assert_eq!(parse(&json!({"by":"mode","mode":"multiply"})).unwrap().mode, Some(BlendMode::Multiply));
        assert!(parse(&json!({"kinds":["raster","text"]})).unwrap().kinds.len() == 2);
        for params in [
            json!(null),
            json!([]),
            json!({"by":"bogus"}),
            json!({"kinds":["shape"]}).clone(),
            json!({"kinds":"raster"}),
            json!({"mode":"nope"}),
            json!({"onlySelected":"yes"}),
            json!({"unknown":1}),
            json!({"name":"a".repeat(201)}),
        ] {
            // `shape` 是合法种类；这里的用例用未知种类检查拒绝路径。
            let result = parse(&params);
            if params == json!({"kinds":["shape"]}) {
                assert!(result.is_ok());
            } else {
                assert!(result.is_err(), "{params}");
            }
        }
        assert!(parse(&json!({"kinds":["bogus"]})).is_err());
    }
}
