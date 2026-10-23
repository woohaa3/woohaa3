//! 时间轴、视频图层与帧交付的 wasm-bindgen 绑定（U77）。
//!
//! 只做类型转换，业务规则都在 [`crate::Editor`] 上（原生可测）。约定与其它域一致：
//! - 参数走 JSON 字符串，返回也走 JSON 字符串，避免把未校验的对象结构透传进 JS；
//! - 帧像素走 `Uint8Array`（RGBA8 行优先），不经过 JSON，避免大幅面帧的数组展开开销；
//! - 错误是 `{"code","message"}` 的 JS 值，界面据此显示拒绝原因。
//!
//! 帧导入**接受已解码的字节**，不接受路径、不在内核里解码：浏览器侧用 WebCodecs /
//! `ImageDecoder` 解码，本机宿主用原生编解码器，两者都把 RGBA8 交给这里（design D2）。
use super::*;

/// 域内参数错误：与 `editor/tools.rs` 的 `command_error` 同形（那里是 `pub(super)`，跨模块不可见）。
fn command_error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.to_string(), message: message.to_string() }
}

#[wasm_bindgen]
impl WasmEditor {
    /// 时间轴信息（含预算与视频层摘要）。
    #[wasm_bindgen(js_name = timelineJson)]
    pub fn timeline_json(&self) -> Result<String, JsValue> {
        self.inner.timeline_info().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 建立或重建时间轴；`duration` 超出本域帧预算时拒绝。
    #[wasm_bindgen(js_name = createTimeline)]
    pub fn create_timeline(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.create_timeline(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 时间轴属性（帧率、时长、工作区范围）。
    #[wasm_bindgen(js_name = setTimelineProps)]
    pub fn set_timeline_props(&mut self, params_json: &str) -> Result<String, JsValue> {
        self.inner.set_timeline_props(parse_params(params_json)?).map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 定位/步进；不新增历史步骤（返回 `{result, historyAdded}`）。
    #[wasm_bindgen(js_name = navigateTimeline)]
    pub fn navigate_timeline(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .navigate_timeline(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 视频图层与帧编辑命令（统一走命令门与帧预算）。
    #[wasm_bindgen(js_name = videoLayerCommand)]
    pub fn video_layer_command(&mut self, id: &str, params_json: &str) -> Result<String, JsValue> {
        self.inner
            .video_layer_command(id, parse_params(params_json)?)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 导入已解码的 RGBA8 帧序列：`pixels` 是 `frame_count` 帧首尾相接的扁平字节。
    #[wasm_bindgen(js_name = importFrames)]
    pub fn import_frames(
        &mut self,
        name: &str,
        width: u32,
        height: u32,
        fps: f32,
        frame_count: u32,
        pixels: &[u8],
    ) -> Result<String, JsValue> {
        let frame_bytes = width as usize * height as usize * 4;
        if frame_bytes == 0 {
            return Err(js_error(&command_error("animation.frame-import", "帧尺寸为 0")));
        }
        let count = frame_count as usize;
        // 先核对扁平长度：JS 侧少给/多给字节是调用错误，要在分配前拒绝。
        let expected = frame_bytes.checked_mul(count).ok_or_else(|| {
            js_error(&command_error("animation.frame-import", "帧字节长度溢出"))
        })?;
        if pixels.len() != expected {
            return Err(js_error(&command_error(
                "animation.frame-import",
                format!("帧字节长度与帧数×尺寸不符：{} != {}", pixels.len(), expected),
            )));
        }
        let frames = pixels.chunks_exact(frame_bytes).map(<[u8]>::to_vec).collect();
        self.inner
            .import_frames(name, width, height, fps, frames)
            .map(|v| v.to_string())
            .map_err(|e| js_error(&e))
    }

    /// 交付计划：帧数、尺寸、帧率与逐帧字节；不渲染像素。
    #[wasm_bindgen(js_name = deliveryPlan)]
    pub fn delivery_plan(&self) -> Result<String, JsValue> {
        self.inner.delivery_plan().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }

    /// 渲染单帧 RGBA8（快照，不移动播放头）。
    #[wasm_bindgen(js_name = renderFrame)]
    pub fn render_frame(&self, frame: u32) -> Result<Vec<u8>, JsValue> {
        self.inner.render_frame(frame as usize).map_err(|e| js_error(&e))
    }

    /// 把整段时间轴编成动画 GIF 字节（浏览器可直接下载播放）。
    #[wasm_bindgen(js_name = renderAnimationGif)]
    pub fn render_animation_gif(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.render_animation_gif().map_err(|e| js_error(&e))
    }

    /// 把当前显示内容写回所在帧（保存/交付前调用，避免丢掉当前帧的编辑）。
    #[wasm_bindgen(js_name = flushVideoFrames)]
    pub fn flush_video_frames(&mut self) -> Result<String, JsValue> {
        self.inner.flush_video_frames().map(|v| v.to_string()).map_err(|e| js_error(&e))
    }
}
