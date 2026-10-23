//! 本域帧预算（design D3）。
//!
//! 共享上限的**唯一权威**仍是 `rust/project-limits.json`（集成负责人维护）。这里只声明本域
//! 实际执行的上限，并按「与现有工程预算取更严格交集」推导，因此不会抬高既有 8192 单边 /
//! 64 MiB 工程 / 64 图层等预算：
//!
//! - 帧数：至多 120 帧（时间轴与导入帧序列同一上限）；
//! - 累计像素：导入帧的累计像素至多 16,777,216，避免一次导入把整份工程预算消耗在解码上；
//! - 解码字节：单次帧导入的解码结果至多 128 MiB；
//! - 交付暂存：逐帧渲染的 RGBA 暂存至多 128 MiB（与解码同一量级），不每帧重新发放整份预算；
//! - 帧率：有限且 `0 < fps <= 1000`（与上游 `timeline.create` 的校验一致）。
//!
//! 提升为共享 `project-limits.json` 字段需要在集成阶段由唯一集成负责人同步 Rust/TS 两侧与
//! contract fixture；本域不改该文件（见 parallel-work.md 的单一写入归属）。

/// 时间轴与导入帧序列的最大帧数。
pub const MAX_FRAMES: usize = 120;
/// 导入帧的累计像素上限（所有帧 `width * height` 之和）。
pub const MAX_CUMULATIVE_FRAME_PIXELS: u64 = 16_777_216;
/// 单次帧导入的解码字节上限（128 MiB）。
pub const MAX_DECODE_BYTES: u64 = 134_217_728;
/// 逐帧交付的 RGBA 暂存上限（128 MiB）。
pub const MAX_DELIVERY_BYTES: u64 = 134_217_728;
/// 帧率上限；更大的值只可能来自错误输入。
pub const MAX_FPS: f32 = 1000.0;

/// 稳定拒绝原因：调用方与测试按 code 判定，不解析中文文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameBudgetError {
    /// 帧数超过 [`MAX_FRAMES`]。
    TooManyFrames,
    /// 累计像素超过 [`MAX_CUMULATIVE_FRAME_PIXELS`]。
    CumulativePixels,
    /// 解码字节超过 [`MAX_DECODE_BYTES`]。
    DecodeBytes,
    /// 交付暂存超过 [`MAX_DELIVERY_BYTES`]。
    DeliveryBytes,
    /// 帧率非法。
    InvalidFps,
    /// 帧尺寸非法（0 或超过画布预算）。
    InvalidFrameSize,
}

impl FrameBudgetError {
    pub fn code(self) -> &'static str {
        match self {
            FrameBudgetError::TooManyFrames => "frame-count-exceeded",
            FrameBudgetError::CumulativePixels => "frame-pixels-exceeded",
            FrameBudgetError::DecodeBytes => "decode-bytes-exceeded",
            FrameBudgetError::DeliveryBytes => "delivery-bytes-exceeded",
            FrameBudgetError::InvalidFps => "invalid-fps",
            FrameBudgetError::InvalidFrameSize => "invalid-frame-size",
        }
    }

    /// 具体原因（含实际值与上限），界面直接展示。
    pub fn message(self, detail: impl std::fmt::Display) -> String {
        match self {
            FrameBudgetError::TooManyFrames => {
                format!("帧数超过上限：{detail} > {MAX_FRAMES} 帧")
            }
            FrameBudgetError::CumulativePixels => {
                format!("累计像素超过上限：{detail} > {MAX_CUMULATIVE_FRAME_PIXELS} 像素")
            }
            FrameBudgetError::DecodeBytes => {
                format!("帧解码字节超过上限：{detail} > {MAX_DECODE_BYTES} 字节")
            }
            FrameBudgetError::DeliveryBytes => {
                format!("交付暂存超过上限：{detail} > {MAX_DELIVERY_BYTES} 字节")
            }
            FrameBudgetError::InvalidFps => {
                format!("帧率必须是 0 到 {MAX_FPS} 之间的有限数值，实际 {detail}")
            }
            FrameBudgetError::InvalidFrameSize => {
                format!("帧尺寸非法：{detail}")
            }
        }
    }
}

/// 一次导入/交付的累积预算；每帧只消耗增量，不重复发放整份预算。
#[derive(Debug, Clone, Default)]
pub struct FrameBudget {
    frames: usize,
    pixels: u64,
    bytes: u64,
}

impl FrameBudget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn frames(&self) -> usize {
        self.frames
    }

    pub fn pixels(&self) -> u64 {
        self.pixels
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    /// 记一帧：先校验尺寸，再校验帧数、累计像素与解码字节。
    pub fn add_frame(&mut self, width: u32, height: u32, decoded_bytes: u64) -> Result<(), FrameBudgetError> {
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_CUMULATIVE_FRAME_PIXELS {
            return Err(FrameBudgetError::InvalidFrameSize);
        }
        let pixels = u64::from(width) * u64::from(height);
        self.check_frames(self.frames + 1)?;
        self.check_pixels(self.pixels.saturating_add(pixels))?;
        self.check_decode_bytes(self.bytes.saturating_add(decoded_bytes))?;
        self.frames += 1;
        self.pixels += pixels;
        self.bytes += decoded_bytes;
        Ok(())
    }

    pub fn check_frames(&self, frames: usize) -> Result<(), FrameBudgetError> {
        if frames > MAX_FRAMES { Err(FrameBudgetError::TooManyFrames) } else { Ok(()) }
    }

    pub fn check_pixels(&self, pixels: u64) -> Result<(), FrameBudgetError> {
        if pixels > MAX_CUMULATIVE_FRAME_PIXELS { Err(FrameBudgetError::CumulativePixels) } else { Ok(()) }
    }

    pub fn check_decode_bytes(&self, bytes: u64) -> Result<(), FrameBudgetError> {
        if bytes > MAX_DECODE_BYTES { Err(FrameBudgetError::DecodeBytes) } else { Ok(()) }
    }

    /// 交付暂存预算：逐帧 RGBA 字节累加，超限即拒绝整次交付。
    pub fn check_delivery_bytes(&self, bytes: u64) -> Result<(), FrameBudgetError> {
        if bytes > MAX_DELIVERY_BYTES { Err(FrameBudgetError::DeliveryBytes) } else { Ok(()) }
    }
}

/// 校验帧率：有限且 `0 < fps <= MAX_FPS`。
pub fn valid_fps(fps: f32) -> Result<f32, FrameBudgetError> {
    if fps.is_finite() && fps > 0.0 && fps <= MAX_FPS { Ok(fps) } else { Err(FrameBudgetError::InvalidFps) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_capped_and_each_frame_only_spends_its_increment() {
        let mut budget = FrameBudget::new();
        for _ in 0..MAX_FRAMES {
            budget.add_frame(64, 64, 64 * 64 * 4).expect("在预算内");
        }
        assert_eq!(budget.frames(), MAX_FRAMES);
        assert_eq!(budget.add_frame(64, 64, 64 * 64 * 4), Err(FrameBudgetError::TooManyFrames));
        // 被拒绝的帧不消耗累计量。
        assert_eq!(budget.frames(), MAX_FRAMES);
        assert_eq!(budget.pixels(), 64 * 64 * MAX_FRAMES as u64);
    }

    #[test]
    fn cumulative_pixels_stop_a_large_sequence_before_allocation() {
        let mut budget = FrameBudget::new();
        // 2048×2048 = 4,194,304 像素/帧：第 5 帧超过 16,777,216。
        for _ in 0..4 {
            budget.add_frame(2048, 2048, 0).expect("前四帧在预算内");
        }
        assert_eq!(budget.add_frame(2048, 2048, 0), Err(FrameBudgetError::CumulativePixels));
        assert_eq!(FrameBudgetError::CumulativePixels.code(), "frame-pixels-exceeded");
    }

    #[test]
    fn decode_and_delivery_bytes_have_their_own_bounds() {
        let mut budget = FrameBudget::new();
        // 尺寸上限与解码上限是两道独立检查，先命中的那道给出原因。
        assert_eq!(budget.add_frame(4097, 4096, 0), Err(FrameBudgetError::InvalidFrameSize));
        assert_eq!(budget.add_frame(9, 9, MAX_DECODE_BYTES + 1), Err(FrameBudgetError::DecodeBytes));
        budget.add_frame(8, 8, MAX_DECODE_BYTES).expect("解码字节刚好到上限");
        assert_eq!(budget.add_frame(8, 8, 1), Err(FrameBudgetError::DecodeBytes));
        assert!(budget.check_delivery_bytes(MAX_DELIVERY_BYTES).is_ok());
        assert_eq!(budget.check_delivery_bytes(MAX_DELIVERY_BYTES + 1), Err(FrameBudgetError::DeliveryBytes));
    }

    #[test]
    fn fps_must_be_finite_and_positive() {
        assert_eq!(valid_fps(30.0), Ok(30.0));
        assert_eq!(valid_fps(0.0), Err(FrameBudgetError::InvalidFps));
        assert_eq!(valid_fps(-1.0), Err(FrameBudgetError::InvalidFps));
        assert_eq!(valid_fps(f32::INFINITY), Err(FrameBudgetError::InvalidFps));
        assert_eq!(valid_fps(MAX_FPS + 1.0), Err(FrameBudgetError::InvalidFps));
    }

    #[test]
    fn messages_name_the_actual_value_and_the_limit() {
        let message = FrameBudgetError::TooManyFrames.message(131);
        assert!(message.contains("131") && message.contains(&MAX_FRAMES.to_string()));
    }
}
