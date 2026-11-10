//! Shot camera preview 的 GPU 就绪代数
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
//!
//! 预览卡片直接采样离屏 `RenderTarget::Image`，因此「画面何时可以发布」必须由**渲染侧**
//! 确认，而不是 CPU 侧发起渲染就当作完成。本模块沿用离屏预览就绪（`preview_readiness`）已验证的同一模式：
//!
//! - 宿主每帧把 [`ShotPreviewReadiness`] 写到**预览相机实体**上（相机 + 稳定 key + 请求代数 +
//!   当前目标 mesh/material）；写在相机实体上是因为只有相机才会被提取出 `ExtractedView`；
//! - `ExtractComponentPlugin` 把它搬到 render world；
//! - render world 在 `Render` 阶段对照可见实体、已准备 pipeline 与 mesh/material GPU 资产，
//!   连续两帧稳定后才把 `(key, generation)` 写入 [`ShotPreviewReady`]。
//!
//! 就绪判定需要连续两帧，覆盖上传与 shader 编译；因此「发起渲染」与「可发布」之间存在真实
//! 间隔，迟到结果不会在资源尚未就绪时被当成新画面。本模块不依赖协议、DOM 或 wasm。

use bevy::{
    asset::AssetId,
    core_pipeline::core_3d::{AlphaMask3d, Opaque3d, Transparent3d},
    pbr::{
        PreparedMaterial, SpecializedMaterialPipelineCache, SpecializedMaterialViewPipelineCache,
    },
    prelude::*,
    render::{
        RenderApp, RenderSystems,
        erased_render_asset::ErasedRenderAssets,
        extract_component::{ExtractComponent, ExtractComponentPlugin},
        mesh::RenderMesh,
        render_asset::RenderAssets,
        render_phase::{ViewBinnedRenderPhases, ViewSortedRenderPhases},
        render_resource::{CachedPipelineState, CachedRenderPipelineId, PipelineCache},
        view::{ExtractedView, visibility::RenderVisibleEntities},
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

/// 宿主侧写入 rig 的「本次请求要渲染什么」。
///
/// 只是 rig 上的**普通组件**，不直接提取：真正的预览相机由 `shot_camera::runtime` 内部创建，
/// 宿主拿不到它的实体，因此由 runtime 复制成 [`ShotPreviewView`] 挂到相机上再提取。
#[derive(Component, Clone, Debug)]
pub struct ShotPreviewReadiness {
    /// 宿主侧的稳定身份（卡片 rig）；就绪结果按它发布。
    pub key: Entity,
    /// 本次采样请求代数（宿主单调推进；迟到结果据此丢弃）。
    pub generation: u64,
    /// 当前目标涉及的 mesh（用于确认 GPU 资产与 pipeline 已准备）。
    pub meshes: Vec<AssetId<Mesh>>,
    /// 当前目标涉及的 material。
    pub materials: Vec<AssetId<StandardMaterial>>,
}

/// 预览相机上的提取组件（render world 侧 `ExtractedView` 与它同实体）。
#[derive(Component, Clone, ExtractComponent)]
#[extract_app(RenderApp)]
pub struct ShotPreviewView {
    /// 宿主侧的稳定身份（卡片 rig）；就绪结果按它发布。
    pub key: Entity,
    /// 本次采样请求代数（宿主单调推进；迟到结果据此丢弃）。
    pub generation: u64,
    /// 当前目标涉及的 mesh（用于确认 GPU 资产与 pipeline 已准备）。
    pub meshes: Vec<AssetId<Mesh>>,
    /// 当前目标涉及的 material。
    pub materials: Vec<AssetId<StandardMaterial>>,
}

impl ShotPreviewReadiness {
    /// 相机侧提取组件（与调用方共享同一 payload 语义）。
    pub fn view(&self) -> ShotPreviewView {
        ShotPreviewView {
            key: self.key,
            generation: self.generation,
            meshes: self.meshes.clone(),
            materials: self.materials.clone(),
        }
    }
}

/// 已在 GPU 上稳定渲染到该代数的卡片集合（主世界与 render world 共享）。
///
/// 键是宿主侧稳定身份（卡片 rig 实体）；卡片重建后 rig 实体变化，因此不会复活旧代数。
#[derive(Resource, Clone, Default)]
pub struct ShotPreviewReady(Arc<Mutex<HashMap<Entity, u64>>>);

impl ShotPreviewReady {
    /// 指定卡片是否已就绪到该代数（严格相等；更小代数视为迟到）。
    pub fn matches(&self, key: Entity, generation: u64) -> bool {
        self.0.lock().unwrap().get(&key).copied() == Some(generation)
    }

    /// 该卡片当前已就绪的代数。
    pub fn generation(&self, key: Entity) -> Option<u64> {
        self.0.lock().unwrap().get(&key).copied()
    }

    /// 取消/回收某卡片的就绪记录（目标切换、删除或重建后不得复活旧代数）。
    pub fn cancel(&self, key: Entity) {
        self.0.lock().unwrap().remove(&key);
    }
}

/// 安装提取与渲染侧观察（由 [`super::ShotCameraPlugin`] 调用）。
pub(crate) fn install(app: &mut App) {
    let ready = ShotPreviewReady::default();
    app.insert_resource(ready.clone())
        .add_plugins(ExtractComponentPlugin::<ShotPreviewView>::default());
    if let Some(render) = app.get_sub_app_mut(RenderApp) {
        render.insert_resource(ready).add_systems(
            bevy::render::Render,
            observe
                .after(RenderSystems::Prepare)
                .before(RenderSystems::Render),
        );
    }
}

/// render world：真实渲染证据足够时才发布就绪代数。
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn observe(
    views: Query<(
        &ShotPreviewView,
        &ExtractedView,
        &RenderVisibleEntities,
        &bevy::render::view::ViewTarget,
    )>,
    unprepared: Query<&ShotPreviewView, Without<bevy::render::view::ViewTarget>>,
    materials: Res<ErasedRenderAssets<PreparedMaterial>>,
    meshes: Res<RenderAssets<RenderMesh>>,
    opaque: Res<ViewBinnedRenderPhases<Opaque3d>>,
    mask: Res<ViewBinnedRenderPhases<AlphaMask3d>>,
    transparent: Res<ViewSortedRenderPhases<Transparent3d>>,
    cache: Res<PipelineCache>,
    specialized: Res<SpecializedMaterialPipelineCache>,
    ready: Res<ShotPreviewReady>,
    mut stable: Local<HashMap<Entity, (u64, u8)>>,
) {
    // 尚未取到 ViewTarget（准备中）：清掉旧就绪，避免把上一帧当作本次结果。
    for preview in &unprepared {
        ready.cancel(preview.key);
    }
    let mut alive = std::collections::HashSet::new();
    for (preview, view, visible, _target) in &views {
        alive.insert(preview.key);
        let mut prepared = preview.meshes.iter().all(|id| meshes.get(*id).is_some())
            && preview
                .materials
                .iter()
                .all(|id| materials.get(*id).is_some());
        let expected = visible
            .get::<Mesh3d>()
            .map(|class| class.entities_cpu_culling.len() + class.entities_gpu_culling.len())
            .unwrap_or(0);
        let mut queued = 0usize;
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
        // 空片场（无 mesh/material/可见实体）也必须能发布零点封面：无目标时相位缺席即视为
        // 已渲染空画面，而不是永远停在准备态。
        let complete = queued >= expected
            || multidraw
                && visible_pipelines_ready(visible, specialized.get(key), |id| {
                    matches!(
                        cache.get_render_pipeline_state(id),
                        CachedPipelineState::Ok(_)
                    )
                });
        let rendered = prepared && (phase_present && complete || expected == 0);
        let entry = stable.entry(preview.key).or_insert((preview.generation, 0));
        if entry.0 != preview.generation {
            *entry = (preview.generation, 0);
        }
        entry.1 = if rendered {
            entry.1.saturating_add(1)
        } else {
            0
        };
        // 连续两帧稳定：覆盖上传与 shader 编译，避免首帧未就绪即发布。
        if entry.1 >= 2 {
            ready
                .0
                .lock()
                .unwrap()
                .insert(preview.key, preview.generation);
        } else {
            ready.cancel(preview.key);
        }
    }
    stable.retain(|entity, _| alive.contains(entity));
}

/// Bevy 0.20 keeps multidraw instance counts private. A batch-set count cannot be
/// compared with visible entity counts. Check every visible entity's specialized
/// pipeline instead, including CPU-culled entities placed in multidraw batches.
/// This also blocks publication while a newly visible entity is still waiting
/// for specialization; merely finding one ready multidraw batch is insufficient.
pub(crate) fn visible_pipelines_ready(
    visible: &RenderVisibleEntities,
    specialized: Option<&SpecializedMaterialViewPipelineCache>,
    mut pipeline_ready: impl FnMut(CachedRenderPipelineId) -> bool,
) -> bool {
    let Some(entities) = visible.get::<Mesh3d>() else {
        return true;
    };
    let Some(specialized) = specialized else {
        return false;
    };
    entities
        .entities_cpu_culling
        .iter()
        .map(|(_, entity)| entity)
        .chain(entities.entities_gpu_culling.keys())
        .all(|entity| {
            specialized
                .get(entity)
                .is_some_and(|id| pipeline_ready(*id))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::render::{sync_world::MainEntity, view::visibility::RenderVisibleEntitiesClass};

    #[test]
    fn multidraw_waits_for_every_cpu_and_gpu_entity_pipeline() {
        let mut world = World::new();
        let cpu = MainEntity::from(world.spawn_empty().id());
        let gpu = MainEntity::from(world.spawn_empty().id());
        let mut visible = RenderVisibleEntities::default();
        visible.classes.insert(
            std::any::TypeId::of::<Mesh3d>(),
            RenderVisibleEntitiesClass {
                entities_cpu_culling: vec![(Entity::PLACEHOLDER, cpu)],
                entities_gpu_culling: [(gpu, Entity::PLACEHOLDER)].into_iter().collect(),
                ..default()
            },
        );
        let mut specialized = SpecializedMaterialViewPipelineCache::default();
        let id = CachedRenderPipelineId::INVALID;
        assert!(!visible_pipelines_ready(&visible, None, |_| true));
        specialized.insert(cpu, id);
        assert!(
            !visible_pipelines_ready(&visible, Some(&specialized), |_| true),
            "one queued batch must not hide a missing entity"
        );
        specialized.insert(gpu, id);
        assert!(
            !visible_pipelines_ready(&visible, Some(&specialized), |_| false),
            "queued pipelines may still be compiling"
        );
        let mut checked = 0;
        assert!(visible_pipelines_ready(
            &visible,
            Some(&specialized),
            |_| {
                checked += 1;
                true
            }
        ));
        assert_eq!(checked, 2, "both culling paths must be checked");
    }
}
