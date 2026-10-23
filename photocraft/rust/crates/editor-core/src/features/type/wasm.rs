use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginText)]
    pub fn begin_text(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.begin_text(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = previewText)]
    pub fn preview_text(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.preview_text(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = commitText)]
    pub fn commit_text(&mut self) -> Result<String,JsValue> {
        self.inner.commit_text().map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = textGeometry)]
    pub fn text_geometry(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.text_geometry(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelText)]
    pub fn cancel_text(&mut self) {self.inner.cancel_text();}

    /// 同源字体加载完成后、打开文档之前注册固定字体。
    #[wasm_bindgen(js_name = registerFixedFont)]
    pub fn register_fixed_font(bytes: &[u8]) -> std::result::Result<(), JsValue> {
        Editor::register_fixed_font(bytes).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = applyTypography)]
    pub fn apply_typography(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.apply_typography(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = checkFont)]
    pub fn check_font(&self, font: &str) -> Result<String, JsValue> {
        self.inner.check_font(font).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 文字域写命令（U67/U68/U69）：白名单与参数校验都在内核内完成。
    #[wasm_bindgen(js_name = typeCommand)]
    pub fn type_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.type_commands(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 文字域只读查询：不改文档、不进历史。
    #[wasm_bindgen(js_name = typeQuery)]
    pub fn type_query(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.type_query(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }
}
