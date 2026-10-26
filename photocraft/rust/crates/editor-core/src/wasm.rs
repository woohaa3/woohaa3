//! wasm-bindgen 绑定：把 [`crate::Editor`] 暴露给 React。
//!
//! 只做类型转换，不含业务逻辑；所有方法都在 [`crate::editor`] 上可原生测试。
//! 返回 JSON 字符串而不是任意 `JsValue`，避免把未校验的对象结构透传进 JS。

use wasm_bindgen::prelude::*;

use crate::editor::Editor;
use crate::error::EditorError;

/// 把内核错误转成 `{"code","message"}` 的 JS 错误值。
fn js_error(error: &EditorError) -> JsValue {
    let payload = serde_json::json!({ "code": error.code(), "message": error.message() }).to_string();
    JsValue::from_str(&payload)
}

/// 合成预览像素。
#[wasm_bindgen]
pub struct WasmPreview {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
impl WasmPreview {
    /// 预览宽度（像素）。
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// 预览高度（像素）。
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// RGBA8 像素（行优先，长度 `width * height * 4`）。
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }
}

/// React 侧持有的编辑会话。
#[wasm_bindgen]
pub struct WasmEditor {
    inner: Editor,
}

/// 一次冻结导出的成对产物。
#[wasm_bindgen]
pub struct WasmExportBundle {
    revision: u64,
    document_content_hash: String,
    canvas_width: u32,
    canvas_height: u32,
    project: Vec<u8>,
    output: Vec<u8>,
}

#[wasm_bindgen]
impl WasmExportBundle {
    /// 冻结时的文档修订号（JS 数值；修订是小的单调计数）。
    #[wasm_bindgen(getter, js_name = revision)]
    pub fn revision(&self) -> f64 {
        self.revision as f64
    }

    /// 冻结时的文档内容指纹（16 位小写 hex）。
    #[wasm_bindgen(getter, js_name = documentContentHash)]
    pub fn document_content_hash(&self) -> String {
        self.document_content_hash.clone()
    }

    /// 画布宽度。
    #[wasm_bindgen(getter, js_name = canvasWidth)]
    pub fn canvas_width(&self) -> u32 {
        self.canvas_width
    }

    /// 画布高度。
    #[wasm_bindgen(getter, js_name = canvasHeight)]
    pub fn canvas_height(&self) -> u32 {
        self.canvas_height
    }

    /// `.pcraft` 工程字节。
    #[wasm_bindgen(getter)]
    pub fn project(&self) -> Vec<u8> {
        self.project.clone()
    }

    /// 合成 PNG 字节。
    #[wasm_bindgen(getter)]
    pub fn output(&self) -> Vec<u8> {
        self.output.clone()
    }
}

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
    #[wasm_bindgen(js_name = beginLayerVisibility)]
    pub fn begin_layer_visibility(&mut self,layer:u32)->Result<String,JsValue> {
        self.inner.begin_layer_visibility(u64::from(layer)).map(|v|v.to_string()).map_err(|e|js_error(&e))
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
    /// Layers 面板拖动重排的画布预览（I218）：候选只读，不写正式文档。
    #[wasm_bindgen(js_name = beginReorderPreview)]
    pub fn begin_reorder_preview(&mut self)->Result<String,JsValue> {
        self.inner.begin_reorder_preview().map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = previewReorder)]
    pub fn preview_reorder(&mut self,params_json:&str)->Result<String,JsValue> {
        self.inner.preview_reorder(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = endReorderPreview)]
    pub fn end_reorder_preview(&mut self)->String {self.inner.end_reorder_preview().to_string()}
    #[wasm_bindgen(js_name = beginAdjustment)]
    pub fn begin_adjustment(&mut self, layer: u32) -> Result<String,JsValue> {
        self.inner.begin_adjustment(u64::from(layer)).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = previewAdjustment)]
    pub fn preview_adjustment(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.preview_adjustment(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = commitAdjustment)]
    pub fn commit_adjustment(&mut self) -> Result<String,JsValue> {
        self.inner.commit_adjustment().map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = cancelAdjustment)]
    pub fn cancel_adjustment(&mut self) {self.inner.cancel_adjustment();}
    #[wasm_bindgen(js_name = curveGeometry)]
    pub fn curve_geometry(&self, points_json: &str) -> Result<String,JsValue> {
        self.inner.curve_geometry(parse_params(points_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = moveHoverAt)]
    pub fn move_hover_at(&self,params_json:&str)->Result<String,JsValue>{self.inner.move_hover_at(parse_params(params_json)?).map(|value|value.to_string()).map_err(|e|js_error(&e))}

    #[wasm_bindgen(js_name = missingFonts)]
    pub fn missing_fonts(&self)->Result<String,JsValue>{self.inner.missing_fonts().map(|fonts|serde_json::to_string(&fonts).unwrap()).map_err(|e|js_error(&e))}

    #[wasm_bindgen(js_name = beginText)]
    pub fn begin_text(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.begin_text(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = previewText)]
    pub fn preview_text(&mut self, params_json: &str) -> Result<String,JsValue> {
        self.inner.preview_text(parse_params(params_json)?).map(|v|v.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = checkpointText)]
    pub fn checkpoint_text(&mut self) -> Result<String,JsValue> {
        self.inner.checkpoint_text().map(|value|value.to_string()).map_err(|e|js_error(&e))
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

    #[wasm_bindgen(js_name = beginImageRotation)]
    pub fn begin_image_rotation(&mut self)->Result<String,JsValue> {self.inner.begin_image_rotation().map(|v|v.to_string()).map_err(|e|js_error(&e))}
    #[wasm_bindgen(js_name = previewImageRotation)]
    pub fn preview_image_rotation(&mut self,params:&str)->Result<String,JsValue> {self.inner.preview_image_rotation(parse_params(params)?).map(|v|v.to_string()).map_err(|e|js_error(&e))}
    #[wasm_bindgen(js_name = commitImageRotation)]
    pub fn commit_image_rotation(&mut self)->Result<String,JsValue> {self.inner.commit_image_rotation().map(|v|v.to_string()).map_err(|e|js_error(&e))}
    #[wasm_bindgen(js_name = cancelImageRotation)]
    pub fn cancel_image_rotation(&mut self) {self.inner.cancel_image_rotation();}

    #[wasm_bindgen(js_name = clipboardBounds)]
    pub fn clipboard_bounds(&self)->String {serde_json::json!(self.inner.clipboard_bounds()).to_string()}

    #[wasm_bindgen(js_name = histogram)]
    pub fn histogram(&self)->Result<String,JsValue> {self.inner.histogram().map(|value|value.to_string()).map_err(|error|js_error(&error))}

    #[wasm_bindgen(js_name = pixelGrid)]
    pub fn pixel_grid(&self,params:&str)->Result<String,JsValue> {let params=serde_json::from_str(params).map_err(|_|js_error(&EditorError::CommandFailed{id:"view.pixelGridReadout".into(),message:"像素网格区域无效".into()}))?;self.inner.pixel_grid(params).map(|value|value.to_string()).map_err(|error|js_error(&error))}

    #[wasm_bindgen(js_name = infoReadout)]
    pub fn info_readout(&self,params:&str)->Result<String,JsValue> {let params=serde_json::from_str(params).map_err(|_|js_error(&EditorError::CommandFailed{id:"document.infoReadout".into(),message:"信息取样参数无效".into()}))?;self.inner.info_readout(params).map(|value|value.to_string()).map_err(|error|js_error(&error))}
    #[wasm_bindgen(js_name = setPerformancePreferences)]
    pub fn set_performance_preferences(&mut self,history_states:f64,memory_usage_mb:f64)->Result<String,JsValue> {
        if !history_states.is_finite() || history_states.fract()!=0. || !(1.0..=1000.0).contains(&history_states) || !memory_usage_mb.is_finite() || memory_usage_mb.fract()!=0. || !(256.0..=1_048_576.0).contains(&memory_usage_mb) {
            return Err(js_error(&EditorError::CommandFailed{id:"preferences.performance".into(),message:"无效的历史状态数量或内存预算".into()}));
        }
        self.inner.set_performance_preferences(history_states as u32,memory_usage_mb as u32).map(|value|value.to_string()).map_err(|e|js_error(&e))
    }
    #[wasm_bindgen(js_name = setHistoryLimit)]
    pub fn set_history_limit(&mut self,limit:u32)->Result<String,JsValue> {self.inner.set_history_limit(limit).map(|value|value.to_string()).map_err(|e|js_error(&e))}

    /// 新建空会话。
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmEditor {
        WasmEditor { inner: Editor::new() }
    }

    /// 上游固定提交、格式版本与构建信息。
    #[wasm_bindgen(js_name = buildInfoJson)]
    pub fn build_info_json() -> String {
        serde_json::to_string(&crate::build_info()).unwrap_or_else(|_| "{}".into())
    }

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

    /// Copy current formal content into a fresh project, without modifying this session.
    #[wasm_bindgen(js_name = duplicateProject)]
    pub fn duplicate_project(&self, name: &str) -> Result<Vec<u8>, JsValue> {
        self.inner.duplicate_project(name).map_err(|error|js_error(&error))
    }

    /// 合成预览：`maxSide` 为最长边上限。
    #[wasm_bindgen(js_name = renderPreview)]
    pub fn render_preview(&self, max_side: u32) -> Result<WasmPreview, JsValue> {
        let preview = self.inner.render_preview(max_side).map_err(|e| js_error(&e))?;
        Ok(WasmPreview { width: preview.width, height: preview.height, pixels: preview.pixels })
    }

    /// 源分辨率区域；JSON 校验先于分配与合成，避免数值被 JS 绑定截断。
    #[wasm_bindgen(js_name = renderRegion)]
    pub fn render_region(&self, params_json: &str) -> Result<WasmPreview, JsValue> {
        let preview=self.inner.render_region(parse_params(params_json)?).map_err(|e|js_error(&e))?;
        Ok(WasmPreview{width:preview.width,height:preview.height,pixels:preview.pixels})
    }

    #[wasm_bindgen(js_name = strokeWantsTime)]
    pub fn stroke_wants_time(&self) -> bool { self.inner.stroke_wants_time() }

    #[wasm_bindgen(js_name = beginStroke)]
    pub fn begin_stroke(&mut self, params_json: &str) -> Result<(), JsValue> {
        self.inner.begin_stroke(parse_params(params_json)?).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = selectionContains)]
    pub fn selection_contains(&self,x:f64,y:f64)->Result<bool,JsValue> {self.inner.selection_contains(x,y).map_err(|e|js_error(&e))}

    #[wasm_bindgen(js_name = sampleColorOptions)]
    pub fn sample_color_options(&self, params: &str) -> Result<Option<String>, JsValue> {
        self.inner.sample_color_options(parse_params(params)?).map_err(|e|js_error(&e))
    }

    #[wasm_bindgen(js_name = sampleColor)]
    pub fn sample_color(&self, x: f64, y: f64) -> Result<Option<String>, JsValue> {
        self.inner.sample_color(x, y).map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = fontPreview)]
    pub fn font_preview(&self,family:&str,size:u32,scale:u32)->Result<WasmPreview,JsValue>{
        let preview=self.inner.font_preview(family,size,scale).map_err(|e|js_error(&e))?;
        Ok(WasmPreview{width:preview.width,height:preview.height,pixels:preview.pixels})
    }

    #[wasm_bindgen(js_name = layerThumbnail)]
    pub fn layer_thumbnail(&self, layer: u32, mask: bool, max_side: u32) -> Result<WasmPreview, JsValue> {
        let preview=self.inner.layer_thumbnail(u64::from(layer),mask,max_side).map_err(|e|js_error(&e))?;
        Ok(WasmPreview{width:preview.width,height:preview.height,pixels:preview.pixels})
    }

    #[wasm_bindgen(js_name = beginTransform)]
    pub fn begin_transform(&mut self) -> Result<(), JsValue> {
        self.inner.begin_transform().map_err(|e| js_error(&e))
    }

    #[wasm_bindgen(js_name = beginSelectionTransform)]
    pub fn begin_selection_transform(&mut self) -> Result<(), JsValue> {
        self.inner.begin_selection_transform().map_err(|e| js_error(&e))
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

    /// 当前文档内容指纹。
    #[wasm_bindgen(js_name = contentHash)]
    pub fn content_hash(&self) -> Result<String, JsValue> {
        self.inner.content_hash().map_err(|e| js_error(&e))
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

    /// 只读当前画笔设置（I132）；不走命令分派，也不产生历史。
    #[wasm_bindgen(js_name = brushGet)]
    pub fn brush_get(&mut self)->Result<String,JsValue> {
        let value=self.inner.execute("brush.get",serde_json::Value::Null).map_err(|e|js_error(&e))?;
        Ok(value.to_string())
    }

    /// 按导出格式与控制编码当前修订（I045）；字节交给宿主单文件端口。
    #[wasm_bindgen(js_name = exportImage)]
    pub fn export_image(&self, params_json:&str)->Result<WasmExportBundle,JsValue> {
        let request=crate::export_request::ExportRequest::parse(&parse_params(params_json)?).map_err(|e|js_error(&e))?;
        let bundle=self.inner.export_image(request).map_err(|e|js_error(&e))?;
        Ok(WasmExportBundle {
            revision:bundle.revision, document_content_hash:bundle.document_content_hash,
            canvas_width:bundle.canvas_width, canvas_height:bundle.canvas_height,
            project:bundle.project, output:bundle.output,
        })
    }

    /// 资产登记表 JSON。
    #[wasm_bindgen(js_name = assetIdsJson)]
    pub fn asset_ids_json(&self) -> String {
        self.inner.asset_ids().to_string()
    }

    /// 命令注册表 JSON（含启用状态与首期能力门）。
    #[wasm_bindgen(js_name = commandsJson)]
    pub fn commands_json(&self) -> String {
        self.inner.commands().to_string()
    }

    /// 首期允许的命令 id 列表 JSON。
    #[wasm_bindgen(js_name = allowedCommandIdsJson)]
    pub fn allowed_command_ids_json(&self) -> String {
        self.inner.allowed_command_ids().to_string()
    }

    /// 完整状态 JSON。
    #[wasm_bindgen(js_name = stateJson)]
    pub fn state_json(&self) -> String {
        self.inner.state().to_string()
    }

    /// 执行命令；返回结果 JSON。
    #[wasm_bindgen(js_name = execute)]
    pub fn execute(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        let params = parse_params(params_json)?;
        self.inner.execute(id, params).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 撤销。
    pub fn undo(&mut self) -> Result<String, JsValue> {
        self.inner.undo().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 重做。
    pub fn redo(&mut self) -> Result<String, JsValue> {
        self.inner.redo().map(|v| v.to_string()).map_err(|e| js_error(&e))
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
}

impl Default for WasmEditor {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析参数 JSON；空字符串等价于 `null`。
fn parse_params(params_json: &str) -> Result<serde_json::Value, JsValue> {
    if params_json.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(params_json)
        .map_err(|e| JsValue::from_str(&serde_json::json!({ "code": "bad-params", "message": e.to_string() }).to_string()))
}
