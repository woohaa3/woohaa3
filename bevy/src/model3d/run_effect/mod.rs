//! Disposable editor visuals. Never part of model roots, bounds, picking, capture or recording.
//! Two submissions and 34 triangles per full owner (static fallback + GPU scan).
mod geometry;
mod material;
mod plan;

use super::{ModelVisuals, grid::ModelCanvasCamera};
use crate::{
    app::{CurrentScene, FocusRig, ModelAssetTable, SurfaceState},
    theme::ThemeResource,
};
use bevy::{
    camera::visibility::{NoFrustumCulling, RenderLayers},
    prelude::*,
};
use material::RunMaterial;
use plan::Lod;
use std::collections::{HashMap, HashSet};

pub(crate) const WORK_LAYER: usize = super::RUN_EFFECT_LAYER;
pub(crate) struct RunEffectPlugin;
impl Plugin for RunEffectPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(MaterialPlugin::<RunMaterial>::default())
            .init_resource::<RunEffects>()
            .init_resource::<RunEffectSettings>();
    }
}

/// Runtime-only control for paired hardware captures. It never changes the accepted scene.
#[derive(Resource)]
pub(crate) struct RunEffectSettings {
    pub(crate) enabled: bool,
}
impl Default for RunEffectSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Clone, PartialEq)]
struct Key {
    ground: [Vec3; 4],
    volume: Option<([Vec3; 4], Vec3)>,
    width: f32,
    color: Color,
    warning: bool,
    lod: Lod,
    pixel_ratio: f32,
    size_lod: Lod,
    camera: Vec3,
}
struct Entry {
    operation: String,
    start: f32,
    stop: Option<f32>,
    key: Option<Key>,
    entities: Vec<Entity>,
    meshes: Vec<Handle<Mesh>>,
    base: Option<Handle<StandardMaterial>>,
    scan: Option<Handle<RunMaterial>>,
}
impl Entry {
    fn new(operation: String, now: f32) -> Self {
        Self {
            operation,
            start: now,
            stop: None,
            key: None,
            entities: vec![],
            meshes: vec![],
            base: None,
            scan: None,
        }
    }
    fn clear(
        &mut self,
        commands: &mut Commands,
        meshes: &mut Assets<Mesh>,
        base: &mut Assets<StandardMaterial>,
        scan: &mut Assets<RunMaterial>,
    ) {
        for entity in self.entities.drain(..) {
            commands.entity(entity).despawn();
        }
        for mesh in self.meshes.drain(..) {
            meshes.remove(mesh.id());
        }
        if let Some(handle) = self.base.take() {
            base.remove(handle.id());
        }
        if let Some(handle) = self.scan.take() {
            scan.remove(handle.id());
        }
        self.key = None;
    }
}
#[derive(Resource, Default)]
pub(crate) struct RunEffects {
    entries: HashMap<String, Entry>,
    hidden: bool,
    focus: Option<String>,
    ready: HashSet<String>,
    /// Changes only on geometry upload, suitable for zero-target / steady-scene assertions.
    pub(crate) geometry_uploads: u64,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    rig: Res<FocusRig>,
    models: Res<ModelVisuals>,
    resources: Res<ModelAssetTable>,
    theme: Res<ThemeResource>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut base: ResMut<Assets<StandardMaterial>>,
    mut scan: ResMut<Assets<RunMaterial>>,
    mut effects: ResMut<RunEffects>,
    settings: Res<RunEffectSettings>,
    cameras: Query<(&Camera, Ref<GlobalTransform>), With<ModelCanvasCamera>>,
    windows: Query<&Window>,
) {
    let now = time.elapsed_secs();
    let hidden = browser_hidden()
        || windows.iter().any(|window| !window.visible)
        || surface.size.min_element() <= 0.
        || !settings.enabled
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some();
    let ready: HashSet<_> = effects
        .entries
        .keys()
        .filter(|id| models.roots.contains_key(*id))
        .cloned()
        .collect();
    let rebuild = scene.is_changed()
        || surface.is_changed()
        || theme.is_changed()
        || settings.is_changed()
        || effects.hidden != hidden
        || effects.focus != rig.focus_node
        || (rig.focus_node.is_some()
            && cameras.iter().any(|(_, transform)| transform.is_changed()))
        || effects.ready != ready;
    if !rebuild && !effects.entries.values().any(|entry| entry.stop.is_some()) {
        return;
    }
    if rebuild {
        effects.hidden = hidden;
        effects.focus = rig.focus_node.clone();
        effects.ready = ready;
        let mut targets: Vec<_> = scene
            .0
            .nodes
            .iter()
            .filter(|n| {
                n.aggregate_run.is_some()
                    && n.run_feedback
                        .as_ref()
                        .is_some_and(|feedback| feedback.active)
            })
            .collect();
        let view = &scene.0.viewport;
        let center = surface.size * 0.5;
        targets.sort_by(|a, b| {
            let priority = |n: &crate::protocol::GraphNode| {
                (
                    rig.focus_node.as_deref() != Some(n.id.as_str()),
                    !scene.0.selection.nodes.contains(&n.id),
                    (Vec2::new(n.x + n.width * 0.5, n.y + n.height * 0.5) * view.zoom
                        + Vec2::new(view.x, view.y)
                        - center)
                        .length_squared(),
                )
            };
            let pa = priority(a);
            let pb = priority(b);
            pa.0.cmp(&pb.0)
                .then(pa.1.cmp(&pb.1))
                .then(pa.2.total_cmp(&pb.2))
                .then(a.id.cmp(&b.id))
        });
        let (mut full, mut animated) = (0, 0);
        let live: HashSet<_> = targets.iter().map(|n| n.id.clone()).collect();
        for node in targets {
            let run = node.aggregate_run.as_ref().unwrap();
            let feedback = node.run_feedback.as_ref().unwrap();
            let scope = crate::canvas_query::scope::node_scope(node);
            let reference = node.model.as_ref();
            let model = reference.and_then(|r| resources.0.get(&r.resource_key));
            let root = model
                .zip(reference)
                .map(|(m, r)| super::layout::film_set_root_transform(node, m, &r.placement));
            let root_y = root.as_ref().map_or_else(
                || super::layout::canvas_world_position(scope.center.x, scope.center.y, 0.).y,
                |t| t.translation.y,
            );
            let ground = plan::ground(scope.vertices, root_y);
            let focused = rig.focus_node.as_deref() == Some(node.id.as_str());
            let mut size = scope.aabb.width.max(scope.aabb.height) * view.zoom;
            if focused {
                if let Ok((camera, transform)) = cameras.single() {
                    let points: Vec<_> = ground
                        .iter()
                        .filter_map(|p| camera.world_to_viewport(&transform, *p).ok())
                        .collect();
                    if !points.is_empty() {
                        let min = points
                            .iter()
                            .copied()
                            .fold(Vec2::splat(f32::INFINITY), Vec2::min);
                        let max = points
                            .iter()
                            .copied()
                            .fold(Vec2::splat(f32::NEG_INFINITY), Vec2::max);
                        size = (max - min).max_element();
                    }
                }
            }
            let screen_min =
                Vec2::new(scope.aabb.x, scope.aabb.y) * view.zoom + Vec2::new(view.x, view.y);
            let screen_max =
                screen_min + Vec2::new(scope.aabb.width, scope.aabb.height) * view.zoom;
            let offscreen = !focused
                && (screen_max.x < 0.
                    || screen_max.y < 0.
                    || screen_min.x > surface.size.x
                    || screen_min.y > surface.size.y);
            let previous = effects
                .entries
                .get(&node.id)
                .and_then(|e| e.key.as_ref())
                .map(|k| k.size_lod)
                .filter(|lod| *lod != Lod::Hidden);
            let moving = matches!(feedback.phase.as_str(), "running" | "committing")
                && !(run.reduce_motion || feedback.reduce_motion);
            let desired = if hidden
                || offscreen
                || rig.focus_node.as_ref().is_some_and(|id| id != &node.id)
            {
                Lod::Hidden
            } else if !moving {
                Lod::Static
            } else if focused {
                Lod::Full
            } else {
                plan::size_lod(size, previous)
            };
            let mut lod = plan::budget(desired, &mut full, &mut animated);
            let mut volume = if lod == Lod::Full && models.roots.contains_key(&node.id) {
                node.composite_asset
                    .as_ref()
                    .and_then(|asset| asset.layout_aabb)
                    .or_else(|| model.and_then(|m| m.aabb))
                    .zip(root)
                    .and_then(|(bounds, root)| {
                        let min = Vec3::from_array(bounds.min);
                        let max = Vec3::from_array(bounds.max);
                        let height = max.y - min.y;
                        if !height.is_finite() || height <= 0.001 {
                            return None;
                        }
                        let bottom = [
                            Vec3::new(min.x, min.y, min.z),
                            Vec3::new(max.x, min.y, min.z),
                            Vec3::new(max.x, min.y, max.z),
                            Vec3::new(min.x, min.y, max.z),
                        ]
                        .map(|p| root.transform_point(p));
                        Some((bottom, root.rotation * Vec3::Y * height * root.scale.y))
                    })
            } else {
                None
            };
            if let Some((bottom, axis)) = volume {
                if let Ok((camera, transform)) = cameras.single() {
                    let area = |points: [Vec3; 4]| -> Option<f32> {
                        let p: Vec<_> = points
                            .into_iter()
                            .map(|p| camera.world_to_viewport(&transform, p).ok())
                            .collect::<Option<_>>()?;
                        Some(
                            (0..4)
                                .map(|i| p[i].perp_dot(p[(i + 1) % 4]))
                                .sum::<f32>()
                                .abs()
                                * 0.5,
                        )
                    };
                    if [area(bottom), area(bottom.map(|p| p + axis))]
                        .into_iter()
                        .flatten()
                        .any(|area| area > surface.size.x * surface.size.y * 0.35)
                    {
                        volume = None;
                    }
                }
            }
            if lod == Lod::Full && volume.is_none() {
                lod = Lod::Outline;
                full -= 1;
            }
            // World-space width is derived from the actual projected footprint and capped at 2 CSS px.
            let projected_world = ground[0]
                .distance(ground[2])
                .max(ground[1].distance(ground[3]))
                .max(0.001);
            let width =
                (projected_world / size.max(1.) * 1.6).clamp(0.001, projected_world * 0.025);
            let warning = feedback.phase == "verifying";
            let color = theme.token_color(if warning {
                "statusWarning"
            } else {
                "interactionAccent"
            });
            let camera = cameras
                .single()
                .map(|(_, t)| *t.forward())
                .unwrap_or(Vec3::new(1., -1., 1.).normalize());
            let key = Key {
                ground,
                volume,
                width,
                color,
                warning,
                lod,
                pixel_ratio: scene
                    .0
                    .surface
                    .as_ref()
                    .map_or(1., |surface| surface.pixel_ratio),
                size_lod: desired,
                camera,
            };
            let operation = feedback
                .operation_key
                .clone()
                .or_else(|| feedback.source.clone())
                .unwrap_or_default();
            let entry = effects
                .entries
                .entry(node.id.clone())
                .or_insert_with(|| Entry::new(operation.clone(), now));
            if entry.operation != operation {
                entry.clear(&mut commands, &mut meshes, &mut base, &mut scan);
                *entry = Entry::new(operation, now);
            }
            if entry.key.as_ref() == Some(&key) {
                continue;
            }
            entry.clear(&mut commands, &mut meshes, &mut base, &mut scan);
            entry.stop = None;
            entry.key = Some(key.clone());
            if lod == Lod::Hidden {
                continue;
            }
            let mesh = meshes.add(geometry::boundary(ground, width * 0.65, camera, warning));
            let material = base.add(StandardMaterial {
                base_color: color.with_alpha(0.52),
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            });
            let layers = RenderLayers::layer(WORK_LAYER);
            entry.entities.push(
                commands
                    .spawn((
                        Mesh3d(mesh.clone()),
                        MeshMaterial3d(material.clone()),
                        Transform::IDENTITY,
                        NoFrustumCulling,
                        layers.clone(),
                    ))
                    .id(),
            );
            entry.meshes.push(mesh);
            entry.base = Some(material);
            if matches!(lod, Lod::Full | Lod::Outline) {
                let mesh = meshes.add(geometry::animated(ground, volume, width, camera));
                let material = scan.add(RunMaterial {
                    color: color.to_linear(),
                    timing: Vec4::new(
                        entry.start % time.wrap_period().as_secs_f32(),
                        -1.,
                        2. * key.pixel_ratio,
                        time.wrap_period().as_secs_f32(),
                    ),
                    axis: volume.map_or(Vec4::ZERO, |(_, axis)| axis.extend(0.)),
                });
                entry.entities.push(
                    commands
                        .spawn((
                            Mesh3d(mesh.clone()),
                            MeshMaterial3d(material.clone()),
                            Transform::IDENTITY,
                            NoFrustumCulling,
                            layers,
                        ))
                        .id(),
                );
                entry.meshes.push(mesh);
                entry.scan = Some(material);
            }
            effects.geometry_uploads += 1;
        }
        for (id, entry) in &mut effects.entries {
            if live.contains(id) || entry.stop.is_some() {
                continue;
            }
            if !scene.0.nodes.iter().any(|node| &node.id == id) || hidden {
                entry.clear(&mut commands, &mut meshes, &mut base, &mut scan);
            } else if let Some(mut material) = entry.scan.as_ref().and_then(|h| scan.get_mut(h)) {
                material.timing.y = now % time.wrap_period().as_secs_f32();
            }
            entry.stop = Some(now);
        }
    }
    effects.entries.retain(|_, entry| {
        if entry.stop.is_some_and(|stop| now - stop >= 0.18) {
            entry.clear(&mut commands, &mut meshes, &mut base, &mut scan);
            false
        } else {
            true
        }
    });
}

#[cfg(target_arch = "wasm32")]
fn browser_hidden() -> bool {
    use wasm_bindgen::JsValue;
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("document"))
        .and_then(|document| js_sys::Reflect::get(&document, &JsValue::from_str("hidden")))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}
#[cfg(not(target_arch = "wasm32"))]
fn browser_hidden() -> bool {
    false
}

#[cfg(test)]
mod gpu_tests;
#[cfg(test)]
mod tests;
