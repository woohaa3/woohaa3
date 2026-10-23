use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = vectorCommand)]
    pub fn vector_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.vector_command(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = vectorSnapshotJson)]
    pub fn vector_snapshot_json(&self) -> Result<String, JsValue> {
        self.inner.vector_snapshot().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 形状预设库快照（工具状态，不属于文档内容）。
    #[wasm_bindgen(js_name = vectorPresetsJson)]
    pub fn vector_presets_json(&self) -> String {
        self.inner.vector_presets().to_string()
    }

    /// 画布拖绘参数 → `shape.create` 参数；纯计算，不写文档、不推进历史。
    ///
    /// 叠加层用同一份结果画预览，松手后把它交给 `vectorCommand("shape.create", …)`。
    #[wasm_bindgen(js_name = vectorDrawParamsJson)]
    pub fn vector_draw_params_json(&self, input_json: &str) -> Result<String, JsValue> {
        self.inner.vector_draw_params(&parse_params(input_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }
}
