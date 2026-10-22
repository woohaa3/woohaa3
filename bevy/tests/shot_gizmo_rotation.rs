use bevy::prelude::*;
use woohaa_bevy_canvas::shot_camera::{
    Aabb, SHOT_ELEVATION_ARC_SEGMENTS, ShotCameraCommands, ShotCameraConfig, ShotCameraDerived,
    ShotCameraPlugin, ShotCameraPose, ShotGizmo, ShotGizmoSelection,
};

#[test]
fn rotating_rig_reuses_gizmo_entities_and_moves_every_part() {
    check_gizmo_updates(false);
}

#[test]
fn resizing_ring_reuses_every_entity_and_mesh() {
    check_gizmo_updates(true);
}

fn check_gizmo_updates(resize: bool) {
    let mut app = App::new();
    app.init_resource::<Assets<Image>>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .add_plugins(ShotCameraPlugin);
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let rig = app.world_mut().commands().spawn_shot_camera(config);
    app.world_mut().resource_mut::<ShotGizmoSelection>().entities.push(rig);
    app.update();
    app.update();
    let focus = app.world().get::<ShotCameraDerived>(rig).unwrap().focus;
    let derived = *app.world().get::<ShotCameraDerived>(rig).unwrap();
    let base_radius = (woohaa_bevy_canvas::shot_camera::shot_view_half_height(
        (derived.position - focus).length(),
        derived.fov,
    ) * 0.5)
        .max(0.1);
    let base_distance = (app.world().get::<ShotCameraDerived>(rig).unwrap().position - focus).length();
    let initial_angle = app.world().get::<ShotCameraPose>(rig).unwrap().azimuth;
    let mut query = app.world_mut().query_filtered::<(Entity, &Transform, &Mesh3d), With<ShotGizmo>>();
    let initial: Vec<_> = query.iter(app.world())
        .map(|(id, transform, mesh)| (id, *transform, mesh.0.clone())).collect();
    assert_eq!(initial.len(), 11 + SHOT_ELEVATION_ARC_SEGMENTS as usize);
    let mesh_count = app.world().resource::<Assets<Mesh>>().len();
    for step in 1..=40 {
        let angle = step as f32 * 0.2;
        app.world_mut().get_mut::<ShotCameraPose>(rig).unwrap().azimuth = initial_angle + angle;
        if resize {
            app.world_mut().get_mut::<ShotCameraPose>(rig).unwrap().distance =
                base_distance * (1.0 + 0.4 * (step as f32 * 0.3).sin());
        }
        app.update();
        let ratio = (app.world().get::<ShotCameraDerived>(rig).unwrap().position - focus).length() / base_distance;
        let rotation = Quat::from_rotation_y(angle);
        for (id, start, mesh) in &initial {
            let current = app.world().get::<Transform>(*id).expect("旋转不得销毁 gizmo 实体");
            let expected = focus + rotation * (start.translation - focus) * ratio;
            assert!(current.translation.abs_diff_eq(expected, 1e-4));
            // 线段保留最小可见线宽；环和相机本体均匀缩放。
            let expected_scale = if start.scale == Vec3::ONE {
                Vec3::splat(ratio)
            } else {
                let width = (base_radius * ratio * 0.012).max(0.01);
                Vec3::new(width, start.scale.y * ratio, width)
            };
            assert!(current.scale.abs_diff_eq(expected_scale, 1e-4));
            assert_eq!(&app.world().get::<Mesh3d>(*id).unwrap().0, mesh);
        }
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), mesh_count);
    }
}
