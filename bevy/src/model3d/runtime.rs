//! 按 signature 同步、根 transform 应用、资源清理与聚焦可见性
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2）。

use std::collections::HashMap;
use std::sync::Arc;

use bevy::prelude::*;

use crate::protocol::{GraphNode, ModelPlacement, ModelSnapshot, Scene};

use super::animation::TransformAnimationPlayback;
use super::layout::model_root_transform;
use super::spawn::spawn_model;

/// 已注册不可变模型资源表（只读视图）；由 app 从 bridge 资源表取得。
///
/// 传入而非在 `model3d` 内读取，保持本模块不依赖 `bridge` / wasm（architecture guard）。
pub(crate) type ModelAssets = HashMap<String, Arc<ModelSnapshot>>;

/// 3D 模型的根锚点（承载动画与相对定位）。
#[derive(Component)]
pub(crate) struct ModelAnchor;

#[derive(Resource, Default)]
pub(crate) struct ModelVisuals {
    pub(super) batching_strategy: super::batch_strategy::BatchStrategy,
    pub(super) roots: HashMap<String, ModelRoot>,
    /// 测试替身：让 dispatch/overview 用例能声明「模型根已就绪」而不必装配整棵渲染根。
    #[cfg(test)]
    pub(super) ready_roots_for_test: std::collections::HashSet<String>,
    pub(super) shared: super::resources::SharedResources,
    pub(super) mesh_references:
        super::resource_ownership::ResourceReferences<bevy::asset::AssetId<Mesh>>,
    pub(super) material_references:
        super::resource_ownership::ResourceReferences<bevy::asset::AssetId<StandardMaterial>>,
    pub(super) demand: Option<std::collections::HashSet<String>>,
    pub(super) offscreen_since: HashMap<String, f64>,
    /// Highest-quality consumers retain capture visibility independently of card focus.
    pub(super) capture_retention: HashMap<u64, CaptureRetention>,
    pub(super) capture_pins: std::collections::HashSet<String>,
    /// 真正的高质量消费者（进行中的截图/导出请求）。可见镜头卡片只进入 `capture_pins`
    /// 保留驻留，不构成 High 需求（2026-10-28 总览缩放时卡片把片场按在 High 的修复）。
    pub(super) high_demand: std::collections::HashSet<String>,
    /// 上一次门禁结算时正在播放的模型节点；用于 A→B 切换时原子 stop 旧根
    /// （change: play-model-animations-on-hover，design D1/D3）。
    pub(super) active_model: Option<String>,
    pub(super) joint_targets: HashMap<String, std::collections::HashSet<String>>,
    pub(super) motion_plan: Option<std::sync::Arc<super::motion_plan::MotionPlan>>,
    pub(super) playback_events: std::collections::VecDeque<serde_json::Value>,
    pub(super) motion_targets: Option<(String, Arc<std::collections::HashSet<String>>)>,
    /// 热路径实际工作量计数（累积）；只服务诊断，不代表 GPU 时间
    /// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D6）。
    pub(crate) hot_path: HotPathCounters,
    /// 上一次资源引用重建时的归属指纹；未变则跳过全量重建
    /// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D8）。
    pub(super) references_key: Option<OwnershipKey>,
    /// 已隐藏、等待按预算退役的旧根实体。
    pub(super) retiring: Vec<Entity>,
}

/// 每帧命令插入/引用重建的实际工作量（累积）。用于证明优化确实减少了写入，
/// 不作为 GPU 时间或帧率估计。
#[derive(Default)]
pub(crate) struct HotPathCounters {
    pub(crate) focus_visibility_inserts: u64,
    pub(crate) focus_visibility_skips: u64,
    pub(crate) preview_layer_inserts: u64,
    pub(crate) preview_layer_skips: u64,
    pub(crate) resource_reference_rebuilds: u64,
    pub(crate) resource_reference_skips: u64,
    pub(crate) preview_sprite_inserts: u64,
    pub(crate) preview_sprite_skips: u64,
    pub(crate) preview_pose_inserts: u64,
    pub(crate) preview_pose_skips: u64,
}

/// 资源归属的廉价指纹：摘要所有会影响共享资源存活集合的身份。
///
/// 只要真实归属集合不变，`refresh_resource_references` 的结果也不变，可整段跳过；
/// 重建/质量替换都会推进 `representation_generation`，因此不会漏检。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct OwnershipKey {
    roots: usize,
    generations: u64,
    mesh_handles: usize,
    material_handles: usize,
    capture_snapshots: usize,
    capture_handles: usize,
    capture_keys: u64,
}

impl OwnershipKey {
    pub(super) fn of(models: &ModelVisuals) -> Self {
        let mut keys = Self {
            roots: models.roots.len(),
            generations: 0,
            mesh_handles: 0,
            material_handles: 0,
            capture_snapshots: models.capture_retention.len(),
            capture_handles: 0,
            capture_keys: 0,
        };
        for root in models.roots.values() {
            keys.generations = keys
                .generations
                .wrapping_add(root.representation_generation)
                .wrapping_mul(0x1000_0000_01b3);
            keys.mesh_handles += root.mesh_handles.len();
            keys.material_handles += root.material_handles.len();
        }
        for (id, retained) in &models.capture_retention {
            keys.capture_keys = keys.capture_keys.wrapping_add(*id);
            keys.capture_handles += retained.meshes.len() + retained.materials.len();
        }
        keys
    }
}

pub(super) struct CaptureRetention {
    pub meshes: Vec<Handle<Mesh>>,
    pub materials: Vec<Handle<StandardMaterial>>,
    pub bytes: usize,
}

/// 当前聚焦状态（change: add-model-focus-viewing）。
///
/// 只记录“上一帧应用过哪个目标”，用于在投影清除时恢复正交相机并重新显示全部内容。
#[derive(Resource, Default)]
pub(crate) struct FocusVisuals {
    /// 当前聚焦目标节点 id；None 表示普通画布。
    pub(crate) node: Option<String>,
}

/// 模型根：内容 identity 与根 transform identity 分离（change: add-model-focus-editing，任务 1.1）。
///
/// `content_signature` 只承载 Scene IR/version/material/animation 内容 identity。node/card
/// position、view mode 与 `modelPlacement` 的根 transform 变化只刷新下方 layout 的 Transform，
/// 不重建 entity/mesh/material；只有内容 identity 变化才原子重建并释放旧资源。
pub(crate) struct ModelRoot {
    pub(super) group_children: HashMap<String, ModelRoot>,
    pub(super) entities: Vec<Entity>,
    /// 内容 identity（Scene IR/version/material/animation）；决定是否重建 hierarchy。
    pub(super) content_signature: String,
    /// 建立该根时的模型纹理表 revision；纹理晚到/被回收后变化时重建，使材质重新绑定句柄
    /// （change: 2026-10-28-support-glb-model-nodes）。
    pub(super) texture_revision: u64,
    /// 该资源表条目的 `Arc`；保证本帧引用期间不被 LRU 淘汰。
    pub(super) resource: std::sync::Arc<ModelSnapshot>,
    /// 实例的 placement；placement 变化只刷新根 transform，不重建。
    pub(super) placement: ModelPlacement,
    /// 根 transform 布局（重建时记录，刷新时按最新 placement/viewport 重算）。
    pub(super) layout: ModelRootLayout,
    /// 该模型创建/复用的 mesh handle；重建或删除时释放。
    pub(super) mesh_handles: Vec<Handle<Mesh>>,
    pub(super) active_mesh_handles: Vec<Handle<Mesh>>,
    pub(super) batched: bool,
    pub(super) part_batches: HashMap<String, Entity>,
    pub(super) prepared_targets: std::collections::HashSet<String>,
    pub(super) batches: Vec<super::batch_cache::BatchBinding>,
    #[cfg(feature = "explicit-instancing")]
    pub(super) instance_parts: HashMap<Entity, Arc<[String]>>,
    pub(super) geometries: Vec<(Entity, String, Arc<super::scene::ModelGeometry>)>,
    pub(super) quality: super::quality::Quality,
    pub(super) quality_changed_at: Option<f64>,
    /// Async LOD completion must survive offscreen quality deferral.
    pub(super) quality_refresh_pending: bool,
    pub(super) representation_generation: u64,
    /// 该模型创建/复用的 material handle；重建或删除时释放。
    pub(super) material_handles: Vec<Handle<StandardMaterial>>,
    /// 该模型内挂载了动画的实体集合（V2 层级节点）。
    ///
    /// 由 spawn 时记录，供 hover 门禁在 O(动画实体数) 内 stop/start，避免每帧扫描全部模型
    /// （change: play-model-animations-on-hover，design D3）。
    pub(super) animation_entities: Vec<Entity>,
    /// 稳定部件 id → entity（change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
    pub(super) part_entities: HashMap<String, Entity>,
    /// 稳定部件 id → **基础** transform（不含 motion 增量），供运动求值合成。
    pub(super) part_bases: HashMap<String, Transform>,
    /// 透明度动作的专属材质实例（实体 → 实例），随根复用并在实体消失时回收
    /// （change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
    pub(super) opacity: super::opacity::OpacityMaterials,
    /// 稳定部件 id → 该部件当前使用的**共享**材质句柄，供透明度动作克隆实例。
    pub(super) part_materials: HashMap<String, Handle<StandardMaterial>>,
}

/// 根 transform 布局（change: 2026-10-07-remove-residual-compatibility —— V2-only）。
pub(super) enum ModelRootLayout {
    /// V2：单个根 entity 承载 placement/view/unit；子级为真实层级。
    V2 { root: Entity },
}

/// 重算并写回模型根 transform（placement / node position 变化时）。
///
/// 不触碰 mesh/material 或 entity 结构：高频 placement preview 因此不产生资源增长
/// （change: add-model-focus-editing，任务 1.1 / design D4）。
pub(super) fn apply_root_transform(
    commands: &mut Commands,
    layout: &ModelRootLayout,
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
) {
    let transform = model_root_transform(node, model, placement);
    let ModelRootLayout::V2 { root } = layout;
    if let Ok(mut entity) = commands.get_entity(*root) {
        entity.insert(transform);
    }
}

/// 释放一个模型根持有的 entity 与资源。
///
/// Bevy 0.16 的 `despawn` 会递归销毁后代，因此先销毁根即可。统一用 `try_despawn`
/// 避免对已随根销毁的实体重复告警。透明度动作克隆出的专属材质实例不进入共享缓存，
/// 必须在这里显式回收（change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。
pub(super) fn despawn_root(
    commands: &mut Commands,
    materials: &mut Assets<StandardMaterial>,
    mut root: ModelRoot,
) {
    for (_, child) in root.group_children.drain() {
        despawn_root(commands, materials, child);
    }
    root.opacity.release_instances(materials);
    for entity in &root.entities {
        commands.entity(*entity).try_despawn();
    }
}

/// 按内容 signature 重建 / 保留，并按 placement/position 刷新根 transform，最后按
/// 聚焦状态设置可见性（change: add-model-focus-editing，任务 1.1 / design D4；
/// change: make-shot-framing-zoom-invariant：模型世界不读取 viewport/surface）。
pub(crate) fn sync_models(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    models: &mut ModelVisuals,
    focus: &mut FocusVisuals,
    resources: &ModelAssets,
    scene: &Scene,
) {
    focus.node = scene
        .model_focus
        .as_ref()
        .map(|focus| focus.node_id.clone());
    // resources 由调用方共享；本帧解析出的资源用 `Arc` 保活，避免注册表淘汰后
    // 已建实体持有的 mesh 引用失去来源（change: optimize-model-scene-snapshot-hot-path）。
    let mut desired = HashMap::new();
    for node in &scene.nodes {
        if models
            .demand
            .as_ref()
            .is_some_and(|d| !d.contains(&node.id))
        {
            continue;
        }
        let Some(reference) = &node.model else {
            continue;
        };
        // 场景校验已在边界保证 key 存在；这里防御性跳过未知资源。
        let Some(resource) = resources.get(&reference.resource_key) else {
            continue;
        };
        desired.insert(node.id.as_str(), reference);
        // 内容 identity 决定是否重建：只有 Scene IR/version/material/animation 变化才重建。
        // placement/viewport 变化只刷新根 transform。
        let content_signature = reference.signature.as_str();
        let allowed = models.batching_strategy.merges();
        #[cfg(feature = "explicit-instancing")]
        let allowed = allowed
            && (models.batching_strategy != super::batch_strategy::BatchStrategy::Explicit
                || node.model_preview.is_some());
        // Joint samples address stable hierarchical part entities. Keep this instance
        // unbatched for the whole timeline, including frames before its first key.
        let part_motion = reference.part_rotations.is_some();
        let batched = allowed && !part_motion
            && !models.high_demand.contains(&node.id) && !scene
            .model_editor
            .as_ref()
            .is_some_and(|e| e.node_id == node.id)
            && !scene
                .model_focus
                .as_ref()
                .is_some_and(|e| e.node_id == node.id);
        let texture_revision = super::model_textures::revision();
        // 只有真正引用内嵌纹理的模型需要在纹理表变化时重建；脚本模型与无纹理 GLB 不受影响。
        let needs_textures = resource.ops.iter().any(|op| {
            matches!(op, crate::protocol::ModelOp::Material { base_color_texture: Some(_), .. })
        });
        let rebuild = models.roots.get(&node.id).is_none_or(|root| {
            root.content_signature != content_signature || root.batched != batched
                || (needs_textures && root.texture_revision != texture_revision)
                || !Arc::ptr_eq(&root.resource, resource)
        });
        if rebuild {
            let rebuild_started = bevy::platform::time::Instant::now();
            models.record_playback(serde_json::json!({"event":"root-rebuild", "nodeId":node.id,
                "reason": models.roots.get(&node.id).map_or("initial", |root| {
                    if root.content_signature != content_signature || !Arc::ptr_eq(&root.resource, resource) { "content" } else { "edit-focus-capture-or-strategy" }
                })}));
            let generation = models
                .roots
                .get(&node.id)
                .map_or(0, |root| root.representation_generation.wrapping_add(1));
            if let Some(previous) = models.roots.remove(&node.id) {
                despawn_root(commands, materials, previous);
            }
            let mut root = spawn_model(
                commands,
                meshes,
                materials,
                node,
                resource,
                &reference.placement,
                super::quality::initial(
                    node,
                    scene,
                    focus.node.as_deref(),
                    models.high_demand.contains(&node.id),
                    resource,
                ),
                &mut models.shared,
                batched,
                models.batching_strategy,
            );
            root.representation_generation = generation;
            root.content_signature = content_signature.to_owned();
            root.texture_revision = texture_revision;
            root.resource = resource.clone();
            root.placement = reference.placement.clone();
            // 重建后的新动画实体按当前门禁初始化：只有目标仍是唯一合法 hover 模型时从零播放，
            // 否则保持 inactive（change: play-model-animations-on-hover，任务 2.3）。
            let start_active = models.active_model.as_deref() == Some(node.id.as_str());
            init_root_playback(commands, &root.animation_entities, start_active);
            models.roots.insert(node.id.clone(), root);
            models.record_playback(
                serde_json::json!({"event":"root-prepared", "nodeId":node.id,
                "cpuMs":rebuild_started.elapsed().as_secs_f64() * 1000.0}),
            );
        } else {
            let root = models.roots.get_mut(&node.id).expect("root exists");
            // 内容 signature 不变，但 placement 可能变化：刷新根 transform，保持资源引用。
            root.resource = resource.clone();
            root.placement = reference.placement.clone();
            apply_root_transform(
                commands,
                &root.layout,
                node,
                &root.resource,
                &root.placement,
            );
        }
    }
    if let Some(playback) = &scene.animation_playback {
        let plan = super::motion_plan::resolve(models, playback);
        super::playback_prepare::prepare(
            commands,
            meshes,
            materials,
            models,
            playback,
            &plan.targets,
        );
    }
    let stale: Vec<String> = models
        .roots
        .keys()
        .filter(|id| !desired.contains_key(id.as_str()))
        .cloned()
        .collect();
    for id in stale {
        if let Some(mut root) = models.roots.remove(&id) {
            // 透明度实例不随实体销毁自动回收（不在共享缓存里），显式移除。
            root.opacity.release_instances(materials);
            despawn_root(commands, materials, root);
        }
    }
    models.set_visible_focus(
        commands,
        scene
            .model_focus
            .as_ref()
            .map(|focus| focus.node_id.as_str()),
        scene,
    );
    purge_unresolved_active(&mut models.active_model, &scene.nodes);
    apply_animation_playback(commands, models, scene);
    models.trim_resources(meshes, materials);
}

impl ModelRoot {
    /// 承载可见性与渲染层归属的层级根实体（V2 布局）。    ///
    /// 可见性沿层级向下传播，渲染层不会，因此两者都需要根实体。
    pub(super) fn root_entity(&self) -> Entity {
        let ModelRootLayout::V2 { root } = self.layout;
        root
    }
}

impl ModelVisuals {
    #[cfg(test)]
    pub(crate) fn test_root(&self, id: &str) -> Option<Entity> {
        self.roots.get(id).map(|model| match model.layout {
            ModelRootLayout::V2 { root } => root,
        })
    }

    #[cfg(test)]
    pub(crate) fn test_part(&self, id: &str, part: &str) -> Option<Entity> {
        self.roots.get(id)?.part_entities.get(part).copied()
    }
    /// 测试替身：声明某个节点已有可用模型根（不涉及 GPU 资源）。
    #[cfg(test)]
    pub(crate) fn mark_root_ready_for_test(&mut self, id: &str) {
        self.ready_roots_for_test.insert(id.to_owned());
    }

    /// 是否存在需要连续更新的模型活动（hover/动画播放、运动求值、截图 pin/保留）。
    ///
    pub(crate) fn has_hot_activity(&self) -> bool {
        self.active_model.is_some()
            || self.motion_plan.is_some()
            || self.motion_targets.is_some()
            || !self.high_demand.is_empty()
            || !self.capture_retention.is_empty()
    }

    pub(crate) fn is_active_model(&self, id: &str) -> bool {
        self.active_model.as_deref() == Some(id)
    }

    pub(crate) fn is_active_animated_model(&self, id: &str) -> bool {
        self.is_active_model(id)
            && self.roots.get(id).is_some_and(|root| !root.animation_entities.is_empty())
    }

    pub(crate) fn preview_meshes(&self, id: &str) -> Vec<bevy::asset::AssetId<Mesh>> {
        self.roots
            .get(id)
            .map(|root| root.active_mesh_handles.iter().map(|h| h.id()).collect())
            .unwrap_or_default()
    }
    pub(crate) fn preview_materials(
        &self,
        id: &str,
    ) -> Vec<bevy::asset::AssetId<StandardMaterial>> {
        self.roots
            .get(id)
            .map(|root| root.material_handles.iter().map(|h| h.id()).collect())
            .unwrap_or_default()
    }
    /// 计算卡片的渲染层（纯函数，不写命令）；供调用方做重复写入去重。
    pub(crate) fn preview_layers(
        &self,
        id: &str,
        layer: usize,
        focused: bool,
    ) -> Option<bevy::camera::visibility::RenderLayers> {
        self.roots.get(id)?;
        let mut layers = bevy::camera::visibility::RenderLayers::from_layers(&[layer]);
        if focused {
            layers = layers.with(0);
        }
        #[cfg(feature = "canvas-core")]
        if focused || self.high_demand.contains(id) {
            layers = layers.with(super::capture::CAPTURE_LAYER);
        }
        Some(layers)
    }

    /// Isolate an existing root without cloning its mesh/material resources.
    ///
    /// `RenderLayers` 不随层级继承，因此必须逐实体写入；返回实际写入的实体数，
    /// 供调用方做目标层未变时的跳过与工作量统计（design D7）。
    pub(crate) fn preview_layer(
        &self,
        commands: &mut Commands,
        id: &str,
        layer: usize,
        focused: bool,
    ) -> Option<u64> {
        let layers = self.preview_layers(id, layer, focused)?;
        let root = self.roots.get(id)?;
        for entity in &root.entities {
            commands.entity(*entity).insert(layers.clone());
        }
        Some(root.entities.len() as u64)
    }

    /// 只更新可见性；退出镜头过渡期间也可保留指定模型，不重建场景。
    ///
    /// 只写层级根：Bevy 的可见性传播会把 `Hidden`/`Inherited` 传给全部后代
    /// （`visibility_propagate_system` 保留子级自身的局部 `Hidden`），因此不必
    /// 遍历整棵子树（change: 2026-10-14-scope-film-set-object-picking-to-focus，design D6）。
    pub(crate) fn set_visible_focus(
        &mut self,
        commands: &mut Commands,
        focus_node: Option<&str>,
        scene: &crate::protocol::Scene,
    ) {
        let mut inserts = 0u64;
        let mut skips = 0u64;
        for (id, root) in &self.roots {
            let visible = focus_node.is_none_or(|selected| selected == id)
                || (crate::canvas_query::focus_context::contains(scene, id)
                    && scene
                        .nodes
                        .iter()
                        .any(|n| n.id == *id && n.model_preview.is_some()));
            let visibility = if visible {
                Visibility::Inherited
            } else {
                Visibility::Hidden
            };
            match commands.get_entity(root.root_entity()) {
                Ok(mut entity_commands) => {
                    entity_commands.insert(visibility);
                    inserts += 1;
                }
                Err(_) => skips += 1,
            }
        }
        self.hot_path.focus_visibility_inserts += inserts;
        self.hot_path.focus_visibility_skips += skips;
    }
}

/// 唯一合法 hover 播放模型：`modelFocus` 缺失时，`hover.nodeId` 指向且确实具有模型资源的节点。
///
/// `modelFocus` 优先级高于 hover（change: play-model-animations-on-hover，design D1）。
pub(crate) fn active_playback_model(scene: &Scene) -> Option<&str> {
    if scene.model_focus.is_some() {
        return None;
    }
    let node_id = scene.hover.as_ref()?.node_id.as_deref()?;
    let node = scene.nodes.iter().find(|node| node.id == node_id)?;
    node.model.as_ref().map(|_| node_id)
}

/// 门禁目标在后续 scene 中消失时清空 active，避免悬空节点 id 让重建误判为仍活跃。
fn purge_unresolved_active(active: &mut Option<String>, nodes: &[GraphNode]) {
    let Some(id) = active.as_deref() else {
        return;
    };
    let alive = nodes
        .iter()
        .any(|node| node.id == id && node.model.is_some());
    if !alive {
        *active = None;
    }
}

/// 把一组动画实体初始化为 stopped/reset 或 start-from-zero。
fn init_root_playback(commands: &mut Commands, entities: &[Entity], start: bool) {
    for entity in entities {
        if let Ok(mut entity_commands) = commands.get_entity(*entity) {
            let mut playback = TransformAnimationPlayback::default();
            if start {
                playback.start();
            }
            entity_commands.insert(playback);
        }
    }
}

/// hover/focus 播放门禁结算（change: play-model-animations-on-hover，任务 2.2 / design D3/D4）。
///
/// 由最新 `Scene` 推导唯一 active model：旧/新根原子 stop/reset → start。`modelFocus` 存在时
/// 目标为空，因此进入 edit/history 聚焦会清空播放；残留 hover 不会重启动画。
pub(crate) fn apply_animation_playback(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    scene: &Scene,
) {
    let desired = active_playback_model(scene).map(str::to_owned);
    if desired == models.active_model {
        return;
    }
    if let Some(previous) = models.active_model.take()
        && let Some(root) = models.roots.get(&previous)
    {
        init_root_playback(commands, &root.animation_entities, false);
    }
    if let Some(next) = &desired
        && let Some(root) = models.roots.get(next)
    {
        init_root_playback(commands, &root.animation_entities, true);
    }
    models.active_model = desired;
}

mod motion;
pub(crate) use motion::apply_motion_playback;
pub(crate) use motion::compose_delta;
/// Quality-only updates never rebuild the hierarchy, execute author scripts or
/// touch canonical AABBs. Cached variants are bounded to three per geometry.
mod quality;
pub(crate) use quality::{sync_quality, sync_quality_with_demand};
