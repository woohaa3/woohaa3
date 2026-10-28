//! preview 单元测试（change: refactor-bevy-rust-file-size，任务 3.4 / design D4）。
//!
//! 由 `preview.rs` 内联测试移动而来，断言与覆盖完全保留。

use super::render::{background_color, encode_png, normalize_readback, render_preview};
use crate::model3d::scene;
use crate::protocol::ModelOp;
use crate::renderer_protocol::{
    CaptureOptions, RENDERER_PROTOCOL_VERSION, RenderRequest,
};

fn request(ops: Vec<ModelOp>, extent: f32, capture: CaptureOptions) -> RenderRequest {
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
        composite_asset_frame: None,
    }
}

#[test]
fn background_transparent_is_none() {
    assert_eq!(background_color("transparent"), bevy::prelude::Color::NONE);
    assert_eq!(
        background_color("#112233"),
        scene::parse_hex("#112233")
    );
}

#[test]
fn png_encoding_produces_signature() {
    let pixels = vec![128u8; 4 * 4 * 4];
    let png = encode_png(&pixels, 4, 4).expect("png");
    assert_eq!(
        &png[..8],
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
    );
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
    assert_eq!(normalize_readback(&padded, 3, 2), [vec![1u8; 12], vec![2u8; 12]].concat());
}

#[test]
fn native_output_uses_original_high_geometry_and_exact_primitive_identity() {
    use bevy::prelude::*;
    use crate::model3d::{resources::SharedResources, scene::ModelGeometry};
    let mut resources = SharedResources::default();
    let mut meshes = Assets::<Mesh>::default();
    let first = ModelGeometry::Sphere { radius: 1.00001 };
    let second = ModelGeometry::Sphere { radius: 1.00002 };
    let a = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let again = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let b = super::render::high_mesh(&mut resources, &mut meshes, &second).unwrap();
    assert_eq!(a, again);
    assert_ne!(a, b, "native must not round distinct dimensions into one cache key");
    assert_eq!(meshes.get(&a).unwrap().indices().unwrap().len() / 3, 528);
    let expected = crate::model3d::mesh::build_mesh(&first).unwrap();
    assert_eq!(meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_POSITION), expected.attribute(Mesh::ATTRIBUTE_POSITION));
    assert_eq!(meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_NORMAL), expected.attribute(Mesh::ATTRIBUTE_NORMAL));
}

#[test]
fn native_custom_meshes_with_equal_counts_preserve_distinct_vertices_and_topology() {
    use bevy::prelude::*;
    use crate::model3d::{resources::SharedResources, scene::ModelGeometry};
    let mut resources = SharedResources::default();
    let mut meshes = Assets::<Mesh>::default();
    let first = ModelGeometry::Mesh { vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], faces: vec![[0, 1, 2]] 
normals: None,
uvs: None,
colors: None,;
    let moved = ModelGeometry::Mesh { vertices: vec![[0., 0., 0.], [2., 0., 0.], [0., 1., 0.]], faces: vec![[0, 1, 2]] 
normals: None,
uvs: None,
colors: None,;
    let reversed = ModelGeometry::Mesh { vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], faces: vec![[0, 2, 1]] 
normals: None,
uvs: None,
colors: None,;
    let a = super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap();
    let b = super::render::high_mesh(&mut resources, &mut meshes, &moved).unwrap();
    let c = super::render::high_mesh(&mut resources, &mut meshes, &reversed).unwrap();
    assert_ne!(a, b); assert_ne!(a, c); assert_ne!(b, c);
    assert_ne!(meshes.get(&a).unwrap().attribute(Mesh::ATTRIBUTE_POSITION), meshes.get(&b).unwrap().attribute(Mesh::ATTRIBUTE_POSITION));
    assert_eq!(meshes.get(&c).unwrap().indices().unwrap().iter().collect::<Vec<_>>(), vec![0, 2, 1]);
    assert_eq!(super::render::high_mesh(&mut resources, &mut meshes, &first).unwrap(), a);
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
    };
    let req = request(ops, 3.0, capture);
    let png = render_preview(&req).expect("native renderer 应产出 PNG");
    assert!(png.len() > 100, "PNG 过小");
    assert_eq!(
        &png[..8],
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
    );
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
