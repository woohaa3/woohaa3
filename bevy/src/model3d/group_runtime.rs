//! Group-owned composition keeps a separate entity subtree for each resource binding.
use super::{
    quality::Quality,
    runtime::{ModelRootLayout, ModelVisuals},
};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};
use bevy::prelude::*;
use std::{collections::HashMap, sync::Arc};

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
        )
    });
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
        let desired = split(resource);
        let stale: Vec<_> = owner
            .group_children
            .keys()
            .filter(|id| !desired.contains_key(*id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(child) = owner.group_children.remove(&id) {
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
                false,
                models.batching_strategy,
                child_overview,
            );
            let ModelRootLayout::V2 { root } = child.layout;
            commands.entity(anchor).add_child(root);
            child.content_signature = snapshot.signature.clone();
            child.resource = snapshot;
            owner.group_children.insert(id, child);
        }
        owner.entities = vec![anchor];
        owner.part_entities.clear();
        owner.part_bases.clear();
        owner.part_materials.clear();
        owner.animation_entities.clear();
        owner.geometries.clear();
        owner.mesh_handles.clear();
        owner.active_mesh_handles.clear();
        owner.material_handles.clear();
        for child in owner.group_children.values() {
            owner.entities.extend(child.entities.iter().copied());
            owner.part_entities.extend(
                child
                    .part_entities
                    .iter()
                    .map(|(id, entity)| (id.clone(), *entity)),
            );
            owner.part_bases.extend(
                child
                    .part_bases
                    .iter()
                    .map(|(id, transform)| (id.clone(), *transform)),
            );
            owner.part_materials.extend(
                child
                    .part_materials
                    .iter()
                    .map(|(id, material)| (id.clone(), material.clone())),
            );
            owner
                .animation_entities
                .extend(child.animation_entities.iter().copied());
            owner.geometries.extend(child.geometries.iter().cloned());
            owner
                .mesh_handles
                .extend(child.mesh_handles.iter().cloned());
            owner
                .active_mesh_handles
                .extend(child.active_mesh_handles.iter().cloned());
            owner
                .material_handles
                .extend(child.material_handles.iter().cloned());
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
