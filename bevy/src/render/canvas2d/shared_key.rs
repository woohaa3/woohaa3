//! Exact draw-only invalidation for the retained shared overlay buffers.
//! No model/media/vertex payloads or unrelated ordinary-card content is copied.
use crate::{
    protocol::{AggregateConnect, Draft, DragAttach, Marquee, Scene},
    theme::ThemeResource,
};
use std::collections::HashSet;
#[derive(PartialEq)]
struct Reference {
    id: String,
    rect: [f32; 4],
    ports: [[f32; 2]; 2],
}
#[derive(PartialEq)]
pub(super) struct SharedKey {
    theme: String,
    scope_revision: u64,
    frame_zoom: Option<f32>,
    frames: Vec<(String, [f32; 4])>,
    frame_hover: Option<String>,
    frame_selection: Vec<String>,
    references: Vec<Reference>,
    draft: Option<Draft>,
    marquee: Option<Marquee>,
    attach: Option<DragAttach>,
    aggregate: Option<AggregateConnect>,
    selection: Vec<String>,
    overlay_count: Option<usize>,
}
impl SharedKey {
    pub(super) fn new(scene: &Scene, theme: &ThemeResource, scope_revision: u64) -> Self {
        let selected: HashSet<_> = scene.selection.nodes.iter().map(String::as_str).collect();
        let mut references = HashSet::new();
        if let Some(draft) = &scene.draft {
            references.insert(draft.source.as_str());
        }
        if let Some(attach) = &scene.drag_attach {
            references.insert(attach.node_id.as_str());
            references.extend(attach.contact_node_id.as_deref());
            for edge in &attach.pending_edges {
                references.insert(&edge.source);
                references.insert(&edge.target);
            }
        }
        if let Some(aggregate) = &scene.aggregate_connect {
            references.extend(selected.iter().copied());
            for edge in &aggregate.pending_edges {
                references.insert(&edge.source);
                references.insert(&edge.target);
            }
        }
        let references = scene
            .nodes
            .iter()
            .filter(|n| references.contains(n.id.as_str()))
            .map(|n| Reference {
                id: n.id.clone(),
                rect: [n.x, n.y, n.width, n.height],
                ports: [
                    super::layout::port(n, false).to_array(),
                    super::layout::port(n, true).to_array(),
                ],
            })
            .collect();
        Self {
            theme: theme.fingerprint().to_owned(),
            scope_revision,
            frame_zoom: scene
                .nodes
                .iter()
                .any(|node| matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }))
                .then_some(scene.viewport.zoom),
            frames: scene
                .nodes
                .iter()
                .filter(|node| matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }))
                .map(|node| (node.id.clone(), [node.x, node.y, node.width, node.height]))
                .collect(),
            frame_hover: scene
                .hover
                .as_ref()
                .and_then(|hover| hover.node_id.as_ref())
                .filter(|id| {
                    scene.nodes.iter().any(|node| {
                        &node.id == *id
                            && matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. })
                    })
                })
                .cloned(),
            frame_selection: scene
                .nodes
                .iter()
                .filter(|node| {
                    matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. })
                        && selected.contains(node.id.as_str())
                })
                .map(|node| node.id.clone())
                .collect(),
            references,
            draft: scene.draft.clone(),
            marquee: scene.marquee.clone(),
            attach: scene.drag_attach.clone(),
            aggregate: scene.aggregate_connect.clone(),
            selection: if scene.aggregate_connect.is_some() {
                scene.selection.nodes.clone()
            } else {
                Vec::new()
            },
            overlay_count: (scene.drag_attach.is_some() || scene.aggregate_connect.is_some())
                .then_some(scene.nodes.len()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moving_resizing_and_selecting_a_scope_invalidates_its_backing() {
        let theme = ThemeResource::default();
        let mut scene = Scene::default();
        scene.nodes.push(
            serde_json::from_value(serde_json::json!({
                "id":"g", "type":"workflow-group-2d", "x":0,"y":0,"width":200,"height":100,
                "chrome":{"kind":"frame","groupId":"g","memberNodeIds":[]}
            }))
            .unwrap(),
        );
        let before = SharedKey::new(&scene, &theme, 0);
        scene.nodes[0].x = 100.0;
        assert!(before != SharedKey::new(&scene, &theme, 0));
        let moved = SharedKey::new(&scene, &theme, 0);
        scene.nodes[0].width = 300.0;
        assert!(moved != SharedKey::new(&scene, &theme, 0));
        let resized = SharedKey::new(&scene, &theme, 0);
        scene.selection.nodes.push("g".into());
        assert!(resized != SharedKey::new(&scene, &theme, 0));
        let selected = SharedKey::new(&scene, &theme, 0);
        scene.viewport.zoom = 2.0;
        assert!(selected != SharedKey::new(&scene, &theme, 0));
    }
}
