//! Opt-in regression for the persistent preview Image used by shot cards.
//! This must exercise preview readiness, not the separate capture camera.
use bevy::{
    prelude::*,
    render::view::window::screenshot::{Screenshot, ScreenshotCaptured},
};
use woohaa_bevy_canvas::shot_camera::{
    Aabb, PreviewUpdatePolicy, ShotCameraCommands, ShotCameraConfig, ShotCameraPlugin,
    ShotCameraPreview, ShotPreviewOutput, TriggerShotPreview,
    preview_readiness::{ShotPreviewReadiness, ShotPreviewReady},
};

#[derive(Resource, Default)]
struct PreviewPixels(Option<Image>);

#[test]
#[ignore = "requires a real hardware GPU; run explicitly on a desktop machine"]
fn publishes_manual_preview_only_after_matching_gpu_frame_is_ready() {
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                primary_window: None,
                exit_condition: bevy::window::ExitCondition::DontExit,
                ..default()
            })
            .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>(),
    );
    app.add_plugins(ShotCameraPlugin);
    app.init_resource::<PreviewPixels>();
    app.finish();
    app.cleanup();
    let adapter = app
        .world()
        .resource::<bevy::render::renderer::RenderAdapterInfo>();
    eprintln!(
        "preview GPU: {} ({:?}, {:?})",
        adapter.name, adapter.device_type, adapter.backend
    );
    assert!(
        matches!(
            format!("{:?}", adapter.device_type).as_str(),
            "IntegratedGpu" | "DiscreteGpu"
        ),
        "software/unknown GPU must not run this test"
    );

    let mesh = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(Cuboid::new(2.0, 2.0, 2.0));
    let material = app
        .world_mut()
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial {
            base_color: Color::srgb(1.0, 0.0, 0.0),
            unlit: true,
            ..default()
        });
    app.world_mut().spawn((
        Mesh3d(mesh.clone()),
        MeshMaterial3d(material.clone()),
        Transform::default(),
    ));
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.pose.distance = 6.0;
    config.preview =
        Some(ShotCameraPreview::new(320, 180).with_policy(PreviewUpdatePolicy::Manual));
    let rig = app.world_mut().commands().spawn_shot_camera(config);
    app.update();

    // Initial cover, then a new content generation: neither may remain hidden
    // forever while the separate capture path can already record successfully.
    for generation in [41, 42] {
        app.world_mut()
            .entity_mut(rig)
            .insert(ShotPreviewReadiness {
                key: rig,
                generation,
                meshes: vec![mesh.id()],
                materials: vec![material.id()],
            });
        assert!(
            !app.world()
                .resource::<ShotPreviewReady>()
                .matches(rig, generation),
            "an earlier generation must not publish the replacement cover"
        );
        let mut confirmed = false;
        for _ in 0..180 {
            app.world_mut()
                .write_message(TriggerShotPreview { camera: rig });
            app.update();
            if app
                .world()
                .resource::<ShotPreviewReady>()
                .matches(rig, generation)
            {
                confirmed = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        assert!(
            confirmed,
            "preview generation {generation} never became ready"
        );

        // Read the persistent preview itself, without request_capture (which
        // creates its own camera and can mask preview publication failures).
        let output = app.world().get::<ShotPreviewOutput>(rig).unwrap().clone();
        assert_eq!(output.size, UVec2::new(320, 180));
        app.world_mut().resource_mut::<PreviewPixels>().0 = None;
        app.world_mut()
            .spawn(Screenshot::image(output.image))
            .observe(
                |event: On<ScreenshotCaptured>, mut pixels: ResMut<PreviewPixels>| {
                    pixels.0 = Some(event.image.clone());
                },
            );
        for _ in 0..180 {
            app.world_mut()
                .write_message(TriggerShotPreview { camera: rig });
            app.update();
            if app.world().resource::<PreviewPixels>().0.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        let image = app
            .world_mut()
            .resource_mut::<PreviewPixels>()
            .0
            .take()
            .expect("preview Image readback never completed");
        assert_eq!(image.texture_descriptor.size.width, 320);
        assert_eq!(image.texture_descriptor.size.height, 180);
        assert!(
            image
                .data
                .as_ref()
                .unwrap()
                .chunks_exact(4)
                .any(|rgba| { rgba[0] > 180 && rgba[1] < 80 && rgba[2] < 80 && rgba[3] > 200 }),
            "published preview must contain the red model, not a gray clear color"
        );
        eprintln!("preview generation {generation}: ready with model pixels");
    }
}
