//! 配置化等距网格模块
//! （change: refactor-bevy-reusable-components，任务 4.1/4.2 / design D2）。
//!
//! 子模块边界：
//! - [`plan`]：纯投影/规划（[`IsometricGridView`]、间距档、`plan_grid`），不依赖 ECS/协议；
//! - [`lifecycle`]：插件、配置/样式/资源与 viewport 同步，不读取 Canvas `Scene` 或主题资源。
//!
//! 宿主/adapter 注入 viewport、surface、颜色、render layer；插件拥有 mesh/material 资源与回收。

mod lifecycle;
pub(crate) mod plan;

pub use lifecycle::{
    GridStyleState, IsometricGrid, IsometricGridAssets, IsometricGridConfig, IsometricGridPlugin,
    IsometricGridSet, IsometricGridState, IsometricGridStyle, IsometricGridTarget, grid_material,
};
pub use plan::{
    CANVAS_CAMERA_PITCH, CANVAS_CAMERA_Z, GRID_BASE_SPACING, GRID_DEPTH, GRID_LINE_WIDTH,
    GRID_MAJOR_EVERY, GRID_MIN_SCREEN_SPACING, GridPlan, IsometricGridView, MODEL_CAMERA_FAR,
    canvas_camera_projection, canvas_camera_projection_for_view, canvas_camera_rotation,
    canvas_camera_transform, canvas_camera_transform_for_view, canvas_point_to_world,
    embed_screen_point, plan_grid, projection_scale, screen_point_from_world,
    screen_point_to_world, screen_to_ground, spacing_for_zoom, unproject_screen_point,
    view_rotation,
};
