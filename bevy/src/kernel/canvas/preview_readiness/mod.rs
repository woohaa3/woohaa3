//! 一次性离屏预览视图的就绪门禁。
//!
//! 历史缩略图（以及任何一次性离屏相机）需要在真实绘制完成后才回读纹理；这里沿用原先
//! 模型卡片预览的就绪判定：在 Render 子应用里只承认「已准备资源 + 该视图排入的绘制阶段
//! 覆盖了可见实体」的连续两帧。
//!
//! 模型卡片预览已删除（change: 2026-11-10-remove-legacy-model-card-nodes），因此本模块只
//! 保留与卡片无关的就绪事实：`PreviewView`（被观察的一次性视图）、`Ready`（已就绪的相机
//! 与 generation）与 `observe` 系统。

use bevy::{
    core_pipeline::core_3d::{AlphaMask3d, Opaque3d, Transparent3d},
    pbr::{PreparedMaterial, SpecializedMaterialPipelineCache},
    prelude::*,
    render::{
        RenderApp, RenderSystems,
        erased_render_asset::ErasedRenderAssets,
        extract_component::{ExtractComponent, ExtractComponentPlugin},
        mesh::RenderMesh,
        render_asset::RenderAssets,
        render_phase::{ViewBinnedRenderPhases, ViewSortedRenderPhases},
        render_resource::{CachedPipelineState, PipelineCache},
        texture::GpuImage,
        view::{ExtractedView, visibility::RenderVisibleEntities},
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// 一次一次性离屏预览视图（历史缩略图等）。
#[derive(Component, Clone, ExtractComponent)]
#[extract_app(RenderApp)]
pub(crate) struct PreviewView {
    pub(crate) camera: Entity,
    pub(crate) generation: u64,
    pub(crate) meshes: Vec<bevy::asset::AssetId<Mesh>>,
    pub(crate) materials: Vec<bevy::asset::AssetId<StandardMaterial>>,
    pub(crate) images: Vec<bevy::asset::AssetId<Image>>,
    /// 该视图对应的模型根此刻是否存在。
    ///
    /// 与「根存在但没有 mesh」区分开：缺失时空画面只表示还没 spawn，不能当作已绘制；
    /// 合法的空模型（根存在、无 mesh）才是有效画面。
    pub(crate) rooted: bool,
}

/// 已就绪的离屏视图（相机实体 → generation）。
#[derive(Resource, Clone, Default)]
pub(crate) struct Ready(Arc<Mutex<HashMap<Entity, u64>>>);

impl Ready {
    pub(crate) fn matches(&self, camera: Entity, generation: u64) -> bool {
        self.0.lock().unwrap().get(&camera).copied() == Some(generation)
    }

    /// 丢弃一次一次性视图的就绪记录。
    pub(crate) fn forget(&self, camera: Entity) {
        self.0.lock().unwrap().remove(&camera);
    }

    #[cfg(test)]
    pub(crate) fn mark_for_test(&self, camera: Entity, generation: u64) {
        self.0.lock().unwrap().insert(camera, generation);
    }
}

/// 一帧渲染对视图绘制状态的证据。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Evidence {
    /// The view queued the subject it was asked to draw.
    Drawn,
    /// The view exists but has not shown its subject yet (assets, pipelines or layers pending).
    Materializing,
    /// The view has no model root at all, so nothing can be drawn until one is spawned.
    AwaitingRoot,
}

/// Classify one frame of an offscreen view.
///
/// An empty frame is only evidence when the model is *legitimately* empty, i.e. the root exists
/// and owns no meshes. A view can exist before its root is spawned (root creation is demand-driven
/// in another system) or before the render layer reaches the root entities; those frames trivially
/// satisfy a bare queue comparison. Publishing readiness on them paints the clear color into the
/// target texture, so the thumbnail stays blank until something else re-arms it.
pub(super) fn evidence(
    prepared: bool,
    phase_present: bool,
    queued: usize,
    expected: usize,
    targets: Option<usize>,
) -> Evidence {
    let Some(targets) = targets else {
        return Evidence::AwaitingRoot;
    };
    let drawn = prepared && phase_present && (targets == 0 || (expected > 0 && queued >= expected));
    if drawn { Evidence::Drawn } else { Evidence::Materializing }
}

/// Consecutive drawn frames required before the texture is published.
const STABLE_FRAMES: u8 = 2;

fn images_ready(ids: &[bevy::asset::AssetId<Image>], mut contains: impl FnMut(bevy::asset::AssetId<Image>) -> bool) -> bool {
    ids.iter().copied().all(&mut contains)
}

/// Render 子应用里的就绪推进系统。
pub(super) fn observe(
    views: Query<(
        &PreviewView,
        &ExtractedView,
        &RenderVisibleEntities,
        &bevy::render::view::ViewTarget,
    )>,
    unprepared: Query<(&PreviewView, &ExtractedView), Without<bevy::render::view::ViewTarget>>,
    materials: Res<ErasedRenderAssets<PreparedMaterial>>,
    meshes: Res<RenderAssets<RenderMesh>>,
    images: Res<RenderAssets<GpuImage>>,
    opaque: Res<ViewBinnedRenderPhases<Opaque3d>>,
    mask: Res<ViewBinnedRenderPhases<AlphaMask3d>>,
    transparent: Res<ViewSortedRenderPhases<Transparent3d>>,
    cache: Res<PipelineCache>,
    specialized: Res<SpecializedMaterialPipelineCache>,
    ready: Res<Ready>,
    mut stable: Local<HashMap<Entity, (u64, u8)>>,
) {
    for (preview, _) in &unprepared {
        ready.forget(preview.camera);
    }
    let mut alive = std::collections::HashSet::new();
    for (preview, view, visible, _target) in &views {
        alive.insert(preview.camera);
        let mut prepared = preview.meshes.iter().all(|id| meshes.get(*id).is_some())
            && preview.materials.iter().all(|id| materials.get(*id).is_some())
            && images_ready(&preview.images, |id| images.get(id).is_some());
        let expected = visible
            .get::<Mesh3d>()
            .map(|class| class.entities_cpu_culling.len() + class.entities_gpu_culling.len())
            .unwrap_or(0);
        let mut queued = 0;
        let mut multidraw = false;
        let key = &view.retained_view_entity;
        let mut phase_present = false;
        if let Some(phase) = opaque.get(key) {
            phase_present = true;
            queued += phase.batchable_meshes.values().map(|bin| bin.entities().len()).sum::<usize>();
            queued += phase.unbatchable_meshes.values().map(|bin| bin.entities.len()).sum::<usize>();
            multidraw |= !phase.multidrawable_meshes.is_empty();
            for batch in phase.multidrawable_meshes.keys() {
                prepared &= matches!(cache.get_render_pipeline_state(batch.pipeline), CachedPipelineState::Ok(_));
            }
            for batch in phase.batchable_meshes.keys().chain(phase.unbatchable_meshes.keys()) {
                prepared &= matches!(cache.get_render_pipeline_state(batch.0.pipeline), CachedPipelineState::Ok(_));
            }
        }
        if let Some(phase) = mask.get(key) {
            phase_present = true;
            queued += phase.batchable_meshes.values().map(|bin| bin.entities().len()).sum::<usize>();
            queued += phase.unbatchable_meshes.values().map(|bin| bin.entities.len()).sum::<usize>();
            multidraw |= !phase.multidrawable_meshes.is_empty();
            for batch in phase.multidrawable_meshes.keys() {
                prepared &= matches!(cache.get_render_pipeline_state(batch.pipeline), CachedPipelineState::Ok(_));
            }
            for batch in phase.batchable_meshes.keys().chain(phase.unbatchable_meshes.keys()) {
                prepared &= matches!(cache.get_render_pipeline_state(batch.0.pipeline), CachedPipelineState::Ok(_));
            }
        }
        if let Some(phase) = transparent.get(key) {
            phase_present = true;
            queued += phase.items.len();
            for (_, item) in &phase.items {
                prepared &= matches!(cache.get_render_pipeline_state(item.pipeline), CachedPipelineState::Ok(_));
            }
        }
        let entry = stable.entry(preview.camera).or_insert((preview.generation, 0));
        if entry.0 != preview.generation {
            *entry = (preview.generation, 0);
        }
        let complete = queued >= expected
            || multidraw
                && crate::shot_camera::preview_readiness::visible_pipelines_ready(
                    visible,
                    specialized.get(key),
                    |id| matches!(cache.get_render_pipeline_state(id), CachedPipelineState::Ok(_)),
                );
        let verdict = evidence(
            prepared && complete,
            phase_present,
            expected,
            expected,
            preview.rooted.then_some(preview.meshes.len()),
        );
        entry.1 = if verdict == Evidence::Drawn { entry.1.saturating_add(1) } else { 0 };
        if entry.1 >= STABLE_FRAMES {
            ready.0.lock().unwrap().insert(preview.camera, preview.generation);
        } else {
            ready.0.lock().unwrap().remove(&preview.camera);
        }
    }
    stable.retain(|entity, _| alive.contains(entity));
}

/// 注册一次性离屏预览的就绪门禁。
pub(crate) struct PreviewReadinessPlugin;

impl Plugin for PreviewReadinessPlugin {
    fn build(&self, app: &mut App) {
        let ready = Ready::default();
        app.insert_resource(ready.clone())
            .add_plugins(ExtractComponentPlugin::<PreviewView>::default());
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render.insert_resource(ready).add_systems(
                bevy::render::Render,
                observe.after(RenderSystems::Prepare).before(RenderSystems::Render),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Evidence::*, evidence};

    #[test]
    fn missing_gpu_image_prevents_readiness() {
        let image = bevy::asset::AssetId::<bevy::prelude::Image>::default();
        assert!(!super::images_ready(&[image], |_| false));
        assert!(super::images_ready(&[image], |_| true));
        assert!(super::images_ready(&[], |_| false));
    }

    #[test]
    fn a_missing_root_never_counts_as_drawn_content() {
        assert_eq!(evidence(true, true, 0, 0, None), AwaitingRoot);
        assert_eq!(evidence(false, false, 0, 0, None), AwaitingRoot);
    }

    #[test]
    fn a_present_root_with_pending_subject_is_not_yet_drawn() {
        assert_eq!(evidence(true, true, 0, 0, Some(3)), Materializing);
        assert_eq!(evidence(true, false, 0, 0, Some(3)), Materializing);
        assert_eq!(evidence(true, true, 2, 3, Some(3)), Materializing);
        assert_eq!(evidence(true, true, 0, 1, Some(3)), Materializing);
        assert_eq!(evidence(false, true, 3, 3, Some(3)), Materializing);
    }

    #[test]
    fn a_queued_subject_is_drawn_once_pipelines_are_prepared() {
        assert_eq!(evidence(true, true, 3, 3, Some(3)), Drawn);
        assert_eq!(evidence(true, true, 4, 3, Some(3)), Drawn);
    }

    #[test]
    fn a_legitimately_empty_model_is_still_a_valid_picture() {
        assert_eq!(evidence(true, true, 0, 0, Some(0)), Drawn);
        assert_eq!(evidence(false, true, 0, 0, Some(0)), Materializing);
    }
}
