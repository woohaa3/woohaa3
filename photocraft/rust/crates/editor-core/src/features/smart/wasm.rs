use super::*;

/// 智能对象源导出结果：文件名与字节成对返回，避免 JS 侧拼装两条独立调用。
#[wasm_bindgen]
pub struct SmartSourceExport {
    name: String,
    bytes: Vec<u8>,
}

#[wasm_bindgen]
impl SmartSourceExport {
    /// 源文件名（嵌入工程自带的名称，不含路径语义）。
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// 源字节（逐字节原样，不重新编码）。
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }
}

#[wasm_bindgen]
impl WasmEditor {
    /// 打开「编辑内容」：返回子文档工程字节与父关联。
    #[wasm_bindgen(js_name = beginSmartChild)]
    pub fn begin_smart_child(&mut self, layer: u32) -> Result<String, JsValue> {
        self.inner.begin_smart_child(u64::from(layer)).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 显式更新父文档（`attemptId` 幂等；`child` 是子文档 `.pcraft` 字节）。
    #[wasm_bindgen(js_name = updateSmartParent)]
    pub fn update_smart_parent(&mut self, attempt_id: &str, child: &[u8]) -> Result<String, JsValue> {
        self.inner
            .update_smart_parent(attempt_id, child)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 冲突恢复：放弃子修改并重载父源。
    #[wasm_bindgen(js_name = reloadSmartChild)]
    pub fn reload_smart_child(&mut self) -> Result<String, JsValue> {
        self.inner.reload_smart_child().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 冲突恢复：导出子工程字节。
    #[wasm_bindgen(js_name = exportSmartChild)]
    pub fn export_smart_child(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.export_smart_child().map_err(|e| js_error(&e))
    }

    /// 冲突恢复：在父文档建立独立对象副本。
    #[wasm_bindgen(js_name = detachSmartChild)]
    pub fn detach_smart_child(&mut self) -> Result<String, JsValue> {
        self.inner.detach_smart_child().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = closeSmartChild)]
    pub fn close_smart_child(&mut self) -> String {
        self.inner.close_smart_child().to_string()
    }

    #[wasm_bindgen(js_name = smartChildStateJson)]
    pub fn smart_child_state_json(&self) -> String {
        self.inner.smart_child_state().to_string()
    }

    /// 转换所选层／组为嵌入智能对象（一步历史）。
    #[wasm_bindgen(js_name = convertToSmartObject)]
    pub fn convert_to_smart_object(&mut self, layers_json: &str) -> Result<String, JsValue> {
        let layers = parse_layers(layers_json)?;
        self.inner
            .convert_to_smart_object(&layers)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 智能对象复制：`independent` 为 true 时「通过拷贝新建」。
    #[wasm_bindgen(js_name = duplicateSmartObject)]
    pub fn duplicate_smart_object(&mut self, layers_json: &str, independent: bool) -> Result<String, JsValue> {
        let layers = parse_layers(layers_json)?;
        self.inner
            .duplicate_smart_object(&layers, independent)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 替换智能对象源内容（保留变换与样式）。
    #[wasm_bindgen(js_name = replaceSmartContents)]
    pub fn replace_smart_contents(&mut self, layer: u32, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner
            .replace_smart_contents(u64::from(layer), bytes)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 显式栅格化智能对象。
    #[wasm_bindgen(js_name = rasterizeSmartObject)]
    pub fn rasterize_smart_object(&mut self, layer: u32) -> Result<String, JsValue> {
        self.inner
            .rasterize_smart_object(u64::from(layer))
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 选中智能层的可用性（导出/替换/编辑内容/转回图层与各自原因）。
    #[wasm_bindgen(js_name = smartLayerStateJson)]
    pub fn smart_layer_state_json(&self, layer: u32) -> Result<String, JsValue> {
        self.inner
            .smart_layer_state(u64::from(layer))
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 导出选中智能层的源字节；不要求已打开子文档。
    #[wasm_bindgen(js_name = exportSmartSource)]
    pub fn export_smart_source(&mut self, layer: u32) -> Result<SmartSourceExport, JsValue> {
        let (name, bytes) = self
            .inner
            .export_smart_source(u64::from(layer))
            .map_err(|e| js_error(&e))?;
        Ok(SmartSourceExport { name, bytes })
    }

    /// 转回图层：解包嵌入源为可编辑图层/组，只改当前实例。
    #[wasm_bindgen(js_name = convertSmartToLayers)]
    pub fn convert_smart_to_layers(&mut self, layer: u32) -> Result<String, JsValue> {
        self.inner
            .convert_smart_to_layers(u64::from(layer))
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }
}
