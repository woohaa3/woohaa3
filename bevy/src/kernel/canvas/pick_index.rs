//! 场景接受点派生的 picking 候选构建（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
//!
//! 本文件只把 `bridge` 资源表注入纯 `model3d` 派生（普通模型候选见
//! [`model3d::pick::model_candidates`]），不拥有 ECS 状态、也不重复几何公式。

use crate::{bridge, canvas_query, model3d, protocol};

/// 每个普通模型的世界 AABB（普通画布 picking 用）。
///
/// 由 [`model3d::pick::model_candidates`] 派生，本层只提供 `bridge` 资源表。
pub(crate) fn model_candidates(
    scene: &protocol::Scene,
) -> Vec<canvas_query::model_pick::ModelCandidate> {
    model3d::pick::model_candidates(scene, bridge::lookup_model_asset)
}
