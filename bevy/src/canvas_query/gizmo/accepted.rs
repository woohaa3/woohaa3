//! Instance-local accepted editor/view. Queries cannot invent a hidden or stale target.
use crate::{
    gizmo_layout::GizmoView,
    protocol::{ModelEditor, ObserverUpdateRequest, Scene},
};
use bevy::prelude::*;
use std::cell::RefCell;
#[derive(Clone)]
pub(super) struct Accepted {
    pub editor: ModelEditor,
    pub view: GizmoView,
}
thread_local! {static ACCEPTED:RefCell<Option<Accepted>>=const {RefCell::new(None)};}
pub(crate) fn accept_gizmo_scene(scene: &Scene) {
    let accepted = (|| {
        let editor = scene.model_editor.as_ref()?;
        let focus = scene.model_focus.as_ref()?;
        let node = scene.nodes.iter().find(|node| node.id == editor.node_id)?;
        let composite = node.composite_asset.as_ref()?;
        if editor.tool_mode == "object"
            && !editor.item_id.as_ref().is_some_and(|id| {
                composite.item_roots.contains_key(id)
                    || composite.media_planes.iter().any(|plane| &plane.item_id == id)
            })
        {
            return None;
        }
        if editor.node_id != focus.node_id
            || editor.tool_mode == "model"
            || scene
                .animation_playback
                .as_ref()
                .is_some_and(|p| p.view_mode == "focus-preview")
        {
            return None;
        }
        let view = gizmo_view(scene)?;
        Some(Accepted {
            editor: editor.clone(),
            view,
        })
    })();
    ACCEPTED.with(|slot| *slot.borrow_mut() = accepted);
}
pub(crate) fn accept_gizmo_observer(request: &ObserverUpdateRequest) {
    ACCEPTED.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(accepted) = slot.as_mut()
            && accepted.editor.node_id == request.node_id
        {
            let old = accepted.view;
            match GizmoView::orbit(
                Vec3::from_array(request.target),
                request.yaw,
                request.pitch,
                request.distance,
                old.size,
                old.fov,
            ) {
                Some(view) => accepted.view = view,
                None => *slot = None,
            }
        }
    });
}
pub(super) fn current() -> Option<Accepted> {
    ACCEPTED.with(|slot| slot.borrow().clone())
}
pub(super) fn layout_id(editor: &ModelEditor, view: &GizmoView) -> String {
    let identity = format!(
        "{}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{:?}",
        editor.node_id,
        editor.item_id,
        editor.camera_id,
        editor.tool_mode,
        editor.object_tool,
        editor.camera_tool,
        editor.focus,
        editor.parent_basis,
        editor.shot,
        view
    );
    let hash = identity.bytes().fold(0xcbf29ce484222325u64, |hash, b| {
        (hash ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}

pub(crate) fn gizmo_view(scene: &crate::protocol::Scene) -> Option<crate::gizmo_layout::GizmoView> {
    let focus = scene.model_focus.as_ref()?;
    let size = scene.surface.as_ref()?;
    crate::gizmo_layout::GizmoView::orbit(
        Vec3::from_array(focus.target),
        focus.yaw,
        focus.pitch,
        focus.distance,
        Vec2::new(size.width, size.height),
        focus.fov,
    )
}
