//! Exact draw-only invalidation for the retained shared group/overlay buffers.
//! No model/media/vertex payloads, viewport or unrelated ordinary-card content is copied.
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
    composite: bool,
}
#[derive(PartialEq)]
pub(super) struct SharedKey {
    pub(super) focus_ownership_links: bool,
    pub(super) ownership_links: Vec<([f32; 2], [f32; 2])>,
    theme: String,
    references: Vec<Reference>,
    draft: Option<Draft>,
    marquee: Option<Marquee>,
    attach: Option<DragAttach>,
    aggregate: Option<AggregateConnect>,
    selection: Vec<String>,
    overlay_count: Option<usize>,
    /// 拍摄镜头归属线（change: 2026-10-15-add-film-set-shooting-shot-previews，design D5）：
    /// 派生呈现，起点随相机姿态变更。参与 key 使线随起点/目标增量重绘。
    shot_preview_links: Vec<crate::protocol::ShotPreviewLink>,
}
impl SharedKey {
    pub(super) fn new(scene: &Scene, theme: &ThemeResource) -> Self {
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
                composite: n.composite_asset.is_some(),
            })
            .collect();
        Self {
            focus_ownership_links: false,
            ownership_links: Vec::new(),
            theme: theme.fingerprint().to_owned(),
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
            shot_preview_links: scene.shot_preview_links.clone(),
        }
    }
}
