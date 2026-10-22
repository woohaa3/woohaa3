//! 动画节点会话时机关闭与姿态求值测试
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.2/4.3）。

use bevy::prelude::*;
use woohaa_bevy_canvas::animation_session::{AnimationSession, PlaybackState};
use woohaa_bevy_canvas::motion::{
    InitialCameraState, RawCameraTrack, RawModelMotion, RawModelTrack, validate,
};

fn camera() -> InitialCameraState {
    InitialCameraState {
        azimuth: 0.0,
        elevation: std::f32::consts::FRAC_PI_4,
        distance: 8.0,
        focus_offset: Vec3::ZERO,
    }
}

fn raw_rotate(target: &str, axis: &str, speed: f32) -> RawModelTrack {
    RawModelTrack {
        target_id: target.to_owned(),
        start_time: Some(0.0),
        end_time: Some(4.0),
        motion: RawModelMotion {
            kind: "rotate".to_owned(),
            axis: Some(axis.to_owned()),
            speed: Some(speed),
            range: None,
            mode: None,
            amplitude: None,
            phase: None,
            ..Default::default()
        },
    }
}

fn rotate_motion() -> woohaa_bevy_canvas::motion::MotionIr {
    validate(
        "woohaa-motion-ir-v1",
        vec![],
        vec![raw_rotate("body", "y", 0.5)],
        4.0,
    )
    .unwrap()
}

#[test]
fn session_starts_stopped_at_zero_and_evaluates_initial_pose() {
    let session = AnimationSession::new(4.0, false, camera(), rotate_motion());
    assert_eq!(session.state, PlaybackState::Stopped);
    assert_eq!(session.time, 0.0);
    let pose = session.pose();
    assert!((pose.camera.azimuth).abs() < 1e-6);
    let body = pose.model.iter().find(|(id, _)| id == "body").unwrap();
    assert_eq!(body.1.rotation, Quat::IDENTITY);
}

#[test]
fn session_advances_only_while_playing_and_seek_pauses() {
    let mut session = AnimationSession::new(4.0, false, camera(), rotate_motion());
    session.advance(1.0);
    assert_eq!(session.time, 0.0);

    session.play();
    session.advance(1.0);
    assert!((session.time - 1.0).abs() < 1e-5);

    session.seek(2.0);
    assert_eq!(session.state, PlaybackState::Paused);
    session.advance(1.0);
    assert!((session.time - 2.0).abs() < 1e-5);
}

#[test]
fn non_loop_session_clamps_at_end_loop_wraps() {
    let mut plain = AnimationSession::new(4.0, false, camera(), rotate_motion());
    plain.play();
    plain.advance(10.0);
    assert!((plain.time - 4.0).abs() < 1e-5);
    assert_eq!(plain.state, PlaybackState::Paused);

    let mut looped = AnimationSession::new(4.0, true, camera(), rotate_motion());
    looped.play();
    looped.advance(5.0);
    assert!((looped.time - 1.0).abs() < 1e-5);
}

#[test]
fn static_session_stays_at_zero() {
    let empty = validate("woohaa-motion-ir-v1", vec![], vec![], 0.0).unwrap();
    let mut session = AnimationSession::new(0.0, false, camera(), empty);
    session.play();
    session.advance(3.0);
    assert_eq!(session.time, 0.0);
}

#[test]
fn stop_resets_to_zero_and_reevaluates() {
    let mut session = AnimationSession::new(4.0, false, camera(), rotate_motion());
    session.play();
    session.advance(2.0);
    session.stop();
    assert_eq!(session.time, 0.0);
    assert_eq!(session.state, PlaybackState::Stopped);
    let body = session
        .pose()
        .model
        .iter()
        .find(|(id, _)| id == "body")
        .cloned()
        .unwrap();
    assert_eq!(body.1.rotation, Quat::IDENTITY);
}

#[test]
fn pose_at_is_independent_of_session_clock() {
    let session = AnimationSession::new(4.0, false, camera(), rotate_motion());
    let at_two = session.pose_at(2.0);
    let body = at_two.model.iter().find(|(id, _)| id == "body").unwrap();
    // 2 秒 × 0.5 rad/s = 1.0 rad；四元数 Y 分量 = sin(0.5)。
    assert!((body.1.rotation.y - 0.5f32.sin()).abs() < 1e-5);
    // 会话时钟仍停在零点。
    assert_eq!(session.time, 0.0);
}

#[test]
fn different_sessions_do_not_share_time() {
    let mut a = AnimationSession::new(4.0, false, camera(), rotate_motion());
    let b = AnimationSession::new(4.0, false, camera(), rotate_motion());
    a.play();
    a.advance(3.0);
    assert!((a.time - 3.0).abs() < 1e-5);
    assert_eq!(b.time, 0.0);
}

#[test]
fn oscillate_move_and_axis_helpers_stay_finite() {
    let motion = validate(
        "woohaa-motion-ir-v1",
        vec![RawCameraTrack {
            property: "elevation".to_owned(),
            start_time: Some(0.0),
            end_time: Some(4.0),
            from: 0.0,
            to: 100.0,
            easing: None,
        }],
        vec![
            RawModelTrack {
                target_id: "a".to_owned(),
                start_time: Some(0.0),
                end_time: Some(4.0),
                motion: RawModelMotion {
                    kind: "move".to_owned(),
                    axis: Some("y".to_owned()),
                    speed: Some(1.0),
                    range: Some([0.0, 2.0]),
                    mode: None,
                    amplitude: None,
                    phase: None,
                    ..Default::default()
                },
            },
            RawModelTrack {
                target_id: "b".to_owned(),
                start_time: Some(0.0),
                end_time: Some(4.0),
                motion: RawModelMotion {
                    kind: "oscillate".to_owned(),
                    axis: Some("z".to_owned()),
                    speed: Some(3.0),
                    range: None,
                    mode: Some("scale".to_owned()),
                    amplitude: Some(0.2),
                    phase: Some(0.0),
                    ..Default::default()
                },
            },
        ],
        4.0,
    )
    .unwrap();
    let mut session = AnimationSession::new(4.0, true, camera(), motion);
    session.play();
    for _ in 0..2000 {
        session.advance(0.016);
        let pose = session.pose();
        assert!(pose.camera.elevation.is_finite());
        assert!(pose.camera.elevation <= std::f32::consts::FRAC_PI_2 + 1e-5);
        for (_, delta) in &pose.model {
            assert!(delta.translation.is_finite());
            assert!(delta.rotation.is_finite());
            assert!(delta.scale.is_finite());
        }
    }
}

fn identity(node_id: &str, hash: &str) -> woohaa_bevy_canvas::animation_session::SessionIdentity {
    woohaa_bevy_canvas::animation_session::SessionIdentity {
        node_id: node_id.to_owned(),
        snapshot_hash: hash.to_owned(),
    }
}

#[test]
fn holder_cancels_old_session_on_select_and_ignores_late_results() {
    use woohaa_bevy_canvas::animation_session::AnimationSessionHolder;
    let mut holder = AnimationSessionHolder::default();
    let generation = holder.select(
        identity("a", "h1"),
        AnimationSession::new(4.0, false, camera(), rotate_motion()),
    );
    assert!(holder.accepts(generation));

    // 切换到另一节点：generation 前进，旧结果失效。
    let next = holder.select(
        identity("b", "h2"),
        AnimationSession::new(4.0, false, camera(), rotate_motion()),
    );
    assert_ne!(next, generation);
    assert!(!holder.accepts(generation));
    assert!(holder.accepts(next));

    holder.exit();
    assert!(!holder.is_active());
    assert!(!holder.accepts(next));
}

#[test]
fn holder_keeps_session_when_definition_unchanged() {
    use woohaa_bevy_canvas::animation_session::AnimationSessionHolder;
    let mut holder = AnimationSessionHolder::default();
    let generation = holder.select(
        identity("a", "h1"),
        AnimationSession::new(4.0, false, camera(), rotate_motion()),
    );
    let same = holder.reconcile(
        identity("a", "h1"),
        AnimationSession::new(4.0, false, camera(), rotate_motion()),
    );
    assert_eq!(same, generation);
}
