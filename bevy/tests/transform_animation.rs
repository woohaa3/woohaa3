//! 通用 transform 动画插件的最小独立 App 测试
//! （change: refactor-bevy-reusable-components，任务 2.3；
//!  change: play-model-animations-on-hover，任务 1.1 —— 动画默认停止，显式 active 才推进）。

use bevy::prelude::*;
use woohaa_bevy_canvas::transform_animation::{
    OscillateMode, TransformAnimation, TransformAnimationKind, TransformAnimationPlayback,
    TransformAnimationPlugin, evaluate_transform_animation,
};

fn app() -> App {
    let mut app = App::new();
    // 固定步长并保持 ≤ Bevy `Time<Virtual>` 默认 250ms 上限。首帧 Bevy 虚拟时间为 0，
    // 因此至少推进两帧才产生非零 delta。
    app.add_plugins((bevy::time::TimePlugin, TransformAnimationPlugin))
        .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(
            std::time::Duration::from_secs_f32(0.2),
        ));
    app
}

fn advance(app: &mut App, steps: usize) {
    for _ in 0..steps {
        app.update();
    }
}

#[test]
fn plugin_drives_entity_transform_when_active() {
    let mut app = app();
    let base = Transform::from_xyz(0.0, 0.0, 0.0);
    let entity = app
        .world_mut()
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
            TransformAnimationPlayback {
                active: true,
                elapsed: 0.0,
            },
        ))
        .id();
    advance(&mut app, 2);
    let animated = *app.world().entity(entity).get::<Transform>().unwrap();
    assert!(
        (animated.translation.y - 2.0).abs() < 1e-4,
        "0.2s * 10 = 2.0, got {}",
        animated.translation.y
    );
    // 纯函数求值仍然确定（供 unit 断言复用）。
    let evaluated = evaluate_transform_animation(
        &base,
        &TransformAnimationKind::LoopMove {
            axis: 1,
            speed: 10.0,
            range: [0.0, 100.0],
        },
        5.0,
    );
    assert!((evaluated.translation.y - 50.0).abs() < 1e-4);
}

#[test]
fn parallel_entities_are_independent() {
    let mut app = app();
    let a = app
        .world_mut()
        .spawn((
            Transform::default(),
            TransformAnimation {
                base: Transform::default(),
                kind: TransformAnimationKind::Oscillate {
                    axis: 1,
                    speed: 1.0,
                    mode: OscillateMode::Position,
                    amplitude: 2.0,
                    phase: 0.0,
                },
            },
            TransformAnimationPlayback::default(),
        ))
        .id();
    let b = app
        .world_mut()
        .spawn((
            Transform::default(),
            TransformAnimation {
                base: Transform::default(),
                kind: TransformAnimationKind::Rotate {
                    axis: 1,
                    speed: 1.0,
                },
            },
            TransformAnimationPlayback {
                active: true,
                elapsed: 0.0,
            },
        ))
        .id();
    advance(&mut app, 2);
    // a 停止保持 base；b 推进。
    assert_eq!(
        *app.world().entity(a).get::<Transform>().unwrap(),
        Transform::default()
    );
    assert!(*app.world().entity(b).get::<Transform>().unwrap() != Transform::default());
}

#[test]
fn inactive_entity_does_not_follow_global_time() {
    let mut app = app();
    let base = Transform::from_xyz(1.0, 2.0, 3.0);
    let entity = app
        .world_mut()
        .spawn((
            base,
            TransformAnimation {
                base,
                kind: TransformAnimationKind::Rotate {
                    axis: 1,
                    speed: 2.0,
                },
            },
            TransformAnimationPlayback::default(),
        ))
        .id();
    for _ in 0..6 {
        advance(&mut app, 1);
    }
    assert_eq!(
        *app.world().entity(entity).get::<Transform>().unwrap(),
        base
    );
    let playback = app
        .world()
        .entity(entity)
        .get::<TransformAnimationPlayback>()
        .unwrap();
    assert!(!playback.active);
    assert_eq!(playback.elapsed, 0.0);
}
