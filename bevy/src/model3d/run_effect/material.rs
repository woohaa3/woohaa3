use bevy::{
    mesh::MeshVertexBufferLayoutRef,
    pbr::{MaterialPipeline, MaterialPipelineKey},
    prelude::*,
    render::render_resource::*,
    shader::ShaderRef,
};

/// All animation uses Bevy's shared Globals uniform. Per-operation inputs change only on transitions.
#[derive(Asset, TypePath, AsBindGroup, Clone)]
pub(crate) struct RunMaterial {
    #[uniform(0)]
    pub(super) color: LinearRgba,
    /// wrapped start, wrapped stop (-1 while active), physical line width, shared clock wrap period
    #[uniform(1)]
    pub(super) timing: Vec4,
    #[uniform(2)]
    pub(super) axis: Vec4,
}
impl Material for RunMaterial {
    fn vertex_shader() -> ShaderRef {
        "shaders/film-set-run.wesl".into()
    }
    fn fragment_shader() -> ShaderRef {
        "shaders/film-set-run.wesl".into()
    }
    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Blend
    }
    fn enable_prepass() -> bool {
        false
    }
    fn enable_shadows() -> bool {
        false
    }
    fn specialize(
        _pipeline: &MaterialPipeline,
        descriptor: &mut RenderPipelineDescriptor,
        _layout: &MeshVertexBufferLayoutRef,
        _key: MaterialPipelineKey<Self>,
    ) -> Result<(), SpecializedMeshPipelineError> {
        descriptor.primitive.cull_mode = None;
        Ok(())
    }
}
