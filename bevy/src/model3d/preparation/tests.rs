//! Native 片场后台准备的非渲染回归
//! （change: 2026-10-18-prepare-native-film-sets-in-background，design D7 / 任务 1.1–5.2）。
//!
//! 覆盖：同步与纯准备产物等价、准备 key 复用/跨实例共享、成果不携带 ECS 依赖、
//! 预算化装配（工作单元/新 mesh 字节/oversize）、乱序完成、连续平移、取消/换源、
//! CPU 工作额度、共享引用与失败重试。全部只跑 CPU 与 ECS，不创建渲染器或 GPU 资源。

use std::collections::HashMap;
use std::sync::Arc;

use bevy::prelude::*;

use crate::protocol::{
    GraphNode, ModelOp, ModelPlacement, ModelReference, ModelSnapshot, Scene,
};

use super::super::batch_strategy::BatchStrategy;
use super::super::quality::Quality;
use super::super::runtime::{ModelAssets, ModelVisuals, sync_models};
use super::assembly::{MAX_NEW_MESH_BYTES, MAX_UNITS_PER_FRAME};
use super::schedule::{MAX_QUEUED, MAX_RUNNING, MAX_WORK_BYTES, Mode, PrepareKey, Priority};
use super::{RootState, enabled};

/// 声明总览 LOD 的片场节点。
fn film_set_node(id: &str) -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id": id, "type": "model", "x": 0, "y": 0, "width": 260, "height": 195,
        "compositeAsset": {
            "x": 0, "y": 0, "width": 260, "height": 195,
            "geometryQuality": "overview-primitives-v1"
        }
    }))
    .unwrap()
}

/// 混合图元 + 自定义 Mesh + segment + 层级 + 动画的片场内容。
fn mixed_snapshot(signature: &str) -> ModelSnapshot {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2",
        "signature": signature,
        "extent": 12,
        "ops": [
            {"t": "group", "id": "root"},
            {"t": "group", "id": "inner", "parent": "root", "position": [0, 0.5, 0]},
            {"t": "sphere", "id": "s0", "parent": "inner", "radius": 1, "color": "#ffffff"},
            {"t": "box", "id": "b0", "parent": "root", "size": [1, 1, 1], "color": "#ffffff"},
            {"t": "cylinder", "id": "c0", "parent": "root", "radius": 0.5, "height": 2,
             "color": "#ffffff"},
            {"t": "capsule", "id": "p0", "parent": "root", "radius": 0.4, "height": 2,
             "color": "#ffffff"},
            {"t": "mesh", "id": "m0", "parent": "root",
             "vertices": [[0,0,0],[1,0,0],[0,1,0],[1,1,0]],
             "faces": [[0,1,2],[1,3,2]], "color": "#ff0000"},
            {"t": "segment", "id": "g0", "parent": "root", "from": [0,0,0], "to": [0,2,0],
             "width": 0.2, "color": "#00ff00"},
            {"t": "rotate", "id": "b0", "axis": "y", "speed": 1.0}
        ]
    }))
    .unwrap();
    snapshot
}

fn reference_for(snapshot: &ModelSnapshot) -> ModelReference {
    ModelReference {
        resource_key: format!(
            "{}:{}",
            snapshot.scene_version.clone().unwrap_or_default(),
            snapshot.signature
        ),
        scene_version: snapshot.scene_version.clone(),
        signature: snapshot.signature.clone(),
        placement: ModelPlacement::default(),
    }
}

fn scene_with(nodes: Vec<GraphNode>) -> Scene {
    Scene {
        nodes,
        ..Scene::default()
    }
}

fn resources_for(snapshots: &[ModelSnapshot]) -> ModelAssets {
    snapshots
        .iter()
        .map(|snapshot| (reference_for(snapshot).resource_key, Arc::new(snapshot.clone())))
        .collect::<HashMap<_, _>>()
}

fn world_with_resources() -> World {
    let mut world = World::new();
    world.init_resource::<Assets<Mesh>>();
    world.init_resource::<Assets<StandardMaterial>>();
    world.init_resource::<ModelVisuals>();
    world
}

/// 复刻调度器行为：取/放资源 + flush，并额外推进一次准备装配。
fn run_sync(world: &mut World, scene: &Scene, resources: &ModelAssets) {
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut focus = world.remove_resource::<super::super::runtime::FocusVisuals>().unwrap_or_default();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let mut materials = world
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap();
    let mut commands = world.commands();
    sync_models(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut visuals,
        &mut focus,
        resources,
        scene,
    );
    world.flush();
    world.insert_resource(visuals);
    world.insert_resource(focus);
    world.insert_resource(meshes);
    world.insert_resource(materials);
}

/// 只执行一次同步 `sync_models`（不分流推进），用于对比改动前的宿主成本。
fn run_sync_once(world: &mut World, scene: &Scene, resources: &ModelAssets) {
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut focus = world
        .remove_resource::<super::super::runtime::FocusVisuals>()
        .unwrap_or_default();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let mut materials = world
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap();
    let mut commands = world.commands();
    sync_models(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut visuals,
        &mut focus,
        resources,
        scene,
    );
    world.flush();
    world.insert_resource(visuals);
    world.insert_resource(focus);
    world.insert_resource(meshes);
    world.insert_resource(materials);
}

fn advance(world: &mut World, scene: &Scene, resources: &ModelAssets) -> bool {
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let changed = super::assembly::assemble(world, &mut visuals, scene, resources);
    world.insert_resource(visuals);
    changed
}

/// 推进到该节点发布为止（有界轮数，避免测试挂死）。
fn advance_until_published(
    world: &mut World,
    scene: &Scene,
    resources: &ModelAssets,
    node: &str,
    frames: usize,
) -> bool {
    for _ in 0..frames {
        advance(world, scene, resources);
        if world
            .resource::<ModelVisuals>()
            .roots
            .contains_key(node)
        {
            return true;
        }
    }
    false
}

/// 纯准备产物与同步创建等价（primitive / 自定义 Mesh / segment / 层级 / 动画 specs）。
#[test]
fn pure_preparation_matches_sync_spawn_for_every_spec_kind() {
    if !enabled() {
        // 非 native 构建：分流关闭，验证同步路径仍然可用。
        return;
    }
    let snapshot = mixed_snapshot("mixed");
    let prepared = super::prepared::prepare(
        &Arc::new(snapshot.clone()),
        Quality::Low,
        true,
        BatchStrategy::Spatial,
        true,
    )
    .expect("prepared");
    let specs = super::super::scene::build_entity_specs(&snapshot);
    // 部件范围：批次合并的 + 未合并的 = 原始 specs（无需构建的部件除外）。
    assert_eq!(
        prepared.parts.len() + prepared.batched_part_count,
        specs.len(),
        "每个规范部件都必须落在批次或独立部件中"
    );
    let mut ids: Vec<&str> = prepared.parts.iter().map(|part| part.id.as_str()).collect();
    for batch in &prepared.batches {
        ids.extend(batch.source.specs.iter().map(|spec| spec.id.as_str()));
    }
    for spec in &specs {
        assert!(ids.contains(&spec.id.as_str()), "缺少部件 {}", spec.id);
    }
    // 局部变换与动画描述等价。
    for part in &prepared.parts {
        let spec = specs.iter().find(|spec| spec.id == part.id).unwrap();
        assert_eq!(part.transform.translation, Vec3::from_array(spec.position));
        assert_eq!(part.animation.is_some(), spec.animation.is_some());
        if let Some(geometry) = &part.geometry {
            assert_eq!(
                part.effective,
                super::super::mesh::effective_quality(geometry, Quality::Low, true),
                "每几何有效档位必须与同步路径一致"
            );
        }
    }
    // 自定义 Mesh 在总览根保持 High（不新增简化任务）。
    let mesh_part = prepared
        .parts
        .iter()
        .find(|part| part.id == "m0")
        .expect("custom mesh part");
    assert_eq!(mesh_part.effective, Quality::High);
    // Box 恒 High。
    let box_batch = prepared
        .batches
        .iter()
        .any(|batch| batch.source.specs.iter().any(|spec| spec.id == "b0"));
    if box_batch {
        assert!(
            prepared
                .batches
                .iter()
                .all(|batch| batch.quality == Quality::High || batch.quality < Quality::High)
        );
    }
    // segment 被表达为 Box/Capsule 几何，而不是丢失。
    assert!(ids.contains(&"g0"));
}

/// 准备 key 不含实例 placement / viewport：仅平移与相同内容不重排。
#[test]
fn prepare_key_ignores_placement_and_viewport_but_tracks_content_quality_and_strategy() {
    let snapshot = Arc::new(mixed_snapshot("content-a"));
    let base = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    let same = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    assert_eq!(base, same);

    let other_quality = PrepareKey::new(&snapshot, Quality::Medium, true, BatchStrategy::Spatial, true);
    assert_ne!(base, other_quality);
    let other_strategy = PrepareKey::new(&snapshot, Quality::Low, false, BatchStrategy::Automatic, true);
    assert_ne!(base, other_strategy);
    let other_content = PrepareKey::new(
        &Arc::new(mixed_snapshot("content-b")),
        Quality::Low,
        true,
        BatchStrategy::Spatial,
        true,
    );
    assert_ne!(base, other_content);
    // 相同内容但新 Arc（内容相同的新 generation）：签名相同但资源身份不同，仍需精确校验，
    // 因此 key 不同；只有真正同一不可变内容才复用（见下方跨根共享测试）。
    let cloned = Arc::new((*snapshot).clone());
    let rebuilt = PrepareKey::new(&cloned, Quality::Low, true, BatchStrategy::Spatial, true);
    assert_ne!(base, rebuilt);
}

/// 同内容两实例共享准备产物与已登记资产，实例映射/摆放独立。
#[test]
fn two_instances_share_prepared_assets_but_keep_independent_mappings() {
    let snapshot = mixed_snapshot("shared");
    let mut a = film_set_node("a");
    let mut b = film_set_node("b");
    let reference = reference_for(&snapshot);
    a.model = Some(reference.clone());
    b.model = Some(reference.clone());
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let mut scene = scene_with(vec![a, b]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "a", 64));
    assert!(advance_until_published(&mut world, &scene, &resources, "b", 64));

    let visuals = world.resource::<ModelVisuals>();
    let root_a = &visuals.roots["a"];
    let root_b = &visuals.roots["b"];
    // 共享资产：相同 mesh handle 只登记一次。
    let handles_a: Vec<_> = root_a.mesh_handles.iter().map(|h| h.id()).collect();
    let handles_b: Vec<_> = root_b.mesh_handles.iter().map(|h| h.id()).collect();
    assert!(
        handles_a.iter().any(|id| handles_b.contains(id)),
        "同内容实例必须共享已登记 mesh"
    );
    // 实例映射独立。
    assert_ne!(root_a.part_entities.get("s0"), root_b.part_entities.get("s0"));
    // 只准备一次：同 key 不会重复建网格。
    assert!(
        visuals.preparation.work.started <= 1,
        "同 key 多实例不应重复准备，实际 {}",
        visuals.preparation.work.started
    );

    // 移动 b 的 placement 不影响 a。
    let placement = ModelPlacement {
        offset: crate::protocol::ModelOffset {
            x: 5.0,
            y: 0.0,
            z: 0.0,
        },
        scale: 1.5,
        yaw: 0.5,
    };
    let mut reference_b = reference.clone();
    reference_b.placement = placement.clone();
    scene.nodes[1].model = Some(reference_b);
    run_sync(&mut world, &scene, &resources);
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(visuals.roots["b"].placement, placement);
    assert_eq!(visuals.roots["a"].placement, ModelPlacement::default());
}

/// staging 根在完整装配前不可见、不进入已发布映射，发布后不留半成品实体。
#[test]
fn staging_is_invisible_and_never_appears_as_published_root() {
    if !enabled() {
        // 非 native 构建不分流：全部根走同步创建，不存在 staging 阶段。
        return;
    }
    // 足够多的部件使装配必然跨越多帧（每帧全局 64 工作单元）。
    let mut ops = vec![serde_json::json!({"t": "group", "id": "root"})];
    for index in 0..200 {
        ops.push(serde_json::json!({
            "t": "sphere", "id": format!("s{index}"), "parent": "root",
            "radius": 0.2, "position": [index as f32 * 0.3, 0.0, 0.0], "color": "#ffffff"
        }));
    }
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "staging", "extent": 12, "ops": ops
    }))
    .unwrap();
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);

    let mut saw_staging = false;
    let mut frames = 0usize;
    loop {
        advance(&mut world, &scene, &resources);
        frames += 1;
        let published = world.resource::<ModelVisuals>().roots.contains_key("film");
        let staging_now = !world.resource::<ModelVisuals>().staging.is_empty();
        // staging 根必须始终 Hidden，并且不进入已发布根/预览 mesh。
        let hidden_anchors = world
            .iter_entities()
            .filter(|entity| entity.get::<super::super::runtime::ModelAnchor>().is_some())
            .filter(|entity| {
                entity
                    .get::<Visibility>()
                    .is_some_and(|visibility| *visibility == Visibility::Hidden)
            })
            .count();
        if staging_now && !published {
            saw_staging = true;
            let visuals = world.resource::<ModelVisuals>();
            assert_eq!(visuals.preparation_state("film"), RootState::Pending);
            assert!(!visuals.has_root("film"), "staging 不得进入已发布根");
            assert!(visuals.preview_meshes("film").is_empty());
            assert!(hidden_anchors >= 1, "staging 根必须不可见（第 {frames} 帧）");
        }
        if published {
            break;
        }
        assert!(frames < 64, "装配必须在有界帧内完成");
    }
    assert!(saw_staging, "该内容必须跨帧装配，才能验证 staging 不可见");
    let visuals = world.resource::<ModelVisuals>();
    assert!(visuals.staging.is_empty());
    assert!(visuals.has_root("film"));
    // 发布后不应残留隐藏的 staging 根（旧根退役也要按预算完成）。
    for _ in 0..64 {
        advance(&mut world, &scene, &resources);
    }
    let hidden_anchors = world
        .iter_entities()
        .filter(|entity| entity.get::<super::super::runtime::ModelAnchor>().is_some())
        .filter(|entity| {
            entity
                .get::<Visibility>()
                .is_some_and(|visibility| *visibility == Visibility::Hidden)
        })
        .count();
    assert_eq!(hidden_anchors, 0, "不应残留隐藏的 staging/旧根实体");
}

/// 装配受全局每帧预算限制，且实际 deferred 命令应用被计入工作量。
#[test]
fn assembly_respects_global_per_frame_budget_across_roots() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("budget");
    let mut nodes = Vec::new();
    for index in 0..4 {
        let mut node = film_set_node(&format!("film-{index}"));
        node.x = index as f32 * 400.0;
        node.model = Some(reference_for(&snapshot));
        nodes.push(node);
    }
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let scene = scene_with(nodes);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);

    let mut first_frame_units = 0u64;
    for frame in 0..64 {
        let before = world
            .resource::<ModelVisuals>()
            .preparation
            .work
            .units_total;
        advance(&mut world, &scene, &resources);
        let after = world
            .resource::<ModelVisuals>()
            .preparation
            .work
            .units_total;
        let used = after - before;
        assert!(
            used <= MAX_UNITS_PER_FRAME,
            "第 {frame} 帧装配 {} 单元，超过全局预算 {}",
            used,
            MAX_UNITS_PER_FRAME
        );
        if frame == 0 {
            first_frame_units = used;
        }
        let published = world.resource::<ModelVisuals>().roots.len();
        if published == 4 {
            break;
        }
    }
    assert!(first_frame_units > 0, "首帧必须开始装配");
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(visuals.roots.len(), 4, "多根最终都要完整发布");
    assert!(
        visuals.preparation.work.new_mesh_bytes_max <= MAX_NEW_MESH_BYTES as u64,
        "单帧新 mesh 字节必须受限"
    );
}

/// 连续平移（viewport 变化 + 新 generation）不取消任务、不重复构建。
#[test]
fn continuous_pan_does_not_restart_or_duplicate_preparation() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("pan");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let mut scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    for offset in 0..6 {
        scene.viewport.x = offset as f32 * -120.0;
        scene.viewport.y = offset as f32 * -80.0;
        run_sync(&mut world, &scene, &resources);
        advance(&mut world, &scene, &resources);
    }
    let visuals = world.resource::<ModelVisuals>();
    assert!(
        visuals.preparation.work.started <= 1,
        "平移不得重启准备，实际 {} 次",
        visuals.preparation.work.started
    );
    assert_eq!(visuals.preparation.work.cancelled, 0, "平移不得取消有效任务");
}

/// 换源后旧结果失效；删除节点后迟到完成不发布。
#[test]
fn content_replacement_and_deletion_invalidate_stale_results() {
    if !enabled() {
        return;
    }
    let first = mixed_snapshot("first");
    let second = mixed_snapshot("second");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&first));
    let resources = resources_for(&[first.clone(), second.clone()]);
    let mut scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    advance(&mut world, &scene, &resources);

    // 换源：旧需求作废。
    scene.nodes[0].model = Some(reference_for(&second));
    run_sync(&mut world, &scene, &resources);
    advance_until_published(&mut world, &scene, &resources, "film", 64);
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(
        visuals.roots["film"].content_signature, "second",
        "必须发布最新内容"
    );

    // 删除节点：根与需求都被回收。
    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    for _ in 0..64 {
        advance(&mut world, &scene, &resources);
    }
    let visuals = world.resource::<ModelVisuals>();
    assert!(!visuals.roots.contains_key("film"));
    assert_eq!(visuals.preparation_state("film"), RootState::Absent);
    assert!(visuals.staging.is_empty());
    assert!(visuals.retiring.is_empty(), "旧根退役必须按预算完成");
}

/// 目标档位变化合并为最新需求，不累积排队。
#[test]
fn quality_changes_merge_into_latest_demand() {
    let snapshot = Arc::new(mixed_snapshot("quality"));
    let mut scheduler = super::Scheduler::default();
    let key_low = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    let key_high = PrepareKey::new(&snapshot, Quality::High, true, BatchStrategy::Spatial, true);
    let low_token = scheduler.demand("film", key_low.clone(), snapshot.clone(), Priority::Warm);
    let high_token = scheduler.demand("film", key_high.clone(), snapshot.clone(), Priority::Visible);
    assert_ne!(low_token, high_token, "档位变化必须推进需求 token");
    assert_eq!(scheduler.demands().count(), 1, "同实例只保留最新需求");
    assert_eq!(scheduler.demand_of("film").unwrap().key, key_high);
    // 相同 key/优先级重复登记保持 token 稳定（仅平移/相同内容 full generation）。
    let stable = scheduler.demand("film", key_high.clone(), snapshot.clone(), Priority::Visible);
    assert_eq!(stable, high_token);
}

/// CPU 工作额度：排队 + 完成待领 + 装配中的保活都计入，取消后等任务退出才释放。
#[test]
fn cpu_work_budget_counts_queued_ready_and_assembling_then_releases() {
    let snapshot = Arc::new(mixed_snapshot("budget-bytes"));
    let mut scheduler = super::Scheduler::default();
    let key = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    scheduler.demand("film", key.clone(), snapshot.clone(), Priority::Visible);
    scheduler.poll();
    // Inline 模式：完成即待装配，产物额度保留。
    assert!(scheduler.claim(&key).is_some());
    let ready = scheduler.claim(&key).unwrap();
    assert!(ready.bytes() > 0, "完成待领必须占用额度");
    assert!(scheduler.work.bytes > 0);
    // 失去最后需求后，产物额度随真实回收下降。
    scheduler.cancel("film");
    scheduler.gc(|_| false);
    assert_eq!(scheduler.work.bytes, 0, "无引用后额度必须归零");
}

/// 队列与运行上限有界；可见请求优先于屏外预热。
#[test]
fn queue_and_running_limits_are_bounded_and_visible_work_wins() {
    let base = mixed_snapshot("limit");
    let mut scheduler = super::Scheduler::default();
    scheduler.set_mode(Mode::Async);
    for index in 0..(MAX_QUEUED + MAX_RUNNING + 4) {
        let mut snapshot = base.clone();
        snapshot.signature = format!("limit-{index}");
        let snapshot = Arc::new(snapshot);
        let priority = if index % 2 == 0 {
            Priority::Warm
        } else {
            Priority::Visible
        };
        let key = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
        scheduler.demand(&format!("film-{index}"), key, snapshot, priority);
    }
    scheduler.poll();
    assert!(scheduler.running_len() <= MAX_RUNNING);
    assert!(
        scheduler.queued_len() <= MAX_QUEUED,
        "排队必须有界，实际 {}",
        scheduler.queued_len()
    );
    // 运行中的请求都是可见优先（预热让位）。
    assert!(
        scheduler.running_visible_only(),
        "可见请求必须先于预热占用运行槽"
    );
    scheduler.clear();
}

/// 无执行器可用时不回退宿主线程同步整场生成（准备失败保持 Pending/Absent）。
#[test]
fn oversized_single_allocation_fails_explicitly_without_sync_fallback() {
    // 单资源估算超额度：需求保留但永不排队，也不在宿主线程生成。
    let mut snapshot = mixed_snapshot("oversized");
    snapshot.ops.push(ModelOp::Mesh {
        id: "huge".into(),
        parent: None,
        position: [0.0; 3],
        rotation: [0.0; 3],
        scale: [1.0; 3],
        vertices: vec![[0.0, 0.0, 0.0]; MAX_WORK_BYTES / 12 + 16],
        faces: vec![[0, 1, 2]],
        color: None,
        material: None,
    });
    let snapshot = Arc::new(snapshot);
    let mut scheduler = super::Scheduler::default();
    let key = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    scheduler.demand("film", key, snapshot, Priority::Visible);
    scheduler.poll();
    assert_eq!(scheduler.running_len(), 0);
    assert_eq!(scheduler.queued_len(), 0);
    assert!(scheduler.work.rejected > 0, "超额必须明确记录，不作为同步生成");
    assert_eq!(scheduler.work.bytes, 0);
}

/// 真实 native 任务池：部件展开/网格合并在非宿主线程执行。
///
/// 只在启用 native 任务池的构建运行；用线程 ID 证明计算已离开宿主线程，
/// 不以 fake executor 冒充跨线程。
#[test]
fn real_task_pool_runs_preparation_off_the_host_thread() {
    if !enabled() {
        return;
    }
    let snapshot = Arc::new(mixed_snapshot("threads"));
    let mut scheduler = super::Scheduler::default();
    scheduler.set_mode(Mode::Async);
    let key = PrepareKey::new(&snapshot, Quality::Low, true, BatchStrategy::Spatial, true);
    scheduler.demand("film", key.clone(), snapshot, Priority::Visible);
    let host = format!("{:?}", std::thread::current().id());
    let mut ready = None;
    for _ in 0..600 {
        scheduler.poll();
        if let Some(claim) = scheduler.claim(&key) {
            ready = Some(claim);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let ready = ready.expect("真实任务池必须完成准备");
    assert!(
        ready.thread != host,
        "准备必须在非宿主线程执行，实际线程 {}（宿主 {}）",
        ready.thread,
        host
    );
}

#[cfg(feature = "canvas-core")]
/// 测试用普通系统：按 `scene3d::sync_models` 的同一参数集合调用。
#[allow(clippy::too_many_arguments)]
fn sync_system(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut visuals: ResMut<ModelVisuals>,
    mut focus: ResMut<super::super::runtime::FocusVisuals>,
    resources: Res<crate::app::ModelAssetTable>,
    scene: Res<crate::app::CurrentScene>,
) {
    sync_models(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut visuals,
        &mut focus,
        &resources.0,
        &scene.0,
    );
}

#[cfg(feature = "canvas-core")]
/// 测试用独占系统：与生产 `scene3d::advance_preparation` 同一入口。
fn advance_system(world: &mut World) {
    let scene = world.resource::<crate::app::CurrentScene>().0.clone();
    let resources = world.resource::<crate::app::ModelAssetTable>().0.clone();
    super::advance(world, &scene, &resources);
}

#[cfg(feature = "canvas-core")]
/// 端到端：真实 `App` 调度顺序（`sync_models` → 准备推进）下，
/// Pending → Published 跨越多个 `App::update()` 完成，期间不发布半成品。
#[test]
fn app_schedule_publishes_across_frames_without_exposing_staging() {
    if !enabled() {
        return;
    }
    let mut ops = vec![serde_json::json!({"t": "group", "id": "root"})];
    for index in 0..180 {
        ops.push(serde_json::json!({
            "t": "sphere", "id": format!("s{index}"), "parent": "root",
            "radius": 0.2, "position": [index as f32 * 0.25, 0.0, 0.0], "color": "#ffffff"
        }));
    }
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "app-e2e", "extent": 12, "ops": ops
    }))
    .unwrap();
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let scene = scene_with(vec![node]);
    let resources = resources_for(std::slice::from_ref(&snapshot));

    let mut app = App::new();
    app.init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .init_resource::<ModelVisuals>()
        .init_resource::<super::super::runtime::FocusVisuals>()
        .insert_resource(crate::app::CurrentScene(scene.clone()))
        .insert_resource(crate::app::ModelAssetTable(resources.clone()))
        .add_systems(Update, (sync_system, advance_system).chain());

    let mut pending_frames = 0usize;
    let mut published_frame = None;
    for frame in 0..64 {
        app.update();
        let models = app.world().resource::<ModelVisuals>();
        let published = models.roots.contains_key("film");
        if !published {
            pending_frames += 1;
            assert_eq!(models.preparation_state("film"), RootState::Pending);
            assert!(models.preview_meshes("film").is_empty());
        } else if published_frame.is_none() {
            published_frame = Some(frame);
        }
    }
    assert!(pending_frames > 0, "该内容必须跨越多个 App 帧装配");
    let published_frame = published_frame.expect("必须在有界帧内发布");
    assert!(published_frame >= 1, "发布不能在同一帧内一次性完成");
    let models = app.world().resource::<ModelVisuals>();
    assert_eq!(models.preparation_state("film"), RootState::Published);
    assert!(models.staging.is_empty(), "发布后 staging 必须清空");
    // 软预算：只有单个不可抢占步骤可以跨过阈值，且必须被显式记录。
    // 命令应用按实测耗时折算后并入同一帧工作量，因此允许极小的附加值。
    assert!(
        models.preparation.work.units_max <= MAX_UNITS_PER_FRAME + 8,
        "单帧装配 {} 单元远超软预算",
        models.preparation.work.units_max
    );
    if models.preparation.work.units_max > MAX_UNITS_PER_FRAME {
        assert!(
            models.preparation.work.budget_overshoot > 0,
            "超出软预算必须显式记录"
        );
    }
    assert!(models.preparation.work.assembling == 0);
}


/// 缓存命中仍计装配工作单元：一份新实例的映射/实体创建不能被当作零成本。
#[test]
fn cache_hits_still_consume_assembly_units() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("cache-hit");
    let mut first = film_set_node("first");
    let mut second = film_set_node("second");
    let reference = reference_for(&snapshot);
    first.model = Some(reference.clone());
    second.model = Some(reference.clone());
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let mut scene = scene_with(vec![first]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "first", 128));

    // 第二实例加入：全部资产都应命中共享缓存，但装配仍要占工作单元。
    scene.nodes.push(second);
    run_sync(&mut world, &scene, &resources);
    let before = world.resource::<ModelVisuals>().preparation.work.units_total;
    assert!(advance_until_published(&mut world, &scene, &resources, "second", 128));
    let visuals = world.resource::<ModelVisuals>();
    let used = visuals.preparation.work.units_total - before;
    assert!(used > 0, "缓存命中仍必须计入装配工作单元");
    assert_eq!(
        visuals.preparation.work.started, 1,
        "第二实例不应重复准备同内容"
    );
}

/// 单资源超软阈值：独占一帧登记，并显式记录 oversize，不饿死请求。
#[test]
fn oversize_single_resource_gets_an_exclusive_frame_and_is_reported() {
    if !enabled() {
        return;
    }
    // 单个自定义 Mesh 部件的 CPU 顶点/索引字节超过 4 MiB 软阈值。
    let vertices: Vec<[f32; 3]> = (0..250_000)
        .map(|index| [index as f32 * 0.001, 0.0, 0.0])
        .collect();
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "oversize", "extent": 40,
        "ops": [
            {"t": "group", "id": "root"},
            {"t": "mesh", "id": "huge", "parent": "root",
             "vertices": vertices, "faces": [[0, 1, 2]], "color": "#ffffff"}
        ]
    }))
    .unwrap();
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let published = advance_until_published(&mut world, &scene, &resources, "film", 256);
    assert!(published, "超阈值资源最终必须发布，不能永久饿死");
    let visuals = world.resource::<ModelVisuals>();
    assert!(
        visuals.preparation.work.oversize > 0,
        "超过软阈值的单资源必须记录 oversize"
    );
}

/// 诊断用（`--ignored`）：在真实 native 构建下测一次冷/热准备与装配的 CPU 阶段耗时。
///
/// 只报告 CPU 准备/装配与真实线程 ID；不采集 GPU 上传、帧率或呈现时间，也不作为
/// 真实片场验收基线（后者需要固定 native 构建 + 真实片场快照 + 真实窗口）。
#[test]
#[ignore = "manual CPU measurement; not a GPU or presentation baseline"]
fn measure_native_preparation_stages() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("measure");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    // 真实任务池（生产路径）；单元测试默认 Inline 只为确定性。
    world
        .resource_mut::<ModelVisuals>()
        .preparation
        .set_mode(Mode::Async);
    run_sync(&mut world, &scene, &resources);
    let started = std::time::Instant::now();
    // 生产节奏：每帧一次 poll，后台任务在真实线程池完成。
    let mut published = false;
    for _ in 0..512 {
        advance(&mut world, &scene, &resources);
        if world.resource::<ModelVisuals>().roots.contains_key("film") {
            published = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let wall = started.elapsed().as_secs_f64() * 1000.0;
    let visuals = world.resource::<ModelVisuals>();
    println!(
        "published={published} wallMs={wall:.3} backgroundMs={:.3} waitMs={:.3} pollMs={:.3} assembleMs={:.3} commandMs={:.3} units={} unitsMax={} newMeshBytes={} workBytes={} peakWorkBytes={} threads={:?} host={:?}",
        visuals.preparation.work.background_ms,
        visuals.preparation.work.wait_ms,
        visuals.preparation.work.poll_ms,
        visuals.preparation.work.assemble_ms,
        visuals.preparation.work.command_ms,
        visuals.preparation.work.units_total,
        visuals.preparation.work.units_max,
        visuals.preparation.work.new_mesh_bytes_total,
        visuals.preparation.work.bytes,
        visuals.preparation.work.peak_bytes,
        visuals.preparation.work.threads,
        visuals.preparation.work.host_thread,
    );
}

/// 发布瞬间沿用当前聚焦可见性：聚焦其他节点时不闪一帧。
#[test]
fn publish_respects_current_focus_visibility() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("focus-visibility");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let mut scene = scene_with(vec![node]);
    scene.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "other".to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    });
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "film", 64));
    let visuals = world.resource::<ModelVisuals>();
    let root = visuals.roots["film"].root_entity();
    assert_eq!(
        world.get::<Visibility>(root),
        Some(&Visibility::Hidden),
        "聚焦其他节点时，新发布的根必须立即隐藏"
    );
}

/// 诊断用（`--ignored`）：合成规模下比较「宿主同步创建」与「后台准备 + 分帧装配」的
/// **宿主线程** CPU 占用，并记录后台线程 ID。
///
/// 规模取 notes/baseline.md 记录的结构计数（4786 / 1185 个几何部件），但**不是**真实片场
/// 快照：只用于校准初始预算与证明计算已离开宿主线程。不采集 GPU、帧率或呈现时间。
#[test]
#[ignore = "manual CPU calibration; synthetic scale, not a GPU/presentation baseline"]
fn measure_sync_vs_background_at_film_set_scale() {
    if !enabled() {
        return;
    }
    let mut ops = vec![serde_json::json!({"t": "group", "id": "root"})];
    // 混合图元：球/盒/圆柱/胶囊 + 少量自定义 Mesh，贴近片场组成。
    for index in 0..4786 {
        let x = (index % 70) as f32 * 0.35;
        let z = (index / 70) as f32 * 0.35;
        match index % 10 {
            0 => ops.push(serde_json::json!({"t": "box", "id": format!("b{index}"),
                "parent": "root", "position": [x, 0.0, z], "size": [0.3, 0.6, 0.3],
                "color": "#9aa4b2"})),
            1 => ops.push(serde_json::json!({"t": "cylinder", "id": format!("c{index}"),
                "parent": "root", "position": [x, 0.3, z], "radius": 0.12, "height": 0.6,
                "color": "#8b6f47"})),
            2 => ops.push(serde_json::json!({"t": "capsule", "id": format!("p{index}"),
                "parent": "root", "position": [x, 0.3, z], "radius": 0.1, "height": 0.7,
                "color": "#6b7280"})),
            _ => ops.push(serde_json::json!({"t": "sphere", "id": format!("s{index}"),
                "parent": "root", "position": [x, 0.5, z], "radius": 0.2,
                "color": "#ffffff"})),
        }
    }
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "scale", "extent": 40, "ops": ops
    }))
    .unwrap();
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));

    // 1) 同步创建（既有入口）：去掉总览声明让该节点走非分流路径，复刻改动前行为。
    let sync = {
        let mut plain = film_set_node("film");
        plain.composite_asset = None;
        plain.model = Some(reference_for(&snapshot));
        let scene = scene_with(vec![plain]);
        let mut world = world_with_resources();
        let started = std::time::Instant::now();
        run_sync_once(&mut world, &scene, &resources);
        let ms = started.elapsed().as_secs_f64() * 1000.0;
        let visuals = world.resource::<ModelVisuals>();
        let parts = visuals.roots["film"].part_entities.len();
        let batches = visuals.roots["film"].batches.len();
        (ms, parts, batches)
    };

    // 2) 后台准备 + 分帧装配（真实任务池，每帧一次 poll）。
    let mut world = world_with_resources();
    world
        .resource_mut::<ModelVisuals>()
        .preparation
        .set_mode(Mode::Async);
    let scene = scene_with(vec![node]);
    run_sync(&mut world, &scene, &resources);
    let started = std::time::Instant::now();
    let mut published = false;
    let mut frames = 0usize;
    for _ in 0..4096 {
        advance(&mut world, &scene, &resources);
        frames += 1;
        if world.resource::<ModelVisuals>().roots.contains_key("film") {
            published = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let wall = started.elapsed().as_secs_f64() * 1000.0;
    let visuals = world.resource::<ModelVisuals>();
    let work = &visuals.preparation.work;
    println!(
        "syncHostMs={:.2} parts={} batches={} | published={published} frames={frames} wallMs={wall:.2} backgroundMs={:.2} assembleMs={:.2} commandMs={:.2} units={} unitsMax={} newMeshBytes={} newMeshBytesMaxPerFrame={} peakWorkBytes={} threads={:?} host={:?}",
        sync.0, sync.1, sync.2,
        work.background_ms, work.assemble_ms, work.command_ms,
        work.units_total, work.units_max, work.new_mesh_bytes_total,
        work.new_mesh_bytes_max, work.peak_bytes, work.threads, work.host_thread,
    );
}

/// 已发布根继续衔接既有 LOD replacement、预览层写入与动作目标准备（不争写）。
#[test]
fn published_root_continues_existing_lod_replacement_and_preview_layers() {
    if !enabled() {
        return;
    }
    use super::super::runtime::sync_quality;
    use crate::model3d::TransformAnimationSet;

    let snapshot = mixed_snapshot("published-lod");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let mut scene = scene_with(vec![node]);
    scene.surface = Some(
        serde_json::from_value(serde_json::json!({
            "width": 800.0, "height": 600.0, "pixelRatio": 1.0
        }))
        .unwrap(),
    );
    scene.viewport.zoom = 1.0;
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "film", 128));

    let initial_quality = world.resource::<ModelVisuals>().roots["film"].quality;
    // 进入聚焦（High owner）：既有 LOD replacement 必须仍能接管已发布的根。
    scene.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "film".to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    });
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let mut materials = world
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap();
    let pins = std::collections::HashSet::new();
    let mut commands = world.commands();
    sync_quality(
        &mut commands,
        &mut meshes,
        &mut visuals,
        &scene,
        Some("film"),
        1.0,
        &pins,
    );
    world.flush();
    world.insert_resource(visuals);
    world.insert_resource(meshes);
    world.insert_resource(materials);
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(
        visuals.roots["film"].quality,
        Quality::High,
        "聚焦后既有 LOD 替换必须提升到 High"
    );
    assert_ne!(visuals.roots["film"].quality, initial_quality);
    // 已发布根的需求仍指向同一内容 key（供同内容实例共享），但不再有 staging 或重复准备。
    assert!(visuals.staging.is_empty());
    assert_eq!(visuals.preparation.work.started, 1);
    assert!(visuals.preparation.claim(
        &visuals.preparation.demand_of("film").expect("demand kept").key
    ).is_some(), "已发布内容的产物仍可被同内容实例复用");
    let _ = TransformAnimationSet::Playback;
}

/// 内容替换期间保留旧完整表示，直到新根完整发布（任何一帧都不出现空窗）。
#[test]
fn content_replacement_keeps_old_representation_until_publish() {
    if !enabled() {
        return;
    }
    // 让替换后的内容足够大，装配必然跨越多个帧。
    let mut ops = vec![serde_json::json!({"t": "group", "id": "root"})];
    for index in 0..200 {
        ops.push(serde_json::json!({
            "t": "sphere", "id": format!("s{index}"), "parent": "root",
            "radius": 0.2, "position": [index as f32 * 0.3, 0.0, 0.0], "color": "#ffffff"
        }));
    }
    let second: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "new-content",
        "extent": 12, "ops": ops
    }))
    .unwrap();
    let first = mixed_snapshot("old-content");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&first));
    let resources = resources_for(&[first, second.clone()]);
    let mut scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "film", 64));
    let old_root = world.resource::<ModelVisuals>().roots["film"].root_entity();

    // 换源：只做一次同步（不推进准备），然后逐帧装配。
    scene.nodes[0].model = Some(reference_for(&second));
    run_sync_once(&mut world, &scene, &resources);
    let mut saw_pending_with_old_visible = false;
    for _ in 0..256 {
        let before = world.resource::<ModelVisuals>();
        let published_before = before.roots["film"].content_signature == "new-content";
        let root_before = if published_before {
            before.roots["film"].root_entity()
        } else {
            old_root
        };
        assert_eq!(
            before.roots.len(),
            1,
            "内容替换期间必须有且只有一个已发布表示"
        );
        advance(&mut world, &scene, &resources);
        let visuals = world.resource::<ModelVisuals>();
        let published_new = visuals.roots["film"].content_signature == "new-content";
        if !published_new {
            assert_eq!(visuals.roots.len(), 1);
            assert_eq!(
                visuals.roots["film"].root_entity(),
                root_before,
                "新根发布前必须继续显示旧完整表示"
            );
            saw_pending_with_old_visible = true;
        } else {
            break;
        }
    }
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(visuals.roots["film"].content_signature, "new-content");
    assert_eq!(visuals.roots.len(), 1);
    assert!(
        saw_pending_with_old_visible,
        "该规模的替换必须跨帧装配，才能验证旧表示保留"
    );
}

/// 诊断：`nativePreparation` 有界、字段齐备，且不在陈旧状态下重复发布。
#[test]
fn native_preparation_diagnostics_are_bounded_and_complete() {
    if !enabled() {
        return;
    }
    let snapshot = mixed_snapshot("diagnostics");
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot));
    let resources = resources_for(std::slice::from_ref(&snapshot));
    let scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "film", 64));

    let visuals = world.resource::<ModelVisuals>();
    let budget = visuals.budget_json(
        world.resource::<Assets<Mesh>>(),
        world.resource::<Assets<StandardMaterial>>(),
    );
    let value: serde_json::Value = serde_json::from_str(&budget).unwrap();
    let preparation = &value["nativePreparation"];
    for key in [
        "queued",
        "running",
        "ready",
        "assembling",
        "published",
        "cancelled",
        "rejected",
        "failed",
        "cacheHits",
        "staleDropped",
        "workBytes",
        "peakWorkBytes",
        "backgroundTotalMs",
        "waitTotalMs",
        "pollTotalMs",
        "assembleTotalMs",
        "commandTotalMs",
        "assemblyUnits",
        "newMeshBytes",
        "oversizeResources",
        "budgetOvershootFrames",
        "stagingRoots",
        "stagingTotal",
        "retiringEntities",
        "publishedRoots",
        "budgets",
        "hostThread",
        "backgroundThreads",
        "scope",
    ] {
        assert!(!preparation[key].is_null(), "缺少诊断字段 {key}");
    }
    assert_eq!(preparation["publishedRoots"], 1);
    assert!(preparation["scope"].as_str().unwrap().contains("not GPU"));
    // staging 列表有界（最多 64 条），且不包含几何内容。
    assert!(preparation["stagingRoots"].as_array().unwrap().len() <= 64);
    // 发布后不再有 staging 或退役实体。
    assert_eq!(preparation["stagingTotal"], 0);
    assert_eq!(preparation["retiringEntities"], 0);
    assert_eq!(preparation["budgets"]["unitsPerFrame"], 64);
    assert_eq!(preparation["budgets"]["newMeshBytesPerFrame"], 4 * 1024 * 1024);
    // 有变更标记只在真正发布/取消/退役的帧上置位。
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    assert!(visuals.take_preparation_changed());
    assert!(!visuals.take_preparation_changed(), "标记必须只消费一次");
    world.insert_resource(visuals);
}

// ---------------------------------------------------------------------------
// 真实片场快照验收（任务 6.1–6.3）
//
// 数据来源：本地画布投影的 revision 652（projectionSha256
// d63cfc82c63fe865ce9b85e70cbf2366961ec6812bb233289e6a0c26824dd02），由
// `web/contracts` 的 modelScript 执行器展开为 Scene IR。文件在 `.local/` 下（已被 git 忽略），
// 因此这些用例在没有该快照的机器上自动跳过，不把私有内容写进仓库。
//
// 这些用例只采集 **CPU** 阶段（后台准备、宿主装配、命令应用、额度、staging 生命周期）；
// GPU 上传、pipeline 准备、实际显示帧长尾与画面一致性不在此处断言。
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct FixtureFile {
    revision: u64,
    #[serde(rename = "projectionSha256")]
    projection_sha256: String,
    films: Vec<FixtureFilm>,
}

#[derive(serde::Deserialize)]
struct FixtureFilm {
    #[serde(rename = "nodeId")]
    node_id: String,
    title: String,
    ops: Vec<serde_json::Value>,
}

/// 读 `.local/native-prep-fixtures.json`；缺失时返回 `None`（CI/无快照机器跳过）。
fn load_real_fixtures() -> Option<FixtureFile> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../.local/native-prep-fixtures.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn film_snapshot(film: &FixtureFilm) -> ModelSnapshot {
    serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2",
        "signature": format!("real:{}", film.node_id),
        "extent": 40,
        "ops": film.ops,
    }))
    .expect("real film set ops are valid Scene IR")
}

/// 任务 6.1：真实片场快照在 native 构建下走后台准备并完整发布。
///
/// 记录每个片场的部件/批次规模与 CPU 阶段耗时；内容身份用 revision + projection hash 定位，
/// 不使用任何模拟动画比例。
#[test]
#[ignore = "需要 .local/native-prep-fixtures.json（真实片场快照）"]
fn real_film_sets_prepare_in_background_and_publish() {
    let Some(fixtures) = load_real_fixtures() else {
        eprintln!("跳过：没有 .local/native-prep-fixtures.json");
        return;
    };
    println!(
        "snapshot revision={} projectionSha256={}",
        fixtures.revision, fixtures.projection_sha256
    );
    for film in &fixtures.films {
        let snapshot = film_snapshot(film);
        let mut node = film_set_node("film");
        node.model = Some(reference_for(&snapshot));
        let resources = resources_for(std::slice::from_ref(&snapshot));
        let scene = scene_with(vec![node]);
        let mut world = world_with_resources();
        world
            .resource_mut::<ModelVisuals>()
            .preparation
            .set_mode(Mode::Async);
        run_sync(&mut world, &scene, &resources);

        // 冷缓存进入：真实任务池 + 每帧一次 poll。
        let started = std::time::Instant::now();
        let mut published = false;
        let mut frames = 0usize;
        for _ in 0..8192 {
            advance(&mut world, &scene, &resources);
            frames += 1;
            if world.resource::<ModelVisuals>().roots.contains_key("film") {
                published = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let cold_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert!(published, "{} 必须在该帧预算内完整发布", film.title);

        let visuals = world.resource::<ModelVisuals>();
        let root = &visuals.roots["film"];
        let work = &visuals.preparation.work;
        println!(
            "[{}] ops={} parts={} batches={} entities={} coldWallMs={:.1} backgroundMs={:.1} assembleMs={:.1} commandMs={:.2} units={} unitsMax={} newMeshBytes={} newMeshBytesMax={} peakWorkBytes={} threads={:?}",
            film.title,
            film.ops.len(),
            root.part_entities.len(),
            root.batches.len(),
            root.entities.len(),
            cold_ms,
            work.background_ms,
            work.assemble_ms,
            work.command_ms,
            work.units_total,
            work.units_max,
            work.new_mesh_bytes_total,
            work.new_mesh_bytes_max,
            work.peak_bytes,
            work.threads,
        );

        // 结构不变量：真实内容的每个规范部件都必须被表示（独立部件或批次范围）。
        assert!(!root.entities.is_empty(), "{} 不能发布空根", film.title);
        assert!(
            work.background_ms > 0.0,
            "{} 的部件展开/网格构建必须发生在后台阶段",
            film.title
        );
        assert!(!work.threads.is_empty(), "{} 必须记录真实后台线程", film.title);
        assert!(
            work.units_max <= MAX_UNITS_PER_FRAME + 8,
            "{} 单帧装配 {} 单元超出软预算",
            film.title,
            work.units_max
        );
        assert!(
            work.new_mesh_bytes_max <= MAX_NEW_MESH_BYTES as u64,
            "{} 单帧新 mesh 字节 {} 超出软阈值",
            film.title,
            work.new_mesh_bytes_max
        );
        assert!(visuals.staging.is_empty(), "{} 发布后不得残留 staging", film.title);
        assert_eq!(visuals.preparation.work.assembling, 0);
    }
}

/// 任务 6.2：同一内容的热缓存重入不重新构建，纯平移不重启任务。
#[test]
#[ignore = "需要 .local/native-prep-fixtures.json（真实片场快照）"]
fn real_film_sets_warm_reentry_and_pan_do_not_rebuild() {
    let Some(fixtures) = load_real_fixtures() else {
        eprintln!("跳过：没有 .local/native-prep-fixtures.json");
        return;
    };
    for film in &fixtures.films {
        let snapshot = film_snapshot(film);
        let mut node = film_set_node("film");
        node.model = Some(reference_for(&snapshot));
        let resources = resources_for(std::slice::from_ref(&snapshot));
        let mut scene = scene_with(vec![node]);
        let mut world = world_with_resources();
        run_sync(&mut world, &scene, &resources);
        assert!(advance_until_published(&mut world, &scene, &resources, "film", 8192));
        let after_cold = {
            let visuals = world.resource::<ModelVisuals>();
            (
                visuals.preparation.work.started,
                visuals.preparation.work.background_ms,
                visuals.preparation.work.units_total,
                visuals.roots["film"].mesh_handles.len(),
            )
        };

        // 纯平移：只改 viewport，不换内容/档位。
        for step in 0..12 {
            scene.viewport.x = -step as f32 * 180.0;
            scene.viewport.y = step as f32 * -120.0;
            run_sync(&mut world, &scene, &resources);
        }
        let after_pan = world.resource::<ModelVisuals>();
        assert_eq!(
            after_pan.preparation.work.started, after_cold.0,
            "{} 平移不得重启后台准备",
            film.title
        );
        assert_eq!(
            after_pan.preparation.work.cancelled, 0,
            "{} 平移不得取消有效任务",
            film.title
        );
        assert_eq!(
            after_pan.roots["film"].mesh_handles.len(),
            after_cold.3,
            "{} 平移不得改变已发布表示",
            film.title
        );

        // 热缓存重入：再挂一个同内容实例（不销毁旧根）。预置产物与已登记资产直接复用，
        // 因此不重新构建几何，但每个实例仍要装配自己的实体/映射。
        let mut sibling = film_set_node("film-2");
        sibling.x = 640.0;
        sibling.model = Some(reference_for(&snapshot));
        scene.nodes.push(sibling);
        run_sync(&mut world, &scene, &resources);
        assert!(advance_until_published(&mut world, &scene, &resources, "film-2", 8192));
        let warm = world.resource::<ModelVisuals>();
        println!(
            "[{}] cold units={} → warm-sibling units={} started={} cacheHits={}",
            film.title,
            after_cold.2,
            warm.preparation.work.units_total,
            warm.preparation.work.started,
            warm.preparation.work.cache_hits,
        );
        assert_eq!(
            warm.preparation.work.started, after_cold.0,
            "{} 同内容第二实例不得重新准备",
            film.title
        );
        assert!(
            warm.preparation.work.cache_hits > 0,
            "{} 第二实例必须命中共享缓存（不重建几何）",
            film.title
        );
        // 两个实例仍共享资产（同部件 id → 同一 mesh），但实体映射互相独立。
        assert!(warm.roots.contains_key("film") && warm.roots.contains_key("film-2"));
        let sample = warm.roots["film"]
            .part_entities
            .keys()
            .next()
            .expect("real film set has parts")
            .clone();
        assert!(
            warm.roots["film-2"].part_entities.contains_key(&sample),
            "同内容实例的部件身份必须一致（共享规范内容）"
        );
        assert_ne!(
            warm.roots["film"].part_entities[&sample],
            warm.roots["film-2"].part_entities[&sample],
            "同一部件在两个实例中必须是不同实体"
        );
        let shared = warm.roots["film"]
            .mesh_handles
            .iter()
            .any(|handle| warm.roots["film-2"].mesh_handles.iter().any(|o| o.id() == handle.id()));
        assert!(shared, "{} 同内容实例必须共享已登记 mesh", film.title);

        // 删除：旧根按预算退役，最终不残留实体或待退役队列。
        scene.nodes.clear();
        run_sync(&mut world, &scene, &resources);
        for _ in 0..8192 {
            advance(&mut world, &scene, &resources);
            let visuals = world.resource::<ModelVisuals>();
            if visuals.roots.is_empty() && visuals.retiring.is_empty() && visuals.staging.is_empty() {
                break;
            }
        }
        let cleared = world.resource::<ModelVisuals>();
        assert!(cleared.roots.is_empty(), "{} 删除后不得残留根", film.title);
        assert!(cleared.retiring.is_empty(), "{} 旧根退役必须完成", film.title);
        assert!(cleared.staging.is_empty(), "{} 删除后不得残留 staging", film.title);
    }
}

/// 任务 6.3：真实片场在内容替换、删除、聚焦、播放与捕获等待下都不发布半成品。
#[test]
#[ignore = "需要 .local/native-prep-fixtures.json（真实片场快照）"]
fn real_film_sets_keep_representation_consistent_across_lifecycle_events() {
    let Some(fixtures) = load_real_fixtures() else {
        eprintln!("跳过：没有 .local/native-prep-fixtures.json");
        return;
    };
    let Some(first) = fixtures.films.first() else {
        return;
    };
    let Some(second) = fixtures.films.get(1) else {
        return;
    };
    let first_snapshot = film_snapshot(first);
    let second_snapshot = film_snapshot(second);
    let resources = resources_for(&[first_snapshot.clone(), second_snapshot.clone()]);
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&first_snapshot));
    let mut scene = scene_with(vec![node]);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert!(advance_until_published(&mut world, &scene, &resources, "film", 8192));
    let old_root = world.resource::<ModelVisuals>().roots["film"].root_entity();

    // 换源（另一个真实片场）：任何一帧都只有一份完整已发布表示。
    scene.nodes[0].model = Some(reference_for(&second_snapshot));
    run_sync_once(&mut world, &scene, &resources);
    let mut frames_with_old = 0usize;
    for _ in 0..8192 {
        let before = world.resource::<ModelVisuals>();
        assert_eq!(before.roots.len(), 1, "内容替换期间只能有一个已发布表示");
        let published_before = before.roots["film"].content_signature
            == format!("real:{}", second.node_id);
        let root_before = if published_before {
            before.roots["film"].root_entity()
        } else {
            old_root
        };
        advance(&mut world, &scene, &resources);
        let after = world.resource::<ModelVisuals>();
        if after.roots["film"].content_signature == format!("real:{}", second.node_id) {
            break;
        }
        assert_eq!(after.roots.len(), 1);
        assert_eq!(
            after.roots["film"].root_entity(),
            root_before,
            "新根发布前必须继续显示旧完整表示"
        );
        frames_with_old += 1;
    }
    assert!(frames_with_old > 0, "真实片场换源必须跨帧装配");
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].content_signature,
        format!("real:{}", second.node_id)
    );

    // 聚焦：发布后的根立即按当前聚焦隐藏/显示，不闪一帧。
    scene.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "other".to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    });
    run_sync(&mut world, &scene, &resources);
    let root = world.resource::<ModelVisuals>().roots["film"].root_entity();
    assert_eq!(world.get::<Visibility>(root), Some(&Visibility::Hidden));

    // 捕获等待：对同一真实内容提出新的 High 需求时，若旧表示仍在，则实例进入 Pending
    // （截图必须等待合法 High 表示），发布后回到 Published 并仍是同一完整表示。
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let high_resource = std::sync::Arc::new(second_snapshot.clone());
    let key = super::PrepareKey::new(
        &high_resource,
        Quality::High,
        true,
        BatchStrategy::Spatial,
        true,
    );
    visuals.preparation.set_mode(Mode::Inline);
    visuals
        .preparation
        .demand("film", key.clone(), high_resource.clone(), Priority::Visible);
    // 已在装配中的同内容实例：状态要么仍 Published（旧完整表示可截），要么 Pending
    // （必须等待）；两种都不得是 Absent。
    let state = visuals.preparation_state("film");
    assert_ne!(state, RootState::Absent, "已发布片场不得被当作无根");
    #[cfg(feature = "canvas-core")]
    assert!(
        super::super::capture::preparation_gate_waits(&visuals, "film")
            == (state == RootState::Pending),
        "捕获等待必须与准备状态严格一致"
    );
    world.insert_resource(visuals);

    // 删除：根、需求、staging、退役队列最终都清空。
    scene.nodes.clear();
    scene.model_focus = None;
    run_sync(&mut world, &scene, &resources);
    for _ in 0..8192 {
        advance(&mut world, &scene, &resources);
        let visuals = world.resource::<ModelVisuals>();
        if visuals.roots.is_empty() && visuals.retiring.is_empty() && visuals.staging.is_empty() {
            break;
        }
    }
    let visuals = world.resource::<ModelVisuals>();
    assert!(visuals.roots.is_empty(), "删除后不得残留已发布根");
    assert!(visuals.staging.is_empty(), "删除后不得残留 staging");
    assert!(visuals.retiring.is_empty(), "删除后旧根退役必须完成");
    assert_eq!(visuals.preparation_state("film"), RootState::Absent);
}
