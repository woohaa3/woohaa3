//! Pure node/edge indexing shared by render and query planning.
//!
//! The index owns no ECS entities and never borrows a Bevy resource.  A renderer and
//! the interaction snapshot may each keep a generation of this value; only the
//! generation that accepted a scene may be used for a diff.

use std::collections::{HashMap, HashSet};

use crate::protocol::{Edge, Scene};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct NodeIndex {
    by_id: HashMap<String, usize>,
}

impl NodeIndex {
    pub(crate) fn build(scene: &Scene) -> Self {
        let mut by_id = HashMap::with_capacity(scene.nodes.len());
        for (index, node) in scene.nodes.iter().enumerate() {
            by_id.entry(node.id.clone()).or_insert(index);
        }
        Self { by_id }
    }

    pub(crate) fn get(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }

    pub(crate) fn len(&self) -> usize {
        self.by_id.len()
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EdgeIndex {
    /// Node id -> edge indices.  A self edge is stored once.
    incident: HashMap<String, Vec<usize>>,
}

impl EdgeIndex {
    pub(crate) fn build(edges: &[Edge]) -> Self {
        let mut incident: HashMap<String, Vec<usize>> = HashMap::new();
        for (index, edge) in edges.iter().enumerate() {
            incident.entry(edge.source.clone()).or_default().push(index);
            if edge.target != edge.source {
                incident.entry(edge.target.clone()).or_default().push(index);
            }
        }
        Self { incident }
    }

    pub(crate) fn incident(&self, id: &str) -> &[usize] {
        self.incident.get(id).map(Vec::as_slice).unwrap_or(&[])
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CanvasIndices {
    pub(crate) nodes: NodeIndex,
    pub(crate) edges: EdgeIndex,
}

impl CanvasIndices {
    pub(crate) fn build(scene: &Scene) -> Self {
        Self {
            nodes: NodeIndex::build(scene),
            edges: EdgeIndex::build(&scene.edges),
        }
    }

    pub(crate) fn incident_edges<'a>(&'a self, ids: impl IntoIterator<Item = &'a str>) -> Vec<usize> {
        let mut edges = HashSet::new();
        for id in ids {
            edges.extend(self.edges.incident(id).iter().copied());
        }
        let mut edges: Vec<_> = edges.into_iter().collect();
        edges.sort_unstable();
        edges
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scene() -> Scene {
        let mut scene = Scene::default();
        scene.nodes = serde_json::from_value(json!([
            {"id":"a","type":"text","x":0,"y":0},
            {"id":"b","type":"text","x":10,"y":10}
        ])).unwrap();
        scene.edges = serde_json::from_value(json!([
            {"id":"e0","source":"a","target":"b"},
            {"id":"e1","source":"a","target":"a"}
        ])).unwrap();
        scene
    }

    #[test]
    fn indexes_nodes_and_deduplicates_self_edges() {
        let scene = scene();
        let indices = CanvasIndices::build(&scene);
        assert_eq!(indices.nodes.get("a"), Some(0));
        assert_eq!(indices.edges.incident("a"), &[0, 1]);
        assert_eq!(indices.incident_edges(["a", "b"].into_iter()).as_slice(), &[0, 1]);
    }
}
