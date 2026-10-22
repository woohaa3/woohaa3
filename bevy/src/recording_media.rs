//! 原生媒体解码：按 PTS 选帧
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.2 / design D4）。
//!
//! 规则与可见播放**同一公式**（`mediaTimelineLocalTime`）：
//! - `T < startTime` → 尚未开始（显示基础/首帧）；
//! - `u = (T - startTime) × timeScale`；
//! - 非循环 → `clamp(u, 0, duration)`；循环 → `u mod duration`；
//! - duration 非正 → 视为 0（首帧）。
//!
//! 解码契约：
//! - 图片保留 **alpha** 与色彩（PNG/WebP 的透明像素不能被填黑）；
//! - 视频按目标 PTS 选**覆盖该时刻**的帧，不用「duration - ε 猜尾帧」，也不用第一个解码帧冒充；
//! - 解码预算：单帧像素上限、每资源保留帧上限；超限明确失败而不是静默降级；
//! - 不依赖用户 PATH 或外部工具（纯 Rust 解码）。
//!
//! 只有 `recording-media` feature 编译（依赖图像/视频解码 crate）。

use std::collections::BTreeMap;
use std::path::Path;

/// 一帧解码结果：RGBA8、自顶向下，尺寸为实际编码尺寸。
///
/// 含 `f64` 时间，因此只实现 `PartialEq`。
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedFrame {
    pub width: u32,
    pub height: u32,
    /// 长度必须是 `width * height * 4`；alpha 保留（0 表示全透明）。
    pub rgba: Vec<u8>,
    /// 该帧对应的媒体时间（秒）；图片为 0。
    pub pts_seconds: f64,
}

/// 解码失败：稳定码 + 阶段。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeFailure {
    pub code: &'static str,
    pub message: String,
    pub stage: DecodeStage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeStage {
    /// 打不开/格式不支持。
    Format,
    /// 目标时刻没有可用帧。
    Selection,
    /// 超出预算。
    Budget,
    /// 解压/解码过程出错。
    Decode,
}

impl DecodeStage {
    pub fn proto_symbol(self) -> &'static str {
        match self {
            Self::Format => "RECORDING_ERROR_STAGE_DECODE",
            Self::Selection => "RECORDING_ERROR_STAGE_DECODE",
            Self::Budget => "RECORDING_ERROR_STAGE_DECODE",
            Self::Decode => "RECORDING_ERROR_STAGE_DECODE",
        }
    }
}

impl DecodeFailure {
    pub fn new(stage: DecodeStage, code: &'static str, message: impl Into<String>) -> Self {
        Self { stage, code, message: message.into() }
    }
}

/// 冻结的 playback 映射（与 contracts `FilmSetPlayback` 同语义）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlaybackMap {
    pub start_time: f64,
    /// 配置的播放时长（0 表示「用自身末帧」）。
    pub duration: f64,
    pub time_scale: f64,
    pub looped: bool,
    /// 媒体自身的真实时长（探针得到）。
    pub media_duration: f64,
}

impl Default for PlaybackMap {
    fn default() -> Self {
        Self { start_time: 0.0, duration: 0.0, time_scale: 1.0, looped: false, media_duration: 0.0 }
    }
}

impl PlaybackMap {
    /// 有效播放时长：配置值优先，否则用媒体自身时长。
    pub fn effective_duration(&self) -> f64 {
        if self.duration > 0.0 {
            self.duration
        } else if self.media_duration > 0.0 {
            self.media_duration
        } else {
            0.0
        }
    }

    /// 时间线时刻 T → 媒体局部时间；`None` 表示尚未开始。
    ///
    /// 与 `mediaTimelineLocalTime` 逐位同语义（含负帧/非有限值处理）。
    pub fn local_time(&self, timeline_seconds: f64) -> Option<f64> {
        let time = if timeline_seconds.is_finite() { timeline_seconds.max(0.0) } else { 0.0 };
        if time < self.start_time {
            return None;
        }
        let scale = if self.time_scale.is_finite() && self.time_scale > 0.0 {
            self.time_scale
        } else {
            1.0
        };
        let u = (time - self.start_time) * scale;
        let duration = self.effective_duration();
        if !(duration > 0.0) {
            return Some(0.0);
        }
        if self.looped {
            let wrapped = u.rem_euclid(duration);
            Some(wrapped)
        } else {
            Some(u.clamp(0.0, duration))
        }
    }
}

/// 解码预算。
#[derive(Clone, Copy, Debug)]
pub struct DecodeBudget {
    /// 单帧像素数上限（宽×高）。
    pub max_frame_pixels: u64,
    /// 单帧边长上限（H.264/纹理限制）。
    pub max_edge: u32,
    /// 视频解码时最多向前的关键帧搜索量（秒）；超出直接失败而不是无限 seek。
    pub max_seek_seconds: f64,
}

impl Default for DecodeBudget {
    fn default() -> Self {
        Self { max_frame_pixels: 4096 * 4096, max_edge: 4096, max_seek_seconds: 60.0 }
    }
}

impl DecodeBudget {
    /// 校验尺寸；超限返回 Budget 阶段失败。
    pub fn check_size(&self, width: u32, height: u32) -> Result<(), DecodeFailure> {
        if width == 0 || height == 0 {
            return Err(DecodeFailure::new(DecodeStage::Format, "recording-media-invalid-size", "媒体尺寸为 0"));
        }
        if width > self.max_edge || height > self.max_edge {
            return Err(DecodeFailure::new(
                DecodeStage::Budget,
                "recording-media-too-large",
                format!("媒体尺寸 {width}x{height} 超过 {0} 上限", self.max_edge),
            ));
        }
        if u64::from(width) * u64::from(height) > self.max_frame_pixels {
            return Err(DecodeFailure::new(
                DecodeStage::Budget,
                "recording-media-too-large",
                "媒体像素数超过单帧预算",
            ));
        }
        Ok(())
    }
}

/// 一个已注册的媒体源（worker 侧私有文件）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaSource {
    pub resource_id: String,
    pub path: std::path::PathBuf,
    pub content_type: String,
}

/// 解码器接口：真实实现与测试替身都实现它。
pub trait MediaDecoder {
    /// 媒体自身时长（秒）；图片为 0。
    fn duration_seconds(&self, source: &MediaSource) -> Result<f64, DecodeFailure>;
    /// 取覆盖 `local_seconds` 的那一帧（图片忽略时间，返回自身像素）。
    fn frame_at(&mut self, source: &MediaSource, local_seconds: f64) -> Result<DecodedFrame, DecodeFailure>;
    /// 释放一个源的解码资源。
    fn release(&mut self, resource_id: &str);
}

/// 简单缓存：同一源同一时刻只解一次，避免同帧被多个对象重复解码。
#[derive(Default)]
pub struct FrameCache {
    entries: BTreeMap<(String, i64), DecodedFrame>,
    max_entries: usize,
}

impl FrameCache {
    pub fn new(max_entries: usize) -> Self {
        Self { entries: BTreeMap::new(), max_entries: max_entries.max(1) }
    }

    /// 时间量化到毫秒（避免浮点噪声造成缓存永不命中）。
    fn key(source: &str, seconds: f64) -> (String, i64) {
        (source.to_owned(), (seconds.max(0.0) * 1000.0).round() as i64)
    }

    pub fn get(&self, source: &str, seconds: f64) -> Option<&DecodedFrame> {
        self.entries.get(&Self::key(source, seconds))
    }

    pub fn insert(&mut self, source: &str, seconds: f64, frame: DecodedFrame) {
        if self.entries.len() >= self.max_entries {
            // 有界：淘汰最早插入的一项（录制是顺序推进的，最旧的帧不会被再用）。
            if let Some(oldest) = self.entries.keys().next().cloned() {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(Self::key(source, seconds), frame);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// 按冻结映射取帧（带缓存）。
pub fn sample_media(
    decoder: &mut dyn MediaDecoder,
    cache: &mut FrameCache,
    source: &MediaSource,
    playback: &PlaybackMap,
    timeline_seconds: f64,
) -> Result<DecodedFrame, DecodeFailure> {
    let local = match playback.local_time(timeline_seconds) {
        Some(local) => local,
        // 尚未开始：显示起始帧（不是空帧），与可见播放一致。
        None => 0.0,
    };
    if let Some(frame) = cache.get(&source.resource_id, local) {
        return Ok(frame.clone());
    }
    let frame = decoder.frame_at(source, local)?;
    cache.insert(&source.resource_id, local, frame.clone());
    Ok(frame)
}

/// 按真实媒体时长补全 `PlaybackMap.media_duration`。
pub fn with_media_duration(
    decoder: &mut dyn MediaDecoder,
    source: &MediaSource,
    playback: PlaybackMap,
) -> Result<PlaybackMap, DecodeFailure> {
    let duration = decoder.duration_seconds(source)?;
    Ok(PlaybackMap { media_duration: duration, ..playback })
}

/// 只有图片（无时间维度）的类型。
pub fn is_image_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

/// 支持的视频类型；不支持的格式明确失败（不猜、不改后缀）。
pub fn is_supported_video_type(content_type: &str) -> bool {
    matches!(content_type, "video/mp4")
}

/// 校验源类型；不支持的返回 Format 阶段失败。
pub fn validate_source_type(content_type: &str) -> Result<(), DecodeFailure> {
    if is_image_content_type(content_type) {
        return match content_type {
            "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif" => Ok(()),
            other => Err(DecodeFailure::new(
                DecodeStage::Format,
                "recording-media-unsupported",
                format!("不支持的图片格式：{other}"),
            )),
        };
    }
    if is_supported_video_type(content_type) {
        return Ok(());
    }
    Err(DecodeFailure::new(
        DecodeStage::Format,
        "recording-media-unsupported",
        format!("不支持的媒体格式：{content_type}"),
    ))
}

/// 路径必须位于任务私有目录内（防止快照里夹带任意路径）。
pub fn ensure_inside(root: &Path, candidate: &Path) -> Result<(), DecodeFailure> {
    let root = root.to_path_buf();
    if !candidate.starts_with(&root) {
        return Err(DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-path-rejected",
            "媒体路径不在任务私有目录内",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, content_type: &str) -> MediaSource {
        MediaSource {
            resource_id: id.into(),
            path: std::path::PathBuf::from(format!("/tmp/{id}")),
            content_type: content_type.into(),
        }
    }

    /// 确定性替身：第 n 毫秒的帧填 n%256，便于断言选帧正确。
    struct FakeDecoder {
        frames_requested: Vec<f64>,
    }

    impl MediaDecoder for FakeDecoder {
        fn duration_seconds(&self, _source: &MediaSource) -> Result<f64, DecodeFailure> {
            Ok(3.5)
        }

        fn frame_at(&mut self, source: &MediaSource, local_seconds: f64) -> Result<DecodedFrame, DecodeFailure> {
            self.frames_requested.push(local_seconds);
            let marker = ((local_seconds * 1000.0).round() as i64).rem_euclid(256) as u8;
            Ok(DecodedFrame {
                width: 2,
                height: 2,
                rgba: vec![marker; 2 * 2 * 4],
                pts_seconds: local_seconds,
            })
        }

        fn release(&mut self, _resource_id: &str) {}
    }

    #[test]
    fn local_time_matches_the_contract_formula() {
        // 与 contracts `mediaTimelineLocalTime` 同一组用例。
        let map = PlaybackMap { start_time: 2.0, duration: 3.0, time_scale: 1.0, looped: false, media_duration: 10.0 };
        assert_eq!(map.local_time(1.0), None);
        assert_eq!(map.local_time(2.0), Some(0.0));
        assert_eq!(map.local_time(5.0), Some(3.0));
        assert_eq!(map.local_time(100.0), Some(3.0));

        let scaled = PlaybackMap { start_time: 2.0, duration: 3.0, time_scale: 2.0, looped: false, media_duration: 10.0 };
        assert_eq!(scaled.local_time(3.0), Some(2.0));
        assert_eq!(scaled.local_time(3.5), Some(3.0));

        let looped = PlaybackMap { start_time: 0.0, duration: 3.0, time_scale: 1.0, looped: true, media_duration: 3.0 };
        assert!((looped.local_time(7.0).unwrap() - 1.0).abs() < 1e-9);
        assert!((looped.local_time(6.0).unwrap()).abs() < 1e-9);
    }

    #[test]
    fn zero_duration_plays_the_first_frame() {
        let map = PlaybackMap::default();
        assert_eq!(map.local_time(5.0), Some(0.0));
        let media_only = PlaybackMap { media_duration: 4.0, ..PlaybackMap::default() };
        assert_eq!(media_only.local_time(2.0), Some(2.0));
        assert_eq!(media_only.local_time(9.0), Some(4.0));
    }

    #[test]
    fn invalid_inputs_are_clamped_not_propagated() {
        let map = PlaybackMap { start_time: 0.0, duration: 2.0, time_scale: f64::NAN, looped: false, media_duration: 2.0 };
        // 非法 timeScale 退化为 1，而不是产出 NaN 时间。
        assert_eq!(map.local_time(1.0), Some(1.0));
        let map = PlaybackMap { start_time: 0.0, duration: 2.0, time_scale: 1.0, looped: false, media_duration: 2.0 };
        assert_eq!(map.local_time(f64::NAN), Some(0.0));
        assert_eq!(map.local_time(-5.0), Some(0.0));
    }

    #[test]
    fn sampling_selects_the_frame_covering_the_target_time() {
        let mut decoder = FakeDecoder { frames_requested: Vec::new() };
        let mut cache = FrameCache::new(8);
        let source = source("a", "video/mp4");
        let playback = PlaybackMap { start_time: 0.0, duration: 3.0, time_scale: 1.0, looped: false, media_duration: 3.0 };

        let first = sample_media(&mut decoder, &mut cache, &source, &playback, 1.25).expect("frame");
        assert!((first.pts_seconds - 1.25).abs() < 1e-9);
        // 同一时刻命中缓存，不重复解码。
        let again = sample_media(&mut decoder, &mut cache, &source, &playback, 1.25).expect("cached");
        assert_eq!(again.rgba, first.rgba);
        assert_eq!(decoder.frames_requested, vec![1.25]);
    }

    #[test]
    fn sampling_holds_the_last_frame_past_the_end() {
        let mut decoder = FakeDecoder { frames_requested: Vec::new() };
        let mut cache = FrameCache::new(8);
        let source = source("a", "video/mp4");
        let playback = PlaybackMap { start_time: 0.0, duration: 2.0, time_scale: 1.0, looped: false, media_duration: 2.0 };
        let frame = sample_media(&mut decoder, &mut cache, &source, &playback, 10.0).expect("frame");
        // 尾帧保持在 duration，而不是「第一个解码帧」。
        assert!((frame.pts_seconds - 2.0).abs() < 1e-9);
    }

    #[test]
    fn before_start_time_uses_the_first_frame() {
        let mut decoder = FakeDecoder { frames_requested: Vec::new() };
        let mut cache = FrameCache::new(8);
        let source = source("a", "video/mp4");
        let playback = PlaybackMap { start_time: 2.0, duration: 3.0, time_scale: 1.0, looped: false, media_duration: 5.0 };
        let frame = sample_media(&mut decoder, &mut cache, &source, &playback, 0.5).expect("frame");
        assert!((frame.pts_seconds - 0.0).abs() < 1e-9);
    }

    #[test]
    fn cache_is_bounded() {
        let mut cache = FrameCache::new(2);
        for index in 0..5 {
            cache.insert("a", index as f64, DecodedFrame {
                width: 1,
                height: 1,
                rgba: vec![index as u8; 4],
                pts_seconds: index as f64,
            });
        }
        assert_eq!(cache.len(), 2);
        // 最新的一项一定在。
        assert!(cache.get("a", 4.0).is_some());
    }

    #[test]
    fn budget_rejects_oversized_media() {
        let budget = DecodeBudget::default();
        assert!(budget.check_size(1280, 720).is_ok());
        assert_eq!(budget.check_size(0, 720).expect_err("zero").code, "recording-media-invalid-size");
        let error = budget.check_size(5000, 100).expect_err("edge");
        assert_eq!(error.code, "recording-media-too-large");
        assert_eq!(error.stage, DecodeStage::Budget);
        // 像素预算单独生效：把上限压低后，边长合规但像素超限也要拒绝。
        let tight = DecodeBudget { max_frame_pixels: 1_000_000, ..DecodeBudget::default() };
        let error = tight.check_size(2000, 2000).expect_err("pixels");
        assert_eq!(error.code, "recording-media-too-large");
        assert_eq!(error.stage, DecodeStage::Budget);
    }

    #[test]
    fn unsupported_formats_fail_explicitly() {
        assert!(validate_source_type("image/png").is_ok());
        assert!(validate_source_type("video/mp4").is_ok());
        assert_eq!(
            validate_source_type("video/webm").expect_err("webm").code,
            "recording-media-unsupported"
        );
        assert_eq!(
            validate_source_type("application/octet-stream").expect_err("other").code,
            "recording-media-unsupported"
        );
    }

    #[test]
    fn paths_outside_the_task_directory_are_rejected() {
        let root = std::path::Path::new("/tmp/work/attempt-1");
        assert!(ensure_inside(root, &root.join("resource-0.bin")).is_ok());
        assert_eq!(
            ensure_inside(root, std::path::Path::new("/etc/passwd")).expect_err("outside").code,
            "recording-media-path-rejected"
        );
        assert!(ensure_inside(root, std::path::Path::new("/tmp/work/attempt-10/x")).is_err());
    }

    #[test]
    fn media_duration_is_filled_from_the_decoder() {
        let mut decoder = FakeDecoder { frames_requested: Vec::new() };
        let filled = with_media_duration(&mut decoder, &source("a", "video/mp4"), PlaybackMap::default()).expect("duration");
        assert_eq!(filled.media_duration, 3.5);
        // 只补时长，不改其它字段。
        assert_eq!(filled.start_time, 0.0);
        assert_eq!(filled.time_scale, 1.0);
    }
}
