//! 通用相机过渡状态机：from/target/duration/elapsed/easing，只插值 `Transform`
//! （change: refactor-bevy-reusable-components，任务 2.2 / design D4）。
//!
//! 本模块只负责 transform 插值与完成状态；投影切换、2D 内容可见性、model focus 目标计算和
//! 恢复策略仍由 Canvas adapter（`app::focus`）管理，不进入本插件。核心不依赖 Canvas 协议。

pub(crate) mod projection;

use bevy::prelude::*;

/// 平滑过渡（smoothstep）：`progress` 先 clamp 到 0..1。
pub fn smoothstep(progress: f32) -> f32 {
    let p = progress.clamp(0.0, 1.0);
    p * p * (3.0 - 2.0 * p)
}

/// 一次相机过渡的纯状态：`from` → `target`，`elapsed` 已推进到 `duration` 即完成。
#[derive(Clone, Copy, Debug)]
pub struct CameraTransition {
    /// 过渡起点姿态。
    pub from: Transform,
    /// 过渡终点姿态。
    pub target: Transform,
    /// 过渡总时长（秒）；非正或非有限时视为即时完成。
    pub duration: f32,
    /// 已过渡时长（秒）。
    pub elapsed: f32,
}

impl CameraTransition {
    /// 构造一个已处于终点的过渡（不产生动画）。
    pub fn settled(at: Transform, duration: f32) -> Self {
        let duration = if duration.is_finite() && duration > 0.0 {
            duration
        } else {
            0.0
        };
        Self {
            from: at,
            target: at,
            duration,
            elapsed: duration,
        }
    }

    /// 是否仍在过渡中。
    pub fn animating(&self) -> bool {
        self.elapsed < self.duration
    }

    /// 推进 `delta_secs` 并返回当前插值姿态；`elapsed` clamp 到 `duration`。
    pub fn step(&mut self, delta_secs: f32) -> Transform {
        self.elapsed = (self.elapsed + delta_secs.max(0.0)).min(self.duration);
        evaluate_transition(self.from, self.target, self.elapsed, self.duration)
    }
}

/// 在 `from`/`target` 之间按 `elapsed`/`duration` 插值（纯函数）。
///
/// `duration <= 0` 时直接返回 `target`；否则用 smoothstep 缓动。
pub fn evaluate_transition(
    from: Transform,
    target: Transform,
    elapsed: f32,
    duration: f32,
) -> Transform {
    if !(duration.is_finite() && duration > 0.0) {
        return target;
    }
    let easing = smoothstep(elapsed / duration);
    Transform {
        translation: from.translation.lerp(target.translation, easing),
        rotation: from.rotation.slerp(target.rotation, easing),
        scale: from.scale.lerp(target.scale, easing),
    }
}

/// 通用相机过渡驱动组件：`target` 变化时宿主重置 `from/elapsed`。
#[derive(Component, Clone, Copy, Debug)]
pub struct CameraTransitionDriver {
    pub transition: CameraTransition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothstep_endpoints_and_midpoint() {
        assert!(smoothstep(0.0).abs() < 1e-6);
        assert!((smoothstep(1.0) - 1.0).abs() < 1e-6);
        assert!((smoothstep(0.5) - 0.5).abs() < 1e-6);
        assert!(smoothstep(-1.0) < 1e-6);
        assert!((smoothstep(2.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn step_lerps_and_clamps() {
        let mut transition = CameraTransition {
            from: Transform::from_xyz(0.0, 0.0, 300.0),
            target: Transform::from_xyz(100.0, 50.0, 20.0),
            duration: 0.4,
            elapsed: 0.0,
        };
        let mid = transition.step(0.2);
        assert!((mid.translation.x - 50.0).abs() < 1e-3);
        let end = transition.step(10.0);
        assert!(end.translation.abs_diff_eq(Vec3::new(100.0, 50.0, 20.0), 1e-5));
        assert!(!transition.animating());
    }

    #[test]
    fn zero_duration_is_instant() {
        let out = evaluate_transition(
            Transform::from_xyz(0.0, 0.0, 0.0),
            Transform::from_xyz(1.0, 2.0, 3.0),
            0.0,
            0.0,
        );
        assert!(out.translation.abs_diff_eq(Vec3::new(1.0, 2.0, 3.0), 1e-6));
    }

    #[test]
    fn settled_is_not_animating() {
        let t = CameraTransition::settled(Transform::from_xyz(1.0, 2.0, 3.0), 0.4);
        assert!(!t.animating());
    }
}
