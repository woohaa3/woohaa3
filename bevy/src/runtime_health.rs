//! Progress acknowledgments, never a claim that a GPU frame was presented.
use bevy::{
    prelude::*,
    render::{Render, RenderApp, RenderSystems},
};
use std::cell::Cell;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

thread_local! {
    static UPDATES: Cell<u32> = const { Cell::new(0) };
    static APPLIED: Cell<u32> = const { Cell::new(0) };
    static RENDERED: Cell<u32> = const { Cell::new(0) };
    static RENDERS: Cell<u32> = const { Cell::new(0) };
    static DRAW_CALLS_3D: Cell<Option<u64>> = const { Cell::new(None) };
}

pub(crate) struct RuntimeHealthPlugin;
impl Plugin for RuntimeHealthPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Last, || UPDATES.with(|v| v.set(v.get().wrapping_add(1))));
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render.add_systems(
                Render,
                (|work: Option<Res<crate::model_preview::render_work::RenderWork>>| {
                    DRAW_CALLS_3D.with(|v| v.set(work.and_then(|work| work.draw_recording_calls())));
                    RENDERS.with(|v| v.set(v.get().wrapping_add(1)));
                    RENDERED.with(|v| v.set(APPLIED.with(Cell::get)));
                })
                .in_set(RenderSystems::PostCleanup),
            );
        }
    }
}

pub(crate) fn mark_applied(generation: u32) {
    APPLIED.with(|v| v.set(generation));
}

#[cfg(feature = "native-canvas")]
pub(crate) fn has_rendered_scene() -> bool {
    // This is a render schedule acknowledgment, not a GPU presentation fence.
    RENDERED.with(|generation| generation.get() != 0)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn runtime_health() -> String {
    format!(
        "{{\"updates\":{},\"renders\":{},\"appliedRevision\":{},\"appliedGeneration\":{},\"renderedGeneration\":{},\"drawCalls3d\":{},\"version\":\"woohaa-runtime-health-v1\"}}",
        UPDATES.with(Cell::get),
        RENDERS.with(Cell::get),
        crate::bridge::revision(),
        APPLIED.with(Cell::get),
        RENDERED.with(Cell::get),
        DRAW_CALLS_3D.with(Cell::get).map_or_else(|| "null".to_owned(), |v| v.to_string())
    )
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn seed_runtime_generation(previous: u32) {
    crate::canvas_query::interaction::seed_generation(previous);
}
