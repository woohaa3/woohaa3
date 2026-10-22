use super::{Instances, MAX_INSTANCES};
use bevy::{
    core_pipeline::core_3d::Opaque3d,
    ecs::system::{lifetimeless::{Read, SRes}, SystemParamItem},
    pbr::{DrawMaterial, DrawMesh, MeshPipeline, MeshPipelineSystems, SetMaterialBindGroup,
        SetMeshBindGroup, SetMeshViewBindGroup, SetMeshViewBindingArrayBindGroup},
    prelude::*,
    render::{mesh::RenderMeshBufferInfo, render_phase::{DrawFunctions, PhaseItem,
        PhaseItemExtraIndex, RenderCommand, RenderCommandResult, RenderCommandState,
        SetItemPipeline, TrackedRenderPass}, render_resource::*, renderer::RenderDevice,
        render_phase::ViewBinnedRenderPhases, sync_world::MainEntity,
        Render, RenderStartup, RenderSystems},
};
use std::sync::{Arc, Mutex};

const ROOT_INDEX_CAPACITY: usize = 1024;
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceStats {
    instance_buffer_creates: u64,
    instance_buffer_initial_data_bytes: u64,
    live_instance_buffer_bytes: usize,
    peak_instance_buffer_bytes: usize,
    root_index_buffer_bytes: usize,
}
#[derive(Resource, Clone, Default)]
pub(crate) struct InstanceWork(Arc<Mutex<InstanceStats>>);
impl InstanceWork {
    pub(crate) fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"scope": "explicit-instance-buffers", "work": &*self.0.lock().unwrap(),
            "driverUploadTraffic": "unavailable"})
    }
}
#[derive(Resource)]
pub(crate) struct RootIndices { buffer: Buffer, capacity: usize }
#[derive(Component)]
pub(crate) struct InstanceBuffer {
    pub count: usize,
    buffer: Buffer,
    source: Arc<[u8]>,
    device_epoch: BufferId,
}
fn prepare_buffers(
    mut commands: Commands,
    query: Query<(Entity, &Instances, Option<&InstanceBuffer>)>,
    device: Res<RenderDevice>,
    work: Res<InstanceWork>,
    indices: Res<RootIndices>,
) {
    let mut created = 0;
    let mut created_bytes = 0;
    let mut live_bytes = 0;
    let mut replaced_bytes = 0;
    for (entity, instances, previous) in &query {
        live_bytes += instances.bytes.len();
        if previous.is_some_and(|buffer| buffer.device_epoch == indices.buffer.id()
            && Arc::ptr_eq(&buffer.source, &instances.bytes)) { continue; }
        replaced_bytes += previous.map_or(0, |buffer| buffer.source.len());
        let buffer = device.create_buffer_with_data(&BufferInitDescriptor {
            label: Some("immutable model instances"), contents: &instances.bytes,
            usage: BufferUsages::VERTEX,
        });
        commands.entity(entity).insert(InstanceBuffer {
            count: instances.parts.len(), buffer, source: instances.bytes.clone(), device_epoch: indices.buffer.id(),
        });
        created += 1;
        created_bytes += instances.bytes.len();
    }
    let mut stats = work.0.lock().unwrap();
    stats.instance_buffer_creates += created;
    stats.instance_buffer_initial_data_bytes += created_bytes as u64;
    stats.live_instance_buffer_bytes = live_bytes;
    stats.peak_instance_buffer_bytes = stats.peak_instance_buffer_bytes.max(live_bytes + replaced_bytes);
}
fn prepare_root_indices(mut commands: Commands, device: Res<RenderDevice>, pipeline: Res<MeshPipeline>, work: Res<InstanceWork>) {
    // A per-instance attribute supplies the root's uniform index separately
    // from gl_InstanceID. Binding a row selects one constant root index for
    // all instances, without per-view buffer rewrites or first-instance offsets.
    let capacity = pipeline.per_object_buffer_batch_size.map_or(ROOT_INDEX_CAPACITY, |size| size as usize);
    let bytes: Vec<u8> = (0..capacity).flat_map(|root|
        (0..MAX_INSTANCES).flat_map(move |_| (root as f32).to_le_bytes())).collect();
    work.0.lock().unwrap().root_index_buffer_bytes = bytes.len();
    commands.insert_resource(RootIndices { capacity, buffer: device.create_buffer_with_data(&BufferInitDescriptor {
        label: Some("model instance root uniform indices"), contents: &bytes, usage: BufferUsages::VERTEX,
    }) });
}
fn resolve_render_entities(
    instances: Query<(Entity, &MainEntity), With<Instances>>,
    mut phases: ResMut<ViewBinnedRenderPhases<Opaque3d>>,
) {
    // Built-in material queueing uses PLACEHOLDER render entities because its
    // DrawMesh only reads main-world identities. Our immutable instance buffer
    // is a render-world component, so resolve it for each unbatchable item.
    let mapping: std::collections::HashMap<_, _> = instances.iter().map(|(entity, main)| (*main, entity)).collect();
    for phase in phases.values_mut() {
        for bin in phase.unbatchable_meshes.values_mut() {
            for (main, entity) in bin.entities.iter_mut() {
                if let Some(render_entity) = mapping.get(main) { *entity = *render_entity; }
            }
        }
    }
}

pub(crate) struct DrawMeshDispatch;
impl<P: PhaseItem> RenderCommand<P> for DrawMeshDispatch {
    type Param = (<DrawMesh as RenderCommand<P>>::Param, Option<SRes<RootIndices>>);
    type ViewQuery = <DrawMesh as RenderCommand<P>>::ViewQuery;
    type ItemQuery = Option<Read<InstanceBuffer>>;
    fn render<'w>(
        item: &P, view: bool, entity: Option<Option<&'w InstanceBuffer>>,
        (params, indices): SystemParamItem<'w, '_, Self::Param>,
        pass: &mut TrackedRenderPass<'w>,
    ) -> RenderCommandResult {
        let Some(buffer) = entity.flatten() else {
            return DrawMesh::render(item, view, None, params, pass);
        };
        let Some(indices) = indices else { return RenderCommandResult::Skip; };
        let indices = indices.into_inner();
        let root_index = item.batch_range().start as usize;
        if root_index >= indices.capacity || buffer.count > MAX_INSTANCES
            || !matches!(item.extra_index(), PhaseItemExtraIndex::None | PhaseItemExtraIndex::DynamicOffset(_)) {
            return RenderCommandResult::Failure("explicit instances require bounded direct CPU mesh uniforms");
        }
        let meshes = params.0.into_inner();
        let mesh_instances = params.1.into_inner();
        let allocator = params.4.into_inner();
        let Some(id) = mesh_instances.mesh_asset_id(item.main_entity()) else { return RenderCommandResult::Skip; };
        let Some(mesh) = meshes.get(id) else { return RenderCommandResult::Skip; };
        let Some(vertices) = allocator.mesh_vertex_slice(&id) else { return RenderCommandResult::Skip; };
        let offset = (root_index * MAX_INSTANCES * 4) as u64;
        pass.set_vertex_buffer(0, vertices.buffer.slice(..));
        pass.set_vertex_buffer(1, buffer.buffer.slice(..));
        pass.set_vertex_buffer(2, indices.buffer.slice(offset..offset + (MAX_INSTANCES * 4) as u64));
        match mesh.buffer_info {
            RenderMeshBufferInfo::Indexed { index_format, count } => {
                let Some(source) = allocator.mesh_index_slice(&id) else { return RenderCommandResult::Skip; };
                pass.set_index_buffer(source.buffer.slice(..), index_format);
                pass.draw_indexed(source.range.start..source.range.start + count,
                    vertices.range.start as i32, 0..buffer.count as u32);
            }
            RenderMeshBufferInfo::NonIndexed => pass.draw(vertices.range, 0..buffer.count as u32),
        }
        RenderCommandResult::Success
    }
}
type DrawInstancesMaterial = (SetItemPipeline, SetMeshViewBindGroup<0>,
    SetMeshViewBindingArrayBindGroup<1>, SetMeshBindGroup<2>, SetMaterialBindGroup<3>, DrawMeshDispatch);
pub(super) fn install(render: &mut SubApp, work: InstanceWork) {
    render.insert_resource(work);
    let state = RenderCommandState::<Opaque3d, DrawInstancesMaterial>::new(render.world_mut());
    render.world().resource::<DrawFunctions<Opaque3d>>().write().add_with::<DrawMaterial, _>(state);
    render.add_systems(RenderStartup, prepare_root_indices.after(MeshPipelineSystems))
        .add_systems(Render, (prepare_buffers.in_set(RenderSystems::PrepareResources),
            resolve_render_entities.after(RenderSystems::Queue).before(RenderSystems::Prepare)));
}
