//! model3d adapter 单元测试入口（change: refactor-bevy-rust-file-size，任务 4.1 / design D4）。
//!
//! 由 `model3d/mod.rs` 内联测试移动而来，断言与覆盖完全保留；再按主题拆分为子模块。
//! 子模块通过 `super::super::{...}` 访问 model3d 的实现细节、通过 `super::*` 使用本模块的
//! world/场景 helper。

mod batching;
mod ownership;
#[cfg(feature = "explicit-instancing")]
mod instancing;
mod lifecycle;
mod lod;
mod motion_playback;
mod playback;
mod playback_representation;
mod units;

use std::collections::HashMap;
use std::sync::Arc;

use bevy::prelude::*;

use super::runtime::{FocusVisuals, ModelAssets, ModelVisuals, sync_models};
use crate::protocol::{GraphNode, ModelPlacement, ModelReference, ModelSnapshot, Scene};

/// 测试用共享世界实例（同一 nodeId 得到稳定实例身份）。
pub(super) fn world_instance_for(node_id: &str) -> crate::protocol::WorldInstance {
    serde_json::from_value(serde_json::json!({
        "kind": "world-instance",
        "version": "shared-world-v1",
        "instanceId": format!("instance-{node_id}"),
        "transform": {
            "version": "shared-world-v1",
            "position": {"u": 0.0, "v": 0.0, "h": 0.0},
            "rotation": [0.0, 0.0, 0.0, 1.0],
            "scale": 1.0
        }
    }))
    .unwrap()
}

/// 让节点成为受支持的共享世界模型（世界根只读实例 transform）。
pub(super) fn with_world_instance(node: &mut GraphNode) {
    if node.shared_world_instance.is_none() {
        let instance = world_instance_for(&node.id);
        node.shared_world_instance = Some(instance);
    }
}

/// 用给定节点与可选模型引用构造单节点场景。
pub(super) fn scene_with(node: &GraphNode, model: Option<ModelReference>) -> Scene {
    let mut node = node.clone();
    with_world_instance(&mut node);
    node.model = model;
    Scene {
        nodes: vec![node],
        ..Scene::default()
    }
}

/// 由内容快照构造节点模型引用（resource_key = sceneVersion:signature）。
///
/// `modelPlacement` 已不再进入场景 wire；参数只为兼容既有夹具签名。
pub(super) fn reference_for(snapshot: &ModelSnapshot, _placement: ModelPlacement) -> ModelReference {
    let scene_version = snapshot.scene_version.clone();
    ModelReference { ground_anchor_local: None, part_rotations: None,
        resource_key: format!(
            "{}:{}",
            scene_version.clone().unwrap_or_default(),
            snapshot.signature
        ),
        scene_version,
        signature: snapshot.signature.clone(),
    }
}

/// 构造注册资源表（resource_key → Arc<ModelSnapshot>）。
pub(super) fn resource_table(
    entries: impl IntoIterator<Item = (String, ModelSnapshot)>,
) -> ModelAssets {
    entries
        .into_iter()
        .map(|(key, snapshot)| (key, Arc::new(snapshot)))
        .collect::<HashMap<_, _>>()
}

/// 在裸 `World` 上执行一次 `sync_models`，并把 native 后台准备推进到发布。
///
/// 生产环境准备是每帧异步推进的；测试断言的是**已发布**表示，因此这里显式把 staging
/// 与旧根退役推进到结束（有界轮数，避免测试挂死）。
pub(super) fn run_sync(world: &mut World, scene: &Scene, resources: &ModelAssets) {
    let mut visuals = world.remove_resource::<ModelVisuals>().unwrap();
    let mut focus = world.remove_resource::<FocusVisuals>().unwrap_or_default();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let mut materials = world.remove_resource::<Assets<StandardMaterial>>().unwrap();
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
    settle_preparation(world, scene, resources);
}

/// 物化为空操作：模型在同步路径上直接发布。
pub(super) fn settle_preparation(_world: &mut World, _scene: &Scene, _resources: &ModelAssets) {}

/// 初始化 world-based 测试所需的资源。
pub(super) fn world_with_resources() -> World {
    let mut world = World::new();
    world.init_resource::<Assets<Mesh>>();
    world.init_resource::<Assets<StandardMaterial>>();
    world.init_resource::<ModelVisuals>();
    world.init_resource::<FocusVisuals>();
    world
}

/// 从实体组件派生本帧透明度实例视图（`OpacityMaterials` 只保留回收策略）。
pub(super) fn opacity_instances(
    world: &mut World,
) -> HashMap<Entity, crate::canvas_ecs::components::OpacityMaterialInstance> {
    let mut query = world
        .query::<(Entity, &crate::canvas_ecs::components::OpacityMaterialInstance)>();
    query
        .iter(world)
        .map(|(entity, instance)| (entity, instance.clone()))
        .collect()
}

mod demand;
