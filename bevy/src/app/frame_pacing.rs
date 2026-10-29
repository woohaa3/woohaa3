//! 画布帧节奏：活动帧 120 FPS，静止后进入「静帧」心跳。
//!
//! 浏览器画布上限为 120 FPS，并由 winit 的 rAF 和 FIFO 同步限制到屏幕刷新节奏。
//! 静态画布继续按 120 FPS 更新，等价于把同一张画面重画上百次：整场上千个部件、
//! 每帧数百次 draw call 全部重复（2026-10-28 draw call 优化）。这里按「是否需要连续帧」
//! 切换 winit 更新间隔：
//!
//! - 活动（输入、动画播放、hover、在途准备/预览/截图）：`ACTIVE_WAIT`（120 FPS 上限）。
//! - 静止超过 `DWELL_SECS`：`IDLE_WAIT` 心跳。画面内容没有任何变化，观感等同冻住一张图，
//!   但每帧工作量降到 1/30。
//!
//! `wake()` 让 JS→WASM 的提交在心跳间隙也立刻唤醒事件循环：否则一次拖动最多要等一个
//! 心跳间隔才被处理。

#[cfg(feature = "wasm")]
use std::{cell::RefCell, time::Duration};

#[cfg(feature = "wasm")]
use bevy::{
    prelude::*,
    winit::{EventLoopProxy, EventLoopProxyWrapper, UpdateMode, WinitSettings, WinitUserEvent},
};

use crate::{history_preview, model_preview, model3d, shot_node_preview};

use super::state::FrameFlags;

/// 活动帧间隔（120 FPS 上限）。
#[cfg(feature = "wasm")]
const ACTIVE_WAIT: Duration = Duration::from_micros(8_333);
/// 静止心跳间隔：静止画布按 4 FPS 重画。
#[cfg(feature = "wasm")]
const IDLE_WAIT: Duration = Duration::from_millis(250);
/// 最后一次活动之后仍保持活动帧的时长（手势间隙不来回切节奏）。
#[cfg(feature = "wasm")]
const DWELL_SECS: f64 = 0.75;
/// 启动后保持活动帧的时长（加载、shader 编译、首帧装配）。
#[cfg(feature = "wasm")]
const STARTUP_HOLD_SECS: f64 = 3.0;

/// 是否仍有需要连续帧的活动。
///
/// 输入（含纯视口增量）、动画播放/运动求值/截图，以及排队中的模型准备、卡片预览与
/// 离屏预览分配都要求逐帧推进；其余情况画布内容不会自行变化，可以停帧。
pub(super) fn busy(
    flags: &FrameFlags,
    visuals: &model3d::ModelVisuals,
    shot: &shot_node_preview::ShotPreviewCards,
    previews: &model_preview::Previews,
    history: &history_preview::ActiveThumbnail,
) -> bool {
    busy_reasons(flags, visuals, shot, previews, history) != 0
}

/// 逐项忙碌位图；`0` 表示可以停帧。
///
/// 位图保留「是哪一项在要求连续帧」：静止降频没生效时，只能靠这份标签从遥测侧分辨
/// 是输入、准备、预览还是截图一直挂着。
fn busy_reasons(
    flags: &FrameFlags,
    visuals: &model3d::ModelVisuals,
    shot: &shot_node_preview::ShotPreviewCards,
    previews: &model_preview::Previews,
    history: &history_preview::ActiveThumbnail,
) -> u16 {
    let mut bits = 0u16;
    for (bit, value) in [
        (1 << 0, flags.scene_received),
        (1 << 1, flags.positions_received),
        (1 << 2, flags.viewport_only),
        (1 << 3, flags.observer_changed),
        (1 << 4, flags.film_set_media_changed),
        (1 << 5, flags.surface_changed),
        (1 << 6, flags.changed),
        (1 << 7, visuals.has_hot_activity()),
        (1 << 8, visuals.has_in_flight_preparation()),
        (1 << 9, shot.has_pending()),
        (1 << 10, previews.has_pending()),
        (1 << 11, history.has_pending()),
    ] {
        if value {
            bits |= bit;
        }
    }
    bits
}

/// 忙碌位图的固定词表（诊断口径，长度有界）。
const BUSY_LABELS: [&str; 12] = [
    "scene",
    "positions",
    "viewport",
    "observer",
    "film-set-media",
    "surface",
    "changed",
    "hot",
    "preparing",
    "shot",
    "previews",
    "history",
];

fn busy_label(bits: u16) -> String {
    let mut label = String::from("active:");
    let mut first = true;
    for (index, name) in BUSY_LABELS.iter().enumerate() {
        if bits & (1 << index) == 0 {
            continue;
        }
        if !first {
            label.push(',');
        }
        label.push_str(name);
        first = false;
    }
    label
}

/// 帧节奏状态。
#[cfg(feature = "wasm")]
#[derive(Resource, Default)]
pub(super) struct PacingState {
    started: bool,
    active_until: f64,
    idle: bool,
    /// 最近一次写出的节奏标签（只在翻转时更新诊断，避免每帧格式化）。
    label: String,
}

/// 启动时的 winit 配置：活动帧上限。
#[cfg(feature = "wasm")]
pub(super) fn settings() -> WinitSettings {
    let mode = mode(false);
    WinitSettings {
        focused_mode: mode,
        unfocused_mode: mode,
    }
}

#[cfg(feature = "wasm")]
fn mode(idle: bool) -> UpdateMode {
    // rAF/FIFO 负责显示刷新同步，wait 负责上限；输入焦点属于父页面，未聚焦时同一规则。
    UpdateMode::Reactive {
        wait: if idle { IDLE_WAIT } else { ACTIVE_WAIT },
        react_to_device_events: false,
        // 允许 `wake()` 的 `WinitUserEvent::WakeUp` 立刻唤醒停帧状态。
        react_to_user_events: true,
        react_to_window_events: true,
    }
}

/// 按「是否需要连续帧」切换更新间隔；只在状态翻转时写资源。
#[cfg(feature = "wasm")]
pub(super) fn sync_pacing(
    time: Res<Time<Real>>,
    flags: Res<FrameFlags>,
    visuals: Res<model3d::ModelVisuals>,
    shot: Res<shot_node_preview::ShotPreviewCards>,
    previews: Res<model_preview::Previews>,
    history: Res<history_preview::ActiveThumbnail>,
    mut state: ResMut<PacingState>,
    mut settings: ResMut<WinitSettings>,
) {
    let now = time.elapsed_secs_f64();
    if !state.started {
        state.started = true;
        state.active_until = now + STARTUP_HOLD_SECS;
    }
    let bits = busy_reasons(&flags, &visuals, &shot, &previews, &history);
    if bits != 0 {
        state.active_until = now + DWELL_SECS;
    }
    let idle = idle_enabled() && now >= state.active_until;
    let label = if bits != 0 {
        busy_label(bits)
    } else if idle {
        "idle".to_owned()
    } else {
        "dwell".to_owned()
    };
    if state.label != label {
        state.label = label.clone();
        crate::bridge::set_frame_pacing_diagnostics(label);
    }
    if state.idle == idle {
        return;
    }
    state.idle = idle;
    let mode = mode(idle);
    settings.focused_mode = mode;
    settings.unfocused_mode = mode;
}

/// 静止降频开关（默认关闭）。
///
/// 它只降低每秒帧数，不改每帧 draw call：用户要看的是单帧绘制量，因此默认保持 120 FPS
/// 连续更新；需要省电/省 GPU 时间时显式打开。
#[cfg(feature = "wasm")]
static IDLE_PACING_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 开关静止降频（策略 MUST 可关闭）。
#[cfg(feature = "wasm")]
pub(crate) fn set_enabled(enabled: bool) {
    IDLE_PACING_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(feature = "wasm")]
fn idle_enabled() -> bool {
    IDLE_PACING_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(feature = "wasm")]
thread_local! {
    /// WASM 单线程：winit 事件循环代理在插件启动时登记，供 JS 线程的提交回调直接唤醒。
    static WAKE_PROXY: RefCell<Option<EventLoopProxy<WinitUserEvent>>> = const { RefCell::new(None) };
}

/// 登记唤醒代理（只登记一次）。
#[cfg(feature = "wasm")]
pub(super) fn install_wake(proxy: Res<EventLoopProxyWrapper>, mut done: Local<bool>) {
    if *done {
        return;
    }
    *done = true;
    let proxy = (**proxy).clone();
    WAKE_PROXY.with(|slot| *slot.borrow_mut() = Some(proxy));
}

/// 立即唤醒事件循环（JS→WASM 提交路径调用；未启动时静默忽略）。
#[cfg(feature = "wasm")]
pub(crate) fn wake() {
    WAKE_PROXY.with(|slot| {
        if let Some(proxy) = slot.borrow().as_ref() {
            let _ = proxy.send_event(WinitUserEvent::WakeUp);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_canvas_frames_stay_still() {
        let flags = FrameFlags::default();
        let visuals = model3d::ModelVisuals::default();
        let shot = shot_node_preview::ShotPreviewCards::default();
        let previews = model_preview::Previews::default();
        let history = history_preview::ActiveThumbnail::default();
        assert!(!busy(&flags, &visuals, &shot, &previews, &history));
    }

    #[test]
    fn input_frames_are_busy() {
        let visuals = model3d::ModelVisuals::default();
        let shot = shot_node_preview::ShotPreviewCards::default();
        let previews = model_preview::Previews::default();
        let history = history_preview::ActiveThumbnail::default();
        for mutate in [
            |flags: &mut FrameFlags| flags.scene_received = true,
            |flags: &mut FrameFlags| flags.viewport_only = true,
            |flags: &mut FrameFlags| flags.positions_received = true,
            |flags: &mut FrameFlags| flags.film_set_media_changed = true,
            |flags: &mut FrameFlags| flags.changed = true,
        ] {
            let mut flags = FrameFlags::default();
            mutate(&mut flags);
            assert!(busy(&flags, &visuals, &shot, &previews, &history));
        }
    }
}
