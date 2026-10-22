//! V2 entity hierarchy 构建与动画挂载
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2；
//!  change: 2026-10-07-remove-residual-compatibility —— 删除 V1 平铺构建路径）。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};

use super::animation::{
    self, TransformAnimation, TransformAnimationKind, TransformAnimationPlayback,
};
use super::layout::{model_anchor, model_unit, model_view_rotation};
use super::mesh::mesh_key;
use super::quality::Quality;
use super::resources::SharedResources;
use super::runtime::{ModelAnchor, ModelRoot, ModelRootLayout};
use super::scene::{self, collect_materials};

/// 构建模型根（V2 层级），并记录内容/根 transform identity。
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_model(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    quality: Quality,
    shared: &mut SharedResources,
    batched: bool,
    strategy: super::batch_strategy::BatchStrategy,
    overview: bool,
) -> ModelRoot {
    let unit = model_unit(node, model, placement);
    let root_rotation = model_view_rotation(placement);
    let world = model_anchor(node, model, placement, unit);
    let mut root = spawn_v2(
        commands,
        meshes,
        materials,
        model,
        world,
        unit,
        root_rotation,
        quality,
        shared,
        batched,
        strategy,
        overview,
    );
    root.content_signature = model.signature.clone();
    root
}

/// V2：建立真实 entity hierarchy；根 entity 承载 placement yaw 与单位缩放。
#[allow(clippy::too_many_arguments)]
fn spawn_v2(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    model: &ModelSnapshot,
    root_translation: Vec3,
    unit: f32,
    root_rotation: Quat,
    quality: Quality,
    shared: &mut SharedResources,
    batched: bool,
    strategy: super::batch_strategy::BatchStrategy,
    overview: bool,
) -> ModelRoot {
    let root = commands
        .spawn((
            ModelAnchor,
            Transform {
                translation: root_translation,
                rotation: root_rotation,
                scale: Vec3::splat(unit),
            },
            Visibility::default(),
            super::model_render_layers(),
        ))
        .id();

    let specs = scene::build_entity_specs(model);
    let material_specs = collect_materials(model);
    let mut mesh_cache: HashMap<String, Handle<Mesh>> = HashMap::new();
    let mut material_cache: HashMap<String, Handle<StandardMaterial>> = HashMap::new();
    let mut entities: HashMap<String, Entity> = HashMap::new();
    let mut base_transforms: HashMap<String, Transform> = HashMap::new();
    let mut spawned = vec![root];
    let mut geometries = Vec::new();
    let opaque = specs
        .iter()
        .filter(|spec| {
            let material = scene::standard_material_for(&spec.material_key, &material_specs);
            material.alpha_mode == bevy::material::AlphaMode::Opaque
        })
        .map(|spec| spec.material_key.clone())
        .collect();
    let plans = if batched && strategy == super::batch_strategy::BatchStrategy::Spatial {
        super::batching::plan(&specs, &opaque, &Default::default())
    } else {
        Vec::new()
    };
    let mut batches = Vec::new();
    let mut batch_parents = Vec::new();
    let mut batched_parts = std::collections::HashSet::new();
    #[cfg(feature = "explicit-instancing")]
    let mut instance_parts = HashMap::new();
    #[cfg(feature = "explicit-instancing")]
    if batched && strategy == super::batch_strategy::BatchStrategy::Explicit {
        for group in super::instancing::spawn_groups(commands, meshes, materials, shared,
            &specs, &opaque, &material_specs, quality) {
            batched_parts.extend(group.indices);
            mesh_cache.insert(format!("instance:{:?}", group.entity), group.mesh);
            material_cache.insert(format!("instance:{:?}", group.entity), group.material);
            spawned.push(group.entity);
            batch_parents.push((group.entity, group.parent));
            instance_parts.insert(group.entity, group.instances.parts);
            geometries.push((group.entity, group.base, group.geometry));
        }
    }
    for plan in plans {
        let source = std::sync::Arc::new(super::batch_cache::BatchSource::new(
            plan.parts.iter().map(|&i| specs[i].clone()).collect(),
        ));
        // 纯盒批次各档几何相同：以有效档位下限请求即可复用同一表示，避免无收益的复制
        // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
        let batch_quality = plan
            .parts
            .iter()
            .filter_map(|&i| specs[i].geometry.as_ref())
            .map(|geometry| super::mesh::effective_quality(geometry, quality, overview))
            .min()
            .unwrap_or(quality);
        let Some(asset) = shared.batches.get(meshes, &source, batch_quality) else {
            continue;
        };
        let material = material_cache
            .entry(plan.material.clone())
            .or_insert_with(|| {
                shared.material(
                    materials,
                    scene::standard_material_for(&plan.material, &material_specs),
                )
            })
            .clone();
        let entity = commands
            .spawn((
                Mesh3d(asset.handle.clone()),
                MeshMaterial3d(material),
                Transform::default(),
                super::model_render_layers(),
                bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
            ))
            .id();
        batched_parts.extend(plan.parts);
        mesh_cache.insert(format!("batch:{}", batches.len()), asset.handle.clone());
        spawned.push(entity);
        batch_parents.push((entity, plan.parent));
        batches.push(super::batch_cache::BatchBinding::new(entity, source, asset));
    }

    // 两遍：先建实体（parent 已先出现），再挂父子关系，保证命令顺序稳定。
    for (spec_index, spec) in specs.iter().enumerate() {
        if batched_parts.contains(&spec_index) {
            continue;
        }
        let transform = Transform {
            translation: Vec3::from_array(spec.position),
            rotation: scene::quat_from_xyz_radians(spec.rotation_radians),
            scale: Vec3::from_array(spec.scale),
        };
        let entity = match &spec.geometry {
            None => commands
                .spawn((
                    transform,
                    Visibility::default(),
                    super::model_render_layers(),
                ))
                .id(),
            Some(geometry) => {
                // Prepared content survives lazy despawn/respawn and root clones.
                // Unprepared internal/test snapshots retain a safe fallback.
                let base = model
                    .geometry_keys
                    .as_ref()
                    .and_then(|keys| keys.get(spec_index))
                    .and_then(Option::as_ref)
                    .cloned()
                    .unwrap_or_else(|| mesh_key(geometry));
                // 每几何有效档位：总览根的自定义 Mesh 保持 High，不新增简化任务。
                let effective = super::mesh::effective_quality(geometry, quality, overview);
                let Some((mesh, shared_geometry)) = shared.mesh(meshes, &base, geometry, effective)
                else {
                    continue;
                };
                mesh_cache.insert(
                    super::mesh::quality_key(&base, geometry, effective),
                    mesh.clone(),
                );
                let material = material_cache
                    .entry(spec.material_key.clone())
                    .or_insert_with(|| {
                        shared.material(
                            materials,
                            scene::standard_material_for(&spec.material_key, &material_specs),
                        )
                    })
                    .clone();
                let entity = commands
                    .spawn((
                        Mesh3d(mesh),
                        MeshMaterial3d(material),
                        transform,
                        super::model_render_layers(),

                    ))
                    .id();
                geometries.push((entity, base, shared_geometry));
                entity
            }
        };
        entities.insert(spec.id.clone(), entity);
        base_transforms.insert(spec.id.clone(), transform);
        spawned.push(entity);
    }
    for spec in &specs {
        let Some(entity) = entities.get(&spec.id).copied() else {
            continue;
        };
        let parent = spec
            .parent
            .as_ref()
            .and_then(|id| entities.get(id).copied())
            .unwrap_or(root);
        commands.entity(entity).insert(ChildOf(parent));
    }
    for (entity, parent) in batch_parents {
        let parent = parent
            .as_ref()
            .and_then(|id| entities.get(id))
            .copied()
            .unwrap_or(root);
        commands.entity(entity).insert(ChildOf(parent));
    }
    let animation_entities = attach_animations(commands, &model.ops, &entities, &base_transforms);

    #[allow(unused_mut)]
    let mut part_batches: HashMap<String, Entity> = batches.iter().flat_map(|batch| batch.ranges.iter().map(move |range| (range.id.clone(), batch.entity))).collect();
    #[cfg(feature = "explicit-instancing")]
    for (entity, ids) in &instance_parts { for id in ids.iter() { part_batches.insert(id.clone(), *entity); } }
    ModelRoot {
        entities: spawned,
        content_signature: String::new(),
        resource: std::sync::Arc::new(ModelSnapshot::default()),
        placement: ModelPlacement::default(),
        layout: ModelRootLayout::V2 { root },
        mesh_handles: mesh_cache.values().cloned().collect(),
        active_mesh_handles: mesh_cache.values().cloned().collect(),
        geometries,
        batched,
        part_batches,
        prepared_targets: Default::default(),
        batches,
        #[cfg(feature = "explicit-instancing")]
        instance_parts,
        quality,
        quality_changed_at: None,
        overview_medium_since: None,
        quality_refresh_pending: false,
        representation_generation: 0,
        overview_lod: overview,
        projection: Default::default(),
        overview_fraction: None,
        overview_desired: quality,
        overview_reason: "initial",
        material_handles: material_cache.into_values().collect(),
        animation_entities,
        part_entities: entities,
        part_bases: base_transforms,
    }
}

/// 把动画组件挂到目标 entity 的 **局部** transform 上；返回挂载了动画的实体集合。
fn attach_animations(
    commands: &mut Commands,
    ops: &[ModelOp],
    entities: &HashMap<String, Entity>,
    base_transforms: &HashMap<String, Transform>,
) -> Vec<Entity> {
    let mut animation_entities = Vec::new();
    for operation in ops {
        let Some(kind) = animation_kind_for(operation) else {
            continue;
        };
        let id = animation_target(operation);
        if let Some(entity) = entities.get(id) {
            commands.entity(*entity).insert((
                TransformAnimation {
                    base: base_transforms.get(id).copied().unwrap_or_default(),
                    kind,
                },
                // 模型动画默认停止：只有 hover 门禁显式激活后才推进
                // （change: play-model-animations-on-hover，design D2）。
                TransformAnimationPlayback::default(),
            ));
            animation_entities.push(*entity);
        }
    }
    animation_entities
}

/// op → 动画种类（无动画返回 `None`）；`attach_animations` 与根 transform 刷新共用。
pub(super) fn animation_kind_for(operation: &ModelOp) -> Option<TransformAnimationKind> {
    match operation {
        ModelOp::Rotate { axis, speed, .. } => Some(TransformAnimationKind::Rotate {
            axis: animation::animation_axis(axis),
            speed: *speed,
        }),
        ModelOp::Move {
            axis, speed, range, ..
        } => Some(TransformAnimationKind::LoopMove {
            axis: animation::animation_axis(axis),
            speed: *speed,
            range: *range,
        }),
        ModelOp::Oscillate {
            axis,
            speed,
            mode,
            amplitude,
            phase,
            ..
        } => Some(TransformAnimationKind::Oscillate {
            axis: animation::animation_axis(axis),
            speed: *speed,
            mode: animation::oscillate_mode(mode),
            amplitude: *amplitude,
            phase: *phase,
        }),
        _ => None,
    }
}

/// 动画 op 的目标 id。
pub(super) fn animation_target(operation: &ModelOp) -> &str {
    match operation {
        ModelOp::Rotate { id, .. } | ModelOp::Move { id, .. } | ModelOp::Oscillate { id, .. } => id,
        _ => "",
    }
}
