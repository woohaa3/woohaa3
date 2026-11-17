//! 运行中节点进度估算（纯逻辑）
//! （change: add-node-running-progress，design D2）。
//!
//! 不依赖 Bevy/ECS：估算与合并规则放在始终编译的模块里，宿主测试（
//! `--no-default-features --features native-renderer`）可直接覆盖；WASM 渲染器
//! （`canvas2d::generation`）复用同一份规则。生产消费方仅 WASM，native 下仅测试使用。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]

/// 节点种类对应的估算生成时长（秒）。与参考实现的默认分类时长一致。
pub(crate) const IMAGE_SECS: f32 = 45.0;
pub(crate) const VIDEO_SECS: f32 = 180.0;
pub(crate) const AUDIO_SECS: f32 = 60.0;
pub(crate) const TEXT_SECS: f32 = 15.0;

/// 估算进度上限（%）：运行中不显示 100%，完成由离开 `busy` 表达。
pub(crate) const ESTIMATE_CEILING: f32 = 95.0;

/// 节点种类 → 估算时长（秒）。
pub(crate) fn category_secs(kind: &str) -> f32 {
    match kind {
        "video" => VIDEO_SECS,
        "audio" => AUDIO_SECS,
        "text" => TEXT_SECS,
        _ => IMAGE_SECS,
    }
}

/// 经过时间 → 估算进度（1..=95%）。
pub(crate) fn estimate_percent(elapsed_secs: f32, kind: &str) -> f32 {
    if !elapsed_secs.is_finite() || elapsed_secs <= 0.0 {
        return 1.0;
    }
    ((elapsed_secs / category_secs(kind)) * 100.0).clamp(1.0, ESTIMATE_CEILING)
}

/// 显示进度 = max(估算, 规范上报)；两者都夹取到 1..=95。
pub(crate) fn display_percent(estimated: f32, reported: f32) -> f32 {
    let reported = if reported.is_finite() {
        reported.clamp(1.0, ESTIMATE_CEILING)
    } else {
        1.0
    };
    estimated.clamp(1.0, ESTIMATE_CEILING).max(reported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_secs_maps_node_kinds() {
        assert_eq!(category_secs("video"), VIDEO_SECS);
        assert_eq!(category_secs("audio"), AUDIO_SECS);
        assert_eq!(category_secs("text"), TEXT_SECS);
        assert_eq!(category_secs("image"), IMAGE_SECS);
        assert_eq!(category_secs("unknown"), IMAGE_SECS);
    }

    #[test]
    fn estimate_percent_is_clamped_and_monotonic() {
        assert_eq!(estimate_percent(0.0, "image"), 1.0);
        assert_eq!(estimate_percent(-5.0, "image"), 1.0);
        // 45s 时长的一半 ≈ 50%。
        let half = estimate_percent(22.5, "image");
        assert!((half - 50.0).abs() < 1.0, "expected ~50, got {half}");
        // 远超时长封顶 95%，永不显示 100%。
        assert_eq!(estimate_percent(10_000.0, "image"), ESTIMATE_CEILING);
        // 封顶前单调递增（video 180s：45s=25%，90s=50%）。
        assert!(estimate_percent(45.0, "video") < estimate_percent(90.0, "video"));
    }

    #[test]
    fn display_percent_takes_max_and_clamps() {
        assert_eq!(display_percent(10.0, 60.0), 60.0);
        assert_eq!(display_percent(80.0, 20.0), 80.0);
        // 上报超过上限时夹取。
        assert_eq!(display_percent(10.0, 100.0), ESTIMATE_CEILING);
        // 非法上报回退到估算。
        assert_eq!(display_percent(30.0, f32::NAN), 30.0);
        assert_eq!(display_percent(0.0, 0.0), 1.0);
    }
}
