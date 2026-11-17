//! Shared-world camera, preview and capture rendering.

#[cfg(feature = "canvas-core")]
pub(crate) mod camera;
#[cfg(feature = "canvas-core")]
pub(crate) mod preview;
#[cfg(feature = "canvas-core")]
pub(crate) mod binding;
#[cfg(any(feature = "canvas-core", feature = "native-renderer"))]
pub(crate) mod view;
#[cfg(feature = "canvas-core")]
pub(crate) mod capture;
#[cfg(feature = "canvas-core")]
pub(crate) mod history_preview;
