//! Bevy rendering domains.

#[cfg(feature = "canvas-core")]
pub(crate) mod canvas2d;
pub mod model3d;
pub(crate) mod scope_visual;
#[cfg(any(feature = "canvas-core", feature = "native-renderer"))]
pub(crate) mod world;
pub mod shot_camera;
