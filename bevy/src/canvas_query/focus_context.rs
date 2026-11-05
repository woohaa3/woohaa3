//! Read-only workspace projection. Does not change canonical model/capture geometry.
use crate::protocol::{GraphNode, Scene};
use std::borrow::Cow;

pub(crate) fn contains(scene: &Scene, id: &str) -> bool {
    scene.model_focus.is_some()
        && scene
            .model_focus_context
            .iter()
            .any(|entry| entry.node_id == id)
}
pub(crate) fn index(scene: &Scene, id: &str, fallback: usize) -> usize {
    if scene.model_focus.is_some() {
        scene
            .model_focus_context
            .iter()
            .position(|e| e.node_id == id)
            .unwrap_or(fallback)
    } else {
        fallback
    }
}
pub(crate) fn node<'a>(scene: &Scene, original: &'a GraphNode) -> Cow<'a, GraphNode> {
    let Some(entry) = scene.model_focus.as_ref().and_then(|_| {
        scene
            .model_focus_context
            .iter()
            .find(|e| e.node_id == original.id)
    }) else {
        return Cow::Borrowed(original);
    };
    let mut node = original.clone();
    node.x = entry.x;
    node.y = entry.y;
    node.width = entry.width;
    node.height = entry.height;
    // This internal drawing kind is derived, never a wire or document node type.
    node.kind = "focus-reference-readonly".into();
    node.card_label = Some(original.kind.clone());
    node.ghost = true;
    node.resizable = false;
    node.history_strip = None;
    node.model = None;
    node.model_preview = None;
    node.texture = false;
    node.busy = false;
    node.media_loading = false;
    node.body.clear();
    node.type_label.clear();
    Cow::Owned(node)
}
pub(crate) fn overlay(scene: &Scene) -> Cow<'_, Scene> {
    if scene.model_focus.is_none() {
        return Cow::Borrowed(scene);
    }
    let mut overlay = Scene::default();
    // 聚焦投影仍是同一份文档快照：身份与代数必须保留，否则投影的「同文档代数单调」
    // 保护会把聚焦帧判成倒退（revision 归零）。
    overlay.canvas_id = scene.canvas_id.clone();
    overlay.revision = scene.revision;
    overlay.theme = scene.theme.clone();
    overlay.surface = scene.surface.clone();
    overlay.viewport.zoom = 1.;
    overlay.nodes = scene
        .model_focus_context
        .iter()
        .filter_map(|entry| scene.nodes.iter().find(|node| node.id == entry.node_id))
        .map(|n| node(scene, n).into_owned())
        .collect();
    Cow::Owned(overlay)
}
pub(crate) fn viewport(scene: &Scene) -> [f32; 3] {
    if scene.model_focus.is_some() {
        [0., 0., 1.]
    } else {
        [scene.viewport.x, scene.viewport.y, scene.viewport.zoom]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scene() -> Scene {
        let theme = Scene::default().theme;
        serde_json::from_value(serde_json::json!({
            "version": crate::protocol::CANVAS_RENDER_SCENE_VERSION,
            "theme": { "id": theme.id, "version": theme.version, "fingerprint": theme.fingerprint, "tokens": theme.tokens },
            "nodes": [
                {"id":"owner","type":"model","x":500,"y":500},
                {"id":"container","type":"model","x":1000,"y":1000,"width":248,"height":232,"title":"Object"},
                {"id":"card","type":"model","x":1012,"y":1012,"width":224,"height":208,"resizable":true},
                {"id":"unrelated","type":"image","x":0,"y":0}
            ], "edges":[], "viewport":{"x":123,"y":456,"zoom":3},
            "selection":{"nodes":["card"]}, "hover":{"nodeId":"card","port":"input"},
            "modelFocus":{"version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87},
            "modelFocusContext":[
                {"nodeId":"container","x":20,"y":20,"width":124,"height":116},
                {"nodeId":"card","x":26,"y":26,"width":112,"height":104}
            ]
        })).unwrap()
    }
    #[test]
    fn focus_context_is_scoped_read_only_and_does_not_move_model_geometry() {
        let source = scene();
        source.validate().unwrap();
        let overlay = overlay(&source);
        assert_eq!(
            overlay
                .nodes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["container", "card"]
        );
        assert_eq!(source.nodes[2].x, 1012.);
        assert_eq!(overlay.nodes[1].x, 26.);
        assert_eq!(overlay.nodes[0].x, 20.);
        assert!(
            overlay
                .nodes
                .iter()
                .all(|n| n.ghost && !n.resizable && n.history_strip.is_none())
        );
        assert!(
            overlay.selection.nodes.is_empty()
                && overlay.hover.is_none()
                && overlay.node_actions.is_empty()
        );
        assert_eq!(viewport(&source), [0., 0., 1.]);
        assert_eq!(overlay.viewport.zoom, 1.);
        assert_eq!(overlay.nodes[0].title, "Object");
        assert!(
            overlay
                .nodes
                .iter()
                .all(|n| n.model.is_none() && n.model_preview.is_none() && !n.texture)
        );
    }
    #[test]
    fn focus_context_hide_and_exit_clear_references_and_restore_overview() {
        let mut source = scene();
        source.model_focus_context.clear();
        assert!(overlay(&source).nodes.is_empty());
        assert!(!contains(&source, "card"));
        source.model_focus = None;
        assert_eq!(overlay(&source).nodes.len(), 4);
        assert_eq!(viewport(&source), [123., 456., 3.]);
    }
    #[test]
    fn focus_context_rejects_dangling_duplicate_owner_and_invalid_rectangles() {
        for entry in [
            serde_json::json!({"nodeId":"missing","x":0,"y":0,"width":10,"height":10}),
            serde_json::json!({"nodeId":"owner","x":0,"y":0,"width":10,"height":10}),
            serde_json::json!({"nodeId":"card","x":0,"y":0,"width":0,"height":10}),
            serde_json::json!({"nodeId":"card","x":0,"y":0,"width":10,"height":10}),
        ] {
            let mut source = scene();
            source
                .model_focus_context
                .push(serde_json::from_value(entry).unwrap());
            assert!(source.validate().is_err());
        }
    }
}
