//! 图层拖放的画布预览（I218）。
//!
//! 上游 `Layers Panel Options › 重排时在画布预览` 默认开启：拖动图层到新层级/位置时，画布在
//! 松开前按落点重算合成。这里用**独立候选会话**实现，不改正式文档、历史、修订或内容指纹：
//!
//! - `begin` 记录基线；
//! - `preview` 在候选文档上执行与提交完全相同的 `layer.moveTo` 参数；
//! - `cancel` 直接丢弃候选；
//! - 提交由调用方在释放时执行原本的 `layer.moveTo`（一次历史），预览本身从不写正式文档。
//!
//! 预览只处理当前活动文档；目标或图层在拖动期间失效时返回错误，画布保持上一次有效结果。

use photocraft_doc::LayerId;
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) struct ReorderPreview {
    base: DocState,
    moved: bool,
    /// 当前有效候选文档；`None` 表示还没有落点。
    pub doc: Option<std::sync::Arc<photocraft_doc::Document>>,
}

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "layer.moveTo".into(), message: message.to_string() }
}

impl ReorderPreview {
    pub fn new(base: &DocState) -> Self {
        Self { base: base.clone(), moved: false, doc: None }
    }

    pub fn is_active(&self) -> bool {
        self.moved
    }

    /// 按落点构造候选文档；参数形状与 `layer.moveTo` 完全一致。
    pub fn preview(&mut self, params: Value) -> Result<Value> {
        let fields = params.as_object().ok_or_else(|| error("重排预览参数必须是对象"))?;
        if fields.keys().any(|key| !matches!(key.as_str(), "layer" | "layers" | "target" | "position" | "copy")) {
            return Err(error("重排预览包含未开放的参数"));
        }
        let position = params.get("position").and_then(Value::as_str).unwrap_or("above");
        if !matches!(position, "above" | "below" | "into") {
            return Err(error("重排位置必须是 above、below 或 into"));
        }
        let target = params.get("target").and_then(Value::as_u64).ok_or_else(|| error("重排目标缺失"))?;
        if self.base.doc.layer(LayerId(target)).is_none() {
            return Err(error("重排目标图层已不存在"));
        }
        // 图层集合：`layers` 与 `layer` 互斥，与提交命令同规则。
        if params.get("layers").is_some() && params.get("layer").is_some() {
            return Err(error("重排预览不能同时给出 layer 和 layers"));
        }
        let ids: Vec<u64> = if let Some(layers) = params.get("layers") {
            let values = layers.as_array().filter(|values| !values.is_empty()).ok_or_else(|| error("重排图层集合不能为空"))?;
            let mut out = Vec::with_capacity(values.len());
            for value in values {
                let id = value.as_u64().ok_or_else(|| error("重排图层 id 必须是非负整数"))?;
                if out.contains(&id) { return Err(error("重排图层 id 重复")); }
                if self.base.doc.layer(LayerId(id)).is_none() { return Err(error("重排图层已不存在")); }
                out.push(id);
            }
            out
        } else {
            let id = params.get("layer").and_then(Value::as_u64)
                .or(self.base.active_layer.map(|id| id.0))
                .ok_or_else(|| error("重排图层缺失"))?;
            if self.base.doc.layer(LayerId(id)).is_none() { return Err(error("重排图层已不存在")); }
            vec![id]
        };
        let mut scratch = Session::new();
        scratch.add_document((*self.base.doc).clone(), None);
        *scratch.active_mut().unwrap() = self.base.clone();
        // 与正式提交相同的命令与参数；候选会话的历史/修订只影响候选。
        let mut commit = params.clone();
        commit.as_object_mut().unwrap().remove("layers");
        commit.as_object_mut().unwrap().remove("layer");
        commit["layers"] = json!(ids);
        scratch.execute("layer.moveTo", commit).map_err(error)?;
        let candidate = scratch.active().unwrap();
        // 预览只关心候选是否真的改变了图层结构；真正的提交仍由调用方在释放时执行一次。
        let valid = candidate.doc != self.base.doc;
        self.moved = valid;
        if !valid { return Err(error("重排没有改变图层结构")); }
        self.doc = Some(candidate.doc.clone());
        Ok(json!({ "layers": ids, "target": target, "position": position }))
    }

    pub fn cancel(&mut self) {
        self.moved = false;
        self.doc = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        let mut s = Session::new();
        s.execute("file.new", json!({ "width": 64, "height": 64 })).unwrap();
        // 背景层固定在最底下；先把三层普通图层建好，再按普通层重排。
        for name in ["底", "中", "顶"] {
            s.execute("layer.new.layer", json!({ "name": name })).unwrap();
        }
        s
    }

    #[test]
    fn preview_accepts_the_same_move_params_as_the_commit_without_touching_the_document() {
        let mut s = session();
        let before = s.active().unwrap().clone();
        let top = before.doc.layers.last().unwrap().id.0;
        // 目标用最上面的普通图层，避开「背景层必须留在最底」的原生规则。
        let below = before.doc.layers[before.doc.layers.len() - 2].id.0;
        let mut draft = ReorderPreview::new(&before);
        assert!(!draft.is_active());
        let result = draft.preview(json!({ "layers": [top], "target": below, "position": "below" })).unwrap();
        assert_eq!(result["position"], "below");
        assert!(draft.is_active());
        // 正式会话完全未变。
        assert_eq!(s.active().unwrap().doc, before.doc);
        assert_eq!(s.active().unwrap().revision, before.revision);
        assert_eq!(s.active().unwrap().history.past_len(), before.history.past_len());
    }

    #[test]
    fn preview_rejects_missing_targets_and_unknown_fields_before_any_state_change() {
        let mut s = session();
        let before = s.active().unwrap().clone();
        let mut draft = ReorderPreview::new(&before);
        for params in [
            json!({ "layers": [1], "target": 9999, "position": "below" }),
            json!({ "layers": [1], "target": 2, "position": "beside" }),
            json!({ "layers": [1], "layer": 2, "target": 2 }),
            json!({ "target": 2 }),
            json!({ "layers": [], "target": 2 }),
            json!({ "layers": [1, 1], "target": 2 }),
            json!({ "layers": [1], "target": 2, "animate": true }),
        ] {
            assert!(draft.preview(params).is_err());
            assert!(!draft.is_active());
        }
        assert_eq!(s.active().unwrap().doc, before.doc);
    }

    #[test]
    fn moving_into_own_descendant_is_refused_by_the_native_rules() {
        let mut s = session();
        s.execute("layer.new.group", json!({ "name": "组" })).unwrap();
        let before = s.active().unwrap().clone();
        let group = before.doc.layers.last().unwrap().id.0;
        let child = before.doc.layers.first().unwrap().id.0;
        let mut draft = ReorderPreview::new(&before);
        // 把祖先移入自己的后代必须被拒绝（与提交命令一致），预览保持不活跃。
        assert!(draft.preview(json!({ "layers": [group], "target": child, "position": "into" })).is_err());
        assert!(!draft.is_active());
        draft.cancel();
        assert!(!draft.is_active());
    }
}
