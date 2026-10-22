//! 网格规划：迁移到通用 [`crate::isometric_grid`]
//! （change: refactor-bevy-reusable-components，任务 4.2/4.3 / design D2）。
//!
//! 纯投影/规划已收敛到协议无关的 `isometric_grid::plan`；本模块只保留 model3d 侧兼容
//! 转发，避免重复实现。协议 `Viewport` → `IsometricGridView` 的转换也在这里完成。

use crate::protocol::Viewport;

pub(crate) use crate::isometric_grid::plan::{IsometricGridView, view_rotation};

// `grid::tests` 经 `super::*` 复用通用网格规划的常量与函数；非测试构建下这些转发未被
// 引用，故按测试面导出（权威定义在 `isometric_grid::plan`）。
#[cfg(test)]
pub(crate) use crate::isometric_grid::plan::{
    GRID_BASE_SPACING, GRID_DEPTH, GRID_LINE_WIDTH, GRID_MAJOR_EVERY, GRID_MIN_SCREEN_SPACING,
    GridPlan, MODEL_CAMERA_FAR, PROJECTION_SCALE, plan_grid, spacing_for_zoom,
};

/// 协议 `Viewport` → 协议无关的 [`IsometricGridView`]。
pub(crate) fn grid_view(view: &Viewport) -> IsometricGridView {
    IsometricGridView {
        x: view.x,
        y: view.y,
        zoom: view.zoom,
    }
}

/// 网格与二维媒体使用同一个实际画布取景。
pub(crate) fn scene_view(scene: &crate::protocol::Scene) -> IsometricGridView {
    crate::canvas_query::media_focus::camera_view(scene)
        .map(|(x, y, zoom)| IsometricGridView { x, y, zoom })
        .unwrap_or_else(|| grid_view(&scene.viewport))
}
