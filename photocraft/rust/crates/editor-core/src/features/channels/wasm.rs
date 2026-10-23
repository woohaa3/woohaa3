//! 通道与通道计算的 WASM 绑定（只做类型转换，逻辑在 [`crate::Editor`] 上可原生测试）。
use super::*;

#[wasm_bindgen]
impl WasmEditor {
    /// 通道命令（创建/复制/删除/改名/排序/目标/显隐/选项/拆合/应用图像/计算/亮度选区）。
    #[wasm_bindgen(js_name = channelCommand)]
    pub fn channel_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .channel_command(id, parse_params(params_json)?)
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 通道面板快照（通道行、目标、显隐、来源文档与预算）。
    #[wasm_bindgen(js_name = channelSnapshotJson)]
    pub fn channel_snapshot_json(&self) -> Result<String, JsValue> {
        self.inner
            .channel_snapshot()
            .map(|value| value.to_string())
            .map_err(|error| js_error(&error))
    }

    /// 单通道缩略图：`referenceJson` 是 `"composite"`、`{color:k}`、`{alpha:i}` 或 `"mask"`。
    #[wasm_bindgen(js_name = channelThumbnail)]
    pub fn channel_thumbnail(&self, reference_json: &str, max_side: u32) -> Result<WasmPreview, JsValue> {
        let preview = self
            .inner
            .channel_thumbnail(parse_params(reference_json)?, max_side)
            .map_err(|error| js_error(&error))?;
        Ok(WasmPreview { width: preview.width, height: preview.height, pixels: preview.pixels })
    }

    /// 当前通道视图预览（单通道灰度或合成）；不改编辑目标。
    #[wasm_bindgen(js_name = channelViewPreview)]
    pub fn channel_view_preview(&self, max_side: u32) -> Result<WasmPreview, JsValue> {
        let preview = self
            .inner
            .channel_view_preview(max_side)
            .map_err(|error| js_error(&error))?;
        Ok(WasmPreview { width: preview.width, height: preview.height, pixels: preview.pixels })
    }

    /// 应用图像/计算的隔离预览像素；正式文档、修订与历史都不变。
    #[wasm_bindgen(js_name = channelCalcPreview)]
    pub fn channel_calc_preview(&self, id: &str, params_json: &str, max_side: u32) -> Result<WasmPreview, JsValue> {
        let (preview, _) = self
            .inner
            .channel_calc_preview(id, parse_params(params_json)?, max_side)
            .map_err(|error| js_error(&error))?;
        Ok(WasmPreview { width: preview.width, height: preview.height, pixels: preview.pixels })
    }

    /// 应用图像/计算的候选摘要（通道行、修订变化与文档数）；确认前界面据此给出反馈。
    #[wasm_bindgen(js_name = channelCalcPreviewJson)]
    pub fn channel_calc_preview_json(&self, id: &str, params_json: &str, max_side: u32) -> Result<String, JsValue> {
        self.inner
            .channel_calc_preview(id, parse_params(params_json)?, max_side)
            .map(|(_, summary)| summary.to_string())
            .map_err(|error| js_error(&error))
    }
}
