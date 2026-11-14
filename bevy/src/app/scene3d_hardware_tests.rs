use super::*;
use crate::{
    bridge,
    protocol::{
        GraphNode, ModelAssetDescriptor, ModelOp, ModelReference, NodePosition,
        Scene,
    },
};
use bevy::{
    asset::RenderAssetUsages,
    camera::RenderTarget,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
};
use std::sync::{Arc, Mutex};

fn descriptor(i: usize, parent_changed: bool) -> ModelAssetDescriptor {
    let key = if parent_changed && i == 0 {
        "parent".to_owned()
    } else {
        format!("asset-{i}")
    };
    ModelAssetDescriptor {
        resource_version: crate::protocol::MODEL_ASSET_VERSION.into(),
        resource_key: key.clone(),
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.into()),
        signature: key,
        extent: 2.,
        aabb: None,
        ops: vec![
            ModelOp::Group {
                id: "parent".into(),
                parent: None,
                position: [0.; 3],
                rotation: if parent_changed && i == 0 {
                    [0., 45., 0.]
                } else {
                    [0.; 3]
                },
                scale: if parent_changed && i == 0 {
                    [0.5; 3]
                } else {
                    [1.; 3]
                },
            },
            ModelOp::Box {
                id: "box".into(),
                parent: Some("parent".into()),
                position: [0.; 3],
                rotation: [0.; 3],
                scale: [1.; 3],
                color: Some(if i == 0 { "#ff0000" } else { "#00ff00" }.into()),
                material: None,
                size: [2.; 3],
            },
        ],
    }
}

fn scene(swap: bool, parent_changed: bool) -> Scene {
    let mut scene = Scene::default();
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({"width":256.,"height":256.,"pixelRatio":1.}))
            .unwrap(),
    );
    for i in 0..2 {
        let asset = descriptor(i, parent_changed);
        let depth = if (i == 0) ^ swap { 0.5 } else { -0.5 };
        let point = crate::isometric_grid::canvas_camera_rotation()
            * Vec3::new(if i == 0 { -0.35 } else { 0.35 }, 0., depth);
        let mut node: GraphNode = serde_json::from_value(serde_json::json!({"id":format!("n{i}"),"type":"model", "x":9000.,"y":0.,"width":100.,"height":50.,
            "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":format!("i{i}"),
              "transform":{"version":"shared-world-v1","position":{"u":point.x,"v":-point.z,"h":point.y},"rotation":[0,0,0,1],"scale":1}}})).unwrap();
        node.model = Some(ModelReference { ground_anchor_local: None, part_rotations: None, part_positions: None,
            resource_key: asset.resource_key,
            scene_version: asset.scene_version,
            signature: asset.signature,
        });
        scene.nodes.push(node);
    }
    scene
}

#[test]
#[ignore = "requires hardware GPU"]
fn shared_world_production_frame_hardware() {
    use crate::model3d::preview::{readiness, render};
    bridge::clear_model_assets();
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: None,
        exit_condition: bevy::window::ExitCondition::DontExit,
        ..default()
    }));
    let ready = readiness::install(&mut app);
    app.init_resource::<model3d::ModelVisuals>()
        .init_resource::<model3d::FocusVisuals>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<CurrentScene>()
        .init_resource::<FrameFlags>()
        .init_resource::<FocusRig>()
        .init_resource::<AnimationCameraState>()
        .init_resource::<model3d::capture::ShotCaptureRouting>()
        .init_resource::<crate::render_work::RenderWork>()
        .init_resource::<super::super::NodeIndex>()
        .init_resource::<super::super::positions::PositionIndex>()
        .init_resource::<SurfaceState>()
        .init_resource::<ThemeResource>()
        .init_resource::<super::super::TextureBatch>()
        .init_resource::<super::super::ModelTextureBatch>()
        .init_resource::<crate::canvas2d::focus_details::FocusDetailBatch>()
        .add_systems(
            Update,
            (
                super::super::input::ingest_bridge,
                super::super::input::sync_surface,
                sync_models,
            )
                .chain(),
        );
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    app.finish();
    app.cleanup();
    let info = app
        .world()
        .resource::<bevy::render::renderer::RenderAdapterInfo>();
    println!(
        "hardware adapter: {} {:?} {:?}",
        info.name, info.backend, info.device_type
    );
    assert_ne!(format!("{:?}", info.device_type), "Cpu");
    app.world_mut()
        .spawn((Window::default(), bevy::window::PrimaryWindow));
    let mut image = Image::new_uninit(
        Extent3d {
            width: 256,
            height: 256,
            ..default()
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |= TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT;
    let image = app.world_mut().resource_mut::<Assets<Image>>().add(image);
    let mut queue = app.world_mut().commands();
    let camera = crate::model3d::grid::setup_camera(&mut queue);
    queue
        .entity(camera)
        .insert(RenderTarget::Image(image.clone().into()));
    app.world_mut().flush();
    let capture = |app: &mut App, name: &str| -> Vec<u8> {
        for _ in 0..20 {
            app.update();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let pixels = Arc::new(Mutex::new(None));
        readiness::enqueue_readback(
            &mut app.world_mut().commands(),
            image.clone(),
            pixels.clone(),
            ready.clone(),
        );
        app.world_mut().flush();
        for _ in 0..2000 {
            app.update();
            if pixels.lock().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let data = pixels
            .lock()
            .unwrap()
            .take()
            .expect("GPU readback timed out");
        let data = render::normalize_readback(&data, 256, 256);
        let dir = std::env::var("WOOHAA_WORLD_EVIDENCE").unwrap();
        std::fs::write(
            format!("{dir}/{name}.png"),
            render::encode_png(&data, 256, 256).unwrap(),
        )
        .unwrap();
        println!(
            "{name}: center={:?} red={} green={}",
            &data[(128 * 256 + 128) * 4..(128 * 256 + 128) * 4 + 4],
            data.chunks_exact(4)
                .filter(|p| p[0] > 200 && p[1] < 80)
                .count(),
            data.chunks_exact(4)
                .filter(|p| p[1] > 200 && p[0] < 80)
                .count()
        );
        data
    };
    bridge::queue_scene(scene(false, false));
    let missing = capture(&mut app, "missing");
    for i in 0..2 {
        bridge::queue_model_asset(descriptor(i, false));
    }
    let original = capture(&mut app, "original");
    assert_ne!(missing, original);
    bridge::queue_positions(
        (0..2)
            .map(|i| NodePosition {
                id: format!("n{i}"),
                x: -9000.,
                y: 3000.,
            })
            .collect(),
        None,
    );
    let start = app.world().resource::<Time>().elapsed_secs_f64();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while app.world().resource::<Time>().elapsed_secs_f64() - start < 1.1 {
        assert!(
            std::time::Instant::now() < deadline,
            "virtual time did not advance"
        );
        app.update();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let elapsed = app.world().resource::<Time>().elapsed_secs_f64() - start;
    println!("card relocation virtual elapsed={elapsed:.3}s");
    for id in ["n0", "n1"] {
        assert!(app
            .world()
            .resource::<model3d::ModelVisuals>()
            .test_root(id)
            .is_some());
    }
    let reordered = capture(&mut app, "reordered");
    assert_eq!(original, reordered);
    bridge::queue_scene(scene(true, false));
    let swapped = capture(&mut app, "swapped");
    let center = (128 * 256 + 128) * 4;
    assert!(original[center] > original[center + 1] && swapped[center + 1] > swapped[center]);
    bridge::queue_model_asset(descriptor(0, true));
    bridge::queue_scene(scene(true, true));
    let parent = capture(&mut app, "parent");
    assert_ne!(swapped, parent);
    bridge::clear_model_assets();
    let released = capture(&mut app, "released");
    assert_eq!(missing, released);
    bridge::queue_model_asset(descriptor(0, true));
    bridge::queue_model_asset(descriptor(1, true));
    let restored = capture(&mut app, "restored");
    assert_eq!(parent, restored);
    bridge::clear_model_assets();
}
