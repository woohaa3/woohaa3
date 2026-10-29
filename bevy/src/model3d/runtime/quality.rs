//! Quality changes replace shared handles while preserving model entities.
//!
//! 总览 primitive LOD 的分帧准备与整根原子发布（change: 2026-10-15-add-film-set-overview-lod，
//! design D2/D4）：投影输入缓存、每帧 source spec 预算、全局单活动根、最新目标合并、High 优先，
//! 以及发布前的内容/资源/代数验证。普通模型卡片沿用既有同步准备路径，不受该队列约束。
use super::ModelVisuals;
use crate::protocol::{GraphNode, ModelSnapshot, Scene};
use bevy::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;

/// 每帧最多准备的 source specs（每批按其 specs 数计入；缓存命中同样计数）。
/// 每帧准备预算（source specs 数）。一个批次是单次构建单元，不能拆到多帧，因此上限与
/// `batching::MAX_PARTS` 对齐：一帧最多构建一个满批次，或 256 个独立部件。
const OVERVIEW_SPEC_BUDGET: usize = 256;
/// 普通升降档的最小发布间隔（秒）；High 消费者提升绕过。
const QUALITY_HOLD_SECONDS: f64 = 0.25;

/// 单活动根的总览准备列表项。
enum WorkItem {
    Part(usize),
    Batch(usize),
}

/// 全局单活动根的总览准备状态（design D4）。同一时刻至多一个；同根新目标合并、旧代数作废。
pub(crate) struct PendingPublish {
    node: String,
    target: super::super::quality::Quality,
    content_signature: String,
    resource: Arc<ModelSnapshot>,
    base_generation: u64,
    work: Vec<WorkItem>,
    cursor: usize,
    parts: Vec<(Entity, Handle<Mesh>)>,
    batches: Vec<(usize, Arc<super::super::batch_cache::BatchAsset>)>,
    ready: bool,
}

impl PendingPublish {
    /// 有界诊断用状态快照（不暴露可变内部）。
    pub(crate) fn diagnostics(&self) -> serde_json::Value {
        serde_json::json!({
            "nodeId": self.node,
            "target": format!("{:?}", self.target),
            "ready": self.ready
        })
    }

    /// 该在途准备是否属于给定根。
    pub(crate) fn is_for(&self, node: &str) -> bool {
        self.node == node
    }

    fn new(node: &str, target: super::super::quality::Quality, root: &super::ModelRoot) -> Self {
        let work = (0..root.geometries.len())
            .map(WorkItem::Part)
            .chain((0..root.batches.len()).map(WorkItem::Batch))
            .collect();
        Self {
            node: node.to_owned(),
            target,
            content_signature: root.content_signature.clone(),
            resource: root.resource.clone(),
            base_generation: root.representation_generation,
            work,
            cursor: 0,
            parts: Vec::new(),
            batches: Vec::new(),
            ready: false,
        }
    }

    fn cost(&self, item: &WorkItem, root: &super::ModelRoot) -> usize {
        match item {
            WorkItem::Part(_) => 1,
            WorkItem::Batch(index) => root
                .batches
                .get(*index)
                .map_or(1, |batch| batch.source.specs.len().max(1)),
        }
    }

    /// 暂存 replacement handle（准备中，尚未发布）。调用方把它们登记为显式引用归属，参与
    /// 普通 mesh/batch 缓存驱逐与 pin 规则，取消/删除/发布后自然释放，不形成第三套永久缓存
    /// （change: 2026-10-15-add-film-set-overview-lod，design D4）。
    pub(crate) fn staged_meshes(&self) -> Vec<Handle<Mesh>> {
        self.parts
            .iter()
            .map(|(_, handle)| handle.clone())
            .chain(self.batches.iter().map(|(_, asset)| asset.handle.clone()))
            .collect()
    }

    /// 暂存 replacement 的估算字节数（诊断用；不冒充活动/pinned 资源的硬内存上限）。
    pub(crate) fn staged_bytes(&self) -> usize {
        self.batches
            .iter()
            .map(|(_, asset)| asset.buffer_bytes)
            .sum::<usize>()
    }
}

/// 高优先消费者细分（诊断用）：把笼统的 `high-owner` 拆成具体来源。
///
/// 只影响 `overview_reason` 标签，不参与档位决策；未识别用途仍归 `high-owner`。
fn high_owner_reason(purpose: super::super::quality::ViewPurpose) -> &'static str {
    use super::super::quality::ViewPurpose;
    match purpose {
        ViewPurpose::Selected => "high-selected",
        ViewPurpose::Focus => "high-focus",
        ViewPurpose::Edit => "high-edit",
        ViewPurpose::Capture => "high-capture",
        ViewPurpose::Export => "high-export",
        ViewPurpose::World => "high-world",
        _ => "high-owner",
    }
}

/// 每个总览根的期望决策（phase A 收集，phase B 消费）。
struct Decision {
    next: super::super::quality::Quality,
    high_owner: bool,
    /// 发布后要保留的原因标签（High owner / motion-bounds / 普通 overview）。
    reason: &'static str,
}

/// 同步档位：`pins` 同时当作高优先需求，等价于 [`sync_quality_with_demand`] 传同一集合。
pub(crate) fn sync_quality(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    models: &mut ModelVisuals,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &std::collections::HashSet<String>,
) -> bool {
    sync_quality_with_demand(commands, meshes, models, scene, focus, now, pins, pins)
}

/// 同步档位，并把「需要 High 的根」与「需要保持驻留的根」分开。
///
/// `pins` 是驻留集合（截图请求 + 可见镜头卡片让源片场不被回收）；`high_demand` 只含真正
/// 需要 High 表示的根（截图/导出请求）。可见镜头卡片的参考内容一旦就绪就已固化，卡片在
/// 总览尺寸下不构成高优先消费者——否则缩到总览时整场仍按全细分加载并绘制。
pub(crate) fn sync_quality_with_demand(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    models: &mut ModelVisuals,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &std::collections::HashSet<String>,
    high_demand: &std::collections::HashSet<String>,
) -> bool {
    let ModelVisuals {
        roots,
        shared,
        capture_pins,
        high_demand: stored_high_demand,
        overview_work,
        pending,
        motion_plan,
        ..
    } = models;
    if *capture_pins != *pins {
        capture_pins.clone_from(pins);
    }
    if *stored_high_demand != *high_demand {
        stored_high_demand.clone_from(high_demand);
    }

    let completed = shared.poll_jobs(meshes);
    let mut changed = completed.is_some();
    if let Some((geometry, quality, true)) = completed.as_ref() {
        for root in roots.values_mut() {
            if *quality == root.quality
                && root
                    .geometries
                    .iter()
                    .any(|(_, _, bound)| std::sync::Arc::ptr_eq(geometry, bound))
            {
                root.quality_refresh_pending = true;
            }
        }
    }

    // Phase A：解析每个根的期望档位；总览根只记录决策并更新诊断，非总览根沿用同步路径。
    // Native 后台准备中的根尚未发布（不在此表），其档位需求由准备管线按最新接受状态合并；
    // 发布后从本帧起进入既有 LOD replacement，两条路径不争写同一表示
    // （change: 2026-10-18-prepare-native-film-sets-in-background，design D6/D3）。
    let mut decisions: HashMap<String, Decision> = HashMap::new();
    'roots: for node in &scene.nodes {
        let Some(root) = roots.get_mut(&node.id) else {
            continue;
        };
        let purpose =
            super::super::quality::purpose(node, scene, focus, high_demand.contains(&node.id));
        let high_owner = purpose.requires_high();
        let high_reason = high_owner_reason(purpose);
        // Demand retains/prewarms nearby roots; ordinary invisible cards must
        // not compete with visible work when wheel/pinch changes their LOD.
        let visible = super::super::quality::card_visible(node, scene, focus);
        if !high_owner && !visible {
            if root.overview_lod {
                // 已保留屏外根不随屏外缩放反复准备；返回真实视口才重新决策。
                root.overview_reason = "offscreen";
                root.overview_medium_since = None;
            }
            continue;
        }
        let next = if high_owner {
            root.overview_medium_since = None;
            super::super::quality::Quality::High
        } else if root.overview_lod {
            let resource = root.resource.clone();
            // 已有动作采样放大几何：规范 bounds 不再保守，保守提升 High，不另跑动作求值
            // （change: 2026-10-15-add-film-set-overview-lod，design D2）。
            let scales_bounds = motion_plan.as_ref().is_some_and(|plan| plan.scales_bounds)
                && scene
                    .animation_playback
                    .as_ref()
                    .is_some_and(|playback| playback.node_id == node.id);
            let (projection, next, hit) = overview_decision(
                &mut root.projection,
                node,
                scene,
                &resource,
                root.quality,
                scales_bounds,
            );
            if !hit {
                overview_work.bounds_rebuilds += 1;
            }
            match projection {
                Some(projection) => {
                    root.overview_fraction = Some(projection.fraction);
                    root.overview_reason = if scales_bounds {
                        "motion-bounds"
                    } else {
                        "overview"
                    };
                }
                None => {
                    // 非法/退化 bounds、缺 surface 或非几何内容：保守保持 High。
                    root.overview_fraction = None;
                    root.overview_reason = "degenerate";
                }
            }
            let resolved =
                next.after_overview_dwell(root.quality, &mut root.overview_medium_since, now);
            if resolved != next {
                root.overview_reason = "medium-dwell";
            }
            resolved
        } else {
            super::super::quality::desired(node, scene, focus, root.quality, &root.resource)
        };
        if root.overview_lod {
            if high_owner {
                root.overview_reason = high_reason;
            }
            root.overview_desired = next;
            // 发布后保留的原因标签；准备中/保持等临时原因在 publish_overview 内覆盖。
            let reason = if high_owner {
                high_reason
            } else if matches!(root.overview_reason, "motion-bounds" | "medium-dwell") {
                root.overview_reason
            } else {
                "overview"
            };
            decisions.insert(
                node.id.clone(),
                Decision {
                    next,
                    high_owner,
                    reason,
                },
            );
            continue;
        }
        // 非总览根：既有同步准备与原子发布路径保持不变（含高 owner 与保持时间语义）。
        let generated = root.quality_refresh_pending;
        if (next == root.quality && !generated)
            || (next != root.quality
                && !high_owner
                && root
                    .quality_changed_at
                    .is_some_and(|t| now - t < QUALITY_HOLD_SECONDS))
        {
            continue;
        }
        // Prepare every replacement before publishing any entity handle or quality
        // identity. A failed batch must not label retained low geometry as high.
        let mut prepared_parts = Vec::with_capacity(root.geometries.len());
        let mut prepared_batches = Vec::with_capacity(root.batches.len());
        let mut active = HashMap::new();
        for (entity, base, geometry) in &root.geometries {
            // 每几何有效档位：Box/自定义 Mesh 恒 High，其余用根目标档位
            // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
            let effective =
                super::super::mesh::effective_quality(geometry, next, root.overview_lod);
            let key = super::super::mesh::quality_key(base, geometry, effective);
            let Some((handle, _)) = shared.mesh(meshes, base, geometry, effective) else {
                continue 'roots;
            };
            active.insert(key, handle.clone());
            prepared_parts.push((*entity, handle));
        }
        for batch in &root.batches {
            // 批次 source 已按有效档位（纯盒 → High）构建，切换时用同一有效档位复用/重建。
            let batch_quality = batch
                .source
                .specs
                .iter()
                .filter_map(|spec| spec.geometry.as_ref())
                .map(|geometry| {
                    super::super::mesh::effective_quality(geometry, next, root.overview_lod)
                })
                .min()
                .unwrap_or(next);
            let Some(asset) = shared.batches.get(meshes, &batch.source, batch_quality) else {
                continue 'roots;
            };
            active.insert(format!("batch:{:?}", batch.entity), asset.handle.clone());
            prepared_batches.push(asset);
        }
        for (entity, handle) in prepared_parts {
            // Bevy recalculates bounds from the replacement mesh before visibility.
            commands
                .entity(entity)
                .remove::<bevy::camera::primitives::Aabb>()
                .insert(Mesh3d(handle));
        }
        for (batch, asset) in root.batches.iter_mut().zip(prepared_batches) {
            commands.entity(batch.entity).insert((
                Mesh3d(asset.handle.clone()),
                bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
            ));
            batch.set_asset(asset);
        }
        root.active_mesh_handles = active.into_values().collect();
        root.mesh_handles = root.active_mesh_handles.clone();
        changed = true;
        if root.quality != next {
            root.quality_changed_at = Some(now);
        }
        root.quality = next;
        root.quality_refresh_pending = false;
        root.representation_generation = root.representation_generation.wrapping_add(1);
    }

    // Phase B：选择全局单活动根（High 优先），推进预算内准备并原子发布。
    if publish_overview(
        commands,
        meshes,
        roots,
        shared,
        pending,
        overview_work,
        &decisions,
        now,
    ) {
        changed = true;
    }
    changed
}

/// 选择候选根（High 优先、其次需要变更的总览根），推进或启动单活动准备。
#[allow(clippy::too_many_arguments)]
fn publish_overview(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    roots: &mut HashMap<String, super::ModelRoot>,
    shared: &mut super::super::resources::SharedResources,
    pending: &mut Option<PendingPublish>,
    overview_work: &mut super::super::resource_work::OverviewWork,
    decisions: &HashMap<String, Decision>,
    now: f64,
) -> bool {
    let candidate = decisions
        .keys()
        .filter(|id| {
            roots.get(*id).is_some_and(|root| {
                decisions[*id].next != root.quality || root.quality_refresh_pending
            })
        })
        .max_by_key(|id| u8::from(decisions[*id].high_owner))
        .cloned();

    let Some(candidate_id) = candidate else {
        // 不需要任何变更：作废在途准备并回收暂存引用。
        if pending.take().is_some() {
            overview_work.cancels += 1;
        }
        return false;
    };
    let decision_next = decisions[&candidate_id].next;
    let high_owner = decisions[&candidate_id].high_owner;

    // 在途准备若非同根同目标，或已失去合法性，则作废重来（旧代数/取消不发布）。
    let reuse = pending.as_ref().is_some_and(|pending| {
        pending.node == candidate_id
            && pending.target == decision_next
            && roots.get(&candidate_id).is_some_and(|root| {
                root.content_signature == pending.content_signature
                    && Arc::ptr_eq(&root.resource, &pending.resource)
                    && root.representation_generation == pending.base_generation
            })
    });
    if !reuse {
        if pending.take().is_some() {
            overview_work.cancels += 1;
        }
        let root = roots.get(&candidate_id).expect("candidate root");
        if root.geometries.is_empty() && root.batches.is_empty() {
            return false;
        }
        *pending = Some(PendingPublish::new(&candidate_id, decision_next, root));
    }

    let mut state = pending.take().expect("pending prepared");
    let root = roots.get_mut(&candidate_id).expect("candidate root");

    // 内容/资源/基础代数在准备期间变化：取消，保留完整旧表示，下一帧重建。
    if root.content_signature != state.content_signature
        || !Arc::ptr_eq(&root.resource, &state.resource)
        || root.representation_generation != state.base_generation
    {
        overview_work.cancels += 1;
        root.overview_reason = "cancelled";
        return false;
    }

    let mut used = 0usize;
    while state.cursor < state.work.len() {
        let index = state.cursor;
        let cost = state.cost(&state.work[index], root);
        if used > 0 && used + cost > OVERVIEW_SPEC_BUDGET {
            break;
        }
        let prepared = match &state.work[index] {
            WorkItem::Part(part) => {
                let (entity, base, geometry) = &root.geometries[*part];
                let effective = super::super::mesh::effective_quality(
                    geometry,
                    state.target,
                    root.overview_lod,
                );
                shared
                    .mesh(meshes, base, geometry, effective)
                    .map(|(handle, _)| PublishPrepared::Part(*entity, handle))
            }
            WorkItem::Batch(batch) => {
                let source = &root.batches[*batch].source;
                let batch_quality = source
                    .specs
                    .iter()
                    .filter_map(|spec| spec.geometry.as_ref())
                    .map(|geometry| {
                        super::super::mesh::effective_quality(
                            geometry,
                            state.target,
                            root.overview_lod,
                        )
                    })
                    .min()
                    .unwrap_or(state.target);
                shared
                    .batches
                    .get(meshes, source, batch_quality)
                    .map(|asset| PublishPrepared::Batch(*batch, asset))
            }
        };
        match prepared {
            Some(PublishPrepared::Part(entity, handle)) => {
                state.parts.push((entity, handle));
            }
            Some(PublishPrepared::Batch(index, asset)) => {
                state.batches.push((index, asset));
            }
            None => {
                // 任一 replacement 失败：保持完整旧表示并报告原因，不部分切档。
                overview_work.prepare_failures += 1;
                root.overview_reason = "prepare-failed";
                return false;
            }
        }
        overview_work.specs_prepared += cost as u64;
        used += cost;
        state.cursor += 1;
    }
    overview_work.prepare_calls += 1;
    state.ready = state.cursor >= state.work.len();
    if !state.ready {
        root.overview_reason = "preparing";
        *pending = Some(state);
        return false;
    }

    // 普通升降档发布间隔至少 250ms；High 消费者提升绕过。
    if !high_owner
        && root.quality != state.target
        && root
            .quality_changed_at
            .is_some_and(|t| now - t < QUALITY_HOLD_SECONDS)
    {
        overview_work.hold_deferrals += 1;
        root.overview_reason = "held";
        *pending = Some(state);
        return false;
    }

    // 全部 replacement 就绪后同一批次原子替换 handle、bounds、引用与表示代数。
    for (entity, handle) in state.parts.drain(..) {
        commands
            .entity(entity)
            .remove::<bevy::camera::primitives::Aabb>()
            .insert(Mesh3d(handle));
    }
    let mut active: Vec<Handle<Mesh>> = Vec::new();
    for (index, asset) in state.batches.drain(..) {
        commands.entity(root.batches[index].entity).insert((
            Mesh3d(asset.handle.clone()),
            bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
        ));
        root.batches[index].set_asset(asset);
    }
    for (_, _, geometry) in &root.geometries {
        let effective =
            super::super::mesh::effective_quality(geometry, state.target, root.overview_lod);
        if let Some(base) = root
            .geometries
            .iter()
            .find(|(_, _, candidate)| Arc::ptr_eq(candidate, geometry))
            .map(|(_, base, _)| base.clone())
        {
            if let Some(handle) = shared.lookup(&base, geometry, effective) {
                active.push(handle.clone());
            }
        }
    }
    active.extend(root.batches.iter().map(|batch| batch.asset.handle.clone()));
    active.sort_by_key(|handle| handle.id());
    active.dedup_by_key(|handle| handle.id());
    root.active_mesh_handles = active.clone();
    root.mesh_handles = active;
    if root.quality != state.target {
        root.quality_changed_at = Some(now);
    }
    if state.target == super::super::quality::Quality::OverviewMedium
        && root.quality != state.target
    {
        root.overview_medium_since = Some(now);
    }
    root.quality = state.target;
    root.overview_desired = state.target;
    root.overview_reason = decisions[&candidate_id].reason;
    root.quality_refresh_pending = false;
    root.representation_generation = root.representation_generation.wrapping_add(1);
    overview_work.publishes += 1;
    true
}

enum PublishPrepared {
    Part(Entity, Handle<Mesh>),
    Batch(usize, Arc<super::super::batch_cache::BatchAsset>),
}

/// 总览决策：命中缓存则复用半径/占比，未命中重算并保存（design D2）。
fn overview_decision(
    cache: &mut super::super::quality::ProjectionCache,
    node: &GraphNode,
    scene: &Scene,
    resource: &Arc<ModelSnapshot>,
    current: super::super::quality::Quality,
    scales_bounds: bool,
) -> (
    Option<super::super::quality::WorldProjection>,
    super::super::quality::Quality,
    bool,
) {
    let key = super::super::quality::projection_key(node, scene, resource);
    let (value, hit) = cache.resolve(key, || {
        super::super::quality::world_projection(node, scene, resource)
    });
    match value {
        Some(projection) => {
            let next = if scales_bounds {
                super::super::quality::Quality::High
            } else {
                super::super::quality::Quality::for_projection(projection, current)
            };
            (Some(projection), next, hit)
        }
        None => (None, super::super::quality::Quality::High, hit),
    }
}

impl ModelVisuals {
    pub(crate) fn capture_pins(&self) -> &std::collections::HashSet<String> {
        &self.capture_pins
    }
    pub(crate) fn capture_content(&self, id: &str) -> Option<&str> {
        self.roots
            .get(id)
            .map(|root| root.content_signature.as_str())
    }
    pub(crate) fn quality(&self, id: &str) -> super::super::quality::Quality {
        self.roots
            .get(id)
            .map_or(super::super::quality::Quality::High, |root| root.quality)
    }
    /// 该节点此刻是否有已 spawn 的模型根。
    ///
    /// 与 `preview_meshes(id).is_empty()` 不等价：根存在但内容为空（合法空模型）也返回 `true`。
    ///
    /// 注意：native 后台准备中的根还没有发布，因此这里返回 `false`；消费者必须用
    /// [`Self::preparation_state`] 区分「准备中」与「确实没有根」，不能把前者当合法空场。
    pub(crate) fn has_root(&self, id: &str) -> bool {
        self.roots.contains_key(id)
    }
    /// 该节点的准备状态（native 后台准备）：`Published` / `Pending` / `Absent`。
    pub(crate) fn preparation_state(&self, id: &str) -> super::super::preparation::RootState {
        super::super::preparation::state(self, id)
    }
    /// 该节点是否有根或正在准备（用于「还在路上」的等待判定）。
    pub(crate) fn has_or_prepares_root(&self, id: &str) -> bool {
        self.roots.contains_key(id) || super::super::preparation::is_pending(self, id)
    }
    /// 表示身份（质量档位 + 表示代数），供预览缓存去重与根重建失效使用。
    ///
    /// 根缺失时返回独立的 `"absent"` 标记，而不是与「刚创建的根」相同的 `"High:0"`：
    /// 卡片可能先建立视图、后 spawn 模型根（需求驱动的 spawn 在另一系统），两者若同身份，
    /// 签名/`quality_changed` 都不会变化，卡片就再也不会重渲染。
    ///
    /// Native 后台准备中的根使用独立 `"pending:<state>"` 身份：准备开始、装配推进与发布
    /// 都会改变身份，卡片因此重新武装并在发布后重新采样，而不是停在准备态。
    pub(crate) fn quality_identity(&self, id: &str) -> String {
        let Some(root) = self.roots.get(id) else {
            return match self.preparation_state(id) {
                super::super::preparation::RootState::Pending => "pending".to_owned(),
                _ => "absent".to_owned(),
            };
        };
        format!("{:?}:{}", root.quality, root.representation_generation)
    }
}

impl ModelVisuals {
    pub(crate) fn refresh_resource_references(&mut self) {
        self.mesh_references.clear();
        self.material_references.clear();
        for root in self.roots.values() {
            self.mesh_references
                .add_consumer(root.mesh_handles.iter().map(|h| h.id()));
            self.material_references
                .add_consumer(root.material_handles.iter().map(|h| h.id()));
        }
        for retained in self.capture_retention.values() {
            self.mesh_references
                .add_consumer(retained.meshes.iter().map(|h| h.id()));
            self.material_references
                .add_consumer(retained.materials.iter().map(|h| h.id()));
        }
        // 在途总览准备的暂存 replacement 同样是显式消费方：最后消费者前不释放，取消/发布后
        // 回收（change: 2026-10-15-add-film-set-overview-lod，design D4）。
        if let Some(pending) = &self.pending {
            self.mesh_references
                .add_consumer(pending.staged_meshes().iter().map(|h| h.id()));
        }
        // Native 后台准备的 staging 也持有已登记 mesh/material：在发布前必须保持存活，
        // 否则缓存驱逐会让发布出来的根引用悬空资产
        // （change: 2026-10-18-prepare-native-film-sets-in-background，design D6）。
        for staging in self.staging.values() {
            self.mesh_references
                .add_consumer(staging.staged_meshes().iter().map(|h| h.id()));
            self.material_references
                .add_consumer(staging.staged_materials().iter().map(|h| h.id()));
        }
    }

    pub(crate) fn trim_resources(
        &mut self,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
    ) {
        // 归属集合未变时引用计数与上一轮完全相同，跳过 O(根×handle) 的全量重建；
        // 仍执行 `trim`，以便回收 prepare 期间新增但未被引用的缓存条目
        // （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D8）。
        let key = super::OwnershipKey::of(self);
        if self.references_key == Some(key) {
            self.hot_path.resource_reference_skips += 1;
        } else {
            self.refresh_resource_references();
            self.references_key = Some(key);
            self.hot_path.resource_reference_rebuilds += 1;
        }
        self.shared.trim(
            meshes,
            materials,
            &self.mesh_references,
            &self.material_references,
            // staging 仍持有资产时不能把共享缓存当作「已无消费者」清空
            // （change: 2026-10-18-prepare-native-film-sets-in-background，design D6）。
            self.roots.is_empty() && self.capture_retention.is_empty() && self.staging.is_empty(),
        );
    }
}
