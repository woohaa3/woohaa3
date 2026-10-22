//! Shot camera 预算常量
//! （change: add-reusable-bevy-shot-camera，任务 2.3 / design D3）。

/// preview 单边最大像素（限制 render target 总预算）。
pub const MAX_PREVIEW_DIMENSION: u32 = 2048;
/// capture 单边最大像素。
pub const MAX_CAPTURE_DIMENSION: u32 = 4096;
/// 同帧最多推进的 preview 更新数。
pub const DEFAULT_MAX_PREVIEW_UPDATES_PER_FRAME: usize = 4;
/// 同帧所有 preview 更新的总像素预算。
pub const DEFAULT_MAX_PREVIEW_PIXELS_PER_FRAME: u64 = 8 * 1024 * 1024;
/// capture 并发上限。
pub const DEFAULT_MAX_CONCURRENT_CAPTURES: usize = 2;
/// capture 队列长度上限。
pub const DEFAULT_MAX_QUEUED_CAPTURES: usize = 8;
