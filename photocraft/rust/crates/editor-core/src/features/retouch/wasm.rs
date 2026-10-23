//! 修饰域的 wasm-bindgen 绑定（change: 2026-10-22-add-photocraft-retouch-workflows）。
//!
//! 只做 JSON/字符串转换；所有逻辑在 [`crate::Editor`] 上可原生测试。命名与
//! `packages/editor/src/features/retouch/wasm-instance.ts` 的签名逐项一致。
use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginRetouch)]
    pub fn begin_retouch(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .begin_retouch(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = appendRetouch)]
    pub fn append_retouch(&mut self, points_json: &str) -> Result<String, JsValue> {
        self.inner
            .append_retouch(parse_params(points_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = commitRetouch)]
    pub fn commit_retouch(&mut self) -> Result<String, JsValue> {
        self.inner.commit_retouch().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelRetouch)]
    pub fn cancel_retouch(&mut self) -> String {
        self.inner.cancel_retouch().to_string()
    }

    #[wasm_bindgen(js_name = retouchStateJson)]
    pub fn retouch_state_json(&self) -> String {
        self.inner.retouch_state().to_string()
    }

    /// 区域修饰（修补／内容识别移动／红眼）：开始算出候选，不写正式文档。
    #[wasm_bindgen(js_name = beginRetouchRegion)]
    pub fn begin_retouch_region(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .begin_retouch_region(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 确认区域修饰：一步历史；无变化不新增历史。
    #[wasm_bindgen(js_name = commitRetouchRegion)]
    pub fn commit_retouch_region(&mut self) -> Result<String, JsValue> {
        self.inner
            .commit_retouch_region()
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 取消区域修饰：丢弃候选。
    #[wasm_bindgen(js_name = cancelRetouchRegion)]
    pub fn cancel_retouch_region(&mut self) -> String {
        self.inner.cancel_retouch_region().to_string()
    }

    /// 历史画笔可用的历史源（只读）。
    #[wasm_bindgen(js_name = retouchHistorySourcesJson)]
    pub fn retouch_history_sources_json(&self) -> Result<String, JsValue> {
        self.inner
            .retouch_history_sources()
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 仿制源槽位与叠加选项（只读；落笔期间也可查询，见 `retouch_clone_sources`）。
    #[wasm_bindgen(js_name = retouchCloneSourcesJson)]
    pub fn retouch_clone_sources_json(&mut self) -> Result<String, JsValue> {
        self.inner
            .retouch_clone_sources()
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }
}
