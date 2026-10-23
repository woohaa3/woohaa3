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
    /// 最近一次 PSD 导出的逐层报告（导出返回字节，报告随即可读）。
    last_psd_report: String,
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

    /// 新建空会话。
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmEditor {
        WasmEditor { inner: Editor::new(), last_psd_report: "null".into() }
    }

    /// 上游固定提交、格式版本与构建信息。
    #[wasm_bindgen(js_name = buildInfoJson)]
    pub fn build_info_json() -> String {
        serde_json::to_string(&crate::build_info()).unwrap_or_else(|_| "{}".into())
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

    /// 当前文档内容指纹。
    #[wasm_bindgen(js_name = contentHash)]
    pub fn content_hash(&self) -> Result<String, JsValue> {
        self.inner.content_hash().map_err(|e| js_error(&e))
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

    /// 分阶段能力协商快照：`{stages, capabilities}`，UI 必须与自身契约逐项一致。
    #[wasm_bindgen(js_name = capabilityHandshakeJson)]
    pub fn capability_handshake_json(&self) -> String {
        self.inner.capability_handshake().to_string()
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

/// 解析图层 id 数组；只接受正整数的 JSON 数组。
fn parse_layers(layers_json: &str) -> Result<Vec<u64>, JsValue> {
    let value = parse_params(layers_json)?;
    let list = value.as_array().ok_or_else(|| {
        JsValue::from_str(&serde_json::json!({ "code": "bad-params", "message": "图层 id 必须是数组" }).to_string())
    })?;
    list.iter()
        .map(|item| {
            item.as_u64().ok_or_else(|| {
                JsValue::from_str(&serde_json::json!({ "code": "bad-params", "message": "图层 id 必须是整数" }).to_string())
            })
        })
        .collect()
}

#[path = "features/files/wasm.rs"]
mod files_feature;

#[path = "features/io/wasm.rs"]
mod io_feature;

#[path = "features/vectors/wasm.rs"]
mod vectors_feature;

#[path = "features/selections/wasm.rs"]
mod selections_feature;

#[path = "features/channels/wasm.rs"]
mod channels_feature;

#[path = "features/painting/wasm.rs"]
mod painting_feature;

#[path = "features/retouch/wasm.rs"]
mod retouch_feature;

#[path = "features/adjustments/wasm.rs"]
mod adjustments_feature;

#[path = "features/modes/wasm.rs"]
mod modes_feature;

#[path = "features/filters/wasm.rs"]
mod filters_feature;

#[path = "features/composition/wasm.rs"]
mod composition_feature;

#[path = "features/layers/wasm.rs"]
mod layers_feature;

#[path = "features/smart/wasm.rs"]
mod smart_feature;

#[path = "features/type/wasm.rs"]
mod type_feature;

#[path = "features/views/wasm.rs"]
mod views_feature;

#[path = "features/customization/wasm.rs"]
mod customization_feature;

#[path = "features/history/wasm.rs"]
mod history_feature;

#[path = "features/animation/wasm.rs"]
mod animation_feature;
