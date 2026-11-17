//! Canvas state, indexing, interaction and scheduling primitives.

pub(crate) mod ecs;
pub(crate) mod query;
pub(crate) mod runtime;
pub(crate) mod depth_order;
#[cfg(feature = "canvas-core")]
pub(crate) mod pick_index;
pub(crate) mod preview_layers;
pub(crate) mod preview_readiness;
pub(crate) mod render_work;
