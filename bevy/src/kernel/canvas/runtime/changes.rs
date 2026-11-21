//! Accepted-scene diffing for local projection and block invalidation.
//!
//! The input scenes are borrowed and the result contains only stable ids and
//! document slots.  Consumers decide how those ids map to ECS entities.

use std::collections::{BTreeSet, HashMap};

use crate::protocol::{GraphNode, Scene};

use super::indices::CanvasIndices;

pub(crate) const BLOCK_SIZE: usize = 16;

/// Read-only view of a same-generation `nodeId → document slot` table.
///
/// Implemented by the app's `NodeIndex`; `canvas_runtime` only needs the slot
/// lookup, not the owning resource type.
pub(crate) trait NodeSlots {
    /// Document slot a position patch writes to: the last occurrence of a
    /// duplicated id, matching the previous `HashMap` collect semantics.
    fn slot_last(&self, id: &str) -> Option<usize>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeChange {
    Added,
    Removed,
    Layout,
    Content,
    Resource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) enum ViewportChange {
    #[default]
    None,
    Pan,
    Zoom,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChangeSet {
    pub(crate) structure_changed: bool,
    pub(crate) nodes: Vec<(String, NodeChange)>,
    pub(crate) card_blocks: BTreeSet<u32>,
    pub(crate) edge_blocks: BTreeSet<u32>,
    pub(crate) incident_edges: BTreeSet<u32>,
    pub(crate) viewport: ViewportChange,
}

impl ChangeSet {
    /// Add the actual accepted position updates using the same-generation
    /// node slots and adjacency; no scene scan or snapshot copy is required.
    ///
    /// `slots` is any same-generation `nodeId → document slot` table (the app's
    /// `NodeIndex`). `canvas_runtime` does not depend on the app layer, so this
    /// stays a trait bound instead of an import.
    pub(crate) fn add_positions(
        &mut self,
        ids: &[String],
        slots: &impl NodeSlots,
        edges: &super::indices::EdgeIndex,
    ) {
        for id in ids {
            let Some(slot) = slots.slot_last(id) else {
                continue;
            };
            self.nodes.push((id.clone(), NodeChange::Layout));
            self.card_blocks.insert((slot / BLOCK_SIZE) as u32);
            for &edge in edges.incident(id) {
                self.incident_edges.insert(edge as u32);
                self.edge_blocks.insert((edge / BLOCK_SIZE) as u32);
            }
        }
    }

    pub(crate) fn between(previous: Option<&Scene>, next: &Scene) -> Self {
        let Some(previous) = previous else {
            let mut result = Self {
                structure_changed: true,
                viewport: ViewportChange::Zoom,
                ..Self::default()
            };
            result
                .card_blocks
                .extend(0..next.nodes.len().div_ceil(BLOCK_SIZE) as u32);
            result
                .edge_blocks
                .extend(0..next.edges.len().div_ceil(BLOCK_SIZE) as u32);
            return result;
        };
        let mut result = Self::default();
        let previous_ids: Vec<&str> = previous.nodes.iter().map(|node| node.id.as_str()).collect();
        let next_ids: Vec<&str> = next.nodes.iter().map(|node| node.id.as_str()).collect();
        result.structure_changed = previous_ids != next_ids;
        let old_by_id: HashMap<&str, &GraphNode> = previous
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        let indices = CanvasIndices::build(next);
        for (index, node) in next.nodes.iter().enumerate() {
            let change = match old_by_id.get(node.id.as_str()) {
                None => Some(NodeChange::Added),
                Some(old) if layout_changed(old, node) => Some(NodeChange::Layout),
                Some(old) if resource_changed(old, node) => Some(NodeChange::Resource),
                Some(old) if content_changed(old, node) => Some(NodeChange::Content),
                _ => None,
            };
            if let Some(change) = change {
                result.nodes.push((node.id.clone(), change));
                result.card_blocks.insert((index / BLOCK_SIZE) as u32);
                result.incident_edges.extend(
                    indices
                        .edges
                        .incident(&node.id)
                        .iter()
                        .map(|edge| *edge as u32),
                );
            }
        }
        let next_by_id: HashMap<&str, &GraphNode> = next
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        for (index, old) in previous.nodes.iter().enumerate() {
            if !next_by_id.contains_key(old.id.as_str()) {
                result.nodes.push((old.id.clone(), NodeChange::Removed));
                result.card_blocks.insert((index / BLOCK_SIZE) as u32);
                result.structure_changed = true;
            }
        }
        if result.structure_changed {
            result
                .card_blocks
                .extend(0..next.nodes.len().div_ceil(BLOCK_SIZE) as u32);
            result
                .edge_blocks
                .extend(0..next.edges.len().div_ceil(BLOCK_SIZE) as u32);
        } else {
            result.edge_blocks.extend(
                result
                    .incident_edges
                    .iter()
                    .map(|edge| edge / BLOCK_SIZE as u32),
            );
            if edges_changed(previous, next) {
                result
                    .edge_blocks
                    .extend(0..next.edges.len().div_ceil(BLOCK_SIZE) as u32);
            }
        }
        result.viewport = viewport_change(&previous.viewport, &next.viewport);
        result
    }
}

fn edges_changed(previous: &Scene, next: &Scene) -> bool {
    previous.edges.len() != next.edges.len()
        || previous.edges.iter().zip(&next.edges).any(|(a, b)| {
            a.id != b.id || a.source != b.source || a.target != b.target || a.label != b.label
        })
}

fn layout_changed(a: &GraphNode, b: &GraphNode) -> bool {
    a.x != b.x || a.y != b.y || a.width != b.width || a.height != b.height
}

fn resource_changed(a: &GraphNode, b: &GraphNode) -> bool {
    a.texture != b.texture
        || a.media_loading != b.media_loading
        || a.model.as_ref().map(|m| (&m.resource_key, &m.signature))
            != b.model.as_ref().map(|m| (&m.resource_key, &m.signature))
}

fn content_changed(a: &GraphNode, b: &GraphNode) -> bool {
    a.title != b.title
        || a.body != b.body
        || a.type_label != b.type_label
        || a.card_label != b.card_label
        || a.kind != b.kind
        || a.chrome != b.chrome
        || a.ghost != b.ghost
        || a.busy != b.busy
        || a.history_strip != b.history_strip
}

fn viewport_change(a: &crate::protocol::Viewport, b: &crate::protocol::Viewport) -> ViewportChange {
    if a.zoom != b.zoom {
        ViewportChange::Zoom
    } else if a.x != b.x || a.y != b.y {
        ViewportChange::Pan
    } else {
        ViewportChange::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scene() -> Scene {
        let mut scene = Scene::default();
        scene.nodes = serde_json::from_value(json!([
            {"id":"a","type":"text","x":0,"y":0,"title":"A"},
            {"id":"b","type":"text","x":100,"y":0,"title":"B"}
        ]))
        .unwrap();
        scene.edges = serde_json::from_value(json!([
            {"id":"e","source":"a","target":"b"}
        ]))
        .unwrap();
        scene
    }

    #[test]
    fn local_title_change_only_dirties_one_card_block_and_incident_edge_block() {
        let old = scene();
        let mut next = old.clone();
        next.nodes[0].title = "changed".into();
        let diff = ChangeSet::between(Some(&old), &next);
        assert_eq!(diff.nodes, vec![("a".into(), NodeChange::Content)]);
        assert_eq!(diff.card_blocks, [0].into_iter().collect());
        assert_eq!(diff.edge_blocks, [0].into_iter().collect());
        assert_eq!(diff.viewport, ViewportChange::None);
    }

    #[test]
    fn position_change_marks_layout_and_incident_edge_without_full_structure() {
        let old = scene();
        let mut next = old.clone();
        next.nodes[1].x += 10.;
        let diff = ChangeSet::between(Some(&old), &next);
        assert_eq!(diff.nodes, vec![("b".into(), NodeChange::Layout)]);
        assert!(!diff.structure_changed);
        assert_eq!(diff.incident_edges, [0].into_iter().collect());
    }

    #[test]
    fn edge_style_change_dirties_only_the_changed_edge_block() {
        let old = scene();
        let mut next = old.clone();
        next.edges[0].label = "new label".into();
        let diff = ChangeSet::between(Some(&old), &next);
        assert!(!diff.structure_changed);
        assert_eq!(diff.nodes, Vec::<(String, NodeChange)>::new());
        assert_eq!(diff.edge_blocks, [0].into_iter().collect());
    }

    #[test]
    fn first_scene_is_conservative_and_viewport_zoom_is_separate() {
        let scene = scene();
        let diff = ChangeSet::between(None, &scene);
        assert!(diff.structure_changed);
        assert_eq!(diff.viewport, ViewportChange::Zoom);
    }
}
