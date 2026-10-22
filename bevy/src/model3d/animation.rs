//! 模型动画：Scene adapter 把 `ModelOp` 动画映射为通用 `TransformAnimation`
//! （change: refactor-bevy-runtime-modules，任务 4.2 / design D6；
//!  change: refactor-bevy-reusable-components，任务 2.1 / design D4）。
//!
//! 动画的求值与驱动已迁到通用 [`crate::transform_animation`]：本模块只负责把模型协议的
//! 字符串轴/模式转换为闭合 enum，并在 `ModelOp` → 组件处复用通用类型。

pub(crate) use crate::transform_animation::{
    OscillateMode, TransformAnimation, TransformAnimationKind, TransformAnimationPlayback,
    TransformAnimationSet,
};

/// 轴名 → 索引（`x` / `z`，其余归 `y`）。
pub(crate) fn animation_axis(axis: &str) -> usize {
    match axis {
        "x" => 0,
        "z" => 2,
        _ => 1,
    }
}

/// 振荡模式字符串 → 闭合 enum（未知回退位移）。
pub(crate) fn oscillate_mode(mode: &str) -> OscillateMode {
    match mode {
        "scale" => OscillateMode::Scale,
        "rotation" => OscillateMode::Rotation,
        _ => OscillateMode::Position,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform_animation::evaluate_transform_animation;
    use bevy::prelude::Transform;
    use std::f32::consts::PI;

    #[test]
    fn axis_mapping_prefers_xz_then_y() {
        assert_eq!(animation_axis("x"), 0);
        assert_eq!(animation_axis("z"), 2);
        assert_eq!(animation_axis(""), 1);
        assert_eq!(animation_axis("y"), 1);
    }

    #[test]
    fn oscillate_mode_maps_protocol_strings() {
        assert_eq!(oscillate_mode("scale"), OscillateMode::Scale);
        assert_eq!(oscillate_mode("rotation"), OscillateMode::Rotation);
        assert_eq!(oscillate_mode("position"), OscillateMode::Position);
        assert_eq!(oscillate_mode("unexpected"), OscillateMode::Position);
    }

    #[test]
    fn rotate_is_deterministic() {
        let base = Transform::from_xyz(1.0, 2.0, 3.0);
        let kind = TransformAnimationKind::Rotate { axis: 1, speed: PI };
        let at_zero = evaluate_transform_animation(&base, &kind, 0.0);
        assert!(at_zero.rotation.abs_diff_eq(base.rotation, 1e-6));
        assert_eq!(at_zero.translation, base.translation);
    }
}
