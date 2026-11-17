//! Versioned absolute-position preview DTO. No document/resource mutation.
use super::Viewport;
use serde::Deserialize;
use std::collections::HashSet;

pub(crate) const CANVAS_POSITION_UPDATE_VERSION: &str = "woohaa-canvas-position-v1";
pub(crate) const MAX_POSITION_UPDATE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_POSITION_UPDATES: usize = 16_384;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NodePosition {
    pub(crate) id: String,
    pub(crate) x: f32,
    pub(crate) y: f32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PositionUpdateRequest {
    pub(crate) version: String,
    pub(crate) base_scene_generation: u32,
    /// Includes moved roots and every affected descendant, in absolute canvas coordinates.
    pub(crate) positions: Vec<NodePosition>,
    /// A combined pan/position frame is one final submission.
    pub(crate) viewport: Option<Viewport>,
}

impl PositionUpdateRequest {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != CANVAS_POSITION_UPDATE_VERSION {
            return Err("Unsupported position update version");
        }
        if self.positions.is_empty() || self.positions.len() > MAX_POSITION_UPDATES {
            return Err("Invalid position update count");
        }
        let mut ids = HashSet::with_capacity(self.positions.len());
        for p in &self.positions {
            if p.id.is_empty() || !p.x.is_finite() || !p.y.is_finite() {
                return Err("Invalid position values");
            }
            if !ids.insert(p.id.as_str()) {
                return Err("Duplicate position node");
            }
        }
        if let Some(viewport) = &self.viewport {
            super::viewport::validate_viewport(viewport)?;
        }
        Ok(())
    }
}
