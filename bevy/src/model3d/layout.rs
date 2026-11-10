//! 根单位、锚点与 transform 计算
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2；
//!  change: 2026-11-10-remove-legacy-model-card-nodes —— 世界根只读 `sharedWorldInstance`）。

use bevy::prelude::*;

use crate::protocol::{GraphNode, ModelSnapshot};

use super::scene::{self, ModelAabb};

/// 场景单位（= 1 米）→ 画布世界单位的固定换算（change:
/// 2026-10-31-render-models-at-absolute-metric-scale）。
///
/// 与 TS `CANVAS_UNITS_PER_METER` 同值。模型尺寸不再按自身包围盒归一化：1.7 m 的人恒为约
/// 109 画布单位高，20 m 的楼恒为约 1280，且与模型在世界原点附近的位置无关。
pub(crate) const CANVAS_UNITS_PER_METER: f32 = 64.0;

/// 由已注册资源与节点派生模型**世界** AABB（含世界实例根姿态）
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2；
///  change: make-shot-framing-zoom-invariant，任务 2.1 / 3.1：固定世界，不读取 viewport/surface）。
///
/// 普通画布 picking 与展示共用同一 `model3d` 事实源：局部 AABB 由 `derive_aabb` 保留在
/// 资源表中，这里只应用实例根姿态，不重新遍历 mesh。没有 `sharedWorldInstance` 的旧卡片节点
/// 不产生模型根，因此也没有世界 AABB。
pub(crate) fn model_world_aabb_for_node(
    model: &ModelSnapshot,
    node: &GraphNode,
) -> Option<ModelAabb> {
    let (local, anchor) = model_bounds_for_node(model, node)?;
    Some(ModelAabb::new(
        [
            local.min[0] + anchor.x,
            local.min[1] + anchor.y,
            local.min[2] + anchor.z,
        ],
        [
            local.max[0] + anchor.x,
            local.max[1] + anchor.y,
            local.max[2] + anchor.z,
        ],
    ))
}

/// Subject-local box and world anchor stay separate so translation cannot round
/// dimensions used by preview framing and LOD/cache selection.
pub(crate) fn model_bounds_for_node(
    model: &ModelSnapshot,
    node: &GraphNode,
) -> Option<(ModelAabb, Vec3)> {
    let root = model_root_transform(node)?;
    let local = scene::model_world_aabb(model, root.rotation, root.scale.x)?;
    Some((local, root.translation))
}

/// 世界实例的真实根姿态（不含任何卡片位置）。缺失时返回 `None`。
///
/// 世界模型、空模型指示与可见面拾取必须共用这一处变换，避免再次出现「渲染在世界、
/// 查询读卡片」的分叉。
pub(crate) fn world_instance_transform(node: &GraphNode) -> Option<Transform> {
    let instance = node.shared_world_instance.as_ref()?;
    Some(crate::world_camera_view::instance_pose(instance))
}

/// The accepted world pose belongs only to the instance root; asset children stay Y-up.
///
/// 旧卡片节点没有世界实例：不创建模型根。
pub(super) fn model_root_transform(node: &GraphNode) -> Option<Transform> {
    world_instance_transform(node)
}

/// 世界空模型标记的真实世界包围盒（与 `world_presence` 的地台/竖杆同一尺寸）。
///
/// 空模型没有 Scene IR，但仍必须有可点选的世界锚点；这里不读卡片位置。
pub(crate) fn world_marker_bounds(node: &GraphNode) -> Option<([f32; 3], [f32; 3])> {
    let transform = world_instance_transform(node)?;
    let unit = transform.scale.x.abs().max(1.0);
    let radius = unit * 0.55;
    let height = unit * 0.9;
    let p = transform.translation;
    Some((
        [p.x - radius, p.y, p.z - radius],
        [p.x + radius, p.y + height, p.z + radius],
    ))
}
