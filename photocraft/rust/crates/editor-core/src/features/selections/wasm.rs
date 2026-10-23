use super::*;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginSelectionModify)]
    pub fn begin_selection_modify(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .begin_selection_modify(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateSelectionModify)]
    pub fn update_selection_modify(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .update_selection_modify(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = commitSelectionModify)]
    pub fn commit_selection_modify(&mut self) -> Result<String, JsValue> {
        self.inner.commit_selection_modify().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelSelectionModify)]
    pub fn cancel_selection_modify(&mut self) -> String {
        self.inner.cancel_selection_modify().to_string()
    }

    #[wasm_bindgen(js_name = prepareRefineEdge)]
    pub fn prepare_refine_edge(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .prepare_refine_edge(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = beginSelectionTransform)]
    pub fn begin_selection_transform(&mut self) -> Result<(), JsValue> {
        self.inner.begin_selection_transform().map_err(|e| js_error(&e))
    }

    // ---------------------------------------------------------------- U17–U24 逐项入口

    /// 单行／单列选框（`line` 为 `row` 或 `column`）。
    #[wasm_bindgen(js_name = selectLine)]
    pub fn select_line(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.select_line(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 磁性套索草稿（追踪结果来自内核，确认才写入文档）。
    #[wasm_bindgen(js_name = beginMagneticLasso)]
    pub fn begin_magnetic_lasso(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.begin_magnetic_lasso(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateMagneticLasso)]
    pub fn update_magnetic_lasso(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_magnetic_lasso(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 命名选区保存（`overwrite` 明确后才替换同名通道）。
    #[wasm_bindgen(js_name = saveNamedSelection)]
    pub fn save_named_selection(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.save_named_selection(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = loadNamedSelection)]
    pub fn load_named_selection(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.load_named_selection(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 按颜色扩大（`similar=false`）或选取相似（`similar=true`）。
    #[wasm_bindgen(js_name = beginColorGrow)]
    pub fn begin_color_grow(&mut self, similar: bool, params_json: &str) -> Result<String, JsValue> {
        self.inner.begin_color_grow(similar, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateColorGrow)]
    pub fn update_color_grow(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_color_grow(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 快速蒙版会话：进入 → 临时笔迹 → 退出转选区／取消恢复。
    #[wasm_bindgen(js_name = beginQuickMask)]
    pub fn begin_quick_mask(&mut self) -> Result<String, JsValue> {
        self.inner.begin_quick_mask().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = paintQuickMask)]
    pub fn paint_quick_mask(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.paint_quick_mask(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = exitQuickMask)]
    pub fn exit_quick_mask(&mut self, cancel: bool) -> Result<String, JsValue> {
        self.inner.exit_quick_mask(cancel).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 传统分割（object／sky／focusArea／removeBackground；subject 仍被能力门禁关闭）。
    #[wasm_bindgen(js_name = beginSmartSelect)]
    pub fn begin_smart_select(&mut self, kind: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner.begin_smart_select(kind, parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = beginColorRange)]
    pub fn begin_color_range(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.begin_color_range(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateColorRange)]
    pub fn update_color_range(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_color_range(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = beginRefineEdge)]
    pub fn begin_refine_edge(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.begin_refine_edge(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = updateRefineEdge)]
    pub fn update_refine_edge(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.update_refine_edge(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 像素蒙版 density／非破坏 feather（内容属性）。
    #[wasm_bindgen(js_name = editLayerMask)]
    pub fn edit_layer_mask(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.edit_layer_mask(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 蒙版属性与查看模式（只读视图）。
    #[wasm_bindgen(js_name = layerMaskProperties)]
    pub fn layer_mask_properties(&self, layer: Option<u32>) -> Result<String, JsValue> {
        self.inner.layer_mask_properties(layer.map(u64::from)).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 独立／叠加查看蒙版（只改会话视图，不是内容历史）。
    #[wasm_bindgen(js_name = viewLayerMask)]
    pub fn view_layer_mask(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.view_layer_mask(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 当前选区草稿的对外视图（种类、候选边界、是否最后输入非法）。
    #[wasm_bindgen(js_name = selectionDraftStateJson)]
    pub fn selection_draft_state_json(&self) -> String {
        self.inner.selection_draft_state().to_string()
    }

    /// 候选选区边界线段（预览与确认后边界一致）。
    #[wasm_bindgen(js_name = selectionDraftOutlineJson)]
    pub fn selection_draft_outline_json(&self) -> String {
        self.inner.selection_draft_outline().to_string()
    }

    #[wasm_bindgen(js_name = commitSelectionDraft)]
    pub fn commit_selection_draft(&mut self) -> Result<String, JsValue> {
        self.inner.commit_selection_draft().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelSelectionDraft)]
    pub fn cancel_selection_draft(&mut self) -> String {
        self.inner.cancel_selection_draft().to_string()
    }
}
