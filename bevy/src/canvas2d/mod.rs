//! 2D 画布渲染域：`CanvasOverlayCache`、2D camera/font/material setup、纹理上传、label 生命周期
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
//! - [`render`]：2D scene 重建（labels、edges、cards、共享 mesh 替换）。

pub(crate) mod geometry;

mod aggregate;
mod attach;
mod camera;
mod card_cache;
mod card_meta;
mod cards;
mod chrome;
mod compact_card;
mod dash;
mod decoration_cache;
pub(crate) mod draw_order;
mod edge_cache;
mod focus_backdrop;
pub(crate) mod focus_details;
mod focus_reference;
mod generation;
pub(crate) mod history_pulse;
pub(crate) mod history_strip;
pub(crate) mod image_focus;
mod init;
mod labels;
mod marquee;
mod node_action;
mod render;
mod render_edges;
mod scene_area_label;
mod shared_key;
pub(crate) mod text_presentation;
mod texture_store;
mod textures;
pub(crate) mod world_camera_connector;

/// 共享纯布局函数（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）：渲染与查询复用
/// `canvas_query::layout` 的同一实现，保持既有 `super::layout` 路径与常量。
pub(crate) mod layout {
    pub(crate) use crate::canvas_query::layout::*;
}

/// 共享边曲线函数（同上）：渲染与命中查询共用同一采样/距离实现。
pub(crate) mod curve {
    pub(crate) use crate::canvas_query::curve::*;
}

use bevy::prelude::*;

/// Shared GPU material/font handles. Entity and layer ownership stays in components/queries;
/// this resource only contains handles safe to share across producers.
#[derive(Resource, Clone)]
pub(crate) struct CanvasMaterials {
    pub(crate) solid: Handle<ColorMaterial>,
    pub(crate) blend: Handle<ColorMaterial>,
    pub(crate) font: Handle<Font>,
}

/// Cache resource aliases used by producers while the cache fields are migrated independently.
/// They keep system signatures explicit at the module boundary and preserve one ECS resource
/// registration during the staged migration.
pub(crate) use card_cache::CardBlockCache;
pub(crate) use decoration_cache::CardDecorationCache;
pub(crate) use edge_cache::EdgeBlockCache;
pub(crate) use texture_store::TextureStore;

pub(crate) use attach::sync_attach_probe;
pub(crate) use camera::sync_camera;
pub(crate) use card_meta::produce_card_meta;
pub(crate) use focus_backdrop::sync as sync_focus_backdrop;
pub(crate) use generation::{GenerationClock, sync_generation};
pub(crate) use init::{font_ready, setup};
pub(crate) use labels::{LabelRequests, sync_canvas_labels};
pub(crate) use node_action::sync_node_action_bars;
pub(crate) use render::{
    begin_selection_outlines, canvas_render_requested, produce_card_geometry, produce_card_hover,
    produce_card_selection, produce_edges, sync_canvas_overlay,
};
pub(crate) use scene_area_label::sync_scene_area_labels;
pub(crate) use textures::sync_textures;
pub(crate) use world_camera_connector::sync as sync_world_camera_connectors;

/// 2D 渲染的共享材质、字体与主卡片块资源。装饰、容器、连线块和纹理内容表分别由
/// `CardDecorationCache`、`ContainerBlockCache`、`EdgeBlockCache` 与 `TextureStore` 拥有；
/// 节点标签、纹理 Sprite 与选中描边由 ECS 组件/Query 或专用批次拥有。
///
/// 字段保持私有：仅有本模块的子孙（`init` / `textures` / `render` / `generation`）访问。
#[derive(Resource)]
pub(crate) struct CanvasOverlayCache {
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
    shared_key: Option<shared_key::SharedKey>,
}

impl CanvasOverlayCache {
    /// 测试/无窗口宿主：空几何与默认句柄的 CanvasOverlayCache。
    #[cfg(test)]
    pub(crate) fn default_for_test() -> Self {
        Self {
            mesh: default(),
            material: default(),
            mesh_entity: None,
            blend_mesh: default(),
            blend_material: default(),
            blend_mesh_entity: None,
            font: default(),
            shared_key: None,
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
