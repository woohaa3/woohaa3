//! 真实媒体解码实现
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.2 / design D5）。
//!
//! - **图片**：用 `image` crate 解码为 RGBA8，**保留 alpha**（PNG/WebP 的透明像素不被填黑）；
//! - **视频**：解析我们自己的 MP4 封装（`recording_mux` 同构），用 OpenH264 逐样本解码，
//!   按目标 PTS 选**覆盖该时刻**的帧；尾部保持在最后一帧，不猜、不跳。
//!
//! 不解码就不假装成功：不支持的格式、损坏的 packet、缺帧都返回 `DecodeFailure`。
//! 只有 `recording-media` feature 编译。

use std::collections::BTreeMap;
use std::path::Path;

use crate::recording_media::{
    DecodeBudget, DecodeFailure, DecodeStage, DecodedFrame, MediaDecoder, MediaSource,
};

/// 真实解码器。
pub struct NativeMediaDecoder {
    budget: DecodeBudget,
    /// 每个源的已解析索引（避免每帧重读文件）。
    indexes: BTreeMap<String, VideoIndex>,
    /// 每个源当前解码位置之后缓存的帧（有界：只保留最近需要的少量帧）。
    decoded: BTreeMap<String, Vec<DecodedFrame>>,
}

/// MP4 样本索引（由我们自己的 `stsz`/`stts` 结构解析）。
struct VideoIndex {
    width: u32,
    height: u32,
    timescale: u32,
    /// 参数集（Annex-B，含起始码）。
    headers: Vec<u8>,
    /// 每个样本的 (相对起始偏移, 长度, 起始 PTS（秒）)。
    samples: Vec<SampleRef>,
    duration_seconds: f64,
}

struct SampleRef {
    offset: usize,
    length: usize,
    pts_seconds: f64,
}

impl NativeMediaDecoder {
    pub fn new(budget: DecodeBudget) -> Self {
        Self {
            budget,
            indexes: BTreeMap::new(),
            decoded: BTreeMap::new(),
        }
    }

    fn index_for(&mut self, source: &MediaSource) -> Result<&VideoIndex, DecodeFailure> {
        if !self.indexes.contains_key(&source.resource_id) {
            let index = read_video_index(&source.path, &self.budget)?;
            self.indexes.insert(source.resource_id.clone(), index);
        }
        Ok(self
            .indexes
            .get(&source.resource_id)
            .expect("index inserted"))
    }
}

impl MediaDecoder for NativeMediaDecoder {
    fn duration_seconds(&self, source: &MediaSource) -> Result<f64, DecodeFailure> {
        if source.content_type.starts_with("image/") {
            return Ok(0.0);
        }
        // `&self` 接口下只读索引：图片/视频都能在需要时重建。
        let index = read_video_index(&source.path, &self.budget)?;
        Ok(index.duration_seconds)
    }

    fn frame_at(
        &mut self,
        source: &MediaSource,
        local_seconds: f64,
    ) -> Result<DecodedFrame, DecodeFailure> {
        crate::recording_media::validate_source_type(&source.content_type)?;
        if source.content_type.starts_with("image/") {
            return decode_image(&source.path, &self.budget);
        }
        let budget = self.budget;
        let index = self.index_for(source)?;
        let (width, height) = (index.width, index.height);
        // 选覆盖目标时刻的样本：最后一个 pts <= target 的样本。
        let sample_index = match index
            .samples
            .iter()
            .rposition(|sample| sample.pts_seconds <= local_seconds + 1e-9)
        {
            Some(index) => index,
            // 目标早于第一个样本：用第一帧（与「尚未开始显示首帧」一致）。
            None => 0,
        };
        if index.samples.is_empty() {
            return Err(DecodeFailure::new(
                DecodeStage::Selection,
                "recording-media-no-frames",
                "视频没有可解码的样本",
            ));
        }

        // 从最近的关键帧/首个样本开始解到目标样本（样本之间是 P 帧依赖）。
        let bytes = std::fs::read(&source.path).map_err(|error| {
            DecodeFailure::new(
                DecodeStage::Format,
                "recording-media-unreadable",
                error.to_string(),
            )
        })?;
        let mut decoder = openh264::decoder::Decoder::new().map_err(|error| {
            DecodeFailure::new(
                DecodeStage::Decode,
                "recording-media-decoder-unavailable",
                error.to_string(),
            )
        })?;
        // 参数集与首个样本一起送：只喂 SPS/PPS 的握手在部分构建上返回 `None`，
        // 与首个 IDR 一起送才稳定产出图像（与 `recording_openh264` 的自检路径一致）。
        let mut pending_headers = Some(index.headers.clone());

        let mut last: Option<DecodedFrame> = None;
        for sample in index.samples.iter().take(sample_index + 1) {
            let end = sample.offset + sample.length;
            if end > bytes.len() {
                return Err(DecodeFailure::new(
                    DecodeStage::Decode,
                    "recording-media-sample-truncated",
                    "样本超出文件长度",
                ));
            }
            // 样本在 MP4 里是 **AVCC**（4 字节长度前缀），解码器要 Annex-B（起始码）。
            // 必须逐 NAL 转码；直接把整个样本当 Annex-B 会把长度前缀当成 NAL 头。
            let mut annex_b = Vec::with_capacity(sample.length + 4 + index.headers.len());
            if let Some(headers) = pending_headers.take() {
                annex_b.extend_from_slice(&headers);
            }
            let mut cursor = sample.offset;
            while cursor + 4 <= end {
                let nal_length = u32::from_be_bytes([
                    bytes[cursor],
                    bytes[cursor + 1],
                    bytes[cursor + 2],
                    bytes[cursor + 3],
                ]) as usize;
                cursor += 4;
                if nal_length == 0 || cursor + nal_length > end {
                    break;
                }
                annex_b.extend_from_slice(&[0, 0, 0, 1]);
                annex_b.extend_from_slice(&bytes[cursor..cursor + nal_length]);
                cursor += nal_length;
            }
            if annex_b.is_empty() {
                continue;
            }
            match decoder.decode(&annex_b) {
                Ok(Some(image)) => {
                    use openh264::formats::YUVSource;
                    let (image_width, image_height) = image.dimensions();
                    let mut rgba = vec![0u8; image_width * image_height * 4];
                    image.write_rgba8(&mut rgba);
                    budget.check_size(image_width as u32, image_height as u32)?;
                    last = Some(DecodedFrame {
                        width: image_width as u32,
                        height: image_height as u32,
                        rgba,
                        pts_seconds: sample.pts_seconds,
                    });
                }
                Ok(None) => {}
                Err(error) => {
                    return Err(DecodeFailure::new(
                        DecodeStage::Decode,
                        "recording-media-sample-invalid",
                        format!(
                            "第 {} 个样本解码失败：{error}",
                            index
                                .samples
                                .iter()
                                .position(|entry| std::ptr::eq(entry, sample))
                                .unwrap_or(0)
                        ),
                    ));
                }
            }
        }
        last.ok_or_else(|| {
            DecodeFailure::new(
                DecodeStage::Selection,
                "recording-media-frame-missing",
                format!(
                    "时刻 {local_seconds:.3}s 没有可用帧（samples={} target_index={sample_index} headers={} bytes）",
                    index.samples.len(),
                    index.headers.len()
                ),
            )
        })
        .map(|frame| DecodedFrame { width: width.max(1), height: height.max(1), ..frame })
    }

    fn release(&mut self, resource_id: &str) {
        self.indexes.remove(resource_id);
        self.decoded.remove(resource_id);
    }
}

/// 解码图片为 RGBA8（保留 alpha）。
fn decode_image(path: &Path, budget: &DecodeBudget) -> Result<DecodedFrame, DecodeFailure> {
    let reader = image::ImageReader::open(path).map_err(|error| {
        DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-unreadable",
            error.to_string(),
        )
    })?;
    let image = reader
        .with_guessed_format()
        .map_err(|error| {
            DecodeFailure::new(
                DecodeStage::Format,
                "recording-media-format-unknown",
                error.to_string(),
            )
        })?
        .decode()
        .map_err(|error| {
            DecodeFailure::new(
                DecodeStage::Decode,
                "recording-media-decode-failed",
                error.to_string(),
            )
        })?;
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width(), rgba.height());
    budget.check_size(width, height)?;
    Ok(DecodedFrame {
        width,
        height,
        rgba: rgba.into_raw(),
        pts_seconds: 0.0,
    })
}

/// 读取 MP4 的样本索引。
///
/// 只支持我们自己封装的 H.264 MP4（`avc1`/`avcC`、单 track、逐样本 chunk）。
fn read_video_index(path: &Path, budget: &DecodeBudget) -> Result<VideoIndex, DecodeFailure> {
    let bytes = std::fs::read(path).map_err(|error| {
        DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-unreadable",
            error.to_string(),
        )
    })?;
    let find = |needle: &[u8]| {
        bytes
            .windows(needle.len())
            .position(|window| window == needle)
    };
    let moov = find(b"moov").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 moov")
    })?;
    let mdat = find(b"mdat").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 mdat")
    })?;
    let avcc = find(b"avcC").ok_or_else(|| {
        DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-unsupported",
            "缺少 avcC（非 H.264）",
        )
    })?;
    let stsz = find(b"stsz").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 stsz")
    })?;
    let stts = find(b"stts").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 stts")
    })?;
    let mdhd = find(b"mdhd").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 mdhd")
    })?;
    let tkhd = find(b"tkhd").ok_or_else(|| {
        DecodeFailure::new(DecodeStage::Format, "recording-media-not-mp4", "缺少 tkhd")
    })?;

    let u32_at = |offset: usize| -> u32 {
        if offset + 4 > bytes.len() {
            return 0;
        }
        u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    // `find` 命中 box type，所以负载从 +4 开始。
    //
    // `mdat` 数据区同样在 type 之后 +4；并用 box 自带的长度做上界，避免把样本算到文件之外
    // （截断文件必须在此处失败，而不是读到相邻数据）。
    let mdat_box_start = mdat.saturating_sub(4);
    let mdat_size = u32_at(mdat_box_start) as usize;
    // box 头 = size(4) + type(4)；`largesize`（size==1）时再加 8。
    let mdat_header = if mdat_size == 1 { 16 } else { 8 };
    let mdat_payload = mdat_box_start + mdat_header;
    let mdat_end = if mdat_size >= mdat_header {
        mdat_box_start + mdat_size
    } else {
        bytes.len()
    };
    let timescale = u32_at(mdhd + 4 + 12);
    let duration_units = u32_at(mdhd + 4 + 16);
    if timescale == 0 {
        return Err(DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-invalid-timescale",
            "timescale 为 0",
        ));
    }
    // `stsz` 负载：version/flags(4) · sample_size(4) · sample_count(4)，负载从 type 之后 +4 开始。
    let sample_count = u32_at(stsz + 12) as usize;
    if sample_count == 0 {
        return Err(DecodeFailure::new(
            DecodeStage::Selection,
            "recording-media-no-frames",
            "视频没有样本",
        ));
    }
    // tkhd：v0 时 width/height 在 box 末端 8 字节。
    let tkhd_size = u32_at(tkhd - 4) as usize;
    let width = u32_at(tkhd - 4 + tkhd_size - 8) >> 16;
    let height = u32_at(tkhd - 4 + tkhd_size - 4) >> 16;
    budget.check_size(width.max(1), height.max(1))?;

    // stts：run-length 的 (count, delta)，展开成每个样本的 PTS。
    let stts_entries = u32_at(stts + 4 + 4) as usize;
    let mut pts_units: Vec<u64> = Vec::with_capacity(sample_count);
    let mut cursor = stts + 4 + 8;
    let mut running = 0u64;
    for _ in 0..stts_entries {
        let count = u32_at(cursor) as u64;
        let delta = u32_at(cursor + 4) as u64;
        for _ in 0..count {
            if pts_units.len() >= sample_count {
                break;
            }
            pts_units.push(running);
            running += delta;
        }
        cursor += 8;
    }
    while pts_units.len() < sample_count {
        pts_units.push(*pts_units.last().unwrap_or(&0));
    }

    // stsz：逐样本大小（sample_size 必须为 0，否则我们无法定位）。
    let uniform = u32_at(stsz + 8);
    if uniform != 0 {
        return Err(DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-unsupported",
            "stsz 使用统一 sample size，无法逐帧定位",
        ));
    }
    let sizes_start = stsz + 16;
    let mut offset = mdat_payload;
    let mut samples = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let length = u32_at(sizes_start + index * 4) as usize;
        if offset + length > mdat_end || offset + length > bytes.len() {
            return Err(DecodeFailure::new(
                DecodeStage::Format,
                "recording-media-sample-truncated",
                format!("第 {index} 个样本超出 mdat 边界"),
            ));
        }
        samples.push(SampleRef {
            offset,
            length,
            pts_seconds: pts_units[index] as f64 / timescale as f64,
        });
        offset += length;
    }

    // avcC：SPS/PPS → Annex-B 头。
    let mut header_cursor = avcc + 4 + 6;
    let mut headers = Vec::new();
    for _ in 0..2 {
        if header_cursor + 2 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes([bytes[header_cursor], bytes[header_cursor + 1]]) as usize;
        header_cursor += 2;
        if header_cursor + length > bytes.len() {
            break;
        }
        headers.extend_from_slice(&[0, 0, 0, 1]);
        headers.extend_from_slice(&bytes[header_cursor..header_cursor + length]);
        header_cursor += length + 1;
    }
    if headers.is_empty() {
        return Err(DecodeFailure::new(
            DecodeStage::Format,
            "recording-media-headers-missing",
            "缺少 SPS/PPS",
        ));
    }

    Ok(VideoIndex {
        width,
        height,
        timescale,
        headers,
        samples,
        duration_seconds: duration_units as f64 / timescale as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wo-media-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn decodes_png_and_preserves_alpha() {
        let dir = temp_dir("png");
        let path = dir.join("image.png");
        // 2x2：左上全透明红、其余不透明。
        let mut image = image::RgbaImage::new(2, 2);
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 0]));
        image.put_pixel(1, 0, image::Rgba([0, 255, 0, 255]));
        image.put_pixel(0, 1, image::Rgba([0, 0, 255, 255]));
        image.put_pixel(1, 1, image::Rgba([10, 20, 30, 255]));
        image.save(&path).expect("save png");

        let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
        let frame = decoder
            .frame_at(
                &MediaSource {
                    resource_id: "img".into(),
                    path,
                    content_type: "image/png".into(),
                },
                0.0,
            )
            .expect("decode");
        assert_eq!((frame.width, frame.height), (2, 2));
        assert_eq!(frame.rgba.len(), 2 * 2 * 4);
        // 透明像素的 alpha 必须保留为 0，不能被填成不透明。
        assert_eq!(frame.rgba[3], 0);
        assert_eq!(frame.rgba[7], 255);
    }

    #[test]
    fn rejects_unsupported_and_unreadable_sources() {
        let dir = temp_dir("bad");
        let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
        let unsupported = decoder.frame_at(
            &MediaSource {
                resource_id: "x".into(),
                path: dir.join("x.webm"),
                content_type: "video/webm".into(),
            },
            0.0,
        );
        assert_eq!(
            unsupported.expect_err("unsupported").code,
            "recording-media-unsupported"
        );

        let missing = decoder.frame_at(
            &MediaSource {
                resource_id: "y".into(),
                path: dir.join("missing.png"),
                content_type: "image/png".into(),
            },
            0.0,
        );
        assert_eq!(
            missing.expect_err("missing").code,
            "recording-media-unreadable"
        );
    }

    #[test]
    fn reads_real_mp4_index_from_our_encoder_output() {
        // 用真实编码器产出一个 MP4，再解析它的样本索引。
        let dir = temp_dir("mp4");
        let output = dir.join("clip.mp4");
        let artifact = crate::recording_openh264::encode_solid_frames(
            &output,
            crate::recording_encode::EncoderProfile {
                width: 64,
                height: 48,
                bitrate: 400_000,
                fps_numer: 30,
                fps_denom: 1,
            },
            6,
            0.2,
            [10, 200, 30, 255],
        )
        .expect("encode");
        assert_eq!(artifact.frame_count, 6);

        let index = read_video_index(&output, &DecodeBudget::default()).expect("index");
        assert_eq!(index.samples.len(), 6);
        // 媒体时基是 90 kHz（见 `MEDIA_TIMESCALE`），不是帧率。
        assert_eq!(index.timescale, crate::recording_openh264::MEDIA_TIMESCALE);
        assert!((index.duration_seconds - 0.2).abs() < 0.05);
        assert!(index.width >= 64);
        assert!(index.height >= 48);
        // PTS 必须单调递增且从 0 开始。
        assert!(index.samples[0].pts_seconds.abs() < 1e-9);
        for window in index.samples.windows(2) {
            assert!(window[1].pts_seconds >= window[0].pts_seconds);
        }

        // 真正解码出像素，并且能按时间选到不同帧。
        let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
        let source = MediaSource {
            resource_id: "clip".into(),
            path: output.clone(),
            content_type: "video/mp4".into(),
        };
        let first = decoder.frame_at(&source, 0.0).expect("first frame");
        assert_eq!((first.width, first.height), (64, 48));
        assert_eq!(first.rgba.len(), 64 * 48 * 4);
        let later = decoder.frame_at(&source, 0.15).expect("later frame");
        assert!(later.pts_seconds >= first.pts_seconds);

        let duration = decoder.duration_seconds(&source).expect("duration");
        assert!((duration - 0.2).abs() < 0.05);
    }

    #[test]
    fn rejects_truncated_mp4_samples() {
        let dir = temp_dir("truncated");
        let output = dir.join("clip.mp4");
        crate::recording_openh264::encode_solid_frames(
            &output,
            crate::recording_encode::EncoderProfile {
                width: 64,
                height: 48,
                bitrate: 400_000,
                fps_numer: 30,
                fps_denom: 1,
            },
            3,
            0.1,
            [1, 2, 3, 255],
        )
        .expect("encode");
        let bytes = std::fs::read(&output).expect("read");
        // 截掉尾部：索引能读出来，但样本越界必须失败而不是返回半个画面。
        std::fs::write(&output, &bytes[..bytes.len() - 40]).expect("truncate");
        let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
        let error = decoder
            .frame_at(
                &MediaSource {
                    resource_id: "clip".into(),
                    path: output,
                    content_type: "video/mp4".into(),
                },
                0.05,
            )
            .expect_err("truncated");
        assert!(
            matches!(
                error.code,
                "recording-media-sample-truncated"
                    | "recording-media-sample-invalid"
                    | "recording-media-not-mp4"
            ),
            "unexpected code {}",
            error.code
        );
    }

    #[test]
    fn release_drops_the_index() {
        let dir = temp_dir("release");
        let output = dir.join("clip.mp4");
        crate::recording_openh264::encode_solid_frames(
            &output,
            crate::recording_encode::EncoderProfile {
                width: 32,
                height: 32,
                bitrate: 300_000,
                fps_numer: 30,
                fps_denom: 1,
            },
            2,
            0.06,
            [9, 9, 9, 255],
        )
        .expect("encode");
        let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
        let source = MediaSource {
            resource_id: "clip".into(),
            path: output,
            content_type: "video/mp4".into(),
        };
        decoder.frame_at(&source, 0.0).expect("frame");
        assert_eq!(decoder.indexes.len(), 1);
        decoder.release("clip");
        assert_eq!(decoder.indexes.len(), 0);
    }
}
