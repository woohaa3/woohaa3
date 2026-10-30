//! GPU target and isolated overview camera construction. No CPU pixel readback is used.

use bevy::{
    asset::RenderAssetUsages,
    camera::{RenderTarget, visibility::RenderLayers},
    image::ImageSampler,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat, TextureUsages},
};

/// A camera and its corresponding screen-aligned plane use the same fixed canvas basis.
pub(crate) fn view_for_bounds(
    bounds: super::geometry::Bounds2d,
    aspect: f32,
    margin: f32,
    depth: f32,
) -> Option<(Transform, OrthographicProjection, Transform, Vec2)> {
    let view = super::geometry::camera_for_bounds(bounds, aspect, margin)?;
    if !depth.is_finite() {
        return None;
    }
    let rotation = crate::isometric_grid::canvas_camera_rotation();
    let camera = Transform {
        translation: crate::isometric_grid::canvas_point_to_world(
            view.center_x,
            view.center_y,
            crate::isometric_grid::CANVAS_CAMERA_Z,
        ),
        rotation,
        ..default()
    };
    let mut projection = crate::isometric_grid::canvas_camera_projection();
    projection.scaling_mode = bevy::camera::ScalingMode::Fixed {
        width: view.half_width * 2.,
        height: view.half_height * 2.,
    };
    let plane = Transform {
        translation: crate::isometric_grid::canvas_point_to_world(
            view.center_x,
            view.center_y,
            depth,
        ),
        rotation,
        ..default()
    };
    Some((
        camera,
        projection,
        plane,
        Vec2::new(view.half_width * 2., view.half_height * 2.),
    ))
}

pub(crate) struct OverviewTarget {
    pub(crate) image: Handle<Image>,
    pub(crate) camera: Entity,
}

impl OverviewTarget {
    /// Arm only after all declared model and media dependencies exist in the main world.
    /// The render-world probe subsequently waits for their GPU assets and pipelines.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn arm_subject(
        &self,
        commands: &mut Commands,
        generation: u64,
        node: &crate::protocol::GraphNode,
        declared_media: usize,
        models: &crate::model3d::ModelVisuals,
        media: &crate::model3d::film_set_media::FilmSetMediaVisuals,
        mesh_components: &Query<&Mesh3d>,
        materials: &Assets<StandardMaterial>,
        images: &Assets<Image>,
    ) -> bool {
        let has_model = node.model.is_some();
        if !super::eligibility::dependencies_ready(
            has_model,
            models.has_root(&node.id),
            declared_media,
            media.owner_dependencies_ready(&node.id, declared_media, materials, images),
        ) {
            return false;
        }
        let Some((media_meshes, media_materials)) = media.owner_preview_assets(&node.id, mesh_components) else {
            return false;
        };
        let mut meshes = models.preview_meshes(&node.id);
        let mut material_ids = models.preview_materials(&node.id);
        meshes.extend(media_meshes);
        material_ids.extend(media_materials);
        let mut image_ids = Vec::new();
        for id in &material_ids {
            let Some(material) = materials.get(*id) else { return false; };
            for image in [
                &material.base_color_texture, &material.emissive_texture,
                &material.metallic_roughness_texture, &material.normal_map_texture,
                &material.occlusion_texture,
            ].into_iter().flatten() {
                if !images.contains(image.id()) { return false; }
                image_ids.push(image.id());
            }
        }
        self.arm(commands, generation, meshes, material_ids, image_ids, true);
        true
    }

    /// Arm the one-shot view with the same render-world readiness probe used by model previews.
    pub(crate) fn arm(
        &self,
        commands: &mut Commands,
        generation: u64,
        meshes: Vec<bevy::asset::AssetId<Mesh>>,
        materials: Vec<bevy::asset::AssetId<StandardMaterial>>,
        images: Vec<bevy::asset::AssetId<Image>>,
        subject_ready: bool,
    ) {
        commands.entity(self.camera).insert(crate::model_preview::PreviewView {
            camera: self.camera,
            generation,
            meshes,
            materials,
            images,
            rooted: subject_ready,
        });
        let camera = self.camera;
        commands.queue(move |world: &mut World| {
            if let Some(mut camera) = world.get_mut::<Camera>(camera) {
                camera.is_active = true;
            }
        });
    }

    pub(crate) fn stop(&self, commands: &mut Commands, ready: &crate::model_preview::Ready) {
        ready.forget(self.camera);
        commands.entity(self.camera).remove::<crate::model_preview::PreviewView>();
        let camera = self.camera;
        commands.queue(move |world: &mut World| {
            if let Some(mut camera) = world.get_mut::<Camera>(camera) {
                camera.is_active = false;
            }
        });
    }
}

pub(crate) struct OverviewPlane {
    pub(crate) entity: Entity,
    pub(crate) mesh: Handle<Mesh>,
    pub(crate) material: Handle<StandardMaterial>,
}

struct Displayed {
    plane: OverviewPlane,
    image: Handle<Image>,
}

/// Owns displayed textures independently of the temporary render targets.
#[derive(Resource, Default)]
pub(crate) struct OverviewDisplayed {
    entries: std::collections::HashMap<String, Displayed>,
}

impl OverviewDisplayed {
    #[cfg(test)]
    pub(crate) fn plane_entity(&self, owner_id: &str) -> Option<Entity> {
        self.entries.get(owner_id).map(|displayed| displayed.plane.entity)
    }

    pub(crate) fn move_to(&self, owner_id: &str, transform: Transform, commands: &mut Commands) {
        if let Some(displayed) = self.entries.get(owner_id) {
            commands.entity(displayed.plane.entity).insert(transform);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn publish(
        &mut self,
        owner_id: &str,
        owner: Entity,
        image: Handle<Image>,
        size: Vec2,
        transform: Transform,
        commands: &mut Commands,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
        images: &mut Assets<Image>,
    ) -> bool {
        if !images.contains(image.id()) { return false; }
        if let Some(displayed) = self.entries.get_mut(owner_id) {
            let Some(mut material) = materials.get_mut(&displayed.plane.material) else { return false; };
            let mesh = meshes.add(Rectangle::new(size.x.max(0.001), size.y.max(0.001)));
            commands.entity(displayed.plane.entity).insert((Mesh3d(mesh.clone()), transform, ChildOf(owner)));
            meshes.remove(displayed.plane.mesh.id());
            displayed.plane.mesh = mesh;
            material.base_color_texture = Some(image.clone());
            if displayed.image != image { images.remove(displayed.image.id()); }
            displayed.image = image;
        } else {
            let plane = spawn_plane(commands, meshes, materials, owner, image.clone(), size, transform);
            self.entries.insert(owner_id.to_owned(), Displayed { plane, image });
        }
        true
    }

    pub(crate) fn remove(
        &mut self,
        owner_id: &str,
        commands: &mut Commands,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
        images: &mut Assets<Image>,
    ) -> bool {
        let Some(displayed) = self.entries.remove(owner_id) else { return false; };
        release_plane(commands, meshes, materials, displayed.plane);
        images.remove(displayed.image.id());
        true
    }
}

/// The plane is visible only to the canvas camera. Capture and shot cameras use their
/// own layers and continue to see the original source geometry.
pub(crate) fn spawn_plane(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    owner: Entity,
    image: Handle<Image>,
    size: Vec2,
    transform: Transform,
) -> OverviewPlane {
    let mesh = meshes.add(Rectangle::new(size.x.max(0.001), size.y.max(0.001)));
    let material = materials.add(StandardMaterial {
        base_color: Color::WHITE,
        base_color_texture: Some(image),
        unlit: true,
        alpha_mode: AlphaMode::Premultiplied,
        cull_mode: None,
        ..default()
    });
    let entity = commands
        .spawn((
            Mesh3d(mesh.clone()),
            MeshMaterial3d(material.clone()),
            transform,
            RenderLayers::layer(0),
            ChildOf(owner),
        ))
        .id();
    OverviewPlane {
        entity,
        mesh,
        material,
    }
}

pub(crate) fn release_plane(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    plane: OverviewPlane,
) {
    commands.entity(plane.entity).try_despawn();
    meshes.remove(plane.mesh.id());
    materials.remove(plane.material.id());
}

#[derive(Resource, Default)]
pub(crate) struct OverviewTargets {
    targets: std::collections::HashMap<String, OverviewTarget>,
}

impl OverviewTargets {
    pub(crate) fn get(&self, owner: &str) -> Option<&OverviewTarget> {
        self.targets.get(owner)
    }

    pub(crate) fn allocate(
        &mut self,
        owner: &str,
        commands: &mut Commands,
        images: &mut Assets<Image>,
        pool: &mut crate::preview_layers::PreviewLayers,
        size: UVec2,
        transform: Transform,
        projection: OrthographicProjection,
    ) -> Option<crate::preview_layers::LayerSlot> {
        if self.targets.contains_key(owner) {
            return pool.slot_of(&format!("overview:{owner}"));
        }
        let slot = pool.acquire(&format!("overview:{owner}"))?;
        let target = spawn_target(commands, images, size, slot.layer, transform, projection);
        self.targets.insert(owner.to_owned(), target);
        Some(slot)
    }

    pub(crate) fn release(
        &mut self,
        owner: &str,
        slot: crate::preview_layers::LayerSlot,
        commands: &mut Commands,
        images: &mut Assets<Image>,
        pool: &mut crate::preview_layers::PreviewLayers,
        ready: &crate::model_preview::Ready,
    ) -> bool {
        if pool.slot_of(&format!("overview:{owner}")) != Some(slot) { return false; }
        let Some(target) = self.targets.remove(owner) else {
            return false;
        };
        ready.forget(target.camera);
        commands.entity(target.camera).try_despawn();
        images.remove(target.image.id());
        pool.release(&format!("overview:{owner}"));
        true
    }

    /// Transfer a completed color image to its displayed owner while returning the
    /// temporary camera and layer. A late generation cannot consume a newer target.
    pub(crate) fn finish(
        &mut self,
        owner: &str,
        slot: crate::preview_layers::LayerSlot,
        generation: u64,
        commands: &mut Commands,
        pool: &mut crate::preview_layers::PreviewLayers,
        ready: &crate::model_preview::Ready,
    ) -> Option<Handle<Image>> {
        let key = format!("overview:{owner}");
        if pool.slot_of(&key) != Some(slot) { return None; }
        let target = self.targets.get(owner)?;
        if !ready.matches(target.camera, generation) { return None; }
        let target = self.targets.remove(owner)?;
        ready.forget(target.camera);
        commands.entity(target.camera).try_despawn();
        pool.release(&key);
        Some(target.image)
    }
}

pub(crate) fn create_target(images: &mut Assets<Image>, size: UVec2) -> Handle<Image> {
    let mut image = Image::new_uninit(
        Extent3d {
            width: size.x.max(1),
            height: size.y.max(1),
            depth_or_array_layers: 1,
        },
        TextureDimension::D2,
        TextureFormat::Rgba8UnormSrgb,
        RenderAssetUsages::MAIN_WORLD | RenderAssetUsages::RENDER_WORLD,
    );
    image.texture_descriptor.usage |=
        TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING;
    image.sampler = ImageSampler::linear();
    images.add(image)
}

pub(crate) fn spawn_target(
    commands: &mut Commands,
    images: &mut Assets<Image>,
    size: UVec2,
    layer: usize,
    transform: Transform,
    projection: OrthographicProjection,
) -> OverviewTarget {
    let image = create_target(images, size);
    let camera = commands
        .spawn((
            Camera3d::default(),
            Camera {
                order: -10,
                is_active: false,
                clear_color: ClearColorConfig::Custom(Color::NONE),
                ..default()
            },
            RenderTarget::Image(image.clone().into()),
            transform,
            Projection::Orthographic(projection),
            RenderLayers::layer(layer),
            Msaa::Sample4,
            bevy::render::view::Tonemapping::None,
            bevy::render::view::DebandDither::Disabled,
            bevy::render::view::NoIndirectDrawing,
        ))
        .id();
    OverviewTarget { image, camera }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_is_transparent_offscreen_and_uses_only_the_leased_layer() {
        let mut world = World::new();
        world.init_resource::<Assets<Image>>();
        let mut images = world.remove_resource::<Assets<Image>>().unwrap();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        let target = spawn_target(
            &mut Commands::new(&mut queue, &world),
            &mut images,
            UVec2::new(256, 128),
            32,
            Transform::IDENTITY,
            OrthographicProjection::default_3d(),
        );
        queue.apply(&mut world);
        let image = images.get(&target.image).unwrap();
        assert_eq!(image.texture_descriptor.size.width, 256);
        assert_eq!(image.texture_descriptor.size.height, 128);
        assert!(
            image
                .texture_descriptor
                .usage
                .contains(TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING)
        );
        assert_eq!(
            *world.get::<RenderLayers>(target.camera).unwrap(),
            RenderLayers::layer(32)
        );
        assert!(!world.get::<Camera>(target.camera).unwrap().is_active);
    }

    #[test]
    fn target_arms_and_stops_the_render_readiness_probe() {
        let mut world = World::new();
        let mut images = Assets::<Image>::default();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        let target = spawn_target(
            &mut Commands::new(&mut queue, &world), &mut images, UVec2::splat(128), 32,
            Transform::IDENTITY, OrthographicProjection::default_3d(),
        );
        target.arm(&mut Commands::new(&mut queue, &world), 42, vec![], vec![], vec![], true);
        queue.apply(&mut world);
        let view = world.get::<crate::model_preview::PreviewView>(target.camera).unwrap();
        assert_eq!(view.generation, 42);
        assert!(view.rooted);
        assert!(world.get::<Camera>(target.camera).unwrap().is_active);
        target.stop(&mut Commands::new(&mut queue, &world), &crate::model_preview::Ready::default());
        queue.apply(&mut world);
        assert!(world.get::<crate::model_preview::PreviewView>(target.camera).is_none());
        assert!(!world.get::<Camera>(target.camera).unwrap().is_active);
    }

    #[test]
    fn target_uses_shared_pool_and_releases_once() {
        let mut world = World::new();
        world.init_resource::<Assets<Image>>();
        let mut images = world.remove_resource::<Assets<Image>>().unwrap();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        let mut pool = crate::preview_layers::PreviewLayers::default();
        let mut targets = OverviewTargets::default();
        let slot = targets
            .allocate(
                "film",
                &mut Commands::new(&mut queue, &world),
                &mut images,
                &mut pool,
                UVec2::splat(128),
                Transform::IDENTITY,
                OrthographicProjection::default_3d(),
            )
            .unwrap();
        assert!(!crate::preview_layers::PreviewLayers::is_reserved(
            slot.layer
        ));
        queue.apply(&mut world);
        assert!(targets.release(
            "film",
            slot,
            &mut Commands::new(&mut queue, &world),
            &mut images,
            &mut pool,
            &crate::model_preview::Ready::default()
        ));
        assert!(!targets.release(
            "film",
            slot,
            &mut Commands::new(&mut queue, &world),
            &mut images,
            &mut pool,
            &crate::model_preview::Ready::default()
        ));
        queue.apply(&mut world);
        assert_eq!(pool.active(), 0);
        assert!(images.is_empty());
    }

    #[test]
    fn finish_transfers_image_only_for_the_current_slot() {
        let mut world = World::new();
        let mut images = Assets::<Image>::default();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        let mut pool = crate::preview_layers::PreviewLayers::default();
        let mut targets = OverviewTargets::default();
        let ready = crate::model_preview::Ready::default();
        let slot = targets.allocate("film", &mut Commands::new(&mut queue, &world), &mut images,
            &mut pool, UVec2::splat(128), Transform::IDENTITY, OrthographicProjection::default_3d()).unwrap();
        queue.apply(&mut world);
        let stale = crate::preview_layers::LayerSlot { generation: slot.generation.wrapping_add(1), ..slot };
        let camera = targets.get("film").unwrap().camera;
        assert!(targets.finish("film", slot, 8, &mut Commands::new(&mut queue, &world), &mut pool, &ready).is_none());
        ready.mark_for_test(camera, 7);
        assert!(targets.finish("film", stale, 7, &mut Commands::new(&mut queue, &world), &mut pool, &ready).is_none());
        assert!(targets.finish("film", slot, 8, &mut Commands::new(&mut queue, &world), &mut pool, &ready).is_none());
        let image = targets.finish("film", slot, 7, &mut Commands::new(&mut queue, &world), &mut pool, &ready).unwrap();
        queue.apply(&mut world);
        assert!(images.contains(image.id()));
        assert_eq!(pool.active(), 0);
        assert!(targets.finish("film", slot, 7, &mut Commands::new(&mut queue, &world), &mut pool, &ready).is_none());
    }

    #[test]
    fn plane_is_unlit_and_excluded_from_capture_layer() {
        let mut world = World::new();
        let owner = world.spawn_empty().id();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let mut images = Assets::<Image>::default();
        let image = images.add(Image::default());
        let mut queue = bevy::ecs::world::CommandQueue::default();
        let plane = spawn_plane(
            &mut Commands::new(&mut queue, &world),
            &mut meshes,
            &mut materials,
            owner,
            image,
            Vec2::new(20., 10.),
            Transform::IDENTITY,
        );
        queue.apply(&mut world);
        let layers = world.get::<RenderLayers>(plane.entity).unwrap();
        assert!(layers.intersects(&RenderLayers::layer(0)));
        assert!(!layers.intersects(&RenderLayers::layer(crate::model3d::capture::CAPTURE_LAYER)));
        assert!(materials.get(&plane.material).unwrap().unlit);
        assert_eq!(materials.get(&plane.material).unwrap().alpha_mode, AlphaMode::Premultiplied);
        release_plane(
            &mut Commands::new(&mut queue, &world),
            &mut meshes,
            &mut materials,
            plane,
        );
        queue.apply(&mut world);
        assert!(meshes.is_empty());
        assert!(materials.is_empty());
    }

    #[test]
    fn displayed_image_swap_and_removal_release_owned_assets() {
        let mut world = World::new();
        let owner = world.spawn_empty().id();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let mut images = Assets::<Image>::default();
        let first = images.add(Image::default());
        let second = images.add(Image::default());
        let mut displayed = OverviewDisplayed::default();
        let mut queue = bevy::ecs::world::CommandQueue::default();
        assert!(displayed.publish("film", owner, first.clone(), Vec2::splat(10.), Transform::IDENTITY,
            &mut Commands::new(&mut queue, &world), &mut meshes, &mut materials, &mut images));
        queue.apply(&mut world);
        let plane_entity = displayed.entries["film"].plane.entity;
        let missing = Handle::<Image>::default();
        assert!(!displayed.publish("film", owner, missing, Vec2::splat(20.), Transform::IDENTITY,
            &mut Commands::new(&mut queue, &world), &mut meshes, &mut materials, &mut images));
        assert!(images.contains(first.id()));
        assert!(displayed.publish("film", owner, second.clone(), Vec2::splat(20.), Transform::from_xyz(1., 2., 3.),
            &mut Commands::new(&mut queue, &world), &mut meshes, &mut materials, &mut images));
        queue.apply(&mut world);
        let entry = &displayed.entries["film"];
        assert_eq!(entry.plane.entity, plane_entity);
        assert_eq!(materials.get(&entry.plane.material).unwrap().base_color_texture, Some(second.clone()));
        assert!(!images.contains(first.id()));
        assert!(images.contains(second.id()));
        assert_eq!(world.get::<Transform>(plane_entity).unwrap().translation, Vec3::new(1., 2., 3.));
        assert_eq!(meshes.len(), 1);
        assert!(displayed.remove("film", &mut Commands::new(&mut queue, &world), &mut meshes, &mut materials, &mut images));
        assert!(!displayed.remove("film", &mut Commands::new(&mut queue, &world), &mut meshes, &mut materials, &mut images));
        queue.apply(&mut world);
        assert!(meshes.is_empty() && materials.is_empty() && images.is_empty());
        assert!(world.get_entity(plane_entity).is_err());
    }

    #[test]
    fn camera_and_plane_share_canvas_basis_and_cover_bounds() {
        let bounds = super::super::geometry::Bounds2d {
            min_x: 20.,
            min_y: 30.,
            max_x: 220.,
            max_y: 130.,
        };
        let (camera, projection, plane, size) = view_for_bounds(bounds, 2., 5., -10.).unwrap();
        let camera_local = crate::isometric_grid::view_rotation() * camera.translation;
        let plane_local = crate::isometric_grid::view_rotation() * plane.translation;
        assert!((camera_local.x - 120.).abs() < 0.001 && (camera_local.y + 80.).abs() < 0.001);
        assert!((plane_local.x - 120.).abs() < 0.001 && (plane_local.y + 80.).abs() < 0.001);
        assert!((plane_local.z + 10.).abs() < 0.001);
        assert!(size.x >= 210. && size.y >= 110.);
        assert!(matches!(
            projection.scaling_mode,
            bevy::camera::ScalingMode::Fixed { .. }
        ));
        assert_eq!(camera.rotation, plane.rotation);
    }
}
