//! model3d adapter 单元测试入口（change: refactor-bevy-rust-file-size，任务 4.1 / design D4）。
//!
//! 由 `model3d/mod.rs` 内联测试移动而来，断言与覆盖完全保留；再按主题拆分为子模块。
//! 子模块通过 `super::super::{...}` 访问 model3d 的实现细节、通过 `super::*` 使用本模块的
//! world/场景 helper。

mod lifecycle;
mod lod;
mod overview_lod;
mod batching;
mod ownership;
#[cfg(feature = "explicit-instancing")]
mod instancing;
mod playback;
mod motion_playback;
mod playback_representation;
mod filmset_camera;
mod units;
mod film_set_layout;

use std::collections::HashMap;
use std::sync::Arc;

use bevy::prelude::*;

use super::runtime::{FocusVisuals, ModelAssets, ModelVisuals, sync_models};
use crate::protocol::{GraphNode, ModelPlacement, ModelReference, ModelSnapshot, Scene};

/// 用给定节点与可选模型引用构造单节点场景。
pub(super) fn scene_with(node: &GraphNode, model: Option<ModelReference>) -> Scene {
    let mut node = node.clone();
    node.model = model;
    Scene {
        nodes: vec![node],
        ..Scene::default()
    }
}

/// 由内容快照 + placement 构造节点模型引用（resource_key = sceneVersion:signature）。
pub(super) fn reference_for(snapshot: &ModelSnapshot, placement: ModelPlacement) -> ModelReference {
    let scene_version = snapshot.scene_version.clone();
    ModelReference {
        resource_key: format!(
            "{}:{}",
            scene_version.clone().unwrap_or_default(),
            snapshot.signature
        ),
        scene_version,
        signature: snapshot.signature.clone(),
        placement,
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
    settle_preparation(world, scene, resources);
}

/// 把 native 后台准备与预算化装配推进到静止（发布完成、旧根退役完成）。
pub(super) fn settle_preparation(world: &mut World, scene: &Scene, resources: &ModelAssets) {
    for _ in 0..512 {
        let changed = super::preparation::advance_for_test(world, scene, resources);
        let idle = {
            let visuals = world.resource::<ModelVisuals>();
            visuals.staging.is_empty()
                && visuals.retiring.is_empty()
                && visuals.preparation.is_empty()
        };
        if idle && !changed {
            break;
        }
    }
}

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
