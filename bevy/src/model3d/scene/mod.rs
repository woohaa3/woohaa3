//! 共享模型场景构建：把 V1/V2 `ModelSnapshot` 规范化为一组与 ECS 无关的构建指令
//! （change: enhance-model-scene-authoring-api，任务 3.2 / 3.3 / 4.1 / 6.1；
//! change: refactor-bevy-rust-file-size 拆分为 facade + 子模块）。
//!
//! 浏览器 WASM adapter 与原生无窗口 renderer adapter **共用**这里的逻辑：
//! - 局部 transform 组合（与 `web/contracts` 的 `model-transform` 同语义）；
//! - `sphere` / `capsule` / `segment` 的确定性中心、长度与朝向；
//! - material 规范化 key（供 mesh/material 缓存复用）。
//!
//! 本模块只依赖 `bevy::prelude`（Transform/Quat/Vec3/Color）、`serde` 与 `crate::protocol`：
//! 不导入 `wasm_bindgen`、不拥有 ECS 状态、不执行 JavaScript。原生 renderer 因此可以
//! 在没有窗口、没有 winit 的进程里复用它。
//!
//! 子模块边界（design D2）：
//! - [`types`]：质量档常量、实体/几何/动画 DTO 与 transform、segment 数学；
//! - [`aabb`]：局部/世界包围盒计算；
//! - [`build`]：V1/V2 实体指令构建；
//! - [`materials`]：material key 规范化与受控 PBR 构建。

mod prepared_bounds;
pub(crate) use prepared_bounds::{PreparedBounds, placed_local_aabb, placed_subtree_aabbs, placed_subtree_aabbs_counted};
mod aabb;
#[cfg(feature = "explicit-instancing")]
pub(crate) use aabb::geometry_half_extents_and_center;
mod build;
mod canonical;
mod materials;
mod types;

// 保留 `crate::model3d::scene::*` 消费路径（design D1）。部分条目只在 native-renderer
// 之外、或只在测试中被引用，因此某个 feature/构建组合下个别再导出会看似“未被使用”；
// 这些 path 必须稳定存在，故显式放行。
#[allow(unused_imports)]
pub(crate) use aabb::{ModelAabb, model_local_aabb, model_subtree_aabb_by_root, model_world_aabb};
#[allow(unused_imports)]
pub(crate) use build::build_entity_specs;
#[allow(unused_imports)]
pub(crate) use canonical::{
    derive_aabb, derive_extent, extent_from_aabb, prepare_snapshot, preview_focus, to_dto,
};
#[allow(unused_imports)]
pub(crate) use materials::{
    MaterialSpec, collect_materials, material_key, normalize_hex, parse_hex, standard_material_for,
};
#[allow(unused_imports)]
pub(crate) use types::{
    CAPSULE_LATITUDES, CAPSULE_LONGITUDES, ModelAnimationSpec, ModelEntitySpec, ModelGeometry,
    SPHERE_SECTORS, SPHERE_STACKS, SegmentGeometry, align_y_to, animation_axis,
    quat_from_xyz_radians, segment_geometry, xyz_radians_from_quat,
};

#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use types::{LocalTransform, quat_from_euler_yxz_degrees};

#[cfg(test)]
mod tests;
