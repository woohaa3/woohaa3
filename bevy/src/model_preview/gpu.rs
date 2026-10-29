use super::{PreviewView, Ready};
use bevy::{
    core_pipeline::core_3d::{AlphaMask3d, Opaque3d, Transparent3d},
    pbr::{PreparedMaterial, SpecializedMaterialPipelineCache},
    prelude::*,
    render::{
        erased_render_asset::ErasedRenderAssets,
        mesh::RenderMesh,
        render_asset::RenderAssets,
        render_phase::{ViewBinnedRenderPhases, ViewSortedRenderPhases},
        render_resource::{CachedPipelineState, PipelineCache},
        view::{ExtractedView, visibility::RenderVisibleEntities},
    },
};
use std::collections::HashMap;

/// What one render frame proves about a card view.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Evidence {
    /// The view queued the subject it was asked to draw.
    Drawn,
    /// The view exists but has not shown its subject yet (assets, pipelines or layers pending).
    Materializing,
    /// The card has no model root at all, so nothing can be drawn until one is spawned.
    AwaitingRoot,
}

/// Classify one frame of a card view.
///
/// An empty frame is only evidence when the model is *legitimately* empty, i.e. the root exists
/// and owns no meshes. A card can hold a view before its root is spawned (root creation is
/// demand-driven in another system) or before the card layer reaches the root entities; those
/// frames trivially satisfy a bare queue comparison. Publishing readiness on them paints the
/// clear color into the card texture and deactivates the camera, so the card stays blank until
/// something else re-arms it — which is only observable as "the model appears on hover".
///
/// While a real subject is missing the camera stays in the bounded active set so the pass can
/// become correct on its own; readiness is what releases it afterwards.
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
    if drawn {
        Evidence::Drawn
    } else {
        Evidence::Materializing
    }
}

/// Consecutive drawn frames required before the texture is published.
const STABLE_FRAMES: u8 = 2;

#[cfg(test)]
mod tests {
    use super::{Evidence::*, evidence};

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

// Keep the camera active through asset upload and shader compilation. Only stop
// after two prepared frames so the texture actually contains the current view.
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
    opaque: Res<ViewBinnedRenderPhases<Opaque3d>>,
    mask: Res<ViewBinnedRenderPhases<AlphaMask3d>>,
    transparent: Res<ViewSortedRenderPhases<Transparent3d>>,
    cache: Res<PipelineCache>,
    specialized: Res<SpecializedMaterialPipelineCache>,
    ready: Res<Ready>,
    mut stable: Local<HashMap<Entity, (u64, u8)>>,
) {
    for (preview, _) in &unprepared {
        ready.0.lock().unwrap().remove(&preview.camera);
    }
    let mut alive = std::collections::HashSet::new();
    for (preview, view, visible, _target) in &views {
        alive.insert(preview.camera);
        let mut prepared = preview.meshes.iter().all(|id| meshes.get(*id).is_some())
            && preview
                .materials
                .iter()
                .all(|id| materials.get(*id).is_some());
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
            queued += phase
                .batchable_meshes
                .values()
                .map(|bin| bin.entities().len())
                .sum::<usize>();
            queued += phase
                .unbatchable_meshes
                .values()
                .map(|bin| bin.entities.len())
                .sum::<usize>();
            multidraw |= !phase.multidrawable_meshes.is_empty();
            for batch in phase.multidrawable_meshes.keys() {
                prepared &= matches!(
                    cache.get_render_pipeline_state(batch.pipeline),
                    CachedPipelineState::Ok(_)
                );
            }
            for batch in phase
                .batchable_meshes
                .keys()
                .chain(phase.unbatchable_meshes.keys())
            {
                prepared &= matches!(
                    cache.get_render_pipeline_state(batch.0.pipeline),
                    CachedPipelineState::Ok(_)
                );
            }
        }
        if let Some(phase) = mask.get(key) {
            phase_present = true;
            queued += phase
                .batchable_meshes
                .values()
                .map(|bin| bin.entities().len())
                .sum::<usize>();
            queued += phase
                .unbatchable_meshes
                .values()
                .map(|bin| bin.entities.len())
                .sum::<usize>();
            multidraw |= !phase.multidrawable_meshes.is_empty();
            for batch in phase.multidrawable_meshes.keys() {
                prepared &= matches!(
                    cache.get_render_pipeline_state(batch.pipeline),
                    CachedPipelineState::Ok(_)
                );
            }
            for batch in phase
                .batchable_meshes
                .keys()
                .chain(phase.unbatchable_meshes.keys())
            {
                prepared &= matches!(
                    cache.get_render_pipeline_state(batch.0.pipeline),
                    CachedPipelineState::Ok(_)
                );
            }
        }
        if let Some(phase) = transparent.get(key) {
            phase_present = true;
            queued += phase.items.len();
            for (_, item) in &phase.items {
                prepared &= matches!(
                    cache.get_render_pipeline_state(item.pipeline),
                    CachedPipelineState::Ok(_)
                );
            }
        }
        let entry = stable
            .entry(preview.camera)
            .or_insert((preview.generation, 0));
        if entry.0 != preview.generation {
            *entry = (preview.generation, 0);
        }
        let complete = queued >= expected
            || multidraw
                && crate::shot_camera::preview_readiness::visible_pipelines_ready(
                    visible,
                    specialized.get(key),
                    |id| {
                        matches!(
                            cache.get_render_pipeline_state(id),
                            CachedPipelineState::Ok(_)
                        )
                    },
                );
        let verdict = evidence(
            prepared && complete,
            phase_present,
            expected,
            expected,
            preview.rooted.then_some(preview.meshes.len()),
        );
        entry.1 = if verdict == Evidence::Drawn {
            entry.1.saturating_add(1)
        } else {
            0
        };
        if entry.1 >= STABLE_FRAMES {
            ready
                .0
                .lock()
                .unwrap()
                .insert(preview.camera, preview.generation);
        } else {
            ready.0.lock().unwrap().remove(&preview.camera);
        }
    }
    stable.retain(|entity, _| alive.contains(entity));
}
