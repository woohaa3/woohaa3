//! Editor handles render over scene geometry using a separate depth buffer.
use crate::model3d::{editor::EDITOR_LAYER, grid::ModelCanvasCamera};
use bevy::{
    camera::visibility::RenderLayers,
    prelude::*,
    render::view::{DebandDither, Tonemapping},
};

use super::CurrentScene;

#[derive(Component)]
pub(super) struct EditorOverlayCamera;

/// Director-area chrome is rendered by a separate camera so it stays visible above
/// world geometry without changing the depth ordering of models or roads.
#[derive(Component)]
pub(super) struct DirectorAreaOverlayCamera;

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
        DebandDither::Disabled,
    ));
    commands.spawn((
        Camera3d::default(),
        Camera {
            order: 1,
            is_active: false,
            clear_color: ClearColorConfig::None,
            ..default()
        },
        DirectorAreaOverlayCamera,
        RenderLayers::layer(crate::world_camera_preview::DIRECTOR_AREA_LAYER),
        Tonemapping::None,
        DebandDither::Disabled,
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
    mut director_overlay: Query<
        (&mut Transform, &mut Projection, &mut Camera),
        (
            With<DirectorAreaOverlayCamera>,
            Without<ModelCanvasCamera>,
            Without<EditorOverlayCamera>,
        ),
    >,
) {
    let Ok((mut editor_transform, mut editor_projection, mut editor_camera)) = overlay.single_mut()
    else {
        return;
    };
    let Ok((mut director_transform, mut director_projection, mut director_camera)) =
        director_overlay.single_mut()
    else {
        return;
    };
    // 退出聚焦即停用，包括主观察相机仍在执行退出过渡的帧。
    editor_camera.is_active = false;
    director_camera.is_active = false;
    let Ok((pose, lens, source)) = observer.single() else {
        return;
    };
    if scene.0.model_focus.is_some() {
        *editor_transform = *pose;
        *editor_projection = lens.clone();
        editor_camera.is_active = source.is_active;
        editor_camera.viewport = source.viewport.clone();
    }
    // Director areas are intentionally absent while a focus or camera-edit view owns
    // the canvas. Those views either have their own helper layer or a separate backdrop.
    if scene.0.model_focus.is_some()
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some()
        || scene.0.world_camera_edit.is_some()
    {
        return;
    }
    *director_transform = *pose;
    *director_projection = lens.clone();
    director_camera.is_active = source.is_active;
    director_camera.viewport = source.viewport.clone();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn director_overlay_is_active_on_the_normal_canvas_and_uses_only_its_layer() {
        let mut app = App::new();
        app.init_resource::<CurrentScene>()
            .add_systems(Startup, setup)
            .add_systems(Update, sync);
        app.world_mut().spawn((
            ModelCanvasCamera,
            Camera::default(),
            Transform::default(),
            Projection::Orthographic(crate::isometric_grid::canvas_camera_projection()),
        ));
        app.update();
        let mut query = app
            .world_mut()
            .query_filtered::<(&Camera, &RenderLayers), With<DirectorAreaOverlayCamera>>();
        let (camera, layers) = query.single(app.world()).expect("director overlay camera");
        assert!(camera.is_active);
        assert_eq!(
            layers,
            &RenderLayers::layer(crate::world_camera_preview::DIRECTOR_AREA_LAYER)
        );
    }
}
