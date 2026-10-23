use bevy::prelude::*;
use woohaa_bevy_canvas::gizmo_layout::{GizmoView, render::GizmoPalette};
use woohaa_bevy_canvas::shot_camera::{
    Aabb, ShotCameraCommands, ShotCameraConfig, ShotCameraPlugin, ShotCameraPose, ShotGizmo,
    ShotGizmoSelection,
};

#[test]
fn moving_rig_and_changing_theme_reuse_entities_meshes_and_materials() {
    let mut app = App::new();
    app.init_resource::<Assets<Image>>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .add_plugins(ShotCameraPlugin);
    let rig = app
        .world_mut()
        .commands()
        .spawn_shot_camera(ShotCameraConfig::from_bounds(Aabb::new(
            Vec3::splat(-1.0),
            Vec3::splat(1.0),
        )));
    {
        let mut selected = app.world_mut().resource_mut::<ShotGizmoSelection>();
        selected.entities.push(rig);
        selected.view =
            GizmoView::orbit(Vec3::ZERO, 0.7, -0.5, 30.0, Vec2::new(1200.0, 800.0), 1.0);
        selected.palette = GizmoPalette {
            colors: [Color::WHITE; 5],
            accent: Color::srgb(1.0, 0.0, 0.0),
        };
    }
    app.update();
    app.update();
    let mut query = app
        .world_mut()
        .query_filtered::<(Entity, &Mesh3d), With<ShotGizmo>>();
    let initial: Vec<_> = query
        .iter(app.world())
        .map(|(entity, mesh)| (entity, mesh.0.clone()))
        .collect();
    assert_eq!(initial.len(), 125);
    let meshes = app.world().resource::<Assets<Mesh>>().len();
    let materials = app.world().resource::<Assets<StandardMaterial>>().len();
    let base = app.world().get::<ShotCameraPose>(rig).unwrap().distance;
    for i in 0..80 {
        let mut pose = app.world_mut().get_mut::<ShotCameraPose>(rig).unwrap();
        pose.azimuth = i as f32 * 0.2;
        pose.distance = base * (1.0 + 0.3 * (i as f32).sin());
        app.update();
        for (entity, mesh) in &initial {
            assert_eq!(&app.world().get::<Mesh3d>(*entity).unwrap().0, mesh);
        }
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), meshes);
        assert_eq!(
            app.world().resource::<Assets<StandardMaterial>>().len(),
            materials
        );
    }
    let handle = app
        .world()
        .get::<MeshMaterial3d<StandardMaterial>>(initial[0].0)
        .unwrap()
        .0
        .clone();
    let before = app
        .world()
        .resource::<Assets<StandardMaterial>>()
        .get(&handle)
        .unwrap()
        .base_color;
    app.world_mut()
        .resource_mut::<ShotGizmoSelection>()
        .palette
        .colors = [Color::BLACK; 5];
    app.update();
    assert_ne!(
        app.world()
            .resource::<Assets<StandardMaterial>>()
            .get(&handle)
            .unwrap()
            .base_color,
        before
    );
    app.world_mut().resource_mut::<ShotGizmoSelection>().view = None;
    app.update();
    let mut query = app.world_mut().query::<&ShotGizmo>();
    assert_eq!(query.iter(app.world()).count(), 0);
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), meshes);
    assert_eq!(
        app.world().resource::<Assets<StandardMaterial>>().len(),
        materials
    );
}
