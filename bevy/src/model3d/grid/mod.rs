//! 网格 Canvas adapter（change: refactor-bevy-reusable-components，任务 4.2/4.3）。
//!
//! - [`plan`]：协议 Viewport ↔ 通用 `IsometricGridView` 的兼容转发；
//! - [`lifecycle`]：3D 相机/灯光 setup、`ModelCanvasCamera` 标记与 config/style/target 适配。

mod lifecycle;
mod plan;

pub(crate) use lifecycle::{
    ModelCanvasCamera, setup, setup_camera, sync_camera, sync_target, sync_theme,
};
pub(crate) use plan::{scene_view, view_rotation};
#[cfg(test)]
pub(crate) use plan::grid_view;

// 测试面：仅供 `grid::tests` 通过 `super::*` 访问。
#[cfg(test)]
pub(crate) use plan::{
    GRID_BASE_SPACING, GRID_DEPTH, GRID_MIN_SCREEN_SPACING, GridPlan, plan_grid, projection_scale,
    spacing_for_zoom,
};

#[cfg(test)]
mod tests;
