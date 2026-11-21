//! Shared-world camera, preview and capture rendering.

#[cfg(feature = "canvas-core")]
pub(crate) mod binding;
#[cfg(feature = "canvas-core")]
pub(crate) mod camera;
#[cfg(feature = "canvas-core")]
pub(crate) mod capture;
#[cfg(feature = "canvas-core")]
pub(crate) mod history_preview;
#[cfg(feature = "canvas-core")]
pub(crate) mod preview;
#[cfg(any(feature = "canvas-core", feature = "native-renderer"))]
pub(crate) mod view;
