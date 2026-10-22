use super::{plan, Instances};
use crate::model3d::{mesh, quality::Quality, resources::SharedResources, scene::{self, ModelEntitySpec, ModelGeometry}};
use bevy::prelude::*;
use std::{collections::HashSet, sync::Arc};

pub(crate) struct Group {
    pub entity: Entity,
    pub parent: Option<String>,
    pub base: String,
    pub geometry: Arc<ModelGeometry>,
    pub mesh: Handle<Mesh>,
    pub material: Handle<StandardMaterial>,
    pub instances: Instances,
    pub indices: Vec<usize>,
}
pub(crate) fn spawn_groups(
    commands: &mut Commands, meshes: &mut Assets<Mesh>, materials: &mut Assets<StandardMaterial>,
    shared: &mut SharedResources, specs: &[ModelEntitySpec], opaque: &HashSet<String>,
    material_specs: &std::collections::HashMap<String, scene::MaterialSpec>, quality: Quality,
) -> Vec<Group> {
    let mut result = Vec::new();
    for plan in plan::plans(specs, opaque) {
        let Some((instances, bounds)) = plan::build(&plan, specs) else { continue; };
        let geometry = specs[plan.parts[0]].geometry.as_ref().unwrap();
        let base = mesh::mesh_key(geometry);
        let Some((mesh, geometry)) = shared.mesh(meshes, &base, geometry, quality) else { continue; };
        let material = shared.material(materials, scene::standard_material_for(&plan.material, material_specs));
        let entity = commands.spawn((Mesh3d(mesh.clone()), MeshMaterial3d(material.clone()),
            Transform::default(), crate::model3d::model_render_layers(),
            bevy::render::batching::NoAutomaticBatching,
            bevy::camera::primitives::Aabb::from_min_max(Vec3::from_array(bounds.min), Vec3::from_array(bounds.max)),
            instances.clone(),
        )).id();
        result.push(Group { entity, parent: plan.parent, base, geometry, mesh, material,
            instances, indices: plan.parts });
    }
    result
}
