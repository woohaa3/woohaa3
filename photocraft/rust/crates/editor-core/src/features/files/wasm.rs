//! 本域 WASM 绑定：只做类型转换，业务校验全在 [`crate::Editor`] 上可原生测试。
//!
//! 新建/复制/恢复都在**候选实例**上工作（一个编辑会话一个文档槽位）：宿主为每个标签建一个
//! `WasmEditor`，创建失败时该实例仍是空会话，不会污染已有文档的会话。
use super::*;

#[wasm_bindgen]
impl WasmEditor {
    /// 打开图片（`assetId` 可为空字符串）。
    #[wasm_bindgen(js_name = openImage)]
    pub fn open_image(&mut self, name: &str, asset_id: &str, bytes: &[u8]) -> Result<String, JsValue> {
        let asset_id = (!asset_id.is_empty()).then_some(asset_id);
        self.inner.open_image(name, asset_id, bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 打开 `.pcraft` 工程字节；`baseAssetId` 为空字符串时表示无来源资产。
    #[wasm_bindgen(js_name = openProject)]
    pub fn open_project(&mut self, bytes: &[u8], base_asset_id: &str) -> Result<String, JsValue> {
        let base_asset_id = (!base_asset_id.is_empty()).then_some(base_asset_id);
        self.inner.open_project(bytes, base_asset_id).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 是否已有活动文档。
    #[wasm_bindgen(js_name = hasDocument)]
    pub fn has_document(&self) -> bool {
        self.inner.has_document()
    }

    /// 关闭活动文档并返回状态 JSON。
    #[wasm_bindgen(js_name = closeDocument)]
    pub fn close_document(&mut self) -> String {
        self.inner.close().to_string()
    }

    /// U01：在空会话上新建空白文档；`paramsJson` 为新建参数。
    #[wasm_bindgen(js_name = createDocument)]
    pub fn create_document(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .create_document(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// U02：用用户授权读取的图片字节在空会话上建立文档。
    #[wasm_bindgen(js_name = createDocumentFromImage)]
    pub fn create_document_from_image(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner
            .create_document_from_image(name, bytes)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// U02：把当前文档整份复制成自包含 `.pcraft` 字节（不改变原文的保存基线）。
    #[wasm_bindgen(js_name = duplicateDocumentBytes)]
    pub fn duplicate_document_bytes(&self, name: &str) -> Result<Vec<u8>, JsValue> {
        let name = (!name.trim().is_empty()).then_some(name);
        self.inner.duplicate_document_bytes(name).map_err(|e| js_error(&e))
    }

    /// U03：用工作区持有的基线字节恢复当前文档；`baseAssetId` 为空字符串表示无来源资产。
    #[wasm_bindgen(js_name = restoreSavedBaseline)]
    pub fn restore_saved_baseline(&mut self, bytes: &[u8], base_asset_id: &str) -> Result<String, JsValue> {
        let base_asset_id = (!base_asset_id.trim().is_empty()).then_some(base_asset_id);
        self.inner
            .restore_saved_baseline(bytes, base_asset_id)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// U04：File Info 读取/写入（同一次调用返回实际结果）。
    #[wasm_bindgen(js_name = fileInfo)]
    pub fn file_info(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.file_info(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// U04：新建文档预设（`action` = `list` | `save` | `delete`）。
    #[wasm_bindgen(js_name = documentPresets)]
    pub fn document_presets(&mut self, action: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .document_presets(action, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// U04：最近的新建设置（最新在前，最多 20 条）。
    #[wasm_bindgen(js_name = recentDocuments)]
    pub fn recent_documents(&mut self) -> Result<String, JsValue> {
        self.inner.recent_documents().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// U04：记录一次新建设置（去重、最新在前、超过 20 条丢弃最旧）。
    #[wasm_bindgen(js_name = recordRecentDocument)]
    pub fn record_recent_document(&mut self, settings_json: &str) -> Result<String, JsValue> {
        self.inner
            .record_recent_document(parse_params(settings_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }
}
