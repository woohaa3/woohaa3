//! OpenH264 软件编码后端与成片收尾
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.3 / design D5）。
//!
//! 这里把「RGBA 帧 → YUV420 → OpenH264 → 样本 spool → MP4」串起来。只有 `recording-codec`
//! feature 才编译（OpenH264 需要 C++ 工具链），但不需要 GPU，可在无 GPU 机器上跑真实编码回归。
//!
//! 集成约定：
//! - 编码器消费调用方给的 PTS/时长，不自己计时；
//! - 队列容量固定（[`crate::recording_encode::FRAME_QUEUE_CAPACITY`]），生产端按 `push` 的
//!   阻塞语义回压；
//! - 成片只写私有临时目录，取消即删除。

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use openh264::encoder::{Encoder, EncoderConfig, FrameType};
use crate::recording_encode::{
    ArtifactFile, EncodedArtifact, EncodeFailure, EncodeStage, EncoderFrame, EncoderProfile,
    MAX_ARTIFACT_BYTES, VideoEncoder, rgba_to_yuv420, sha256_hex, verify_mp4,
};
use crate::recording_mux::{EncodedSample, MuxOptions, append_sample, write_mp4};

/// 媒体时基（90 kHz，MPEG 标准）。见 `timescale` 的说明。
pub const MEDIA_TIMESCALE: u32 = 90_000;

/// 关键帧间隔（秒）；2 秒与既有 WebCodecs 路径的关键帧策略一致。
const KEYFRAME_INTERVAL_SECONDS: f64 = 2.0;

/// OpenH264 软件编码器配置。
#[derive(Clone, Debug)]
pub struct OpenH264EncoderOptions {
    /// 输出 MP4 路径（私有临时目录内）。
    pub output: PathBuf,
    /// 样本 spool 路径（与输出同目录的临时文件）。
    pub spool: PathBuf,
    pub profile: EncoderProfile,
    /// 强制关键帧间隔（帧数）；默认按 2 秒换算。
    pub keyframe_interval_frames: Option<u32>,
}

/// OpenH264 编码器 + 最小 MP4 封装。
pub struct OpenH264Encoder {
    encoder: Encoder,
    options: OpenH264EncoderOptions,
    spool: BufWriter<File>,
    samples: Vec<EncodedSample>,
    sps: Vec<u8>,
    pps: Vec<u8>,
    pushed_frames: u64,
    bytes_written: u64,
    /// 已编码的累计时长（秒），用于把 PTS 换算成 timescale 单位。
    elapsed_seconds: f64,
    timescale: u32,
    cancelled: bool,
    artifact: Option<ArtifactFile>,
}

impl OpenH264Encoder {
    /// 创建编码器；尺寸/帧率非法或 spool 无法创建时返回稳定失败。
    pub fn create(options: OpenH264EncoderOptions) -> Result<Self, EncodeFailure> {
        options.profile.validate()?;
        let bitrate = openh264::encoder::BitRate::from_bps(options.profile.bitrate.max(100_000));
        let frame_rate = openh264::encoder::FrameRate::from_hz(
            options.profile.fps_numer as f32 / options.profile.fps_denom as f32,
        );
        // 关闭 skip frame 保证「一帧输入 ⇒ 一帧输出」，不丢帧；bitrate 因此只作目标参考，
        // OpenH264 会打印一条相关警告（不是失败）。录制不允许跳帧，所以这里接受该警告。
        let config = EncoderConfig::new()
            .bitrate(bitrate)
            .max_frame_rate(frame_rate)
            .skip_frames(false)
            .intra_frame_period(openh264::encoder::IntraFramePeriod::from_num_frames(
                options
                    .keyframe_interval_frames
                    .unwrap_or_else(|| default_keyframe_interval(&options.profile)),
            ));
        let encoder = Encoder::with_api_config(openh264::OpenH264API::from_source(), config)
            .map_err(|error| {
                EncodeFailure::new(EncodeStage::Encode, "recording-encoder-unavailable", error.to_string())
            })?;

        if let Some(parent) = options.output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                EncodeFailure::new(EncodeStage::Mux, "recording-artifact-directory-failed", error.to_string())
            })?;
        }
        if let Some(parent) = options.spool.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                EncodeFailure::new(EncodeStage::Mux, "recording-artifact-directory-failed", error.to_string())
            })?;
        }
        let spool_file = File::create(&options.spool).map_err(|error| {
            EncodeFailure::new(EncodeStage::Mux, "recording-artifact-create-failed", error.to_string())
        })?;
        let artifact = ArtifactFile::create(
            options.output.parent().unwrap_or(Path::new(".")),
            options
                .output
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("recording"),
        )?;

        // 媒体时基取 90 kHz（MPEG 标准）：30fps 的整帧是 3000 单位，末帧的 1/60 秒是 1500 单位，
        // 因此非整数时长（如 2.05s）能精确表达。取 `fps_numer` 会把 1/60 秒round 成半帧，
        // 让成片比声明的 D 长出半个帧（已在端到端验收中实测到 2.0667s）。
        let timescale = MEDIA_TIMESCALE;
        Ok(Self {
            encoder,
            options,
            spool: BufWriter::new(spool_file),
            samples: Vec::new(),
            sps: Vec::new(),
            pps: Vec::new(),
            pushed_frames: 0,
            bytes_written: 0,
            elapsed_seconds: 0.0,
            timescale,
            cancelled: false,
            artifact: Some(artifact),
        })
    }

    /// 已编码帧数。
    pub fn frame_count(&self) -> u64 {
        self.pushed_frames
    }

    /// 已写入 spool 的字节数。
    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    fn collect_parameter_sets(&mut self, nal: &[u8]) {
        if nal.len() < 4 {
            return;
        }
        // Annex-B 起始码 0x00000001 或 0x000001 后是 NAL 头。
        let header_index = if nal.starts_with(&[0, 0, 0, 1]) {
            4
        } else if nal.starts_with(&[0, 0, 1]) {
            3
        } else {
            return;
        };
        let Some(&header) = nal.get(header_index) else { return };
        let nal_type = header & 0x1f;
        // avcC 里的 `sequenceParameterSetNALUnit` 是**完整 NAL 单元**（含 NAL 头），
        // 但不含起始码；这里保留头部字节，否则解码器读到的是残缺 bitstream。
        let unit = &nal[header_index..];
        match nal_type {
            // SPS
            7 if self.sps.is_empty() => self.sps = unit.to_vec(),
            // PPS
            8 if self.pps.is_empty() => self.pps = unit.to_vec(),
            _ => {}
        }
    }

    /// NAL 头是否为 SPS(7)/PPS(8)。
    fn is_parameter_set(nal_payload: &[u8]) -> bool {
        matches!(nal_payload.first().map(|header| header & 0x1f), Some(7) | Some(8))
    }

    /// 把 Annex-B NAL 拆成 AVCC 形式（去起始码），返回纯负载。
    fn strip_start_code(nal: &[u8]) -> Option<&[u8]> {
        if let Some(rest) = nal.strip_prefix(&[0, 0, 0, 1]) {
            Some(rest)
        } else {
            nal.strip_prefix(&[0, 0, 1])
        }
    }
}

fn default_keyframe_interval(profile: &EncoderProfile) -> u32 {
    let fps = profile.fps_numer as f64 / profile.fps_denom.max(1) as f64;
    (fps * KEYFRAME_INTERVAL_SECONDS).round().max(1.0) as u32
}

impl VideoEncoder for OpenH264Encoder {
    fn push(&mut self, frame: EncoderFrame) -> Result<(), EncodeFailure> {
        if self.cancelled {
            return Err(EncodeFailure::new(EncodeStage::Encode, "recording-cancelled", "编码已取消"));
        }
        let profile = &self.options.profile;
        if frame.width != profile.width || frame.height != profile.height {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-frame-size-mismatch",
                format!(
                    "帧尺寸 {}x{} 与 profile {}x{} 不一致",
                    frame.width, frame.height, profile.width, profile.height
                ),
            ));
        }
        let yuv = rgba_to_yuv420(&frame.rgba, frame.width, frame.height).ok_or_else(|| {
            EncodeFailure::new(
                EncodeStage::Encode,
                "recording-frame-invalid",
                "帧像素长度与尺寸不匹配（或尺寸非偶数）",
            )
        })?;
        // 直接以切片形式交给 OpenH264：三平面连续、stride 等于宽度。
        let dimensions = (frame.width as usize, frame.height as usize);
        let strides = (frame.width as usize, (frame.width / 2) as usize, (frame.width / 2) as usize);
        let slices = openh264::formats::YUVSlices::new((&yuv.y, &yuv.u, &yuv.v), dimensions, strides);

        let bitstream = self.encoder.encode(&slices).map_err(|error| {
            EncodeFailure::new(EncodeStage::Encode, "recording-encode-failed", error.to_string())
                .transient()
        })?;
        let frame_type = bitstream.frame_type();
        if matches!(frame_type, FrameType::Invalid | FrameType::Skip) {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-encode-skipped",
                format!("编码器返回 {frame_type:?}，未产出可交付样本"),
            ));
        }

        // 先把 NAL 复制出来，结束对编码器的借用，再更新 SPS/PPS 状态。
        //
        // OpenH264 把 SPS/PPS 放在**非 video** 的层里（`is_video()` 为 false）：参数集必须
        // 收集进 `avcC`，但**不能**作为样本负载重复写入 `mdat`。
        let mut parameter_sets: Vec<Vec<u8>> = Vec::new();
        let mut video_nals: Vec<Vec<u8>> = Vec::new();
        for layer_index in 0..bitstream.num_layers() {
            let Some(layer) = bitstream.layer(layer_index) else { continue };
            for nal_index in 0..layer.nal_count() {
                let Some(raw) = layer.nal_unit(nal_index) else { continue };
                if layer.is_video() {
                    video_nals.push(raw.to_vec());
                } else {
                    parameter_sets.push(raw.to_vec());
                }
            }
        }
        for raw in &parameter_sets {
            self.collect_parameter_sets(raw);
        }
        let mut nals: Vec<Vec<u8>> = Vec::with_capacity(video_nals.len());
        for raw in &video_nals {
            if let Some(payload) = Self::strip_start_code(raw) {
                // 视频层里偶尔也会内联 SPS/PPS（IDR 前置），同样收进参数集而不重复写入样本。
                if Self::is_parameter_set(payload) {
                    self.collect_parameter_sets(raw);
                    continue;
                }
                nals.push(payload.to_vec());
            }
        }
        if nals.is_empty() {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-encode-empty",
                "编码器未返回任何 NAL 单元",
            ));
        }

        let size = append_sample(&mut self.spool, &nals).map_err(|mut error| {
            error.stage = EncodeStage::Encode;
            error
        })?;
        self.bytes_written = self.bytes_written.saturating_add(size as u64);
        if self.bytes_written > MAX_ARTIFACT_BYTES {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-artifact-too-large",
                format!("成片超过 {MAX_ARTIFACT_BYTES} 字节上限"),
            ));
        }

        // PTS 由调用方给定，按 timescale 换算；用累计 elapsed 消除浮点漂移。
        // PTS/时长都按 90 kHz 换算；末帧的分数时长（如 1/60 秒 = 1500 单位）是精确值。
        let pts = (frame.pts_seconds.max(0.0) * f64::from(self.timescale)).round() as u64;
        let duration_units = (frame.duration_seconds.max(0.0) * f64::from(self.timescale)).round() as u64;
        self.samples.push(EncodedSample {
            pts,
            duration: duration_units.max(if self.pushed_frames == 0 { 1 } else { 0 }),
            keyframe: matches!(frame_type, FrameType::IDR | FrameType::I),
            size,
        });
        self.pushed_frames += 1;
        self.elapsed_seconds += frame.duration_seconds.max(0.0);
        Ok(())
    }

    fn finish(&mut self) -> Result<EncodedArtifact, EncodeFailure> {
        if self.cancelled {
            return Err(EncodeFailure::new(EncodeStage::Encode, "recording-cancelled", "编码已取消"));
        }
        if self.samples.is_empty() {
            return Err(EncodeFailure::new(EncodeStage::Mux, "recording-artifact-empty", "没有已编码的帧"));
        }
        if self.sps.is_empty() || self.pps.is_empty() {
            return Err(EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-missing-parameter-sets",
                "编码器未产出 SPS/PPS，无法写样本描述",
            ));
        }
        self.spool
            .flush()
            .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-write-failed", error.to_string()))?;

        let mux_options = MuxOptions {
            width: self.options.profile.width,
            height: self.options.profile.height,
            timescale: self.timescale,
            sps: self.sps.clone(),
            pps: self.pps.clone(),
        };
        let result = write_mp4(
            &self.options.output,
            &self.options.spool,
            &mux_options,
            &self.samples,
        )?;
        let facts = verify_mp4(&self.options.output, result.size_bytes)?;
        if facts.has_audio {
            return Err(EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-has-audio",
                "首期成片不应包含音轨",
            ));
        }
        let _ = std::fs::remove_file(&self.options.spool);
        let artifact = self
            .artifact
            .take()
            .ok_or_else(|| {
                EncodeFailure::new(EncodeStage::Mux, "recording-artifact-missing", "临时产物已释放")
            })?;
        let path = artifact.keep();
        Ok(EncodedArtifact {
            path,
            size_bytes: facts.size_bytes,
            content_sha256: sha256_hex(&std::fs::read(&self.options.output).unwrap_or_default()),
            width: self.options.profile.width,
            height: self.options.profile.height,
            frame_count: result.frame_count,
            duration_seconds: self.elapsed_seconds,
            has_audio: false,
        })
    }

    fn cancel(&mut self) -> Result<(), EncodeFailure> {
        self.cancelled = true;
        // 丢弃 spool 与输出；`ArtifactFile` 的 Drop 负责删除。
        let _ = std::fs::remove_file(&self.options.spool);
        self.artifact.take();
        Ok(())
    }
}

/// 供宿主/文档使用的后端名称（进入 `codecVersion`）。
pub fn backend_version() -> String {
    format!("openh264-{}", openh264_version())
}

fn openh264_version() -> &'static str {
    // 与 Cargo 锁定的 openh264 version 一致；升级依赖时同步（见 docs/design/native-recording-protocol.md）。
    "0.9.9"
}

/// 写一个恒色（便于测试与 fixture）帧序列，返回成片事实。
///
/// 这是**无 GPU** 的编码回归入口：真机渲染验收仍在别处。
pub fn encode_solid_frames(
    output: &Path,
    profile: EncoderProfile,
    frames: u32,
    duration_seconds: f32,
    rgba: [u8; 4],
) -> Result<EncodedArtifact, EncodeFailure> {
    let spool = output.with_extension("spool");
    let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
        output: output.to_path_buf(),
        spool,
        profile: profile.clone(),
        keyframe_interval_frames: None,
    })?;
    let pixel_count = (profile.width as usize) * (profile.height as usize);
    let mut frame_rgba = Vec::with_capacity(pixel_count * 4);
    for _ in 0..pixel_count {
        frame_rgba.extend_from_slice(&rgba);
    }
    let duration = duration_seconds as f64 / frames.max(1) as f64;
    for index in 0..frames {
        encoder.push(EncoderFrame {
            rgba: frame_rgba.clone(),
            width: profile.width,
            height: profile.height,
            pts_seconds: index as f64 * duration,
            duration_seconds: duration,
        })?;
    }
    encoder.finish()
}

use std::io::Write as _;

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> EncoderProfile {
        EncoderProfile {
            width: 64,
            height: 48,
            bitrate: 400_000,
            fps_numer: 30,
            fps_denom: 1,
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wo-rec-encode-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    #[test]
    fn encodes_real_h264_mp4_with_fast_start() {
        let dir = temp_dir("solid");
        let output = dir.join("solid.mp4");
        let artifact = encode_solid_frames(&output, profile(), 12, 0.4, [200, 40, 40, 255])
            .expect("encode");
        assert_eq!(artifact.frame_count, 12);
        assert_eq!(artifact.width, 64);
        assert_eq!(artifact.height, 48);
        assert!(!artifact.has_audio);
        assert!(artifact.size_bytes > 0);
        let bytes = std::fs::read(&output).expect("artifact exists");
        assert_eq!(bytes.len() as u64, artifact.size_bytes);
        let ftyp = bytes.windows(4).position(|w| w == b"ftyp").expect("ftyp");
        let moov = bytes.windows(4).position(|w| w == b"moov").expect("moov");
        let mdat = bytes.windows(4).position(|w| w == b"mdat").expect("mdat");
        assert!(ftyp < moov && moov < mdat, "Fast Start 结构");
        assert!(bytes.windows(4).any(|w| w == b"avcC"), "应有 avcC 样本描述");
        // 成片必须能被真实 H.264 解码器读出帧：从 avcC 还原参数集、从 mdat 还原 AVCC 样本。
        let mdat_payload = bytes
            .windows(4)
            .position(|w| w == b"mdat")
            .map(|index| index + 4)
            .expect("mdat payload");
        // avcC 负载从 box type 之后开始：
        // version(1) profile(1) compat(1) level(1) lengthSizeMinusOne(1) numSPS(1) len(2) SPS...
        // numPPS(1) len(2) PPS
        let avcc = bytes
            .windows(4)
            .position(|w| w == b"avcC")
            .map(|index| index + 4)
            .expect("avcC box");
        let mut cursor = avcc + 6;
        let mut annex_b_stream: Vec<u8> = Vec::new();
        for _ in 0..2 {
            if cursor + 2 > bytes.len() {
                break;
            }
            let length = u16::from_be_bytes(bytes[cursor..cursor + 2].try_into().unwrap()) as usize;
            cursor += 2;
            if cursor + length > bytes.len() {
                break;
            }
            annex_b_stream.extend_from_slice(&[0, 0, 0, 1]);
            annex_b_stream.extend_from_slice(&bytes[cursor..cursor + length]);
            cursor += length + 1; // 跳过下一个 numXxx 计数
        }
        let mut decoder = openh264::decoder::Decoder::new().expect("decoder");
        let mut decoded_frames = 0u32;
        match decoder.decode(&annex_b_stream) {
            Ok(Some(_)) => decoded_frames += 1,
            Ok(None) | Err(_) => {}
        }
        let mut cursor = mdat_payload;
        while cursor + 4 <= bytes.len() {
            let length = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
            if length == 0 || cursor + 4 + length > bytes.len() {
                break;
            }
            let nal = &bytes[cursor + 4..cursor + 4 + length];
            let mut annex_b = Vec::with_capacity(nal.len() + 4);
            annex_b.extend_from_slice(&[0, 0, 0, 1]);
            annex_b.extend_from_slice(nal);
            match decoder.decode(&annex_b) {
                Ok(Some(image)) => {
                    // 真实解码还要确认尺寸：结构正确但内容错位会在这里暴露。
                    use openh264::formats::YUVSource;
                    assert_eq!(image.dimensions(), (64, 48));
                    // 采样像素应与输入的红块一致（Y 平面中段非黑）。
                    assert!(image.y().iter().any(|value| *value > 32), "解码结果不应是全黑");
                    decoded_frames += 1;
                }
                Ok(None) | Err(_) => {}
            }
            cursor += 4 + length;
        }
        assert!(decoded_frames > 0, "MP4 里应至少有一帧可解码图像");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_frame_size_mismatch() {
        let dir = temp_dir("mismatch");
        let output = dir.join("mismatch.mp4");
        let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
            output,
            spool: dir.join("mismatch.spool"),
            profile: profile(),
            keyframe_interval_frames: None,
        })
        .expect("create");
        let error = encoder
            .push(EncoderFrame {
                rgba: vec![0u8; 32 * 32 * 4],
                width: 32,
                height: 32,
                pts_seconds: 0.0,
                duration_seconds: 1.0 / 30.0,
            })
            .expect_err("mismatch");
        assert_eq!(error.code, "recording-frame-size-mismatch");
        assert_eq!(error.stage, EncodeStage::Encode);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cancel_removes_temporary_artifacts() {
        let dir = temp_dir("cancel");
        let output = dir.join("cancelled.mp4");
        let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
            output: output.clone(),
            spool: dir.join("cancelled.spool"),
            profile: profile(),
            keyframe_interval_frames: None,
        })
        .expect("create");
        encoder
            .push(EncoderFrame {
                rgba: vec![255u8; 64 * 48 * 4],
                width: 64,
                height: 48,
                pts_seconds: 0.0,
                duration_seconds: 1.0 / 30.0,
            })
            .expect("push");
        encoder.cancel().expect("cancel");
        assert!(!output.exists(), "取消后不得留下成片");
        assert!(!dir.join("cancelled.spool").exists(), "取消后不得留下 spool");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finish_without_frames_fails_in_mux_stage() {
        let dir = temp_dir("empty");
        let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
            output: dir.join("empty.mp4"),
            spool: dir.join("empty.spool"),
            profile: profile(),
            keyframe_interval_frames: None,
        })
        .expect("create");
        let error = encoder.finish().expect_err("no frames");
        assert_eq!(error.code, "recording-artifact-empty");
        assert_eq!(error.stage, EncodeStage::Mux);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backend_version_is_stable() {
        assert!(backend_version().starts_with("openh264-"));
    }
}
