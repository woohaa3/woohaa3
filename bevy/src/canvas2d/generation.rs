//! Generation/loading overlays. Static geometry and labels change with presentation inputs;
//! media spinners share immutable meshes and animate only their transforms.
use std::collections::{HashMap, HashSet};

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use super::geometry::Geometry;
use super::labels::{LabelRequests, LabelStyle};
use super::layout::{generation_ring_rect, shows_generation_ring};
use crate::app::{CurrentScene, NodeIndex, SurfaceState};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasNodeId, CardPresentation, RunningProgressLayer,
};
use crate::generation_progress::{display_percent, estimate_percent};

const RUNNING_LABEL_FONT: f32 = 13.0;

#[derive(Resource, Default)]
pub(crate) struct GenerationClock {
    pub(crate) started: HashMap<String, f32>,
}

#[derive(Component)]
pub(crate) struct LoadingSpinner {
    owner: Entity,
}

#[derive(Clone, Copy, PartialEq)]
struct OverlayInput {
    owner: Entity,
    rect: [f32; 4],
    z: f32,
    accent: u32,
    /// None is an indeterminate media spinner. Generation rings follow the displayed integer.
    percent: Option<u8>,
}
impl OverlayInput {
    fn center(self) -> Vec2 {
        Vec2::new(
            self.rect[0] + self.rect[2] / 2.,
            self.rect[1] + self.rect[3] / 2.,
        )
    }
    fn radius(self) -> f32 {
        (self.rect[2].min(self.rect[3]) * 0.18).clamp(12., 28.)
    }
}

#[derive(Default)]
pub(crate) struct GenerationCache {
    inputs: Vec<OverlayInput>,
    theme: String,
    spinner_meshes: HashMap<(u32, u32, u32), Handle<Mesh>>,
}

/// Cull against the accepted canvas surface, in CSS pixels (viewport is pan + world * zoom).
fn visible(rect: [f32; 4], viewport: &crate::protocol::Viewport, size: Vec2) -> bool {
    let [x, y, w, h] = rect;
    let zoom = viewport.zoom;
    let left = x * zoom + viewport.x;
    let top = y * zoom + viewport.y;
    size.x > 0.
        && size.y > 0.
        && left <= size.x + 24.
        && top <= size.y + 24.
        && left + w * zoom >= -24.
        && top + h * zoom >= -24.
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_generation(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    surface: Res<SurfaceState>,
    theme: Res<crate::theme::ThemeResource>,
    materials: Res<super::CanvasMaterials>,
    mut clock: ResMut<GenerationClock>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth, &CardPresentation)>,
    layers: Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
    mut spinners: Query<(Entity, &LoadingSpinner, &mut Transform)>,
    mut cache: Local<GenerationCache>,
) {
    let now = time.elapsed_secs();
    let hidden =
        super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some();
    let mut inputs = Vec::new();
    let mut busy = HashSet::new();
    for (owner, id, depth, presentation) in &nodes {
        // Reject idle/type-ineligible nodes before retrieving/cloning any draw DTO.
        if !presentation.busy && !presentation.media_loading {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        if node.group.is_some() || node.composite_asset.is_some() {
            continue;
        }
        if node.busy {
            busy.insert(id.0.as_str());
            if !clock.started.contains_key(&id.0) {
                clock.started.insert(id.0.clone(), now);
            }
        }
        if hidden || !(shows_generation_ring(&node) || (node.media_loading && !node.busy)) {
            continue;
        }
        let (x, y, w, h) = generation_ring_rect(&node);
        let rect = [x, y, w, h];
        if !visible(rect, &scene.0.viewport, surface.size) {
            continue;
        }
        let percent = if node.busy {
            let elapsed = match node.progress_started_at {
                Some(started) if crate::clock::epoch_millis() > 0. => {
                    ((crate::clock::epoch_millis() - started) / 1000.) as f32
                }
                _ => now - clock.started[&node.id],
            };
            // Text already presents integer progress. Keep ring geometry at the same precision,
            // so elapsed time alone does not invalidate a mesh on every frame.
            Some(
                display_percent(estimate_percent(elapsed, &node.kind), node.progress).round() as u8,
            )
        } else {
            None
        };
        inputs.push(OverlayInput {
            owner,
            rect,
            z: 10. + depth.render as f32 * 0.1 + 0.01,
            accent: theme.node_palette(&node.kind).0,
            percent,
        });
    }
    // Busy clocks include offscreen nodes; panning back must not restart generation progress.
    // Focus projections can omit busy owners entirely. Preserve their clocks until overview
    // returns, as before; viewport culling alone never removes a running owner's start time.
    if !hidden {
        clock.started.retain(|id, _| busy.contains(id.as_str()));
    }
    let missing_layer = !inputs.is_empty() && layers.is_empty();
    let missing_spinner = inputs
        .iter()
        .filter(|input| input.percent.is_none())
        .count()
        != spinners.iter().len();
    if cache.inputs != inputs
        || cache.theme != theme.fingerprint()
        || missing_layer
        || missing_spinner
    {
        requests.begin(CanvasLabelRole::Running);
        let old_spinners: HashMap<_, _> = spinners
            .iter()
            .map(|(entity, spinner, _)| (spinner.owner, entity))
            .collect();
        let mut wanted_spinners = HashSet::new();
        let mut used_meshes = HashSet::new();
        let mut geometry = Geometry::default();
        for input in &inputs {
            let [x, y, w, h] = input.rect;
            geometry.rounded_rect(
                x,
                y,
                w,
                h,
                3.,
                input.z,
                theme.token_u32("canvasNodeContent"),
            );
            let center = input.center();
            let radius = input.radius();
            let (label, position) = match input.percent {
                Some(percent) => {
                    geometry.progress_ring(
                        center,
                        radius,
                        percent as f32,
                        input.accent,
                        theme.token_u32("canvasProgressTrack"),
                        input.z + 0.001,
                    );
                    (format!("{percent}%"), center)
                }
                None => {
                    let key = (
                        radius.to_bits(),
                        input.accent,
                        theme.token_u32("canvasProgressTrack"),
                    );
                    used_meshes.insert(key);
                    let handle = cache
                        .spinner_meshes
                        .entry(key)
                        .or_insert_with(|| {
                            let mut ring = Geometry::default();
                            ring.loading_ring(Vec2::ZERO, radius, 0., key.1, key.2, 0.);
                            meshes.add(ring.build())
                        })
                        .clone();
                    let transform =
                        Transform::from_xyz(center.x, -(center.y - 8.), input.z + 0.001)
                            .with_rotation(Quat::from_rotation_z(-now * 3.));
                    if let Some(entity) = old_spinners.get(&input.owner) {
                        commands.entity(*entity).insert((Mesh2d(handle), transform));
                    } else {
                        commands.spawn((
                            LoadingSpinner { owner: input.owner },
                            Mesh2d(handle),
                            MeshMaterial2d(materials.blend.clone()),
                            transform,
                            ChildOf(input.owner),
                            NoFrustumCulling,
                        ));
                    }
                    wanted_spinners.insert(input.owner);
                    ("加载中…".to_owned(), center + Vec2::Y * (radius + 8.))
                }
            };
            requests.push(
                CanvasLabelRole::Running,
                input.owner,
                vec![(label, position, RUNNING_LABEL_FONT, input.accent)],
                input.z + 0.01,
                LabelStyle::Running,
            );
        }
        for (owner, entity) in old_spinners {
            if !wanted_spinners.contains(&owner) {
                commands.entity(entity).despawn();
            }
        }
        cache.spinner_meshes.retain(|key, handle| {
            if used_meshes.contains(key) {
                true
            } else {
                meshes.remove(handle.id());
                false
            }
        });
        // Empty overlays are cleared once, then remain untouched until content returns.
        if !inputs.is_empty() || !cache.inputs.is_empty() {
            replace_overlay_mesh(
                &mut commands,
                &mut meshes,
                &materials,
                &layers,
                geometry.build(),
            );
        }
        cache.inputs = inputs;
        cache.theme = theme.fingerprint().to_owned();
    }
    let rotation = Quat::from_rotation_z(-now * 3.);
    for (_, _, mut transform) in &mut spinners {
        if transform.rotation != rotation {
            transform.rotation = rotation;
        }
    }
}

fn replace_overlay_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &super::CanvasMaterials,
    layers: &Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
    built: Mesh,
) {
    let handle = meshes.add(built);
    match layers.iter().next() {
        Some((entity, old_handle)) => {
            if let Some(old) = old_handle {
                meshes.remove(old.0.id());
            }
            commands.entity(entity).insert(Mesh2d(handle));
        }
        None => {
            commands.spawn((
                RunningProgressLayer,
                Mesh2d(handle),
                MeshMaterial2d(materials.blend.clone()),
                NoFrustumCulling,
            ));
        }
    }
}

#[cfg(test)]
mod tests;
