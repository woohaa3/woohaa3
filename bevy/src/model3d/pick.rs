//! 普通画布模型 picking 候选派生
//! （change: 2026-10-13-add-film-set-hover-camera-entity，任务 1.2 / design D4）。
//!
//! 从 `Scene` 派生每个**普通模型**节点的世界 AABB（含 placement/anchor），供 `set_scene`
//! 接受点一次性发布给共享纯几何查询模块。
//!
//! 资源表由调用方以 `lookup` 注入，保持本模块不依赖 `bridge` / wasm（架构守卫）。

use std::sync::Arc;
use bevy::{prelude::*, render::mesh::{Indices, VertexAttributeValues}};

use crate::canvas_query::model_pick::ModelCandidate;
use crate::protocol::{GraphNode, ModelSnapshot, Scene};

thread_local! {
    static SHARED_SCENE: std::cell::RefCell<Option<Scene>> = const { std::cell::RefCell::new(None) };
    static CACHE: std::cell::RefCell<Vec<(String, Arc<ModelSnapshot>, Mat4, ModelCandidate)>> = const { std::cell::RefCell::new(Vec::new()) };
}

pub(crate) fn remember_scene(scene: &Scene) {
    SHARED_SCENE.with(|slot| *slot.borrow_mut() = Some(scene.clone()));
}

pub(crate) fn refresh_shared_models(lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>) {
    SHARED_SCENE.with(|slot| {
        if let Some(scene) = slot.borrow().as_ref() {
            CACHE.with(|cache| {
                let mut old = std::mem::take(&mut *cache.borrow_mut());
                let mut next = Vec::new();
                for node in scene.nodes.iter().filter(|n| n.shared_world_instance.is_some() && is_model_candidate(n)) {
                    let reference = node.model.as_ref().unwrap();
                    let Some(model) = lookup(&reference.resource_key) else { continue };
                    let root = super::layout::model_root_transform(node, &model, &reference.placement).to_matrix();
                    let candidate = if let Some(index) = old.iter().position(|(id, asset, pose, _)| id == &node.id && Arc::ptr_eq(asset, &model) && *pose == root) {
                        old.swap_remove(index).3
                    } else {
                        let triangles = world_triangles(node, &model, &reference.placement);
                        let mut min = Vec3::splat(f32::INFINITY);
                        let mut max = Vec3::splat(f32::NEG_INFINITY);
                        for vertex in triangles.iter().flat_map(|triangle| triangle.vertices) {
                            let vertex = Vec3::from_array(vertex);
                            min = min.min(vertex);
                            max = max.max(vertex);
                        }
                        if triangles.is_empty() { min = Vec3::ZERO; max = Vec3::ZERO; }
                        if !min.is_finite() || !max.is_finite() { continue; }
                        ModelCandidate { node_id: node.id.clone(), shared_world: true, min: min.to_array(), max: max.to_array(), triangles: Some(Arc::new(triangles)) }
                    };
                    next.push((node.id.clone(), model, root, candidate));
                }
                crate::canvas_query::model_pick::replace_shared_models(next.iter().map(|entry| entry.3.clone()).collect());
                *cache.borrow_mut() = next;
            });
        }
    });
}

/// 普通模型 picking 候选资格：非预览卡片、且携带模型引用。
pub(crate) fn is_model_candidate(node: &GraphNode) -> bool {
    (node.model_preview.is_none() || node.shared_world_instance.is_some()) && node.model.is_some()
}

/// 派生普通模型候选世界 AABB；`lookup` 提供不可变资源表（`set_scene` 接受点注入 `bridge`）。
pub(crate) fn model_candidates(
    scene: &Scene,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> Vec<ModelCandidate> {
    let mut candidates = Vec::new();
    for node in &scene.nodes {
        if !is_model_candidate(node) {
            continue;
        }
        let Some(reference) = &node.model else {
            continue;
        };
        let Some(model) = lookup(&reference.resource_key) else {
            continue;
        };
        let Some(world) =
            super::layout::model_world_aabb_for_node(&model, &reference.placement, node)
        else {
            continue;
        };
        candidates.push(ModelCandidate {
            shared_world: node.shared_world_instance.is_some(),
            node_id: node.id.clone(),
            min: world.min,
            max: world.max,
            triangles: None,
        });
    }
    candidates
}

fn world_triangles(node: &GraphNode, model: &ModelSnapshot, placement: &crate::protocol::ModelPlacement) -> Vec<crate::canvas_query::model_pick::SurfaceTriangle> {
    let root = super::layout::model_root_transform(node, model, placement).to_matrix();
    let specs = super::scene::build_entity_specs(model);
    let materials = super::scene::collect_materials(model);
    let indices: std::collections::HashMap<_, _> = specs.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    fn world(index: usize, specs: &[super::scene::ModelEntitySpec], indices: &std::collections::HashMap<&str, usize>, root: Mat4, visiting: &mut Vec<usize>) -> Option<Mat4> {
        if visiting.contains(&index) { return None; }
        visiting.push(index);
        let spec = &specs[index];
        let parent = match spec.parent.as_deref() {
            Some(id) => world(*indices.get(id)?, specs, indices, root, visiting)?,
            None => root,
        };
        visiting.pop();
        Some(parent * Transform { translation: Vec3::from_array(spec.position), rotation: super::scene::quat_from_xyz_radians(spec.rotation_radians), scale: Vec3::from_array(spec.scale) }.to_matrix())
    }
    let mut triangles = Vec::new();
    for (index, spec) in specs.iter().enumerate() {
        let Some(world) = world(index, &specs, &indices, root, &mut Vec::new()) else { continue };
        let material = spec.material_key.strip_prefix("material:").and_then(|id| materials.get(id));
        if material.is_some_and(|material| material.static_opacity() <= 0.0) { continue; }
        let cull_back = spec.material_key.starts_with("material:") && material.map_or(true, |material| !material.double_sided);
        let Some(mesh) = spec.geometry.as_ref().and_then(super::mesh::build_mesh) else { continue };
        let Some(VertexAttributeValues::Float32x3(vertices)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else { continue };
        let indices: Vec<usize> = match mesh.indices() {
            Some(Indices::U16(values)) => values.iter().map(|i| *i as usize).collect(),
            Some(Indices::U32(values)) => values.iter().map(|i| *i as usize).collect(),
            None => (0..vertices.len()).collect(),
        };
        for face in indices.chunks_exact(3) {
            if let (Some(a), Some(b), Some(c)) = (vertices.get(face[0]), vertices.get(face[1]), vertices.get(face[2])) {
                triangles.push(crate::canvas_query::model_pick::SurfaceTriangle { vertices: [*a, *b, *c].map(|v| world.transform_point3(Vec3::from_array(v)).to_array()), cull_back });
            }
        }
    }
    triangles
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(json: &str) -> GraphNode {
        serde_json::from_str(json).expect("graph node")
    }

    fn snapshot() -> ModelSnapshot {
        ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            vec![crate::protocol::ModelOp::Box {
                id: "body".to_owned(),
                parent: None,
                position: [0.0, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0],
                scale: [1.0; 3],
                color: Some("#ffffff".to_owned()),
                material: None,
                size: [2.0, 2.0, 2.0],
            }],
            "sig".to_owned(),
            2.0,
            Default::default(),
        )
    }

    /// 普通模型本体与预览卡片语义保持：带模型引用入选，仅预览卡片不入选。
    #[test]
    fn plain_model_is_candidate_and_preview_card_is_not() {
        let plain = node(
            r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"}}"#,
        );
        assert!(is_model_candidate(&plain));

        let preview = node(
            r#"{"id":"p","type":"model","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"},
                "modelPreview":{"azimuth":0.5,"elevation":0.2,"distanceScale":1.2,"targetOffset":[0,0,0]}}"#,
        );
        assert!(!is_model_candidate(&preview));

        let mut world_preview = preview.clone();
        world_preview.shared_world_instance = serde_json::from_value(serde_json::json!({
            "kind":"world-instance", "version":"shared-world-v1", "instanceId":"instance",
            "transform":{"version":"shared-world-v1", "position":{"u":1,"v":2,"h":3},
                "rotation":[0,0,0,1], "scale":1}
        })).unwrap();
        assert!(is_model_candidate(&world_preview));

        let scene = Scene {
            nodes: vec![plain, preview],
            ..Scene::default()
        };
        let candidates = model_candidates(&scene, |_| Some(Arc::new(snapshot())));
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].node_id, "m");
        assert!(candidates[0].min[0] < candidates[0].max[0]);
    }

    #[test]
    fn shared_box_produces_surface_triangles() {
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let scene = Scene { nodes: vec![node], ..Scene::default() };
        remember_scene(&scene);
        let asset = Arc::new(snapshot());
        refresh_shared_models(|_| Some(asset.clone()));
        let triangles = world_triangles(&scene.nodes[0], &asset, &scene.nodes[0].model.as_ref().unwrap().placement);
        let mut candidates = model_candidates(&scene, |_| Some(asset.clone()));
        candidates[0].triangles = Some(Arc::new(triangles));
        assert_eq!(candidates[0].triangles.as_ref().unwrap().len(), 12);
        let direction = crate::isometric_grid::canvas_camera_rotation() * Vec3::NEG_Z;
        let center = Vec3::new(0., 64., 0.);
        assert!(crate::canvas_query::model_pick::pick_candidates(&candidates, center - direction * 100000., direction, 200000.).is_some());
    }

    #[test]
    fn production_query_tracks_late_and_released_assets() {
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let scene = Scene { nodes: vec![node], ..Scene::default() };
        remember_scene(&scene);
        crate::canvas_query::model_pick::accept_models(Vec::new(), 7, Default::default());
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 64., 0.), &Default::default());
        let request = format!(r#"{{"generation":7,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let query = || serde_json::from_str::<serde_json::Value>(&crate::canvas_query::model_pick::pick_query_json(&request)).unwrap();
        refresh_shared_models(|_| None);
        assert!(query()["nodeId"].is_null());
        let asset = Arc::new(snapshot());
        refresh_shared_models(|_| Some(asset.clone()));
        assert_eq!(query()["nodeId"], "m");
        let first = CACHE.with(|cache| cache.borrow()[0].3.triangles.clone().unwrap());
        refresh_shared_models(|_| Some(asset.clone()));
        CACHE.with(|cache| assert!(Arc::ptr_eq(&first, cache.borrow()[0].3.triangles.as_ref().unwrap())));
        refresh_shared_models(|_| None);
        assert!(query()["nodeId"].is_null());
    }

    #[test]
    fn transparent_material_does_not_publish_a_pick_surface() {
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let mut model = snapshot();
        if let crate::protocol::ModelOp::Box { material, .. } = &mut model.ops[0] {
            *material = Some("invisible".into());
        }
        model.ops.push(crate::protocol::ModelOp::Material {
            id: "invisible".into(), base_color: "#ffffff".into(), roughness: 0.5,
            metallic: 0.0, emissive: "#000000".into(), emissive_strength: 0.0,
            alpha_mode: "blend".into(), double_sided: true, unlit: false,
            opacity: Some(0.0), base_color_texture: None,
        });
        assert!(world_triangles(&node, &model, &node.model.as_ref().unwrap().placement).is_empty());
        remember_scene(&Scene { nodes: vec![node], ..Scene::default() });
        crate::canvas_query::model_pick::accept_models(Vec::new(), 9, Default::default());
        let asset = Arc::new(model);
        refresh_shared_models(|_| Some(asset.clone()));
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 64., 0.), &Default::default());
        let request = format!(r#"{{"generation":9,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let result: serde_json::Value = serde_json::from_str(&crate::canvas_query::model_pick::pick_query_json(&request)).unwrap();
        assert!(result["nodeId"].is_null());
    }

    #[test]
    fn bridge_public_query_tracks_resource_and_generation() {
        crate::bridge::clear_model_assets();
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let scene = Scene { nodes: vec![node], ..Scene::default() };
        remember_scene(&scene);
        crate::canvas_query::model_pick::accept_models(Vec::new(), 7, Default::default());
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 64., 0.), &Default::default());
        let request = |generation| format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let query = |generation| serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request(generation))).unwrap();
        assert!(query(7)["nodeId"].is_null());
        let asset = Arc::new(snapshot());
        crate::bridge::queue_model_snapshot("v:sig".into(), asset.signature.clone(), asset.scene_version.clone(), asset);
        assert_eq!(query(7)["nodeId"], "m");
        let first = CACHE.with(|cache| cache.borrow()[0].3.triangles.clone().unwrap());
        crate::canvas_query::model_pick::accept_viewport_camera([0., 0., 1.], [800., 600.], 8);
        assert_eq!(query(7)["reason"], "stale");
        assert_eq!(query(8)["nodeId"], "m");
        crate::bridge::clear_model_assets();
        assert!(query(8)["nodeId"].is_null());
        let mut replacement = snapshot();
        if let crate::protocol::ModelOp::Box { size, .. } = &mut replacement.ops[0] { *size = [3.; 3]; }
        let replacement = Arc::new(replacement);
        crate::bridge::queue_model_snapshot("v:sig".into(), replacement.signature.clone(), replacement.scene_version.clone(), replacement);
        assert_eq!(query(8)["nodeId"], "m");
        CACHE.with(|cache| assert!(!Arc::ptr_eq(&first, cache.borrow()[0].3.triangles.as_ref().unwrap())));
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn production_query_uses_sparse_mesh_and_parent_transform() {
        crate::bridge::clear_model_assets();
        let node = node(r#"{"id":"mesh","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"sparse"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let ops = vec![
            crate::protocol::ModelOp::Mesh { id: "surface".into(), parent: Some("parent".into()), position: [0.; 3], rotation: [0.; 3], scale: [1.; 3], color: Some("#ffffff".into()), material: None, vertices: vec![[0., 0., 0.], [2., 0., 0.], [0., 2., 0.]], faces: vec![[0, 1, 2]], normals: None, uvs: None, colors: None },
            crate::protocol::ModelOp::Group { id: "parent".into(), parent: None, position: [2., 0., 0.], rotation: [0.; 3], scale: [1.; 3] },
        ];
        let model = Arc::new(ModelSnapshot::new(Some(crate::protocol::MODEL_SCENE_IR_V2.into()), ops, "sparse".into(), 4., Default::default()));
        crate::bridge::queue_model_snapshot("sparse".into(), model.signature.clone(), model.scene_version.clone(), model);
        remember_scene(&Scene { nodes: vec![node], ..Scene::default() });
        crate::canvas_query::model_pick::accept_models(Vec::new(), 10, Default::default());
        let query = |point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":10,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()
        };
        assert_eq!(query(Vec3::new(160., 32., 0.))["nodeId"], "mesh");
        assert!(query(Vec3::new(224., 96., 0.))["nodeId"].is_null());
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn production_interleaved_surface_identities_survive_card_reorder() {
        crate::bridge::clear_model_assets();
        let mut nodes = Vec::new();
        for (id, sign) in [("red", 1.0_f32), ("green", -1.0_f32)] {
            let json = format!(r#"{{"id":"{id}","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{{"resourceKey":"{id}"}},"sharedWorldInstance":{{"kind":"world-instance","version":"shared-world-v1","instanceId":"{id}","transform":{{"version":"shared-world-v1","position":{{"u":0,"v":0,"h":0}},"rotation":[0,0,0,1],"scale":1}}}}}}"#);
            nodes.push(node(&json));
            let mut ops = vec![crate::protocol::ModelOp::Group { id: "parent".into(), parent: None, position: [0.; 3], rotation: [0.; 3], scale: [1.; 3] }];
            for (part, position) in [("left", [-0.707 + sign * 0.612, sign * 0.5, 0.707 + sign * 0.612]), ("right", [0.707 - sign * 0.612, -sign * 0.5, -0.707 - sign * 0.612])] {
                ops.push(crate::protocol::ModelOp::Box { id: part.into(), parent: Some("parent".into()), position, rotation: [0.; 3], scale: [1.; 3], color: Some("#ffffff".into()), material: None, size: [1.5; 3] });
            }
            let model = Arc::new(ModelSnapshot::new(Some(crate::protocol::MODEL_SCENE_IR_V2.into()), ops, id.into(), 4., Default::default()));
            crate::bridge::queue_model_snapshot(id.into(), model.signature.clone(), model.scene_version.clone(), model);
        }
        let mut scene = Scene { nodes, ..Scene::default() };
        let points = [Vec3::new(-0.095, 0.5, 1.319) * 64., Vec3::new(1.319, 0.5, -0.095) * 64.];
        let query = |point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":11,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        crate::canvas_query::model_pick::accept_models(Vec::new(), 11, Default::default());
        remember_scene(&scene);
        let before = [query(points[0]), query(points[1])];
        scene.nodes[0].x = 900.;
        scene.nodes.reverse();
        remember_scene(&scene);
        assert_eq!([query(points[0]), query(points[1])], before);
        assert_eq!(before, ["red", "green"]);
        crate::bridge::clear_model_assets();
    }
}
