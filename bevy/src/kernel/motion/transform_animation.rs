//! 通用 transform 动画：闭合 kind enum、显式播放状态、纯求值与 Plugin
//! （change: refactor-bevy-reusable-components，任务 2.1 / design D4；
//!  change: play-model-animations-on-hover，任务 1.1 / 1.2 / design D2）。
//!
//! 任意 Bevy 实体挂载 [`TransformAnimation`] 即可由插件驱动 `Transform` 动画；`kind` 是闭合
//! enum，不接受模型协议字符串（协议字符串 → enum 的映射由 model Scene adapter 负责）。本模块
//! 不依赖 Canvas 协议、bridge 或 DOM。
//!
//! 播放是显式的：实体默认 **inactive**，保持 base transform 且局部时间归零；宿主通过
//! [`TransformAnimationPlayback::start`] / [`TransformAnimationPlayback::stop`] 切换。插件每帧只为
//! active 实体累加 `Time::delta_secs()` 到局部 `elapsed`，再调用纯求值函数。全局 elapsed
//! 时间不参与求值，因此 hover 进入总是从零点开始、停止总是恢复初始姿态，且不受应用已运行
//! 多久影响。

use bevy::prelude::*;

/// 轴索引（0=x, 1=y, 2=z）。
pub type AnimationAxis = usize;

/// 闭合的动画种类；由宿主/adapter 从协议值构造，核心不接受字符串。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TransformAnimationKind {
    /// 绕指定轴持续旋转（角速度 rad/s）。
    Rotate { axis: AnimationAxis, speed: f32 },
    /// 沿指定轴按 `range` 环绕平移（单位/秒）。
    LoopMove {
        axis: AnimationAxis,
        speed: f32,
        range: [f32; 2],
    },
    /// 正弦振荡：位移 / 旋转 / 缩放三种模式。
    Oscillate {
        axis: AnimationAxis,
        speed: f32,
        mode: OscillateMode,
        amplitude: f32,
        phase: f32,
    },
}

/// 振荡作用的目标分量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OscillateMode {
    Position,
    Rotation,
    Scale,
}

/// 挂载在实体上的动画组件：以 `base` 为基准每帧求值。
#[derive(Component, Clone, Copy, Debug)]
pub struct TransformAnimation {
    pub base: Transform,
    pub kind: TransformAnimationKind,
}

/// 显式播放状态：与动画定义分离的宿主可控门禁与局部时钟。
///
/// `active` 为 `false` 时实体保持 `base` 且 `elapsed` 归零；由 `true` 切到 `false`（或在
/// `false` 时重复停止）都会清零局部时间，保证再次 `start` 从零点重新播放。
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct TransformAnimationPlayback {
    /// 是否正在推进动画。
    pub active: bool,
    /// 自本次播放开始推进的局部秒数；停止时清零。
    pub elapsed: f32,
}

impl TransformAnimationPlayback {
    /// 激活播放并从局部时间零点开始。
    pub fn start(&mut self) {
        self.active = true;
        self.elapsed = 0.0;
    }

    /// 停止播放、清零局部时间；实体恢复 base transform 的语义由动画系统结算。
    pub fn stop(&mut self) {
        self.active = false;
        self.elapsed = 0.0;
    }
}

/// 动画求值/播放结算的系统集（change: play-model-animations-on-hover，design D4）。
///
/// 宿主 adapter 通过 `*Playback` 集在动画求值前切换 active；`Evaluate` 只为 active 实体
/// 推进局部时钟并写回 transform。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TransformAnimationSet {
    /// 宿主写入 active/elapsed（stop/reset/start）——必须先于 `Evaluate`。
    Playback,
    /// 按局部时钟求值 transform。
    Evaluate,
}

/// 通用 transform 动画插件。
pub struct TransformAnimationPlugin;

impl Plugin for TransformAnimationPlugin {
    fn build(&self, app: &mut App) {
        app.configure_sets(
            Update,
            TransformAnimationSet::Playback.before(TransformAnimationSet::Evaluate),
        )
        .add_systems(
            Update,
            animate_transforms.in_set(TransformAnimationSet::Evaluate),
        );
    }
}

const AXES: [Vec3; 3] = [Vec3::X, Vec3::Y, Vec3::Z];

/// 对单个动画在 `now` 秒时刻求值（纯函数，便于测试）。
pub fn evaluate_transform_animation(
    base: &Transform,
    kind: &TransformAnimationKind,
    now: f32,
) -> Transform {
    let mut transform = *base;
    match kind {
        TransformAnimationKind::Rotate { axis, speed } => {
            transform.rotation = base.rotation * Quat::from_axis_angle(AXES[*axis], now * speed);
        }
        TransformAnimationKind::LoopMove { axis, speed, range } => {
            let span = range[1] - range[0];
            if span.abs() > f32::EPSILON {
                transform.translation[*axis] =
                    range[0] + (base.translation[*axis] - range[0] + now * speed).rem_euclid(span);
            }
        }
        TransformAnimationKind::Oscillate {
            axis,
            speed,
            mode,
            amplitude,
            phase,
        } => {
            let wave = (now * speed + phase).sin() * amplitude;
            match mode {
                OscillateMode::Scale => {
                    transform.scale[*axis] = (base.scale[*axis] * (1.0 + wave)).max(0.05);
                }
                OscillateMode::Rotation => {
                    transform.rotation = base.rotation * Quat::from_axis_angle(AXES[*axis], wave);
                }
                OscillateMode::Position => transform.translation[*axis] += wave,
            }
        }
    }
    transform
}

/// 按显式播放状态推进动画实体；`inactive` 实体写回 base 且局部时间归零。
pub fn animate_transforms(
    time: Res<Time>,
    mut query: Query<(
        &mut Transform,
        &TransformAnimation,
        &mut TransformAnimationPlayback,
    )>,
) {
    let delta = time.delta_secs();
    for (mut transform, animation, mut playback) in &mut query {
        if playback.active {
            playback.elapsed = (playback.elapsed + delta.max(0.0)).min(MAX_LOCAL_ELAPSED);
            *transform =
                evaluate_transform_animation(&animation.base, &animation.kind, playback.elapsed);
        } else {
            playback.elapsed = 0.0;
            *transform = animation.base;
        }
    }
}

/// 局部播放时间上限（秒）。长期 hover 时把 `f32` 时钟封顶，避免长时间运行后相位精度衰减。
const MAX_LOCAL_ELAPSED: f32 = 86_400.0;

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    #[test]
    fn loop_move_wraps_within_range() {
        let base = Transform::from_xyz(0.0, 0.0, 0.0);
        let kind = TransformAnimationKind::LoopMove {
            axis: 1,
            speed: 10.0,
            range: [0.0, 100.0],
        };
        assert_eq!(
            evaluate_transform_animation(&base, &kind, 0.0)
                .translation
                .y,
            0.0
        );
        assert_eq!(
            evaluate_transform_animation(&base, &kind, 5.0)
                .translation
                .y,
            50.0
        );
        assert_eq!(
            evaluate_transform_animation(&base, &kind, 12.0)
                .translation
                .y,
            20.0
        );
    }

    #[test]
    fn oscillate_scale_is_clamped() {
        let base = Transform::from_xyz(0.0, 0.0, 0.0);
        let kind = TransformAnimationKind::Oscillate {
            axis: 1,
            speed: 0.0,
            mode: OscillateMode::Scale,
            amplitude: -5.0,
            phase: PI / 2.0,
        };
        assert!(evaluate_transform_animation(&base, &kind, 0.0).scale.y >= 0.05);
    }

    #[test]
    fn rotate_is_deterministic_at_zero() {
        let base = Transform::from_xyz(1.0, 2.0, 3.0);
        let kind = TransformAnimationKind::Rotate { axis: 1, speed: PI };
        let at_zero = evaluate_transform_animation(&base, &kind, 0.0);
        assert!(at_zero.rotation.abs_diff_eq(base.rotation, 1e-6));
        assert_eq!(at_zero.translation, base.translation);
    }

    #[test]
    fn degenerate_range_does_not_produce_nan() {
        let base = Transform::from_xyz(0.0, 0.0, 0.0);
        let kind = TransformAnimationKind::LoopMove {
            axis: 0,
            speed: 5.0,
            range: [2.0, 2.0],
        };
        let out = evaluate_transform_animation(&base, &kind, 1.0);
        assert!(out.translation.is_finite());
    }

    fn app() -> App {
        let mut app = App::new();
        // 固定步长并保持 ≤ Bevy `Time<Virtual>` 默认 250ms 上限，使测试推进确定。
        app.add_plugins((bevy::time::TimePlugin, TransformAnimationPlugin))
            .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(
                std::time::Duration::from_secs_f32(0.2),
            ));
        app
    }

    fn spawn(app: &mut App, playback: TransformAnimationPlayback) -> Entity {
        let base = Transform::from_xyz(3.0, 4.0, 0.0);
        app.world_mut()
            .spawn((
                base,
                TransformAnimation {
                    base,
                    kind: TransformAnimationKind::LoopMove {
                        axis: 1,
                        speed: 10.0,
                        range: [0.0, 100.0],
                    },
                },
                playback,
            ))
            .id()
    }

    /// 以 `delta` 为固定步长推进若干帧。
    fn advance_steps(app: &mut App, delta: f32, steps: usize) {
        app.insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(
            std::time::Duration::from_secs_f32(delta),
        ));
        for _ in 0..steps {
            app.update();
        }
    }

    /// inactive 实体保持 base；全局时间推进不改变它，局部时间归零。
    #[test]
    fn inactive_entity_ignores_global_time() {
        let mut app = app();
        let entity = spawn(&mut app, TransformAnimationPlayback::default());
        advance_steps(&mut app, 0.2, 5);
        let transform = *app.world().entity(entity).get::<Transform>().unwrap();
        assert_eq!(transform.translation, Vec3::new(3.0, 4.0, 0.0));
        let playback = app
            .world()
            .entity(entity)
            .get::<TransformAnimationPlayback>()
            .unwrap();
        assert!(!playback.active);
        assert_eq!(playback.elapsed, 0.0);
    }

    /// 从零开始且只按 delta 推进：每帧按步长累加，不从全局时间跳相位。
    #[test]
    fn active_entity_advances_from_zero_by_delta() {
        let mut app = app();
        let entity = spawn(
            &mut app,
            TransformAnimationPlayback {
                active: true,
                elapsed: 0.0,
            },
        );
        // 首帧 Bevy 虚拟时间为 0（无上一帧），第二帧起按步长推进。
        advance_steps(&mut app, 0.2, 2);
        let after_first = *app.world().entity(entity).get::<Transform>().unwrap();
        assert!(
            (after_first.translation.y - 6.0).abs() < 1e-4,
            "base 4.0 + 0.2s * 10 = 6.0, got {}",
            after_first.translation.y
        );
        advance_steps(&mut app, 0.2, 1);
        let after_second = *app.world().entity(entity).get::<Transform>().unwrap();
        assert!(
            (after_second.translation.y - 8.0).abs() < 1e-4,
            "base 4.0 + 0.4s * 10 = 8.0, got {}",
            after_second.translation.y
        );
    }

    /// stop 清零局部时间并恢复 base；restart 从零点重新开始。
    #[test]
    fn stop_resets_and_restart_begins_at_zero() {
        let mut app = app();
        let entity = spawn(
            &mut app,
            TransformAnimationPlayback {
                active: true,
                elapsed: 0.0,
            },
        );
        advance_steps(&mut app, 0.2, 1);
        // 停止。
        app.world_mut()
            .entity_mut(entity)
            .get_mut::<TransformAnimationPlayback>()
            .unwrap()
            .stop();
        advance_steps(&mut app, 0.2, 1);
        let stopped_transform = *app.world().entity(entity).get::<Transform>().unwrap();
        assert_eq!(stopped_transform.translation, Vec3::new(3.0, 4.0, 0.0));
        let stopped = app
            .world()
            .entity(entity)
            .get::<TransformAnimationPlayback>()
            .unwrap();
        assert_eq!(stopped.elapsed, 0.0);
        // 再次激活：从零点开始，而不是延续上一相位。
        app.world_mut()
            .entity_mut(entity)
            .get_mut::<TransformAnimationPlayback>()
            .unwrap()
            .start();
        advance_steps(&mut app, 0.1, 1);
        let restarted = *app.world().entity(entity).get::<Transform>().unwrap();
        assert!(
            (restarted.translation.y - 5.0).abs() < 1e-4,
            "base 4.0 + 0.1s * 10 = 5.0"
        );
    }

    /// base 更新在 inactive 时立即生效；active 时以新 base 继续推进。
    #[test]
    fn base_update_is_preserved_when_stopped_and_active() {
        let mut app = app();
        let entity = spawn(&mut app, TransformAnimationPlayback::default());
        let new_base = Transform::from_xyz(-2.0, 1.0, 0.0);
        app.world_mut()
            .entity_mut(entity)
            .get_mut::<TransformAnimation>()
            .unwrap()
            .base = new_base;
        advance_steps(&mut app, 0.4, 1);
        assert_eq!(
            *app.world().entity(entity).get::<Transform>().unwrap(),
            new_base
        );
        // active 后仍以更新后的 base 为基准。
        app.world_mut()
            .entity_mut(entity)
            .get_mut::<TransformAnimationPlayback>()
            .unwrap()
            .start();
        advance_steps(&mut app, 0.2, 1);
        let active = *app.world().entity(entity).get::<Transform>().unwrap();
        assert!(
            (active.translation.y - 3.0).abs() < 1e-4,
            "base 1.0 + 0.2s * 10 = 3.0"
        );
    }

    /// 同帧 active→stopped：先用 `Commands`（延迟命令）模拟真实 `sync_models` 门禁，再靠
    /// Bevy auto-sync 在 `Playback`→`Evaluate` 边插入 `ApplyDeferred`；否则求值会读到旧状态。
    #[test]
    fn deferred_playback_stop_settles_before_evaluation_in_same_frame() {
        let mut app = App::new();
        app.add_plugins(bevy::time::TimePlugin)
            .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(
                std::time::Duration::from_secs_f32(0.5),
            ))
            .configure_sets(
                Update,
                TransformAnimationSet::Playback.before(TransformAnimationSet::Evaluate),
            )
            .add_systems(
                Update,
                (
                    (|mut commands: Commands, query: Query<Entity, With<TransformAnimationPlayback>>| {
                        for entity in &query {
                            commands
                                .entity(entity)
                                .insert(TransformAnimationPlayback::default());
                        }
                    })
                    .in_set(TransformAnimationSet::Playback),
                    animate_transforms.in_set(TransformAnimationSet::Evaluate),
                ),
            );
        let entity = spawn(
            &mut app,
            TransformAnimationPlayback {
                active: true,
                elapsed: 5.0,
            },
        );
        app.update();
        let transform = *app.world().entity(entity).get::<Transform>().unwrap();
        assert_eq!(
            transform.translation,
            Vec3::new(3.0, 4.0, 0.0),
            "延迟停止必须在同帧求值前生效"
        );
    }

    /// 有界 scale 振荡在 active 推进过程中始终有限且不低于下限。
    #[test]
    fn oscillate_scale_stays_finite_and_bounded() {
        let mut app = app();
        let base = Transform::default();
        let entity = app
            .world_mut()
            .spawn((
                base,
                TransformAnimation {
                    base,
                    kind: TransformAnimationKind::Oscillate {
                        axis: 1,
                        speed: 3.0,
                        mode: OscillateMode::Scale,
                        amplitude: -4.0,
                        phase: 0.0,
                    },
                },
                TransformAnimationPlayback {
                    active: true,
                    elapsed: 0.0,
                },
            ))
            .id();
        for _ in 0..40 {
            advance_steps(&mut app, 0.05, 1);
            let transform = *app.world().entity(entity).get::<Transform>().unwrap();
            assert!(transform.scale.is_finite());
            assert!(transform.scale.y >= 0.05);
        }
    }
}
