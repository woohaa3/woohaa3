use super::*;
use serde_json::json;

#[wasm_bindgen]
impl WasmEditor {
    #[wasm_bindgen(js_name = beginStroke)]
    pub fn begin_stroke(&mut self, params_json: &str) -> Result<(), JsValue> {
        self.inner.begin_stroke(parse_params(params_json)?).map_err(|e| js_error(&e))
    }

    /// 笔刷预设列表（`full` 时含来源与资源摘要）。
    #[wasm_bindgen(js_name = brushPresetsJson)]
    pub fn brush_presets_json(&self, full: bool) -> String {
        self.inner.brush_presets(full).to_string()
    }

    /// 单条预设的完整设置（含采样位图）。
    #[wasm_bindgen(js_name = brushPresetJson)]
    pub fn brush_preset_json(&self, name: &str) -> Result<String, JsValue> {
        self.inner.brush_preset(name).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 保存／覆盖预设。
    #[wasm_bindgen(js_name = saveBrushPreset)]
    pub fn save_brush_preset(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.save_brush_preset(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = renameBrushPreset)]
    pub fn rename_brush_preset(&mut self, name: &str, new_name: &str) -> Result<String, JsValue> {
        self.inner.rename_brush_preset(name, new_name).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = deleteBrushPreset)]
    pub fn delete_brush_preset(&mut self, name: &str) -> Result<String, JsValue> {
        self.inner.delete_brush_preset(name).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = moveBrushPreset)]
    pub fn move_brush_preset(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.move_brush_preset(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = selectBrushPreset)]
    pub fn select_brush_preset(&mut self, name: &str) -> Result<String, JsValue> {
        self.inner.select_brush_preset(name).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 真实内核笔迹预览（RGBA8）。
    #[wasm_bindgen(js_name = brushPreview)]
    pub fn brush_preview(&self, params_json: &str) -> Result<WasmPreview, JsValue> {
        let preview = self.inner.brush_preview(parse_params(params_json)?).map_err(|e| js_error(&e))?;
        Ok(WasmPreview { width: preview.width, height: preview.height, pixels: preview.pixels })
    }

    /// 本机笔刷库快照字节。
    #[wasm_bindgen(js_name = brushLibrarySnapshot)]
    pub fn brush_library_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.brush_library_snapshot().map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = restoreBrushLibrary)]
    pub fn restore_brush_library(&mut self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.restore_brush_library(bytes).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// ABR 导入预检：只返回报告，不发布。
    #[wasm_bindgen(js_name = inspectBrushAbr)]
    pub fn inspect_brush_abr(&mut self, bytes: &[u8], group: &str) -> Result<String, JsValue> {
        self.inner.inspect_brush_abr(bytes, group).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 确认发布上一次 ABR 预检。
    #[wasm_bindgen(js_name = commitBrushAbr)]
    pub fn commit_brush_abr(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.commit_brush_abr(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelBrushAbr)]
    pub fn cancel_brush_abr(&mut self) -> String {
        self.inner.cancel_brush_abr().to_string()
    }

    /// 从图片字节定义采样笔尖。
    #[wasm_bindgen(js_name = importBrushFromImage)]
    pub fn import_brush_from_image(&mut self, name: &str, bytes: &[u8], params_json: &str) -> Result<String, JsValue> {
        self.inner
            .import_brush_from_image(name, bytes, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = sampleColor)]
    pub fn sample_color(&self, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        self.inner.sample_color(x, y).map_err(|e| js_error(&e))
    }

    /// 本域命令统一入口：先确认归属，再走同一道能力门（U27–U36）。
    #[wasm_bindgen(js_name = paintingCommand)]
    pub fn painting_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .painting_command(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 独立吸管：按采样尺寸与采样层策略读源像素；越界或透明返回 `null`。只读。
    #[wasm_bindgen(js_name = sampleColorOptions)]
    pub fn sample_color_options(&self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .sample_color_options(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 当前文档的绘画对称状态；未启用时 `{"enabled":false}`。
    #[wasm_bindgen(js_name = symmetryStateJson)]
    pub fn symmetry_state_json(&self) -> Result<String, JsValue> {
        self.inner.symmetry_state().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 笔刷分组改名；返回最新分组表。
    #[wasm_bindgen(js_name = renameBrushGroup)]
    pub fn rename_brush_group(&mut self, group: &str, new_name: &str) -> Result<String, JsValue> {
        self.inner
            .rename_brush_group(group, new_name)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 笔刷分组删除；`keepPresets` 为 true 时条目移入 general。
    #[wasm_bindgen(js_name = deleteBrushGroup)]
    pub fn delete_brush_group(&mut self, group: &str, keep_presets: bool) -> Result<String, JsValue> {
        self.inner
            .delete_brush_group(group, keep_presets)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 笔刷分组排序。
    #[wasm_bindgen(js_name = moveBrushGroup)]
    pub fn move_brush_group(&mut self, group: &str, index: usize) -> Result<String, JsValue> {
        self.inner
            .move_brush_group(group, index)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 从当前选区定义静态笔尖并收入本机库。
    #[wasm_bindgen(js_name = defineBrushFromSelection)]
    pub fn define_brush_from_selection(&mut self, name: &str, group: &str) -> Result<String, JsValue> {
        let group = (!group.trim().is_empty()).then_some(group);
        self.inner
            .define_brush_from_selection(name, group)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 工具预设列表（可按工具过滤）。
    #[wasm_bindgen(js_name = toolPresetsJson)]
    pub fn tool_presets_json(&self, tool: &str) -> String {
        let tool = (!tool.trim().is_empty()).then_some(tool);
        json!({ "presets": self.inner.tool_presets(tool) }).to_string()
    }

    /// 保存／覆盖工具预设。
    #[wasm_bindgen(js_name = saveToolPreset)]
    pub fn save_tool_preset(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .save_tool_preset(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 应用工具预设；返回工具 id 供界面切换。
    #[wasm_bindgen(js_name = selectToolPreset)]
    pub fn select_tool_preset(&mut self, name: &str) -> Result<String, JsValue> {
        self.inner
            .select_tool_preset(name)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 编辑工具预设（`action` = rename|delete）。
    #[wasm_bindgen(js_name = editToolPreset)]
    pub fn edit_tool_preset(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .edit_tool_preset(parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = resetToolPresets)]
    pub fn reset_tool_presets(&mut self) -> String {
        self.inner.reset_tool_presets().to_string()
    }

    /// 工具预设快照字节（签名 + 有界 JSON），供宿主偏好存储。
    #[wasm_bindgen(js_name = toolPresetSnapshot)]
    pub fn tool_preset_snapshot(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.tool_preset_snapshot().map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = restoreToolPresets)]
    pub fn restore_tool_presets(&mut self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner
            .restore_tool_presets(bytes)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = appendStroke)]
    pub fn append_stroke(&mut self, params_json: &str) -> Result<(), JsValue> {
        self.inner.append_stroke(parse_params(params_json)?).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = takeStrokeDamage)]
    pub fn take_stroke_damage(&mut self)->String {self.inner.take_stroke_damage().to_string()}

    #[wasm_bindgen(js_name = commitStroke)]
    pub fn commit_stroke(&mut self) -> Result<String, JsValue> {
        self.inner.commit_stroke().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = cancelStroke)]
    pub fn cancel_stroke(&mut self) {
        self.inner.cancel_stroke();
    }
}
