//! Continuous group surfaces behind 3D appearances, using the existing canvas camera.
//! No overlay cutout, extra camera, offscreen preview or capture-layer geometry.
//!
//! Only groups that carry a model keep this 3D surface: it draws the speech-bubble tail behind
//! the free-standing badge. Plain groups are filled by the per-group 2D panel in
//! [`super::group::draw_group_panel`]. The 3D surface MUST NOT contain a badge plate or a
//! translucent group fill: the 2D panel owns that 0.55 underlay for every group, while this
//! layer only provides the small pointed tail behind the model.
use std::collections::{HashMap, HashSet};

use super::geometry::Geometry;
use crate::{
    app::{CurrentScene, FrameFlags},
    canvas_query::group_model,
    theme::ThemeResource,
};
use bevy::{
    camera::visibility::{NoFrustumCulling, RenderLayers},
    prelude::*,
};

#[derive(Component)]
struct GroupSurface;

#[derive(PartialEq)]
struct Key {
    rect: [f32; 4],
    depth: f32,
    badge: bool,
    badge_scale: f32,
}
struct Surface {
    entity: Entity,
    mesh: Handle<Mesh>,
    key: Key,
}
#[derive(Default)]
pub(crate) struct Surfaces {
    entries: HashMap<String, Surface>,
    material: Option<Handle<StandardMaterial>>,
}

// Same projected world coordinates as the models, between the grid (-20000) and models (~0).
// Entity translation carries this depth so transparent sorting also places the surface behind models.
fn transform(node: &crate::protocol::GraphNode, depth: f32) -> Transform {
    Transform {
        translation: crate::isometric_grid::canvas_point_to_world(
            node.x + node.width / 2.,
            node.y + node.height / 2.,
            depth,
        ),
        rotation: crate::isometric_grid::canvas_camera_rotation(),
        ..default()
    }
}

fn mesh(node: &crate::protocol::GraphNode) -> Mesh {
    let origin = Vec2::new(node.x + node.width / 2., node.y + node.height / 2.);
    let mut geometry = Geometry::default();
    // The badge itself has no plate. The tail is a small opaque shape on the 3D camera so
    // the model stays in front of it while the 2D body panel remains behind the external badge.
    let tail = group_model::tail_path(node);
    if !tail.is_empty() {
        let relative: Vec<_> = tail.iter().map(|point| *point - origin).collect();
        geometry.polygon_alpha(&relative, 0., 0xffffff, 1.);
    }
    geometry.build()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut state: Local<Surfaces>,
) {
    if !flags.changed {
        return;
    }
    let nodes: Vec<_> = scene
        .0
        .nodes
        .iter()
        .filter(|node| group_model::has_badge(node) && scene.0.model_focus.is_none())
        .collect();
    let ids: HashSet<_> = nodes.iter().map(|node| node.id.as_str()).collect();
    state.entries.retain(|id, surface| {
        if ids.contains(id.as_str()) {
            return true;
        }
        commands.entity(surface.entity).despawn();
        meshes.remove(surface.mesh.id());
        false
    });
    if nodes.is_empty() {
        if let Some(material) = state.material.take() {
            materials.remove(material.id());
        }
        return;
    }
    let color = theme.token_color("canvasNodeSurface");
    let material = state
        .material
        .get_or_insert_with(|| {
            materials.add(StandardMaterial {
                base_color: color,
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            })
        })
        .clone();
    if let Some(mut value) = materials.get_mut(&material) {
        value.base_color = color;
    }
    for node in nodes {
        // 气泡尾巴只退到自己组深度平面之后一个极小 ε：本组模型在它前面，与相邻根的遮挡
        // 交给逐像素深度（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D4/D5）。
        let depth = crate::depth_order::group_badge_depth(&node.id);
        let key = Key {
            rect: [node.x, node.y, node.width, node.height],
            depth,
            badge: group_model::has_badge(node),
            badge_scale: group_model::badge_scale(node),
        };
        if state
            .entries
            .get(&node.id)
            .is_some_and(|surface| surface.key == key)
        {
            continue;
        }
        let transform = transform(node, depth);
        if let Some(surface) = state.entries.get_mut(&node.id) {
            if surface.key.rect[2..] != key.rect[2..]
                || surface.key.badge != key.badge
                || surface.key.badge_scale != key.badge_scale
            {
                let handle = meshes.add(mesh(node));
                meshes.remove(surface.mesh.id());
                commands
                    .entity(surface.entity)
                    .insert(Mesh3d(handle.clone()));
                surface.mesh = handle;
            }
            commands.entity(surface.entity).insert(transform);
            surface.key = key;
        } else {
            let handle = meshes.add(mesh(node));
            let entity = commands
                .spawn((
                    GroupSurface,
                    Mesh3d(handle.clone()),
                    MeshMaterial3d(material.clone()),
                    transform,
                    RenderLayers::layer(0),
                    NoFrustumCulling,
                ))
                .id();
            state.entries.insert(
                node.id.clone(),
                Surface {
                    entity,
                    mesh: handle,
                    key,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests;
