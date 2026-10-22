//! 场景接受点派生的 picking 候选构建（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm；
//! change: 2026-10-09-add-film-set-object-motion-and-editing 增加片场对象候选；
//! change: 2026-10-13-add-film-set-hover-camera-entity 把普通模型候选派生下沉到纯 `model3d`；
//! change: 2026-10-14-scope-film-set-object-picking-to-focus 把内部对象候选收敛到聚焦片场）。
//!
//! 本文件只把 `bridge` 资源表注入纯 `model3d` 派生（普通模型候选见
//! [`model3d::pick::model_candidates`]，内部对象候选见 [`model3d::film_set_pick::prepare`]），
//! 不拥有 ECS 状态、也不重复几何公式。目标门禁（accepted `modelFocus` 定位唯一 composite 节点）
//! 与部件包围盒计数在纯模块内，因此可在 native 测试覆盖。

use crate::{bridge, canvas_query, model3d, protocol};

/// 每个普通模型的世界 AABB（普通画布 picking 用）。
///
/// 由 [`model3d::pick::model_candidates`] 派生（按通用 presentation 排除 composite 资产），
/// 本层只提供 `bridge` 资源表。
pub(crate) fn model_candidates(
    scene: &protocol::Scene,
) -> Vec<canvas_query::model_pick::ModelCandidate> {
    model3d::pick::model_candidates(scene, bridge::lookup_model_asset)
}

/// 当前聚焦片场的内部对象候选（owner + 候选 + 部件包围盒求值次数）。
///
/// 由 [`model3d::film_set_pick::prepare`] 派生；无聚焦目标时为 `owner = None`/空候选，
/// 不接受点不会做任何部件或媒体准备（design D1）。
pub(crate) fn film_set_items(scene: &protocol::Scene) -> model3d::FilmSetItemPreparation {
    model3d::film_set_pick::prepare(scene, bridge::lookup_model_asset)
}
