//! 2D 画布渲染域：`Visuals`、2D camera/font/material setup、纹理上传、label 生命周期
//! 与 2D scene 重建（change: refactor-bevy-runtime-modules，任务 3.3 / 3.4 / design D5；
//! change: refactor-bevy-rust-file-size 拆分为 facade + 子模块）。
//!
//! 本模块独占 2D mesh/material、font、node labels、edge labels 与纹理 Sprite/Image 映射，
//! 不导入 `bridge` / `model3d`。
//!
//! 子模块边界（design D3）：
//! - [`init`]：2D camera、字体与共享 mesh/material 初始化、字体就绪判定；
//! - [`textures`]：纹理批次消费与 Sprite 生命周期；
//! - [`camera`]：2D camera 跟随 viewport；
//! - [`group_surface`]：组连续底面，借用既有主画布 3D 相机置于模型后方；
//! - [`render`]：2D scene 重建（labels、edges、cards、共享 mesh 替换）。

pub(crate) mod geometry;

mod aggregate;
mod attach;
mod camera;
mod card_cache;
mod cards;
mod compact_card;
mod container_cache;
mod dash;
mod decoration_cache;
pub(crate) mod draw_order;
mod edge_cache;
mod film_set;
mod focus_reference;
#[cfg(test)]
pub(crate) use film_set::draw_film_set_run_mask;
mod focus_backdrop;
pub(crate) mod focus_details;
mod generation;
pub(crate) mod group;
mod group_motion;
mod group_outline;
mod group_surface;
pub(crate) mod history_pulse;
mod history_strip;
pub(crate) mod image_focus;
mod init;
mod labels;
mod marquee;
mod node_action;
mod ownership_links;
mod render;
mod render_edges;
pub(crate) mod scope_panel;
mod shared_key;
pub(crate) mod text_presentation;
mod texture_store;
mod textures;

/// 共享纯布局函数（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）：渲染与查询复用
/// `canvas_query::layout` 的同一实现，保持既有 `super::layout` 路径与常量。
pub(crate) mod layout {
    pub(crate) use crate::canvas_query::layout::*;
}

/// 共享复合资产范围几何（change: 2026-10-12-align-film-set-scope-with-isometric-grid）：
/// 绘制与命中复用 `canvas_query::scope` 的同一派生，保持既有 `super::scope` 路径。
pub(crate) mod scope {
    pub(crate) use crate::canvas_query::scope::*;
}

/// 共享边曲线函数（同上）：渲染与命中查询共用同一采样/距离实现。
pub(crate) mod curve {
    pub(crate) use crate::canvas_query::curve::*;
}

/// 拍摄镜头预览卡片内容区/状态/进度条的共享纯几何
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D8）：
/// 卡片绘制、GPU Sprite 摆放与归属线终点复用 `canvas_query::shot_preview` 的同一实现。
pub(crate) mod shot_preview {
    pub(crate) use crate::canvas_query::shot_preview::*;
}

use bevy::prelude::*;

pub(crate) use alpha_checker::sync as sync_alpha_checker;
pub(crate) use attach::sync_attach_probe;
pub(crate) use camera::sync_camera;
pub(crate) use focus_backdrop::sync as sync_focus_backdrop;
pub(crate) use generation::{GenerationClock, sync_generation};
pub(crate) use group_motion::sync as sync_group_motion;
pub(crate) use group_surface::sync as sync_group_surfaces;
pub(crate) use init::{font_ready, setup};
pub(crate) use node_action::sync_node_action_bars;
pub(crate) use group::is_running as group_is_running;
pub(crate) use render::{
    begin_selection_outlines, canvas_render_requested, produce_card_geometry, produce_card_hover,
    produce_card_selection, produce_container_geometry, produce_edges, produce_film_set_selection,
    produce_group_selection, sync_canvas_overlay,
};
pub(crate) use labels::{sync_canvas_labels, LabelRequests};
pub(crate) use textures::sync_textures;

/// 2D 渲染的共享资源与生命周期状态：共享几何 mesh/material、font handle、纹理内容表与
/// 批处理块。节点标签、纹理 Sprite 与选中描边由 ECS 组件/Query 拥有，不在此 Resource 中。
///
/// 字段保持私有：仅有本模块的子孙（`init` / `textures` / `render` / `generation`）访问。
#[derive(Resource)]
pub(crate) struct Visuals {
    card_blocks: Vec<card_cache::Block>,
    card_decorations: Vec<decoration_cache::Block>,
    container_blocks: Vec<container_cache::Block>,
    mesh: Handle<Mesh>,
    material: Handle<ColorMaterial>,
    /// 共享 2D 几何实体；首个非空快照到达后才生成（避免 0 顶点 mesh 触发 wgpu panic）。
    ///
    /// 该 mesh 为**不透明**几何（卡片外壳、边、把手），材质开深度写入，使每个节点的真实
    /// z 参与深度测试：上层卡片能正确遮挡下层卡片的纹理/预览 Sprite
    /// （change: 2026-10-09-fix-model-preview-layering-and-projection）。
    mesh_entity: Option<Entity>,
    /// 半透明叠加层共享 mesh（group 底、框选、聚合选区、粘连高亮）：Blend 材质、不写深度，
    /// 仅深度测试，因此被上层不透明卡片正确遮挡。
    blend_mesh: Handle<Mesh>,
    blend_material: Handle<ColorMaterial>,
    blend_mesh_entity: Option<Entity>,
    font: Handle<Font>,
    /// 纹理按内容身份 + 尺寸共享的引用表
    /// （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.4）。
    ///
    /// `textures` 是「节点 → 展示实例」，本表是「内容 → GPU 图像」；删除节点只减引用，
    /// 最后一个引用结束才移除 `Assets<Image>`。
    texture_store: texture_store::TextureStore,
    edge_blocks: Vec<edge_cache::Block>,
    shared_key: Option<shared_key::SharedKey>,
    /// 拖动粘连触须的逐帧动画覆盖层（独立于主 card mesh，避免每帧重建整场几何）。
    attach_probe_mesh: Handle<Mesh>,
    attach_probe_entity: Option<Entity>,
    /// 触须覆盖层当前是否含非空几何（用于从「有触须」到「无」时清空一次）。
    attach_probe_active: bool,
    /// 运行中节点的逐帧进度覆盖层（change: add-node-running-progress）：
    /// 独立于主 card mesh，避免逐帧重建时影响边标签。
    running_mesh: Handle<Mesh>,
    running_mesh_entity: Option<Entity>,
    /// 覆盖层当前是否含非空几何（用于从「有运行节点」到「无」时清空一次）。
    running_active: bool,
    /// 节点顶部操作横条覆盖层（change: 2026-10-13-add-node-to-film-set-shortcut）：
    /// 逐帧重建，锚定节点上方并随位置/视口顶部碰撞变化，独立于主 card mesh 与标签池。
    node_action_mesh: Handle<Mesh>,
    node_action_entity: Option<Entity>,
    /// 横条覆盖层当前是否含非空几何（用于从「有横条」到「无」时清空一次）。
    node_action_active: bool,
}

impl Visuals {
    /// 测试/无窗口宿主：空几何与默认句柄的 Visuals。
    #[cfg(test)]
    pub(crate) fn default_for_test() -> Self {
        Self {
            card_blocks: Vec::new(),
            card_decorations: Vec::new(),
            container_blocks: Vec::new(),
            mesh: default(),
            material: default(),
            mesh_entity: None,
            blend_mesh: default(),
            blend_material: default(),
            blend_mesh_entity: None,
            font: default(),
            texture_store: default(),
            edge_blocks: default(),
            shared_key: None,
            attach_probe_mesh: default(),
            attach_probe_entity: None,
            attach_probe_active: false,
            running_mesh: default(),
            running_mesh_entity: None,
            running_active: false,
            node_action_mesh: default(),
            node_action_entity: None,
            node_action_active: false,
        }
    }

    /// 共享不透明 2D 材质（选择描边批次与第三方 producer 的 flush 复用）。
    pub(crate) fn mesh_material(&self) -> Handle<ColorMaterial> {
        self.material.clone()
    }

    /// 共享半透明叠加材质。
    pub(crate) fn blend_visuals(&self) -> (Handle<Mesh>, Handle<ColorMaterial>) {
        (self.blend_mesh.clone(), self.blend_material.clone())
    }

    /// 字体句柄（标签 producer 新建文字实体时复用）。
    pub(crate) fn font(&self) -> Handle<Font> {
        self.font.clone()
    }
}

#[derive(Component)]
pub(crate) struct MainCanvasCamera;
