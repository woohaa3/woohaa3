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
    static SUSPENDED: Cell<bool> = const { Cell::new(false) };
    static UPDATES: Cell<u32> = const { Cell::new(0) };
    static APPLIED: Cell<u32> = const { Cell::new(0) };
    static RENDERED: Cell<u32> = const { Cell::new(0) };
    static RENDERS: Cell<u32> = const { Cell::new(0) };
    static DRAW_CALLS_3D: Cell<Option<u64>> = const { Cell::new(None) };
}

pub(crate) struct RuntimeHealthPlugin;
impl Plugin for RuntimeHealthPlugin {
    fn build(&self, app: &mut App) {
        // Health is read through main-thread RPC and stored in thread-local cells.
        // An exclusive system keeps these writes on that same thread.
        app.add_systems(Last, |world: &mut World| {
            SUSPENDED.with(|v| {
                v.set(world
                    .get_resource::<crate::canvas_activity::CanvasWorkSuspended>()
                    .is_some_and(|state| state.0));
            });
            UPDATES.with(|v| v.set(v.get().wrapping_add(1)));
        });
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render.add_systems(
                Render,
                (|work: Option<Res<crate::render_work::RenderWork>>| {
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
        "{{\"updates\":{},\"renders\":{},\"appliedRevision\":{},\"appliedGeneration\":{},\"renderedGeneration\":{},\"drawCalls3d\":{},\"suspended\":{},\"version\":\"woohaa-runtime-health-v1\"}}",
        UPDATES.with(Cell::get),
        RENDERS.with(Cell::get),
        crate::bridge::revision(),
        APPLIED.with(Cell::get),
        RENDERED.with(Cell::get),
        DRAW_CALLS_3D
            .with(Cell::get)
            .map_or_else(|| "null".to_owned(), |v| v.to_string()),
        SUSPENDED.with(Cell::get)
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

#[cfg(test)]
mod suspension_tests {
    use super::*;

    #[test]
    fn health_reports_intentional_suspension_without_acknowledging_pending_scene() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, RuntimeHealthPlugin));
        app.init_resource::<crate::canvas_activity::CanvasWorkSuspended>();
        app.update();
        let before: serde_json::Value = serde_json::from_str(&runtime_health()).unwrap();
        assert_eq!(before["suspended"], false);
        app.world_mut().resource_mut::<crate::canvas_activity::CanvasWorkSuspended>().0 = true;
        app.update();
        let paused: serde_json::Value = serde_json::from_str(&runtime_health()).unwrap();
        assert_eq!(paused["suspended"], true);
        assert_eq!(paused["appliedGeneration"], before["appliedGeneration"]);
        assert_eq!(paused["renderedGeneration"], before["renderedGeneration"]);
        app.world_mut().resource_mut::<crate::canvas_activity::CanvasWorkSuspended>().0 = false;
        app.update();
        let resumed: serde_json::Value = serde_json::from_str(&runtime_health()).unwrap();
        assert_eq!(resumed["suspended"], false);
    }
}
