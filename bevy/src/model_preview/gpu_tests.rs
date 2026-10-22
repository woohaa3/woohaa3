//! Opt-in real Metal regression; never run with a software renderer.
use super::*;
use bevy::{
    core_pipeline::core_3d::Opaque3d,
    render::{
        Render, RenderApp, RenderPlugin, RenderSystems,
        gpu_readback::{Readback, ReadbackComplete},
        render_phase::ViewBinnedRenderPhases,
        settings::{Backends, RenderCreation, WgpuSettings},
    },
};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

#[derive(Resource, Clone, Default)]
struct MultidrawEvidence(Arc<AtomicUsize>, Arc<AtomicUsize>);

fn observe_multidraw(
    phases: Res<ViewBinnedRenderPhases<Opaque3d>>,
    evidence: Res<MultidrawEvidence>,
    views: Query<
        (
            &bevy::render::view::ExtractedView,
            &bevy::render::view::visibility::RenderVisibleEntities,
        ),
        With<PreviewView>,
    >,
) {
    let count = phases
        .values()
        .map(|phase| phase.multidrawable_meshes.len())
        .sum();
    evidence.0.fetch_max(count, Ordering::Relaxed);
    for (view, visible) in &views {
        let Some(phase) = phases.get(&view.retained_view_entity) else {
            continue;
        };
        let expected = visible.get::<Mesh3d>().map_or(0, |v| {
            v.entities_cpu_culling.len() + v.entities_gpu_culling.len()
        });
        let counted: usize = phase
            .batchable_meshes
            .values()
            .map(|bin| bin.entities().len())
            .sum::<usize>()
            + phase
                .unbatchable_meshes
                .values()
                .map(|bin| bin.entities.len())
                .sum::<usize>();
        if !phase.multidrawable_meshes.is_empty() && expected > counted {
            evidence.1.fetch_max(expected - counted, Ordering::Relaxed);
        }
    }
}

fn update_models(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut models: ResMut<model3d::ModelVisuals>,
    mut focus: ResMut<model3d::FocusVisuals>,
    resources: Res<ModelAssetTable>,
    scene: Res<CurrentScene>,
    flags: Res<crate::app::FrameFlags>,
) {
    if flags.changed {
        model3d::sync_models(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut models,
            &mut focus,
            &resources.0,
            &scene.0,
        );
    }
}

fn snapshot(version: usize) -> crate::protocol::ModelSnapshot {
    let key = if version == 3 {
        "WOOHAA_PREVIEW_BEFORE_OPS"
    } else {
        "WOOHAA_PREVIEW_AFTER_OPS"
    };
    let ops: serde_json::Value = if let Ok(path) = std::env::var(key) {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    } else {
        (0..version)
            .map(|floor| {
                serde_json::json!({
                    "t":"box", "id":format!("floor-{floor}"),
                    "position":[0, floor as f32 * 1.2, 0], "size":[2,1,2],
                    "rotation":[0,0,0], "scale":[1,1,1], "color":"#b68048"
                })
            })
            .collect::<Vec<_>>()
            .into()
    };
    model3d::prepare_snapshot(
        serde_json::from_value(serde_json::json!({
            "sceneVersion":"woohaa-model-scene-ir-v2", "signature":format!("floors-{version}"),
            "extent":10, "ops":ops
        }))
        .unwrap(),
    )
}

fn set_version(app: &mut App, version: usize) {
    let model = snapshot(version);
    let signature = model.signature.clone();
    app.world_mut()
        .resource_mut::<ModelAssetTable>()
        .0
        .insert("building".into(), Arc::new(model));
    let nodes = serde_json::from_value(serde_json::json!([{
        "id":"building", "type":"model", "x":0, "y":0, "width":320, "height":320,
        "model":{"resourceKey":"building", "signature":signature},
        "modelPreview":{"azimuth":0.5,"elevation":0.4,"distanceScale":1}
    }]))
    .unwrap();
    app.world_mut().resource_mut::<CurrentScene>().0.nodes = nodes;
    app.world_mut()
        .resource_mut::<crate::app::FrameFlags>()
        .changed = true;
}

fn settle(app: &mut App) -> (Handle<Image>, u64) {
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        app.update();
        let state = app.world().resource::<Previews>();
        if let Some(card) = state.cards.get("building") {
            if app
                .world()
                .resource::<Ready>()
                .matches(card.camera, card.generation)
                && card.displayed == card.image
                && !app.world().get::<Camera>(card.camera).unwrap().is_active
            {
                return (card.displayed.clone(), card.generation);
            }
        }
        assert!(Instant::now() < deadline, "new preview never published");
        std::thread::sleep(Duration::from_millis(8));
    }
}

fn pixels(app: &mut App, image: Handle<Image>, label: &str) -> Vec<u8> {
    let descriptor = app
        .world()
        .resource::<Assets<Image>>()
        .get(&image)
        .unwrap()
        .texture_descriptor
        .clone();
    let result = Arc::new(Mutex::new(None));
    let sink = result.clone();
    app.world_mut().spawn(Readback::texture(image)).observe(
        move |capture: On<ReadbackComplete>, mut commands: Commands| {
            *sink.lock().unwrap() = Some(capture.data.clone());
            commands.entity(capture.entity).despawn();
        },
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        app.update();
        if let Some(raw) = result.lock().unwrap().take() {
            let row_bytes = descriptor.size.width as usize * 4;
            let stride = row_bytes.div_ceil(256) * 256;
            let data = raw
                .chunks_exact(stride)
                .take(descriptor.size.height as usize)
                .flat_map(|row| row[..row_bytes].iter().copied())
                .collect::<Vec<_>>();
            if let Ok(dir) = std::env::var("WOOHAA_PREVIEW_ARTIFACTS") {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(format!("{dir}/{label}.rgba"), &data).unwrap();
                std::fs::write(
                    format!("{dir}/{label}.json"),
                    serde_json::to_vec(&serde_json::json!({
                        "width":descriptor.size.width,
                        "height":descriptor.size.height,
                        "format":format!("{:?}",descriptor.format),
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            return data;
        }
        assert!(Instant::now() < deadline, "GPU readback timed out");
        std::thread::sleep(Duration::from_millis(8));
    }
}

fn focus_pixels(
    app: &mut App,
    camera: Entity,
    image: &Handle<Image>,
    generation: u64,
    label: &str,
) -> Vec<u8> {
    let models = app.world().resource::<model3d::ModelVisuals>();
    let meshes = models.preview_meshes("building");
    let materials = models.preview_materials("building");
    app.world_mut().entity_mut(camera).insert(PreviewView {
        camera,
        rooted: true,
        generation,
        meshes,
        materials,
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    while !app.world().resource::<Ready>().matches(camera, generation) {
        app.update();
        assert!(Instant::now() < deadline, "focused model never prepared");
        std::thread::sleep(Duration::from_millis(8));
    }
    pixels(app, image.clone(), label)
}

fn verify_focused_edit(app: &mut App) {
    let camera = app.world().resource::<Previews>().cards["building"].camera;
    let pose = *app.world().get::<Transform>(camera).unwrap();
    let projection = app.world().get::<Projection>(camera).unwrap().clone();
    let image = app
        .world_mut()
        .resource_mut::<Assets<Image>>()
        .add(make_image(UVec2::new(320, 280)));
    let camera = app
        .world_mut()
        .spawn((
            Camera3d::default(),
            Camera {
                order: -9,
                clear_color: ClearColorConfig::Custom(Color::srgb(0.9, 0.9, 0.9)),
                ..default()
            },
            RenderTarget::Image(image.clone().into()),
            pose,
            projection,
            RenderLayers::layer(0),
            Msaa::Sample4,
            bevy::render::view::Tonemapping::None,
        ))
        .id();
    app.world_mut().resource_mut::<FocusRig>().focus_node = Some("building".into());
    app.world_mut().resource_mut::<CurrentScene>().0.model_focus = Some(
        serde_json::from_value(serde_json::json!({
            "nodeId":"building", "target":[0,0,0], "yaw":0.5, "pitch":0.4, "distance":10, "fov":0.8
        }))
        .unwrap(),
    );
    // Focus changes batching to the editable/high representation on the shared root.
    app.world_mut()
        .resource_mut::<crate::app::FrameFlags>()
        .changed = true;
    app.update();
    let before = focus_pixels(app, camera, &image, 100, "focus-three-floors");
    set_version(app, 2);
    app.update();
    let after = focus_pixels(app, camera, &image, 101, "focus-two-floors");
    let changed = before
        .chunks_exact(4)
        .zip(after.chunks_exact(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8))
        .count();
    assert!(
        changed > before.len() / 4 / 20,
        "focused edit must change over 5% of pixels"
    );
    eprintln!("focused editable root changed pixels: {changed}");
}

#[test]
#[ignore = "requires real Apple Metal GPU; opt-in only"]
fn metal_multidraw_publishes_building_edit_and_history_restore() {
    let mut app = App::new();
    let plugins = DefaultPlugins
        .set(WindowPlugin {
            primary_window: None,
            exit_condition: bevy::window::ExitCondition::DontExit,
            ..default()
        })
        .set(RenderPlugin {
            render_creation: RenderCreation::Automatic(Box::new(WgpuSettings {
                backends: Some(Backends::METAL),
                ..default()
            })),
            ..default()
        })
        .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>();
    #[cfg(feature = "wasm")]
    let plugins = plugins.disable::<bevy::winit::WinitPlugin>();
    app.add_plugins(plugins);
    app.add_plugins(ModelPreviewPlugin)
        .init_resource::<CurrentScene>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<model3d::ModelVisuals>()
        .init_resource::<model3d::FocusVisuals>()
        .init_resource::<crate::app::FocusRig>()
        .init_resource::<crate::theme::ThemeResource>()
        .init_resource::<crate::app::FrameFlags>()
        .insert_resource(SurfaceState {
            size: Vec2::new(1200., 800.),
        })
        .insert_resource(GlobalAmbientLight {
            brightness: 600.,
            ..default()
        })
        .add_systems(
            Update,
            (
                update_models,
                sync,
                // Production cards use direct drawing; explicitly exercise the guarded
                // indirect path here so this regression still covers multidraw.
                |mut commands: Commands, views: Query<Entity, With<PreviewView>>| {
                    for entity in &views {
                        commands
                            .entity(entity)
                            .remove::<bevy::render::view::NoIndirectDrawing>();
                    }
                },
                |mut flags: ResMut<crate::app::FrameFlags>| flags.changed = false,
            )
                .chain(),
        );
    let evidence = MultidrawEvidence::default();
    app.sub_app_mut(RenderApp)
        .insert_resource(evidence.clone())
        .add_systems(
            Render,
            observe_multidraw
                .after(RenderSystems::Prepare)
                .before(RenderSystems::Render),
        );
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        bevy::tasks::tick_global_task_pools_on_main_thread();
    }
    app.finish();
    app.cleanup();
    set_version(&mut app, 3);
    let (first, first_generation) = settle(&mut app);
    let before = pixels(&mut app, first.clone(), "three-floors");
    assert!(
        evidence.0.load(Ordering::Relaxed) > 0,
        "must exercise real multidraw"
    );
    assert!(
        evidence.1.load(Ordering::Relaxed) > 0,
        "must reproduce the old queue undercount"
    );
    eprintln!(
        "entities omitted by the old counter: {}",
        evidence.1.load(Ordering::Relaxed)
    );
    assert!(
        before.chunks_exact(4).filter(|p| p[0] < 200).count() > 1000,
        "model must be drawn"
    );
    set_version(&mut app, 2);
    app.update();
    {
        let card = &app.world().resource::<Previews>().cards["building"];
        assert_eq!(
            card.displayed, first,
            "keep old texture while new one prepares"
        );
        assert_ne!(card.image, first);
    }
    let (second, second_generation) = settle(&mut app);
    let after = pixels(&mut app, second, "two-floors");
    assert!(second_generation > first_generation);
    let changed = before
        .chunks_exact(4)
        .zip(after.chunks_exact(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8))
        .count();
    assert!(
        changed > before.len() / 4 / 20,
        "edit must visibly change over 5% of pixels"
    );
    set_version(&mut app, 3);
    let (restored, restored_generation) = settle(&mut app);
    let restored = pixels(&mut app, restored, "restored-three-floors");
    assert!(restored_generation > second_generation);
    // Rebuilt coplanar geometry can reorder equal-depth fragments at seams.
    // Require the restored image to match within a small raster tolerance.
    let difference: usize = before
        .iter()
        .zip(&restored)
        .map(|(a, b)| a.abs_diff(*b) as usize)
        .sum();
    let restored_pixels = before
        .chunks_exact(4)
        .zip(restored.chunks_exact(4))
        .filter(|(a, b)| a != b)
        .count();
    assert!(
        difference as f64 / (before.len() as f64) < 0.1 && restored_pixels < before.len() / 4 / 100,
        "history restore must redraw matching geometry"
    );
    eprintln!(
        "changed pixels: {changed}; restore differing pixels: {restored_pixels}; restore mean channel difference: {}",
        difference as f64 / before.len() as f64
    );
    verify_focused_edit(&mut app);
    eprintln!(
        "Metal multidraw: generations {first_generation}->{second_generation}->{restored_generation}; edit changed pixels and restore matched"
    );
}
