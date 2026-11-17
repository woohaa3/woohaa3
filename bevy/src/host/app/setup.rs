use bevy::prelude::*;

use crate::{canvas2d, model3d, orbit_camera, theme::ThemeResource};

pub(super) fn setup_2d(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<ColorMaterial>>,
    assets: Res<AssetServer>,
) {
    canvas2d::setup(&mut commands, &mut meshes, &mut materials, &assets);
}

pub(super) fn setup_3d(
    mut commands: Commands,
    mut materials: ResMut<Assets<StandardMaterial>>,
    theme: Res<ThemeResource>,
) {
    let camera = model3d::setup_camera(&mut commands);
    model3d::setup_grid(&mut commands, &theme);

    // 主观察相机由一个通用 orbit rig 拥有其 target/pose/lens/limits；adapter（focus 系统）
    // 在聚焦期间投影 scene.modelFocus 到该 rig，非聚焦时挂起 rig 并保留正交 home。
    let rig = commands
        .spawn((
            Name::new("focus-observer-rig"),
            orbit_camera::OrbitCameraRig,
            orbit_camera::OrbitCameraTarget::default(),
            orbit_camera::OrbitCameraPose {
                distance: 300.0,
                ..default()
            },
            orbit_camera::OrbitCameraLens {
                projection: orbit_camera::OrbitProjection::Perspective {
                    fov: orbit_camera::ORBIT_DEFAULT_FOV,
                },
                near: model3d::focus::FOCUS_NEAR,
                far: model3d::focus::FOCUS_FAR,
            },
            orbit_camera::OrbitCameraLimits {
                min_distance: model3d::focus::FOCUS_OBSERVER_MIN_DISTANCE,
                max_distance: model3d::focus::FOCUS_OBSERVER_MAX_DISTANCE,
                ..default()
            },
            orbit_camera::OrbitCameraDerived::default(),
            orbit_camera::OrbitCameraInner {
                camera: Some(camera),
            },
            // 初始即挂起：正交 home 由 focus adapter 写。
            orbit_camera::OrbitCameraSuspended,
        ))
        .id();
    commands
        .entity(camera)
        .insert(orbit_camera::OrbitCameraLink(rig));
    commands.insert_resource(FocusObserverRig(rig));

    commands.init_resource::<model3d::ModelVisuals>();
    commands.init_resource::<model3d::FocusVisuals>();
    commands.init_resource::<model3d::shot_adapter::ShotAdapterState>();
    commands.init_resource::<model3d::capture::ShotCaptureRouting>();
    let _ = &mut materials;
}

/// 主观察相机绑定的 orbit rig（focus adapter 写入点）。
#[derive(Resource, Clone, Copy, Debug)]
pub(crate) struct FocusObserverRig(pub(crate) Entity);
