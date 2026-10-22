//! Wall-clock execution spans around Bevy Queue/Prepare/Render, across all views.
//! Render includes pipeline-queue processing and render graph/driver CPU calls,
//! including waits incurred inside that stage; it does not isolate GPU execution.
//! This is not GPU time, per-preview cost, or a sum of individual system CPU times.
use bevy::{
    platform::time::Instant,
    prelude::*,
    render::{Render, RenderSystems},
    ecs::schedule::ScheduleLabel,
};
use std::sync::{Arc, Mutex};

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    #[serde(skip)]
    startup: crate::startup_trace::Trace,
    #[serde(skip)]
    pending: Pending,
    queue_frames: u64,
    queue_ms: f64,
    queue_max_ms: f64,
    prepare_frames: u64,
    prepare_ms: f64,
    prepare_max_ms: f64,
    render_frames: u64,
    render_ms: f64,
    render_max_ms: f64,
}
#[derive(Resource, Clone, Default)]
pub(crate) struct RenderWork(Arc<Mutex<Stats>>, super::render_draw_work::DrawWork,
    #[cfg(feature = "explicit-instancing")] crate::model3d::instancing::InstanceWork);
#[derive(Clone, Default)]
struct Pending {
    model_ms: f64,
    main_ms: Option<f64>,
    main_gap_ms: Option<f64>,
    main_finished: Option<Instant>,
    main_begin_ms: Option<f64>,
    main_end_ms: Option<f64>,
    extract_begin_ms: Option<f64>,
    extract_end_ms: Option<f64>,
    main_to_extract_ms: Option<f64>,
    extract_ms: Option<f64>,
    extract_finished: Option<Instant>,
}
const STAGE_NAMES: [&str; 12] = ["extractCommandsMs", "prepareAssetsMs", "prepareMeshesMs",
    "createViewsMs", "specializeMs", "prepareViewsMs", "queueMs", "phaseSortMs",
    "prepareMs", "renderWallMs", "cleanupMs", "postCleanupMs"];
#[derive(Resource, Default)]
struct Clock {
    queue: Option<Instant>,
    prepare: Option<Instant>,
    render: Option<Instant>,
    starts: [Option<Instant>; 12],
    stage_ms: [Option<f64>; 12],
}
fn now_ms() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
fn emit(report: Option<serde_json::Value>) {
    if let Some(report) = report {
        for part in crate::startup_trace::parts(report) {
            bevy::log::info!("[shot-startup] rust-batch {}", part);
        }
    }
}
impl RenderWork {
    pub(crate) fn draw_recording_calls(&self) -> Option<u64> {
        self.1.recording_calls()
    }

    pub(crate) fn startup_models(&self, playback: Option<&crate::protocol::AnimationPlayback>, cpu_ms: f64) {
        let mut stats = self.0.lock().unwrap();
        let key = playback.filter(|p| p.playing).map(|p| (p.node_id.clone(), p.clip_id.clone(), p.generation));
        let report = stats.startup.arm(key, now_ms());
        stats.pending.model_ms = cpu_ms;
        drop(stats);
        emit(report);
    }
    pub(crate) fn startup_main(&self, cpu_ms: f64, gap_ms: Option<f64>) {
        let mut stats = self.0.lock().unwrap();
        stats.pending.main_ms = Some(cpu_ms);
        stats.pending.main_gap_ms = gap_ms;
        stats.pending.main_finished = Some(Instant::now());
        let end_ms = now_ms();
        stats.pending.main_begin_ms = Some(end_ms - cpu_ms);
        stats.pending.main_end_ms = Some(end_ms);
    }
    fn finish_frame(&self, total_ms: f64, post_extract_ms: Option<f64>, stages: [Option<f64>;12]) {
        let render_end_ms = now_ms();
        let mut stats = self.0.lock().unwrap();
        if !stats.startup.collecting() { return; }
        let p = &stats.pending;
        let mut row = serde_json::json!({"mainWorldMs":p.main_ms,"frameGapMs":p.main_gap_ms,
            "mainBeginMs":p.main_begin_ms,"mainEndMs":p.main_end_ms,
            "extractBeginMs":p.extract_begin_ms,"extractEndMs":p.extract_end_ms,
            "renderBeginMs":render_end_ms-total_ms,"renderEndMs":render_end_ms,
            "clock":"rust-local-monotonic-ms","scope":"all-render-views",
            "modelMs":p.model_ms,"mainToExtractMs":p.main_to_extract_ms,"extractMs":p.extract_ms,
            "extractToRenderMs":post_extract_ms,"renderUpdateMs":total_ms,
            "renderUnattributedMs":(total_ms-stages.iter().flatten().sum::<f64>()).max(0.0)});
        for (name, ms) in STAGE_NAMES.iter().zip(stages) { row[*name] = serde_json::json!(ms); }
        let report = stats.startup.push(now_ms(), row);
        drop(stats);
        emit(report);
    }

    pub fn snapshot(&self) -> String {
        let stats = self.0.lock().unwrap();
        let value = serde_json::json!({"scope":"all-render-views", "clock":"stage-wall-elapsed",
            "work": &*stats, "draws": self.1.snapshot(),
            "gpuTime":"unavailable", "perPreviewPrepare":"unavailable"});
        #[cfg(feature = "explicit-instancing")]
        let value = { let mut value = value; value["explicitInstances"] = self.2.snapshot(); value };
        value.to_string()
    }
    #[cfg(feature = "explicit-instancing")]
    pub(super) fn with_instances(mut self, work: crate::model3d::instancing::InstanceWork) -> Self {
        self.2 = work;
        self
    }
}
pub(super) fn install(render: &mut SubApp, work: RenderWork) {
    super::render_draw_work::install(render, work.1.clone());
    if let Some(mut extract) = render.take_extract() {
        let shared = work.clone();
        render.set_extract(move |main, world| {
            let started = Instant::now();
            let extract_begin_ms = now_ms();
            let gap = shared.0.lock().unwrap().pending.main_finished.map(|end| end.elapsed().as_secs_f64()*1000.0);
            extract(main, world);
            let ms = started.elapsed().as_secs_f64()*1000.0;
            let mut stats = shared.0.lock().unwrap();
            stats.pending.main_to_extract_ms = gap;
            stats.pending.extract_ms = Some(ms);
            stats.pending.extract_begin_ms = Some(extract_begin_ms);
            stats.pending.extract_end_ms = Some(extract_begin_ms + ms);
            stats.pending.extract_finished = Some(Instant::now());
        });
    }
    if let Some(original) = render.update_schedule {
        let shared = work.clone();
        render.add_systems(StartupRenderUpdate, move |world: &mut World| {
            world.resource_mut::<Clock>().stage_ms = [None;12];
            let gap = shared.0.lock().unwrap().pending.extract_finished.map(|end| end.elapsed().as_secs_f64()*1000.0);
            let started = Instant::now();
            world.run_schedule(original);
            shared.finish_frame(started.elapsed().as_secs_f64()*1000.0, gap, world.resource::<Clock>().stage_ms);
        });
        render.update_schedule = Some(StartupRenderUpdate.intern());
    }
    let sets = [RenderSystems::ExtractCommands, RenderSystems::PrepareAssets, RenderSystems::PrepareMeshes,
        RenderSystems::CreateViews, RenderSystems::Specialize, RenderSystems::PrepareViews,
        RenderSystems::Queue, RenderSystems::PhaseSort, RenderSystems::Prepare, RenderSystems::Render,
        RenderSystems::Cleanup, RenderSystems::PostCleanup];
    render.add_systems(Render, (begin_stage::<0>.before_weak(sets[0].clone()), end_stage::<0>.after_weak(sets[0].clone()).before_weak(sets[1].clone())));
    render.add_systems(Render, (begin_stage::<1>.before_weak(sets[1].clone()).after_weak(sets[0].clone()), end_stage::<1>.after_weak(sets[1].clone()).before_weak(sets[2].clone())));
    render.add_systems(Render, (begin_stage::<2>.before_weak(sets[2].clone()).after_weak(sets[1].clone()), end_stage::<2>.after_weak(sets[2].clone()).before_weak(sets[3].clone())));
    render.add_systems(Render, (begin_stage::<3>.before_weak(sets[3].clone()).after_weak(sets[2].clone()), end_stage::<3>.after_weak(sets[3].clone()).before_weak(sets[4].clone())));
    render.add_systems(Render, (begin_stage::<4>.before_weak(sets[4].clone()).after_weak(sets[3].clone()), end_stage::<4>.after_weak(sets[4].clone()).before_weak(sets[5].clone())));
    render.add_systems(Render, (begin_stage::<5>.before_weak(sets[5].clone()).after_weak(sets[4].clone()), end_stage::<5>.after_weak(sets[5].clone()).before_weak(sets[6].clone())));
    render.add_systems(Render, (begin_stage::<7>.before_weak(sets[7].clone()).after_weak(sets[6].clone()), end_stage::<7>.after_weak(sets[7].clone()).before_weak(sets[8].clone())));
    render.add_systems(Render, (begin_stage::<10>.before_weak(sets[10].clone()).after_weak(sets[9].clone()), end_stage::<10>.after_weak(sets[10].clone()).before_weak(sets[11].clone())));
    render.add_systems(Render, (begin_stage::<11>.before_weak(sets[11].clone()).after_weak(sets[10].clone()), end_stage::<11>.after_weak(sets[11].clone())));
    render
        .insert_resource(work)
        .init_resource::<Clock>()
        .add_systems(
            Render,
            (
                begin_queue
                    .after(RenderSystems::PrepareViews)
                    .before(RenderSystems::Queue),
                end_queue
                    .after(RenderSystems::Queue)
                    .before(RenderSystems::PhaseSort),
                begin_prepare
                    .after(RenderSystems::PhaseSort)
                    .before(RenderSystems::Prepare),
                end_prepare
                    .after(RenderSystems::Prepare)
                    .before(RenderSystems::Render),
                begin_render.after(end_prepare).before(RenderSystems::Render),
                end_render.after(RenderSystems::Render).before(RenderSystems::Cleanup),
            ),
        );
}
#[derive(ScheduleLabel, Clone, Debug, PartialEq, Eq, Hash)]
struct StartupRenderUpdate;
fn begin_stage<const N: usize>(mut clock: ResMut<Clock>) { clock.starts[N] = Some(Instant::now()); }
fn end_stage<const N: usize>(mut clock: ResMut<Clock>) {
    if let Some(start) = clock.starts[N].take() { clock.stage_ms[N] = Some(start.elapsed().as_secs_f64()*1000.0); }
}
fn begin_queue(mut clock: ResMut<Clock>) {
    clock.queue = Some(Instant::now());
}
fn begin_prepare(mut clock: ResMut<Clock>) {
    clock.prepare = Some(Instant::now());
}
fn end_queue(mut clock: ResMut<Clock>, work: Res<RenderWork>) {
    if let Some(start) = clock.queue.take() {
        let ms = start.elapsed().as_secs_f64() * 1000.;
        let mut stats = work.0.lock().unwrap();
        clock.stage_ms[6] = Some(ms);
        stats.queue_frames += 1;
        stats.queue_ms += ms;
        stats.queue_max_ms = stats.queue_max_ms.max(ms);
    }
}
fn end_prepare(mut clock: ResMut<Clock>, work: Res<RenderWork>) {
    if let Some(start) = clock.prepare.take() {
        let ms = start.elapsed().as_secs_f64() * 1000.;
        let mut stats = work.0.lock().unwrap();
        clock.stage_ms[8] = Some(ms);
        stats.prepare_frames += 1;
        stats.prepare_ms += ms;
        stats.prepare_max_ms = stats.prepare_max_ms.max(ms);
    }
}

fn begin_render(mut clock: ResMut<Clock>) {
    clock.render = Some(Instant::now());
}
fn end_render(mut clock: ResMut<Clock>, work: Res<RenderWork>) {
    if let Some(start) = clock.render.take() {
        let ms = start.elapsed().as_secs_f64() * 1000.;
        let mut stats = work.0.lock().unwrap();
        clock.stage_ms[9] = Some(ms);
        stats.render_frames += 1;
        stats.render_ms += ms;
        stats.render_max_ms = stats.render_max_ms.max(ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn brackets_actual_stage_execution_and_counts_each_pass_once() {
        let mut render = SubApp::new();
        let work = RenderWork::default();
        install(&mut render, work.clone());
        render.configure_sets(
            Render,
            (
                RenderSystems::PrepareViews,
                RenderSystems::Queue,
                RenderSystems::PhaseSort,
                RenderSystems::Prepare,
                RenderSystems::Render,
                RenderSystems::Cleanup,
            )
                .chain(),
        );
        render.add_systems(
            Render,
            (
                (|clock: Res<Clock>| assert!(clock.queue.is_some())).in_set(RenderSystems::Queue),
                (|clock: Res<Clock>| assert!(clock.prepare.is_some()))
                    .in_set(RenderSystems::Prepare),
                (|clock: Res<Clock>| {
                    assert!(clock.prepare.is_none());
                    assert!(clock.render.is_some());
                    let started = Instant::now();
                    while started.elapsed().as_secs_f64() < 0.002 {
                        std::hint::spin_loop();
                    }
                }).in_set(RenderSystems::Render),
                (|clock: Res<Clock>| assert!(clock.render.is_none()))
                    .in_set(RenderSystems::Cleanup),
            ),
        );
        render.world_mut().run_schedule(Render);
        render.world_mut().run_schedule(Render);
        let snapshot: serde_json::Value = serde_json::from_str(&work.snapshot()).unwrap();
        assert_eq!(snapshot["work"]["queueFrames"], 2);
        assert_eq!(snapshot["work"]["prepareFrames"], 2);
        assert_eq!(snapshot["work"]["renderFrames"], 2);
        assert!(snapshot["work"]["renderMs"].as_f64().unwrap() >= 4.);
        assert!(snapshot["work"]["renderMs"].as_f64().unwrap().is_finite());
        assert!(snapshot["work"]["renderMaxMs"].as_f64().unwrap() >= 0.);
        assert_eq!(snapshot["gpuTime"], "unavailable");
        assert!(snapshot["work"]["prepareMs"].as_f64().unwrap().is_finite());
        assert_eq!(snapshot["scope"], "all-render-views");
        assert_eq!(snapshot["perPreviewPrepare"], "unavailable");
    }
}
