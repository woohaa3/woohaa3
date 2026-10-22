//! Editor handles render over scene geometry using a separate depth buffer.
use crate::model3d::{editor::EDITOR_LAYER, grid::ModelCanvasCamera};
use bevy::{camera::visibility::RenderLayers, prelude::*, render::view::Tonemapping};

use super::CurrentScene;

#[derive(Component)]
pub(super) struct EditorOverlayCamera;

pub(super) fn setup(mut commands: Commands) {
    commands.spawn((
        Camera3d::default(),
        Camera {
            order: 1,
            is_active: false,
            clear_color: ClearColorConfig::None,
            ..default()
        },
        EditorOverlayCamera,
        RenderLayers::layer(EDITOR_LAYER),
        Tonemapping::None,
    ));
}

pub(super) fn sync(
    scene: Res<CurrentScene>,
    observer: Query<
        (&Transform, &Projection, &Camera),
        (With<ModelCanvasCamera>, Without<EditorOverlayCamera>),
    >,
    mut overlay: Query<
        (&mut Transform, &mut Projection, &mut Camera),
        (With<EditorOverlayCamera>, Without<ModelCanvasCamera>),
    >,
) {
    let Ok((mut transform, mut projection, mut camera)) = overlay.single_mut() else {
        return;
    };
    // 退出聚焦即停用，包括主观察相机仍在执行退出过渡的帧。
    camera.is_active = false;
    if scene.0.model_focus.is_none() {
        return;
    }
    let Ok((pose, lens, source)) = observer.single() else {
        return;
    };
    *transform = *pose;
    *projection = lens.clone();
    camera.is_active = source.is_active;
    camera.viewport = source.viewport.clone();
}
