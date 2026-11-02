use crate::{protocol::ModelSnapshot, renderer_protocol::CompositeAssetFrameRequest};
use bevy::prelude::*;

/// 片场场景单位 → 原生生产输出的换算倍率（change:
/// 2026-10-23-isolate-film-set-camera-space，design D3/D4；
/// change: 2026-10-31-render-models-at-absolute-metric-scale）。
///
/// 生产输出**只**使用场景单位（1 单位 = 1 米）：`CANVAS_UNITS_PER_METER` 把内容脚本单位换算成
/// 与镜头 distance/focusOffset 相同尺度的场景单位，不再除以 `extent`。画布节点矩形
/// （`CompositeAssetFrameRequest.width/height`）与 viewport 不参与，因此调整呈现不会改变成片取景。
///
/// 注意这里与浏览器 `filmSetNaturalScale` 的差异是**有意**的：浏览器还要乘
/// `min(placement.scale,1)` 与节点矩形容器适配（`filmSetFit`）才有世界倍率；离屏渲染没有呈现
/// 容器，`placement.scale` 仍按内容根倍率应用（见 [`production_root`]）。
pub(super) fn scene_scale(_extent: f32) -> f32 {
    crate::model3d::layout::CANVAS_UNITS_PER_METER
}

/// 生产输出根 transform：场景单位 × 内容根 placement（scale/yaw），不含节点矩形适配。
pub(super) fn production_root(model: &ModelSnapshot, _extent: f32) -> Transform {
    let placement = &model.placement;
    let scale = placement.scale;
    let safe_scale = if scale.is_finite() && scale > 0.0 {
        scale.min(1.0)
    } else {
        1.0
    };
    let yaw = if placement.yaw.is_finite() {
        placement.yaw.to_radians()
    } else {
        0.0
    };
    Transform {
        translation: Vec3::ZERO,
        rotation: Quat::from_rotation_y(yaw),
        scale: Vec3::splat(scene_scale(_extent) * safe_scale),
    }
}

/// 内容局部 AABB → 场景单位 AABB（只应用 yaw 与内容根倍率）。
fn scene_bounds(
    model: &ModelSnapshot,
    local: crate::model3d::scene::ModelAabb,
) -> crate::model3d::scene::ModelAabb {
    let root = production_root(model, model.extent);
    local.transformed(&Transform {
        scale: Vec3::splat(root.scale.x),
        rotation: root.rotation,
        ..default()
    })
}

/// Same immutable reference geometry and card scale as the browser; no animated bounds.
///
/// 生产取景在**场景空间**：包围球由内容单位 × `CANVAS_UNITS_PER_METER` 派生，`frame` 只提供媒体
/// 与 layout bounds，节点宽高不参与取景（change: 2026-10-23-isolate-film-set-camera-space，
/// 任务 3.1 / design D4；change: 2026-10-31-render-models-at-absolute-metric-scale 去掉按
/// `extent` 归一化）。
pub(super) fn reference_frame(
    model: &ModelSnapshot,
    frame: Option<&CompositeAssetFrameRequest>,
) -> (Transform, Vec3, f32) {
    let Some(frame) = frame else {
        let (center, radius) = crate::model3d::preview_focus(model).unwrap_or((Vec3::ZERO, 1.0));
        return (Transform::default(), center, radius);
    };
    let mut reference = model.clone();
    reference.extent = frame.resource_extent;
    let root = production_root(&reference, frame.resource_extent);
    let local = frame
        .layout_aabb
        .as_ref()
        .map(|bounds| crate::model3d::scene::ModelAabb::new(bounds.min, bounds.max))
        .or_else(|| crate::model3d::scene::model_world_aabb(&reference, Quat::IDENTITY, 1.0));
    let (center, radius) = local
        .map(|bounds| scene_bounds(&reference, bounds))
        .map(|b| (b.center(), b.radius()))
        .unwrap_or((Vec3::ZERO, 1.0));
    (root, center, radius)
}
