//! Bevy rendering domains.

#[cfg(feature = "canvas-core")]
pub(crate) mod canvas2d;
pub mod model3d;
pub(crate) mod scope_visual;
pub mod shot_camera;
#[cfg(any(feature = "canvas-core", feature = "native-renderer"))]
pub(crate) mod world;
