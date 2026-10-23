use super::*;

/// 本 change 新增的交换绑定（U05/U06/U07）。
#[path = "wasm_interchange.rs"]
mod interchange;


#[wasm_bindgen]
impl WasmEditor {
    /// 内部旧标注转层；不提供用户置入入口，`paramsJson` 为转换参数。
    #[wasm_bindgen(js_name = placeImage)]
    pub fn place_image(&mut self, name: &str, asset_id: &str, bytes: &[u8], params_json: &str) -> Result<String, JsValue> {
        let params = parse_params(params_json)?;
        let asset_id = (!asset_id.is_empty()).then_some(asset_id);
        self.inner.place_image(name, asset_id, bytes, &params).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 序列化当前工程，返回 `.pcraft` 字节。
    #[wasm_bindgen(js_name = saveProject)]
    pub fn save_project(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.save_project().map_err(|e| js_error(&e))
    }

    /// 置入前预检：真实解码类型与尺寸（不创建层）。
    #[wasm_bindgen(js_name = inspectPlaceAsset)]
    pub fn inspect_place_asset(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.inspect_place_asset(bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 图片置入当前文档（`mode` = `pixel` | `smartObject`）。
    #[wasm_bindgen(js_name = placeAsset)]
    pub fn place_asset(&mut self, params_json: &str, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner
            .place_asset(parse_params(params_json)?, bytes)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// PSD 兼容矩阵（与核验器共用同一份声明）。
    #[wasm_bindgen(js_name = psdMatrixJson)]
    pub fn psd_matrix_json(&self) -> String {
        self.inner.psd_matrix().to_string()
    }

    /// PSD 头部预检（不替换文档）。
    #[wasm_bindgen(js_name = inspectPsd)]
    pub fn inspect_psd(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.inspect_psd(bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 导入 PSD（`flatJson` = `{"flat":bool}`）；成功后替换当前文档。
    #[wasm_bindgen(js_name = importPsd)]
    pub fn import_psd(&mut self, bytes: &[u8], params_json: &str) -> Result<String, JsValue> {
        let flat = parse_params(params_json)
            .ok()
            .and_then(|value| value.get("flat").and_then(serde_json::Value::as_bool))
            .unwrap_or(false);
        self.inner
            .import_psd_project(bytes, flat)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// PSD 导出预检（逐层报告）。
    #[wasm_bindgen(js_name = inspectPsdExport)]
    pub fn inspect_psd_export(&self) -> Result<String, JsValue> {
        self.inner.inspect_psd_export().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// PSD 导出：返回字节，报告通过 `lastPsdExportReportJson` 读取。
    #[wasm_bindgen(js_name = exportPsd)]
    pub fn export_psd(&mut self, params_json: &str) -> Result<Vec<u8>, JsValue> {
        let (bytes, report) = self.inner.export_psd(parse_params(params_json)?).map_err(|e| js_error(&e))?;
        self.last_psd_report = report.to_string();
        Ok(bytes)
    }

    /// 最近一次 PSD 导出的逐层报告。
    #[wasm_bindgen(js_name = lastPsdExportReportJson)]
    pub fn last_psd_export_report_json(&self) -> String {
        self.last_psd_report.clone()
    }

    /// 冻结导出：一次同步调用内取齐修订、指纹、尺寸与成对产物。
    #[wasm_bindgen(js_name = exportBundle)]
    pub fn export_bundle(&self) -> Result<WasmExportBundle, JsValue> {
        let bundle = self.inner.export_bundle().map_err(|e| js_error(&e))?;
        Ok(WasmExportBundle {
            revision: bundle.revision,
            document_content_hash: bundle.document_content_hash,
            canvas_width: bundle.canvas_width,
            canvas_height: bundle.canvas_height,
            project: bundle.project,
            output: bundle.output,
        })
    }
}
