//! 图层列表过滤：只影响显示，不改层树、选择或渲染。
//!
//! 组合规则只在 [`super::layer_filter_domain::LayerListFilter`] 维护一份；这里的
//! [`LayerFilter`] 是早期三字段调用点（名称/种类/只选中）的适配层，规则仍然委托过去，
//! 避免出现两套不一致的过滤语义。
use crate::features::layers::layer_filter_domain::{self, LayerListFilter};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct LayerFilter {
    pub name: String,
    /// 内核种类（`raster` / `text` / `adjustment` / `group` / `smart` / `shape`）；空集表示全部。
    pub kinds: Vec<String>,
    /// 只显示选中层。
    pub only_selected: bool,
}

impl LayerFilter {
    fn inner(&self) -> LayerListFilter {
        LayerListFilter {
            by: layer_filter_domain::FilterBy::Kind,
            name: self.name.clone(),
            kinds: self.kinds.clone(),
            mode: None,
            only_selected: self.only_selected,
        }
    }

    /// 是否过滤掉该层（不带混合模式条件的三字段调用点）。
    pub fn hides(&self, name: &str, kind: &str, selected: bool) -> bool {
        self.inner().hides(name, kind, photocraft_doc::BlendMode::Normal, selected, false)
    }

    pub fn active(&self) -> bool {
        self.inner().active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_keeps_the_three_field_contract() {
        let filter = LayerFilter { name: String::new(), kinds: vec!["raster".into()], only_selected: false };
        assert!(!filter.hides("背景", "raster", false));
        assert!(filter.hides("标题", "text", false));
        assert!(!filter.hides("背景", "Pixel", false));
        assert!(!filter.hides("背景", "pixel", false));
        let selected = LayerFilter { only_selected: true, ..Default::default() };
        assert!(selected.hides("未选", "raster", false));
        assert!(!selected.hides("已选", "raster", true));
        assert!(!LayerFilter::default().active());
    }
}
