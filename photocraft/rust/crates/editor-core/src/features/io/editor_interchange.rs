//! U05/U06/U07 的编辑会话入口（change: 2026-10-22-add-photocraft-raster-interchange）。
//!
//! 这里只做**编排**：把会话里的活动文档与选择交给 [`super::formats`]、[`super::export`]、
//! [`super::layers`]、[`super::assets`]，再把结果包成字节 + JSON。编码、预算、命名与打包全在
//! 那些纯函数里，因此原生测试可以直接覆盖，不需要 WASM 或界面。
//!
//! 事务边界（design「事务和生命周期」）：
//! - 打开在**候选文档**上成功后才替换当前文档（委托 [`crate::editor::Editor::open_image`]）；
//! - 导出/预览/逐层/资产都只读文档与选择，返回字节与报告，不改 doc、不进历史、不推进保存基线；
//! - 有笔迹或工具草稿时拒绝导出，避免交付半成品。
use serde_json::{json, Value};

use super::assets;
use super::export;
use super::formats;
use super::layers;
use crate::editor::Editor;
use crate::error::{EditorError, Result};

fn command_error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

impl Editor {
    /// U05：逐格式真实矩阵（图像不受当前文档影响）。
    pub fn interchange_matrix(&self) -> Value {
        json!({
            "formats": formats::compatibility_matrix(),
            "openable": formats::openable_extensions(),
            "exportable": formats::exportable_formats()
                .into_iter()
                .map(|format| format.extensions()[0])
                .collect::<Vec<_>>(),
            "budgets": super::budgets::budgets(),
            "capabilities": super::INTERCHANGE_CAPABILITIES,
        })
    }

    /// U05：打开前预检，真实解码一次以核对位深与尺寸（不创建文档）。
    pub fn inspect_raster(&self, bytes: &[u8]) -> Result<Value> {
        let (inspection, image) = formats::inspect_raster_decoded(bytes)?;
        let mut value = serde_json::to_value(&inspection).map_err(|error| command_error("format.openRaster", error))?;
        if let Some(object) = value.as_object_mut() {
            object.insert("width".into(), json!(image.width()));
            object.insert("height".into(), json!(image.height()));
            object.insert("documentChanged".into(), json!(false));
        }
        Ok(value)
    }

    /// U05：可编辑打开。准入由矩阵判定，真正的解码与建文档复用既有导入链。
    ///
    /// 非矩阵格式（PSD/SVG/工程）在预检就被拒绝，因此本入口不会绕开各自的专用打开流程。
    ///
    /// 这里必须和 [`Self::inspect_raster`] 走**同一套**真实解码准入：只按签名过预检会让
    /// 16 位/浮点样本"预检拒绝、打开却成功"，等于绕过「不自动降位深」。因此先完整解码一次
    /// 核对位深与尺寸，再交给共享导入链建文档（两者共用同一份预算）。
    pub fn open_raster(&mut self, name: &str, bytes: &[u8]) -> Result<Value> {
        let (inspection, _decoded) = formats::inspect_raster_decoded(bytes)?;
        let mut state = self.open_image(name, None, bytes)?;
        if let Some(object) = state.as_object_mut() {
            object.insert(
                "raster".into(),
                json!({
                    "format": inspection.format,
                    "name": inspection.name,
                    "mime": inspection.mime,
                    "readOnly": inspection.read_only,
                    "documentChanged": true,
                }),
            );
        }
        Ok(state)
    }

    /// U06：通用导出矩阵（格式、参数与可用的 Save for Web 格式词）。
    pub fn export_matrix(&self) -> Value {
        export::export_matrix()
    }

    /// U06：导出预检（设置归一化 + 目标尺寸 + 格式能力），不编码、不改文档。
    pub fn inspect_export(&self, params: Value) -> Result<Value> {
        // 与交付同一道草稿门：预检能看到的东西必须能一次交付，否则界面会显示不可用的计划。
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let settings = export::parse_settings(&params)?;
        let doc = &self.active_doc()?.doc;
        let target = settings.size.target(doc.size.width, doc.size.height);
        export::validate_target(&settings, target)?;
        Ok(json!({
            "ok": true,
            "mode": match settings.mode { export::ExportMode::Export => "export", export::ExportMode::Web => "web" },
            "format": settings.extension,
            "mime": settings.format.mime_type(),
            "width": target.0,
            "height": target.1,
            "sourceWidth": doc.size.width,
            "sourceHeight": doc.size.height,
            "settings": settings.inspect_json(),
            "webFormats": export::web_formats_for(settings.format),
            "documentChanged": false,
        }))
    }

    /// U06：真实编码预览。返回的就是交付字节（同一编码器），预览不提交任何内容。
    pub fn preview_export(&self, params: Value) -> Result<(Vec<u8>, Value)> {
        self.encode_for_interchange(&params, true)
    }

    /// U06：导出交付。与预览同源同设置，导出不推进工程保存基线。
    pub fn export_raster(&self, params: Value) -> Result<(Vec<u8>, Value)> {
        self.encode_for_interchange(&params, false)
    }

    fn encode_for_interchange(&self, params: &Value, preview: bool) -> Result<(Vec<u8>, Value)> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let settings = export::parse_settings(params)?;
        let state = self.active_doc()?;
        let revision = state.revision;
        let hash = self.content_hash()?;
        let encoded = export::encode_export(&state.doc, &settings, revision, &hash, preview)?;
        Ok((encoded.bytes, encoded.report))
    }

    /// U07：逐层导出计划（目标层、边界、交付名、改写原因与预算），不编码。
    pub fn inspect_layer_export(&self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let plan = layers::plan_layers(&state.doc, state.active_layer, &state.selected_layers, &params)?;
        Ok(layers::plan_json(&plan))
    }

    /// U07：逐层/Layers to Files 交付（内存 ZIP + `report.json`）。
    pub fn export_layer_bundle(&self, params: Value) -> Result<(Vec<u8>, Value)> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let plan = layers::plan_layers(&state.doc, state.active_layer, &state.selected_layers, &params)?;
        let hash = self.content_hash()?;
        let encoded = layers::export_layers(&state.doc, &plan, state.revision, &hash)?;
        Ok((encoded.bytes, encoded.report))
    }

    /// U07：单层 Quick Export / Export As（多格式、可缩放）。
    ///
    /// 交付的是**隔离图层**的像素（边界与逐层包一致），不是整个画布。
    pub fn export_layer_as(&self, params: Value) -> Result<(Vec<u8>, Value)> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let layer_id = match params.get("layer") {
            Some(value) => value.as_u64().ok_or_else(|| command_error("format.layers.export", "`layer` 必须是图层 id"))?,
            None => state
                .active_layer
                .map(|id| id.0)
                .ok_or_else(|| command_error("format.layers.export", "未选择任何图层"))?,
        };
        if state.doc.layer(photocraft_doc::LayerId(layer_id)).is_none() {
            return Err(command_error("format.layers.export", format!("目标图层已失效：{layer_id}")));
        }
        // 缺省格式是 PNG：快速导出不该强迫调用方先选格式。
        let mut settings_params = params.clone();
        if settings_params.get("format").is_none() {
            if let Some(object) = settings_params.as_object_mut() {
                object.insert("format".into(), json!("png"));
            }
        }
        let settings = export::parse_settings(&settings_params)?;
        let isolated = photocraft_engine::layer_menu_cmds::layer_document(&state.doc, photocraft_doc::LayerId(layer_id))
            .map_err(|error| command_error("format.layers.export", error))?;
        let hash = self.content_hash()?;
        let encoded = export::encode_export(&isolated, &settings, state.revision, &hash, false)?;
        let mut report = encoded.report;
        if let Some(object) = report.as_object_mut() {
            object.insert("kind".into(), json!("layer-export"));
            object.insert("layerId".into(), json!(layer_id));
            object.insert(
                "layerName".into(),
                json!(state.doc.layer(photocraft_doc::LayerId(layer_id)).map(|layer| layer.name.clone())),
            );
        }
        Ok((encoded.bytes, report))
    }

    /// U07：按名称资产的计划（语法展开、尺寸、清理后的相对路径与预算），不编码。
    pub fn inspect_image_assets(&self) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let plan = assets::plan_assets(&state.doc)?;
        Ok(assets::plan_json(&plan))
    }

    /// U07：按名称资产交付（一次用户触发；内存 ZIP + `report.json`，不启动后台生成器）。
    pub fn export_image_assets(&self) -> Result<(Vec<u8>, Value)> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let plan = assets::plan_assets(&state.doc)?;
        let hash = self.content_hash()?;
        let encoded = assets::export_assets(&state.doc, &plan, state.revision, &hash)?;
        Ok((encoded.bytes, encoded.report))
    }

    /// U07：复核已交付的包（条目 + `report.json`），用于交付后核对。
    pub fn inspect_io_bundle(&self, bytes: &[u8]) -> Result<Value> {
        layers::inspect_bundle(bytes)
    }
}
