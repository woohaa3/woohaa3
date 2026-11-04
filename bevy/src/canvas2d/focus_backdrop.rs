//! 媒体聚焦背景遮罩：保留原画布，当前素材在遮罩之上。
use crate::app::{CurrentScene, FrameFlags};
use crate::canvas_ecs::components::MediaBackdrop;
use crate::canvas_query::media_focus::{backdrop_rect, foreground_z};
use crate::theme::ThemeResource;
use bevy::prelude::*;

/// 复用一张纯色 Sprite，不参与命中，也不创建 DOM 或额外相机。
pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
    mut sprites: Query<(Entity, &mut Sprite, &mut Transform), With<MediaBackdrop>>,
) {
    if !flags.camera_changed
        && !(flags.scene_received
            || flags.positions_received
            || flags.surface_changed
            || flags.theme_changed)
        && !scene.is_changed()
    {
        return;
    }
    let Some([x, y, width, height]) = backdrop_rect(&scene.0) else {
        for (entity, _, _) in &sprites {
            commands.entity(entity).despawn();
        }
        return;
    };
    let size = Vec2::new(width, height);
    let color = theme.token_color("webOverlay");
    let transform = Transform::from_xyz(
        x + width / 2.0,
        -(y + height / 2.0),
        foreground_z(&scene.0) - 0.1,
    );
    if let Some((_, mut sprite, mut current_transform)) = sprites.iter_mut().next() {
        sprite.color = color;
        sprite.custom_size = Some(size);
        *current_transform = transform;
        return;
    }
    commands.spawn((MediaBackdrop, Sprite::from_color(color, size), transform));
}
