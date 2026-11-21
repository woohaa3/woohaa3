//! Frame-level identity of the accepted 2D document.
//!
//! `scene.is_changed()` is not a content signal: the camera snapshot system refills
//! `CurrentScene` from the camera every frame, so the resource is dirty on every frame even when
//! nothing the dynamic overlays derive from it changed. Overlays keyed on it therefore rebuilt
//! their full mesh on a still canvas.
//!
//! The stamp is a value digest of exactly what those overlays are allowed to read: node
//! identity/layout/presentation, the edge list, canvas-relative ordering (selection, hover, drag
//! attach, aggregate connect, marquee, draft), the viewport they are drawn against, the theme
//! fingerprint, and the node-action payloads. Their own keys are still rebuilt from
//! `CurrentScene`; this only decides whether the rebuild is needed at all.

use bevy::prelude::*;

use crate::app::CurrentScene;
use crate::protocol::Scene;

#[derive(Resource, Default)]
pub(crate) struct OverlayStamp {
    value: Option<u64>,
    body_digest: Option<u64>,
}

impl OverlayStamp {
    /// Stamp that never matches a fresh digest (test fixtures that bypass the refresh system).
    #[cfg(test)]
    pub(crate) fn never_matching() -> Self {
        Self {
            value: Some(u64::MAX),
            body_digest: None,
        }
    }

    pub(crate) fn get(&self) -> Option<u64> {
        self.value
    }
}

/// Refresh the stamp from the accepted scene. Reads `&CurrentScene` only, so it never dirties the
/// scene resource the overlays also read.
pub(crate) fn refresh(
    scene: Res<CurrentScene>,
    flags: Option<Res<crate::app::FrameFlags>>,
    mut stamp: ResMut<OverlayStamp>,
) {
    let body_unchanged = flags.as_ref().is_some_and(|flags| {
        !flags.scene_received
            && !flags.positions_received
            && !flags.theme_changed
            && !flags.surface_changed
            && !flags.observer_changed
    });
    let body = match stamp.body_digest.filter(|_| body_unchanged) {
        Some(cached) => cached,
        None => {
            let computed = digest_without_viewport(&scene.0);
            stamp.body_digest = Some(computed);
            computed
        }
    };
    stamp.value = Some(finish_with_viewport(body, &scene.0));
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

struct Digest(u64);

impl Digest {
    const fn new() -> Self {
        Self(FNV_OFFSET)
    }

    fn bytes(&mut self, bytes: &[u8]) -> &mut Self {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
        self
    }

    fn u32(&mut self, value: u32) -> &mut Self {
        self.bytes(&value.to_le_bytes())
    }

    fn bool(&mut self, value: bool) -> &mut Self {
        self.u32(u32::from(value))
    }

    /// `-0.0` and `0.0` paint identically, so they share one representation.
    fn f32(&mut self, value: f32) -> &mut Self {
        self.u32(if value == 0.0 { 0 } else { value.to_bits() })
    }

    fn f64(&mut self, value: f64) -> &mut Self {
        self.bytes(&(if value == 0.0 { 0 } else { value.to_bits() }).to_le_bytes())
    }

    fn str(&mut self, value: &str) -> &mut Self {
        self.u32(value.len() as u32);
        self.bytes(value.as_bytes())
    }

    fn opt_str(&mut self, value: Option<&str>) -> &mut Self {
        match value {
            Some(text) => self.bool(true).str(text),
            None => self.bool(false),
        }
    }
}

fn digest_history_dots(digest: &mut Digest, node: &crate::protocol::GraphNode) {
    match node.history_strip.as_ref() {
        Some(strip) => {
            digest
                .bool(true)
                .u32(strip.truncated)
                .u32(strip.dots.len() as u32);
            for dot in &strip.dots {
                digest
                    .opt_str(dot.presentation_id.as_deref())
                    .str(&dot.state)
                    .bool(dot.current)
                    .bool(dot.selected == Some(true))
                    .bool(dot.unseen)
                    .bool(dot.hovered)
                    .bool(dot.pressed);
            }
        }
        None => {
            digest.bool(false);
        }
    }
}

fn digest_world_camera(digest: &mut Digest, node: &crate::protocol::GraphNode) {
    match node.world_camera.as_ref() {
        Some(camera) => {
            digest
                .bool(true)
                .str(&camera.camera_id)
                .f64(camera.position.u)
                .f64(camera.position.v)
                .f64(camera.position.h);
            for rotation in camera.rotation {
                digest.f64(rotation);
            }
        }
        None => {
            digest.bool(false);
        }
    }
}

/// Digest of everything the dynamic overlays may derive from the accepted scene.
pub(crate) fn digest(scene: &Scene) -> u64 {
    finish_with_viewport(digest_without_viewport(scene), scene)
}

fn finish_with_viewport(body: u64, scene: &Scene) -> u64 {
    let mut digest = Digest(body);
    digest
        .f32(scene.viewport.x)
        .f32(scene.viewport.y)
        .f32(scene.viewport.zoom);
    digest.0
}

fn digest_without_viewport(scene: &Scene) -> u64 {
    let mut digest = Digest::new();
    digest
        .str(&scene.canvas_id)
        .u32(scene.revision)
        .bool(
            scene
                .edit_scope
                .as_ref()
                .is_none_or(|scope| scope.three_d == "edit"),
        )
        .str(&scene.theme.fingerprint)
        .u32(scene.nodes.len() as u32);
    for node in &scene.nodes {
        digest
            .str(&node.id)
            .str(&node.kind)
            .f32(node.x)
            .f32(node.y)
            .f32(node.width)
            .f32(node.height)
            .f32(node.progress)
            .f64(node.progress_started_at.unwrap_or(f64::NAN))
            .bool(node.busy)
            .bool(node.ghost)
            .bool(node.texture)
            .bool(node.media_loading);
        digest_history_dots(&mut digest, node);
        digest_world_camera(&mut digest, node);
    }
    digest.u32(scene.edges.len() as u32);
    for edge in &scene.edges {
        digest
            .str(&edge.id)
            .str(&edge.source)
            .str(&edge.target)
            .str(&edge.label);
    }
    digest.u32(scene.selection.nodes.len() as u32);
    for id in &scene.selection.nodes {
        digest.str(id);
    }
    digest.opt_str(scene.selection.edge.as_deref());
    match scene.hover.as_ref() {
        Some(hover) => {
            digest
                .bool(true)
                .opt_str(hover.node_id.as_deref())
                .opt_str(hover.port.as_deref())
                .opt_str(hover.edge_id.as_deref());
            match hover.cursor {
                Some(cursor) => {
                    digest.bool(true).f32(cursor.x).f32(cursor.y);
                }
                None => {
                    digest.bool(false);
                }
            }
        }
        None => {
            digest.bool(false);
        }
    }
    match scene.drag_attach.as_ref() {
        Some(attach) => {
            digest
                .bool(true)
                .str(&attach.node_id)
                .opt_str(attach.mode.as_deref())
                .opt_str(attach.contact_node_id.as_deref())
                .u32(attach.pending_edges.len() as u32);
            for edge in &attach.pending_edges {
                digest.str(&edge.id).str(&edge.source).str(&edge.target);
            }
        }
        None => {
            digest.bool(false);
        }
    }
    match scene.aggregate_connect.as_ref() {
        Some(connect) => {
            digest.bool(true).opt_str(connect.direction.as_deref());
            match connect.cursor {
                Some(cursor) => {
                    digest.bool(true).f32(cursor.x).f32(cursor.y);
                }
                None => {
                    digest.bool(false);
                }
            }
            digest.u32(connect.pending_edges.len() as u32);
            for edge in &connect.pending_edges {
                digest.str(&edge.id).str(&edge.source).str(&edge.target);
            }
        }
        None => {
            digest.bool(false);
        }
    }
    match scene.draft.as_ref() {
        Some(draft) => {
            digest
                .bool(true)
                .str(&draft.source)
                .str(&draft.side)
                // Pointer position in world space; every relevant bit counts.
                .u32(draft.x.to_bits())
                .u32(draft.y.to_bits());
        }
        None => {
            digest.bool(false);
        }
    }
    match scene.marquee.as_ref() {
        Some(marquee) => {
            digest
                .bool(true)
                // Marquee edges are drawn exactly; sub-pixel changes are visible.
                .u32(marquee.x.to_bits())
                .u32(marquee.y.to_bits())
                .u32(marquee.width.to_bits())
                .u32(marquee.height.to_bits());
        }
        None => {
            digest.bool(false);
        }
    }
    // The focused-media camera view changes what every overlay is projected against, so its
    // numbers belong to the stamp as well.
    if let Some((x, y, zoom)) = crate::canvas_query::media_focus::camera_view(scene) {
        digest
            .bool(true)
            .u32(x.to_bits())
            .u32(y.to_bits())
            .u32(zoom.to_bits());
    } else {
        digest.bool(false);
    }
    digest
        .bool(scene.model_focus.is_some())
        .bool(scene.image_focus.is_some())
        .bool(scene.video_focus.is_some())
        .bool(scene.model_editor.is_some());
    // Node-action bars are keyed by node id; iteration order is irrelevant to the drawing.
    let mut actions: Vec<(&String, &crate::protocol::NodeActions)> =
        scene.node_actions.iter().collect();
    actions.sort_by(|a, b| a.0.cmp(b.0));
    digest.u32(actions.len() as u32);
    for (id, node_actions) in actions {
        digest
            .str(id)
            .opt_str(node_actions.summary.as_deref())
            .u32(node_actions.actions.len() as u32);
        for action in &node_actions.actions {
            digest
                .str(&action.id)
                .str(&action.label)
                .str(&action.tone)
                .bool(action.enabled)
                .bool(action.menu)
                .bool(action.icon_only)
                .opt_str(action.icon.as_deref());
        }
    }
    digest.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Viewport;

    fn scene() -> Scene {
        Scene {
            canvas_id: "canvas-a".into(),
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"a","type":"text","x":0,"y":0,"width":240,"height":180,"title":"A","body":""},
                {"id":"b","type":"text","x":300,"y":0,"width":240,"height":180,"title":"B","body":""}
            ]))
            .unwrap(),
            viewport: Viewport { x: 10.0, y: 20.0, zoom: 1.0 },
            revision: 3,
            ..Default::default()
        }
    }

    #[test]
    fn identical_payload_keeps_one_digest() {
        assert_eq!(digest(&scene()), digest(&scene()));
    }

    #[test]
    fn camera_rewrites_do_not_change_the_digest() {
        let base = scene();
        let mut rewritten = scene();
        // The camera snapshot rewrites the viewport every frame; the same value keeps the stamp.
        rewritten.viewport = Viewport {
            x: 10.0,
            y: 20.0,
            zoom: 1.0,
        };
        assert_eq!(digest(&base), digest(&rewritten));
    }

    #[test]
    fn overlay_inputs_change_the_digest() {
        let base = scene();
        let mut moved = scene();
        moved.nodes[1].x += 1.0;
        assert_ne!(digest(&base), digest(&moved));
        let mut panned = scene();
        panned.viewport.x += 4.0;
        assert_ne!(digest(&base), digest(&panned));
        let mut hovered = scene();
        hovered.hover = Some(serde_json::from_value(serde_json::json!({ "nodeId": "a" })).unwrap());
        assert_ne!(digest(&base), digest(&hovered));
        let mut selected = scene();
        selected.selection.nodes = vec!["a".into()];
        assert_ne!(digest(&base), digest(&selected));
    }
}
