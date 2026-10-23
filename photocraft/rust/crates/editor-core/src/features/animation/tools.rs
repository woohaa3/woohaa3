//! U77：时间轴、视频图层与帧交付的统一入口
//! （change: 2026-10-22-add-photocraft-animation-workflows，design D1/D2/D4）。
//!
//! 事务规则与其它域一致：
//! - 内容写入（建时间轴、帧编辑、栅格化）走一次 `Session::execute` / `Session::edit`，
//!   一步历史；失败保留现场。
//! - **导航**（定位、步进、读取）不是历史步骤：上游这些命令 `journal: false`，
//!   这里也不额外记历史，因此播放/定位不新增历史（spec：播放不新增历史）。
//! - 交付冻结快照：渲染与编码都在副本上做，不移动活动文档的播放头（design D4）。
//!
//! 本模块不使用路径、不写文件：依赖 `std::fs` 的上游命令不进入命令门（见 [`super::mod`]）。
use serde_json::{Value, json};

use crate::editor::*;
use super::command_error;
use crate::features::animation::export;
use crate::features::animation::limits::{self, FrameBudget, FrameBudgetError};

impl Editor {
    /// 时间轴信息：`{timeline: {fps, duration, current, workStart, workEnd} | null}`，
    /// 附带本域的实际预算与逐帧交付摘要，界面据此渲染时间轴与参数栏。
    pub fn timeline_info(&self) -> Result<Value> {
        let doc = &self.active_doc()?.doc;
        let mut info = doc
            .timeline
            .as_ref()
            .map(|timeline| {
                json!({
                    "timeline": {
                        "fps": f64::from(timeline.fps),
                        "duration": timeline.duration,
                        "current": timeline.current,
                        "workStart": timeline.work_start,
                        "workEnd": timeline.work_end,
                        "time": f64::from(timeline.time()),
                    }
                })
            })
            .unwrap_or_else(|| json!({"timeline": null}));
        info["budget"] = json!({
            "maxFrames": limits::MAX_FRAMES,
            "maxCumulativeFramePixels": limits::MAX_CUMULATIVE_FRAME_PIXELS,
            "maxDecodeBytes": limits::MAX_DECODE_BYTES,
            "maxDeliveryBytes": limits::MAX_DELIVERY_BYTES,
            "maxFps": limits::MAX_FPS,
        });
        info["videoLayers"] = json!(export::video_layer_frame_counts(doc));
        Ok(info)
    }

    /// 建立或重建时间轴。`duration` 超过本域帧预算时拒绝（上游允许到 1,000,000 帧）。
    pub fn create_timeline(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let duration = params.get("duration").and_then(Value::as_u64).unwrap_or(30);
        let duration = usize::try_from(duration).unwrap_or(usize::MAX);
        if duration == 0 || duration > limits::MAX_FRAMES {
            return Err(command_error(
                "timeline.create",
                FrameBudgetError::TooManyFrames.message(duration),
            ));
        }
        if let Some(fps) = params.get("fps").and_then(Value::as_f64) {
            let fps = fps as f32;
            if let Err(error) = limits::valid_fps(fps) {
                return Err(command_error("timeline.create", error.message(fps)));
            }
        }
        self.execute("timeline.create", params)
    }

    /// 时间轴属性：帧率、时长、工作区范围。时长同样受本域预算约束。
    pub fn set_timeline_props(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if let Some(duration) = params.get("duration").and_then(Value::as_u64) {
            if duration == 0 || duration > limits::MAX_FRAMES as u64 {
                return Err(command_error(
                    "timeline.setProps",
                    FrameBudgetError::TooManyFrames.message(duration),
                ));
            }
        }
        if let Some(fps) = params.get("fps").and_then(Value::as_f64) {
            let fps = fps as f32;
            if let Err(error) = limits::valid_fps(fps) {
                return Err(command_error("timeline.setProps", error.message(fps)));
            }
        }
        for key in ["workStart", "workEnd"] {
            if let Some(value) = params.get(key).and_then(Value::as_u64) {
                if value > limits::MAX_FRAMES as u64 {
                    return Err(command_error(
                        "timeline.setProps",
                        format!("{key} 超过帧预算：{value} > {}", limits::MAX_FRAMES),
                    ));
                }
            }
        }
        let result = self.execute("timeline.setProps", params)?;
        Ok(result)
    }

    /// 定位/步进：只改会话播放位置，不产生历史步骤。
    pub fn navigate_timeline(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if id == "timeline.info" {
            return self.timeline_info();
        }
        let allowed = [
            "timeline.setFrame",
            "timeline.nextFrame",
            "timeline.previousFrame",
        ];
        if !allowed.contains(&id) {
            return Err(command_error("timeline.navigate", format!("{id} 不是时间轴导航命令")));
        }
        let steps_before = self.active_doc()?.history.past_len();
        if id == "timeline.setFrame" {
            let frame = params.get("frame").and_then(Value::as_u64).ok_or_else(|| {
                command_error("timeline.setFrame", "需要 frame（非负整数）")
            })?;
            if frame > limits::MAX_FRAMES as u64 {
                return Err(command_error(
                    "timeline.setFrame",
                    format!("帧号超过帧预算：{frame} > {}", limits::MAX_FRAMES),
                ));
            }
        }
        let result = self.execute(id, params)?;
        // 导航只推进修订，不记录历史；把实测差值回给界面与测试（spec：播放不新增历史）。
        let steps_after = self.active_doc()?.history.past_len();
        Ok(json!({
            "result": result,
            "historyAdded": steps_after.saturating_sub(steps_before),
        }))
    }

    /// 视频图层与帧编辑：统一走命令门，并保持图层预算。
    pub fn video_layer_command(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let allowed = [
            "layer.videoLayers.newBlankVideoLayer",
            "layer.videoLayers.insertBlankFrame",
            "layer.videoLayers.duplicateFrame",
            "layer.videoLayers.deleteFrame",
            "layer.videoLayers.restoreFrame",
            "layer.videoLayers.restoreAllFrames",
            "layer.videoLayers.showAlteredVideo",
            "layer.videoLayers.rasterize",
            "layer.rasterize.video",
            "layer.videoLayers.interpretFootage",
        ];
        if !allowed.contains(&id) {
            return Err(command_error("animation.video-layers", format!("{id} 不是已开放的视频图层命令")));
        }
        if id == "layer.videoLayers.newBlankVideoLayer" {
            self.check_layer_capacity()?;
        }
        // 解释素材只改视频层帧率：上游对 `fps` 不做任何校验（`0`/`NaN`/`∞` 会让交付除零或无限
        // 循环），因此在本域入口用同一套帧率预算先拒绝，且不写半份修改。
        if id == "layer.videoLayers.interpretFootage" {
            let fps = params.get("fps").and_then(Value::as_f64).unwrap_or(f64::NAN);
            if let Err(error) = limits::valid_fps(fps as f32) {
                return Err(command_error(id, error.message(fps)));
            }
        }
        // 恢复原始帧：上游取不到原始素材时会用**空白帧**顶替（`original.unwrap_or_else(blank)`），
        // 即把用户的帧清空。浏览器里的帧导入不产生原始素材副本（上游只有路径命令会写入
        // `original_frames`），因此这里必须拒绝，而不是把「没有可恢复的东西」实现成「清空」。
        if matches!(id, "layer.videoLayers.restoreFrame" | "layer.videoLayers.restoreAllFrames") {
            let doc = &self.active_doc()?.doc;
            let has_original = self
                .active_layer_id()
                .and_then(|layer| doc.layer(layer))
                .and_then(|layer| layer.video.as_ref())
                .is_some_and(|video| video.original_frames.is_some());
            if !has_original {
                return Err(command_error(
                    id,
                    "该视频层没有原始素材副本，无法恢复；恢复不会清空当前帧",
                ));
            }
        }
        // 插入/复制帧会增长帧栈：先在副本上算目标帧数，再按本域预算拒绝，避免先分配后拒绝。
        if matches!(id, "layer.videoLayers.insertBlankFrame" | "layer.videoLayers.duplicateFrame") {
            let doc = &self.active_doc()?.doc;
            let active = self.active_layer_id();
            let frames = active
                .and_then(|layer| doc.layer(layer))
                .and_then(|layer| layer.video.as_ref())
                .map_or(0, |video| video.frames.len());
            let next = if frames == 0 { 1 } else { frames + 1 };
            if next > limits::MAX_FRAMES {
                return Err(command_error(id, FrameBudgetError::TooManyFrames.message(next)));
            }
        }
        let result = self.execute(id, params)?;
        Ok(result)
    }

    /// 帧导入：把已解码的 RGBA8 帧写入视频层（浏览器侧解码，不经路径）。
    ///
    /// 全部帧先校验预算再写入：任一帧超限则整次导入失败，文档保持原样（不写半份帧栈）。
    pub fn import_frames(&mut self, name: &str, width: u32, height: u32, fps: f32, frames: Vec<Vec<u8>>) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let fps = limits::valid_fps(fps)
            .map_err(|error| command_error("animation.frame-import", error.message(fps)))?;
        if frames.is_empty() {
            return Err(command_error("animation.frame-import", "没有可导入的帧"));
        }
        // 先做完整预算核算：帧数、累计像素、解码字节都在这里拒绝，不触碰文档。
        let mut budget = FrameBudget::new();
        for frame in &frames {
            let decoded = frame.len() as u64;
            let expected = u64::from(width) * u64::from(height) * 4;
            if decoded != expected {
                return Err(command_error(
                    "animation.frame-import",
                    format!("帧字节长度与尺寸不符：{decoded} != {expected}"),
                ));
            }
            budget
                .add_frame(width, height, decoded)
                .map_err(|error| command_error("animation.frame-import", error.message(frames.len())))?;
        }
        self.check_layer_capacity()?;
        let name = sanitize_layer_name(name);
        let format = self.active_doc()?.doc.pixel_format();
        let count = frames.len();
        let surfaces = frames
            .into_iter()
            .map(|frame| surface_from_rgba(format, width, height, &frame))
            .collect::<Vec<_>>();
        let id = self
            .session
            .edit("Import Frames", |doc, active| {
                if doc.timeline.is_none() {
                    doc.timeline = Some(photocraft_doc::Timeline::new(count, fps));
                } else if let Some(timeline) = &mut doc.timeline {
                    // 导入的帧数可能超过当前时长：只增长，不缩短（与上游帧导入一致）。
                    if count > timeline.duration {
                        timeline.duration = count;
                        if timeline.work_end >= count {
                            timeline.work_end = count;
                        }
                    }
                    timeline.fps = fps;
                    timeline.clamp();
                }
                let mut layer = photocraft_doc::Layer::raster(&name, format);
                let mut video = photocraft_doc::VideoData::new(surfaces, fps);
                video.source = photocraft_doc::VideoSource::Blank;
                layer.video = Some(video);
                let layer_id = doc.insert_above(*active, layer);
                *active = Some(layer_id);
                // 显示内容换成当前播放头的那一帧；否则图层是空白内容，预览与导出都会丢帧。
                let current = doc.timeline.as_ref().map_or(0, |timeline| timeline.current);
                export::sync_display_content(doc, current);
                Ok(layer_id)
            })
            .map_err(|error| command_error("animation.frame-import", error.to_string()))?;
        let after = self.active_doc()?;
        Ok(json!({
            "layer": id.0,
            "frames": count,
            "width": width,
            "height": height,
            "fps": f64::from(fps),
            "duration": after.doc.timeline.as_ref().map_or(count, |timeline| timeline.duration),
        }))
    }

    /// 交付计划：帧数、尺寸、帧率与逐帧字节；不渲染像素（界面据此显示进度与拒绝原因）。
    pub fn delivery_plan(&self) -> Result<Value> {
        let doc = &self.active_doc()?.doc;
        let report = export::plan_delivery(doc).map_err(|failure| {
            command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message))
        })?;
        Ok(json!({
            "frames": report.frames,
            "width": report.width,
            "height": report.height,
            "fpsMillis": report.fps_millis,
            "frameBytes": report.frame_bytes,
            "totalBytes": report.frame_bytes as u64 * report.frames as u64,
        }))
    }

    /// 渲染单帧 RGBA8：返回的是**快照**帧，不移动活动文档的播放头。
    pub fn render_frame(&self, frame: usize) -> Result<Vec<u8>> {
        export::render_frame_rgba(&self.active_doc()?.doc, frame)
            .map_err(|failure| command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message)))
    }

    /// 把整段时间轴编成动画 GIF 字节（浏览器可直接下载播放）。
    pub fn render_animation_gif(&self) -> Result<Vec<u8>> {
        let doc = &self.active_doc()?.doc;
        let report = export::plan_delivery(doc)
            .map_err(|failure| command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message)))?;
        let delay = export::gif_delay_cs(report.fps_millis);
        let mut frames = Vec::with_capacity(report.frames);
        for frame in 0..report.frames {
            let rgba = export::render_frame_rgba(doc, frame)
                .map_err(|failure| command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message)))?;
            frames.push(
                export::index_frame(&rgba, report.width, report.height, delay)
                    .map_err(|failure| command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message)))?,
            );
        }
        export::encode_gif(report.width, report.height, &frames, true)
            .map_err(|failure| command_error("animation.frame-delivery", format!("{}: {}", failure.code, failure.message)))
    }

    /// 导出：把当前显示内容写回帧栈。
    ///
    /// 上游只在**导航**时写回（`timeline_cmds::with_timeline` 先 `store` 再换帧），而浏览器侧
    /// 保存由共享 `save_project`/`export_bundle` 负责，它不经过时间轴命令。因此在视频层上作画
    /// 后直接保存会丢掉「当前帧」的编辑（上游注释亦说明保存只保留当前帧作为图层内容）。
    ///
    /// 本入口把显示内容写回它所在的帧，供界面在内容提交后与宿主在保存/冻结前调用：
    /// - 有活动草稿（滤镜/修饰/选区/构图/笔触）时**不写回**：那时显示内容只是预览，写回会把
    ///   预览烧进帧栈（返回 `written: false`，原因 `draft-active`）；
    /// - 不新增历史步骤（写回的正是已提交的内容，避免一次作画产生两步撤销）；
    /// - 没有视频层或内容未变时不推进修订。
    pub fn flush_video_frames(&mut self) -> Result<Value> {
        if self.has_active_draft() {
            return Ok(json!({"written": false, "reason": "draft-active"}));
        }
        // 「显示原始素材」模式下画布上的编辑是预览，写回被跳过（上游 #3060）。此时**不能**报
        // `unchanged`：那会把「这次作画存不下来」说成「没有要写的东西」，用户保存后重开才发现丢了。
        if let Some(message) = crate::features::animation::content::original_view_edits_pending(&self.active_doc()?.doc) {
            return Ok(json!({"written": false, "reason": "original-view-preview", "message": message}));
        }
        let Some(state) = self.session.active_mut() else {
            return Ok(json!({"written": false, "reason": "no-document"}));
        };
        // 不能靠 `Document` 的相等比较判断「是否写回」：视频层帧栈的 `PartialEq` 只比形状，
        // 像素变化会被当成未变（见上游 `doc::video`）。
        let mut next = (*state.doc).clone();
        if !export::store_display_content(&mut next) {
            return Ok(json!({"written": false, "reason": "unchanged"}));
        }
        state.doc = std::sync::Arc::new(next);
        state.revision += 1;
        // 写回会改变帧栈；画面本身不变，因此不需要重绘整幅预览。
        state.last_damage = Some(photocraft_geom::Rect::EMPTY);
        Ok(json!({"written": true, "revision": state.revision}))
    }

    /// 是否有活动草稿（预览态）。写回帧栈前必须为空，否则会把预览烧进内容。
    fn has_active_draft(&self) -> bool {
        self.require_no_stroke().is_err() || self.require_no_tool_draft().is_err()
    }
}

/// 图层名：去掉控制字符并按 UTF-8 边界截断，避免把用户输入原样写进工程。
fn sanitize_layer_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).take(120).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() { "导入帧".into() } else { trimmed.to_string() }
}

/// 把 RGBA8 帧写成文档像素格式的表面；alpha 直通。
fn surface_from_rgba(
    format: photocraft_color::PixelFormat,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> photocraft_raster::Surface {
    let mut surface = photocraft_raster::Surface::new(format);
    let channels = format.channels();
    let mut row = Vec::with_capacity(width as usize * channels);
    for y in 0..height {
        row.clear();
        for x in 0..width {
            let index = ((y as usize * width as usize) + x as usize) * 4;
            let pixel = [
                f32::from(rgba[index]) / 255.0,
                f32::from(rgba[index + 1]) / 255.0,
                f32::from(rgba[index + 2]) / 255.0,
                f32::from(rgba[index + 3]) / 255.0,
            ];
            let mut samples = [0.0f32; 4];
            let written = photocraft_raster::from_rgba_into(&format, pixel, &mut samples);
            row.extend_from_slice(&samples[..written]);
        }
        for x in 0..width {
            let start = x as usize * channels;
            surface.write_pixel(x as i32, y as i32, &row[start..start + channels]);
        }
    }
    surface
}

#[cfg(test)]
#[path = "tests_timeline.rs"]
mod tests;
