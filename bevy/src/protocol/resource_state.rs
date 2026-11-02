//! Presentation-only updates. Geometry and interaction snapshots stay unchanged.
use serde::Deserialize;
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeResourceState {
    pub(crate) id: String,
    pub(crate) texture: bool,
    pub(crate) media_loading: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceStateRequest {
    version: String,
    pub(crate) base_scene_generation: u32,
    pub(crate) nodes: Vec<NodeResourceState>,
}
impl ResourceStateRequest {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != "woohaa-canvas-resource-state-v1"
            || self.nodes.is_empty()
            || self.nodes.len() > 16384
        {
            return Err("Invalid resource state request");
        }
        let mut ids = std::collections::HashSet::new();
        for node in &self.nodes {
            if node.id.is_empty() || !ids.insert(&node.id) {
                return Err("Invalid resource state node");
            }
        }
        Ok(())
    }
}
