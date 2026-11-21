use super::scene_instant::NodeHover;
use serde::Deserialize;
pub(crate) const CANVAS_HOVER_UPDATE_VERSION: &str = "woohaa-canvas-hover-v1";
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HoverUpdateRequest {
    pub(crate) version: String,
    pub(crate) base_scene_generation: u32,
    pub(crate) hover: Option<NodeHover>,
}
impl HoverUpdateRequest {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_HOVER_UPDATE_VERSION {
            return Err("Unsupported hover update version");
        }
        if let Some(h) = &self.hover {
            if h.node_id.is_none() == h.edge_id.is_none() {
                return Err("Invalid hover target");
            }
        }
        Ok(())
    }
}
