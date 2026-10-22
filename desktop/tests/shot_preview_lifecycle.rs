//! Preview readiness lifecycle without creating a renderer or GPU.
use bevy::{prelude::*, render::view::NoIndirectDrawing};
use woohaa_bevy_canvas::shot_camera::{
    ShotCameraInner, ShotCameraPlugin,
    preview_readiness::{ShotPreviewReadiness, ShotPreviewView},
};

#[test]
fn direct_drawing_follows_preview_readiness_lifetime() {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, ShotCameraPlugin));
    app.init_resource::<Assets<Mesh>>();
    app.init_resource::<Assets<StandardMaterial>>();
    app.init_resource::<Assets<Image>>();
    let preview = app.world_mut().spawn_empty().id();
    let ordinary = app.world_mut().spawn_empty().id();
    let rig = app
        .world_mut()
        .spawn(ShotCameraInner {
            preview_camera: Some(preview),
            ..default()
        })
        .id();
    app.world_mut()
        .entity_mut(rig)
        .insert(ShotPreviewReadiness {
            key: rig,
            generation: 7,
            meshes: vec![],
            materials: vec![],
        });
    app.world_mut().spawn(ShotCameraInner {
        preview_camera: Some(ordinary),
        ..default()
    });
    app.update();
    assert_eq!(
        app.world()
            .get::<ShotPreviewView>(preview)
            .unwrap()
            .generation,
        7
    );
    assert!(app.world().get::<NoIndirectDrawing>(preview).is_some());
    assert!(app.world().get::<NoIndirectDrawing>(ordinary).is_none());

    app.world_mut()
        .entity_mut(rig)
        .remove::<ShotPreviewReadiness>();
    app.update();
    assert!(app.world().get::<ShotPreviewView>(preview).is_none());
    assert!(app.world().get::<NoIndirectDrawing>(preview).is_none());
}
