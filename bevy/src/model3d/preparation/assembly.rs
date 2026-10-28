//! 主线程预算化装配与完整发布（change: 2026-10-18-prepare-native-film-sets-in-background，
//! design D5/D6 / 任务 3.1–3.5）。
//!
//! 装配直接写 `World`（而不是继续排队 `Commands` 后由帧尾无界 drain）：每帧只推进有限数量的
//! 工作单元，并把真实世界变更计入工作量。staging 根在完整装配前保持 `Hidden` 且不进入
//! `ModelVisuals::roots`，因此主观察相机、预览、捕获、编辑与已发布根查找都看不到半成品。
//!
//! 预算（design D5 初值，全部**全局**共享，不是每根一份）：
//! [`MAX_UNITS_PER_FRAME`] 个工作单元、[`MAX_NEW_MESH_BYTES`] 新登记 mesh 字节、
//! [`SOFT_STOP_MS`] 宿主墙钟软停止点；单资源超阈值时独占一帧并记录 `oversize`。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bevy::camera::primitives::Aabb;
use bevy::platform::time::Instant;
use bevy::prelude::*;

use crate::canvas_ecs::components::{ModelBatch, ModelOwner, ModelPart};
use crate::protocol::{ModelPlacement, Scene};

use super::super::animation::{TransformAnimation, TransformAnimationPlayback};
use super::super::batch_cache::BatchBinding;
use super::super::layout::{model_anchor, model_unit, model_view_rotation};
use super::super::runtime::{ModelAnchor, ModelAssets, ModelRoot, ModelRootLayout, ModelVisuals};
use super::prepared::{PreparedBatch, PreparedModel, PreparedPart};
use super::schedule::{PrepareKey, Ready};

/// 每帧全局装配工作单元上限。
pub const MAX_UNITS_PER_FRAME: u64 = 64;
/// 每帧全局新登记 mesh 顶点/索引字节上限。
pub const MAX_NEW_MESH_BYTES: usize = 4 * 1024 * 1024;
/// 每帧宿主墙钟软停止点（毫秒）。达到后不再启动下一项，但已开始的一项不可抢占。
pub const SOFT_STOP_MS: f64 = 2.0;

/// 装配步骤（工作单元按真实世界变更计数）。
enum Step {
    /// 创建 staging 根实体。
    Root,
    /// 一个未合批部件：登记 mesh、创建实体、连接父级、写映射、挂动画。
    Part { index: usize },
    /// 一条批次：登记共享批次资产、创建实体、连接父级、写全部部件范围映射。
    Batch { index: usize },
    /// 把 staging 根切换为已发布根。
    Publish,
}

impl Step {
    /// 该步骤的工作单元代价：批次按其部件数计，不能把数百项映射包装成一次操作。
    fn cost(&self, prepared: &PreparedModel) -> u64 {
        match self {
            Step::Root | Step::Publish => 1,
            Step::Part { .. } => 3,
            Step::Batch { index } => prepared
                .batches
                .get(*index)
                .map_or(2, |batch| 1 + batch.source.specs.len() as u64),
        }
    }

    /// 该步骤首次登记的唯一 CPU mesh 字节（不是 GPU 上传量）。
    fn mesh_bytes(&self, prepared: &PreparedModel) -> usize {
        match self {
            Step::Part { index } => prepared.parts.get(*index).map_or(0, |part| part.bytes),
            Step::Batch { index } => prepared.batches.get(*index).map_or(0, |batch| batch.bytes),
            Step::Root | Step::Publish => 0,
        }
    }
}

/// 一个实例的 staging 装配状态（对已发布根查找不可见）。
pub struct Staging {
    node: String,
    key: PrepareKey,
    ready: Ready,
    /// 发布校验用的需求 token。
    token: u64,
    steps: Vec<Step>,
    cursor: usize,
    root: Option<Entity>,
    part_entities: HashMap<String, Entity>,
    part_bases: HashMap<String, Transform>,
    /// 部件 id → 有效材质（对象根透明度据此为全部块克隆实例；D2）。
    part_materials: HashMap<String, Handle<StandardMaterial>>,
    spawned: Vec<Entity>,
    batches: Vec<BatchBinding>,
    geometries: Vec<(Entity, String, Arc<super::super::scene::ModelGeometry>)>,
    mesh_handles: Vec<Handle<Mesh>>,
    material_handles: Vec<Handle<StandardMaterial>>,
    animation_entities: Vec<Entity>,
    part_batches: HashMap<String, Entity>,
}

impl Staging {
    pub(super) fn new(node: &str, key: PrepareKey, ready: Ready, token: u64) -> Self {
        let prepared = &ready.prepared;
        let mut steps = Vec::with_capacity(prepared.parts.len() + prepared.batches.len() + 2);
        steps.push(Step::Root);
        // 父级优先：父部件先出现，子级连接时才能找到父实体。
        steps.extend(
            parent_first(&prepared.parts)
                .into_iter()
                .map(|index| Step::Part { index }),
        );
        steps.extend((0..prepared.batches.len()).map(|index| Step::Batch { index }));
        steps.push(Step::Publish);
        Self {
            node: node.to_owned(),
            key,
            ready,
            token,
            steps,
            cursor: 0,
            root: None,
            part_entities: HashMap::new(),
            part_bases: HashMap::new(),
            part_materials: HashMap::new(),
            spawned: Vec::new(),
            batches: Vec::new(),
            geometries: Vec::new(),
            mesh_handles: Vec::new(),
            material_handles: Vec::new(),
            animation_entities: Vec::new(),
            part_batches: HashMap::new(),
        }
    }

    fn finished(&self) -> bool {
        self.cursor >= self.steps.len()
    }

    /// 诊断：已推进步骤/总步骤。
    pub(crate) fn progress(&self) -> (usize, usize) {
        (self.cursor, self.steps.len())
    }

    /// staging 已登记的 mesh handle（取消/销毁前必须作为显式消费者保活）。
    pub(crate) fn staged_meshes(&self) -> &[Handle<Mesh>] {
        &self.mesh_handles
    }

    /// staging 已登记的 material handle。
    pub(crate) fn staged_materials(&self) -> &[Handle<StandardMaterial>] {
        &self.material_handles
    }
}

/// 父级优先的部件顺序（其余保持原 specs 相对顺序）。
fn parent_first(parts: &[PreparedPart]) -> Vec<usize> {
    let mut order = Vec::with_capacity(parts.len());
    let mut placed: HashSet<&str> = HashSet::new();
    let mut remaining: Vec<usize> = (0..parts.len()).collect();
    while !remaining.is_empty() {
        let mut next = Vec::with_capacity(remaining.len());
        let mut progressed = false;
        for index in remaining {
            let parent = parts[index].parent.as_deref();
            let ready = parent.is_none_or(|parent| {
                !parts.iter().any(|candidate| candidate.id == parent) || placed.contains(parent)
            });
            if ready {
                order.push(index);
                placed.insert(parts[index].id.as_str());
                progressed = true;
            } else {
                next.push(index);
            }
        }
        if !progressed {
            // 环或缺失父级：保持原顺序并回退到根（与既有两遍构建一致）。
            order.extend(next);
            break;
        }
        remaining = next;
    }
    order
}

/// 本帧装配统计（计入诊断）。
#[derive(Default)]
pub(super) struct FrameWork {
    pub(super) units: u64,
    pub(super) mesh_bytes: usize,
    pub(super) oversize: u64,
    pub(super) published: u64,
    pub(super) cancelled: u64,
    pub(super) retired: u64,
}

/// 装配推进：每帧一次（宿主线程），按全局预算装配所有 staging 根。
///
/// 返回本帧是否发生世界变更（发布/取消/退役）。
///
/// 本函数作为**独占系统**运行：进入时 Bevy 已应用上一系统排队的 deferred 命令。这里再显式
/// `flush` 一次，是为了把「实际应用」这些命令的耗时纳入装配预算，而不是只测 `Commands`
/// 排队、把重活留给帧尾无界 drain（design D5）。`flush` 只应用已排队的命令，不生成新批次，
/// 因此不会让本帧工作量无界增长。
pub(super) fn assemble(
    world: &mut World,
    models: &mut ModelVisuals,
    scene: &Scene,
    resources: &ModelAssets,
) -> bool {
    let mut work = FrameWork::default();

    // 0) 应用本帧此前系统排队的 deferred 命令，并把**实际应用**耗时计入装配预算，
    //    避免只测 `Commands` 排队、把重活留给帧尾无界 drain（design D5）。
    let flush_started = Instant::now();
    world.flush();
    let command_ms = flush_started.elapsed().as_secs_f64() * 1000.0;
    work.units += models.preparation.work.record_commands(command_ms);

    // 1) 渲染器生命周期校验：场景里已不存在的实例，其需求与迟到结果一律作废。
    let alive: HashSet<&str> = scene.nodes.iter().map(|node| node.id.as_str()).collect();
    models.preparation.retain(|node| alive.contains(node));
    models.staging.retain(|node, _| alive.contains(node.as_str()));

    // 2) 非阻塞 poll；把完成结果按当前需求领取为 staging。
    //    共享缓存命中（同内容同档位的 mesh/material/批次已在库）在本帧结束时统一计账：
    //    命中说明没有重新构建几何，但不等于零成本（装配单元仍按真实实体/映射计入）。
    let cache_hits_before = models.shared.cache_hits();
    models.preparation.poll();
    collect_ready(models);

    // 装配软停止点只度量宿主实际装配，不把后台准备时间算进来
    // （Inline 回归下 preparation 与装配同线程，更需要这条界线）。
    let started = Instant::now();

    // 3) 预算内逐根轮流推进，避免单根独占全局预算。
    loop {
        if work.units >= MAX_UNITS_PER_FRAME
            || started.elapsed().as_secs_f64() * 1000.0 >= SOFT_STOP_MS
        {
            break;
        }
        let nodes: Vec<String> = models.staging.keys().cloned().collect();
        if nodes.is_empty() {
            break;
        }
        let mut progressed = false;
        for node in nodes {
            let Some(mut staging) = models.staging.remove(&node) else {
                continue;
            };
            let key = staging.key.clone();
            if staging.finished() {
                models.staging.insert(node, staging);
                continue;
            }
            let step = staging.cursor;
            let cost = staging.steps[step].cost(&staging.ready.prepared);
            let mesh_bytes = staging.steps[step].mesh_bytes(&staging.ready.prepared);
            let oversize = mesh_bytes > MAX_NEW_MESH_BYTES;
            if (work.units > 0 && work.units + cost > MAX_UNITS_PER_FRAME)
                || (!oversize
                    && work.mesh_bytes > 0
                    && work.mesh_bytes + mesh_bytes > MAX_NEW_MESH_BYTES)
            {
                models.staging.insert(node, staging);
                continue;
            }
            if oversize {
                work.oversize += 1;
            }
            match apply_step(world, models, scene, resources, &mut staging, step) {
                StepOutcome::Progressed => {
                    staging.cursor += 1;
                    work.units += cost;
                    work.mesh_bytes += mesh_bytes;
                    progressed = true;
                    models.staging.insert(node, staging);
                }
                StepOutcome::Published => {
                    work.units += cost;
                    work.mesh_bytes += mesh_bytes;
                    work.published += 1;
                    progressed = true;
                    models.staging.insert(node, staging);
                }
                StepOutcome::Cancelled => {
                    // 登记/校验失败：明确结束该实例的需求，避免确定性失败每帧重试。
                    // 额度不足不会走到这里（那时根本不入队，需求保留为可重试）。
                    let same_request = models
                        .preparation
                        .demand_of(&node)
                        .is_some_and(|demand| demand.key == key);
                    if same_request {
                        models.preparation.cancel(&node);
                        models.preparation.work.failed += 1;
                    }
                    release_staging(world, models, staging);
                    work.units += 1;
                    work.cancelled += 1;
                    progressed = true;
                }
            }
            if work.units >= MAX_UNITS_PER_FRAME
                || started.elapsed().as_secs_f64() * 1000.0 >= SOFT_STOP_MS
            {
                break;
            }
        }
        if !progressed {
            break;
        }
    }

    // 4) 完成/取消的 staging：释放产物额度。
    let finished: Vec<String> = models
        .staging
        .iter()
        .filter(|(_, staging)| staging.finished())
        .map(|(node, _)| node.clone())
        .collect();
    for node in finished {
        if let Some(staging) = models.staging.remove(&node) {
            release_staging(world, models, staging);
        }
    }
    // 回收无人需要的完成产物（额度随真实释放下降）。
    let assembling: HashSet<PrepareKey> = models.staging.values().map(|staging| staging.key.clone()).collect();
    models.preparation.gc(|key| assembling.contains(key));

    // 5) 旧根退役与 staging 取消复用同一预算，避免另一处整场销毁尖刺。
    work.retired = retire_pending(world, models, &mut work);

    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    models
        .preparation
        .work
        .frame_units(work.units, work.mesh_bytes as u64, elapsed);
    models.preparation.work.cache_hits += models
        .shared
        .cache_hits()
        .saturating_sub(cache_hits_before);
    models.preparation.work.published += work.published;
    models.preparation.work.cancelled += work.cancelled;
    models.preparation.work.oversize += work.oversize;
    models.preparation.work.assembling = models.staging.len();

    let changed = work.published > 0 || work.cancelled > 0 || work.retired > 0;
    if changed {
        models.preparation_changed = true;
    }
    changed
}

/// 把已完成且仍被需求的产物领取为 staging（同 key 多实例各自装配自己的实体映射）。
fn collect_ready(models: &mut ModelVisuals) {
    // 需求按优先级、再加节点 id 稳定排序，保证同级公平且可复现。
    let mut demands: Vec<_> = models.preparation.demands().cloned().collect();
    demands.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.node.cmp(&b.node)));
    for demand in demands {
        if models.staging.contains_key(&demand.node) {
            continue;
        }
        // 已发布同内容根：不需要再装配。
        if models.roots.get(&demand.node).is_some_and(|root| {
            root.content_signature == demand.resource.signature
                && Arc::ptr_eq(&root.resource, &demand.resource)
                && root.batched == demand.key.batched
        }) {
            models.preparation.cancel(&demand.node);
            continue;
        }
        let Some(ready) = models.preparation.claim(&demand.key) else {
            continue;
        };
        models.staging.insert(
            demand.node.clone(),
            Staging::new(&demand.node, demand.key.clone(), ready, demand.token),
        );
    }
}

/// 该 staging 的需求仍是最新接受的实例需求（内容/档位/token 均未变）。
fn demand_valid(models: &ModelVisuals, staging: &Staging) -> bool {
    models
        .preparation
        .demand_of(&staging.node)
        .is_some_and(|demand| demand.key == staging.key && demand.token == staging.token)
}

enum StepOutcome {
    Progressed,
    Published,
    Cancelled,
}

/// 执行一个装配步骤。
fn apply_step(
    world: &mut World,
    models: &mut ModelVisuals,
    scene: &Scene,
    resources: &ModelAssets,
    staging: &mut Staging,
    step: usize,
) -> StepOutcome {
    match staging.steps[step] {
        Step::Root => {
            let (translation, rotation, unit) = staging
                .root_transform(scene, resources)
                .unwrap_or((Vec3::ZERO, Quat::IDENTITY, 1.0));
            let root = world
                .spawn((
                    ModelAnchor,
                    Transform {
                        translation,
                        rotation,
                        scale: Vec3::splat(unit),
                    },
                    // staging 不可见：主观察相机、预览、捕获、编辑都不看到半成品。
                    Visibility::Hidden,
                    super::super::model_render_layers(),
                ))
                .id();
            world.entity_mut(root).insert(ModelOwner { root });
            staging.root = Some(root);
            staging.spawned.push(root);
            StepOutcome::Progressed
        }
        Step::Part { index } => {
            let prepared = staging.ready.prepared.clone();
            let Some((root, part)) = staging.root.zip(prepared.parts.get(index)) else {
                return StepOutcome::Cancelled;
            };
            match spawn_part(world, models, staging, part, root) {
                Some(()) => StepOutcome::Progressed,
                None => StepOutcome::Cancelled,
            }
        }
        Step::Batch { index } => {
            let prepared = staging.ready.prepared.clone();
            let Some((root, batch)) = staging.root.zip(prepared.batches.get(index)) else {
                return StepOutcome::Cancelled;
            };
            match spawn_batch(world, models, staging, batch, root, index) {
                Some(()) => StepOutcome::Progressed,
                None => StepOutcome::Cancelled,
            }
        }
        Step::Publish => {
            // 发布前校验：内容 key、档位需求 token 与当前渲染器身份都必须仍匹配。
            if !demand_valid(models, staging) {
                return StepOutcome::Cancelled;
            }
            publish(world, models, scene, resources, staging);
            StepOutcome::Published
        }
    }
}

impl Staging {
    /// 最新已接受的根 placement（不携带排队时的旧值）。
    fn root_transform(
        &self,
        scene: &Scene,
        resources: &ModelAssets,
    ) -> Option<(Vec3, Quat, f32)> {
        let node = scene.nodes.iter().find(|node| node.id == self.node)?;
        let resource = node
            .model
            .as_ref()
            .and_then(|reference| resources.get(&reference.resource_key))
            .cloned()
            .unwrap_or_else(|| self.ready.prepared.resource.clone());
        let placement = node
            .model
            .as_ref()
            .map_or(ModelPlacement::default(), |reference| {
                reference.placement.clone()
            });
        let unit = model_unit(node, &resource, &placement);
        Some((
            model_anchor(node, &resource, &placement, unit),
            model_view_rotation(&placement),
            unit,
        ))
    }
}

/// 未合批部件：登记（或复用）mesh/material，创建实体；无几何部件只建空实体。
fn spawn_part(
    world: &mut World,
    models: &mut ModelVisuals,
    staging: &mut Staging,
    part: &PreparedPart,
    root: Entity,
) -> Option<()> {
    let parent = part
        .parent
        .as_ref()
        .and_then(|id| staging.part_entities.get(id).copied())
        .unwrap_or(root);
    let Some(geometry) = &part.geometry else {
        let entity = world
            .spawn((
                part.transform,
                Visibility::default(),
                super::super::model_render_layers(),
                ChildOf(parent),
                ModelOwner { root },
                ModelPart {
                    owner: root,
                    part_id: part.id.clone(),
                },
            ))
            .id();
        record_part(staging, part, entity);
        return Some(());
    };
    let mesh = part.mesh.as_ref()?;
    let material = material_handle(world, models, &staging.ready.prepared, &part.material_key)?;
    let (handle, shared_geometry) = {
        let mut meshes = world.resource_mut::<Assets<Mesh>>();
        models.shared.adopt_mesh(
            &mut meshes,
            &part.base,
            geometry,
            part.effective,
            |_| Some(mesh.clone()),
        )?
    };
    let mut entity = world.spawn((
        Mesh3d(handle.clone()),
        MeshMaterial3d(material.clone()),
        part.transform,
        super::super::model_render_layers(),
        ChildOf(parent),
        ModelOwner { root },
        ModelPart {
            owner: root,
            part_id: part.id.clone(),
        },
    ));
    if let Some(kind) = &part.animation {
        // 动画默认停止；只有本根是当前唯一活动模型时才从零播放（与既有门禁一致）。
        let mut playback = TransformAnimationPlayback::default();
        if models.active_model.as_deref() == Some(staging.node.as_str()) {
            playback.start();
        }
        entity.insert((
            TransformAnimation {
                base: part.transform,
                kind: kind.clone(),
            },
            playback,
        ));
        staging.animation_entities.push(entity.id());
    }
    let entity = entity.id();
    staging.mesh_handles.push(handle);
    staging.material_handles.push(material.clone());
    record_part_material(staging, part, material);
    staging
        .geometries
        .push((entity, part.base.clone(), shared_geometry));
    record_part(staging, part, entity);
    Some(())
}

fn record_part(staging: &mut Staging, part: &PreparedPart, entity: Entity) {
    staging.part_entities.insert(part.id.clone(), entity);
    staging.part_bases.insert(part.id.clone(), part.transform);
    staging.spawned.push(entity);
}

/// 记录部件与其有效材质；对象根动作需要按部件查材质来克隆实例。
fn record_part_material(staging: &mut Staging, part: &PreparedPart, material: Handle<StandardMaterial>) {
    staging
        .part_materials
        .insert(part.id.clone(), material);
}

/// 一条批次：登记共享批次资产，创建实体并连接父级；映射逐部件写入。
fn spawn_batch(
    world: &mut World,
    models: &mut ModelVisuals,
    staging: &mut Staging,
    batch: &PreparedBatch,
    root: Entity,
    index: usize,
) -> Option<()> {
    let parent = batch
        .parent
        .as_ref()
        .and_then(|id| staging.part_entities.get(id).copied())
        .unwrap_or(root);
    let material = material_handle(world, models, &staging.ready.prepared, &batch.material_key)?;
    let asset = {
        // 后台构建的 CPU 网格只登记一次；同 key 的第二实例直接命中共享缓存。
        let mut meshes = world.resource_mut::<Assets<Mesh>>();
        models.shared.batches.adopt_with(
            &mut meshes,
            &batch.source,
            batch.quality,
            || batch.take_built(),
        )?
    };
    let entity = world
        .spawn((
            Mesh3d(asset.handle.clone()),
            MeshMaterial3d(material.clone()),
            Transform::default(),
            super::super::model_render_layers(),
            Aabb::from_min_max(asset.min, asset.max),
            ChildOf(parent),
            ModelOwner { root },
            ModelBatch {
                owner: root,
                batch_id: format!("batch:{index}"),
            },
        ))
        .id();
    staging.mesh_handles.push(asset.handle.clone());
    staging.material_handles.push(material.clone());
    staging
        .batches
        .push(BatchBinding::new(entity, batch.source.clone(), asset));
    for spec in &batch.source.specs {
        staging.part_batches.insert(spec.id.clone(), entity);
        // 对象根透明度按部件查有效材质；合批块同样要为每个 spec 记录同一材质。
        staging
            .part_materials
            .insert(spec.id.clone(), material.clone());
    }
    staging.spawned.push(entity);
    Some(())
}

fn material_handle(
    world: &mut World,
    models: &mut ModelVisuals,
    prepared: &Arc<PreparedModel>,
    key: &str,
) -> Option<Handle<StandardMaterial>> {
    let index = *prepared.material_index.get(key)?;
    let material = prepared.materials.get(index)?;
    let mut materials = world.resource_mut::<Assets<StandardMaterial>>();
    Some(models.shared.adopt_material(
        &mut materials,
        material.cache_key.clone(),
        material.material.clone(),
    ))
}

/// 完整发布：校验通过后同一宿主帧把 staging 根切为已发布根，替换旧表示。
fn publish(
    world: &mut World,
    models: &mut ModelVisuals,
    scene: &Scene,
    resources: &ModelAssets,
    staging: &mut Staging,
) {
    let Some(root) = staging.root.take() else {
        return;
    };
    let prepared = staging.ready.prepared.clone();
    let node = scene.nodes.iter().find(|node| node.id == staging.node);
    // 最新已接受 placement / 姿态：发布时统一应用，不使用排队时的旧值。
    let (translation, rotation, unit) = staging
        .root_transform(scene, resources)
        .unwrap_or((Vec3::ZERO, Quat::IDENTITY, 1.0));
    // 发布瞬间就带上当前聚焦可见性：否则新根会以 `Inherited` 显示一帧，
    // 在聚焦其他节点时形成闪烁（下一帧 `set_visible_focus` 才纠正）。
    let visible = scene
        .model_focus
        .as_ref()
        .is_none_or(|focus| focus.node_id == staging.node)
        || (crate::canvas_query::focus_context::contains(&scene, &staging.node) && node.is_some_and(|n| n.model_preview.is_some()));
    world.entity_mut(root).insert((
        Transform {
            translation,
            rotation,
            scale: Vec3::splat(unit),
        },
        if visible {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        },
    ));
    // 片场 item 摆放：发布时直接应用，不等到下一帧。
    if let Some(asset) = node.and_then(|node| node.composite_asset.as_ref()) {
        for (id, placement) in &asset.item_placements {
            let Some(entity) = staging.part_entities.get(id).copied() else {
                continue;
            };
            let base = super::super::item_placement::transform(placement);
            staging.part_bases.insert(id.clone(), base);
            world.entity_mut(entity).insert(base);
        }
    }
    // 动作门禁：按当前唯一活动模型初始化，不恢复排队前的旧时间。
    let active = models.active_model.as_deref() == Some(staging.node.as_str());
    for entity in &staging.animation_entities {
        let mut playback = TransformAnimationPlayback::default();
        if active {
            playback.start();
        }
        world.entity_mut(*entity).insert(playback);
    }

    // 内容替换：旧完整表示保留到这里，此刻原子切换；旧根隐藏后按预算退役。
    let previous = models.roots.remove(&staging.node);
    let generation = previous
        .as_ref()
        .map_or(0, |root| root.representation_generation.wrapping_add(1));
    if let Some(mut previous) = previous {
        // 替换表示时旧根的透明度实例也要从材质资产中回收（D2）。
        previous.opacity.release_instances(
            &mut world.resource_mut::<Assets<StandardMaterial>>(),
        );
        for entity in &previous.entities {
            world.entity_mut(*entity).insert(Visibility::Hidden);
        }
        models.retiring.extend(previous.entities.iter().copied());
    }

    let resource = node
        .and_then(|node| node.model.as_ref())
        .and_then(|reference| resources.get(&reference.resource_key))
        .cloned()
        .unwrap_or_else(|| prepared.resource.clone());
    let mesh_handles = std::mem::take(&mut staging.mesh_handles);
    let mut root_state = ModelRoot {
        entities: std::mem::take(&mut staging.spawned),
        content_signature: prepared.content_signature.clone(),
        resource,
        placement: node
            .and_then(|node| node.model.as_ref())
            .map_or(ModelPlacement::default(), |reference| {
                reference.placement.clone()
            }),
        layout: ModelRootLayout::V2 { root },
        active_mesh_handles: dedup_handles(&mesh_handles),
        mesh_handles,
        batched: prepared.batched,
        part_batches: std::mem::take(&mut staging.part_batches),
        prepared_targets: Default::default(),
        batches: std::mem::take(&mut staging.batches),
        #[cfg(feature = "explicit-instancing")]
        instance_parts: HashMap::new(),
        geometries: std::mem::take(&mut staging.geometries),
        quality: prepared.quality,
        quality_changed_at: None,
        overview_medium_since: None,
        quality_refresh_pending: false,
        representation_generation: generation,
        overview_lod: prepared.overview,
        projection: Default::default(),
        overview_fraction: None,
        overview_desired: prepared.quality,
        overview_reason: "initial",
        material_handles: std::mem::take(&mut staging.material_handles),
        animation_entities: std::mem::take(&mut staging.animation_entities),
        part_entities: std::mem::take(&mut staging.part_entities),
        part_bases: std::mem::take(&mut staging.part_bases),
        opacity: Default::default(),
        part_materials: std::mem::take(&mut staging.part_materials),
    };
    root_state.active_mesh_handles = dedup_handles(&root_state.mesh_handles);
    models.roots.insert(staging.node.clone(), root_state);
    staging.cursor = staging.steps.len();
}

fn dedup_handles(handles: &[Handle<Mesh>]) -> Vec<Handle<Mesh>> {
    let mut seen = HashSet::new();
    handles
        .iter()
        .filter(|handle| seen.insert(handle.id()))
        .cloned()
        .collect()
}

/// 释放一个 staging 的实体引用（取消/失败时销毁 staging 实体）。
fn release_staging(world: &mut World, models: &mut ModelVisuals, staging: Staging) {
    let published = models.roots.contains_key(&staging.node);
    if !published {
        // 尚未发布：staging 实体全部销毁（根是 `Hidden`，销毁不会造成可见闪烁）。
        for entity in &staging.spawned {
            let _ = world.try_despawn(*entity);
        }
        models.preparation.work.stale_dropped += 1;
    }
}

/// 旧根退役与 staging 取消：按本帧剩余预算逐个销毁已建实体。
fn retire_pending(world: &mut World, models: &mut ModelVisuals, work: &mut FrameWork) -> u64 {
    let mut retired = 0u64;
    while work.units < MAX_UNITS_PER_FRAME {
        let Some(entity) = models.retiring.pop() else {
            break;
        };
        let _ = world.try_despawn(entity);
        work.units += 1;
        retired += 1;
    }
    retired
}
