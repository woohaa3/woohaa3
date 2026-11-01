//! 根单位、锚点与 transform 计算
//! （change: refactor-bevy-rust-file-size，任务 3.2 / design D2）。

use bevy::prelude::*;

use crate::protocol::{GraphNode, ModelPlacement, ModelSnapshot};

use super::grid;
use super::scene::{self, ModelAabb};

/// 卡片底部与模型上边界之间保留的屏幕间距（zoom = 1 时约 40 CSS 像素）。
///
/// 卡片由 2D camera（更高的 camera order）绘制，永远盖在 3D 模型之上；因此模型必须整体
/// 位于卡片**下方**，否则高模型的顶部会被卡片遮挡（change: 卡片与模型不重叠）。
pub(crate) const MODEL_CARD_GAP: f32 = 40.0;

/// 场景单位（= 1 米）→ 画布世界单位的固定换算（change:
/// 2026-10-31-render-models-at-absolute-metric-scale）。
///
/// 与 TS `CANVAS_UNITS_PER_METER` 同值。模型尺寸不再按自身包围盒归一化：1.7 m 的人恒为约
/// 109 画布单位高，20 m 的楼恒为约 1280，且与模型在世界原点附近的位置无关。
pub(crate) const CANVAS_UNITS_PER_METER: f32 = 64.0;
/// 由已注册资源与节点派生模型**世界** AABB（含 view rotation/unit/anchor）
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.2；
///  change: make-shot-framing-zoom-invariant，任务 2.1 / 3.1：固定世界，不读取 viewport/surface）。
///
/// 普通画布 picking 与展示共用同一 `model3d` 事实源：局部 AABB 由 `derive_aabb` 保留在
/// 资源表中，这里只应用根 transform 与锚点，不重新遍历 mesh。根旋转只有 placement yaw；
/// 等距视角由相机承担，锚点经固定 [`canvas_world_position`] 嵌入倾斜世界。
pub(crate) fn model_world_aabb_for_node(
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    node: &GraphNode,
) -> Option<ModelAabb> {
    let (local, anchor) = model_bounds_for_node(model, placement, node)?;
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
    placement: &ModelPlacement,
    node: &GraphNode,
) -> Option<(ModelAabb, Vec3)> {
    let unit = model_unit(node, model, placement);
    let local = layout_aabb(node, model, model_view_rotation(placement), unit)?;
    Some((local, model_anchor(node, model, placement, unit)))
}

/// 模型在画布世界的根位置（world y 轴向上）——固定画布坐标，不读取 viewport/surface。
///
/// 模型整体位于内嵌预览卡片**下方**（`MODEL_CARD_GAP`）。
pub(crate) fn model_anchor(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    unit: f32,
) -> Vec3 {
    let (cx, cy) = model_anchor_canvas(node, model, placement, unit);
    // 3D 遮挡逐像素决定；`depth_order` 只提供打破共面平局的极小偏移（change:
    // 2026-10-27-order-canvas-layers-by-ground-anchor，design D1/D3）；
    // `placement.offset.z` 仍保留在协议与内容身份里，但不再决定前后遮挡。
    canvas_world_position(cx, cy, root_depth(node))
}

/// 普通模型根锚点的画布坐标 `(cx, cy)`，不含观察深度。
fn model_anchor_canvas(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    unit: f32,
) -> (f32, f32) {
    let size = 64.0;
    let cx = node.x + node.width / 2.0 + placement.offset.x * size;
    // 模型顶部相对根锚点的世界高度（含层级/半径/单位缩放）。缺失时用既有固定偏移。
    // 卡片间距按屏幕投影后的顶部计算（等距相机看到的高度），根实体本身不带这层旋转。
    let layout_rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let top = scene::model_world_aabb(model, layout_rotation, unit)
        .map(|aabb| aabb.max[1].max(0.0))
        .filter(|value| value.is_finite())
        .unwrap_or(74.0 - MODEL_CARD_GAP);
    let cy = node.y + node.height + MODEL_CARD_GAP + top - placement.offset.y * size;
    (cx, cy)
}

/// 根的观察深度：只含逐像素平局偏移，不做整对象厚度分离。
fn root_depth(node: &GraphNode) -> f32 {
    crate::depth_order::depth_of(&node.id)
}

/// 模型根单位缩放。
///
/// 绝对米制：`placement.scale * CANVAS_UNITS_PER_METER`，**不除以 `extent`**
/// （change: 2026-10-31-render-models-at-absolute-metric-scale）。1 场景单位 = 1 米 = 64 画布单位，
/// 因此 1.7 m 的人与 20 m 的楼在所有节点里都保持真实比例，也不再受"模型离世界原点多远"影响。
///
pub(crate) fn model_unit(
    _node: &GraphNode,
    _model: &ModelSnapshot,
    placement: &ModelPlacement,
) -> f32 {
    placement.scale * CANVAS_UNITS_PER_METER
}

/// Saved placement bounds drive layout; drag previews only replace item transforms.
fn layout_aabb(
    _node: &GraphNode,
    model: &ModelSnapshot,
    rotation: Quat,
    unit: f32,
) -> Option<ModelAabb> {
    scene::model_world_aabb(model, rotation, unit)
}

/// 模型根旋转：只有 placement yaw。等距 45° 在正交相机 lookat 上。
pub(super) fn model_view_rotation(placement: &ModelPlacement) -> Quat {
    Quat::from_rotation_y(placement.yaw.to_radians())
}

/// 固定画布坐标 `(cx, cy, depth)` → 世界：`R × (cx, -cy, depth)`，原点固定为世界零点。
pub(super) fn canvas_world_position(cx: f32, cy: f32, depth: f32) -> Vec3 {
    crate::isometric_grid::canvas_point_to_world(cx, cy, depth)
}

/// 根 transform identity（诊断/测试用）：node position 与 placement（不读 viewport）。
///
/// placement 现为根 transform 的一部分，不再进入 `ModelSnapshot::signature`。
#[cfg(test)]
pub(crate) fn model_transform_signature(
    _model: &ModelSnapshot,
    placement: &ModelPlacement,
    node: &GraphNode,
) -> String {
    format!(
        "{:.2}:{:.2}:{:.2}:{:.2}:{:.3}:{:.3}:{:.3}:{:.4}",
        node.x,
        node.y,
        node.width,
        node.height,
        placement.offset.x,
        placement.offset.y,
        placement.offset.z,
        placement.scale as f64,
    )
}
