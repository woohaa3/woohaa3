//! 2D 画布共享纯几何与可丢弃 interaction 查询
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D4）。
//!
//! 本模块不依赖 ECS、bridge、winit 或 wasm-bindgen，因此可在 native 下单独测试：
//! - [`layout`]：节点画布几何、端口、控件矩形的唯一纯实现（绘制与查询共用）；
//! - [`curve`]：边三次贝塞尔控制点/采样/点到线段距离的唯一纯实现；
//! - [`interaction`]：接受合法场景后构建的快照与点/框选/probe 查询；
//! - [`shot_preview`]：拍摄镜头预览卡片的内容区/接口几何与可视判定（绘制与命中共用）。
//!
//! `canvas2d` 渲染模块复用同一套函数，确保「画在哪、点在哪」一致，且删除 48/64 段差异。
#![cfg_attr(not(feature = "canvas-core"), allow(dead_code))]

pub(crate) mod focus_context;
pub(crate) mod group_model;
pub(crate) mod aggregate;
pub(crate) mod composite_panel;
pub(crate) mod curve;
pub(crate) mod film_set_pick;
pub(crate) mod gizmo;
pub(crate) mod interaction;
pub(crate) mod layout;
pub(crate) mod model_pick;
pub(crate) mod media_focus;
pub(crate) mod scope;
pub(crate) mod shot_preview;
mod position_basis;

/// 记录一次合法 `set_scene` 并在同一接受点同步发布 interaction snapshot。
#[cfg(feature = "canvas-core")]
pub(crate) use interaction::accept_scene;
