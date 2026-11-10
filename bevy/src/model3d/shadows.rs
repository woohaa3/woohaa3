//! Fixed renderer policy and camera-scoped directional shadow casters.
//! Bevy 0.20 normally uses the light's union of layers for every cascade. Narrow
//! both CPU visibility and render-world shadow views to the owning camera, while
//! retaining one shared light (including on WebGL2's one-light backend).
use bevy::{
    camera::visibility::{CascadesVisibleEntities, RenderLayers},
    light::{
        CascadeShadowConfig, CascadeShadowConfigBuilder, DirectionalLightShadowMap,
        NotShadowCaster, SimulationLightSystems,
    },
    prelude::*,
    render::{Render, RenderApp, RenderSystems},
};

pub(crate) const MAP_SIZE: usize = 2048;

/// Shooting views do not consume the canvas light. Geometry is shared, while
/// their ambient baseline is owned by the camera rather than global state.
#[derive(Component)]
pub(crate) struct IgnoreGlobalLight;

pub(crate) fn camera_lighting() -> (IgnoreGlobalLight, bevy::light::AmbientLight) {
    (
        IgnoreGlobalLight,
        bevy::light::AmbientLight {
            color: Color::WHITE,
            brightness: 600.0,
            ..default()
        },
    )
}

/// Light arrives from world +Z and casts toward -Z: lower-left to upper-right
/// along a ground-grid axis in the default orthographic canvas. Keep elevation.
pub(crate) fn world_light_rotation() -> Quat {
    Quat::from_rotation_x(-crate::isometric_grid::CANVAS_CAMERA_PITCH)
}

/// `off` is a build-time comparison probe; normal builds always enable shadows.
pub(crate) fn light() -> DirectionalLight {
    DirectionalLight {
        color: Color::srgb_u8(255, 245, 223),
        illuminance: 4_000.0,
        shadow_maps_enabled: option_env!("WOOHAA_MODEL_SHADOWS") != Some("off"),
        shadow_depth_bias: 0.02,
        shadow_normal_bias: 1.8,
        ..default()
    }
}

#[cfg(test)]
fn cascades() -> CascadeShadowConfig {
    cascades_for_scale(super::CANVAS_UNITS_PER_METER)
}

fn cascades_for_scale(units_per_meter: f32) -> CascadeShadowConfig {
    // WebGL2 supports one cascade. Keep the same bounded policy on all backends.
    CascadeShadowConfigBuilder {
        num_cascades: 1,
        minimum_distance: 0.0,
        maximum_distance: 20.0 * units_per_meter,
        first_cascade_far_bound: 5.0 * units_per_meter,
        overlap_proportion: 0.1,
    }
    .build()
}

#[derive(Component)]
struct FixedModelLight {
    shadow_maps_enabled: bool,
}

/// Startup/reinitialization is idempotent; layer leases are preserved on retry.
pub(crate) fn install_light(
    commands: &mut Commands,
    rotation: Quat,
    layers: RenderLayers,
    enabled: bool,
    units_per_meter: f32,
) {
    commands.queue(move |world: &mut World| {
        let mut query = world.query_filtered::<Entity, With<FixedModelLight>>();
        let existing = query.iter(world).next();
        let mut source = light();
        source.shadow_maps_enabled &= enabled;
        let fixed = FixedModelLight {
            shadow_maps_enabled: source.shadow_maps_enabled,
        };
        let transform = Transform::from_xyz(180.0, 260.0, 300.0).with_rotation(rotation);
        if let Some(entity) = existing {
            let mask = world
                .get::<RenderLayers>(entity)
                .cloned()
                .unwrap_or_default()
                .union(&layers);
            world.entity_mut(entity).insert((
                fixed,
                source,
                cascades_for_scale(units_per_meter),
                transform,
                mask,
            ));
        } else {
            world.spawn((
                fixed,
                source,
                cascades_for_scale(units_per_meter),
                transform,
                layers,
            ));
        }
    });
}

pub(crate) struct ModelShadowsPlugin;
impl Plugin for ModelShadowsPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(DirectionalLightShadowMap { size: MAP_SIZE })
            .add_systems(
                PostUpdate,
                (sync_global_light, sync_transparent_casters)
                    .before(SimulationLightSystems::CheckLightVisibility),
            )
            .add_systems(
                PostUpdate,
                isolate_cpu_casters.after(SimulationLightSystems::CheckLightVisibility),
            );
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            render.add_systems(
                Render,
                isolate_shadow_views
                    .in_set(RenderSystems::CreateViews)
                    .after(bevy::pbr::prepare_lights),
            );
        }
    }
}

// The native single-model renderer has no CurrentScene and keeps its fixed policy.
// Only ordinary canvas/model views consume the global preference. Shooting
// cameras keep their own lighting, without mutating the source during recording.
fn sync_global_light(
    #[cfg(feature = "canvas-core")] scene: Option<Res<crate::app::CurrentScene>>,
    cameras: Query<
        Option<&RenderLayers>,
        (
            With<Camera3d>,
            Without<IgnoreGlobalLight>,
            Without<FixedModelLight>,
        ),
    >,
    mut lights: Query<(&FixedModelLight, &mut DirectionalLight, &mut RenderLayers)>,
) {
    #[cfg(feature = "canvas-core")]
    let enabled = scene
        .as_ref()
        .and_then(|scene| scene.0.global_light_enabled)
        .unwrap_or(true);
    #[cfg(not(feature = "canvas-core"))]
    let enabled = true;
    // Recompute instead of unioning leases forever: a former ordinary preview
    // slot can be reused by a bound shooting camera on the next frame.
    let mut view_layers = RenderLayers::none();
    for layers in &cameras {
        view_layers = view_layers.union(layers.unwrap_or_default());
    }
    view_layers = view_layers.without(crate::preview_layers::WORLD_CAMERA_CONTENT_LAYER);
    for (fixed, mut source, mut layers) in &mut lights {
        if *layers != view_layers {
            *layers = view_layers.clone();
        }
        let illuminance = if enabled { light().illuminance } else { 0.0 };
        let shadows = enabled && fixed.shadow_maps_enabled;
        if source.illuminance != illuminance || source.shadow_maps_enabled != shadows {
            source.illuminance = illuminance;
            source.shadow_maps_enabled = shadows;
        }
    }
}

// Only remove exclusions owned here; helpers' permanent exclusions are retained.
#[derive(Component)]
struct TransparentCaster;
fn sync_transparent_casters(
    mut commands: Commands,
    materials: Res<Assets<StandardMaterial>>,
    meshes: Query<(
        Entity,
        &MeshMaterial3d<StandardMaterial>,
        Has<NotShadowCaster>,
        Has<TransparentCaster>,
    )>,
) {
    for (entity, handle, excluded, owned) in &meshes {
        let Some(material) = materials.get(&handle.0) else {
            continue;
        };
        let transparent = !matches!(
            material.alpha_mode,
            bevy::material::AlphaMode::Opaque | bevy::material::AlphaMode::Mask(_)
        );
        if transparent && !excluded {
            commands
                .entity(entity)
                .insert((NotShadowCaster, TransparentCaster));
        } else if !transparent && owned {
            commands
                .entity(entity)
                .remove::<(NotShadowCaster, TransparentCaster)>();
        }
    }
}

fn isolate_cpu_casters(
    cameras: Query<Option<&RenderLayers>, With<Camera3d>>,
    meshes: Query<Option<&RenderLayers>, With<Mesh3d>>,
    mut lights: Query<&mut CascadesVisibleEntities, With<DirectionalLight>>,
) {
    for mut visible in &mut lights {
        for (camera, cascades) in &mut visible.entities {
            let Ok(layers) = cameras.get(*camera) else {
                continue;
            };
            let layers = layers.cloned().unwrap_or_default();
            for cascade in cascades {
                cascade.entities.retain(|entity| {
                    meshes
                        .get(*entity)
                        .is_ok_and(|mesh| layers.intersects(mesh.unwrap_or_default()))
                });
            }
        }
    }
}

fn isolate_shadow_views(
    cameras: Query<
        (&bevy::pbr::ViewLightEntities, Option<&RenderLayers>),
        Without<bevy::pbr::LightEntity>,
    >,
    mut shadows: Query<(&bevy::pbr::LightEntity, &mut RenderLayers)>,
) {
    for (views, layers) in &cameras {
        for entity in &views.lights {
            if let Ok((bevy::pbr::LightEntity::Directional { .. }, mut mask)) =
                shadows.get_mut(*entity)
            {
                let camera = layers.cloned().unwrap_or_default();
                *mask = mask.intersection(&camera);
            }
        }
    }
}

#[cfg(test)]
mod tests;
