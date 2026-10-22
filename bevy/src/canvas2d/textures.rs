//! 纹理批次消费与 Sprite 生命周期
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3）。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

use crate::app::TextureBatch;

use super::Visuals;

/// 消费本帧 keyed 纹理批次；即使 scene/surface 未变也必须执行。
pub(crate) fn sync_textures(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    mut visuals: ResMut<Visuals>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<TextureBatch>,
    mut sprites: Query<&mut Sprite>,
) {
    for (id, (width, height, rgba)) in batch.0.drain() {
        let scene = &scene.0;
        let Some(node) = scene.nodes.iter().find(|n| n.id == id && n.texture) else {
            continue;
        };
        let image = Image::new(
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            rgba,
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::default(),
        );
        let texture_px = Vec2::new(width as f32, height as f32);
        if let Some((entity, handle, previous_size)) = visuals.textures.get_mut(&id) {
            if *previous_size != texture_px {
                // 聚焦和卡片使用不同分辨率。换尺寸时换 handle，使 Sprite 的 GPU
                // bind group 同步换到新纹理，避免继续采样旧尺寸的最后一帧。
                let next_handle = images.add(image);
                if let Ok(mut sprite) = sprites.get_mut(*entity) {
                    sprite.image = next_handle.clone();
                }
                let previous_handle = std::mem::replace(handle, next_handle);
                images.remove(previous_handle.id());
                *previous_size = texture_px;
            } else {
                images.insert(handle.id(), image).unwrap();
            }
        } else {
            let handle = images.add(image);
            let index = scene.nodes.iter().position(|n| n.id == id).unwrap_or(0);
            // 聚焦纹理在遮罩之上，其他纹理保留原画布位置和层级
            // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2/4.3）。
            let (content, center, color, z) =
                super::image_focus::sprite_layout(scene, node, texture_px, index);
            let entity = commands
                .spawn((
                    Sprite {
                        image: handle.clone(),
                        custom_size: Some(content),
                        // 运行中上传的纹理先隐藏，避免盖住进度环（change: add-node-running-progress）。
                        color,
                        ..default()
                    },
                    Transform::from_xyz(center.x, -center.y, z),
                ))
                .id();
            visuals.textures.insert(id, (entity, handle, texture_px));
        }
    }
}
