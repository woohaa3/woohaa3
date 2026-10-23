use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = viewAidsJson)]
    pub fn view_aids_json(&self) -> String {
        self.inner.view_aids().to_string()
    }

    #[wasm_bindgen(js_name = setViewAids)]
    pub fn set_view_aids(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.set_view_aids(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = snapPoint)]
    pub fn snap_point(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner.snap_point(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = guideCommand)]
    pub fn guide_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.guide_command(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 参考线布局与画布参考线（U71）。
    #[wasm_bindgen(js_name = guideLayoutCommand)]
    pub fn guide_layout_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.guide_layout_command(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 本域统一写入口：逐项声明的视图/分析命令（U70–U73）。
    #[wasm_bindgen(js_name = viewCommand)]
    pub fn view_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.view_command(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 视图与分析只读快照（参考线、原点、旋转投影、取样点、测量、计数、注释）。
    #[wasm_bindgen(js_name = viewSnapshotJson)]
    pub fn view_snapshot_json(&self) -> Result<String, JsValue> {
        self.inner.view_snapshot().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 单个取样点的真实源像素读数。
    #[wasm_bindgen(js_name = samplerReadoutJson)]
    pub fn sampler_readout_json(&self, index: usize) -> Result<String, JsValue> {
        self.inner.sampler_readout(index).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 长度按当前标尺单位格式化（Info/标尺显示，不改文档）。
    #[wasm_bindgen(js_name = formatLengthJson)]
    pub fn format_length_json(&self, params_json: &str) -> Result<String, JsValue> {
        let params = parse_params(params_json)?;
        let px = params.get("px").and_then(serde_json::Value::as_f64).unwrap_or(f64::NAN);
        let unit = params.get("unit").and_then(serde_json::Value::as_str).unwrap_or("px");
        let state = self.inner.active_doc().map_err(|e| js_error(&e))?;
        let value = crate::composition::format_length(
            px,
            unit,
            f64::from(state.doc.resolution_dpi),
            f64::from(state.doc.size.width.max(1)),
        )
        .ok_or_else(|| js_error(&crate::error::EditorError::CommandFailed {
            id: "view.analysis".into(),
            message: format!("无法把 {px} px 换算成 {unit}"),
        }))?;
        Ok(serde_json::json!({ "text": value, "unit": unit }).to_string())
    }

    /// 画布指针几何：参考线命中/拖动、标尺原点拖动与 Info 源像素读数（U70–U73）。
    ///
    /// `action` = `hit-guide` | `drag-guide` | `drag-origin` | `probe`；参数是**客户坐标**，
    /// 返回源坐标结果。全部只读：不改文档、不造历史。
    #[wasm_bindgen(js_name = viewPointerJson)]
    pub fn view_pointer_json(&self, action: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .view_pointer(action, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }
}
