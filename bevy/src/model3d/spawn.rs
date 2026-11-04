//! V2 entity hierarchy 构建与动画挂载
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2；
//!  change: 2026-10-07-remove-residual-compatibility —— 删除 V1 平铺构建路径）。

use std::collections::{HashMap, HashSet};

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;

use crate::canvas_ecs::components::{ModelBatch, ModelOwner, ModelPart};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelSnapshot};

use super::animation::{
    self, TransformAnimation, TransformAnimationKind, TransformAnimationPlayback,
};
use super::layout::model_root_transform;
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
) -> ModelRoot {
    let transform = model_root_transform(node, model, placement);
    let mut root = spawn_v2(
        commands,
        meshes,
        materials,
        model,
        transform.translation,
        transform.scale.x,
        transform.rotation,
        quality,
        shared,
        batched,
        strategy,
        &HashSet::new(),
    );
    root.content_signature = model.signature.clone();
    root
}

/// 一次性预览根的句柄：只有「建起来的是哪些实体/资产」与「用完怎么拆」。
///
/// 历史缩略图作业**不**把根登记进 `ModelVisuals`（那会被主场景同步清理），而是持有一份
/// 临时根，渲染一帧后整体拆除（change: 2026-10-26-move-generation-history-to-ai-center，D6）。
pub(crate) struct PreviewRoot {
    pub(crate) entities: Vec<Entity>,
    pub(crate) meshes: Vec<bevy::asset::AssetId<Mesh>>,
    pub(crate) materials: Vec<bevy::asset::AssetId<StandardMaterial>>,
}

/// 在给定渲染层上建立一次性模型根（单位缩放、原点摆放、无 batching）。
///
/// 供页面内历史缩略图使用：内容来自服务端权威脚本派生的 Scene IR，只在一个租用的
/// 预览层上可见，主画布相机看不到它。
pub(crate) fn spawn_preview_root(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    model: &ModelSnapshot,
    layer: usize,
) -> PreviewRoot {
    // 预览根不与主场景共享 mesh/material 缓存：共享表按根持有资源，临时根退出后
    // 留下的条目只会污染 LRU 归属。每帧成本由缩略图尺寸与串行队列限定。
    let mut shared = SharedResources::default();
    let root = spawn_v2(
        commands,
        meshes,
        materials,
        model,
        Vec3::ZERO,
        1.0,
        Quat::IDENTITY,
        Quality::High,
        &mut shared,
        false,
        super::batch_strategy::BatchStrategy::Spatial,
        &HashSet::new(),
    );
    // 每个实体单独写入租用层：`RenderLayers` 不随层级继承，缺省层（0）会被主画布相机看到。
    let layers = RenderLayers::from_layers(&[layer]);
    for entity in &root.entities {
        commands.entity(*entity).insert(layers.clone());
    }
    PreviewRoot {
        entities: root.entities,
        meshes: root.mesh_handles.iter().map(|handle| handle.id()).collect(),
        materials: root
            .material_handles
            .iter()
            .map(|handle| handle.id())
            .collect(),
    }
}

/// V2：建立真实 entity hierarchy；根 entity 承载 placement yaw 与单位缩放。
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_v2(
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
    barriers: &HashSet<String>,
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
    // 根自持 owner：派生实体统一携带 `ModelOwner { root }`，运行时可按根回收/隔离，
    // 不必把所有实体句柄留在 `ModelRoot` 里（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，5.1）。
    commands.entity(root).insert(ModelOwner { root });

    let mut specs = scene::build_entity_specs(model);
    let material_specs = collect_materials(model);
    let mut mesh_cache: HashMap<String, Handle<Mesh>> = HashMap::new();
    let mut material_cache: HashMap<String, Handle<StandardMaterial>> = HashMap::new();
    let mut entities: HashMap<String, Entity> = HashMap::new();
    let mut base_transforms: HashMap<String, Transform> = HashMap::new();
    // 稳定部件 id → 该部件当前使用的共享材质（透明度动作据此克隆实例）。
    let mut part_materials: HashMap<String, Handle<StandardMaterial>> = HashMap::new();

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
    // 总览片场把只做平移的父级分组平铺到根空间，按材质合并批次（draw call 优化）。
    let plans = if batched && strategy == super::batch_strategy::BatchStrategy::Spatial {
        let planned = super::batching::plan(&specs, &opaque, &Default::default(), false, barriers);
        super::batching::apply_flatten(&mut specs, &planned.flatten);
        planned.plans
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
        for group in super::instancing::spawn_groups(
            commands,
            meshes,
            materials,
            shared,
            &specs,
            &opaque,
            &material_specs,
            quality,
        ) {
            batched_parts.extend(group.indices);
            let batch_id = format!("instance:{:?}", group.entity);
            commands.entity(group.entity).insert((
                ModelOwner { root },
                ModelBatch {
                    owner: root,
                    batch_id: batch_id.clone(),
                },
            ));
            mesh_cache.insert(batch_id.clone(), group.mesh);
            material_cache.insert(batch_id, group.material);
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
            .map(|geometry| super::mesh::effective_quality(geometry, quality))
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
                MeshMaterial3d(material.clone()),
                Transform::default(),
                super::model_render_layers(),
                bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
            ))
            .id();
        let batch_id = format!("batch:{}", batches.len());
        commands.entity(entity).insert((
            ModelOwner { root },
            ModelBatch {
                owner: root,
                batch_id: batch_id.clone(),
            },
        ));
        for &index in &plan.parts {
            if let Some(spec) = specs.get(index) {
                part_materials.insert(spec.id.clone(), material.clone());
            }
        }
        batched_parts.extend(plan.parts);
        mesh_cache.insert(batch_id, asset.handle.clone());
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
                let effective = super::mesh::effective_quality(geometry, quality);
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
                        MeshMaterial3d(material.clone()),
                        transform,
                        super::model_render_layers(),
                    ))
                    .id();
                part_materials.insert(spec.id.clone(), material);
                geometries.push((entity, base, shared_geometry));
                entity
            }
        };
        // 每个部件实体都携带根 owner 与稳定 `partId`：`ModelRoot.part_entities` 只作为
        // 热路径 O(1) 索引，实体身份以组件为准（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，5.1）。
        commands.entity(entity).insert((
            ModelOwner { root },
            ModelPart {
                owner: root,
                part_id: spec.id.clone(),
            },
        ));
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
    let mut part_batches: HashMap<String, Entity> = batches
        .iter()
        .flat_map(|batch| {
            batch
                .ranges
                .iter()
                .map(move |range| (range.id.clone(), batch.entity))
        })
        .collect();
    #[cfg(feature = "explicit-instancing")]
    for (entity, ids) in &instance_parts {
        for id in ids.iter() {
            part_batches.insert(id.clone(), *entity);
        }
    }
    ModelRoot {
        group_children: Default::default(),
        entities: spawned,
        content_signature: String::new(),
        texture_revision: crate::model3d::model_textures::revision(),
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
        quality_refresh_pending: false,
        representation_generation: 0,
        material_handles: material_cache.into_values().collect(),
        animation_entities,
        part_entities: entities,
        part_bases: base_transforms,
        opacity: Default::default(),
        part_materials,
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
