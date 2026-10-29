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
/// 普通 `model3d`：模型整体位于内嵌预览卡片**下方**（`MODEL_CARD_GAP`）。
/// 片场（`composite-asset`）：没有卡片，模型**居中锚定**在节点矩形中心
/// （change: 2026-10-08-make-film-set-model-only 修订）。
pub(crate) fn model_anchor(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    unit: f32,
) -> Vec3 {
    if node.group.is_some() {
        return group_anchor(node, model, placement, unit);
    }
    if node.composite_asset.is_some() {
        return film_set_anchor(node, model, placement, unit);
    }
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

/// The accepted presentation and the model use one layout, including eccentric model origins.
fn group_layout(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
) -> crate::canvas_query::group_model::GroupModelLayout {
    crate::canvas_query::group_model::for_node(node).unwrap_or_else(|| {
        let local =
            scene::model_local_aabb(model).unwrap_or_else(|| ModelAabb::new([0.; 3], [0.; 3]));
        crate::canvas_query::group_model::derive(node, local, model.extent, placement)
    })
}
fn group_anchor(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    _unit: f32,
) -> Vec3 {
    let layout = group_layout(node, model, placement);
    canvas_world_position(layout.anchor.x, layout.anchor.y, root_depth(node))
}

/// 片场模型适配节点矩形时四周保留的边距（世界单位）。
pub(crate) const FILM_SET_FIT_MARGIN: f32 = 16.0;

/// 片场根锚点：把模型世界 AABB 的**投影中心**对齐到节点矩形中心。
fn film_set_anchor(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    unit: f32,
) -> Vec3 {
    let layout_rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let bounds = layout_aabb(node, model, layout_rotation, unit);
    let (cx, cy) = film_set_anchor_canvas(node, bounds, placement);
    canvas_world_position(cx, cy, root_depth(node))
}

/// 片场根锚点的画布坐标 `(cx, cy)`（y 向下）；索引/标题与渲染共用同一居中与偏移夹取公式。
fn film_set_anchor_canvas(
    node: &GraphNode,
    bounds: Option<ModelAabb>,
    placement: &ModelPlacement,
) -> (f32, f32) {
    let size = 64.0;
    let center = bounds
        .map(|aabb| aabb.center())
        .filter(|value| value.is_finite())
        .unwrap_or(Vec3::ZERO);
    // 投影中心（屏幕对齐、y 向上）→ 画布坐标（y 向下）的锚点；placement offset 与普通模型
    // 同语义（x/y 为画布平移，z 为观察深度）。
    let half = bounds.map(|aabb| aabb.half_extents()).unwrap_or(Vec3::ZERO);
    let slack_x = (node.width / 2.0 - FILM_SET_FIT_MARGIN - half.x).max(0.0);
    let slack_y = (node.height / 2.0 - FILM_SET_FIT_MARGIN - half.y).max(0.0);
    let cx =
        node.x + node.width / 2.0 - center.x + (placement.offset.x * size).clamp(-slack_x, slack_x);
    let cy = node.y + node.height / 2.0 + center.y
        - (placement.offset.y * size).clamp(-slack_y, slack_y);
    (cx, cy)
}

/// 模型根单位缩放。
///
/// 普通 `model3d`：`placement.scale * 64 * 3 / extent`（既有语义）。
/// 片场：在既有自然单位上再乘适配系数，使整体倍率至多为 1（完整适配尺寸），模型投影 AABB 等比适配
/// 节点矩形；更小的 `placement.scale` 仍可缩小内容，超出适配尺寸的倍率被限制（change: 2026-10-08-make-film-set-model-only
/// 修订）。拖动线框角落改变节点矩形即等比缩放整套内容，媒体平面在映射层用同一适配因子。
pub(crate) fn model_unit(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
) -> f32 {
    let size = 64.0;
    let natural = size * 3.0 / model.extent.max(0.001);
    let base = placement.scale * natural;
    if node.group.is_some() {
        return group_layout(node, model, placement).unit;
    }
    if node.composite_asset.is_some() {
        return placement.scale.min(1.0) * natural * film_set_fit(node, model, placement, natural);
    }
    base
}

/// 片场适配系数（与 `placement.scale` 无关，基于自然单位投影）：让模型投影 AABB 等比落入
/// 节点矩形（减去固定边距）。无几何或非法数值时返回 `1`。
fn film_set_fit(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    natural_unit: f32,
) -> f32 {
    let layout_rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let Some(aabb) = layout_aabb(node, model, layout_rotation, natural_unit) else {
        return 1.0;
    };
    film_set_fit_for_bounds(node, &aabb)
}

/// 让给定投影 AABB 等比落入节点矩形（减去固定边距）；与 `film_set_fit` 共用。
fn film_set_fit_for_bounds(node: &GraphNode, aabb: &ModelAabb) -> f32 {
    let width = (aabb.max[0] - aabb.min[0]).max(1e-3);
    let height = (aabb.max[1] - aabb.min[1]).max(1e-3);
    let avail_w = (node.width - FILM_SET_FIT_MARGIN * 2.0).max(1.0);
    let avail_h = (node.height - FILM_SET_FIT_MARGIN * 2.0).max(1.0);
    let fit = (avail_w / width).min(avail_h / height);
    if fit.is_finite() && fit > 0.0 {
        fit
    } else {
        1.0
    }
}

/// 片场全部内容在画布上的投影包围盒 `(x, y, width, height)`（y 向下）。
///
/// 直接消费呈现字段 `layout_aabb`/`content_extent`/根 placement（渲染节点优先使用模型引用的
/// placement），并复用与 [`film_set_fit`] 和 [`film_set_anchor_canvas`] 完全相同的适配与锚点
/// 公式。范围标题据此浮在模型顶部之上，点命中只把条带延伸到模型包围盒顶部，避免高模型顶部被
/// 标题遮挡、身体又难以点选。缺失内容几何或数值非法时返回 `None`。
pub(crate) fn film_set_content_bounds(node: &GraphNode) -> Option<(f32, f32, f32, f32)> {
    let film = node.composite_asset.as_ref()?;
    let bounds = film.layout_aabb?;
    let local = ModelAabb::new(bounds.min, bounds.max);
    if !local.is_finite() {
        return None;
    }
    let placement = node
        .model
        .as_ref()
        .map(|model| &model.placement)
        .or(film.root_placement.as_ref())
        .cloned()
        .unwrap_or_default();
    let extent = film
        .content_extent
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(2.0);
    let natural = 64.0 * 3.0 / extent.max(0.001);
    let rotation = grid::view_rotation() * Quat::from_rotation_y(placement.yaw.to_radians());
    let projected = local.transformed(&Transform {
        rotation,
        scale: Vec3::splat(natural),
        ..default()
    });
    let unit = placement.scale.min(1.0) * natural * film_set_fit_for_bounds(node, &projected);
    let isometric = local.transformed(&Transform {
        rotation,
        scale: Vec3::splat(unit),
        ..default()
    });
    let (cx, cy) = film_set_anchor_canvas(node, Some(isometric), &placement);
    let x = cx + isometric.min[0];
    let y = cy - isometric.max[1];
    let width = isometric.max[0] - isometric.min[0];
    let height = isometric.max[1] - isometric.min[1];
    (x.is_finite()
        && y.is_finite()
        && width.is_finite()
        && height.is_finite()
        && width >= 0.0
        && height >= 0.0)
        .then_some((x, y, width, height))
}

/// Saved placement bounds drive layout; drag previews only replace item transforms.
fn layout_aabb(
    node: &GraphNode,
    model: &ModelSnapshot,
    rotation: Quat,
    unit: f32,
) -> Option<ModelAabb> {
    if let Some(bounds) = node
        .composite_asset
        .as_ref()
        .and_then(|film| film.layout_aabb)
    {
        let local = ModelAabb::new(bounds.min, bounds.max);
        return Some(local.transformed(&Transform {
            rotation,
            scale: Vec3::splat(unit),
            ..default()
        }));
    }
    scene::model_world_aabb(model, rotation, unit)
}

/// 片场内部对象候选世界 AABB（对象模式 picking 用，change: 2026-10-09-add-film-set-object-motion-and-editing）。
///
/// 按 `item_roots`（itemId → 组合作用域根 id）求每对象子树 AABB，应用到整体组合根 transform
/// （view rotation × unit + anchor）。返回 `(itemId, worldAabb)`；无几何对象跳过。
///
/// change: 2026-10-14-scope-film-set-object-picking-to-focus，任务 3.1 —— 本变体额外返回为本次
/// 内部对象准备实际求值的部件包围盒次数；计数来自真实派生，不额外遍历、不在无目标时制造求值。
pub(crate) fn film_set_item_world_aabbs_counted(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
    item_roots: &std::collections::HashMap<String, String>,
) -> (Vec<(String, ModelAabb)>, u64) {
    if item_roots.is_empty() {
        return (Vec::new(), 0);
    }
    let unit = model_unit(node, model, placement);
    let view_rotation = model_view_rotation(placement);
    let anchor = model_anchor(node, model, placement, unit);
    let root_ids: Vec<String> = item_roots.values().cloned().collect();
    let (subtrees, evaluated_parts) = scene::placed_subtree_aabbs_counted(
        model,
        &root_ids,
        node.composite_asset
            .as_ref()
            .map(|asset| &asset.item_placements),
    );
    let root = Transform {
        translation: anchor,
        rotation: view_rotation,
        scale: Vec3::splat(unit),
    };
    let mut result = Vec::new();
    for (root_id, local) in subtrees {
        let Some((item_id, _)) = item_roots
            .iter()
            .find(|(_, value)| value.as_str() == root_id.as_str())
        else {
            continue;
        };
        let world = local.transformed(&root);
        result.push((item_id.clone(), world));
    }
    (result, evaluated_parts as u64)
}

/// 模型根旋转：只有 placement yaw。等距 45° 在正交相机 lookat 上。
pub(super) fn model_view_rotation(placement: &ModelPlacement) -> Quat {
    Quat::from_rotation_y(placement.yaw.to_radians())
}

/// 组合内容 → 画布世界的**共同根 transform**（模型与地面/媒体每层只应用一次）。
///
/// 与模型实体根完全同式：`world = anchor + rotation × (unit × content_local)`，其中
/// `rotation` 只含 placement yaw（等距观察由相机承担，不烘焙进根），`unit` 为模型单位。
/// 片场媒体平面与对象 picking/逆变换都据此根，避免媒体另走画布中心嵌入而与模型漂移
/// （change: 2026-10-11-extract-film-set-extension D4/D7）。
pub(crate) fn film_set_root_transform(
    node: &GraphNode,
    model: &ModelSnapshot,
    placement: &ModelPlacement,
) -> Transform {
    let unit = model_unit(node, model, placement);
    Transform {
        translation: model_anchor(node, model, placement, unit),
        rotation: model_view_rotation(placement),
        scale: Vec3::splat(unit),
    }
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
