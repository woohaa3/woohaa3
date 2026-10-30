//! Group-owned composition keeps a separate entity subtree for each resource binding.
use super::{
    quality::Quality,
    runtime::{ModelRootLayout, ModelVisuals},
};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};
use bevy::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

fn object_id(op: &ModelOp) -> &str {
    match op {
        ModelOp::Material { id, .. }
        | ModelOp::Group { id, .. }
        | ModelOp::Box { id, .. }
        | ModelOp::Cylinder { id, .. }
        | ModelOp::Mesh { id, .. }
        | ModelOp::Sphere { id, .. }
        | ModelOp::Capsule { id, .. }
        | ModelOp::Segment { id, .. }
        | ModelOp::Oscillate { id, .. }
        | ModelOp::Move { id, .. }
        | ModelOp::Rotate { id, .. } => id,
    }
}

fn split(resource: &ModelSnapshot) -> HashMap<String, Arc<ModelSnapshot>> {
    let mut objects: HashMap<String, Vec<ModelOp>> = HashMap::new();
    for op in &resource.ops {
        let id = object_id(op);
        let Some((length, rest)) = id.split_once(':') else {
            continue;
        };
        let Ok(length) = length.parse::<usize>() else {
            continue;
        };
        // TS identity uses UTF-16 length. Binding ids are restricted ASCII by the marker.
        let Some(binding) = rest.get(..length) else {
            continue;
        };
        objects
            .entry(binding.to_owned())
            .or_default()
            .push(op.clone());
    }
    objects
        .into_iter()
        .map(|(id, ops)| {
            let signature =
                crate::protocol::fnv1a64_utf16(&serde_json::to_string(&ops).unwrap_or_default());
            (
                id,
                Arc::new(ModelSnapshot {
                    ops,
                    signature,
                    extent: resource.extent,
                    ..Default::default()
                }),
            )
        })
        .collect()
}

/// 子根销毁前把 owner 上由它贡献的批次条目一并摘除。
///
/// 批次实体属于子根，但 `ModelRoot.batches`/`part_batches` 由 owner 统一持有（总览 LOD 的
/// 原子发布与播放替换只读取 owner）；不摘除会留下已销毁实体。
fn detach_batches(owner: &mut super::runtime::ModelRoot, entities: &[Entity]) {
    owner.batches.retain(|batch| !entities.contains(&batch.entity));
    owner
        .part_batches
        .retain(|_, entity| !entities.contains(entity));
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    models: &mut ModelVisuals,
    node: &GraphNode,
    resource: &Arc<ModelSnapshot>,
    placement: &ModelPlacement,
    group: &crate::protocol::FilmSetGroupPreparation,
    quality: Quality,
    overview: bool,
    batched: bool,
) {
    models.preparation.cancel(&node.id);
    let previous = models.roots.remove(&node.id);
    let previous = if previous
        .as_ref()
        .is_some_and(|root| root.group_children.is_empty() && !root.part_entities.is_empty())
    {
        super::runtime::despawn_root(commands, materials, previous.unwrap());
        None
    } else {
        previous
    };
    let created = previous.is_none();
    let mut owner = previous.unwrap_or_else(|| {
        super::spawn::spawn_v2(
            commands,
            meshes,
            materials,
            &ModelSnapshot::default(),
            Vec3::ZERO,
            1.0,
            Quat::IDENTITY,
            quality,
            &mut models.shared,
            false,
            models.batching_strategy,
            overview,
            &HashSet::new(),
        )
    });
    // 合批开关变化（进入聚焦/对象编辑、截图 High 消费者等）需要重建子根：合批部件没有
    // 独立实体，逐部件动画/拾取只在非合批表示上成立。
    if owner.batched != batched {
        let children: Vec<_> = owner.group_children.drain().map(|(_, child)| child).collect();
        for child in children {
            detach_batches(&mut owner, &child.entities);
            owner.opacity.remove_entities(materials, &child.entities);
            super::runtime::despawn_root(commands, materials, child);
        }
        owner.batched = batched;
        owner.content_signature.clear();
        owner.representation_generation = owner.representation_generation.wrapping_add(1);
    }
    // 根已存在时保留当前档位（由 `sync_quality` 推进）；声明变化才重置决策状态。
    if owner.overview_lod != overview {
        owner.overview_lod = overview;
        owner.quality = quality;
        owner.overview_desired = quality;
        owner.overview_reason = "initial";
        owner.quality_changed_at = None;
        owner.overview_medium_since = None;
        owner.projection = Default::default();
        owner.quality_refresh_pending = false;
        owner.representation_generation = owner.representation_generation.wrapping_add(1);
    }
    let child_quality = owner.quality;
    let child_overview = owner.overview_lod;
    let ModelRootLayout::V2 { root: anchor } = owner.layout;
    if owner.content_signature != resource.signature || !Arc::ptr_eq(&owner.resource, resource) {
        // 播放替换会由 `playback_prepare` 直接往 owner 插入部件实体（不在任何子根的
        // `entities` 里）。内容重建前先回收，否则旧快照的替换部件会作为孤儿留在场景里。
        let live: HashSet<Entity> = owner
            .group_children
            .values()
            .flat_map(|child| child.entities.iter().copied())
            .collect();
        for entity in owner.entities.iter().copied() {
            if entity != anchor && !live.contains(&entity) {
                commands.entity(entity).try_despawn();
            }
        }
        let desired = split(resource);
        // 每个 binding 的根实体承载运行时的摆放/显隐；合批以它为屏障，批次仍挂在该实体下，
        // 否则 `item_placement::sync` 写入的 transform 会与平铺后的几何脱节。
        let barriers: HashSet<String> = desired
            .keys()
            .map(|id| format!("{}:{}", id.len(), id))
            .collect();
        let stale: Vec<_> = owner
            .group_children
            .keys()
            .filter(|id| !desired.contains_key(*id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(child) = owner.group_children.remove(&id) {
                detach_batches(&mut owner, &child.entities);
                owner.opacity.remove_entities(materials, &child.entities);
                super::runtime::despawn_root(commands, materials, child);
            }
        }
        for (id, snapshot) in desired {
            if owner
                .group_children
                .get(&id)
                .is_some_and(|child| child.content_signature == snapshot.signature)
            {
                continue;
            }
            if let Some(child) = owner.group_children.remove(&id) {
                detach_batches(&mut owner, &child.entities);
                owner.opacity.remove_entities(materials, &child.entities);
                super::runtime::despawn_root(commands, materials, child);
            }
            let mut child = super::spawn::spawn_v2(
                commands,
                meshes,
                materials,
                &snapshot,
                Vec3::ZERO,
                1.0,
                Quat::IDENTITY,
                child_quality,
                &mut models.shared,
                batched,
                models.batching_strategy,
                child_overview,
                &barriers,
            );
            let ModelRootLayout::V2 { root } = child.layout;
            commands.entity(anchor).add_child(root);
            child.content_signature = snapshot.signature.clone();
            child.resource = snapshot;
            // 批次与部件索引上收到 owner：总览 LOD 的整根原子发布、播放替换与诊断都从
            // owner 读取。批次实体仍由子根持有并在其销毁时摘除（`detach_batches`）。
            owner.batches.append(&mut child.batches);
            owner.part_batches.extend(child.part_batches.drain());
            owner.group_children.insert(id, child);
        }
        let mut entities = vec![anchor];
        let mut part_entities = HashMap::new();
        let mut part_bases = HashMap::new();
        let mut part_materials = HashMap::new();
        let mut animation_entities = Vec::new();
        let mut geometries = Vec::new();
        // 句柄集合与已发布档位有关：保留既有句柄再并入子根句柄，避免内容变化瞬间把仍在
        // `Mesh3d` 上的高档句柄从保留集合里挤掉；随后强制一次重发布收敛到精确集合。
        let mut mesh_handles = std::mem::take(&mut owner.mesh_handles);
        let mut active_mesh_handles = std::mem::take(&mut owner.active_mesh_handles);
        let mut material_handles = Vec::new();
        for child in owner.group_children.values() {
            entities.extend(child.entities.iter().copied());
            part_entities.extend(
                child
                    .part_entities
                    .iter()
                    .map(|(id, entity)| (id.clone(), *entity)),
            );
            part_bases.extend(
                child
                    .part_bases
                    .iter()
                    .map(|(id, transform)| (id.clone(), *transform)),
            );
            part_materials.extend(
                child
                    .part_materials
                    .iter()
                    .map(|(id, material)| (id.clone(), material.clone())),
            );
            animation_entities.extend(child.animation_entities.iter().copied());
            geometries.extend(child.geometries.iter().cloned());
            mesh_handles.extend(child.mesh_handles.iter().cloned());
            active_mesh_handles.extend(child.active_mesh_handles.iter().cloned());
            material_handles.extend(child.material_handles.iter().cloned());
        }
        mesh_handles.sort_by_key(|handle| handle.id());
        mesh_handles.dedup_by_key(|handle| handle.id());
        active_mesh_handles.sort_by_key(|handle| handle.id());
        active_mesh_handles.dedup_by_key(|handle| handle.id());
        material_handles.sort_by_key(|handle| handle.id());
        material_handles.dedup_by_key(|handle| handle.id());
        owner.entities = entities;
        owner.part_entities = part_entities;
        owner.part_bases = part_bases;
        owner.part_materials = part_materials;
        owner.animation_entities = animation_entities;
        owner.geometries = geometries;
        owner.mesh_handles = mesh_handles;
        owner.active_mesh_handles = active_mesh_handles;
        owner.material_handles = material_handles;
        // 子根重建后主动重发布一次：把句柄集合与批次资产收敛到当前档位的精确结果。
        // 首次创建时子根已按当前档位建好，且空根（无部件/批次）没有可发布内容。
        if !created && (!owner.geometries.is_empty() || !owner.batches.is_empty()) {
            owner.quality_refresh_pending = true;
        }
        owner.representation_generation = owner.representation_generation.wrapping_add(1);
    }
    owner.content_signature = resource.signature.clone();
    owner.resource = resource.clone();
    owner.placement = placement.clone();
    super::runtime::apply_root_transform(commands, &owner.layout, node, resource, placement);
    if let Some(t) = &group.scene_transform {
        let base = super::layout::film_set_root_transform(node, resource, placement);
        commands
            .entity(anchor)
            .insert(base.mul_transform(scene_transform(t)));
    }
    owner.batched = batched;
    models.roots.insert(node.id.clone(), owner);
}

pub(super) fn scene_transform(t: &crate::protocol::FilmSetGroupTransform) -> Transform {
    Transform {
        translation: Vec3::new(t.x, t.y, t.z),
        rotation: Quat::from_rotation_y(t.yaw),
        scale: Vec3::splat(t.scale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::world::CommandQueue;
    use serde_json::json;

    fn resource(size: f32, include_b: bool) -> Arc<ModelSnapshot> {
        let mut ops = vec![
            json!({"t":"group","id":"1:a"}),
            json!({"t":"box","id":"1:a4:body","parent":"1:a","size":[size,1,1]}),
        ];
        if include_b {
            ops.extend([
                json!({"t":"group","id":"1:b"}),
                json!({"t":"box","id":"1:b4:body","parent":"1:b","size":[1,1,1]}),
            ]);
        }
        Arc::new(serde_json::from_value(json!({"sceneVersion":"woohaa-model-scene-ir-v2","signature":format!("{size}:{include_b}"),"extent":2,"ops":ops})).unwrap())
    }

    #[test]
    fn source_replacement_retains_other_binding_entities_and_reclaims_removed_subtrees() {
        let node: GraphNode = serde_json::from_value(
            json!({"id":"film","type":"group","x":0,"y":0,"width":400,"height":300}),
        )
        .unwrap();
        let group = serde_json::from_value(json!({"schemaVersion":"woohaa-film-set-group-render-v1","ownerId":"film","badgeOrigin":{"x":0,"y":0},"bindings":[]})).unwrap();
        let mut world = World::new();
        let mut models = ModelVisuals::default();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let mut apply =
            |world: &mut World, models: &mut ModelVisuals, resource: Arc<ModelSnapshot>| {
                let mut queue = CommandQueue::default();
                {
                    let mut commands = Commands::new(&mut queue, world);
                    sync(
                        &mut commands,
                        &mut meshes,
                        &mut materials,
                        models,
                        &node,
                        &resource,
                        &ModelPlacement::default(),
                        &group,
                        Quality::High,
                        false,
                        false,
                    );
                }
                queue.apply(world);
            };
        apply(&mut world, &mut models, resource(1.0, true));
        let anchor = models.roots["film"].entities[0];
        let a = models.roots["film"].group_children["a"].entities.clone();
        let b = models.roots["film"].group_children["b"].entities.clone();
        apply(&mut world, &mut models, resource(2.0, true));
        assert_eq!(models.roots["film"].entities[0], anchor);
        assert_eq!(models.roots["film"].group_children["b"].entities, b);
        assert_ne!(models.roots["film"].group_children["a"].entities, a);
        assert!(a.iter().all(|entity| world.get_entity(*entity).is_err()));
        assert!(b.iter().all(|entity| world.get_entity(*entity).is_ok()));
        let retained_a = models.roots["film"].group_children["a"].entities.clone();
        apply(&mut world, &mut models, resource(2.0, false));
        assert_eq!(
            models.roots["film"].group_children["a"].entities,
            retained_a
        );
        assert!(b.iter().all(|entity| world.get_entity(*entity).is_err()));
    }
}
