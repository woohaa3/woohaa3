//! Shot camera 仰角（竖直半圆）集成测试
//! （change: add-shot-camera-elevation-control）。
//!
//! 覆盖：可变仰角取景、越界奇点钳制、elevation 编辑轴、以及相对起始 pose 的净变化判定。

use bevy::prelude::*;
use woohaa_bevy_canvas::shot_camera::{
    Aabb, SHOT_CAMERA_ELEVATION_LIMIT, ShotCameraAxis, ShotCameraCommands, ShotCameraConfig,
    ShotCameraDerived, ShotCameraPlugin, ShotCameraPose, begin_edit, commit_edit,
    elevation_from_vertical_drag, resolve_shot_camera, update_elevation,
};

#[test]
fn resolve_supports_variable_elevation() {
    let aabb = Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0));
    // 水平：相机与 focus 同高。
    let horizontal = resolve_shot_camera(&aabb, 0.0, 0.0, 100.0, 16.0 / 9.0, Vec3::ZERO).unwrap();
    assert!((horizontal.position.y - horizontal.focus.y).abs() < 1e-4);
    // 越界仰角钳入奇点容差，仍严格位于上方。
    let clamped = resolve_shot_camera(&aabb, 0.0, 100.0, 100.0, 16.0 / 9.0, Vec3::ZERO).unwrap();
    assert!((clamped.elevation - SHOT_CAMERA_ELEVATION_LIMIT).abs() < 1e-6);
    assert!(clamped.position.y > clamped.focus.y);
}

#[test]
fn edit_elevation_axis_moves_and_clamps() {
    let pose = ShotCameraPose::new(0.3, 10.0);
    let mut session = begin_edit(
        Entity::from_raw_u32(3).unwrap(),
        ShotCameraAxis::Elevation,
        None,
        pose,
        5.0,
    );
    // 向上拖动（负 y）增大仰角：-100/800 屏 = +π/8。
    let event = update_elevation(&mut session, -100.0, 800.0);
    assert!(
        matches!(event, woohaa_bevy_canvas::shot_camera::ShotEditEvent::Updated { moved, .. } if moved)
    );
    assert!(
        (session.current_pose.elevation - (pose.elevation + std::f32::consts::FRAC_PI_8)).abs()
            < 1e-5
    );
    // azimuth/distance 不受影响。
    assert!((session.current_pose.azimuth - pose.azimuth).abs() < 1e-9);
    assert!((session.current_pose.distance - pose.distance).abs() < 1e-9);

    // 越界钳到奇点容差。
    let clamped = elevation_from_vertical_drag(0.0, -10_000.0, 800.0);
    assert!((clamped - SHOT_CAMERA_ELEVATION_LIMIT).abs() < 1e-6);
}

#[test]
fn elevation_change_commits_and_cancel_restores() {
    let pose = ShotCameraPose::new(0.0, 10.0);
    let mut moved = begin_edit(
        Entity::from_raw_u32(4).unwrap(),
        ShotCameraAxis::Elevation,
        None,
        pose,
        5.0,
    );
    let _ = update_elevation(&mut moved, -200.0, 800.0);
    assert!(
        commit_edit(&moved).is_some(),
        "elevation 有净变化应发布 commit"
    );

    // 无净变化不提交。
    let same = begin_edit(
        Entity::from_raw_u32(4).unwrap(),
        ShotCameraAxis::Elevation,
        None,
        pose,
        5.0,
    );
    assert!(commit_edit(&same).is_none());
}

#[test]
fn changing_elevation_re_derives_runtime_camera() {
    // 回归：pose 签名必须包含 elevation，否则 elevation 变化被去抖跳过，镜头不会实时生效。
    let mut app = App::new();
    app.init_resource::<Assets<Image>>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .add_plugins(ShotCameraPlugin);
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let rig = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    let before = *app.world().get::<ShotCameraDerived>(rig).unwrap();

    // 只改 elevation；期望下一帧重新派生（position 变化）。
    app.world_mut()
        .get_mut::<ShotCameraPose>(rig)
        .unwrap()
        .elevation = SHOT_CAMERA_ELEVATION_LIMIT;
    app.update();
    let after = *app.world().get::<ShotCameraDerived>(rig).unwrap();
    assert!(
        after.position != before.position,
        "elevation 变化应重新派生相机 position"
    );
    assert!(
        after.generation > before.generation,
        "elevation 变化应推进 generation"
    );
}
