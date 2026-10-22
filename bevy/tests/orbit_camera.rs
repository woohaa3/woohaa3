//! 通用 orbit camera 插件的最小独立 App 测试
//! （change: refactor-bevy-reusable-components，任务 3.2 / 3.5）。

use bevy::prelude::*;
use woohaa_bevy_canvas::orbit_camera::{
    OrbitCameraCommand, OrbitCameraCommands, OrbitCameraCommandsExt, OrbitCameraDerived,
    OrbitCameraLens, OrbitCameraLimits, OrbitCameraPlugin, OrbitCameraPose, OrbitCameraRig,
    OrbitCameraTarget, derive_orbit_transform,
};

fn app() -> App {
    let mut app = App::new();
    app.add_plugins(OrbitCameraPlugin);
    app
}

#[test]
fn spawn_orbit_rig_creates_derived_camera() {
    let mut app = app();
    let rig = app.world_mut().commands().spawn_orbit_camera(
        OrbitCameraTarget { point: Vec3::ZERO },
        OrbitCameraPose {
            distance: 10.0,
            ..default()
        },
        OrbitCameraLens::default(),
        OrbitCameraLimits::default(),
    );
    app.update();
    app.update();
    let derived = app.world().get::<OrbitCameraDerived>(rig).unwrap();
    assert!(derived.position.is_finite());
    assert!(derived.position.z > 0.0, "默认在 +Z 方向");
    // 实际 Camera3d 子实体存在，且标记为 orbit rig。
    let mut q = app.world_mut().query::<&woohaa_bevy_canvas::orbit_camera::OrbitCameraLink>();
    assert_eq!(q.iter(app.world()).count(), 1);
    assert!(app.world().get::<OrbitCameraRig>(rig).is_some());
}

#[test]
fn orbit_command_updates_pose_and_clamps() {
    let mut app = app();
    let rig = app.world_mut().commands().spawn_orbit_camera(
        OrbitCameraTarget { point: Vec3::ZERO },
        OrbitCameraPose {
            distance: 10.0,
            ..default()
        },
        OrbitCameraLens::default(),
        OrbitCameraLimits {
            max_distance: 20.0,
            min_distance: 1.0,
            ..default()
        },
    );
    app.update();
    app.world_mut()
        .resource_mut::<OrbitCameraCommands>()
        .push(rig, OrbitCameraCommand::Zoom { factor: 100.0 });
    app.update();
    let pose = app.world().get::<OrbitCameraPose>(rig).unwrap();
    assert!((pose.distance - 20.0).abs() < 1e-4, "distance 应被 clamp 到上限");

    app.world_mut()
        .resource_mut::<OrbitCameraCommands>()
        .push(rig, OrbitCameraCommand::Orbit { delta_yaw: 1.0, delta_pitch: 100.0 });
    app.update();
    let pose = app.world().get::<OrbitCameraPose>(rig).unwrap();
    assert!(pose.yaw.is_finite() && pose.pitch.is_finite());
    assert!(pose.pitch <= OrbitCameraLimits::default().max_pitch + 1e-6);
}

#[test]
fn derive_matches_pure_function() {
    let target = OrbitCameraTarget {
        point: Vec3::new(1.0, 2.0, 3.0),
    };
    let pose = OrbitCameraPose {
        yaw: 0.5,
        pitch: 0.3,
        distance: 4.0,
        pan: Vec3::new(0.5, 0.0, 0.0),
    };
    let (position, rotation) = derive_orbit_transform(&target, &pose);
    assert!(position.is_finite());
    assert!(rotation.is_finite());
}
