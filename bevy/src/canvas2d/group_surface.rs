//! Continuous group surfaces behind 3D appearances, using the existing canvas camera.
//! No overlay cutout, extra camera, offscreen preview or capture-layer geometry.
//!
//! Only groups that carry a model keep this 3D surface: it draws the speech-bubble tail behind
//! the free-standing badge. Plain groups are filled by the per-group 2D panel in
//! [`super::group::draw_group_panel`]. The 3D surface MUST NOT contain a badge plate or a
//! translucent group fill: the 2D panel owns that 0.55 underlay for every group, while this
//! layer only provides the small pointed tail behind the model.
use std::collections::HashSet;

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

/// 尾巴几何 key：矩形、深度与徽标状态变化才重建 mesh。
#[derive(PartialEq)]
struct Key {
    rect: [f32; 4],
    depth: f32,
    badge: bool,
    badge_scale: f32,
}

/// group 3D 气泡尾巴实体：owner 节点 + 几何 key + 独占 mesh。
///
/// change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 实体身份与 mesh 归属改由组件
/// 表达；`Surfaces` 只保留共享材质句柄。
#[derive(Component)]
pub(crate) struct GroupSurface {
    owner: Entity,
    key: Key,
    mesh: Handle<Mesh>,
}

/// 共享 StandardMaterial（资源归属，不是 owner 事实）。
#[derive(Default)]
pub(crate) struct Surfaces {
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
    index: Res<crate::app::NodeIndex>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut state: Local<Surfaces>,
    nodes: Query<(Entity, &crate::canvas_ecs::components::CanvasNodeId, &crate::canvas_ecs::components::GroupPresentation)>,
    mut surfaces: Query<(Entity, &mut GroupSurface)>,
) {
    if !(flags.scene_received || flags.positions_received || flags.surface_changed || flags.theme_changed || flags.camera_changed) && !scene.is_changed() && !theme.is_changed() {
        return;
    }
    let focus = scene.0.model_focus.is_some();
    let mut live = HashSet::new();
    let mut targets: Vec<(Entity, crate::protocol::GraphNode)> = Vec::new();
    for (entity, id, presentation) in &nodes {
        if !presentation.badge || focus {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        live.insert(entity);
        targets.push((entity, node.into_owned()));
    }
    // 节点删除、展示类型替换或聚焦隔离后，尾巴实体与独占 mesh 一并回收。
    for (surface_entity, surface) in &mut surfaces {
        if !live.contains(&surface.owner) {
            meshes.remove(surface.mesh.id());
            commands.entity(surface_entity).despawn();
        }
    }
    if targets.is_empty() {
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
    for (owner, node) in targets {
        // 气泡尾巴只退到自己组深度平面之后一个极小 ε：本组模型在它前面，与相邻根的遮挡
        // 交给逐像素深度（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D4/D5）。
        let depth = crate::depth_order::group_badge_depth(&node.id);
        let key = Key {
            rect: [node.x, node.y, node.width, node.height],
            depth,
            badge: group_model::has_badge(&node),
            badge_scale: group_model::badge_scale(&node),
        };
        let existing = surfaces.iter_mut().find(|(_, surface)| surface.owner == owner);
        match existing {
            Some((entity, mut surface)) => {
                if surface.key == key {
                    continue;
                }
                if surface.key.rect[2..] != key.rect[2..]
                    || surface.key.badge != key.badge
                    || surface.key.badge_scale != key.badge_scale
                {
                    let handle = meshes.add(mesh(&node));
                    meshes.remove(surface.mesh.id());
                    commands.entity(entity).insert(Mesh3d(handle.clone()));
                    surface.mesh = handle;
                }
                commands.entity(entity).insert(transform(&node, depth));
                surface.key = key;
            }
            None => {
                let handle = meshes.add(mesh(&node));
                commands.spawn((
                    GroupSurface {
                        owner,
                        key,
                        mesh: handle.clone(),
                    },
                    Mesh3d(handle),
                    MeshMaterial3d(material.clone()),
                    transform(&node, depth),
                    RenderLayers::layer(0),
                    NoFrustumCulling,
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests;
