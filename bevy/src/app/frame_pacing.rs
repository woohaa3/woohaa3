//! 浏览器画布上限为 120 FPS，并由 winit 的 rAF 和 FIFO 同步限制到屏幕刷新节奏。
use std::time::Duration;

use bevy::winit::{UpdateMode, WinitSettings};

pub(super) fn settings() -> WinitSettings {
    // rAF/FIFO 负责显示刷新同步，wait 负责 120 FPS 上限；输入先排队，不能绕过 wait。
    // 输入焦点属于父页面，因此 renderer 未聚焦时也使用同一规则。
    let mode = UpdateMode::Reactive {
        wait: Duration::from_secs_f64(1.0 / 120.0),
        react_to_device_events: false,
        react_to_user_events: false,
        react_to_window_events: false,
    };
    WinitSettings {
        focused_mode: mode,
        unfocused_mode: mode,
    }
}
