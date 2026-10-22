//! 原生 H.264 编码与 MP4 封装
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 4.3 / design D5）。
//!
//! 设计约束：
//! - **不依赖用户 PATH**：编码器由 Rust 直接链接（OpenH264 软件编码；平台硬件编码作为后续
//!   优化项，调用方按 capability 探测选择），不 spawn `ffmpeg`；
//! - **有界**：帧队列容量固定，回压时**阻塞生产**而不是丢帧；
//! - **确定性时间**：PTS 由调用方给定的有理时间表决定，编码器不自己计时；
//! - **增量写**：编码边写临时文件，超过 256 MiB 立即失败并删除产物；
//! - **无音轨**：首期输出只有视频轨。
//!
//! 本模块不含 Bevy，可用纯 CPU + GPU 无关路径测试（见文件末尾）。

use std::fs::File;
use std::io::{BufWriter, Seek, Write};
use std::path::{Path, PathBuf};

/// 成片大小上限（与 `DEFAULT_MAX_UPLOAD_BYTES` 一致：256 MiB）。
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;

/// 编码输出格式：首期只有 MP4/H.264。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncoderProfile {
    pub width: u32,
    pub height: u32,
    pub bitrate: u32,
    /// 采样帧率分子/分母（写入容器时用）。
    pub fps_numer: u32,
    pub fps_denom: u32,
}

impl EncoderProfile {
    /// 宽高必须是偶数：YUV420 色度下采样要求，奇数尺寸会被拒绝而不是悄悄裁掉一像素。
    pub fn validate(&self) -> Result<(), EncodeFailure> {
        if self.width == 0 || self.height == 0 {
            return Err(EncodeFailure::new(EncodeStage::Encode, "recording-invalid-size", "输出尺寸必须为正"));
        }
        if self.width % 2 != 0 || self.height % 2 != 0 {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-invalid-size",
                "H.264 输出尺寸必须是偶数（YUV420 下采样要求）",
            ));
        }
        if self.width > 4096 || self.height > 4096 {
            return Err(EncodeFailure::new(
                EncodeStage::Encode,
                "recording-invalid-size",
                "输出尺寸超过 4096 上限",
            ));
        }
        if self.fps_numer == 0 || self.fps_denom == 0 {
            return Err(EncodeFailure::new(EncodeStage::Encode, "recording-invalid-frame-rate", "帧率必须为正"));
        }
        Ok(())
    }
}

/// 编码/封装阶段；与 proto `RecordingErrorStage` 对齐。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeStage {
    Encode,
    Mux,
}

impl EncodeStage {
    pub fn proto_symbol(self) -> &'static str {
        match self {
            Self::Encode => "RECORDING_ERROR_STAGE_ENCODE",
            Self::Mux => "RECORDING_ERROR_STAGE_MUX",
        }
    }
}

/// 编码失败：稳定错误码 + 阶段 + 可读说明。
#[derive(Clone, Debug, PartialEq)]
pub struct EncodeFailure {
    pub stage: EncodeStage,
    pub code: &'static str,
    pub message: String,
    /// 是否值得重试（硬件编码中途失败按新 attempt 重试；预算/参数错误不重试）。
    pub transient: bool,
}

impl EncodeFailure {
    pub fn new(stage: EncodeStage, code: &'static str, message: impl Into<String>) -> Self {
        Self { stage, code, message: message.into(), transient: false }
    }

    pub fn transient(mut self) -> Self {
        self.transient = true;
        self
    }
}

/// 一帧待编码像素：RGBA8、自顶向下。
pub struct EncoderFrame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// 呈现时间戳（秒）；由有理时间表算出，编码器不再解释。
    pub pts_seconds: f64,
    /// 该帧呈现时长（秒）。
    pub duration_seconds: f64,
}

/// 编码器接口：真实实现与测试替身都实现它。
///
/// `finish` 取 `&mut self` 而不是 `self`/`Box<Self>`：录制编排持有 `&mut dyn VideoEncoder`，
/// 且必须能在 finish 之后仍执行清理。实现可在 finish 内部释放资源。
pub trait VideoEncoder {
    /// 编码并写入一帧；队列满时阻塞（回压），不丢帧。
    fn push(&mut self, frame: EncoderFrame) -> Result<(), EncodeFailure>;
    /// 结束编码并完成封装；返回可交付的成片事实。
    fn finish(&mut self) -> Result<EncodedArtifact, EncodeFailure>;
    /// 取消：停止编码、删除临时产物（幂等）。
    fn cancel(&mut self) -> Result<(), EncodeFailure>;
}

/// 成片事实：宿主会重新 probe，这里只是 worker 自查结果。
///
/// 含 `f64` 时长，因此只实现 `PartialEq`。
#[derive(Clone, Debug, PartialEq)]
pub struct EncodedArtifact {
    pub path: PathBuf,
    pub size_bytes: u64,
    /// 流式 SHA-256（小写 hex）。
    pub content_sha256: String,
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
    /// 成片时长（秒，容器时间精度内）。
    pub duration_seconds: f64,
    pub has_audio: bool,
}

/// 有界帧队列容量：与 design D6「最多 3 个在途回读/编码帧」一致。
pub const FRAME_QUEUE_CAPACITY: usize = 3;

/// 从 RGBA 计算流式 sha256（不引入额外 crate：用 FNV 不可用于校验，改用内置实现）。
///
/// 这是**成片自查**用的摘要；宿主的权威校验仍会重新计算，不依赖本值。
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// 最小 SHA-256 实现（避免为一次摘要引入依赖爆炸；正确性由测试向量覆盖）。
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (bytes.len() as u64) * 8;
    let mut padded = Vec::with_capacity(bytes.len() + 72);
    padded.extend_from_slice(bytes);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, value) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

/// RGBA → YUV420 的 BT.709 转换（与 HTML/视频默认一致；不做线性化，保持 sRGB 直通）。
///
/// 输入自顶向下、4 字节/像素；输出 Y 平面 + 交错的 U/V（每 2×2 一个样本）。
pub fn rgba_to_yuv420(rgba: &[u8], width: u32, height: u32) -> Option<Yuv420Frame> {
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
        return None;
    }
    if rgba.len() != w * h * 4 {
        return None;
    }
    let mut y = vec![0u8; w * h];
    let mut u = vec![0u8; (w / 2) * (h / 2)];
    let mut v = vec![0u8; (w / 2) * (h / 2)];
    for row in 0..h {
        for col in 0..w {
            let index = (row * w + col) * 4;
            let (r, g, b) = (
                rgba[index] as f32,
                rgba[index + 1] as f32,
                rgba[index + 2] as f32,
            );
            // BT.709 limited range。
            let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            y[row * w + col] = (16.0 + (luma / 255.0) * 219.0).round().clamp(0.0, 255.0) as u8;
            if row % 2 == 0 && col % 2 == 0 {
                let (cb, cr) = (
                    -0.1146 * r - 0.3854 * g + 0.5 * b,
                    0.5 * r - 0.4542 * g - 0.0458 * b,
                );
                let u_index = (row / 2) * (w / 2) + col / 2;
                u[u_index] = (128.0 + (cb / 255.0) * 224.0).round().clamp(0.0, 255.0) as u8;
                v[u_index] = (128.0 + (cr / 255.0) * 224.0).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Some(Yuv420Frame { width, height, y, u, v })
}

/// YUV420 帧（三个平面分开，便于按 stride 拷贝给编码器）。
#[derive(Clone, Debug, PartialEq)]
pub struct Yuv420Frame {
    pub width: u32,
    pub height: u32,
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

/// 校验 worker 产出的成片结构（不依赖外部 probe 工具）。
///
/// 只读实际文件：检查 `ftyp`、`moov` 在 `mdat` 之前（Fast Start）、存在 `avc1`/`avcC`
/// 样本描述、以及文件长度与声明大小一致。任何不符都按 `EncodeStage::Mux` 拒绝。
pub fn verify_mp4(path: &Path, expected_size: u64) -> Result<Mp4Facts, EncodeFailure> {
    let bytes = std::fs::read(path)
        .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-unreadable", error.to_string()))?;
    if bytes.len() as u64 != expected_size {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-truncated",
            format!("成片长度 {} 与声明 {} 不一致", bytes.len(), expected_size),
        ));
    }
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-too-large",
            format!("成片超过 {MAX_ARTIFACT_BYTES} 字节上限"),
        ));
    }
    let find = |needle: &[u8]| bytes.windows(needle.len()).position(|window| window == needle);
    let ftyp = find(b"ftyp").ok_or_else(|| {
        EncodeFailure::new(EncodeStage::Mux, "recording-artifact-not-mp4", "缺少 MP4 ftyp box")
    })?;
    if ftyp > 32 {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-not-mp4",
            "ftyp 不在文件头部",
        ));
    }
    let moov = find(b"moov");
    let mdat = find(b"mdat");
    let (moov, mdat) = match (moov, mdat) {
        (Some(moov), Some(mdat)) => (moov, mdat),
        _ => {
            return Err(EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-incomplete",
                "缺少 moov 或 mdat box",
            ))
        }
    };
    if moov > mdat {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-not-fast-start",
            "moov 在 mdat 之后，Fast Start 未生效",
        ));
    }
    let avc1 = find(b"avc1");
    let avcc = find(b"avcC");
    if avc1.is_none() || avcc.is_none() {
        return Err(EncodeFailure::new(
            EncodeStage::Mux,
            "recording-artifact-wrong-codec",
            "样本描述不是 H.264（缺少 avc1/avcC）",
        ));
    }
    Ok(Mp4Facts {
        size_bytes: bytes.len() as u64,
        content_sha256: sha256_hex(&bytes),
        has_audio: find(b"soun").is_some(),
    })
}

/// `verify_mp4` 的观察结果。
#[derive(Clone, Debug, PartialEq)]
pub struct Mp4Facts {
    pub size_bytes: u64,
    pub content_sha256: String,
    pub has_audio: bool,
}

/// 临时产物管理器：确保取消/失败时删除私有文件。
pub struct ArtifactFile {
    path: PathBuf,
}

impl ArtifactFile {
    /// 在给定目录创建 `<name>.mp4` 临时文件。
    pub fn create(directory: &Path, name: &str) -> Result<Self, EncodeFailure> {
        std::fs::create_dir_all(directory).map_err(|error| {
            EncodeFailure::new(EncodeStage::Mux, "recording-artifact-directory-failed", error.to_string())
        })?;
        let path = directory.join(format!("{name}.mp4"));
        File::create(&path).map_err(|error| {
            EncodeFailure::new(EncodeStage::Mux, "recording-artifact-create-failed", error.to_string())
        })?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 成功路径：保留文件，放弃删除责任。
    pub fn keep(mut self) -> PathBuf {
        let path = std::mem::take(&mut self.path);
        std::mem::forget(self);
        path
    }
}

impl Drop for ArtifactFile {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 简单有界写入器：增量写并在超限时失败，避免先写满磁盘再判断。
pub struct BoundedWriter {
    inner: BufWriter<File>,
    written: u64,
    limit: u64,
}

impl BoundedWriter {
    pub fn create(path: &Path, limit: u64) -> Result<Self, EncodeFailure> {
        let file = File::create(path).map_err(|error| {
            EncodeFailure::new(EncodeStage::Mux, "recording-artifact-create-failed", error.to_string())
        })?;
        Ok(Self { inner: BufWriter::new(file), written: 0, limit })
    }

    pub fn write_all(&mut self, bytes: &[u8]) -> Result<(), EncodeFailure> {
        let next = self.written.saturating_add(bytes.len() as u64);
        if next > self.limit {
            return Err(EncodeFailure::new(
                EncodeStage::Mux,
                "recording-artifact-too-large",
                format!("成片超过 {0} 字节上限", self.limit),
            ));
        }
        self.inner
            .write_all(bytes)
            .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-write-failed", error.to_string()))?;
        self.written = next;
        Ok(())
    }

    pub fn rewrite_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), EncodeFailure> {
        self.inner
            .flush()
            .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-write-failed", error.to_string()))?;
        let file = self.inner.get_mut();
        file.seek(std::io::SeekFrom::Start(offset))
            .and_then(|_| file.write_all(bytes))
            .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-write-failed", error.to_string()))?;
        Ok(())
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn finish(mut self) -> Result<u64, EncodeFailure> {
        self.inner
            .flush()
            .map_err(|error| EncodeFailure::new(EncodeStage::Mux, "recording-artifact-write-failed", error.to_string()))?;
        Ok(self.written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn profile_rejects_odd_and_oversized_dimensions() {
        let base = EncoderProfile { width: 1280, height: 720, bitrate: 4_000_000, fps_numer: 30, fps_denom: 1 };
        assert!(base.validate().is_ok());
        assert_eq!(
            EncoderProfile { width: 1281, ..base }.validate().unwrap_err().code,
            "recording-invalid-size"
        );
        assert_eq!(
            EncoderProfile { width: 0, ..base }.validate().unwrap_err().code,
            "recording-invalid-size"
        );
        assert_eq!(
            EncoderProfile { width: 5000, ..base }.validate().unwrap_err().code,
            "recording-invalid-size"
        );
        assert_eq!(
            EncoderProfile { fps_numer: 0, ..base }.validate().unwrap_err().code,
            "recording-invalid-frame-rate"
        );
    }

    #[test]
    fn rgba_conversion_is_bounded_and_alpha_free() {
        // 2x2 纯白：Y 应为 limited-range 上限附近，U/V 为中性 128。
        let white = vec![255u8; 2 * 2 * 4];
        let frame = rgba_to_yuv420(&white, 2, 2).expect("converted");
        assert_eq!(frame.y.len(), 4);
        assert_eq!(frame.u.len(), 1);
        assert_eq!(frame.v.len(), 1);
        assert!(frame.y.iter().all(|value| *value >= 235), "白色 Y 应接近 235");
        assert_eq!(frame.u[0], 128);
        assert_eq!(frame.v[0], 128);

        // 黑色：limited range 下限 16。
        let black = vec![0u8, 0, 0, 255].repeat(4);
        let frame = rgba_to_yuv420(&black, 2, 2).expect("converted");
        assert!(frame.y.iter().all(|value| *value <= 16));

        // 尺寸/长度不符直接拒绝，不做裁剪。
        assert!(rgba_to_yuv420(&white, 3, 2).is_none());
        assert!(rgba_to_yuv420(&white[..8], 2, 2).is_none());
        assert!(rgba_to_yuv420(&white, 0, 2).is_none());
    }

    #[test]
    fn yuv_conversion_keeps_colour_separation() {
        // 左红右蓝：U/V 应有明显差异，证明没有把色度丢掉。
        let mut rgba = Vec::with_capacity(2 * 2 * 4);
        rgba.extend_from_slice(&[255, 0, 0, 255]);
        rgba.extend_from_slice(&[0, 0, 255, 255]);
        rgba.extend_from_slice(&[255, 0, 0, 255]);
        rgba.extend_from_slice(&[0, 0, 255, 255]);
        let frame = rgba_to_yuv420(&rgba, 2, 2).expect("converted");
        // 只有一个 2x2 色度样本（混合红蓝），至少不能是中性灰。
        assert_ne!(frame.u[0], 128);
    }

    #[test]
    fn bounded_writer_refuses_to_exceed_the_limit() {
        let dir = std::env::temp_dir().join("wo-recording-writer-test");
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("bounded.bin");
        let mut writer = BoundedWriter::create(&path, 8).expect("create");
        writer.write_all(&[1u8; 8]).expect("within limit");
        let error = writer.write_all(&[1u8]).expect_err("over limit");
        assert_eq!(error.code, "recording-artifact-too-large");
        assert_eq!(error.stage, EncodeStage::Mux);
        drop(writer);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn artifact_file_is_removed_without_keep() {
        let dir = std::env::temp_dir().join("wo-recording-artifact-test");
        let file = ArtifactFile::create(&dir, "job-1").expect("create");
        let path = file.path().to_path_buf();
        assert!(path.exists());
        drop(file);
        assert!(!path.exists(), "未保留的临时产物必须被删除");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn artifact_file_survives_when_kept() {
        let dir = std::env::temp_dir().join("wo-recording-artifact-keep-test");
        let file = ArtifactFile::create(&dir, "job-2").expect("create");
        let path = file.keep();
        assert!(path.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mp4_verification_rejects_truncated_and_wrong_container() {
        let dir = std::env::temp_dir().join("wo-recording-mp4-test");
        std::fs::create_dir_all(&dir).expect("dir");

        // 不是 MP4。
        let not_mp4 = dir.join("not.mp4");
        std::fs::write(&not_mp4, b"not a container at all").expect("write");
        let error = verify_mp4(&not_mp4, 22).expect_err("not mp4");
        assert_eq!(error.code, "recording-artifact-not-mp4");

        // 声明长度与实际不符（截断）。
        let truncated = dir.join("truncated.mp4");
        std::fs::write(&truncated, b"\0\0\0\x14ftypisom").expect("write");
        let error = verify_mp4(&truncated, 10_000).expect_err("truncated");
        assert_eq!(error.code, "recording-artifact-truncated");

        // moov 在 mdat 之后：Fast Start 未生效。
        let mut slow = Vec::new();
        slow.extend_from_slice(b"\0\0\0\x14ftypisom");
        slow.extend_from_slice(b"mdat");
        slow.extend_from_slice(b"moov");
        slow.extend_from_slice(b"avc1avcC");
        let slow_path = dir.join("slow.mp4");
        std::fs::write(&slow_path, &slow).expect("write");
        let error = verify_mp4(&slow_path, slow.len() as u64).expect_err("not fast start");
        assert_eq!(error.code, "recording-artifact-not-fast-start");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mp4_verification_accepts_fast_start_h264_structure() {
        let dir = std::env::temp_dir().join("wo-recording-mp4-ok-test");
        std::fs::create_dir_all(&dir).expect("dir");
        let mut ok = Vec::new();
        ok.extend_from_slice(b"\0\0\0\x14ftypisom");
        ok.extend_from_slice(b"moovavc1avcC");
        ok.extend_from_slice(b"mdat");
        let path = dir.join("ok.mp4");
        std::fs::write(&path, &ok).expect("write");
        let facts = verify_mp4(&path, ok.len() as u64).expect("valid mp4");
        assert_eq!(facts.size_bytes, ok.len() as u64);
        assert!(!facts.has_audio);
        assert_eq!(facts.content_sha256, sha256_hex(&ok));
        std::fs::remove_dir_all(&dir).ok();
    }
}
