//! 动态镜头视频编码（change: 2026-11-05-camera-shot-as-video，任务 3.2）。
//!
//! 单帧 RGBA → I420 → OpenH264（CPU 编码）→ 单轨 MP4（AVC）。
//! 只在 `native-renderer` feature 下编译：浏览器 WASM 没有该能力，动态取景会显式不可用，
//! 不会降级成静态图片。

pub mod h264;
pub mod mp4;
pub mod protocol;

pub use h264::{EncodedVideo, H264Encoder};
pub use mp4::build_mp4;
pub use protocol::{FinishedVideo, VideoEncoderSession, run_session};

/// 单次动态捕获的硬上限（与 contracts 的 `WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS` 对齐）。
pub const MAX_VIDEO_SECONDS: u32 = 60;
/// 帧率上限。
pub const MAX_VIDEO_FPS: u32 = 60;
/// 尺寸上限（4K 以内，避免一次录制耗尽内存）。
pub const MAX_VIDEO_EDGE: u32 = 4096;
