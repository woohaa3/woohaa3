//! U05/U06/U07 的 wasm-bindgen 绑定（change: 2026-10-22-add-photocraft-raster-interchange）。
//!
//! 与其余域一样只做类型转换：字节以 `Vec<u8>`（WASM 内存的一次拷贝）交付，报告以 JSON 字符串
//! 交付，避免把未校验的对象结构透传进 JS。预览与交付返回**同一个** [`WasmEncodedImage`]：
//! `bytes` 就是真实编码结果，`reportJson` 是同一次调用的报告，因此界面不会出现「预览一套、交付
//! 另一套」。
use wasm_bindgen::prelude::*;

use super::super::{js_error, parse_params, WasmEditor};

/// 一次编码/打包产物：真实字节 + 报告。
#[wasm_bindgen]
pub struct WasmEncodedImage {
    bytes: Vec<u8>,
    report_json: String,
}

#[wasm_bindgen]
impl WasmEncodedImage {
    /// 交付字节（预览时就是真实编码结果，可直接当图片显示）。
    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.bytes.clone()
    }

    /// 同一次调用的报告（格式、尺寸、改动标记、逐项结果）。
    #[wasm_bindgen(getter, js_name = reportJson)]
    pub fn report_json(&self) -> String {
        self.report_json.clone()
    }
}

fn encoded(bytes: Vec<u8>, report: serde_json::Value) -> WasmEncodedImage {
    WasmEncodedImage { bytes, report_json: report.to_string() }
}

#[wasm_bindgen]
impl WasmEditor {
    /// U05：逐格式矩阵、可打开/可导出扩展名、域预算与能力 id。
    #[wasm_bindgen(js_name = interchangeMatrixJson)]
    pub fn interchange_matrix_json(&self) -> String {
        self.inner.interchange_matrix().to_string()
    }

    /// U05：打开前预检（真实解码一次，核对位深与尺寸；不创建文档）。
    #[wasm_bindgen(js_name = inspectRaster)]
    pub fn inspect_raster(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.inspect_raster(bytes).map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// U05：可编辑打开（成功后替换当前文档，失败保留现场）。
    #[wasm_bindgen(js_name = openRaster)]
    pub fn open_raster(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.open_raster(name, bytes).map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// U06：通用导出矩阵（格式、参数集合与可用的 Save for Web 格式词）。
    #[wasm_bindgen(js_name = exportMatrixJson)]
    pub fn export_matrix_json(&self) -> String {
        self.inner.export_matrix().to_string()
    }

    /// U06：导出预检（设置归一化 + 目标尺寸），不编码、不改文档。
    #[wasm_bindgen(js_name = inspectExport)]
    pub fn inspect_export(&self, params_json: &str) -> Result<String, JsValue> {
        let params = parse_params(params_json)?;
        self.inner.inspect_export(params).map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// U06：真实编码预览（与交付同一编码器、同一快照；不提交任何内容）。
    #[wasm_bindgen(js_name = previewExport)]
    pub fn preview_export(&self, params_json: &str) -> Result<WasmEncodedImage, JsValue> {
        let params = parse_params(params_json)?;
        self.inner.preview_export(params).map(|(bytes, report)| encoded(bytes, report)).map_err(|error| js_error(&error))
    }

    /// U06：导出交付（不推进工程保存基线）。
    #[wasm_bindgen(js_name = exportRaster)]
    pub fn export_raster(&self, params_json: &str) -> Result<WasmEncodedImage, JsValue> {
        let params = parse_params(params_json)?;
        self.inner.export_raster(params).map(|(bytes, report)| encoded(bytes, report)).map_err(|error| js_error(&error))
    }

    /// U07：逐层导出计划（目标层、边界、交付名、改写原因与预算），不编码。
    #[wasm_bindgen(js_name = inspectLayerExport)]
    pub fn inspect_layer_export(&self, params_json: &str) -> Result<String, JsValue> {
        let params = parse_params(params_json)?;
        self.inner.inspect_layer_export(params).map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// U07：逐层 / Layers to Files 交付（内存 ZIP + `report.json`）。
    #[wasm_bindgen(js_name = exportLayerBundle)]
    pub fn export_layer_bundle(&self, params_json: &str) -> Result<WasmEncodedImage, JsValue> {
        let params = parse_params(params_json)?;
        self.inner
            .export_layer_bundle(params)
            .map(|(bytes, report)| encoded(bytes, report))
            .map_err(|error| js_error(&error))
    }

    /// U07：单层 Quick Export / Export As（缺省 PNG）。
    #[wasm_bindgen(js_name = exportLayerAs)]
    pub fn export_layer_as(&self, params_json: &str) -> Result<WasmEncodedImage, JsValue> {
        let params = parse_params(params_json)?;
        self.inner
            .export_layer_as(params)
            .map(|(bytes, report)| encoded(bytes, report))
            .map_err(|error| js_error(&error))
    }

    /// U07：按名称资产计划（语法展开、尺寸、清理后的相对路径与预算），不编码。
    #[wasm_bindgen(js_name = inspectImageAssets)]
    pub fn inspect_image_assets(&self) -> Result<String, JsValue> {
        self.inner.inspect_image_assets().map(|value| value.to_string()).map_err(|error| js_error(&error))
    }

    /// U07：按名称资产交付（一次用户触发；不启动后台生成器）。
    #[wasm_bindgen(js_name = exportImageAssets)]
    pub fn export_image_assets(&self) -> Result<WasmEncodedImage, JsValue> {
        self.inner
            .export_image_assets()
            .map(|(bytes, report)| encoded(bytes, report))
            .map_err(|error| js_error(&error))
    }

    /// U07：复核已交付的包（条目 + `report.json`）。
    #[wasm_bindgen(js_name = inspectIoBundle)]
    pub fn inspect_io_bundle(&self, bytes: &[u8]) -> Result<String, JsValue> {
        self.inner.inspect_io_bundle(bytes).map(|value| value.to_string()).map_err(|error| js_error(&error))
    }
}
