//! Immutable renderer-state snapshot. Geometry remains shared; pose is request-owned.
mod media;
mod playback;

use super::super::runtime::{CaptureRetention, ModelRoot};
use bevy::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

pub(super) type RenderParts<'w, 's> = Query<
    'w,
    's,
    (
        Option<&'static Mesh3d>,
        Option<&'static MeshMaterial3d<StandardMaterial>>,
        Option<&'static ChildOf>,
    ),
>;
struct Part {
    source: Entity,
    parent: Option<Entity>,
    transform: Transform,
    mesh: Option<Handle<Mesh>>,
    material: Option<Handle<StandardMaterial>>,
}
pub(super) struct FrozenModelSnapshot {
    parts: Vec<Part>,
    /// Keep immutable content alive without duplicating script operations or geometry arrays.
    _resource: Option<Arc<crate::protocol::ModelSnapshot>>,
    owned_materials: Vec<Handle<StandardMaterial>>,
    owned_images: Vec<Handle<Image>>,
    pub(super) image_bytes: usize,
    admitted_bases: HashMap<String, Transform>,
}
impl FrozenModelSnapshot {
    pub fn freeze(
        root: &ModelRoot,
        transforms: &Query<&Transform>,
        render: &RenderParts,
    ) -> Option<(Self, CaptureRetention)> {
        #[cfg(feature = "explicit-instancing")]
        if !root.instance_parts.is_empty() { return None; }
        if root.quality != super::super::quality::Quality::High || root.entities.len() > 32_768 {
            return None;
        }
        let mut parts = Vec::with_capacity(root.entities.len());
        let mut meshes = HashMap::new();
        let mut materials = HashMap::new();
        for &source in &root.entities {
            let transform = *transforms.get(source).ok()?;
            let (mesh, material, parent) = render.get(source).ok()?;
            let mesh = mesh.map(|m| m.0.clone());
            let material = material.map(|m| m.0.clone());
            if let Some(mesh) = &mesh {
                meshes.insert(mesh.id(), mesh.clone());
            }
            if let Some(material) = &material {
                materials.insert(material.id(), material.clone());
            }
            parts.push(Part {
                source,
                parent: parent.map(ChildOf::parent),
                transform,
                mesh,
                material,
            });
        }
        let owned: HashSet<_> = parts.iter().map(|p| p.source).collect();
        if parts
            .iter()
            .any(|p| p.parent.is_some_and(|parent| !owned.contains(&parent)))
        {
            return None;
        }
        let bytes = parts.capacity() * std::mem::size_of::<Part>();
        let retention = CaptureRetention {
            meshes: meshes.into_values().collect(),
            materials: materials.into_values().collect(),
            bytes,
        };
        Some((
            Self {
                parts,
                _resource: Some(root.resource.clone()),
                owned_materials: Vec::new(),
                owned_images: Vec::new(),
                image_bytes: 0,
                admitted_bases: HashMap::new(),
            },
            retention,
        ))
    }
    pub(super) fn apply_admitted(
        &mut self,
        root: Option<&ModelRoot>,
        admitted: &super::admitted::Scene,
    ) -> bool {
        let Some(root) = root else {
            return admitted.model_signature.is_none();
        };
        if admitted.model_signature.as_deref() != Some(root.content_signature.as_str())
            || admitted
                .resource
                .as_ref()
                .is_none_or(|resource| !Arc::ptr_eq(resource, &root.resource))
        {
            return false;
        }
        let super::super::runtime::ModelRootLayout::V2 { root: entity } = root.layout;
        let indices: HashMap<_, _> = self
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| (part.source, index))
            .collect();
        let Some(index) = indices.get(&entity) else {
            return false;
        };
        self.parts[*index].transform = admitted.root;
        self.admitted_bases = admitted.item_bases.clone();
        for (id, base) in &self.admitted_bases {
            if let Some(index) = root
                .part_entities
                .get(id)
                .and_then(|entity| indices.get(entity))
            {
                self.parts[*index].transform = *base;
            }
        }
        true
    }
    /// Build an isolated hierarchy with no animation/playback components.
    /// The caller owns the returned entities and must release them at request end.
    pub fn spawn(&self, commands: &mut Commands, layer: usize) -> Vec<Entity> {
        let mut mapping = HashMap::new();
        let mut entities = Vec::with_capacity(self.parts.len());
        for part in &self.parts {
            let entity = commands
                .spawn((
                    part.transform,
                    Visibility::Inherited,
                    bevy::camera::visibility::RenderLayers::from_layers(&[layer]),
                ))
                .id();
            if let (Some(mesh), Some(material)) = (&part.mesh, &part.material) {
                commands.entity(entity).insert((
                    Mesh3d(mesh.clone()),
                    MeshMaterial3d(material.clone()),
                    // Frozen readback admits a pose without retaining source AABBs.
                    // Keep this dedicated capture representation uncullable until
                    // its bounds/readiness scheduling is verified separately.
                    bevy::camera::visibility::NoFrustumCulling,
                ));
            }
            mapping.insert(part.source, entity);
            entities.push(entity);
        }
        for part in &self.parts {
            if let Some(parent) = part.parent.and_then(|p| mapping.get(&p)) {
                commands
                    .entity(mapping[&part.source])
                    .insert(ChildOf(*parent));
            }
        }
        entities
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model3d::{
        ModelVisuals,
        tests::{reference_for, resource_table, run_sync, scene_with, world_with_resources},
    };
    fn trim(world: &mut World) {
        let mut models = world.remove_resource::<ModelVisuals>().unwrap();
        let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
        let mut materials = world.remove_resource::<Assets<StandardMaterial>>().unwrap();
        models.trim_resources(&mut meshes, &mut materials);
        world.insert_resource(models);
        world.insert_resource(meshes);
        world.insert_resource(materials);
    }
    #[test]
    fn snapshot_pose_is_independent_and_shared_assets_survive_source_deletion() {
        let node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
            "id":"capture", "type":"model", "x":0,"y":0,"width":120,"height":100
        }))
        .unwrap();
        let model: crate::protocol::ModelSnapshot = serde_json::from_value(serde_json::json!({
            "sceneVersion":"woohaa-model-scene-ir-v2","signature":"frozen","extent":1,
            "ops":[{"t":"box","id":"body","size":[1,1,1]}]
        }))
        .unwrap();
        let reference = reference_for(&model, default());
        let resources = resource_table([(reference.resource_key.clone(), model)]);
        let scene = scene_with(&node, Some(reference));
        let mut world = world_with_resources();
        run_sync(&mut world, &scene, &resources);
        let source = world.resource::<ModelVisuals>().roots["capture"].entities[0];
        let original = *world.get::<Transform>(source).unwrap();
        let mut state = bevy::ecs::system::SystemState::<(
            Res<ModelVisuals>,
            Query<&Transform>,
            RenderParts,
        )>::new(&mut world);
        let (models, transforms, render) = state.get(&world).unwrap();
        let (snapshot, retention) =
            FrozenModelSnapshot::freeze(&models.roots["capture"], &transforms, &render).unwrap();
        let mesh = retention.meshes[0].clone();
        world
            .resource_mut::<ModelVisuals>()
            .capture_retention
            .insert(1, retention);
        world.get_mut::<Transform>(source).unwrap().translation.x += 9.;
        let clones = snapshot.spawn(&mut world.commands(), 8);
        world.flush();
        assert_eq!(*world.get::<Transform>(clones[0]).unwrap(), original);
        assert_eq!(world.get::<Mesh3d>(clones[1]).unwrap().0, mesh);
        assert!(
            world
                .get::<crate::transform_animation::TransformAnimationPlayback>(clones[1])
                .is_none()
        );
        world.despawn(source);
        world.resource_mut::<ModelVisuals>().roots.clear();
        trim(&mut world);
        assert!(world.resource::<Assets<Mesh>>().contains(mesh.id()));
        world.despawn(clones[0]);
        world
            .resource_mut::<ModelVisuals>()
            .capture_retention
            .clear();
        trim(&mut world);
        assert!(world.resource::<Assets<Mesh>>().is_empty());
    }
}
