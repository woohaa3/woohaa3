use super::{Instances, INSTANCE_STRIDE};
use bevy::{
    asset::AssetId,
    mesh::{MeshVertexBufferLayoutRef, VertexBufferLayout},
    pbr::{ExtendedMaterial, MaterialExtension, MaterialExtensionKey, MaterialExtensionPipeline},
    prelude::*,
    render::{extract_component::ExtractComponentPlugin, render_resource::*, RenderApp},
    shader::ShaderRef,
};
use std::collections::{HashMap, HashSet};

#[derive(Asset, AsBindGroup, TypePath, Clone, Default)]
pub(crate) struct InstanceExtension {}
pub(crate) type InstanceMaterial = ExtendedMaterial<StandardMaterial, InstanceExtension>;
impl MaterialExtension for InstanceExtension {
    fn vertex_shader() -> ShaderRef { "shaders/model-instancing.wesl".into() }
    // Explicit cards have no shadow/prepass cameras. High consumers always
    // restore ordinary StandardMaterial entities before capture/edit/focus.
    fn enable_prepass() -> bool { false }
    fn enable_shadows() -> bool { false }
    fn specialize(
        _pipeline: &MaterialExtensionPipeline,
        descriptor: &mut RenderPipelineDescriptor,
        _layout: &MeshVertexBufferLayoutRef,
        _key: MaterialExtensionKey<Self>,
    ) -> Result<(), SpecializedMeshPipelineError> {
        descriptor.vertex.buffers.push(VertexBufferLayout {
            array_stride: INSTANCE_STRIDE as u64,
            step_mode: VertexStepMode::Instance,
            attributes: (0..6).map(|index| VertexAttribute {
                format: VertexFormat::Float32x4, offset: index * 16, shader_location: index as u32 + 8,
            }).collect(),
        });
        descriptor.vertex.buffers.push(VertexBufferLayout {
            array_stride: 4, step_mode: VertexStepMode::Instance,
            attributes: vec![VertexAttribute { format: VertexFormat::Float32, offset: 0, shader_location: 14 }],
        });
        Ok(())
    }
}

#[derive(Resource, Default)]
struct InstanceMaterials(HashMap<AssetId<StandardMaterial>, Handle<InstanceMaterial>>);
pub(crate) struct InstancingPlugin;
impl Plugin for InstancingPlugin {
    fn build(&self, app: &mut App) {
        if super::super::batch_strategy::BatchStrategy::default()
            != super::super::batch_strategy::BatchStrategy::Explicit { return; }
        app.add_plugins((MaterialPlugin::<InstanceMaterial>::default(),
            ExtractComponentPlugin::<Instances>::default()))
            .init_resource::<InstanceMaterials>()
            .add_systems(PostUpdate, prepare_materials);
        let work = super::InstanceWork::default();
        app.insert_resource(work.clone());
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            super::render::install(render, work);
        }
    }
}
fn prepare_materials(
    mut commands: Commands,
    incoming: Query<(Entity, &MeshMaterial3d<StandardMaterial>), With<Instances>>,
    current: Query<&MeshMaterial3d<InstanceMaterial>, With<Instances>>,
    mut removed: RemovedComponents<Instances>,
    standard: Res<Assets<StandardMaterial>>,
    mut extended: ResMut<Assets<InstanceMaterial>>,
    mut cache: ResMut<InstanceMaterials>,
) {
    let changed = removed.read().next().is_some() || !incoming.is_empty();
    if !changed { return; }
    let mut live: HashSet<_> = current.iter().map(|m| m.0.id()).collect();
    for (entity, source) in &incoming {
        let Some(base) = standard.get(&source.0) else { continue; };
        let handle = cache.0.entry(source.0.id()).or_insert_with(|| extended.add(InstanceMaterial {
            base: base.clone(), extension: InstanceExtension::default(),
        })).clone();
        live.insert(handle.id());
        commands.entity(entity).remove::<MeshMaterial3d<StandardMaterial>>()
            .insert(MeshMaterial3d(handle));
    }
    cache.0.retain(|_, handle| {
        if live.contains(&handle.id()) { true } else { extended.remove(handle.id()); false }
    });
}
