//! Opt-in hardware smoke: production effect assembly, shader, depth and capture layer.
use super::*;
use bevy::{
    asset::RenderAssetUsages,
    camera::RenderTarget,
    render::{
        RenderPlugin,
        gpu_readback::{Readback, ReadbackComplete},
        render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
        renderer::RenderAdapterInfo,
        settings::{Backends, RenderCreation, WgpuSettings},
    },
    time::TimeUpdateStrategy,
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

fn models(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut visuals: ResMut<ModelVisuals>,
    mut focus: Local<super::super::FocusVisuals>,
    resources: Res<ModelAssetTable>,
    scene: Res<CurrentScene>,
    mut done: Local<bool>,
) {
    if *done {
        return;
    }
    super::super::sync_models(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut visuals,
        &mut focus,
        &resources.0,
        &scene.0,
    );
    *done = true;
}

fn pixels(app: &mut App, image: &Handle<Image>, label: &str) -> Vec<u8> {
    let sink = Arc::new(Mutex::new(None));
    let shared = sink.clone();
    app.world_mut()
        .spawn(Readback::texture(image.clone()))
        .observe(
            move |capture: On<ReadbackComplete>, mut commands: Commands| {
                *shared.lock().unwrap() = Some(capture.data.clone());
                commands.entity(capture.entity).despawn();
            },
        );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        app.update();
        if let Some(data) = sink.lock().unwrap().take() {
            if let Ok(directory) = std::env::var("WOOHAA_RUN_ARTIFACTS") {
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::write(format!("{directory}/{label}.rgba"), &data).unwrap();
            }
            return data;
        }
        assert!(Instant::now() < deadline, "GPU readback timed out");
        std::thread::sleep(Duration::from_millis(8));
    }
}

#[test]
#[ignore = "requires a real hardware GPU; never use a software fallback"]
fn hardware_run_effect_shader_and_output_isolation() {
    let mut app = App::new();
    let plugins = DefaultPlugins
        .set(WindowPlugin {
            primary_window: None,
            exit_condition: bevy::window::ExitCondition::DontExit,
            ..default()
        })
        .set(AssetPlugin {
            file_path: format!("{}/assets", env!("CARGO_MANIFEST_DIR")),
            ..default()
        })
        .set(RenderPlugin {
            render_creation: RenderCreation::Automatic(Box::new(WgpuSettings {
                backends: Some(if cfg!(target_os = "macos") {
                    Backends::METAL
                } else {
                    Backends::VULKAN | Backends::DX12
                }),
                force_fallback_adapter: false,
                ..default()
            })),
            ..default()
        })
        .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>();
    #[cfg(feature = "wasm")]
    let plugins = plugins.disable::<bevy::winit::WinitPlugin>();
    app.add_plugins(plugins)
        .add_plugins(RunEffectPlugin)
        .init_resource::<CurrentScene>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<ModelVisuals>()
        .init_resource::<FocusRig>()
        .init_resource::<ThemeResource>()
        .insert_resource(SurfaceState {
            size: Vec2::new(640., 480.),
            pixel_ratio: 1.,
        })
        .insert_resource(GlobalAmbientLight {
            brightness: 700.,
            ..default()
        })
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_millis(
            16,
        )))
        .add_systems(Update, (models, sync).chain());
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        bevy::tasks::tick_global_task_pools_on_main_thread();
    }
    app.finish();
    app.cleanup();
    let adapter = app.world().resource::<RenderAdapterInfo>();
    let kind = format!("{:?}", adapter.device_type);
    assert!(
        kind == "DiscreteGpu" || kind == "IntegratedGpu",
        "hardware required, got {kind}"
    );
    eprintln!(
        "run effect hardware: {} {:?} {}",
        adapter.name, adapter.backend, adapter.driver_info
    );
    let model = super::super::prepare_snapshot(serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"run-fixture", "extent":4,
        "ops":[
            {"t":"box","id":"a","position":[-0.9,0.8,0],"size":[1,1.6,1],"rotation":[0,0,0],"scale":[1,1,1],"color":"#b68048"},
            {"t":"box","id":"b","position":[0.7,0.5,0.4],"size":[1.4,1,1.4],"rotation":[0,0,0],"scale":[1,1,1],"color":"#687f83"}
        ]
    })).unwrap());
    app.world_mut()
        .resource_mut::<ModelAssetTable>()
        .0
        .insert("fixture".into(), Arc::new(model));
    let mut state = app.world_mut().resource_mut::<CurrentScene>();
    state.0.nodes = serde_json::from_value(serde_json::json!([{
        "id":"film","type":"model","x":180,"y":100,"width":280,"height":260,
        "model":{"resourceKey":"fixture","signature":"run-fixture"},
        "compositeAsset":{"x":160,"y":100,"width":320,"height":280,"scopeShape":"isometric-diamond",
            "scopeGround":{"cx":320,"cy":300,"hx":170,"hz":140}},
        "aggregateRun":{"active":true}
    }]))
    .unwrap();
    state.0.run_feedback = serde_json::from_value(serde_json::json!([{
        "nodeId":"film","active":true,"operationKey":"fixture-operation","phase":"running","source":"agent","labelCode":"generating"
    }])).unwrap();
    state.0.index_primitives();
    drop(state);
    let mut image = Image::new_uninit(
        Extent3d {
            width: 640,
            height: 480,
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::default(),
    );
    image.texture_descriptor.usage |=
        TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    let target = app.world_mut().resource_mut::<Assets<Image>>().add(image);
    let camera = app
        .world_mut()
        .spawn((
            Camera3d::default(),
            ModelCanvasCamera,
            Camera {
                clear_color: ClearColorConfig::Custom(Color::srgb(0.94, 0.95, 0.93)),
                ..default()
            },
            RenderTarget::Image(target.clone().into()),
            Projection::Orthographic(crate::isometric_grid::canvas_camera_projection()),
            crate::isometric_grid::canvas_camera_transform(Vec2::new(640., 480.)),
            RenderLayers::from_layers(&[0, WORK_LAYER]),
            Msaa::Off,
            bevy::render::view::Tonemapping::None,
            bevy::render::view::DebandDither::Disabled,
        ))
        .id();
    // Use the production overview backdrop in the existing 2D work-camera pass.
    let mut backdrop = crate::canvas2d::geometry::Geometry::default();
    crate::canvas2d::draw_film_set_run_mask(
        &mut backdrop,
        app.world().resource::<ThemeResource>(),
        &app.world().resource::<CurrentScene>().0.nodes[0],
        10.,
    );
    let backdrop = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(backdrop.build());
    let material = app
        .world_mut()
        .resource_mut::<Assets<ColorMaterial>>()
        .add(ColorMaterial {
            alpha_mode: bevy::sprite_render::AlphaMode2d::Blend,
            ..default()
        });
    app.world_mut().spawn((
        Mesh2d(backdrop),
        MeshMaterial2d(material),
        Transform::IDENTITY,
    ));
    let overlay_camera = app
        .world_mut()
        .spawn((
            Camera2d,
            Camera {
                order: 1,
                clear_color: ClearColorConfig::None,
                ..default()
            },
            RenderTarget::Image(target.clone().into()),
            Transform::from_xyz(320., -240., 1000.),
            Msaa::Off,
            bevy::render::view::Tonemapping::None,
            bevy::render::view::DebandDither::Disabled,
        ))
        .id();
    // Give real asynchronous mesh/material/shader preparation a bounded batch of frames.
    for _ in 0..180 {
        app.update();
        std::thread::sleep(Duration::from_millis(8));
    }
    *app.world_mut().resource_mut::<TimeUpdateStrategy>() =
        TimeUpdateStrategy::ManualDuration(Duration::ZERO);
    let now = app.world().resource::<Time>().elapsed_secs();
    let handle = app.world().resource::<RunEffects>().entries["film"]
        .scan
        .clone()
        .unwrap();
    app.world_mut()
        .resource_mut::<Assets<RunMaterial>>()
        .get_mut(&handle)
        .unwrap()
        .timing
        .x = now - 1.;
    for _ in 0..8 {
        app.update();
    }
    let running = pixels(&mut app, &target, "running");
    app.world_mut()
        .get_mut::<Camera>(overlay_camera)
        .unwrap()
        .is_active = false;
    for _ in 0..8 {
        app.update();
    }
    let unmasked = pixels(&mut app, &target, "running-without-mask");
    assert!(
        running
            .chunks_exact(4)
            .zip(unmasked.chunks_exact(4))
            .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 3))
            .count()
            > 1000,
        "the required translucent backdrop must visibly cover the owner scope"
    );
    app.world_mut()
        .get_mut::<Camera>(overlay_camera)
        .unwrap()
        .is_active = true;
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .run_feedback
        .as_mut()
        .unwrap()
        .phase = "queued".into();
    for _ in 0..8 {
        app.update();
    }
    let queued = pixels(&mut app, &target, "queued");
    let changed = running
        .chunks_exact(4)
        .zip(queued.chunks_exact(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 3))
        .count();
    assert!(
        changed > 40,
        "scan shader must render beyond static fallback, changed {changed} pixels"
    );
    // The same camera/pose in the capture layer must see identical model bytes with effects on/off.
    app.world_mut()
        .get_mut::<Camera>(overlay_camera)
        .unwrap()
        .is_active = false;
    app.world_mut()
        .entity_mut(camera)
        .insert(RenderLayers::layer(super::super::capture::CAPTURE_LAYER));
    for _ in 0..8 {
        app.update();
    }
    let capture = pixels(&mut app, &target, "capture");
    app.world_mut().resource_mut::<RunEffectSettings>().enabled = false;
    for _ in 0..8 {
        app.update();
    }
    assert_eq!(
        capture,
        pixels(&mut app, &target, "capture-effects-disabled")
    );
    assert!(
        app.world().resource::<RunEffects>().entries["film"]
            .entities
            .is_empty()
    );
}
