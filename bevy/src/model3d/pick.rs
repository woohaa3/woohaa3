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
use std::collections::HashMap;

type PartPoses = HashMap<String, crate::motion::ModelDelta>;

thread_local! {
    static SHARED_SCENE: std::cell::RefCell<Option<Scene>> = const { std::cell::RefCell::new(None) };
    static CACHE: std::cell::RefCell<Vec<(String, Arc<ModelSnapshot>, Mat4, u64, ModelCandidate)>> = const { std::cell::RefCell::new(Vec::new()) };
    static MOTION: std::cell::RefCell<(Option<String>, PartPoses, u64)> = std::cell::RefCell::new((None, HashMap::new(), 0));
}

pub(crate) fn publish_motion(node: Option<&str>, poses: PartPoses) {
    MOTION.with(|slot| {
        let mut current = slot.borrow_mut();
        let equal = current.0.as_deref() == node && current.1.len() == poses.len()
            && poses.iter().all(|(id, p)| current.1.get(id).is_some_and(|q|
                p.translation == q.translation && p.rotation == q.rotation && p.scale == q.scale && p.opacity == q.opacity));
        if !equal {
            current.0 = node.map(str::to_owned);
            current.1 = poses;
            current.2 = current.2.wrapping_add(1);
        }
    });
}

pub(crate) fn remember_scene(scene: &Scene) {
    crate::canvas_query::model_pick::accept_editor_camera(scene);
    MOTION.with(|slot| {
        let clear = slot.borrow().0.as_ref().is_some_and(|node| {
            scene.animation_playback.as_ref().is_none_or(|playback| &playback.node_id != node)
                || !scene.nodes.iter().any(|candidate| &candidate.id == node)
        });
        if clear {
            publish_motion(None, HashMap::new());
        }
    });
    SHARED_SCENE.with(|slot| *slot.borrow_mut() = Some(scene.clone()));
}

pub(crate) fn refresh_shared_models(lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>) {
    SHARED_SCENE.with(|slot| {
        if let Some(scene) = slot.borrow().as_ref() {
            CACHE.with(|cache| {
                let mut old = std::mem::take(&mut *cache.borrow_mut());
                let mut next = Vec::new();
                let mut published = Vec::new();
                MOTION.with(|motion| {
                let motion = motion.borrow();
                for node in scene.nodes.iter().filter(|n| n.shared_world_instance.is_some()) {
                    let reference = node.model.as_ref();
                    let Some(model) = reference.and_then(|reference| lookup(&reference.resource_key)) else {
                        // 空模型/资源未就绪：以真实世界锚点作为可选中的标记候选。
                        if let Some((min, max)) = super::layout::world_marker_bounds(node) {
                            published.push(ModelCandidate {
                                node_id: node.id.clone(),
                                shared_world: true,
                                empty_marker: true,
                                min,
                                max,
                                triangles: None,
                            });
                        }
                        continue;
                    };
                    let placement = &reference.expect("model reference").placement;
                    let root = super::layout::model_root_transform(node, &model, placement).to_matrix();
                    let revision = if motion.0.as_deref() == Some(&node.id) { motion.2 } else { 0 };
                    let candidate = if let Some(index) = old.iter().position(|(id, asset, pose, rev, _)| id == &node.id && Arc::ptr_eq(asset, &model) && *pose == root && *rev == revision) {
                        old.swap_remove(index).4
                    } else {
                        let poses = if revision != 0 { Some(&motion.1) } else { None };
                        let triangles = world_triangles(node, &model, placement, poses);
                        let mut min = Vec3::splat(f32::INFINITY);
                        let mut max = Vec3::splat(f32::NEG_INFINITY);
                        for vertex in triangles.iter().flat_map(|triangle| triangle.vertices) {
                            let vertex = Vec3::from_array(vertex);
                            min = min.min(vertex);
                            max = max.max(vertex);
                        }
                        if triangles.is_empty() { min = Vec3::ZERO; max = Vec3::ZERO; }
                        if !min.is_finite() || !max.is_finite() { continue; }
                        ModelCandidate { node_id: node.id.clone(), shared_world: true, empty_marker: false, min: min.to_array(), max: max.to_array(), triangles: Some(Arc::new(triangles)) }
                    };
                    published.push(candidate.clone());
                    next.push((node.id.clone(), model, root, revision, candidate));
                }
                });
                // Shared-world cameras are first-class 3D objects: their body bounds are
                // pickable even though they have no model payload. Frustum lines use
                // oriented surfaces so their AABB corners do not steal model clicks.
                #[cfg(feature = "canvas-core")]
                for node in &scene.nodes {
                    let Some(camera) = &node.world_camera else { continue };
                    for region in crate::world_camera::pick_regions(camera) {
                        published.push(ModelCandidate {
                            node_id: node.id.clone(),
                            shared_world: true,
                            empty_marker: true,
                            min: region.min,
                            max: region.max,
                            triangles: region.triangles.map(Arc::new),
                        });
                    }
                }
                crate::canvas_query::model_pick::replace_shared_models(published);
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
        if node.shared_world_instance.is_some() {
            let surface = node
                .model
                .as_ref()
                .and_then(|reference| lookup(&reference.resource_key))
                .and_then(|model| {
                    let placement = node.model.as_ref().map(|reference| &reference.placement)?;
                    super::layout::model_world_aabb_for_node(&model, placement, node)
                });
            match surface {
                Some(world) => candidates.push(ModelCandidate {
                    shared_world: true,
                    node_id: node.id.clone(),
                    empty_marker: false,
                    min: world.min,
                    max: world.max,
                    triangles: None,
                }),
                None => {
                    if let Some((min, max)) = super::layout::world_marker_bounds(node) {
                        candidates.push(ModelCandidate {
                            shared_world: true,
                            node_id: node.id.clone(),
                            empty_marker: true,
                            min,
                            max,
                            triangles: None,
                        });
                    }
                }
            }
            continue;
        }
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
            shared_world: false,
            empty_marker: false,
            node_id: node.id.clone(),
            min: world.min,
            max: world.max,
            triangles: None,
        });
    }
    candidates
}

fn world_triangles(node: &GraphNode, model: &ModelSnapshot, placement: &crate::protocol::ModelPlacement, poses: Option<&PartPoses>) -> Vec<crate::canvas_query::model_pick::SurfaceTriangle> {
    let root = super::layout::model_root_transform(node, model, placement).to_matrix();
    let specs = super::scene::build_entity_specs(model);
    let materials = super::scene::collect_materials(model);
    let indices: std::collections::HashMap<_, _> = specs.iter().enumerate().map(|(i, s)| (s.id.as_str(), i)).collect();
    fn world(index: usize, specs: &[super::scene::ModelEntitySpec], indices: &std::collections::HashMap<&str, usize>, root: Mat4, poses: Option<&PartPoses>, visiting: &mut Vec<usize>) -> Option<Mat4> {
        if visiting.contains(&index) { return None; }
        visiting.push(index);
        let spec = &specs[index];
        // A hidden parent hides its entire Bevy entity subtree.
        if spec.geometry.is_some() && poses.and_then(|p| p.get(&spec.id)).is_some_and(|p| p.opacity <= 0.0) { return None; }
        let parent = match spec.parent.as_deref() {
            Some(id) => world(*indices.get(id)?, specs, indices, root, poses, visiting)?,
            None => root,
        };
        visiting.pop();
        let base = Transform { translation: Vec3::from_array(spec.position), rotation: super::scene::quat_from_xyz_radians(spec.rotation_radians), scale: Vec3::from_array(spec.scale) };
        let local = poses.and_then(|p| p.get(&spec.id)).map_or(base, |delta| super::runtime::compose_delta(base, delta));
        Some(parent * local.to_matrix())
    }
    let mut triangles = Vec::new();
    for (index, spec) in specs.iter().enumerate() {
        let Some(world) = world(index, &specs, &indices, root, poses, &mut Vec::new()) else { continue };
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
        let triangles = world_triangles(&scene.nodes[0], &asset, &scene.nodes[0].model.as_ref().unwrap().placement, None);
        let mut candidates = model_candidates(&scene, |_| Some(asset.clone()));
        candidates[0].triangles = Some(Arc::new(triangles));
        assert_eq!(candidates[0].triangles.as_ref().unwrap().len(), 12);
        let direction = crate::isometric_grid::canvas_camera_rotation() * Vec3::NEG_Z;
        let center = Vec3::new(0., 64., 0.);
        assert!(crate::canvas_query::model_pick::pick_candidates(&candidates, center - direction * 100000., direction, 200000.).is_some());
    }

    #[test]
    fn world_camera_body_is_pickable_without_a_model_payload() {
        let camera = node(r#"{"id":"cam","type":"node","x":0,"y":0,"width":248,"height":156,
            "worldCamera":{"kind":"world-camera","version":"shared-world-v1",
                "cameraId":"camera-1","settingsVersion":"v1",
                "position":{"u":0,"v":0,"h":1.5},
                "rotation":[-0.27984814233312133,-0.11591689595929515,0.3647051996310009,0.8804762392171493],
                "projection":{"kind":"isometric","verticalSizeMeters":8,"nearMeters":0.1,"farMeters":500},
                "captureMode":{"kind":"static"},"aspect":{"width":16,"height":9},"boundInstanceId":null}}"#);
        let scene = Scene { nodes: vec![camera], ..Scene::default() };
        remember_scene(&scene);
        crate::canvas_query::model_pick::accept_models(Vec::new(), 31, Default::default());
        refresh_shared_models(|_| None);
        let screen = crate::isometric_grid::screen_point_from_world(
            Vec3::new(0., 96., 0.),
            &Default::default(),
        );
        let request = format!(
            r#"{{"generation":31,"x":{},"y":{},"width":800,"height":600}}"#,
            screen.x, screen.y
        );
        let value: serde_json::Value =
            serde_json::from_str(&crate::canvas_query::model_pick::pick_query_json(&request)).unwrap();
        assert_eq!(value["nodeId"], "cam");
    }

    #[test]
    fn production_query_tracks_late_and_released_assets() {
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let scene = Scene { nodes: vec![node], ..Scene::default() };
        remember_scene(&scene);
        crate::canvas_query::model_pick::accept_models(Vec::new(), 7, Default::default());
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 100., 0.), &Default::default());
        let request = format!(r#"{{"generation":7,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let query = || serde_json::from_str::<serde_json::Value>(&crate::canvas_query::model_pick::pick_query_json(&request)).unwrap();
        refresh_shared_models(|_| None);
        // 空模型标记只在世界锚点可命中；模型表面高度处没有陈旧三角面。
        assert!(query()["nodeId"].is_null());
        let asset = Arc::new(snapshot());
        refresh_shared_models(|_| Some(asset.clone()));
        assert_eq!(query()["nodeId"], "m");
        let first = CACHE.with(|cache| cache.borrow()[0].4.triangles.clone().unwrap());
        refresh_shared_models(|_| Some(asset.clone()));
        CACHE.with(|cache| assert!(Arc::ptr_eq(&first, cache.borrow()[0].4.triangles.as_ref().unwrap())));
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
        assert!(world_triangles(&node, &model, &node.model.as_ref().unwrap().placement, None).is_empty());
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
    fn hidden_parent_removes_child_surface() {
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let mut model = snapshot();
        if let crate::protocol::ModelOp::Box { parent, .. } = &mut model.ops[0] {
            *parent = Some("parent".into());
        }
        model.ops.push(crate::protocol::ModelOp::Box { id: "parent".into(), parent: None, position: [0.; 3], rotation: [0.; 3], scale: [1.; 3], color: Some("#ffffff".into()), material: None, size: [1.; 3] });
        let mut delta = crate::motion::ModelDelta::default();
        delta.opacity = 0.;
        let poses = HashMap::from([("parent".into(), delta)]);
        assert!(!world_triangles(&node, &model, &node.model.as_ref().unwrap().placement, None).is_empty());
        assert!(world_triangles(&node, &model, &node.model.as_ref().unwrap().placement, Some(&poses)).is_empty());
        crate::bridge::clear_model_assets();
        publish_motion(None, HashMap::new());
        let mut background = node.clone();
        background.id = "background".into();
        background.model.as_mut().unwrap().resource_key = "background".into();
        let foreground = Arc::new(model);
        let behind = Arc::new(snapshot());
        crate::bridge::queue_model_snapshot("v:sig".into(), foreground.signature.clone(), foreground.scene_version.clone(), foreground);
        crate::bridge::queue_model_snapshot("background".into(), behind.signature.clone(), behind.scene_version.clone(), behind);
        remember_scene(&Scene { nodes: vec![node, background], ..Scene::default() });
        crate::canvas_query::model_pick::accept_models(Vec::new(), 13, Default::default());
        publish_motion(Some("m"), poses);
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 64., 0.), &Default::default());
        let request = format!(r#"{{"generation":13,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let result: serde_json::Value = serde_json::from_str(&crate::query_model_pick(&request)).unwrap();
        assert_eq!(result["nodeId"], "background");
        publish_motion(None, HashMap::new());
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn bridge_public_query_tracks_resource_and_generation() {
        crate::bridge::clear_model_assets();
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"v:sig"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let scene = Scene { nodes: vec![node], ..Scene::default() };
        remember_scene(&scene);
        crate::canvas_query::model_pick::accept_models(Vec::new(), 7, Default::default());
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(0., 100., 0.), &Default::default());
        let request = |generation| format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
        let query = |generation| serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request(generation))).unwrap();
        assert!(query(7)["nodeId"].is_null());
        let asset = Arc::new(snapshot());
        crate::bridge::queue_model_snapshot("v:sig".into(), asset.signature.clone(), asset.scene_version.clone(), asset);
        assert_eq!(query(7)["nodeId"], "m");
        let first = CACHE.with(|cache| cache.borrow()[0].4.triangles.clone().unwrap());
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
        CACHE.with(|cache| assert!(!Arc::ptr_eq(&first, cache.borrow()[0].4.triangles.as_ref().unwrap())));
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn set_scene_public_query_tracks_resource_lifecycle() {
        crate::bridge::clear_model_assets();
        let request = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","sceneVersion":"woohaa-model-scene-ir-v2","ops":[{"t":"box","id":"body","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","size":[2,2,2]}]}"##;
        let metadata: serde_json::Value = serde_json::from_str(&crate::prepare_and_register_model_resource(request).unwrap()).unwrap();
        let key = metadata["resourceKey"].as_str().unwrap();
        let mut scene: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/shared-world/render-scene.json")).unwrap();
        scene["nodes"][0]["model"] = serde_json::json!({"resourceKey":key});
        scene["nodes"][0]["sharedWorldInstance"]["transform"] = serde_json::json!({"version":"shared-world-v1","position":{"u":2,"v":-1,"h":0},"rotation":[0,0,0,1],"scale":1});
        let mut legacy = scene["nodes"][0].clone();
        legacy["id"] = serde_json::json!("legacy");
        legacy.as_object_mut().unwrap().remove("sharedWorldInstance");
        legacy.as_object_mut().unwrap().remove("modelPreview");
        legacy["x"] = serde_json::json!(2000);
        scene["nodes"].as_array_mut().unwrap().push(legacy);
        scene["viewport"] = serde_json::json!({"x":120,"y":80,"zoom":1.5});
        let generation = crate::set_scene(&scene.to_string()).unwrap();
        let view = crate::isometric_grid::IsometricGridView { x: 120., y: 80., zoom: 1.5 };
        let screen = crate::isometric_grid::screen_point_from_world(Vec3::new(128., 64., 64.), &view);
        let high = crate::isometric_grid::screen_point_from_world(Vec3::new(128., 110., 64.), &view);
        let query = |generation| {
            let request = format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()
        };
        let query_high = |generation| {
            let request = format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, high.x, high.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()
        };
        assert_eq!(query(generation)["nodeId"], "model");
        let signature = metadata["signature"].as_str().unwrap();
        let conflict = serde_json::json!({
            "resourceVersion": "woohaa-model-descriptor-v1",
            "resourceKey": key,
            "sceneVersion": metadata["sceneVersion"],
            "signature": &signature[signature.len() - 1..],
            "extent": metadata["extent"],
            "aabb": metadata["aabb"]
        });
        let error = crate::declare_model_resource(&conflict.to_string()).unwrap_err();
        #[cfg(feature = "wasm")]
        assert_eq!(error.as_string().as_deref(), Some("Model resource key conflict"));
        #[cfg(not(feature = "wasm"))]
        assert_eq!(error.to_string(), "Model resource key conflict");
        assert_eq!(query(generation)["nodeId"], "model");
        assert_eq!(query(generation.wrapping_sub(1))["reason"], "stale");
        crate::bridge::clear_model_assets();
        // 释放后只在世界锚点保留可选中的空模型标记；模型表面高度不得残留旧三角面。
        assert!(query_high(generation)["nodeId"].is_null());
        crate::prepare_and_register_model_resource(request).unwrap();
        assert_eq!(query(generation)["nodeId"], "model");
        // Card movement must not move the shared-world surface or rebuild it.
        let triangles = CACHE.with(|cache| cache.borrow()[0].4.triangles.clone().unwrap());
        scene["nodes"][0]["x"] = serde_json::json!(9000);
        let moved_card = crate::set_scene(&scene.to_string()).unwrap();
        assert_eq!(query(moved_card)["nodeId"], "model");
        CACHE.with(|cache| assert!(Arc::ptr_eq(&triangles, cache.borrow()[0].4.triangles.as_ref().unwrap())));
        scene["nodes"][0]["sharedWorldInstance"]["transform"]["position"]["u"] = serde_json::json!(10);
        let moved_world = crate::set_scene(&scene.to_string()).unwrap();
        assert!(query(moved_world)["nodeId"].is_null());
        let new_screen = crate::isometric_grid::screen_point_from_world(Vec3::new(640., 64., 64.), &view);
        let moved_request = format!(r#"{{"generation":{moved_world},"x":{},"y":{},"width":800,"height":600}}"#, new_screen.x, new_screen.y);
        let result: serde_json::Value = serde_json::from_str(&crate::query_model_pick(&moved_request)).unwrap();
        assert_eq!(result["nodeId"], "model");
        scene["nodes"] = serde_json::json!([]);
        let cleared = crate::set_scene(&scene.to_string()).unwrap();
        assert!(query(cleared)["nodeId"].is_null());
        assert_eq!(query(moved_world)["reason"], "stale");
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn scheduled_motion_and_scene_reset_update_public_query() {
        #[derive(Resource)]
        struct TestScene(Scene);
        fn run_motion(
            mut commands: Commands,
            mut models: ResMut<super::super::ModelVisuals>,
            mut materials: ResMut<Assets<StandardMaterial>>,
            scene: Res<TestScene>,
            _main_thread: bevy::ecs::system::NonSendMarker,
        ) {
            super::super::apply_motion_playback(&mut commands, &mut models, &mut materials, &HashMap::new(), &scene.0);
        }
        crate::bridge::clear_model_assets();
        let request = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","sceneVersion":"woohaa-model-scene-ir-v2","ops":[{"t":"box","id":"body","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","size":[2,2,2]}]}"##;
        let metadata: serde_json::Value = serde_json::from_str(&crate::prepare_and_register_model_resource(request).unwrap()).unwrap();
        let mut scene: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/shared-world/render-scene.json")).unwrap();
        scene["nodes"][0]["model"] = serde_json::json!({"resourceKey": metadata["resourceKey"]});
        scene["nodes"][0]["sharedWorldInstance"]["transform"] = serde_json::json!({"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1});
        scene["animationPlayback"] = serde_json::json!({"nodeId":"model","version":"woohaa-motion-ir-v1","time":1,"duration":4,"initialCamera":{},"modelMotion":[{"targetId":"body","startTime":0,"endTime":4,"motion":{"kind":"move","axis":"x","speed":4,"range":[0,8]}}]});
        let mut app = App::new();
        app.init_resource::<super::super::ModelVisuals>().init_resource::<Assets<StandardMaterial>>()
            .insert_resource(TestScene(serde_json::from_value(scene.clone()).unwrap()))
            .add_systems(Update, run_motion);
        let generation = crate::set_scene(&scene.to_string()).unwrap();
        app.update();
        let query = |generation, point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        assert_eq!(query(generation, Vec3::new(256., 64., 0.)), "model");
        assert!(query(generation, Vec3::new(0., 64., 0.)).is_null());
        scene.as_object_mut().unwrap().remove("animationPlayback");
        let reset = crate::set_scene(&scene.to_string()).unwrap();
        app.world_mut().resource_mut::<TestScene>().0 = serde_json::from_value(scene.clone()).unwrap();
        app.update();
        assert_eq!(query(reset, Vec3::new(0., 64., 0.)), "model");
        assert!(query(reset, Vec3::new(256., 64., 0.)).is_null());
        scene["nodes"] = serde_json::json!([]);
        let cleared = crate::set_scene(&scene.to_string()).unwrap();
        app.world_mut().resource_mut::<TestScene>().0 = serde_json::from_value(scene).unwrap();
        app.update();
        assert!(query(cleared, Vec3::new(0., 64., 0.)).is_null());
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn published_motion_invalidates_visible_surface_cache() {
        crate::bridge::clear_model_assets();
        publish_motion(None, HashMap::new());
        let node = node(r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,"model":{"resourceKey":"moving"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1}}}"#);
        let asset = Arc::new(snapshot());
        crate::bridge::queue_model_snapshot("moving".into(), asset.signature.clone(), asset.scene_version.clone(), asset);
        remember_scene(&Scene { nodes: vec![node], ..Scene::default() });
        crate::canvas_query::model_pick::accept_models(Vec::new(), 12, Default::default());
        let query = |point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":12,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        assert_eq!(query(Vec3::new(0., 64., 0.)), "m");
        let mut delta = crate::motion::ModelDelta::default();
        delta.translation = Vec3::new(4., 0., 0.);
        publish_motion(Some("m"), HashMap::from([("body".into(), delta)]));
        assert!(query(Vec3::new(0., 64., 0.)).is_null());
        assert_eq!(query(Vec3::new(256., 64., 0.)), "m");
        delta.opacity = 0.;
        publish_motion(Some("m"), HashMap::from([("body".into(), delta)]));
        assert!(query(Vec3::new(256., 64., 0.)).is_null());
        // Publishing a scene without playback clears the previous node's motion immediately.
        let current = SHARED_SCENE.with(|slot| slot.borrow().clone().unwrap());
        remember_scene(&current);
        assert_eq!(query(Vec3::new(0., 64., 0.)), "m");
        publish_motion(None, HashMap::new());
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

    #[test]
    fn empty_world_model_anchor_is_selectable_at_instance_pose() {
        crate::bridge::clear_model_assets();
        let node = node(r#"{"id":"empty","type":"model3d","x":9000,"y":9000,"width":260,"height":195,"chrome":{"kind":"none"},"sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i","transform":{"version":"shared-world-v1","position":{"u":2,"v":3,"h":1},"rotation":[0,0,0,1],"scale":1}}}"#);
        remember_scene(&Scene { nodes: vec![node], ..Scene::default() });
        crate::canvas_query::model_pick::accept_models(Vec::new(), 21, Default::default());
        let query = |point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":21,"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        // 世界锚点（u=2,v=3,h=1 → renderer 128,64,-192）可选中；卡片坐标不参与。
        assert_eq!(query(Vec3::new(128., 80., -192.)), "empty");
        assert!(query(Vec3::new(0., 80., 0.)).is_null());
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn focus_camera_ray_uses_perspective_projection() {
        crate::bridge::clear_model_assets();
        let request = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","sceneVersion":"woohaa-model-scene-ir-v2","ops":[{"t":"box","id":"body","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","size":[2,2,2]}]}"##;
        let metadata: serde_json::Value = serde_json::from_str(&crate::prepare_and_register_model_resource(request).unwrap()).unwrap();
        let mut scene: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/shared-world/render-scene.json")).unwrap();
        scene["nodes"][0]["model"] = serde_json::json!({"resourceKey":metadata["resourceKey"]});
        scene["nodes"][0]["sharedWorldInstance"]["transform"] = serde_json::json!({
            "version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1
        });
        scene["surface"] = serde_json::json!({"width":800,"height":600,"pixelRatio":1});
        scene["modelFocus"] = serde_json::json!({
            "version":"woohaa-model-focus-v1","nodeId":"model","target":[0,64,0],
            "yaw":0.6,"pitch":-0.3,"distance":1000,"fov":0.8,"radius":64
        });
        let generation = crate::set_scene(&scene.to_string()).unwrap();
        let query = |x: f32, y: f32| {
            let request = format!(r#"{{"generation":{generation},"x":{x},"y":{y},"width":800,"height":600}}"#);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        assert_eq!(query(400., 300.), "model");
        assert!(query(4., 4.).is_null());
        crate::bridge::clear_model_assets();
    }
}
