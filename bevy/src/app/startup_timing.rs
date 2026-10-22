//! 开播后有界的主世界帧耗时；不包含后续 render sub-app 或 GPU 执行。
use bevy::{platform::time::Instant, prelude::*};

#[derive(Resource, Default)]
pub(super) struct StartupTiming {
    started: Option<Instant>,
    previous: Option<Instant>,
    gap_ms: Option<f64>,
}
pub(super) fn begin(mut timing: ResMut<StartupTiming>) {
    let now = Instant::now();
    timing.gap_ms = timing.previous.map(|last| now.duration_since(last).as_secs_f64() * 1000.0);
    timing.previous = Some(now);
    timing.started = Some(now);
}
pub(super) fn end(timing: Res<StartupTiming>, work: Res<crate::model_preview::render_work::RenderWork>) {
    if let Some(start) = timing.started {
        work.startup_main(start.elapsed().as_secs_f64()*1000.0, timing.gap_ms);
    }
}
