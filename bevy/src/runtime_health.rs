//! Progress acknowledgments, never a claim that a GPU frame was presented.
use bevy::platform::time::Instant;
use bevy::{
    prelude::*,
    render::{Render, RenderApp, RenderSystems},
};
use std::cell::{Cell, RefCell};
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

thread_local! {
    static MEDIA_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static MODEL_READY: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    static SAMPLES: RefCell<crate::frame_samples::Samples> = RefCell::new(Default::default());
    static CLOCK: Instant = Instant::now();
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
                    DRAW_CALLS_3D
                        .with(|v| v.set(work.and_then(|work| work.draw_recording_calls())));
                    RENDERS.with(|v| v.set(v.get().wrapping_add(1)));
                    RENDERED.with(|v| v.set(APPLIED.with(Cell::get)));
                    SAMPLES.with(|samples| {
                        let mut samples = samples.borrow_mut();
                        if samples.enabled() {
                            let at_ms = CLOCK.with(|clock| clock.elapsed().as_secs_f64() * 1000.0);
                            samples.push(at_ms, RENDERED.with(Cell::get));
                        }
                    });
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
        DRAW_CALLS_3D
            .with(Cell::get)
            .map_or_else(|| "null".to_owned(), |v| v.to_string())
    )
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn seed_runtime_generation(previous: u32) {
    crate::canvas_query::interaction::seed_generation(previous);
}

/// Test-only explicit arming. None drains; Some toggles and resets the window.
/// Time origin is local to this runtime; never subtract from browser timestamps.
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn benchmark_frames(enabled: Option<bool>) -> String {
    SAMPLES.with(|samples| {
        let mut samples = samples.borrow_mut();
        if let Some(enabled) = enabled {
            samples.arm(enabled);
            MODEL_READY.with(|ready| ready.borrow_mut().clear());
        }
        let (rows, dropped) = samples.drain();
        let rows: Vec<_> = rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "atMs": row.at_ms, "generation": row.generation
                })
            })
            .collect();
        serde_json::json!({"version":1,"dropped":dropped,"frames":rows}).to_string()
    })
}

pub(crate) fn benchmark_enabled() -> bool {
    SAMPLES.with(|samples| samples.borrow().enabled()) || MEDIA_ACTIVE.with(Cell::get)
}
pub(crate) fn benchmark_models_ready(ids: Vec<String>) {
    MODEL_READY.with(|ready| *ready.borrow_mut() = ids);
}
#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn benchmark_media(enabled: Option<bool>) -> String {
    if let Some(enabled) = enabled {
        MEDIA_ACTIVE.with(|active| active.set(enabled));
        MODEL_READY.with(|ready| ready.borrow_mut().clear());
    }
    MODEL_READY.with(|ready| serde_json::json!({"readyModels": *ready.borrow()}).to_string())
}
