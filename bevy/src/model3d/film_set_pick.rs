//! 片场内部对象候选的**唯一派生**（change: 2026-10-14-scope-film-set-object-picking-to-focus，
//! 任务 1.1 / design D1）。
//!
//! 从已接受 `Scene` 派生内部对象目标与候选：先按 accepted `modelFocus.node_id` 定位唯一
//! `composite_asset` 节点，再只对该目标执行几何准备。普通模型、非片场、目标缺失或没有 model
//! focus 一律得到 `owner = None`（提前关闭，不做任何部件/包围盒求值）。目标仅含媒体、无 model
//! 资源时仍准备合法媒体候选；空片场得到明确目标且候选为空。
//!
//! 资源表由调用方以 `lookup` 注入，本模块不依赖 bridge / wasm；因此目标门禁与几何结果可在
//! native 纯 Rust 测试中覆盖。`pick_index` 只转发 `bridge` 资源表。

use std::sync::Arc;

use crate::canvas_query::film_set_pick::FilmSetItemCandidate;
use crate::protocol::{GraphNode, ModelSnapshot, Scene};

/// 内部对象索引的接受结果（owner 与候选与派生工作量）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FilmSetItemPreparation {
    /// accepted `modelFocus` 指向的复合资产节点 id；无聚焦目标或目标非复合资产时为 `None`。
    pub(crate) owner: Option<String>,
    pub(crate) candidates: Vec<FilmSetItemCandidate>,
    /// 为本次内部候选实际求值的部件包围盒次数（无目标/无模型对象时为 0）。
    pub(crate) part_bounds_evaluations: u64,
}

impl FilmSetItemPreparation {
    fn closed() -> Self {
        Self {
            owner: None,
            candidates: Vec::new(),
            part_bounds_evaluations: 0,
        }
    }
}

/// 派生当前聚焦片场的内部对象候选（design D1）。
///
/// 定位目标允许扫描轻量节点列表，但不得访问非目标的部件层级、派生包围盒或媒体候选。
pub(crate) fn prepare(
    scene: &Scene,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> FilmSetItemPreparation {
    let Some(node) = focused_composite_node(scene) else {
        return FilmSetItemPreparation::closed();
    };
    let (candidates, part_bounds_evaluations) = item_candidates(node, lookup);
    FilmSetItemPreparation {
        owner: Some(node.id.clone()),
        candidates,
        part_bounds_evaluations,
    }
}

/// Group based film sets use the same interaction index, but their candidates
/// come from the binding primitives instead of a legacy `compositeAsset` blob.
/// Model candidates use the registered source geometry and the same binding
/// transform as rendering. Unavailable resources cannot produce phantom hits.
pub(crate) fn prepare_group(
    scene: &Scene,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> FilmSetItemPreparation {
    let Some(focus) = scene.model_focus.as_ref() else {
        return FilmSetItemPreparation::closed();
    };
    group_candidates(scene, &focus.node_id, lookup)
}

pub(super) fn group_candidates(
    scene: &Scene,
    owner_id: &str,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> FilmSetItemPreparation {
    let Some(group) = scene
        .film_set_groups
        .iter()
        .find(|entry| entry.owner_id == owner_id)
    else {
        return FilmSetItemPreparation::closed();
    };
    let Some(owner) = scene.nodes.iter().find(|node| node.id == group.owner_id) else {
        return FilmSetItemPreparation::closed();
    };
    let owner_model = owner
        .model
        .as_ref()
        .and_then(|reference| lookup(&reference.resource_key));
    let root = super::media_geometry::film_set_root(owner, owner_model.as_deref());
    let root = group
        .scene_transform
        .as_ref()
        .map(|t| root.mul_transform(super::group_runtime::scene_transform(t)))
        .unwrap_or(root);
    let roots: Vec<_> = group
        .bindings
        .iter()
        .map(|binding| format!("{}:{}", binding.binding_id.len(), binding.binding_id))
        .collect();
    let combined: std::collections::HashMap<_, _> = owner_model
        .as_deref()
        .map(|model| {
            super::scene::placed_subtree_aabbs(model, &roots, None)
                .into_iter()
                .collect()
        })
        .unwrap_or_default();
    let mut candidates = Vec::with_capacity(group.bindings.len());
    for binding in &group.bindings {
        if !binding.visible {
            continue;
        }
        let transform = bevy::prelude::Transform {
            translation: bevy::prelude::Vec3::new(
                binding.transform.x,
                binding.transform.y,
                binding.transform.z,
            ),
            rotation: bevy::prelude::Quat::from_rotation_y(binding.transform.yaw),
            scale: bevy::prelude::Vec3::splat(binding.transform.scale),
        };
        let combined_id = format!("{}:{}", binding.binding_id.len(), binding.binding_id);
        let from_combined = combined.get(&combined_id);
        let media_plane =
            if matches!(binding.kind.as_str(), "image" | "video") && binding.diagnostic.is_none() {
                Some(super::media_geometry::group_media_plane(
                    &group.owner_id,
                    binding,
                    owner_model.as_deref(),
                ))
            } else {
                None
            };
        let local = if let Some(bounds) = from_combined {
            *bounds
        } else if binding.diagnostic.is_some() {
            super::scene::ModelAabb::new([-0.4, 0.0, -0.4], [0.4, 0.8, 0.4])
        } else if binding.kind == "model3d" {
            let Some(model) = binding.resource_key.as_deref().and_then(&lookup) else {
                continue;
            };
            let Some(bounds) = super::scene::model_local_aabb(&model) else {
                continue;
            };
            bounds
        } else if let Some(plane) = &media_plane {
            super::scene::ModelAabb::new(
                [-0.5 * plane.width, 0.0, 0.0],
                [0.5 * plane.width, plane.height, 0.0],
            )
        } else {
            continue;
        };
        let local =
            if binding.kind == "model3d" && from_combined.is_none() && binding.diagnostic.is_none()
            {
                let placement = scene
                    .nodes
                    .iter()
                    .find(|node| node.id == binding.source_node_id)
                    .and_then(|node| node.model.as_ref())
                    .map(|model| &model.placement);
                if let Some(placement) = placement {
                    local.transformed(&bevy::prelude::Transform {
                        translation: bevy::prelude::Vec3::new(
                            placement.offset.x,
                            placement.offset.y,
                            placement.offset.z,
                        ),
                        rotation: bevy::prelude::Quat::from_rotation_y(placement.yaw.to_radians()),
                        scale: bevy::prelude::Vec3::splat(placement.scale),
                    })
                } else {
                    local
                }
            } else {
                local
            };
        let transform = root.mul_transform(transform);
        let bounds = local.transformed(&transform);
        let basis = bevy::math::Mat3::from_quat(root.rotation) * root.scale.x;
        candidates.push(FilmSetItemCandidate {
            node_id: group.owner_id.clone(),
            item_id: binding.binding_id.clone(),
            min: bounds.min,
            max: bounds.max,
            unit: root.scale.x,
            yaw: binding.transform.yaw,
            world_to_local: Some(basis.inverse().to_cols_array()),
            plane_inverse: media_plane.as_ref().map(|plane| {
                super::media_geometry::plane_transform(plane, &transform)
                    .compute_affine()
                    .inverse()
            }),
        });
    }
    if let Some(ground) = &group.ground {
        let transform = ground
            .transform
            .as_ref()
            .map(super::group_runtime::scene_transform)
            .unwrap_or_default();
        let bounds = super::scene::ModelAabb::new(
            [-ground.width * 0.5, -0.075, -ground.depth * 0.5],
            [ground.width * 0.5, 0.075, ground.depth * 0.5],
        )
        .transformed(&root.mul_transform(transform));
        let basis = bevy::math::Mat3::from_quat(root.rotation) * root.scale.x;
        candidates.push(FilmSetItemCandidate {
            node_id: group.owner_id.clone(),
            item_id: "film-set-ground".into(),
            min: bounds.min,
            max: bounds.max,
            unit: root.scale.x,
            yaw: ground.transform.as_ref().map(|t| t.yaw).unwrap_or(0.0),
            world_to_local: Some(basis.inverse().to_cols_array()),
            plane_inverse: None,
        });
    }
    FilmSetItemPreparation {
        owner: Some(group.owner_id.clone()),
        candidates,
        part_bounds_evaluations: 0,
    }
}

/// accepted `modelFocus` 定位的复合资产节点；目标缺失/非片场/非复合资产返回 `None`。
///
/// 只读节点列表与 `composite_asset` 存在性，不读取部件、包围盒或媒体。
pub(crate) fn focused_composite_node(scene: &Scene) -> Option<&GraphNode> {
    scene
        .model_focus
        .as_ref()
        .and_then(|focus| scene.nodes.iter().find(|node| node.id == focus.node_id))
        .filter(|node| node.composite_asset.is_some())
}

/// 单个片场节点的内部对象候选：媒体平面 + `item_roots` 模型对象。
fn item_candidates(
    node: &GraphNode,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> (Vec<FilmSetItemCandidate>, u64) {
    let Some(film_set) = &node.composite_asset else {
        return (Vec::new(), 0);
    };
    let mut candidates = Vec::new();
    // 媒体平面候选：目标无 model 资源仍按既有根回退准备（纯媒体片场）。
    let media_model = node
        .model
        .as_ref()
        .and_then(|reference| lookup(&reference.resource_key));
    candidates.extend(
        film_set.media.iter().map(|plane| {
            super::media_geometry::item_candidate(node, media_model.as_deref(), plane)
        }),
    );
    if film_set.item_roots.is_empty() {
        return (candidates, 0);
    }
    let Some(reference) = &node.model else {
        return (candidates, 0);
    };
    let Some(model) = lookup(&reference.resource_key) else {
        return (candidates, 0);
    };
    let (worlds, evaluated) = super::film_set_item_world_aabbs_counted(
        node,
        &model,
        &reference.placement,
        &film_set.item_roots,
    );
    let unit = super::model_unit(node, &model, &reference.placement);
    let yaw = reference.placement.yaw.to_radians();
    candidates.extend(
        worlds
            .into_iter()
            .map(|(item_id, world)| FilmSetItemCandidate {
                node_id: node.id.clone(),
                item_id,
                unit,
                yaw,
                world_to_local: None,
                plane_inverse: None,
                min: world.min,
                max: world.max,
            }),
    );
    (candidates, evaluated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GraphNode;
    use serde_json::json;
    use std::collections::HashMap;

    fn node(json: serde_json::Value) -> GraphNode {
        serde_json::from_value(json).expect("graph node")
    }

    fn snapshot() -> ModelSnapshot {
        serde_json::from_value(json!({
            "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"items", "extent":2,
            "ops":[
                {"t":"group","id":"rootA"},
                {"t":"box","id":"bodyA","parent":"rootA","size":[2,2,2]},
                {"t":"group","id":"rootB"},
                {"t":"box","id":"bodyB","parent":"rootB","size":[4,4,4]}
            ]
        }))
        .expect("snapshot")
    }

    fn film_set(id: &str, roots: serde_json::Value) -> GraphNode {
        node(json!({
            "id":id,"type":"model","x":0,"y":0,"width":260,"height":195,
            "model":{"resourceKey":"v:sig"},
            "compositeAsset":{"x":0,"y":0,"width":260,"height":195,
                "itemRoots":roots,
                "media":[{"id":format!("{id}::photo"),"itemId":"photo","kind":"image",
                    "x":0,"y":10,"z":0,"width":32,"height":24,"yaw":0}]}
        }))
    }

    fn scene(nodes: Vec<GraphNode>, focus: Option<&str>) -> Scene {
        let mut scene = Scene {
            nodes,
            ..Scene::default()
        };
        scene.model_focus = focus.map(|node_id| {
            serde_json::from_value(json!({
                "version":"woohaa-model-focus-v1","nodeId":node_id,
                "target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87
            }))
            .expect("focus")
        });
        scene
    }

    fn lookup(_: &str) -> Option<Arc<ModelSnapshot>> {
        Some(Arc::new(snapshot()))
    }

    #[test]
    fn group_model_picking_uses_source_bounds_and_skips_missing_resources() {
        let owner =
            node(json!({"id":"group","type":"group","x":120,"y":80,"width":400,"height":300}));
        let mut scene = scene(vec![owner], Some("group"));
        scene.film_set_groups = serde_json::from_value(json!([{
            "schemaVersion":"woohaa-film-set-group-render-v1", "ownerId":"group",
            "badgeOrigin":{"x":0,"y":0}, "bindings":[{
                "bindingId":"binding", "sourceNodeId":"source", "kind":"model3d",
                "contentKey":"model:v1", "resourceKey":"model:v1",
                "transform":{"x":10,"y":0,"z":0,"yaw":0,"scale":2}, "visible":true
            }]
        }]))
        .unwrap();
        assert!(prepare_group(&scene, |_| None).candidates.is_empty());
        let result = prepare_group(&scene, lookup);
        assert_eq!(result.owner.as_deref(), Some("group"));
        assert_eq!(result.candidates.len(), 1);
        let root = super::super::media_geometry::film_set_root(&scene.nodes[0], None);
        let expected = super::super::scene::ModelAabb::new([6.0, -4.0, -4.0], [14.0, 4.0, 4.0])
            .transformed(&root);
        assert_eq!(result.candidates[0].min, expected.min);
        assert_eq!(result.candidates[0].max, expected.max);
        assert!(result.candidates[0].world_to_local.is_some());
        scene.film_set_groups[0].bindings[0].visible = false;
        assert!(prepare_group(&scene, lookup).candidates.is_empty());
    }

    #[test]
    fn group_media_picking_uses_rendered_plane_size_and_scene_transform() {
        let owner =
            node(json!({"id":"group","type":"group","x":120,"y":80,"width":400,"height":300}));
        let mut scene = scene(vec![owner], Some("group"));
        scene.film_set_groups = serde_json::from_value(json!([{
            "schemaVersion":"woohaa-film-set-group-render-v1", "ownerId":"group", "badgeOrigin":{"x":0,"y":0},
            "sceneTransform":{"x":2,"y":1,"z":0,"yaw":0.4,"scale":1.5},
            "bindings":[{"bindingId":"photo","sourceNodeId":"source","kind":"image","contentKey":"v1",
                "aspectRatio":2,"transform":{"x":3,"y":0,"z":1,"yaw":0.3,"scale":2},"visible":true}]
        }])).unwrap();
        let result = prepare_group(&scene, |_| None);
        let binding = &scene.film_set_groups[0].bindings[0];
        let root = super::super::media_geometry::film_set_root(&scene.nodes[0], None)
            .mul_transform(super::super::group_runtime::scene_transform(
                scene.film_set_groups[0].scene_transform.as_ref().unwrap(),
            ))
            .mul_transform(super::super::group_runtime::scene_transform(
                &binding.transform,
            ));
        let plane = super::super::media_geometry::group_media_plane("group", binding, None);
        assert_eq!(plane.height, 0.5);
        assert_eq!(plane.width, 1.0);
        let expected = super::super::scene::ModelAabb::new([-0.5, 0.0, 0.0], [0.5, 0.5, 0.0])
            .transformed(&root);
        assert_eq!(result.candidates[0].min, expected.min);
        assert_eq!(result.candidates[0].max, expected.max);
        assert!(result.candidates[0].plane_inverse.is_some());
    }

    /// 多片场总览（无 modelFocus）：提前关闭，不处理任何片场。
    #[test]
    fn overview_has_no_target_and_prepares_nothing() {
        let items = prepare(
            &scene(
                vec![
                    film_set("a", json!({"obj":"rootA"})),
                    film_set("b", json!({"obj":"rootB"})),
                ],
                None,
            ),
            lookup,
        );
        assert_eq!(items.owner, None);
        assert!(items.candidates.is_empty());
        assert_eq!(items.part_bounds_evaluations, 0);
    }

    /// 聚焦片场 A：只准备 A，不处理 B/C。
    #[test]
    fn focusing_one_film_set_prepares_only_that_target() {
        let items = prepare(
            &scene(
                vec![
                    film_set("a", json!({"obj":"rootA"})),
                    film_set("b", json!({"obj":"rootB"})),
                    film_set("c", json!({"obj":"rootA"})),
                ],
                Some("a"),
            ),
            lookup,
        );
        assert_eq!(items.owner.as_deref(), Some("a"));
        assert!(
            items
                .candidates
                .iter()
                .all(|candidate| candidate.node_id == "a")
        );
        // 媒体候选 + 一个模型对象候选。
        let ids: Vec<_> = items
            .candidates
            .iter()
            .map(|c| c.item_id.as_str())
            .collect();
        assert!(ids.contains(&"photo"), "{ids:?}");
        assert!(ids.contains(&"obj"), "{ids:?}");
        assert!(items.part_bounds_evaluations >= 2, "只对目标求值部件包围盒");
    }

    /// 普通模型聚焦（modelFocus 指向非 composite 节点）不启用内部对象索引。
    #[test]
    fn plain_model_focus_has_no_target() {
        let plain =
            node(json!({"id":"m","type":"model3d","x":0,"y":0,"model":{"resourceKey":"v:sig"}}));
        let items = prepare(
            &scene(
                vec![plain, film_set("a", json!({"obj":"rootA"}))],
                Some("m"),
            ),
            lookup,
        );
        assert_eq!(items.owner, None);
        assert!(items.candidates.is_empty());
        assert_eq!(items.part_bounds_evaluations, 0);
    }

    /// 目标缺失（聚焦 id 不在节点列表）不启用。
    #[test]
    fn missing_focus_node_has_no_target() {
        let items = prepare(
            &scene(vec![film_set("a", json!({"obj":"rootA"}))], Some("gone")),
            lookup,
        );
        assert_eq!(items.owner, None);
    }

    /// 空片场：目标明确、候选为空、无部件求值。
    #[test]
    fn empty_film_set_has_owner_and_no_candidates() {
        let empty = node(json!({
            "id":"empty","type":"model","x":0,"y":0,"width":260,"height":195,
            "compositeAsset":{"x":0,"y":0,"width":260,"height":195}
        }));
        let items = prepare(&scene(vec![empty], Some("empty")), lookup);
        assert_eq!(items.owner.as_deref(), Some("empty"));
        assert!(items.candidates.is_empty());
        assert_eq!(items.part_bounds_evaluations, 0);
    }

    /// 纯媒体片场：无 model 资源时仍准备合法媒体候选，不要求模型资源。
    #[test]
    fn media_only_film_set_prepares_media_candidates() {
        let only_media = node(json!({
            "id":"media","type":"model","x":0,"y":0,"width":260,"height":195,
            "compositeAsset":{"x":0,"y":0,"width":260,"height":195,
                "media":[{"id":"media::photo","itemId":"photo","kind":"image",
                    "x":0,"y":10,"z":0,"width":32,"height":24,"yaw":0}]}
        }));
        let items = prepare(&scene(vec![only_media], Some("media")), |_| None);
        assert_eq!(items.owner.as_deref(), Some("media"));
        assert_eq!(items.candidates.len(), 1);
        assert_eq!(items.candidates[0].item_id, "photo");
        assert!(items.candidates[0].plane_inverse.is_some());
        assert_eq!(items.part_bounds_evaluations, 0);
    }

    /// 未注册目标资源（item_roots 存在但 lookup 缺失）时目标仍合法，只是无模型对象候选。
    #[test]
    fn unregistered_model_resource_keeps_owner_without_model_candidates() {
        let items = prepare(
            &scene(vec![film_set("a", json!({"obj":"rootA"}))], Some("a")),
            |_| None,
        );
        assert_eq!(items.owner.as_deref(), Some("a"));
        assert!(
            items
                .candidates
                .iter()
                .all(|candidate| candidate.item_id == "photo")
        );
        assert_eq!(items.part_bounds_evaluations, 0);
    }

    /// `HashMap` 注入面保持纯几何：同一输入重复派生得到相同结果。
    #[test]
    fn derivation_is_deterministic() {
        let build = || {
            scene(
                vec![film_set("a", json!({"obj":"rootA","obj2":"rootB"}))],
                Some("a"),
            )
        };
        let first = prepare(&build(), lookup);
        let second = prepare(&build(), lookup);
        let sort = |mut items: FilmSetItemPreparation| {
            items.candidates.sort_by(|a, b| a.item_id.cmp(&b.item_id));
            items
        };
        assert_eq!(sort(first), sort(second));
        let _: HashMap<String, String> = HashMap::new();
    }
}
