//! 2D camera、字体与共享 mesh/material 初始化
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3）。


use bevy::sprite_render::AlphaMode2d;
use bevy::{prelude::*, render::view::Tonemapping};

use super::CanvasOverlayCache;
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
    let font = assets.load("fonts/NotoSansSC-Regular.otf");
    commands.insert_resource(super::CanvasMaterials {
        solid: material.clone(),
        blend: blend_material.clone(),
        font: font.clone(),
    });
    commands.insert_resource(CanvasOverlayCache {
        mesh,
        material,
        mesh_entity: None,
        blend_mesh,
        blend_material,
        blend_mesh_entity: None,
        font,
        shared_key: None,
    });
    commands.insert_resource(super::TextureStore::default());
    commands.insert_resource(super::CardDecorationCache::default());
    commands.insert_resource(super::CardBlockCache::default());
    commands.insert_resource(super::EdgeBlockCache::default());
}

/// 字体 asset 是否已就绪（供 app 发布 ready，本模块不依赖 bridge）。
pub(crate) fn font_ready(fonts: &Assets<Font>, visuals: &CanvasOverlayCache) -> bool {
    fonts.get(&visuals.font).is_some()
}
