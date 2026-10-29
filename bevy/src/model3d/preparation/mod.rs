//! Native 片场准备管线对外入口（change: 2026-10-18-prepare-native-film-sets-in-background，
//! design D1/D6）。
//!
//! 仅 `native-canvas` 且显式声明总览 primitive LOD 的根进入本管线；其它 target/feature 与
//! 普通模型卡片继续走既有同步创建入口。`ModelVisuals::roots` 只包含**已发布**根，因此
//! 查询、预览、捕获与编辑都不会看到 staging 实体。

// 非 native 构建下分流关闭，这些实现只被测试或诊断引用；显式放行以免把 feature gate
// 撒到每个函数上（与 `model3d` 其它 adapter 的既有做法一致）。
#![cfg_attr(not(feature = "native-canvas"), allow(dead_code))]

mod assembly;
mod prepared;
mod schedule;

#[cfg(test)]
mod tests;

pub use assembly::Staging;
pub use assembly::{MAX_NEW_MESH_BYTES, MAX_UNITS_PER_FRAME, SOFT_STOP_MS};
pub use schedule::{PrepareKey, Priority, Scheduler};

#[cfg(test)]
#[allow(unused_imports)]
pub use schedule::{MAX_QUEUED, MAX_RUNNING, MAX_WORK_BYTES, Mode, PreparationWork};

use std::sync::Arc;

use bevy::prelude::*;

use crate::protocol::{GraphNode, ModelSnapshot, Scene};

use super::quality::{self, Quality};
use super::runtime::{ModelAssets, ModelVisuals};

/// 本运行配置是否启用 native 后台准备（design D1）。
///
/// 必须按 target/feature 明确分流：只有原生画布具备真实多线程任务池；浏览器 WASM、
/// 原生离屏渲染与录制 worker 保持既有同步创建行为。
pub(crate) const fn enabled() -> bool {
    cfg!(feature = "native-canvas")
}

/// 该根是否应进入后台准备管线（native + 显式总览策略）。
pub(super) fn eligible(node: &GraphNode) -> bool {
    enabled() && quality::has_overview_lod_declaration(node)
}

/// 实例的准备状态（对消费者可见的事实，不含 staging 实体）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RootState {
    /// 尚未请求（不在 demand 内，也没有根）。
    Absent,
    /// 正在后台准备或分帧装配：**不是**合法空场，消费者必须等待。
    Pending,
    /// 已发布完整表示（CPU 世界），GPU 就绪仍由各自门禁判定。
    Published,
}

/// 一次需求解析的优先级输入。
pub(super) struct PriorityInput {
    /// 显式高质量消费者（选中/聚焦/编辑/捕获/预览）或可见根。
    pub(super) visible: bool,
}

impl PriorityInput {
    pub(super) fn priority(&self) -> Priority {
        if self.visible {
            Priority::Visible
        } else {
            Priority::Warm
        }
    }
}

/// 为需要创建/替换的根登记需求；返回该实例是否需要等待新表示。
///
/// `quality` 是本次要准备的目标档位；仅平移、播放时钟或相同内容的新 generation 不改变
/// 内容/档位/策略 key，因此不会重启任务（design D3）。
pub(super) fn request(
    models: &mut ModelVisuals,
    node: &GraphNode,
    resource: &Arc<ModelSnapshot>,
    quality: Quality,
    batched: bool,
    priority: PriorityInput,
) -> RootState {
    let key = PrepareKey::new(
        resource,
        quality,
        batched,
        models.batching_strategy,
        quality::has_overview_lod_declaration(node),
    );
    // 需求按实例保留：它同时标识该实例当前需要的准备 key。同内容已发布时不再排队
    // （`enqueue` 会跳过已发布/已待领的 key），因此保留需求不会造成重复准备，却能让
    // 同内容的新实例共享同一份已完成产物与已登记资产（design D3）。
    let key_for_demand = key.clone();
    models.preparation.demand(
        &node.id,
        key_for_demand,
        resource.clone(),
        priority.priority(),
    );
    match models.roots.get(&node.id) {
        Some(root)
            if root.content_signature == resource.signature
                && Arc::ptr_eq(&root.resource, resource)
                && root.batched == batched =>
        {
            RootState::Published
        }
        _ => RootState::Pending,
    }
}

/// 当前状态：已发布根优先于待准备需求。
pub(crate) fn state(models: &ModelVisuals, node: &str) -> RootState {
    if models.roots.contains_key(node) {
        RootState::Published
    } else if models.staging.contains_key(node) || models.preparation.demand_of(node).is_some() {
        RootState::Pending
    } else {
        RootState::Absent
    }
}

/// 该实例是否处于准备态（消费者等待语义）。
///
/// 供模型预览、镜头预览与捕获使用：Pending **不是**合法空场，不能发布灰底或把首次呈现
/// 当作已完成；它们继续沿用既有超时与公平调度等待发布。
pub(crate) fn is_pending(models: &ModelVisuals, node: &str) -> bool {
    state(models, node) == RootState::Pending
}

/// 测试辅助：直接推进一帧（与生产 `advance` 同一实现）。
#[cfg(test)]
pub(crate) fn advance_for_test(world: &mut World, scene: &Scene, resources: &ModelAssets) -> bool {
    advance(world, scene, resources)
}

/// 后台 poll + 预算化装配（每帧一次，独占宿主线程）。
pub(crate) fn advance(world: &mut World, scene: &Scene, resources: &ModelAssets) -> bool {
    if !enabled() {
        return false;
    }

    let mut models = world.remove_resource::<ModelVisuals>().unwrap_or_default();
    let changed = assembly::assemble(world, &mut models, scene, resources);
    world.insert_resource(models);
    changed
}
