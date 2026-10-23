use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginCompose)]
    pub fn begin_compose(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .begin_compose(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateCompose)]
    pub fn update_compose(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_compose(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = commitCompose)]
    pub fn commit_compose(&mut self) -> Result<String, JsValue> {
        self.inner.commit_compose().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelCompose)]
    pub fn cancel_compose(&mut self) -> String {
        self.inner.cancel_compose().to_string()
    }

    #[wasm_bindgen(js_name = beginTransform)]
    pub fn begin_transform(&mut self) -> Result<(), JsValue> {
        self.inner.begin_transform().map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = beginMove)]
    pub fn begin_move(&mut self, params_json: &str) -> Result<bool, JsValue> {
        self.inner.begin_move(parse_params(params_json)?).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = previewTransform)]
    pub fn preview_transform(&mut self, matrix_json: &str) -> Result<(), JsValue> {
        self.inner.preview_transform(parse_params(matrix_json)?).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = commitTransform)]
    pub fn commit_transform(&mut self) -> Result<String, JsValue> {
        self.inner.commit_transform().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelTransform)]
    pub fn cancel_transform(&mut self) { self.inner.cancel_transform(); }

    /// 构图工作流清单（U50–U56）：`[{id,group,label,command,allowed,reason}]`。
    #[wasm_bindgen(js_name = workflowManifestJson)]
    pub fn workflow_manifest_json(&self) -> String {
        self.inner.workflow_manifest().to_string()
    }

    /// 执行一个构图工作流；未开放的命令由命令门拒绝并给出原因。
    #[wasm_bindgen(js_name = runWorkflow)]
    pub fn run_workflow(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .run_workflow(id, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 画板/切片导出计划（U56）：`{files:[{fileName,name,rect:[x,y,w,h],kind}]}`。
    ///
    /// 只给范围与命名，不写盘；宿主按 `rect` 取像素后走自己的文件交付通道。
    #[wasm_bindgen(js_name = compositionExportPlanJson)]
    pub fn composition_export_plan_json(&self, kind: &str) -> Result<String, JsValue> {
        self.inner
            .composition_export_plan(kind)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 导出一项画板/切片为 PNG 字节（U56）。`rect_json` 为 `{x,y,width,height}`。
    #[wasm_bindgen(js_name = compositionExportPng)]
    pub fn composition_export_png(&self, rect_json: &str) -> Result<Vec<u8>, JsValue> {
        self.inner
            .composition_export_png(parse_params(rect_json)?)
            .map_err(|error| js_error(&error))
    }
}
