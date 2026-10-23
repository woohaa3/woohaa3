//! 时间轴与视频图层的有界核验（U77，change: 2026-10-22-add-photocraft-animation-workflows）。
//!
//! 只做**收紧**：核验器不新增可接受的形状，只把本域无法交付的内容拒掉，避免打开一份
//! 编辑器再也导不出的工程。
//!
//! 检查项（逐层，深度/层数/画布/解压总量仍由共享核验负责）：
//! - 视频帧栈非空，帧数不超过本域帧预算（上游允许任意长，浏览器侧交付不了）；
//! - 帧率有限且为正、不超过本域上限（0/NaN/∞ 会让交付无限循环或除零）；
//! - 帧栈（含原始素材栈）的累计像素不超过本域预算，否则一次交付必然超预算；
//! - 帧栈未被截断成与原素材不一致的长度（`original_frames` 与 `frames` 同长）。
//!
//! ## 接线
//!
//! 共享分派器 `features/mod.rs::inspect_content` 是**首个命中生效**，而 `painting::inspect` 会认领
//! 所有 `LayerContent::Raster`，视频层本身也是 Raster 内容。因此本域 `inspect` 排在 `painting`
//! **之前**：带 `layer.video` 的图层先由本域核验并把种类记为 `video-layer`，普通栅格层仍落到
//! `painting`（本域对它们返回 `None`）。
//!
//! 文档级的时间轴时长/帧率/播放头/工作区在 `timeline` 上，逐层 `inspect` 看不到，因此由
//! `lib.rs::verify_container_with` 调用一次 [`inspect_document`]。

use super::*;

/// 帧数上限（与编辑器 `features::animation::limits::MAX_FRAMES` 一致，取更严格者）。
const MAX_FRAMES: usize = 120;
/// 帧栈累计像素上限（与编辑器 `MAX_CUMULATIVE_FRAME_PIXELS` 一致）。
const MAX_CUMULATIVE_FRAME_PIXELS: u64 = 16_777_216;
/// 帧率上限（与编辑器 `MAX_FPS` 一致）。
const MAX_FPS: f32 = 1000.0;

pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    let video = layer.video.as_ref()?;
    out.kinds.insert("video-layer".into());
    Some(validate_video(video))
}

/// 文档级检查：时间轴预算 + 整棵图层树的视频帧预算。
///
/// 逐层 `inspect` 看不到时间轴（时长在 `document.timeline` 上），因此这里提供**一个**文档级入口：
/// 共享 `lib.rs::verify_container_with` 里的 `features::animation::inspect_document(&document)?;`
/// 是唯一调用方，不需要再改本域规则。
///
/// 只收紧、不放宽：编辑器自身写出的时间轴一定通过 `Timeline::clamp`，这里的拒绝目标是被手工
/// 改过或来自其它工具、浏览器交付不了的内容。
pub fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    if let Some(timeline) = &document.timeline {
        if !(1..=MAX_FRAMES).contains(&timeline.duration) {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("时间轴时长超过上限：{} 帧（上限 {MAX_FRAMES}）", timeline.duration),
            ));
        }
        if !timeline.fps.is_finite() || timeline.fps <= 0.0 || timeline.fps > MAX_FPS {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("时间轴帧率非法：{}", timeline.fps),
            ));
        }
        if timeline.current >= timeline.duration {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("时间轴播放头越界：{} >= {}", timeline.current, timeline.duration),
            ));
        }
        if timeline.work_start >= timeline.work_end || timeline.work_end > timeline.duration {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!(
                    "时间轴工作区范围非法：{}..{}（时长 {}）",
                    timeline.work_start, timeline.work_end, timeline.duration
                ),
            ));
        }
    }
    inspect_layers(&document.layers)
}

fn inspect_layers(layers: &[photocraft_doc::Layer]) -> Result<(), VerifyError> {
    for layer in layers {
        if let Some(video) = &layer.video {
            validate_video(video)?;
        }
        if let photocraft_doc::LayerContent::Group(group) = &layer.content {
            inspect_layers(&group.children)?;
        }
    }
    Ok(())
}

fn validate_video(video: &photocraft_doc::VideoData) -> Result<(), VerifyError> {
    if video.frames.is_empty() {
        return Err(err(VerifyErrorCode::UnsupportedObject, "视频图层的帧栈为空"));
    }
    if video.frames.len() > MAX_FRAMES {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("视频图层帧数超过上限：{} > {MAX_FRAMES}", video.frames.len()),
        ));
    }
    if !video.fps.is_finite() || video.fps <= 0.0 || video.fps > MAX_FPS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("视频图层帧率非法：{}", video.fps),
        ));
    }
    if let Some(original) = &video.original_frames {
        if original.len() != video.frames.len() {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("视频图层原始帧数与帧栈不一致：{} != {}", original.len(), video.frames.len()),
            ));
        }
        if original.is_empty() {
            return Err(err(VerifyErrorCode::UnsupportedObject, "视频图层原始帧栈为空"));
        }
    }
    // 累计像素：按每帧**已分配**的 tile 包围盒计（Surface 是稀疏存储，布置范围即实际占用的
    // 画布区域）。这样核验只会漏放稀疏帧，不会误拒编辑器能打开的工程。
    let mut pixels: u64 = 0;
    for surface in video.frames.iter().chain(video.original_frames.iter().flatten()) {
        let bounds = surface.tile_bounds();
        let frame_pixels = u64::from(bounds.width()) * u64::from(bounds.height());
        pixels = pixels.saturating_add(frame_pixels);
        if pixels > MAX_CUMULATIVE_FRAME_PIXELS {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("视频帧累计像素超过上限：{pixels} > {MAX_CUMULATIVE_FRAME_PIXELS}"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(width: u32, height: u32) -> photocraft_doc::Surface {
        let mut surface = photocraft_doc::Surface::new(photocraft_doc::PixelFormat::RGBA8);
        surface.fill_rect(
            photocraft_doc::Rect::new(0, 0, width as i32, height as i32),
            &[0.5, 0.25, 0.125, 1.0],
        );
        surface
    }

    fn video(frames: usize, fps: f32, side: u32) -> photocraft_doc::VideoData {
        photocraft_doc::VideoData::new((0..frames).map(|_| surface(side, side)).collect(), fps)
    }

    #[test]
    fn normal_video_layer_passes() {
        let clip = video(3, 24.0, 16);
        assert!(validate_video(&clip).is_ok());
    }

    #[test]
    fn empty_and_oversized_frame_stacks_are_rejected() {
        assert!(validate_video(&video(0, 24.0, 8)).is_err());
        // 121 帧超过预算。
        assert!(validate_video(&video(121, 24.0, 8)).is_err());
        // 累计像素：4096² × 2 = 33,554,432 > 16,777,216。
        assert!(validate_video(&video(2, 24.0, 4096)).is_err());
    }

    #[test]
    fn bad_frame_rates_are_rejected() {
        for fps in [0.0, -1.0, f32::INFINITY, f32::NAN, 2000.0] {
            assert!(validate_video(&video(1, fps, 8)).is_err(), "{fps} 应被拒绝");
        }
    }

    #[test]
    fn original_frames_must_match_the_stack() {
        let mut clip = video(2, 24.0, 8);
        clip.original_frames = Some((0..3).map(|_| surface(8, 8)).collect());
        assert!(validate_video(&clip).is_err());
        clip.original_frames = Some((0..2).map(|_| surface(8, 8)).collect());
        assert!(validate_video(&clip).is_ok());
    }

    /// 端到端：带视频层与时间轴的工程字节经共享 `verify` 通过并可完整重开。
    #[test]
    fn a_saved_video_project_round_trips_and_an_oversized_one_is_refused() {
        use photocraft_doc::{ColorMode, Document, SampleType, Size, Timeline};
        let mut document = Document::new("时序", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        let format = document.pixel_format();
        document.layers.push(photocraft_doc::Layer::raster("背景", format));
        let mut layer = photocraft_doc::Layer::raster("帧", format);
        layer.video = Some(video(3, 12.0, 8));
        document.layers.push(layer);
        document.timeline = Some(Timeline::new(3, 12.0));
        let bytes = photocraft_format::save_to_bytes(&document, &photocraft_format::SaveOptions::default())
            .expect("保存带视频层的工程");
        let summary = crate::verify(&bytes).expect("带视频层的工程应通过核验");
        assert!(summary.layer_count >= 2);
        // 分派器把视频层交给本域，而不是当作普通栅格。
        assert!(
            summary.object_kinds.iter().any(|kind| kind == "video-layer"),
            "{:?}",
            summary.object_kinds
        );
        // 存回去的解析结果仍带时间轴与帧栈（上游 manifest 保存两者）。
        let loaded = photocraft_format::load_from_bytes(&bytes).expect("重新解析");
        assert_eq!(loaded.timeline.as_ref().map(|timeline| timeline.duration), Some(3));
        assert_eq!(loaded.layers.last().and_then(|l| l.video.as_ref()).map(|video| video.frames.len()), Some(3));

        // 超预算帧栈：共享核验必须拒绝（不是放行后交给界面）。
        let mut big = document.clone();
        if let Some(video) = big.layers.last_mut().and_then(|layer| layer.video.as_mut()) {
            *video = video_clip(121);
        }
        assert!(validate_video(big.layers.last().and_then(|layer| layer.video.as_ref()).expect("视频层")).is_err());
        let bytes = photocraft_format::save_to_bytes(&big, &photocraft_format::SaveOptions::default())
            .expect("保存超预算工程");
        let failure = crate::verify(&bytes).expect_err("超预算帧栈必须被核验器拒绝");
        assert_eq!(failure.code, VerifyErrorCode::UnsupportedObject);
        assert!(failure.message.contains("121"), "{}", failure.message);

        // 超预算时间轴同样由文档级规则拒绝。
        let mut long = document.clone();
        long.timeline = Some(Timeline::new(121, 24.0));
        let bytes = photocraft_format::save_to_bytes(&long, &photocraft_format::SaveOptions::default())
            .expect("保存超长时间轴工程");
        let failure = crate::verify(&bytes).expect_err("超长时间轴必须被核验器拒绝");
        assert_eq!(failure.code, VerifyErrorCode::UnsupportedObject);
    }

    fn video_clip(frames: usize) -> photocraft_doc::VideoData {
        let mut clip = video(1, 30.0, 2);
        clip.frames = (0..frames).map(|_| surface(2, 2)).collect();
        clip
    }

    /// 文档级规则：时间轴预算与整棵图层树，且**只在**共享 `verify_container` 接线后才影响载入。
    #[test]
    fn document_level_timeline_and_frame_budgets_are_enforced() {
        use photocraft_doc::{ColorMode, Document, SampleType, Size, Timeline};
        let mut document = Document::new("时序", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        let format = document.pixel_format();
        document.layers.push(photocraft_doc::Layer::raster("背景", format));
        document.timeline = Some(Timeline::new(4, 24.0));
        assert!(inspect_document(&document).is_ok(), "编辑器写出的时间轴必须通过");

        // 时长超预算：浏览器交付不了这么长的时间轴。
        let mut too_long = document.clone();
        too_long.timeline = Some(Timeline { duration: 121, ..Timeline::new(121, 24.0) });
        let failure = inspect_document(&too_long).unwrap_err();
        assert_eq!(failure.code, VerifyErrorCode::UnsupportedObject);
        assert!(failure.message.contains("121"), "{}", failure.message);

        // 帧率非法（0/NaN/超上限）。
        for fps in [0.0, f32::NAN, 2000.0] {
            let mut bad = document.clone();
            bad.timeline = Some(Timeline { fps, ..Timeline::new(4, 24.0) });
            assert!(inspect_document(&bad).is_err(), "{fps} 应被拒绝");
        }

        // 工作区范围非法（逆序或越界）。
        let mut bad_range = document.clone();
        bad_range.timeline = Some(Timeline { work_start: 3, work_end: 1, ..Timeline::new(4, 24.0) });
        assert!(inspect_document(&bad_range).is_err());
        let mut beyond = document.clone();
        beyond.timeline = Some(Timeline { work_end: 9, ..Timeline::new(4, 24.0) });
        assert!(inspect_document(&beyond).is_err());

        // 嵌套图层里的视频帧同样受限。
        let mut nested = document.clone();
        let mut child = photocraft_doc::Layer::raster("深层帧", format);
        child.video = Some(video_clip(121));
        nested.layers.push(photocraft_doc::Layer::group("组", vec![child]));
        let failure = inspect_document(&nested).unwrap_err();
        assert!(failure.message.contains("121"), "{}", failure.message);

        // 旧工程（无时间轴、无视频层）不产生任何贡献。
        let mut plain = Document::new("旧", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        plain.layers.push(photocraft_doc::Layer::raster("图层", format));
        assert!(inspect_document(&plain).is_ok());
    }
}
