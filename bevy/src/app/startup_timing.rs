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
    timing.gap_ms = timing
        .previous
        .map(|last| now.duration_since(last).as_secs_f64() * 1000.0);
    timing.previous = Some(now);
    timing.started = Some(now);
}
/// 渲染工作快照是 `Option`：没有安装渲染工作资源时（例如最小装配的原生画布）
/// 只跳过该读数，不让系统参数校验失败并中断帧循环。
pub(super) fn end(
    timing: Res<StartupTiming>,
    work: Option<Res<crate::render_work::RenderWork>>,
) {
    let (Some(start), Some(work)) = (timing.started, work.as_deref()) else {
        return;
    };
    work.startup_main(start.elapsed().as_secs_f64() * 1000.0, timing.gap_ms);
}
