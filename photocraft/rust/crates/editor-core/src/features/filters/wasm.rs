use super::*;

/// 滤镜域的 WASM 绑定：草稿、清单、画廊目录与重复上次。
///
/// 清单与草稿状态都以 JSON 字符串返回，与其余域一致（调用方在本模块外解析）。
#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginFilter)]
    pub fn begin_filter(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .begin_filter(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateFilter)]
    pub fn update_filter(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_filter(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = commitFilter)]
    pub fn commit_filter(&mut self) -> Result<String, JsValue> {
        self.inner.commit_filter().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelFilter)]
    pub fn cancel_filter(&mut self) -> String {
        self.inner.cancel_filter().to_string()
    }

    /// 滤镜清单：命令、中文名、归类、交互形态与参数 schema（含画廊目录与上限）。
    #[wasm_bindgen(js_name = filterCatalogueJson)]
    pub fn filter_catalogue_json(&self) -> String {
        self.inner.filter_catalogue().to_string()
    }

    /// 画廊目录：分类与每个滤镜的参数 schema。
    #[wasm_bindgen(js_name = filterGalleryCatalogueJson)]
    pub fn filter_gallery_catalogue_json(&self) -> String {
        self.inner.filter_gallery_catalogue().to_string()
    }

    /// 滤镜库默认组合（面板首次打开即可预览）。
    #[wasm_bindgen(js_name = filterGalleryDefaultStackJson)]
    pub fn filter_gallery_default_stack_json(&self) -> String {
        self.inner.filter_gallery_default_stack().to_string()
    }

    /// 活动草稿状态；没有草稿时返回 `null`。
    #[wasm_bindgen(js_name = filterDraftStateJson)]
    pub fn filter_draft_state_json(&self) -> String {
        self.inner.filter_draft_state().to_string()
    }

    /// 上一次滤镜的可用性与规范参数。
    #[wasm_bindgen(js_name = filterLastJson)]
    pub fn filter_last_json(&self) -> String {
        self.inner.filter_last().to_string()
    }

    /// 重复上次滤镜：重建草稿（不直接执行，仍走确认/取消）。
    #[wasm_bindgen(js_name = repeatLastFilter)]
    pub fn repeat_last_filter(&mut self) -> Result<String, JsValue> {
        self.inner.repeat_last_filter().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 图内控制点：文档坐标 → 0–1 相对坐标。
    #[wasm_bindgen(js_name = filterNormalizePoint)]
    pub fn filter_normalize_point(&self, x: f64, y: f64, width: f64, height: f64) -> Result<String, JsValue> {
        self.inner
            .filter_normalize_point(x, y, width, height)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 位移图来源：会话里已打开的文档（序号 + 名称 + 尺寸）。
    #[wasm_bindgen(js_name = filterMapSourcesJson)]
    pub fn filter_map_sources_json(&self) -> String {
        self.inner.filter_map_sources().to_string()
    }

    /// 火焰滤镜的路径来源：文档里的已保存路径名（`path` 是名字，不是坐标）。
    #[wasm_bindgen(js_name = filterPathSourcesJson)]
    pub fn filter_path_sources_json(&self) -> String {
        self.inner.filter_path_sources().to_string()
    }

    /// 消失点粘贴的图层来源：当前文档里可见且带像素的图层。
    #[wasm_bindgen(js_name = filterLayerSourcesJson)]
    pub fn filter_layer_sources_json(&self) -> String {
        self.inner.filter_layer_sources().to_string()
    }
}
