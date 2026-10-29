//! Atomically split only batches containing new motion targets; keep the root alive.
use super::{
    batch_cache::{BatchBinding, BatchSource},
    runtime::{ModelRootLayout, ModelVisuals},
    scene,
};
use bevy::prelude::*;
use std::{collections::HashSet, sync::Arc};

pub(super) fn prepare(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    models: &mut ModelVisuals,
    playback: &crate::protocol::AnimationPlayback,
    targets: &HashSet<String>,
) {
    let node_id = &playback.node_id;
    let Some(root) = models.roots.get_mut(node_id) else {
        return;
    };
    let affected: HashSet<Entity> = targets
        .iter()
        .filter_map(|id| root.part_batches.get(id).copied())
        .collect();
    if affected.is_empty() {
        return;
    }
    let started = bevy::platform::time::Instant::now();
    let material_specs = scene::collect_materials(&root.resource);
    let mut replacements = Vec::new();
    #[allow(unused_mut)]
    let mut sources: Vec<_> = root
        .batches
        .iter()
        .filter(|batch| affected.contains(&batch.entity))
        .map(|batch| (batch.entity, batch.source.clone()))
        .collect();
    #[cfg(feature = "explicit-instancing")]
    if root
        .instance_parts
        .keys()
        .any(|entity| affected.contains(entity))
    {
        let specs = scene::build_entity_specs(&root.resource);
        for (entity, ids) in root
            .instance_parts
            .iter()
            .filter(|(entity, _)| affected.contains(entity))
        {
            let ids: HashSet<_> = ids.iter().collect();
            sources.push((
                *entity,
                Arc::new(BatchSource::new(
                    specs
                        .iter()
                        .filter(|spec| ids.contains(&spec.id))
                        .cloned()
                        .collect(),
                )),
            ));
        }
    }
    // Prepare every mesh before changing any entity/mapping. Failed preparation is retried.
    for (entity, source) in sources {
        let mut parts = Vec::new();
        let mut remaining = Vec::new();
        for spec in &source.specs {
            if !targets.contains(&spec.id) {
                remaining.push(spec.clone());
                continue;
            }
            let geometry = spec.geometry.as_ref().expect("batch geometry");
            let base = super::mesh::mesh_key(geometry);
            // 每几何有效档位：总览根的自定义 Mesh / Box 恒 High，与 spawn/quality 一致
            // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
            let effective =
                super::mesh::effective_quality(geometry, root.quality, root.overview_lod);
            let Some((mesh, geometry)) = models.shared.mesh(meshes, &base, geometry, effective)
            else {
                return;
            };
            let material = models.shared.material(
                materials,
                scene::standard_material_for(&spec.material_key, &material_specs),
            );
            parts.push((spec.clone(), base, mesh, geometry, material));
        }
        let material = models.shared.material(
            materials,
            scene::standard_material_for(&source.specs[0].material_key, &material_specs),
        );
        let replacement = if remaining.is_empty() {
            None
        } else {
            let source = Arc::new(BatchSource::new(remaining));
            // 剩余批次同样按每几何有效档位下限请求，纯盒复用原表示
            // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
            let batch_quality = source
                .specs
                .iter()
                .filter_map(|spec| spec.geometry.as_ref())
                .map(|geometry| {
                    super::mesh::effective_quality(geometry, root.quality, root.overview_lod)
                })
                .min()
                .unwrap_or(root.quality);
            let Some(asset) = models.shared.batches.get(meshes, &source, batch_quality) else {
                return;
            };
            Some((source, asset))
        };
        replacements.push((entity, parts, replacement, material));
    }
    let mesh_prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut prepared = 0;
    for (entity, parts, replacement, material) in replacements {
        root.batches.retain(|batch| batch.entity != entity);
        root.part_batches.retain(|_, owner| *owner != entity);
        #[cfg(feature = "explicit-instancing")]
        if root.instance_parts.remove(&entity).is_some() {
            root.geometries.retain(|(owner, _, _)| *owner != entity);
            commands
                .entity(entity)
                .remove::<super::instancing::Instances>()
                .remove::<MeshMaterial3d<super::instancing::InstanceMaterial>>()
                .remove::<bevy::render::batching::NoAutomaticBatching>();
        }
        if let Some((source, asset)) = replacement {
            commands.entity(entity).insert((
                Mesh3d(asset.handle.clone()),
                MeshMaterial3d(material.clone()),
                bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
            ));
            for spec in &source.specs {
                root.part_batches.insert(spec.id.clone(), entity);
                // 剩余合批块的部件仍映射到该块的材质（对象根透明度按此克隆实例，D2）。
                root.part_materials
                    .insert(spec.id.clone(), material.clone());
            }
            root.mesh_handles.push(asset.handle.clone());
            root.batches.push(BatchBinding::new(entity, source, asset));
        } else {
            commands.entity(entity).try_despawn();
            root.entities.retain(|id| *id != entity);
        }
        for (spec, base, mesh, geometry, material) in parts {
            let transform = Transform {
                translation: Vec3::from_array(spec.position),
                rotation: scene::quat_from_xyz_radians(spec.rotation_radians),
                scale: Vec3::from_array(spec.scale),
            };
            let ModelRootLayout::V2 { root: anchor } = root.layout;
            let parent = spec
                .parent
                .as_ref()
                .and_then(|id| root.part_entities.get(id))
                .copied()
                .unwrap_or(anchor);
            let entity = commands
                .spawn((
                    Mesh3d(mesh.clone()),
                    MeshMaterial3d(material.clone()),
                    transform,
                    super::model_render_layers(),
                    ChildOf(parent),
                ))
                .id();
            root.entities.push(entity);
            root.part_entities.insert(spec.id.clone(), entity);
            root.part_bases.insert(spec.id.clone(), transform);
            root.part_materials
                .insert(spec.id.clone(), material.clone());
            root.prepared_targets.insert(spec.id);
            root.geometries.push((entity, base, geometry));
            root.mesh_handles.push(mesh);
            root.material_handles.push(material);
            prepared += 1;
        }
    }
    root.mesh_handles = root
        .geometries
        .iter()
        .filter_map(|(_, base, geometry)| {
            // 有效档位（总览根自定义 Mesh/Box 恒 High），避免低档 lookup 漏掉 High handle。
            let effective =
                super::mesh::effective_quality(geometry, root.quality, root.overview_lod);
            models.shared.lookup(base, geometry, effective).cloned()
        })
        .chain(root.batches.iter().map(|batch| batch.asset.handle.clone()))
        .collect();
    root.mesh_handles.sort_by_key(|handle| handle.id());
    root.mesh_handles.dedup_by_key(|handle| handle.id());
    root.material_handles.sort_by_key(|handle| handle.id());
    root.material_handles.dedup_by_key(|handle| handle.id());
    root.active_mesh_handles = root.mesh_handles.clone();
    root.representation_generation = root.representation_generation.wrapping_add(1);
    let generation = root.representation_generation;
    models.record_playback(
        serde_json::json!({"event":"target-preparation", "nodeId":node_id,
        "clipId":playback.clip_id, "generation":playback.generation,
        "meshPrepareMs":mesh_prepare_ms,
        "targets":prepared, "blocks":affected.len(), "representationGeneration":generation,
        "cpuMs": started.elapsed().as_secs_f64() * 1000.0}),
    );
}
