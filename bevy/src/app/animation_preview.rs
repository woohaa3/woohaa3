//! Consume the sampled camera after rig derivation and before preview rendering.
use super::{AnimationCameraState, CurrentScene, FrameFlags, ModelAssetTable};
use crate::model3d::{
    ModelVisuals,
    shot_adapter::{ShotAdapterState, focused_model_bounds, sampled_camera_pose},
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
    // 与 overview 辅助实体共用同一 pose 派生（design D2），避免第二套取景公式。
    // 采样镜头是**场景单位**：这里按片场的显示变换映射为画布世界姿态
    // （change: 2026-10-23-isolate-film-set-camera-space，任务 2.2）。
    let display = adapter.node_id.as_deref().and_then(|node_id| {
        crate::model3d::shot_adapter::display_unit_for_node(&scene.0, &resources.0, node_id)
    });
    let Some((focus, position)) = sampled_camera_pose(bounds, display, &camera) else {
        return;
    };
    let Ok(mut derived) = rigs.get_mut(entity) else {
        return;
    };
    let key = (playback.generation, playback.time.to_bits());
    if derived.focus != focus
        || derived.position != position
        || *last_sample != Some(key)
        || flags.film_set_media_changed
    {
        derived.focus = focus;
        derived.position = position;
        derived.generation = derived.generation.wrapping_add(1);
        *last_sample = Some(key);
    }
}

/// 同步拍摄镜头相机标记集合
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.1 / design D5）。
///
/// 在运动求值（`sync_models` 写入 `AnimationCameraState`）之后、渲染预览之前运行；为每个可见
/// 拍摄镜头派生稳定标记（静态/非活动用零点封面相机，活动动态用同一 T 的采样相机）。只消费已
/// 接受场景与共享姿态派生，不订阅 hover、不自行开播。聚焦隔离与不合法目标都不显示标记。
#[allow(clippy::too_many_arguments)]
pub(super) fn sync_film_set_camera(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut assets: ResMut<crate::model3d::filmset_camera::FilmSetCameraAssets>,
    markers: Query<(Entity, &crate::canvas_ecs::components::FilmSetCameraMarker)>,
    scene: Res<CurrentScene>,
    sampled: Res<AnimationCameraState>,
    models: Res<ModelVisuals>,
    resources: Res<ModelAssetTable>,
) {
    // 从 ECS 派生本帧视图：Resource 不再保存「预览节点 → 标记实体」第二份 owner map。
    let markers: Vec<(Entity, crate::canvas_ecs::components::FilmSetCameraMarker)> = markers
        .iter()
        .map(|(entity, marker)| (entity, marker.clone()))
        .collect();
    crate::model3d::filmset_camera::sync(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut assets,
        &markers,
        &scene.0,
        sampled.0,
        &models,
        &resources.0,
    );
}
