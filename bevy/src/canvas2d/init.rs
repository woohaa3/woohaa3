//! 2D camera、字体与共享 mesh/material 初始化
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3）。

use std::collections::HashMap;

use bevy::sprite_render::AlphaMode2d;
use bevy::{prelude::*, render::view::Tonemapping};

use super::Visuals;
use super::geometry::Geometry;

/// 2D camera、字体与共享 mesh/material 初始化。
pub(crate) fn setup(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<ColorMaterial>,
    assets: &AssetServer,
) {
    commands.spawn((
        Camera2d,
        super::MainCanvasCamera,
        Camera {
            order: 1,
            clear_color: ClearColorConfig::None,
            ..default()
        },
        Msaa::Sample4,
        Tonemapping::None,
    ));
    let mesh = meshes.add(Geometry::default().build());
    // 不透明材质：开深度写入，让卡片外壳按真实 z 遮挡媒体 Sprite
    // （change: 2026-10-09-fix-model-preview-layering-and-projection）。
    let material = materials.add(ColorMaterial {
        alpha_mode: AlphaMode2d::Opaque,
        ..ColorMaterial::default()
    });
    let blend_mesh = meshes.add(Geometry::default().build());
    // 半透明叠加层材质：Blend、不写深度，仅 `GreaterEqual` 测试。
    let blend_material = materials.add(ColorMaterial {
        alpha_mode: AlphaMode2d::Blend,
        ..ColorMaterial::default()
    });
    let running_mesh = meshes.add(Geometry::default().build());
    let attach_probe_mesh = meshes.add(Geometry::default().build());
    let node_action_mesh = meshes.add(Geometry::default().build());
    commands.insert_resource(Visuals {
        card_blocks: Vec::new(),
        card_decorations: Vec::new(),
        container_blocks: Vec::new(),
        mesh,
        material,
        mesh_entity: None,
        blend_mesh,
        blend_material,
        blend_mesh_entity: None,
        font: assets.load("fonts/NotoSansSC-Regular.otf"),
        labels: HashMap::new(),
        textures: HashMap::new(),
        edge_blocks: Vec::new(),
        shared_key: None,
        attach_labels: HashMap::new(),
        attach_probe_mesh,
        attach_probe_entity: None,
        attach_probe_active: false,
        running_mesh,
        running_mesh_entity: None,
        running_labels: HashMap::new(),
        running_active: false,
        node_action_mesh,
        node_action_entity: None,
        node_action_labels: HashMap::new(),
        node_action_active: false,
    });
}

/// 字体 asset 是否已就绪（供 app 发布 ready，本模块不依赖 bridge）。
pub(crate) fn font_ready(fonts: &Assets<Font>, visuals: &Visuals) -> bool {
    fonts.get(&visuals.font).is_some()
}
