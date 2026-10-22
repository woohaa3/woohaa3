//! Opt-in explicit primitive instancing; canonical specs remain independent.
mod material;
mod render;
mod spawn;
pub(super) use spawn::spawn_groups;
pub(super) mod plan;
pub(crate) use material::InstancingPlugin;
pub(super) use material::InstanceMaterial;
pub(crate) use render::{DrawMeshDispatch, InstanceWork};
use bevy::prelude::*;
use std::sync::Arc;

pub(crate) const MAX_INSTANCES: usize = 64;
pub(crate) const INSTANCE_STRIDE: usize = 96;
#[cfg(test)]
mod tests;
pub(crate) fn enabled() -> bool {
    super::batch_strategy::BatchStrategy::default() == super::batch_strategy::BatchStrategy::Explicit
}
#[derive(Component, Clone)]
pub(crate) struct Instances {
    pub bytes: Arc<[u8]>,
    pub parts: Arc<[String]>,
}

impl bevy::render::sync_component::SyncComponent<bevy::render::RenderApp> for Instances {
    type Target = Self;
}
impl bevy::render::extract_component::ExtractComponent<bevy::render::RenderApp> for Instances {
    type QueryData = &'static Self;
    type QueryFilter = ();
    type Out = Self;
    fn extract_component(value: bevy::ecs::query::QueryItem<'_, '_, Self::QueryData>) -> Option<Self> {
        Some(value.clone())
    }
}
