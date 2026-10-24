//! 媒体聚焦的透明棋盘格
//!
//! 节点文档的画布是**透明交互层**：编辑器只发布 RGBA 纹理，DOM 面板浮在 Bevy 之上。
//! 没有这层棋盘格时，矢量蒙版/图层蒙版裁出来的透明区域会直接露出应用的网格背景 ——
//! 看起来像「蒙版把图层藏了」，而不是「这里本来是透明的」（2026-10-24 审片 A5）。
//!
//! 只在存在已呈现的媒体聚焦时出现，并且和聚焦素材占**同一块世界矩形**（同一个中心与尺寸），
//! 因此画布缩放/平移时始终对齐，不会盖到别处。实体存在 `Visuals` 上（和背景遮罩一致），
//! 不依赖系统私有的 `Local`，这样「出现 → 消失 → 再出现」都能正确重建。

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

use super::Visuals;
use crate::app::{CurrentScene, FrameFlags};
use crate::canvas_query::layout::{content_center, texture_size};
use crate::canvas_query::media_focus::{foreground_z, presented_media_focus};

/// 棋盘纹理的一格边长（世界/文档像素）。
const CHECKER_CELL: u32 = 16;
const CHECKER_LIGHT: [u8; 3] = [242, 242, 242];
const CHECKER_DARK: [u8; 3] = [214, 214, 214];

#[derive(Component)]
pub(crate) struct MediaAlphaChecker;

/// 棋盘纹理句柄只建一次（2×2 格），由 `Tiled` 模式铺满聚焦矩形。
#[derive(Resource, Default)]
pub(crate) struct MediaAlphaCheckerTexture(pub Option<Handle<Image>>);

fn checker_texture() -> Image {
    let cell = CHECKER_CELL;
    let side = cell * 2;
    let mut data = vec![0u8; (side * side * 4) as usize];
    for y in 0..side {
        for x in 0..side {
            let dark = ((x / cell) + (y / cell)) % 2 == 1;
            let color = if dark { CHECKER_DARK } else { CHECKER_LIGHT };
            let offset = ((y * side + x) * 4) as usize;
            data[offset..offset + 3].copy_from_slice(&color);
            data[offset + 3] = 255;
        }
    }
    Image::new(
        Extent3d { width: side, height: side, depth_or_array_layers: 1 },
        TextureDimension::D2,
        data,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::default(),
    )
}

pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    flags: Res<FrameFlags>,
    mut images: ResMut<Assets<Image>>,
    mut texture: ResMut<MediaAlphaCheckerTexture>,
    mut visuals: ResMut<Visuals>,
    mut sprites: Query<(&mut Sprite, &mut Transform), With<MediaAlphaChecker>>,
) {
    if !flags.camera_changed && !flags.changed {
        return;
    }
    let scene = &scene.0;
    let entity = visuals.media_alpha_checker;
    let focus = presented_media_focus(scene);
    let node = focus
        .as_ref()
        .and_then(|focus| scene.nodes.iter().find(|node| node.id == focus.node_id));
    let (Some(focus), Some(node)) = (focus, node) else {
        if let Some(previous) = entity {
            commands.entity(previous).despawn();
            visuals.media_alpha_checker = None;
        }
        return;
    };
    // 与聚焦素材渲染矩形一致：节点内容框内按原图比例 contain。
    let size = texture_size(node, Vec2::new(focus.source_width, focus.source_height));
    let center = content_center(node);
    if !size.x.is_finite() || !size.y.is_finite() || size.x <= 1.0 || size.y <= 1.0 {
        return;
    }
    let handle = match &texture.0 {
        Some(handle) => handle.clone(),
        None => {
            let handle = images.add(checker_texture());
            texture.0 = Some(handle.clone());
            handle
        }
    };
    // 在聚焦素材正下方：素材本身仍是透明交互层，透明像素透出这层格子。
    let transform = Transform::from_xyz(center.x, -center.y, foreground_z(scene) - 0.5);
    let image_mode = SpriteImageMode::Tiled { tile_x: true, tile_y: true, stretch_value: 1.0 };
    if let Some(previous) = entity {
        if let Ok((mut sprite, mut placed)) = sprites.get_mut(previous) {
            sprite.image = handle;
            sprite.custom_size = Some(size);
            sprite.image_mode = image_mode;
            *placed = transform;
            return;
        }
    }
    visuals.media_alpha_checker = Some(
        commands
            .spawn((
                MediaAlphaChecker,
                Sprite { image: handle, custom_size: Some(size), image_mode, color: Color::WHITE, ..Default::default() },
                transform,
            ))
            .id(),
    );
}

#[cfg(test)]
mod tests;
