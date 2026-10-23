use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = patternLibrary)]
    pub fn pattern_library(&self)->String {self.inner.pattern_library().to_string()}

    #[wasm_bindgen(js_name = importPatternPresets)]
    pub fn import_pattern_presets(&mut self,bytes:&[u8])->Result<String,JsValue> {
        self.inner.import_pattern_presets(bytes).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = renamePatternPreset)]
    pub fn rename_pattern_preset(&mut self,key:&str,name:&str)->Result<String,JsValue> {
        self.inner.rename_pattern_preset(key,name).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = deletePatternPreset)]
    pub fn delete_pattern_preset(&mut self,key:&str)->Result<String,JsValue> {
        self.inner.delete_pattern_preset(key).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = exportPatternPresets)]
    pub fn export_pattern_presets(&self,key:Option<String>)->Result<Vec<u8>,JsValue> {
        self.inner.export_pattern_presets(key.as_deref()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = patternLibrarySnapshot)]
    pub fn pattern_library_snapshot(&self)->Result<Vec<u8>,JsValue> {self.inner.pattern_library_snapshot().map_err(|e|js_error(&e))}

    #[wasm_bindgen(js_name = restorePatternLibrary)]
    pub fn restore_pattern_library(&mut self,bytes:&[u8])->Result<String,JsValue> {
        self.inner.restore_pattern_library(bytes).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = importContourPresets)]
    pub fn import_contour_presets(&self,bytes:&[u8])->Result<String,JsValue> {
        crate::contour_presets::import(bytes).map(|value|value.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = exportContourPreset)]
    pub fn export_contour_preset(&self,contour_json:&str)->Result<Vec<u8>,JsValue> {
        crate::contour_presets::export(parse_params(contour_json)?).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = beginLayerProperties)]
    pub fn begin_layer_properties(&mut self,layer:u32)->Result<String,JsValue> {
        self.inner.begin_layer_properties(u64::from(layer)).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = previewLayerProperties)]
    pub fn preview_layer_properties(&mut self,params_json:&str)->Result<String,JsValue> {
        self.inner.preview_layer_properties(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = stylePositionFrame)]
    pub fn style_position_frame(&self,index:u32)->Result<String,JsValue> {
        self.inner.style_position_frame(index).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = commitLayerProperties)]
    pub fn commit_layer_properties(&mut self)->Result<String,JsValue> {
        self.inner.commit_layer_properties().map(|v|v.to_string()).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelLayerProperties)]
    pub fn cancel_layer_properties(&mut self) {self.inner.cancel_layer_properties();}

    /// 导出选中图层为跨文档载荷字节（源文档关闭后仍有效）。
    #[wasm_bindgen(js_name = exportLayerTransfer)]
    pub fn export_layer_transfer(&self, params_json: &str) -> Result<Vec<u8>, JsValue> {
        self.inner.export_layer_transfer(parse_params(params_json)?).map_err(|e| js_error(&e))
    }

    /// 载荷摘要与结构（不解码像素）。
    #[wasm_bindgen(js_name = inspectLayerTransfer)]
    pub fn inspect_layer_transfer(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.inspect_layer_transfer(bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 目标候选文档预检（不改状态）。
    #[wasm_bindgen(js_name = canPasteLayerTransfer)]
    pub fn can_paste_layer_transfer(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.can_paste_layer_transfer(bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 粘贴载荷：`{"placement":"inPlace"|"center","center":[x,y]?}`，一步原子提交。
    #[wasm_bindgen(js_name = pasteLayerTransfer)]
    pub fn paste_layer_transfer(&mut self, bytes: &[u8], params_json: &str) -> Result<String, JsValue> {
        self.inner
            .paste_layer_transfer(bytes, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = filterLayers)]
    pub fn filter_layers(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner.filter_layers(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = layerThumbnail)]
    pub fn layer_thumbnail(&self, layer: u32, mask: bool, max_side: u32) -> Result<WasmPreview, JsValue> {
        let preview=self.inner.layer_thumbnail(u64::from(layer),mask,max_side).map_err(|e|js_error(&e))?;
        Ok(WasmPreview{width:preview.width,height:preview.height,pixels:preview.pixels})
    }

    // ---------- U57：可重编填充层 ----------

    /// 新建填充层（`layer.newFillLayer.*`），返回规范参数。
    #[wasm_bindgen(js_name = newFillLayer)]
    pub fn new_fill_layer(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.new_fill_layer(id, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 填充层规范参数（只读）：重开后仍能改填充参数。
    #[wasm_bindgen(js_name = fillLayerInfo)]
    pub fn fill_layer_info(&self, layer: u32) -> Result<String, JsValue> {
        self.inner.fill_layer_info(u64::from(layer)).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 填充参数预览（纯函数）：正式修订/指纹/历史不变。
    #[wasm_bindgen(js_name = previewFillLayer)]
    pub fn preview_fill_layer(&self, layer: u32, params_json: &str) -> Result<String, JsValue> {
        self.inner.preview_fill_layer(u64::from(layer), parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 确认填充参数：重新校验后一步提交，无变化不增历史。
    #[wasm_bindgen(js_name = applyFillLayer)]
    pub fn apply_fill_layer(&mut self, layer: u32, params_json: &str) -> Result<String, JsValue> {
        self.inner.apply_fill_layer(u64::from(layer), parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    // ---------- U58–U62、U64：图层工作流 ----------

    /// 本组统一入口：`preview` 为真时只返回候选像素，不写文档。
    #[wasm_bindgen(js_name = layerWorkflow)]
    pub fn layer_workflow(&mut self, id: &str, params_json: &str, preview: bool) -> Result<String, JsValue> {
        self.inner.layer_workflow(id, parse_params(params_json)?, preview).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 图层复合列表（只读）：面板据此渲染复合行与缺失层报告。
    #[wasm_bindgen(js_name = layerComps)]
    pub fn layer_comps(&self) -> Result<String, JsValue> {
        self.inner.layer_comps().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 粘贴入/外的选区、剪贴板与目标摘要（只读）。
    #[wasm_bindgen(js_name = pasteRegion)]
    pub fn paste_region(&self) -> Result<String, JsValue> {
        self.inner.paste_region().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 样式预设管理（U61）：`list`/`new`/`edit`/`reset`，只改会话偏好、不写文档。
    #[wasm_bindgen(js_name = stylePresets)]
    pub fn style_presets(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.layer_workflow(id, parse_params(params_json)?, false).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }
}
