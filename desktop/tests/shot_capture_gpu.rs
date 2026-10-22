//! Opt-in real GPU regression; never run with a software adapter.
use bevy::prelude::*;
use woohaa_bevy_canvas::shot_camera::{
    Aabb, ShotCameraCommands, ShotCameraConfig, ShotCameraDerived, ShotCameraPlugin,
    ShotCaptureEnqueue, ShotCaptureQueue, ShotCaptureResults,
    preview_readiness::ShotPreviewReadiness, request_capture,
};

#[test]
#[ignore = "requires a real hardware GPU; run explicitly on a desktop machine"]
fn records_offscreen_shot_after_gpu_resources_are_ready() {
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
    app.finish();
    app.cleanup();
    let adapter = app
        .world()
        .resource::<bevy::render::renderer::RenderAdapterInfo>();
    eprintln!(
        "capture GPU: {} ({:?}, {:?})",
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
    let model = app
        .world_mut()
        .spawn((
            Mesh3d(mesh.clone()),
            MeshMaterial3d(material.clone()),
            Transform::default(),
        ))
        .id();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.pose.distance = 6.0;
    config.preview = None;
    let rig = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    let generation = app
        .world()
        .get::<ShotCameraDerived>(rig)
        .unwrap()
        .generation;
    app.world_mut()
        .entity_mut(rig)
        .insert(ShotPreviewReadiness {
            key: rig,
            generation,
            meshes: vec![mesh.id()],
            materials: vec![material.id()],
        });
    // Repeated requests exercise frame-by-frame video sampling and cleanup.
    for frame_index in 0..3 {
        app.world_mut()
            .get_mut::<Transform>(model)
            .unwrap()
            .translation
            .x = (frame_index as f32 - 1.0) * 0.5;
        let world = app.world_mut();
        let mut queue = world.remove_resource::<ShotCaptureQueue>().unwrap();
        let mut results = world.remove_resource::<ShotCaptureResults>().unwrap();
        let (request_id, outcome) =
            request_capture(&mut queue, &mut results, rig, 1280, 720, generation);
        assert_eq!(outcome, ShotCaptureEnqueue::Accepted);
        world.insert_resource(queue);
        world.insert_resource(results);
        let mut captured = false;
        for _ in 0..300 {
            app.update();
            let mut results = app.world_mut().resource_mut::<ShotCaptureResults>();
            assert!(
                results.failures.is_empty(),
                "capture failed: {:?}",
                results.failures
            );
            if let Some(frame) = results.completed.pop() {
                assert_eq!(frame.request_id, request_id);
                assert_eq!((frame.width, frame.height), (1280, 720));
                assert_eq!(frame.rgba.len(), 1280 * 720 * 4);
                assert!(
                    frame
                        .rgba
                        .chunks_exact(4)
                        .any(|rgba| rgba[0] > 180 && rgba[1] < 80 && rgba[2] < 80 && rgba[3] > 200),
                    "capture must contain the red model, not just the clear color"
                );
                captured = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        assert!(captured, "capture never completed for frame {frame_index}");
    }
}
