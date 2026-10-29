//! 画布节点 ECS 投影层
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）。
//!
//! 本模块只拥有三件事：
//! 1. **公共组件**：节点身份、布局、深度、选中/悬停/可见性与展示类型，以及标签/纹理/
//!    surface/缩略图/细节/marker 的 owner 组件；
//! 2. **投影**：accepted `CurrentScene` → 稳定的节点实体集合；
//! 3. **批处理接口与调度顺序**：各展示类型 producer 共享的 `SelectionOutlineBatch` 与
//!    system sets。
//!
//! 资产、预算、LRU、异步准备、纹理内容共享与合批块仍是 Resource；派生实体通过 `ChildOf`
//! 归属节点实体，删除节点即回收派生状态。

pub(crate) mod components;

#[cfg(feature = "canvas-core")]
pub(crate) mod batch;
#[cfg(feature = "canvas-core")]
pub(crate) mod presentation;
#[cfg(feature = "canvas-core")]
pub(crate) mod projection;

#[cfg(feature = "canvas-core")]
pub(crate) use batch::{
    CanvasBatchWriter, SelectionOutlineBatch, SelectionOutlineLayer, flush_selection_outlines,
};
#[cfg(feature = "canvas-core")]
pub(crate) use presentation::sync_group_panels;
#[cfg(feature = "canvas-core")]
pub(crate) use projection::{
    CanvasProjectionState, node_for_draw, project_canvas_nodes, projection_requested,
};

use bevy::ecs::schedule::SystemSet;

/// 2D 画布帧内顺序。`app` 用 `.chain()` 把各 set 串成显式调度依赖；每个 set 边界都会应用
/// deferred，因此投影当帧创建的实体、presentation 子实体与标签对后续 producer 可见。
#[cfg(feature = "canvas-core")]
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum CanvasRenderSet {
    /// 从 accepted snapshot 更新节点实体与公共组件（唯一的快照遍历点）。
    Project,
    /// 按展示组件创建/复用语义子实体（group 面板、纹理 Sprite、缩略图、细节）。
    Presentation,
    /// 按展示类型生产几何：卡片、group、片场、边。
    Geometry,
    /// 各展示类型自己的持久选中描边 producer。
    Selection,
    /// 标签/文字与派生 overlay 同步。
    Labels,
    /// 只替换共享 mesh handle、应用材质并清理空批次。
    Flush,
}

#[cfg(test)]
#[cfg(feature = "canvas-core")]
mod tests;
