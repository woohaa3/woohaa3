use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use bevy::{app::AppExit, prelude::*, render::{RenderApp, Render, RenderSystems, render_resource::PipelineCache,
    gpu_readback::{Readback, ReadbackComplete}}};

#[derive(Resource, Clone)]
struct CaptureReady(Arc<AtomicBool>);

#[derive(Component)]
struct PendingReadback {
    image: Handle<Image>,
    pixels: Arc<Mutex<Option<Vec<u8>>>>,
    ready: Arc<AtomicBool>,
}

pub(super) fn enqueue_readback(commands: &mut Commands, image: Handle<Image>,
    pixels: Arc<Mutex<Option<Vec<u8>>>>, ready: Arc<AtomicBool>) {
    commands.spawn(PendingReadback { image, pixels, ready });
}

fn admit_readback(mut commands: Commands, pending: Query<(Entity, &PendingReadback)>) {
    for (entity, request) in &pending {
        if !request.ready.load(Ordering::Acquire) { continue; }
        // Starting continuous readback at Startup can leave old blank frames in
        // flight. Callback-time readiness cannot identify which frame was copied.
        // Admit the copy only after high geometry/material preparation settles.
        let pixels = request.pixels.clone();
        commands.entity(entity).remove::<PendingReadback>()
            .insert(Readback::texture(request.image.clone()))
            .observe(move |trigger: On<ReadbackComplete>, mut commands: Commands, mut exit: MessageWriter<AppExit>| {
                *pixels.lock().expect("pixels lock") = Some(trigger.data.clone());
                exit.write(AppExit::Success);
                commands.entity(trigger.entity).despawn();
            });
    }
}

/// Readback starts before material pipelines finish compiling. Only accept pixels
/// after the render world has completed several prepared frames, with no shaders pending.
pub(super) fn install(app: &mut App) -> Arc<AtomicBool> {
    let ready = Arc::new(AtomicBool::new(false));
    app.add_systems(Update, admit_readback);
    if let Some(render_app) = app.get_sub_app_mut(RenderApp) {
        render_app.insert_resource(CaptureReady(ready.clone()));
        render_app.add_systems(Render, observe.in_set(RenderSystems::Prepare));
    }
    ready
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_gpu_copy_is_queued_before_high_preparation_is_ready() {
        let mut app = App::new();
        app.add_message::<AppExit>().add_systems(Update, admit_readback);
        let ready = Arc::new(AtomicBool::new(false));
        let entity = app.world_mut().spawn(PendingReadback { image: Handle::default(),
            pixels: Arc::new(Mutex::new(None)), ready: ready.clone() }).id();
        app.update();
        assert!(app.world().entity(entity).contains::<PendingReadback>());
        assert!(!app.world().entity(entity).contains::<Readback>());
        ready.store(true, Ordering::Release);
        app.update();
        assert!(!app.world().entity(entity).contains::<PendingReadback>());
        assert!(app.world().entity(entity).contains::<Readback>());
    }
}
fn observe(cache: Res<PipelineCache>, ready: Res<CaptureReady>, mut frames: Local<u32>, mut stable: Local<u8>) {
    *frames += 1;
    if *frames >= 8 && cache.waiting_pipelines().next().is_none() { *stable = stable.saturating_add(1); }
    else { *stable = 0; }
    ready.0.store(*stable >= 3, Ordering::Release);
}
