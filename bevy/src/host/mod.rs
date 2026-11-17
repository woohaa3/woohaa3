//! Runtime adapters: Bevy app assembly, host bridge and native-only services.

#[cfg(feature = "canvas-core")]
pub(crate) mod app;
#[cfg(feature = "canvas-core")]
pub(crate) mod bridge;
#[cfg(feature = "native-renderer")]
pub mod video_encode;
