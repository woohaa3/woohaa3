//! Shared diagnostics, timing and generated presentation support.

pub(crate) mod clock;
pub mod canvas_activity;
pub(crate) mod frame_samples;
pub(crate) mod generation_progress;
#[cfg(feature = "canvas-core")]
pub(crate) mod runtime_health;
pub(crate) mod startup_trace;
pub(crate) mod theme;
pub(crate) mod theme_generated;
