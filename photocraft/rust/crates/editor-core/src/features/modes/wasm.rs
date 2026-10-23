use super::*;

/// 图像模式与调色板：只读信息、计划与应用（预览不改正式文档）。
#[wasm_bindgen]
impl WasmEditor {
    /// 当前模式、颜色表、油墨、目标矩阵与陷印状态（只读）。
    #[wasm_bindgen(js_name = modeInfo)]
    pub fn mode_info(&self) -> Result<String, JsValue> {
        self.inner.mode_info().map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// 预览模式转换：`target` 为 `rgb|grayscale|bitmap|indexed|duotone`。
    #[wasm_bindgen(js_name = planMode)]
    pub fn plan_mode(&self, target: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .plan_mode(target, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 确认模式转换：要求 `baseRevision`/`baseContentHash` 与预览时一致。
    #[wasm_bindgen(js_name = applyMode)]
    pub fn apply_mode(&mut self, target: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .apply_mode(target, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 预览颜色表编辑（仅索引色）。
    #[wasm_bindgen(js_name = planColorTable)]
    pub fn plan_color_table(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .plan_color_table(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 确认颜色表编辑（仅索引色）。
    #[wasm_bindgen(js_name = applyColorTable)]
    pub fn apply_color_table(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .apply_color_table(parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }
}
