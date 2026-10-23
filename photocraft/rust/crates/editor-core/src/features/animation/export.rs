//! 帧序列交付：把文档的每个时间轴帧合成为字节（design D2/D4）。
//!
//! 与上游 `file.export.renderVideo` 的区别是**不接受路径、不写文件**：上游那条命令需要
//! `std::fs`，浏览器里没有等价物，因此不进入命令门。本模块提供：
//!
//! - [`render_frame_bytes`]：按帧号合成单个文档的某一帧（逐帧交付，宿主负责下载）；
//! - [`encode_frames`]：把已渲染的 RGBA8 帧编为一条动画 GIF（真实可播放的动画交付）；
//! - [`DeliveryReport`]：逐帧进度/失败/取消的报告，取消发生在帧边界，不产出半成品。
//!
//! 预算：帧数与累计像素由 [`super::limits::FrameBudget`] 校验；编码前的 RGBA 暂存累计超过
//! 128 MiB 时拒绝整次交付，而不是逐帧重发预算。
//!
//! 视频容器（MP4/WebM）不在这里编码：浏览器侧依赖 WebCodecs + 容器 mux，属于公共 codec 端口
//! （`packages/protocol/src/features/animation/` 的 `AnimationCodecPort`）。内核只声明「该端口
//! 支持什么」，不支持时由界面禁用并给出原因，绝不用只取首帧的图片冒充视频。

use photocraft_doc::{Document, LayerContent};
use serde_json::{Value, json};

use super::limits::{FrameBudget, FrameBudgetError, MAX_FRAMES};

/// 逐帧交付结果（不含像素本身，界面按帧号再取字节）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryReport {
    /// 交付的帧数。
    pub frames: usize,
    /// 画布宽高。
    pub width: u32,
    pub height: u32,
    /// 帧率（时间轴缺省时 30）。
    pub fps_millis: u32,
    /// 每帧的字节长度（RGBA8）。
    pub frame_bytes: usize,
}

/// 交付失败：预算、取消或帧合成失败，都带稳定 code。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryFailure {
    pub code: &'static str,
    pub message: String,
}

impl DeliveryFailure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 一次交付的帧数：时间轴存在时用其 `duration`，否则视为单帧。
pub fn frame_count(doc: &Document) -> usize {
    doc.timeline.as_ref().map_or(1, |timeline| timeline.duration).max(1)
}

/// 帧率（毫秒表示，避免浮点在报告里抖动）：缺省 30 fps。
pub fn fps_millis(doc: &Document) -> u32 {
    let fps = doc.timeline.as_ref().map_or(30.0, |timeline| timeline.fps);
    if !fps.is_finite() || fps <= 0.0 {
        return 1000 / 30;
    }
    (1000.0f32 / fps).round().clamp(1.0, u32::MAX as f32) as u32
}

/// 交付前的预算与形状检查；返回总帧数与单帧字节数。
pub fn plan_delivery(doc: &Document) -> Result<DeliveryReport, DeliveryFailure> {
    let frames = frame_count(doc);
    if frames > MAX_FRAMES {
        return Err(DeliveryFailure::new(
            FrameBudgetError::TooManyFrames.code(),
            FrameBudgetError::TooManyFrames.message(frames),
        ));
    }
    let bounds = doc.bounds();
    let width = bounds.width();
    let height = bounds.height();
    if width == 0 || height == 0 {
        return Err(DeliveryFailure::new(
            FrameBudgetError::InvalidFrameSize.code(),
            "画布尺寸为 0，无法交付帧序列",
        ));
    }
    let budget = FrameBudget::new();
    // 逐帧只消耗增量：累计像素 = 帧数 × 单帧像素。
    budget
        .check_pixels(u64::from(width) * u64::from(height) * frames as u64)
        .map_err(|error| DeliveryFailure::new(error.code(), error.message(frames)))?;
    let frame_bytes = width as usize * height as usize * 4;
    budget
        .check_delivery_bytes(frame_bytes as u64 * frames as u64)
        .map_err(|error| {
            DeliveryFailure::new(error.code(), error.message(frame_bytes as u64 * frames as u64))
        })?;
    Ok(DeliveryReport { frames, width, height, fps_millis: fps_millis(doc), frame_bytes })
}

/// 克隆文档并把播放头移到 `frame`，同时同步所有视频层显示内容。
///
/// 不修改调用方文档：交付冻结的是快照（design D4），因此导出期间继续编辑不会混入半成品。
///
/// 上游把「当前帧写回帧栈 + 按播放头换显示内容」放在引擎私有模块 `video_cmds`（`pub mod` 未
/// 导出），因此这里按同一语义实现最小同步：先把显示内容写回其所在帧，再把显示内容换成目标帧。
/// 集成阶段可由集成负责人把 `video_cmds::{store,sync}` 重新导出（`12§` 见 change 的
/// verification 记录），届时本函数改为直接调用，行为不变。
pub fn frame_document(doc: &Document, frame: usize) -> Result<Document, DeliveryFailure> {
    let report = plan_delivery(doc)?;
    if frame >= report.frames {
        return Err(DeliveryFailure::new(
            "frame-out-of-range",
            format!("帧号超出时间轴范围：{frame} >= {}", report.frames),
        ));
    }
    let mut snapshot = doc.clone();
    // 先把显示内容写回它所在的帧，再移动播放头——顺序与上游 `timeline_cmds::with_timeline` 一致；
    // 反过来会把当前显示的这一帧覆盖到目标帧上，导致每帧导出同一张图。
    store_display_content(&mut snapshot);
    if let Some(timeline) = &mut snapshot.timeline {
        timeline.current = frame;
    }
    sync_display_content(&mut snapshot, frame);
    Ok(snapshot)
}

/// 把每个视频层的显示内容写回其当前帧（编辑结果不能丢）。
///
/// 返回是否真的写入了内容：`VideoData` 的 `PartialEq` 只比帧栈形状（见上游 `doc::video`），
/// 用它判断「有没有改」会把像素变化误判成未变，因此这里逐帧按 `Surface` 内容比较。
pub fn store_display_content(doc: &mut Document) -> bool {
    let current = doc.timeline.as_ref().map_or(0, |timeline| timeline.current);
    store_layers(&mut doc.layers, current)
}

/// 把每个视频层的显示内容换成 `frame`（越界时停在最后一帧，与引擎一致）。
pub fn sync_display_content(doc: &mut Document, frame: usize) {
    sync_layers(&mut doc.layers, frame);
}

fn store_layers(layers: &mut [photocraft_doc::Layer], current: usize) -> bool {
    let mut changed = false;
    for layer in layers.iter_mut() {
        if let (Some(video), LayerContent::Raster(surface)) = (&mut layer.video, &layer.content)
            && (video.show_altered || video.original_frames.is_none())
        {
            let slot = current.min(video.frames.len().saturating_sub(1));
            if let Some(frame) = video.frames.get_mut(slot)
                && *frame != *surface
            {
                *frame = surface.clone();
                changed = true;
            }
        }
        if let LayerContent::Group(group) = &mut layer.content
            && store_layers(&mut group.children, current)
        {
            changed = true;
        }
    }
    changed
}

fn sync_layers(layers: &mut [photocraft_doc::Layer], frame: usize) {
    for layer in layers.iter_mut() {
        let target = layer.video.as_ref().and_then(|video| {
            let visible = if video.show_altered { &video.frames } else { video.original_frames.as_ref().unwrap_or(&video.frames) };
            visible.get(frame.min(visible.len().saturating_sub(1))).cloned()
        });
        if let Some(surface) = target
            && let LayerContent::Raster(content) = &mut layer.content
        {
            *content = surface;
        }
        if let LayerContent::Group(group) = &mut layer.content {
            sync_layers(&mut group.children, frame);
        }
    }
}

/// 合成单帧为 RGBA8（行优先，长度 `width * height * 4`）。
pub fn render_frame_rgba(doc: &Document, frame: usize) -> Result<Vec<u8>, DeliveryFailure> {
    let snapshot = frame_document(doc, frame)?;
    let bounds = snapshot.bounds();
    let width = bounds.width() as usize;
    let height = bounds.height() as usize;
    let bytes = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| DeliveryFailure::new("delivery-bytes-exceeded", "帧字节长度溢出"))?;
    let mut rgba = vec![0u8; bytes];
    let buffer = photocraft_compose::render(&snapshot, bounds);
    for (out, pixel) in rgba.chunks_exact_mut(4).zip(buffer.px.iter()) {
        for (channel, value) in out.iter_mut().zip(pixel.iter()) {
            *channel = (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    Ok(rgba)
}

/// 一帧的索引色版本（供动画 GIF）。
#[derive(Debug)]
pub struct IndexedFrame {
    pub indices: Vec<u8>,
    pub palette: Vec<[u8; 3]>,
    pub transparent: Option<u8>,
    pub delay_cs: u16,
}

/// 把 RGBA8 帧量化为索引色：alpha < 0.5 记透明，和上游 Save for Web 的 GIF 一致。
pub fn index_frame(rgba: &[u8], width: u32, height: u32, delay_cs: u16) -> Result<IndexedFrame, DeliveryFailure> {
    use photocraft_algo::quantize::{self, Dither, Forced, PaletteKind};
    let pixels = width as usize * height as usize;
    if rgba.len() != pixels * 4 {
        return Err(DeliveryFailure::new("invalid-frame-bytes", "帧字节长度与画布不符"));
    }
    let mut px: Vec<[f32; 4]> = rgba
        .chunks_exact(4)
        .map(|p| [f32::from(p[0]) / 255.0, f32::from(p[1]) / 255.0, f32::from(p[2]) / 255.0, f32::from(p[3]) / 255.0])
        .collect();
    let transparent = px.iter().any(|p| p[3] < 0.5);
    let visible: Vec<[f32; 4]> = px.iter().filter(|p| p[3] >= 0.5).map(|p| [p[0], p[1], p[2], 1.0]).collect();
    let source = if visible.is_empty() { &px } else { &visible };
    let mut palette = quantize::build_palette(source, PaletteKind::Adaptive, if transparent { 255 } else { 256 }, Forced::None)
        .map_err(|error| DeliveryFailure::new("encode-failed", error))?;
    let index = transparent.then(|| {
        palette.truncate(255);
        palette.push(palette.first().copied().unwrap_or([0, 0, 0]));
        palette.len() - 1
    });
    let indices = quantize::quantize(&mut px, width as usize, &palette, Dither::None, 1.0, index);
    Ok(IndexedFrame { indices, palette, transparent: index.map(|i| i as u8), delay_cs })
}

/// 编码动画 GIF；`frames` 必须与画布尺寸一致。
pub fn encode_gif(width: u32, height: u32, frames: &[IndexedFrame], loop_forever: bool) -> Result<Vec<u8>, DeliveryFailure> {
    if frames.is_empty() {
        return Err(DeliveryFailure::new("empty-delivery", "动画至少需要一帧"));
    }
    if frames.len() > MAX_FRAMES {
        return Err(DeliveryFailure::new(
            FrameBudgetError::TooManyFrames.code(),
            FrameBudgetError::TooManyFrames.message(frames.len()),
        ));
    }
    let gif_frames: Vec<photocraft_codecs::web::GifFrame> = frames
        .iter()
        .map(|frame| photocraft_codecs::web::GifFrame {
            indices: frame.indices.clone(),
            palette: frame.palette.clone(),
            transparent: frame.transparent,
            delay_cs: frame.delay_cs,
        })
        .collect();
    photocraft_codecs::web::encode_gif_animated(width, height, &gif_frames, loop_forever)
        .map_err(|error| DeliveryFailure::new("encode-failed", error.to_string()))
}

/// 帧率对应的 GIF 帧延迟（厘秒）；GIF 只有 1–65535 cs。
pub fn gif_delay_cs(fps_millis: u32) -> u16 {
    (fps_millis / 10).clamp(1, u16::MAX as u32) as u16
}

/// 逐帧遍历视频层的报告（界面用来显示「第 i/n 帧」与取消）。
pub fn video_layer_frame_counts(doc: &Document) -> Vec<Value> {
    fn walk(layers: &[photocraft_doc::Layer], out: &mut Vec<Value>) {
        for layer in layers {
            if let Some(video) = &layer.video {
                out.push(json!({
                    "layerId": layer.id.0,
                    "name": layer.name,
                    "frames": video.frames.len(),
                    "fps": f64::from(video.fps),
                    "showAltered": video.show_altered,
                    "hasOriginal": video.original_frames.is_some(),
                }));
            }
            if let LayerContent::Group(group) = &layer.content {
                walk(&group.children, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(&doc.layers, &mut out);
    out
}

#[cfg(test)]
#[path = "tests_delivery.rs"]
mod tests;
