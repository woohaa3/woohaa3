//! 原图片节点的区域纹理替换，沿用同一 Camera2d，基础图与细节不重叠。
use super::Visuals;
use crate::{
    app::CurrentScene,
    protocol::focus_details::{FocusDetailUpload, FocusDetails},
};
use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};
use std::sync::Arc;

#[derive(Resource, Default)]
pub(crate) struct FocusDetailBatch(pub Option<Option<FocusDetailUpload>>);
#[derive(Resource, Default)]
pub(crate) struct FocusDetailVisuals {
    frame: Option<FocusDetails>,
    details: Vec<(Entity, Handle<Image>, [u32; 4], Arc<[u8]>)>,
    base: Vec<(Entity, [u32; 4])>,
}

fn layout(rect: [u32; 4], source: Vec2, size: Vec2, center: Vec2, z: f32) -> (Vec2, Transform) {
    let a = Vec2::new(rect[0] as f32, rect[1] as f32);
    let b = Vec2::new(rect[2] as f32, rect[3] as f32);
    let offset = ((a + b) * 0.5 / source - Vec2::splat(0.5)) * size;
    (
        (b - a) / source * size,
        Transform::from_xyz(center.x + offset.x, -center.y - offset.y, z),
    )
}
fn clear(state: &mut FocusDetailVisuals, commands: &mut Commands, images: &mut Assets<Image>) {
    for (entity, handle, _, _) in state.details.drain(..) {
        commands.entity(entity).despawn();
        images.remove(handle.id());
    }
    for (entity, _) in state.base.drain(..) {
        commands.entity(entity).despawn();
    }
    state.frame = None;
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    visuals: Res<Visuals>,
    mut batch: ResMut<FocusDetailBatch>,
    mut state: ResMut<FocusDetailVisuals>,
    mut images: ResMut<Assets<Image>>,
    mut sprites: Query<(&mut Sprite, &mut Transform)>,
) {
    // 每帧先恢复上次替换的基础 Sprite；仅有效细节会在下面重新隐藏它。
    // 同代节点索引按 id O(1) 定位（change: 2026-10-23-scale-canvas-media-residency，任务 7.2）。
    if let Some(frame) = &state.frame {
        if let Some((entity, _, px)) = visuals.textures.get(&frame.node_id) {
            if let Some((index, node)) = index.node(&scene.0, &frame.node_id) {
                if let Ok((mut sprite, _)) = sprites.get_mut(*entity) {
                    sprite.color = super::image_focus::sprite_layout(&scene.0, node, *px, index).2;
                }
            }
        }
    }
    if let Some(next) = batch.0.take() {
        if let Some(upload) = next {
            let compatible = state.frame.as_ref().is_some_and(|old| {
                old.node_id == upload.frame.node_id
                    && old.width == upload.frame.width
                    && old.height == upload.frame.height
            });
            if !compatible {
                clear(&mut state, &mut commands, &mut images);
            }
            // 覆盖范围变化才重建基础分片；未变化的内部纹理与实体保留。
            if state
                .frame
                .as_ref()
                .is_some_and(|old| old.bounds() != upload.frame.bounds())
            {
                for (entity, _) in state.base.drain(..) {
                    commands.entity(entity).despawn();
                }
            }
            let mut previous = std::mem::take(&mut state.details);
            for (tile, pixels) in upload.frame.tiles.iter().zip(upload.pixels) {
                let rect = tile.rect();
                if let Some(index) = previous
                    .iter()
                    .position(|(_, _, old, data)| *old == rect && Arc::ptr_eq(data, &pixels))
                {
                    state.details.push(previous.swap_remove(index));
                    continue;
                }
                let image = Image::new(
                    Extent3d {
                        width: tile.width,
                        height: tile.height,
                        depth_or_array_layers: 1,
                    },
                    TextureDimension::D2,
                    pixels.to_vec(),
                    TextureFormat::Rgba8UnormSrgb,
                    RenderAssetUsages::default(),
                );
                let handle = images.add(image);
                let entity = commands
                    .spawn((
                        Sprite {
                            image: handle.clone(),
                            color: Color::NONE,
                            ..default()
                        },
                        Transform::default(),
                    ))
                    .id();
                state.details.push((entity, handle, rect, pixels));
            }
            for (entity, handle, _, _) in previous {
                commands.entity(entity).despawn();
                images.remove(handle.id());
            }
            state.frame = Some(upload.frame);
        } else {
            clear(&mut state, &mut commands, &mut images);
        }
    }
    let Some(frame) = &state.frame else {
        return;
    };
    let valid = scene.0.image_focus.as_ref().is_some_and(|f| {
        f.presentation_ready
            && f.node_id == frame.node_id
            && f.source_width == frame.width as f32
            && f.source_height == frame.height as f32
    });
    if !valid {
        clear(&mut state, &mut commands, &mut images);
        return;
    }
    let Some((base_entity, base_handle, px)) = visuals.textures.get(&frame.node_id) else {
        clear(&mut state, &mut commands, &mut images);
        return;
    };
    let Some((index, node)) = index
        .node(&scene.0, &frame.node_id)
        .filter(|(_, n)| n.texture)
    else {
        clear(&mut state, &mut commands, &mut images);
        return;
    };
    let (size, center, color, z) = super::image_focus::sprite_layout(&scene.0, node, *px, index);
    let source = Vec2::new(frame.width as f32, frame.height as f32);
    if let Ok((mut sprite, _)) = sprites.get_mut(*base_entity) {
        sprite.color = Color::NONE;
    }
    if state.base.is_empty() {
        for rect in frame.base_regions() {
            let (custom_size, transform) = layout(rect, source, size, center, z);
            let uv = |x: u32, y: u32| Vec2::new(x as f32, y as f32) / source * *px;
            let entity = commands
                .spawn((
                    Sprite {
                        image: base_handle.clone(),
                        custom_size: Some(custom_size),
                        rect: Some(Rect::from_corners(
                            uv(rect[0], rect[1]),
                            uv(rect[2], rect[3]),
                        )),
                        color,
                        ..default()
                    },
                    transform,
                ))
                .id();
            state.base.push((entity, rect));
        }
    }
    for (entity, rect) in &state.base {
        if let Ok((mut sprite, mut transform)) = sprites.get_mut(*entity) {
            let (custom_size, next) = layout(*rect, source, size, center, z);
            let uv = |x: u32, y: u32| Vec2::new(x as f32, y as f32) / source * *px;
            sprite.rect = Some(Rect::from_corners(
                uv(rect[0], rect[1]),
                uv(rect[2], rect[3]),
            ));
            sprite.image = base_handle.clone();
            sprite.custom_size = Some(custom_size);
            sprite.color = color;
            *transform = next;
        }
    }
    for (entity, handle, rect, _) in &state.details {
        let (custom_size, transform) = layout(*rect, source, size, center, z);
        // 新实体在 Commands 应用前尚不可查询，直接写入最终组件，避免空白首帧。
        commands.entity(*entity).insert((
            Sprite {
                image: handle.clone(),
                custom_size: Some(custom_size),
                color,
                ..default()
            },
            transform,
        ));
    }
}
