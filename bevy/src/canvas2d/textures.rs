//! 纹理批次消费与 Sprite 生命周期
//! （change: refactor-bevy-rust-file-size，任务 3.1 / design D3；
//!  change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— Sprite 归属改为
//!  `CanvasTextureSprite` owner 组件，节点删除/换源按 owner 查询回收，不再保存
//!  `HashMap<String, Entity>`）。
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
use crate::canvas_ecs::components::{CanvasNodeId, CanvasTextureSprite};

use super::texture_store::TextureAction;
use super::Visuals;

/// 消费本帧 keyed 纹理批次并回收不再挂载的 Sprite。
pub(crate) fn sync_textures(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    mut visuals: ResMut<Visuals>,
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<TextureBatch>,
    nodes: Query<(Entity, &CanvasNodeId)>,
    mut sprites: Query<(
        Entity,
        &mut Sprite,
        &mut Transform,
        &mut CanvasTextureSprite,
    )>,
) {
    let by_id: std::collections::HashMap<&str, Entity> = nodes
        .iter()
        .map(|(entity, id)| (id.0.as_str(), entity))
        .collect();
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
        let Some(owner) = by_id.get(id.as_str()).copied() else {
            continue;
        };
        let texture_px = Vec2::new(width as f32, height as f32);
        let content = content.as_deref();
        // 同内容同尺寸已有共享纹理：只把该节点绑过去，不重复建 GPU 资源。
        let existing = sprites
            .iter()
            .find(|(_, _, _, sprite)| sprite.owner == owner)
            .map(|(entity, _, _, sprite)| (entity, sprite.node_id.clone(), sprite.content_id.clone()));
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
                match existing.clone() {
                    // 同尺寸的既有纹理：原地覆盖，保留 handle 与 Sprite。
                    Some((entity, _, _)) => {
                        let previous = sprites
                            .get(entity)
                            .ok()
                            .map(|(_, sprite, _, _)| sprite.image.clone());
                        match previous {
                            Some(previous) if images.contains(previous.id()) => {
                                images.insert(previous.id(), image);
                                previous
                            }
                            _ => images.add(image),
                        }
                    }
                    // 新节点：新建 handle；旧 handle 交给共享表决定是否释放。
                    None => images.add(image),
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
        let display = crate::canvas_query::focus_context::node(scene, node);
        let index = crate::canvas_query::focus_context::index(scene, &node.id, index);
        let overlay = crate::canvas_query::focus_context::overlay(scene);
        let shown = scene.model_focus.is_none();
        let visibility = if shown {
            Visibility::Inherited
        } else {
            Visibility::Hidden
        };
        let (custom_size, center, color, z) =
            super::image_focus::sprite_layout(&overlay, &display, texture_px, index);
        match existing {
            Some((entity, _, _)) => {
                commands.entity(entity).insert(visibility);
                if let Ok((_, mut sprite, mut transform, mut owner_component)) =
                    sprites.get_mut(entity)
                {
                    sprite.image = handle.clone();
                    sprite.custom_size = Some(custom_size);
                    sprite.color = color;
                    transform.translation = Vec3::new(center.x, -center.y, z);
                    owner_component.content_id = content.map(str::to_owned);
                }
            }
            None => {
                commands.spawn((
                    Sprite {
                        image: handle.clone(),
                        custom_size: Some(custom_size),
                        // 运行中上传的纹理先隐藏，避免盖住进度环
                        // （change: add-node-running-progress）。
                        color,
                        ..default()
                    },
                    Transform::from_xyz(center.x, -center.y, z),
                    visibility,
                    CanvasTextureSprite {
                        owner,
                        node_id: id.clone(),
                        content_id: content.map(str::to_owned),
                    },
                    Name::new(format!("canvas-texture:{id}")),
                ));
            }
        }
    }
    // 节点删除/类型替换/不再显示纹理：回收 Sprite 并让共享表释放本节点引用。
    let mut stale = Vec::new();
    for (entity, _, _, sprite) in &sprites {
        let alive = by_id.contains_key(sprite.node_id.as_str())
            && index
                .node(&scene.0, &sprite.node_id)
                .is_some_and(|(_, node)| node.texture);
        if !alive {
            stale.push((entity, sprite.node_id.clone()));
        }
    }
    for (entity, id) in stale {
        commands.entity(entity).despawn();
        for released in visuals.texture_store.release(&id) {
            images.remove(released.id());
        }
    }
}
