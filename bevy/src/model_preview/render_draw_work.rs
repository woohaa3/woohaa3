//! Main-pass PBR mesh command recording, measured after Bevy DrawMesh executes.
//! Indirect GPU counts, shadow/prepass, 2D and driver submissions are not inferred.
use bevy::{
    core_pipeline::core_3d::{AlphaMask3d, Opaque3d, Transparent3d},
    ecs::{query::ROQueryItem, system::{SystemParamItem, lifetimeless::SRes}},
    pbr::{DrawMaterial, SetMaterialBindGroup, SetMeshBindGroup,
        SetMeshViewBindGroup, SetMeshViewBindingArrayBindGroup},
    pbr::Transmissive3d,
    prelude::*,
    render::render_phase::{CachedRenderPipelinePhaseItem, DrawFunctions, PhaseItem, PhaseItemExtraIndex,
        RenderCommand, RenderCommandResult, RenderCommandState, SetItemPipeline, TrackedRenderPass},
};
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};

#[derive(Default)]
struct Counters {
    direct: AtomicU64,
    direct_instances: AtomicU64,
    indirect: AtomicU64,
    indirect_slots: AtomicU64,
    skipped: AtomicU64,
}
#[derive(Resource, Clone)]
pub(super) struct DrawWork(Arc<Counters>, bool);
impl Default for DrawWork {
    fn default() -> Self {
        Self(Arc::default(), option_env!("WOOHAA_RENDER_DRAW_DIAGNOSTICS") != Some("0"))
    }
}
impl DrawWork {
    /// CPU draw API recordings, including one call per multi_draw invocation.
    /// Not the GPU-expanded indirect draw count or a count of mesh instances.
    pub(super) fn recording_calls(&self) -> Option<u64> {
        self.1.then(|| {
            self.0.direct.load(Ordering::Relaxed) + self.0.indirect.load(Ordering::Relaxed)
        })
    }

    pub fn snapshot(&self) -> serde_json::Value {
        if !self.1 {
            return serde_json::json!({"status": "disabled", "driverSubmissions": "unavailable"});
        }
        let read = |value: &AtomicU64| value.load(Ordering::Relaxed);
        serde_json::json!({
            "scope": "bevy-material-3d-main-passes-all-views",
            "directRecordingCalls": read(&self.0.direct),
            "directInstances": read(&self.0.direct_instances),
            "indirectRecordingCalls": read(&self.0.indirect),
            "indirectParameterSlots": read(&self.0.indirect_slots),
            "skippedMeshCommands": read(&self.0.skipped),
            "gpuIndirectDrawCount": "unavailable", "driverSubmissions": "unavailable"
        })
    }
    fn record(&self, extra: PhaseItemExtraIndex, instances: u64, success: bool) {
        if !success {
            self.0.skipped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        match extra {
            PhaseItemExtraIndex::None | PhaseItemExtraIndex::DynamicOffset(_) => {
                self.0.direct.fetch_add(1, Ordering::Relaxed);
                self.0.direct_instances.fetch_add(instances, Ordering::Relaxed);
            }
            PhaseItemExtraIndex::IndirectParametersIndex { range, .. } => {
                self.0.indirect.fetch_add(1, Ordering::Relaxed);
                self.0.indirect_slots.fetch_add(u64::from(range.end - range.start), Ordering::Relaxed);
            }
        }
    }
}

struct MeasuredDrawMesh;
#[cfg(feature = "explicit-instancing")]
type MeshDraw = crate::model3d::instancing::DrawMeshDispatch;
#[cfg(not(feature = "explicit-instancing"))]
type MeshDraw = bevy::pbr::DrawMesh;
impl<P: PhaseItem> RenderCommand<P> for MeasuredDrawMesh {
    type Param = (<MeshDraw as RenderCommand<P>>::Param, SRes<DrawWork>);
    type ViewQuery = <MeshDraw as RenderCommand<P>>::ViewQuery;
    type ItemQuery = <MeshDraw as RenderCommand<P>>::ItemQuery;
    fn render<'w>(
        item: &P,
        view: bool,
        entity: Option<ROQueryItem<'w, '_, Self::ItemQuery>>,
        (params, work): SystemParamItem<'w, '_, Self::Param>,
        pass: &mut TrackedRenderPass<'w>,
    ) -> RenderCommandResult {
        // In pinned Bevy 0.20 DrawMesh, Success follows exactly one draw,
        // draw_indexed or multi_draw_* recording. All early exits return Skip.
        let instances = u64::from(item.batch_range().end - item.batch_range().start);
        #[cfg(feature = "explicit-instancing")]
        let instances = entity.flatten().map_or(instances, |buffer| buffer.count as u64);
        let result = MeshDraw::render(item, view, entity, params, pass);
        work.record(item.extra_index(), instances,
            matches!(result, RenderCommandResult::Success));
        result
    }
}
type MeasuredDrawMaterial = (
    SetItemPipeline, SetMeshViewBindGroup<0>, SetMeshViewBindingArrayBindGroup<1>,
    SetMeshBindGroup<2>, SetMaterialBindGroup<3>, MeasuredDrawMesh,
);

fn install_phase<P: CachedRenderPipelinePhaseItem>(render: &mut SubApp) {
    if !render.world().contains_resource::<DrawFunctions<P>>() { return; }
    let state = RenderCommandState::<P, MeasuredDrawMaterial>::new(render.world_mut());
    // Material preparation resolves DrawMaterial's type ID. Preserve all bind
    // commands and the original DrawMesh behavior, replacing only its counter.
    render.world().resource::<DrawFunctions<P>>().write()
        .add_with::<DrawMaterial, _>(state);
}
pub(super) fn install(render: &mut SubApp, work: DrawWork) {
    if !work.1 { return; }
    render.insert_resource(work);
    install_phase::<Opaque3d>(render);
    install_phase::<AlphaMask3d>(render);
    install_phase::<Transparent3d>(render);
    install_phase::<Transmissive3d>(render);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_resolves_the_measured_material_command() {
        let mut render = SubApp::new();
        render.init_resource::<DrawFunctions<Opaque3d>>();
        let original = RenderCommandState::<Opaque3d, DrawMaterial>::new(render.world_mut());
        let old_id = render.world().resource::<DrawFunctions<Opaque3d>>().write()
            .add_with::<DrawMaterial, _>(original);
        install(&mut render, DrawWork::default());
        let functions = render.world().resource::<DrawFunctions<Opaque3d>>().read();
        assert_ne!(functions.id::<DrawMaterial>(), old_id);
        assert_eq!(functions.draw_functions.len(), 2);
    }
    #[test]
    fn does_not_infer_indirect_draws_from_parameter_slots_or_skips() {
        let work = DrawWork::default();
        work.record(PhaseItemExtraIndex::None, 12, true);
        work.record(PhaseItemExtraIndex::None, 100, false);
        work.record(PhaseItemExtraIndex::IndirectParametersIndex {
            range: 0..40, batch_set_index: None,
        }, 100, true);
        let value = work.snapshot();
        assert_eq!(value["directRecordingCalls"], 1);
        assert_eq!(value["directInstances"], 12);
        assert_eq!(value["indirectRecordingCalls"], 1);
        assert_eq!(value["indirectParameterSlots"], 40);
        assert_eq!(value["skippedMeshCommands"], 1);
        assert_eq!(value["gpuIndirectDrawCount"], "unavailable");
        assert_eq!(work.recording_calls(), Some(2));
        assert_eq!(DrawWork(Arc::default(), false).recording_calls(), None);
    }
}
