//! preview 单元测试（change: refactor-bevy-rust-file-size，任务 3.4 / design D4）。
//!
//! 由 `preview.rs` 内联测试移动而来，断言与覆盖完全保留。

use super::render::{background_color, encode_png, normalize_readback, render_preview};
use crate::model3d::scene;
use crate::protocol::ModelOp;
use crate::renderer_protocol::{CaptureOptions, RENDERER_PROTOCOL_VERSION, RenderRequest};

pub(super) fn request(ops: Vec<ModelOp>, extent: f32, capture: CaptureOptions) -> RenderRequest {
    RenderRequest {
        protocol_version: RENDERER_PROTOCOL_VERSION.to_owned(),
        request_id: "req".to_owned(),
        scene_version: crate::protocol::MODEL_SCENE_IR_V2.to_owned(),
        signature: "sig".to_owned(),
        extent,
        ops,
        capture,
        placement: None,
        motion: None,
        world: None,
    }
}

#[test]
fn background_transparent_is_none() {
    assert_eq!(background_color("transparent"), bevy::prelude::Color::NONE);
    assert_eq!(background_color("#112233"), scene::parse_hex("#112233"));
}

#[test]
fn png_encoding_produces_signature() {
    let pixels = vec![128u8; 4 * 4 * 4];
    let png = encode_png(&pixels, 4, 4).expect("png");
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
}

#[test]
fn png_encoding_rejects_short_buffer() {
    assert!(encode_png(&[0, 0, 0], 4, 4).is_err());
}

#[test]
fn readback_is_trimmed_to_expected() {
    let data = vec![7u8; 4 * 4 * 4 + 12];
    assert_eq!(normalize_readback(&data, 4, 4).len(), 4 * 4 * 4);
}

#[test]
fn readback_removes_gpu_padding_from_each_row() {
    let mut padded = vec![255u8; 512];
    padded[..12].fill(1);
    padded[256..268].fill(2);
    assert_eq!(
        normalize_readback(&padded, 3, 2),
        [vec![1u8; 12], vec![2u8; 12]].concat()
    );
}

#[test]
fn native_output_uses_original_high_geometry_and_exact_primitive_identity() {
    use crate::model3d::{resources::SharedResources, scene::ModelGeometry};
    use bevy::prelude::*;
    let mut resources = SharedResources::default();
    let mut meshes = Assets::<Mesh>::default();
    let first = ModelGeometry::Sphere { radius: 1.00001 };
    let second = ModelGeometry::Sphere { radius: 1.00002 };
    let a = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let again = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let b = super::render::high_mesh(&mut resources, &mut meshes, &second).unwrap();
    assert_eq!(a, again);
    assert_ne!(
        a, b,
        "native must not round distinct dimensions into one cache key"
    );
    assert_eq!(meshes.get(&a).unwrap().indices().unwrap().len() / 3, 528);
    let expected = crate::model3d::mesh::build_mesh(&first).unwrap();
    assert_eq!(
        meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_POSITION),
        expected.attribute(Mesh::ATTRIBUTE_POSITION)
    );
    assert_eq!(
        meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_NORMAL),
        expected.attribute(Mesh::ATTRIBUTE_NORMAL)
    );
}

#[test]
fn native_custom_meshes_with_equal_counts_preserve_distinct_vertices_and_topology() {
    use crate::model3d::{resources::SharedResources, scene::ModelGeometry};
    use bevy::prelude::*;
    let mut resources = SharedResources::default();
    let mut meshes = Assets::<Mesh>::default();
    let first = ModelGeometry::Mesh {
        vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
        faces: vec![[0, 1, 2]],
        normals: None,
        uvs: None,
        colors: None,
    };
    let moved = ModelGeometry::Mesh {
        vertices: vec![[0., 0., 0.], [2., 0., 0.], [0., 1., 0.]],
        faces: vec![[0, 1, 2]],
        normals: None,
        uvs: None,
        colors: None,
    };
    let reversed = ModelGeometry::Mesh {
        vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
        faces: vec![[0, 2, 1]],
        normals: None,
        uvs: None,
        colors: None,
    };
    let a = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let b = super::render::high_mesh(&mut resources, &mut meshes, &moved).unwrap();
    let c = super::render::high_mesh(&mut resources, &mut meshes, &reversed).unwrap();
    assert_ne!(a, b);
    assert_ne!(a, c);
    assert_ne!(b, c);
    assert_ne!(
        meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_POSITION),
        meshes.get(&b).unwrap().attribute(Mesh::ATTRIBUTE_POSITION)
    );
    assert_eq!(
        meshes
            .get(&c)
            .unwrap()
            .indices()
            .unwrap()
            .iter()
            .collect::<Vec<_>>(),
        vec![0, 2, 1]
    );
    assert_eq!(
        super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap(),
        a
    );
    assert_eq!(resources.simplification_diagnostics()["pending"], 0);
}

/// 端到端：用真实 GPU 适配器渲染一个 V2 人物 fixture，验证非空且 PNG 签名正确。
///
/// 默认 `#[ignore]`：无 GPU 的 CI 容器里 lavapipe/llvmpipe 可能在 shader JIT 阶段
/// 直接 SIGILL（进程级崩溃，非可捕获错误）。macOS/Metal 开发机上已验证可跑通。显式运行：
/// `cargo test --features native-renderer -- --ignored native_renderer_png`
#[test]
#[ignore = "需要可用 GPU 适配器（macOS Metal 已验证）；无 GPU 时由 client 呈现 renderer-unavailable"]
fn native_renderer_png() {
    let ops = humanoid_ops();
    let capture = CaptureOptions {
        width: 128,
        height: 128,
        background: "#101010".to_owned(),
        camera_preset: "dimetric".to_owned(),
        format: "png".to_owned(),
    };
    let req = request(ops, 3.0, capture);
    let png = render_preview(&req).expect("native renderer 应产出 PNG");
    assert!(png.len() > 100, "PNG 过小");
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
}

/// Exercises the production model synchronizer and canvas camera on a hardware target.
#[cfg(feature = "native-canvas")]
#[test]
#[ignore = "requires hardware GPU"]
fn shared_world_canvas_hardware() {
    use bevy::{prelude::*, asset::RenderAssetUsages, camera::RenderTarget,
        render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
        app::ScheduleRunnerPlugin};
    use std::sync::{Arc, Mutex};
    use crate::model3d::{runtime::{FocusVisuals, ModelVisuals, sync_models}, scene::prepare_snapshot};
    use crate::protocol::{GraphNode, ModelPlacement, ModelReference, ModelSnapshot, Scene};

    fn frame(swap: bool, moved_cards: bool, parent_changed: bool) -> Vec<u8> {
        let pixels = Arc::new(Mutex::new(None));
        let mut app = App::new();
        app.add_plugins(DefaultPlugins.set(WindowPlugin { primary_window: None,
            exit_condition: bevy::window::ExitCondition::DontExit, ..default() }));
        app.add_plugins(ScheduleRunnerPlugin::run_loop(std::time::Duration::from_millis(8)));
        let ready = super::readiness::install(&mut app);
        let output = pixels.clone();
        app.add_systems(Startup, move |mut commands: Commands, mut images: ResMut<Assets<Image>>,
            mut meshes: ResMut<Assets<Mesh>>, mut materials: ResMut<Assets<StandardMaterial>>,
            info: Res<bevy::render::renderer::RenderAdapterInfo>| {
            println!("hardware adapter: {} {:?} {:?}", info.name, info.backend, info.device_type);
            assert_ne!(format!("{:?}", info.device_type), "Cpu");
            let mut image = Image::new_uninit(Extent3d { width: 256, height: 256, ..default() },
                TextureDimension::D2, TextureFormat::Rgba8UnormSrgb,
                RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD);
            image.texture_descriptor.usage |= TextureUsages::COPY_SRC | TextureUsages::RENDER_ATTACHMENT;
            let image = images.add(image);
            let camera = crate::model3d::grid::setup_camera(&mut commands);
            commands.entity(camera).insert(RenderTarget::Image(image.clone().into()));
            let mut visuals = ModelVisuals::default();
            let mut focus = FocusVisuals::default();
            let mut scene = Scene::default();
            let mut assets = std::collections::HashMap::new();
            for (i, color) in ["#ff0000", "#00ff00"].iter().enumerate() {
                let signature = format!("hardware-{i}");
                let snapshot = prepare_snapshot(ModelSnapshot { scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.into()),
                    ops: vec![ModelOp::Group { id: "parent".into(), parent: None, position: [0.;3],
                        rotation: if parent_changed && i == 0 { [0., 45., 0.] } else { [0.;3] },
                        scale: if parent_changed && i == 0 { [0.5, 0.5, 0.5] } else { [1.;3] } },
                        ModelOp::Box { id: "box".into(), parent: Some("parent".into()), position: [0.;3], rotation: [0.;3],
                        scale: [1.;3], color: Some((*color).into()), material: None, size: [2., 2., 2.] }],
                    signature: signature.clone(), extent: 2., aabb: None, geometry_keys: None,
                    prepared_bounds: None, placement: ModelPlacement::default() });
                let key = format!("hardware-{i}");
                assets.insert(key.clone(), Arc::new(snapshot));
                let depth = if (i == 0) ^ swap { 0.5 } else { -0.5 };
                let point = crate::isometric_grid::canvas_camera_rotation()
                    * Vec3::new(if i == 0 { -0.35 } else { 0.35 }, 0., depth);
                let mut node: GraphNode = serde_json::from_value(serde_json::json!({"id":format!("n{i}"),
                    "type":"model", "x":if moved_cards { 900 } else { 0 }, "y":0,"width":100,"height":50,
                    "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":format!("i{i}"),
                        "transform":{"version":"shared-world-v1","position":{"u":point.x,"v":-point.z,"h":point.y},"rotation":[0,0,0,1],"scale":1}}})).unwrap();
                node.model = Some(ModelReference { ground_anchor_local: None, part_rotations: None, part_positions: None, resource_key:key, scene_version:Some(crate::protocol::MODEL_SCENE_IR_V2.into()),
                    signature, placement:ModelPlacement::default() });
                scene.nodes.push(node);
            }
            scene.surface = Some(serde_json::from_value(serde_json::json!({
                "width": 256., "height": 256., "pixelRatio": 1.
            })).unwrap());
            // Exercise the same demand gate and lease calculation used by the canvas system.
            for now in [0., 3.] {
                crate::model3d::demand::update(&mut visuals, &scene, None,
                    &Default::default(), &Default::default(), now);
                assert_eq!(crate::model3d::demand::payload_lease_keys(&scene, &visuals).len(), 2);
                sync_models(&mut commands, &mut meshes, &mut materials, &mut visuals, &mut focus, &assets, &scene);
                assert_eq!(visuals.roots.len(), 2);
            }
            commands.insert_resource(visuals);
            super::readiness::enqueue_readback(&mut commands, image, output.clone(), ready.clone());
        });
        app.run();
        let data = pixels.lock().unwrap().take().unwrap();
        super::render::normalize_readback(&data, 256, 256)
    }
    let a = frame(false, false, false);
    let reordered = frame(false, true, false);
    let swapped = frame(true, false, false);
    let parent = frame(false, false, true);
    assert_eq!(a, reordered);
    assert_ne!(a, swapped);
    assert_ne!(a, parent);
    let center = (128 * 256 + 128) * 4;
    println!("center original={:?} swapped={:?}", &a[center..center+4], &swapped[center..center+4]);
    assert!(a[center] > a[center + 1] && swapped[center + 1] > swapped[center]);
    let dir = std::env::var("WOOHAA_WORLD_EVIDENCE").unwrap();
    for (name, pixels) in [("original", a), ("reordered", reordered), ("swapped", swapped), ("parent", parent)] {
        println!("{name}: red={}, green={}", pixels.chunks_exact(4).filter(|p| p[0] > 200 && p[1] < 80).count(),
            pixels.chunks_exact(4).filter(|p| p[1] > 200 && p[0] < 80).count());
        std::fs::write(format!("{dir}/{name}.png"), encode_png(&pixels, 256, 256).unwrap()).unwrap();
    }
}

fn humanoid_ops() -> Vec<ModelOp> {
    vec![
        ModelOp::Material {
            id: "armor".into(),
            base_color: "#26343a".into(),
            roughness: 0.35,
            metallic: 0.85,
            emissive: "#000000".into(),
            emissive_strength: 0.0,
            alpha_mode: "opaque".into(),
            double_sided: false,
            unlit: false,
            opacity: None,
            base_color_texture: None,
        },
        ModelOp::Group {
            id: "arm".into(),
            parent: None,
            position: [0.6, 0.4, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
        },
        ModelOp::Sphere {
            id: "elbow".into(),
            parent: Some("arm".into()),
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: None,
            material: Some("armor".into()),
            radius: 0.2,
        },
        ModelOp::Segment {
            id: "forearm".into(),
            parent: Some("arm".into()),
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: None,
            material: Some("armor".into()),
            from: [0.0, 0.0, 0.0],
            to: [0.0, -0.8, 0.0],
            width: 0.3,
            depth: Some(0.3),
            shape: "capsule".into(),
            overlap: 0.0,
        },
        ModelOp::Capsule {
            id: "leg".into(),
            parent: None,
            position: [-0.3, -0.6, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#cc8844".into()),
            material: None,
            radius: 0.25,
            height: 1.0,
        },
    ]
}
