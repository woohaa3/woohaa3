//! Real hardware regression: a manual shot preview must publish after GPU batching.
#![cfg(feature = "native-renderer")]
use bevy::{camera::visibility::RenderLayers, prelude::*};
use woohaa_bevy_canvas::shot_camera::{
    PreviewTarget, PreviewUpdatePolicy, ShotCameraCommands, ShotCameraConfig, ShotCameraPlugin,
    ShotCameraPreview, ShotCameraViewMask, ShotPreviewOutput, TriggerShotPreview,
    preview_readiness::{ShotPreviewReadiness, ShotPreviewReady},
};

#[test]
fn manual_preview_publishes_gpu_batched_scene() {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: None,
        exit_condition: bevy::window::ExitCondition::DontExit,
        ..default()
    }));
    app.add_plugins(ShotCameraPlugin);
    app.finish();
    app.cleanup();
    let adapter = app
        .world()
        .resource::<bevy::render::renderer::RenderAdapterInfo>();
    assert!(!adapter.name.to_lowercase().contains("swiftshader"));
    assert!(!adapter.name.to_lowercase().contains("llvmpipe"));
    eprintln!("Real adapter: {} ({:?})", adapter.name, adapter.backend);
    let mesh = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(Cuboid::new(1., 1., 1.));
    let material = app
        .world_mut()
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial {
            base_color: Color::srgb(0.8, 0.2, 0.1),
            unlit: true,
            ..default()
        });
    for i in 0..16 {
        app.world_mut().spawn((
            Mesh3d(mesh.clone()),
            MeshMaterial3d(material.clone()),
            Transform::from_xyz((i % 4) as f32 - 1.5, 0., (i / 4) as f32 - 1.5),
            RenderLayers::layer(40),
        ));
    }
    let mut config = ShotCameraConfig::from_bounds(woohaa_bevy_canvas::shot_camera::Aabb::new(
        Vec3::splat(-3.),
        Vec3::splat(3.),
    ));
    config.view_mask = ShotCameraViewMask(RenderLayers::layer(40));
    config.preview = Some(
        ShotCameraPreview::new(256, 144)
            .with_target(PreviewTarget::Offscreen)
            .with_policy(PreviewUpdatePolicy::Manual),
    );
    let rig = app.world_mut().commands().spawn_shot_camera(config);
    app.world_mut().flush();
    app.world_mut()
        .entity_mut(rig)
        .insert(ShotPreviewReadiness {
            key: rig,
            generation: 1,
            meshes: vec![mesh.id()],
            materials: vec![material.id()],
        });
    let mut published = false;
    for _ in 0..180 {
        app.world_mut()
            .write_message(TriggerShotPreview { camera: rig });
        app.update();
        if app.world().resource::<ShotPreviewReady>().matches(rig, 1) {
            published = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    assert!(
        published,
        "ready never published for a GPU-batched shot preview"
    );
    let first = read_pixels(&mut app, rig);
    assert_has_model(&first);

    // Idle manual cameras retain their published image; resuming must still publish.
    for _ in 0..6 {
        app.update();
    }
    assert_eq!(read_pixels(&mut app, rig), first);
    // Card insertion/removal can reassign an existing rig's render layer.
    let entities: Vec<Entity> = app
        .world_mut()
        .query_filtered::<Entity, With<Mesh3d>>()
        .iter(app.world())
        .collect();
    for entity in entities {
        app.world_mut()
            .entity_mut(entity)
            .insert(RenderLayers::layer(41));
    }
    app.world_mut().entity_mut(rig).insert((
        ShotCameraViewMask(RenderLayers::layer(41)),
        ShotPreviewReadiness {
            key: rig,
            generation: 2,
            meshes: vec![mesh.id()],
            materials: vec![material.id()],
        },
    ));
    for _ in 0..30 {
        app.world_mut()
            .write_message(TriggerShotPreview { camera: rig });
        app.update();
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    assert!(app.world().resource::<ShotPreviewReady>().matches(rig, 2));
    assert_has_model(&read_pixels(&mut app, rig));
}

fn read_pixels(app: &mut App, rig: Entity) -> Vec<u8> {
    use bevy::render::gpu_readback::{Readback, ReadbackComplete};
    use std::sync::{Arc, Mutex};
    let pixels = Arc::new(Mutex::new(None));
    let result = pixels.clone();
    let image = app
        .world()
        .get::<ShotPreviewOutput>(rig)
        .unwrap()
        .image
        .clone();
    app.world_mut().spawn(Readback::texture(image)).observe(
        move |event: On<ReadbackComplete>, mut commands: Commands| {
            *result.lock().unwrap() = Some(event.data.clone());
            commands.entity(event.entity).despawn();
        },
    );
    for _ in 0..60 {
        app.update();
        if let Some(data) = pixels.lock().unwrap().take() {
            return data;
        }
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
    panic!("GPU image readback timed out");
}

fn assert_has_model(pixels: &[u8]) {
    let colored = pixels
        .chunks_exact(4)
        .filter(|p| p[0] > p[1].saturating_add(30) && p[3] > 0)
        .count();
    assert!(
        colored > 50,
        "published preview has no red model pixels ({colored})"
    );
}
