//! 纹理批次消费与 Sprite 生命周期
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3）。
//!
//! change: 2026-10-23-scale-canvas-media-residency（design D4 / 任务 4.4）：GPU 纹理按
//! **内容身份 + 尺寸**共享，`nodeId` 只是绑定实例。1000 个引用同一资产的卡片不再各建一份
//! `Image`；渲染代际恢复时若同内容已驻留，只重新绑定 Sprite，不必重传像素。
//!
//! 释放逐层进行：节点删除/换源/换档只解绑自己，最后一个引用结束才 `images.remove`。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

use crate::app::TextureBatch;

use super::texture_store::TextureAction;
use super::Visuals;

/// 消费本帧 keyed 纹理批次；即使 scene/surface 未变也必须执行。
pub(crate) fn sync_textures(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    mut visuals: ResMut<Visuals>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<TextureBatch>,
    mut sprites: Query<(&mut Sprite, &mut Transform)>,
) {
    let ids: Vec<String> = batch.0.keys().cloned().collect();
    for id in ids {
        let Some((width, height, rgba, content)) = batch.0.remove(&id) else {
            continue;
        };
        let scene = &scene.0;
        // 同代节点索引：按 id 定位，替代逐纹理全文档线性 find
        // （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 7.2）。
        let Some((index, node)) = index.node(scene, &id).filter(|(_, node)| node.texture) else {
            continue;
        };
        let texture_px = Vec2::new(width as f32, height as f32);
        let content = content.as_deref();
        // 同内容同尺寸已有共享纹理：只把该节点绑过去，不重复建 GPU 资源。
        let handle = match visuals.texture_store.resolve(content, texture_px) {
            TextureAction::Reused(shared) => shared,
            TextureAction::Fresh => {
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
                match visuals.textures.get(&id).cloned() {
                    // 同尺寸的既有纹理：原地覆盖，保留 handle 与 Sprite。
                    Some((_entity, previous, previous_size))
                        if previous_size == texture_px && images.contains(previous.id()) =>
                    {
                        images.insert(previous.id(), image);
                        previous
                    }
                    // 换尺寸/新节点：新建 handle；旧 handle 交给共享表决定是否释放。
                    existing => {
                        let next = images.add(image);
                        if let Some((entity, previous, _)) = existing {
                            if let Ok((mut sprite, _)) = sprites.get_mut(entity) {
                                sprite.image = next.clone();
                            }
                            if previous != next {
                                images.remove(previous.id());
                            }
                        }
                        next
                    }
                }
            }
        };
        // 共享表里换绑可能释放旧 handle（同内容换 handle / 换源 / 换档）。
        let released = visuals
            .texture_store
            .bind(&id, content, texture_px, handle.clone());
        for stale in released {
            if stale != handle {
                images.remove(stale.id());
            }
        }
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(scene, node, texture_px, index);
        match visuals.textures.get(&id).cloned() {
            Some((entity, _, _)) => {
                if let Ok((mut sprite, mut transform)) = sprites.get_mut(entity) {
                    sprite.image = handle.clone();
                    sprite.custom_size = Some(custom_size);
                    sprite.color = color;
                    transform.translation = Vec3::new(center.x, -center.y, z);
                }
                visuals.textures.insert(id, (entity, handle, texture_px));
            }
            None => {
                let entity = commands
                    .spawn((
                        Sprite {
                            image: handle.clone(),
                            custom_size: Some(custom_size),
                            // 运行中上传的纹理先隐藏，避免盖住进度环
                            // （change: add-node-running-progress）。
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
}
