//! Consume the sampled camera after rig derivation and before preview rendering.
use super::{AnimationCameraState, CurrentScene, FrameFlags, ModelAssetTable};
use crate::model3d::{
    shot_adapter::{focused_model_bounds, sampled_camera_pose, ShotAdapterState},
    ModelVisuals,
};
use crate::shot_camera::ShotCameraDerived;
use bevy::prelude::*;

pub(super) fn apply_sampled_camera(
    scene: Res<CurrentScene>,
    sampled: Res<AnimationCameraState>,
    adapter: Res<ShotAdapterState>,
    models: Res<ModelVisuals>,
    resources: Res<ModelAssetTable>,
    mut rigs: Query<&mut ShotCameraDerived>,
    flags: Res<FrameFlags>,
    mut last_sample: Local<Option<(u32, u32)>>,
) {
    let Some(playback) = scene
        .0
        .animation_playback
        .as_ref()
        .filter(|p| p.view_mode == "focus-preview")
    else {
        *last_sample = None;
        return;
    };
    let (Some(camera), Some(entity), Some(bounds)) = (
        sampled.0,
        adapter.rig,
        focused_model_bounds(&scene.0, &models, &resources.0),
    ) else {
        return;
    };
    let Some((focus, position)) = sampled_camera_pose(bounds, &camera) else {
        return;
    };
    let Ok(mut derived) = rigs.get_mut(entity) else {
        return;
    };
    let key = (playback.generation, playback.time.to_bits());
    if derived.focus != focus
        || derived.position != position
        || *last_sample != Some(key)
        || flags.model_textures_changed
    {
        derived.focus = focus;
        derived.position = position;
        derived.generation = derived.generation.wrapping_add(1);
        *last_sample = Some(key);
    }
}
