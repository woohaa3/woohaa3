use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginAdjustment)]
    pub fn begin_adjustment(&mut self, layer: u32) -> Result<String,JsValue> {
        self.inner.begin_adjustment(u64::from(layer)).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    /// 图像 ▸ 调整（直接像素调整）：`target` 是调整类型或自动/匹配命令 id，
    /// `layer` 为 `undefined` 时用活动层。
    #[wasm_bindgen(js_name = beginDirectAdjustment)]
    pub fn begin_direct_adjustment(&mut self, target: &str, params_json: &str, layer: Option<u32>) -> Result<String,JsValue> {
        self.inner.begin_direct_adjustment(target, parse_params(params_json)?, layer.map(u64::from)).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    /// 直接调整可用目标（只含已开放命令），供界面渲染真实入口。
    #[wasm_bindgen(js_name = directAdjustmentTargetsJson)]
    pub fn direct_adjustment_targets(&self) -> String {
        self.inner.direct_adjustment_targets().to_string()
    }

    #[wasm_bindgen(js_name = previewAdjustment)]
    pub fn preview_adjustment(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.preview_adjustment(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = commitAdjustment)]
    pub fn commit_adjustment(&mut self) -> Result<String,JsValue> {
        self.inner.commit_adjustment().map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelAdjustment)]
    pub fn cancel_adjustment(&mut self) {self.inner.cancel_adjustment();}

    #[wasm_bindgen(js_name = curveGeometry)]
    pub fn curve_geometry(&self, points_json: &str) -> Result<String,JsValue> {
        self.inner.curve_geometry(parse_params(points_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    /// 直方图采样（只读；结果带 `generation`）。
    #[wasm_bindgen(js_name = histogram)]
    pub fn histogram(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner.histogram(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }
}
