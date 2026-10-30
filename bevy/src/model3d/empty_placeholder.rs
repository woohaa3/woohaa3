//! Derived overview chrome. No model roots, pick markers, content bounds or asynchronous work.
//!
//! The empty-film-set placeholder is a themed plinth: a low platform derived from the accepted
//! scope footprint, with the two camera-facing side faces carrying extruded 3D brand labels
//! `WOOHAA3` and `片场` (change: 2026-10-25-empty-film-set-fence).
//!
//! Film sets are group containers now, so the same plinth also stands in for the empty scene
//! inside the group's identity badge: the badge shows the brand model until the film set has a
//! scene binding or an authored ground, then the real scene composition replaces it.
//!
//! The plinth lies on the canvas floor: its footprint is derived in ground space so the screen
//! silhouette turns with [`CANVAS_CAMERA_PITCH`] like every other model in the scene.
use crate::{
    app::{CurrentScene, FocusRig},
    canvas_query::{group_model, scope},
    isometric_grid::{
        CANVAS_CAMERA_PITCH, canvas_camera_rotation, canvas_point_to_world, view_rotation,
    },
    theme::ThemeResource,
};
use bevy::{
    asset::RenderAssetUsages, camera::visibility::RenderLayers, mesh::Indices, prelude::*,
    render::render_resource::PrimitiveTopology,
};
use std::collections::{HashMap, HashSet};

mod text;
use text::{PIANCHANG_JSON, WOOHAA3_JSON};

pub(crate) use super::FILM_SET_PLACEHOLDER_LAYER;

/// Footprint inset from the accepted scope, leaving room for the vertical projection.
const PLINTH_INSET: f32 = 0.65;
/// Badge-fitting footprint fraction: larger than the scope inset so the compact badge still reads
/// as a plinth, while the platform and its extruded letters stay inside the badge rectangle at
/// every badge scale.
const BADGE_PLINTH_INSET: f32 = 0.72;
/// Platform side height as a fraction of the shorter footprint edge.
const PLINTH_DEPTH_RATIO: f32 = 0.13;
/// Letter height as a fraction of the shorter footprint edge (before face fitting).
const LABEL_HEIGHT_RATIO: f32 = 0.11;
/// Keep the back of the extruded letters just outside their side face.
const TEXT_BASE_OFFSET: f32 = 0.02;
/// Extrusion depth of the generated letters, in label-height units.
const TEXT_DEPTH_RATIO: f32 = 0.18;
/// Width / height of the two fixed glyph meshes; verified against the embedded JSON below.
const WOOHAA3_WIDTH: f32 = 6.533_6;
const PIANCHANG_WIDTH: f32 = 2.065_15;

/// Fixed 3D glyph geometry generated from the bundled Noto Sans SC font. The JSON is embedded so
/// the placeholder never depends on the asset server for its lettering.
#[derive(serde::Deserialize)]
struct TextMeshData {
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
    width: f32,
}

#[derive(Resource, Default)]
pub(crate) struct Placeholders {
    entries: HashMap<String, Plinth>,
    shared: Option<SharedAssets>,
    theme: Option<String>,
}

#[derive(Clone)]
struct SharedAssets {
    /// `WOOHAA3` and `片场`, in left/right slot order. `None` degrades only the lettering.
    text_meshes: [Option<Handle<Mesh>>; 2],
    side_material: Handle<StandardMaterial>,
    top_material: Handle<StandardMaterial>,
    text_material: Handle<StandardMaterial>,
}

struct Plinth {
    body: Entity,
    top: Entity,
    labels: [Option<Entity>; 2],
    side_mesh: Handle<Mesh>,
    top_mesh: Handle<Mesh>,
    top_vertices: [Vec3; 4],
    depth: f32,
}

#[derive(Clone, Copy, Debug)]
struct Face {
    normal: Vec3,
    /// World-local point at the middle of the vertical face.
    center: Vec3,
    /// World-local point at the middle of the top edge (used for screen ordering).
    top_mid: Vec3,
    edge: f32,
}

#[derive(Clone, Copy, Debug)]
struct Label {
    normal: Vec3,
    /// World-local point on the face plane, slightly outside the side surface.
    center: Vec3,
    height: f32,
    width: f32,
    /// Outward depth of the extruded front cap.
    depth: f32,
    text: &'static str,
}

struct Layout {
    center: Vec3,
    top: [Vec3; 4],
    depth: f32,
    labels: Vec<Label>,
}

pub(crate) fn is_overview(scene: &crate::protocol::Scene, focused: bool) -> bool {
    !focused
        && scene.model_focus.is_none()
        && scene.image_focus.is_none()
        && scene.video_focus.is_none()
        && !scene
            .animation_playback
            .as_ref()
            .is_some_and(|p| p.view_mode == "focus-preview")
}

pub(crate) fn overview_layers(overview: bool) -> RenderLayers {
    if overview {
        RenderLayers::from_layers(&[0, super::RUN_EFFECT_LAYER, FILM_SET_PLACEHOLDER_LAYER])
    } else {
        RenderLayers::from_layers(&[0, super::RUN_EFFECT_LAYER])
    }
}

/// Project accepted scope vertices onto the ground along the overview camera rays, inset from the
/// scope boundary, then extrude a themed plinth downward.
fn plinth_layout(scope: &scope::ScopeGeometry) -> Layout {
    // A diamond plinth keeps two vertical side faces visible to the isometric camera. Both scope
    // shapes map to a diamond footprint: a diamond scope is inset around its center, while a rect
    // scope uses an inscribed ground square (see [`ground_diamond`]).
    let footprint = if scope.ground.is_some() {
        scope
            .vertices
            .map(|p| scope.center + (p - scope.center) * PLINTH_INSET)
    } else {
        let rx = scope.aabb.width * 0.5 * PLINTH_INSET;
        let ry = scope.aabb.height * 0.5 * PLINTH_INSET;
        ground_diamond(scope.center, rx, ry)
    };
    plinth_layout_from_footprint(footprint)
}

/// Empty film-set group: the plinth occupies the identity badge instead of a scene scope, so the
/// badge keeps a recognisable brand model until the first object or ground arrives.
fn badge_plinth_layout(node: &crate::protocol::GraphNode) -> Layout {
    let badge = group_model::badge_rect(node);
    let center = Vec2::new(badge.x + badge.z * 0.5, badge.y + badge.w * 0.5);
    plinth_layout_from_footprint(ground_diamond(
        center,
        badge.z * 0.5 * BADGE_PLINTH_INSET,
        badge.w * 0.5 * BADGE_PLINTH_INSET,
    ))
}

/// Diamond footprint centred on `center` with the given half width/height, in canvas units.
fn diamond(center: Vec2, rx: f32, ry: f32) -> [Vec2; 4] {
    [
        Vec2::new(center.x, center.y - ry),
        Vec2::new(center.x + rx, center.y),
        Vec2::new(center.x, center.y + ry),
        Vec2::new(center.x - rx, center.y),
    ]
}

/// Ground-aligned diamond that fits inside the given canvas half extents.
///
/// A footprint authored purely in canvas space unprojects to the ground with the same camera and
/// projects back to the very same silhouette at every pitch, so the placeholder would silently
/// ignore `CANVAS_CAMERA_PITCH` while every real model turns with the camera. Laying the footprint
/// on the canvas floor instead pins the screen edge slope to `sin(pitch)`: the plinth turns with
/// the isometric grid and still fits the rect it fills.
fn ground_diamond(center: Vec2, half_width: f32, half_height: f32) -> [Vec2; 4] {
    let slope = CANVAS_CAMERA_PITCH.sin().clamp(0.0, 1.0);
    let rx = if slope > f32::EPSILON {
        half_width.min(half_height / slope)
    } else {
        half_width
    };
    diamond(center, rx, rx * slope)
}

fn plinth_layout_from_footprint(footprint: [Vec2; 4]) -> Layout {
    let direction = canvas_camera_rotation() * Vec3::NEG_Z;
    let ground = footprint.map(|p| {
        let origin = canvas_point_to_world(p.x, p.y, 0.);
        origin + direction * (-origin.y / direction.y)
    });
    let center = ground.iter().copied().sum::<Vec3>() / 4.0;
    let top = ground.map(|p| p - center);
    let short = (0..4)
        .map(|i| (top[(i + 1) % 4] - top[i]).length())
        .fold(f32::INFINITY, f32::min);
    let short = if short.is_finite() {
        short.max(0.0)
    } else {
        0.0
    };
    let depth = short * PLINTH_DEPTH_RATIO;

    let faces: [Face; 4] = std::array::from_fn(|i| {
        let a = top[i];
        let b = top[(i + 1) % 4];
        let edge = b - a;
        let mut normal = edge.cross(Vec3::Y).normalize_or_zero();
        let mid = (a + b) * 0.5;
        if normal.dot(mid) < 0.0 {
            normal = -normal;
        }
        Face {
            normal,
            center: mid + Vec3::NEG_Y * depth * 0.5,
            top_mid: mid,
            edge: edge.length(),
        }
    });

    let camera_toward = canvas_camera_rotation() * Vec3::Z;
    let mut visible: Vec<(usize, f32)> = (0..4)
        .filter(|&i| faces[i].normal.dot(camera_toward) > 0.0)
        .map(|i| (i, (view_rotation() * (center + faces[i].top_mid)).x))
        .collect();
    visible.sort_by(|a, b| a.1.total_cmp(&b.1));
    if visible.len() < 2 {
        // Degenerate/exactly edge-on geometry: retain a deterministic pair rather than dropping
        // the labels. Valid accepted scopes always have two camera-facing sides.
        let mut all: Vec<(usize, f32)> = (0..4)
            .map(|i| (i, faces[i].normal.dot(camera_toward)))
            .collect();
        all.sort_by(|a, b| b.1.total_cmp(&a.1));
        visible = all
            .into_iter()
            .take(2)
            .map(|(i, _)| (i, (view_rotation() * (center + faces[i].top_mid)).x))
            .collect();
        visible.sort_by(|a, b| a.1.total_cmp(&b.1));
    }
    visible.truncate(2);

    let labels = visible
        .iter()
        .enumerate()
        .filter_map(|(slot, (index, _))| {
            let face = &faces[*index];
            let (text, width_ratio) = if slot == 0 {
                ("WOOHAA3", WOOHAA3_WIDTH)
            } else {
                ("片场", PIANCHANG_WIDTH)
            };
            let height = (short * LABEL_HEIGHT_RATIO)
                .min(face.edge * 0.82 / width_ratio)
                .min(depth * 0.82)
                .max(0.0);
            (height > 0.0).then_some(Label {
                normal: face.normal,
                center: face.center + face.normal * TEXT_BASE_OFFSET,
                height,
                width: height * width_ratio,
                depth: height * TEXT_DEPTH_RATIO,
                text,
            })
        })
        .collect();

    Layout {
        center,
        top,
        depth,
        labels,
    }
}

fn label_transform(label: &Label) -> Transform {
    debug_assert!(label.width > 0.0 && label.depth > 0.0);
    let right = Vec3::Y.cross(label.normal).normalize_or_zero();
    if right.length_squared() < 1e-6 {
        return Transform::from_translation(label.center).with_scale(Vec3::ZERO);
    }
    let rotation = Quat::from_mat3(&Mat3::from_cols(right, Vec3::Y, label.normal));
    // The generated mesh is one label-height tall, centred on the origin in X/Y, and extends
    // outward from z=0 to z=TEXT_DEPTH_RATIO.
    Transform::from_translation(label.center)
        .with_rotation(rotation)
        .with_scale(Vec3::splat(label.height))
}

fn text_mesh(json: &str) -> Option<Mesh> {
    let data: TextMeshData = serde_json::from_str(json).ok()?;
    if !data.width.is_finite()
        || data.width <= 0.0
        || data.positions.is_empty()
        || data.indices.is_empty()
        || data.indices.len() % 3 != 0
        || data
            .indices
            .iter()
            .any(|&i| i as usize >= data.positions.len())
    {
        return None;
    }
    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, data.positions);
    mesh.insert_indices(Indices::U32(data.indices));
    mesh.duplicate_vertices();
    mesh.compute_flat_normals();
    Some(mesh)
}

/// Four vertical side quads (no top face; the light top plate is a separate entity).
fn side_mesh(top: &[Vec3; 4], depth: f32) -> Mesh {
    let mut positions = Vec::with_capacity(16);
    let mut indices = Vec::with_capacity(24);
    for i in 0..4 {
        let a = top[i];
        let b = top[(i + 1) % 4];
        let base = positions.len() as u32;
        positions.extend([a, a - Vec3::Y * depth, b - Vec3::Y * depth, b]);
        let outward = (b - a).cross(Vec3::Y).dot((a + b) * 0.5) >= 0.0;
        if outward {
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        } else {
            indices.extend([base, base + 2, base + 1, base, base + 3, base + 2]);
        }
    }
    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
    mesh.insert_indices(Indices::U32(indices));
    mesh.duplicate_vertices();
    mesh.compute_flat_normals();
    mesh
}

fn top_mesh(top: &[Vec3; 4]) -> Mesh {
    let normal = (top[1] - top[0]).cross(top[2] - top[0]);
    let indices = if normal.y >= 0.0 {
        vec![0, 1, 2, 0, 2, 3]
    } else {
        vec![0, 2, 1, 0, 3, 2]
    };
    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, top.to_vec());
    mesh.insert_indices(Indices::U32(indices));
    mesh.duplicate_vertices();
    mesh.compute_flat_normals();
    mesh
}

fn text_material(theme: &ThemeResource) -> StandardMaterial {
    StandardMaterial {
        base_color: theme.token_color("interactionOnAccent"),
        perceptual_roughness: 0.55,
        // The glyph mesh has closed caps and outward side walls. Disabling culling costs almost
        // nothing for two fixed labels and keeps the lettering visible even if a wall triangle is
        // seen edge-on.
        cull_mode: None,
        ..default()
    }
}

fn ensure_shared(
    state: &mut Placeholders,
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    theme: &ThemeResource,
) {
    let theme_changed = state.theme.as_deref() != Some(theme.fingerprint());
    if state.shared.is_some() && !theme_changed {
        return;
    }
    let old = state.shared.take();
    if let Some(old) = &old {
        materials.remove(&old.side_material);
        materials.remove(&old.top_material);
        materials.remove(&old.text_material);
    }
    let text_meshes = old
        .as_ref()
        .map(|assets| assets.text_meshes.clone())
        .unwrap_or_else(|| {
            [
                text_mesh(WOOHAA3_JSON).map(|mesh| meshes.add(mesh)),
                text_mesh(PIANCHANG_JSON).map(|mesh| meshes.add(mesh)),
            ]
        });
    let side_material = materials.add(StandardMaterial {
        base_color: theme.token_color("interactionAccent"),
        perceptual_roughness: 0.72,
        ..default()
    });
    let top_material = materials.add(StandardMaterial {
        base_color: theme.token_color("interactionAccentSoft"),
        perceptual_roughness: 0.9,
        ..default()
    });
    let text_material = materials.add(text_material(theme));
    let shared = SharedAssets {
        text_meshes,
        side_material,
        top_material,
        text_material,
    };
    if old.is_some() {
        // Theme-only update: keep entities and per-node meshes, swap shared materials.
        for entry in state.entries.values() {
            commands
                .entity(entry.body)
                .insert(MeshMaterial3d(shared.side_material.clone()));
            commands
                .entity(entry.top)
                .insert(MeshMaterial3d(shared.top_material.clone()));
            for entity in entry.labels.into_iter().flatten() {
                commands
                    .entity(entity)
                    .insert(MeshMaterial3d(shared.text_material.clone()));
            }
        }
    }
    state.shared = Some(shared);
    state.theme = Some(theme.fingerprint().to_owned());
}

pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    rig: Res<FocusRig>,
    theme: Res<ThemeResource>,
    mut state: ResMut<Placeholders>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    if !scene.is_changed() && !rig.is_changed() && !theme.is_changed() {
        return;
    }
    let hidden = !is_overview(&scene.0, rig.focus_node.is_some());
    // Film-set groups have no assembled geometry while the scene has neither an active binding nor
    // an authored ground. The host already publishes that fact as the accepted film-set group
    // preparation, so this stays a presentation projection instead of guessing from business ids.
    let empty_film_sets: HashSet<&str> = scene
        .0
        .film_set_groups
        .iter()
        .filter(|group| group.bindings.is_empty() && group.ground.is_none())
        .map(|group| group.owner_id.as_str())
        .collect();
    let targets: Vec<(&crate::protocol::GraphNode, bool)> = if hidden {
        Vec::new()
    } else {
        scene
            .0
            .nodes
            .iter()
            .filter_map(|node| {
                // Empty film sets show the brand plinth in the same identity badge that later
                // carries the real scene composition. The badge wins over a generic composite
                // declaration because the group's model lives inside it, not in the scope.
                let empty_badge = node.group.is_some()
                    && group_model::has_badge(node)
                    && empty_film_sets.contains(node.id.as_str());
                if empty_badge {
                    return Some((node, true));
                }
                let declared = node
                    .composite_asset
                    .as_ref()
                    .is_some_and(|asset| asset.empty_placeholder.is_some());
                declared.then_some((node, false))
            })
            .collect()
    };
    let retained: HashSet<_> = targets.iter().map(|(node, _)| node.id.clone()).collect();
    state.entries.retain(|id, entry| {
        if retained.contains(id) {
            return true;
        }
        commands.entity(entry.body).despawn();
        meshes.remove(&entry.side_mesh);
        meshes.remove(&entry.top_mesh);
        false
    });
    if targets.is_empty() {
        return;
    }
    ensure_shared(
        &mut state,
        &mut commands,
        &mut meshes,
        &mut materials,
        &theme,
    );
    let shared = state.shared.as_ref().expect("shared assets").clone();
    for (node, badge) in targets {
        let layout = if badge {
            badge_plinth_layout(node)
        } else {
            plinth_layout(&scope::node_scope(node))
        };
        let unchanged = state
            .entries
            .get(&node.id)
            .is_some_and(|entry| entry.top_vertices == layout.top && entry.depth == layout.depth);
        if unchanged {
            let entry = state.entries.get(&node.id).expect("plinth");
            commands
                .entity(entry.body)
                .insert(Transform::from_translation(layout.center));
            continue;
        }
        if let Some(old) = state.entries.remove(&node.id) {
            commands.entity(old.body).despawn();
            meshes.remove(&old.side_mesh);
            meshes.remove(&old.top_mesh);
        }
        let side = meshes.add(side_mesh(&layout.top, layout.depth));
        let top = meshes.add(top_mesh(&layout.top));
        let body = commands
            .spawn((
                Name::new("empty-film-set-plinth"),
                Mesh3d(side.clone()),
                MeshMaterial3d(shared.side_material.clone()),
                Transform::from_translation(layout.center),
                RenderLayers::layer(FILM_SET_PLACEHOLDER_LAYER),
            ))
            .id();
        let top_entity = commands
            .spawn((
                Mesh3d(top.clone()),
                MeshMaterial3d(shared.top_material.clone()),
                Transform::IDENTITY,
                RenderLayers::layer(FILM_SET_PLACEHOLDER_LAYER),
                ChildOf(body),
            ))
            .id();
        let mut label_entities = [None, None];
        for (slot, label) in layout.labels.iter().enumerate().take(2) {
            let Some(mesh) = shared.text_meshes[slot].clone() else {
                continue;
            };
            let entity = commands
                .spawn((
                    Name::new(format!("empty-film-set-plinth-label-{}", label.text)),
                    Mesh3d(mesh),
                    MeshMaterial3d(shared.text_material.clone()),
                    label_transform(label),
                    RenderLayers::layer(FILM_SET_PLACEHOLDER_LAYER),
                    ChildOf(body),
                ))
                .id();
            label_entities[slot] = Some(entity);
        }
        state.entries.insert(
            node.id.clone(),
            Plinth {
                body,
                top: top_entity,
                labels: label_entities,
                side_mesh: side,
                top_mesh: top,
                top_vertices: layout.top,
                depth: layout.depth,
            },
        );
    }
}

#[cfg(test)]
mod tests;
