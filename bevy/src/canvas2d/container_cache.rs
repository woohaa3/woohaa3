//! Local group/film-scope buffers; transparent fills retain document ordering below overlays.
use super::{Visuals, geometry::Geometry, labels::sync_labels};
use crate::{
    protocol::{GraphNode, GroupPresentation, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, mesh::VertexAttributeValues, prelude::*};
const BLOCK_SIZE: usize = 16;
#[derive(PartialEq)]
struct Key {
    id: String,
    index: usize,
    rect: [f32; 4],
    scope: Option<(f32, f32, f32, f32)>,
    title: String,
    group: Option<GroupPresentation>,
    selected: bool,
    hovered: bool,
    /// 聚合节点运行遮罩（change: 2026-10-12-unify-generation-history-strip，design D5）：
    /// 仅聚合节点（复合资产）出现，运行中时绘制半透明遮罩 + 「运行中」。
    aggregate_run: bool,
}
impl Key {
    fn new(n: &GraphNode, index: usize, scene: &Scene) -> Self {
        Self {
            id: n.id.clone(),
            index,
            rect: [n.x, n.y, n.width, n.height],
            scope: n
                .composite_asset
                .as_ref()
                .map(|asset| (asset.x, asset.y, asset.width, asset.height)),
            title: n.title.clone(),
            group: n.group.clone(),
            selected: scene.selection.nodes.contains(&n.id),
            hovered: n.composite_asset.is_some()
                && scene.hover.as_ref().and_then(|h| h.node_id.as_deref()) == Some(n.id.as_str()),
            aggregate_run: n.aggregate_run.as_ref().is_some_and(|run| run.active),
        }
    }
}
#[derive(Default)]
pub(super) struct Block {
    keys: Vec<Key>,
    theme: String,
    band: Option<[f32; 4]>,
    sort_z: f32,
    entities: [Option<Entity>; 2],
    meshes: [Option<Handle<Mesh>>; 2],
}
impl Block {
    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        for entity in &mut self.entities {
            if let Some(entity) = entity.take() {
                commands.entity(entity).despawn();
            }
        }
        for handle in &mut self.meshes {
            if let Some(handle) = handle.take() {
                meshes.remove(handle.id());
            }
        }
        self.keys.clear();
        self.theme.clear();
        self.band = None;
    }
    #[cfg(test)]
    pub(super) fn blend_entity(&self) -> Option<Entity> {
        self.entities[1]
    }
    #[cfg(test)]
    pub(super) fn state(&self) -> [Option<bevy::asset::AssetId<Mesh>>; 2] {
        self.meshes
            .each_ref()
            .map(|handle| handle.as_ref().map(Handle::id))
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut Visuals,
    text: &mut Query<(&mut Text2d, &mut Transform, &mut TextColor), Without<Sprite>>,
    scene: &Scene,
    theme: &ThemeResource,
) -> u64 {
    let band = scene.aggregate_connect.as_ref().and_then(|_| {
        crate::canvas_query::aggregate::selection_bounds(&scene.nodes, &scene.selection.nodes)
    });
    let mut blocks = std::mem::take(&mut visuals.container_blocks);
    let count = scene.nodes.len().div_ceil(BLOCK_SIZE);
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let mut rebuilt = 0;
    for (block_index, nodes) in scene.nodes.chunks(BLOCK_SIZE).enumerate() {
        let block = &mut blocks[block_index];
        let keys: Vec<_> = nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.group.is_some() || n.composite_asset.is_some())
            .map(|(local, n)| Key::new(n, block_index * BLOCK_SIZE + local, scene))
            .collect();
        let band = if block_index == 0 { band } else { None };
        // Bevy Transparent2d sorts by the entity transform, independently of mesh vertex z.
        // Negative sort depths place all group fills below the transient overlay owner (z=0).
        let sort_z = -0.001 * (count - block_index) as f32 / (count + 1) as f32;
        if block.keys == keys
            && block.band == band
            && block.theme == theme.fingerprint()
            && block.sort_z == sort_z
        {
            continue;
        }
        if keys.is_empty() && band.is_none() {
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            block.sort_z = sort_z;
            continue;
        }
        let mut geometry = Geometry::default();
        if band.is_some() {
            super::aggregate::draw_aggregate_selection_band(
                &mut geometry,
                theme,
                &scene.nodes,
                &scene.selection.nodes,
                super::group::GROUP_Z,
            );
        }
        for key in &keys {
            let node = &scene.nodes[key.index];
            let z = 10.0 + key.index as f32 * 0.1;
            let mut labels = if let Some(group) = &node.group {
                vec![super::group::draw_group(
                    &mut geometry,
                    theme,
                    node,
                    group,
                    key.selected,
                )]
            } else {
                super::film_set::draw_film_set_scope(
                    &mut geometry,
                    theme,
                    node,
                    key.selected,
                    key.hovered,
                    z,
                )
                .unwrap_or_default()
            };
            if let Some(label) = super::group::draw_run_status(&mut geometry, theme, node) {
                labels.push(label);
            }
            // 聚合节点运行遮罩：覆盖整个范围（change: 2026-10-12-unify-generation-history-strip，
            // design D5）。半透明遮罩写入 blend 层，被上层不透明卡片正确遮挡。
            if key.aggregate_run {
                let scope = super::scope::node_scope(node);
                let bounds = (scope.aabb.x, scope.aabb.y, scope.aabb.width, scope.aabb.height);
                let label =
                    super::history_strip::draw_aggregate_run_overlay(&mut geometry, theme, bounds, z + 0.02);
                labels.push((
                    label,
                    Vec2::new(bounds.0 + bounds.2 / 2.0, bounds.1 + bounds.3 / 2.0),
                    14.,
                    theme.token_u32("interactionAccent"),
                ));
            }
            sync_labels(commands, visuals, text, &node.id, labels, z + 0.02);
        }
        let (mut opaque, mut blend) = geometry.into_layers();
        let opaque_depth = 0.0002 * block_index as f32 / (count + 1) as f32;
        shift_depth(&mut opaque, opaque_depth);
        // Compensate the phase-sort transform so transparent world-space depth stays canonical.
        shift_depth(&mut blend, -sort_z);
        for (layer, built) in [opaque, blend].into_iter().enumerate() {
            let handle = meshes.add(built);
            if let Some(old) = block.meshes[layer].replace(handle.clone()) {
                meshes.remove(old.id());
            }
            let transform = Transform::from_xyz(0., 0., if layer == 1 { sort_z } else { 0. });
            if let Some(entity) = block.entities[layer] {
                commands.entity(entity).insert((Mesh2d(handle), transform));
            } else {
                let material = if layer == 1 {
                    visuals.blend_material.clone()
                } else {
                    visuals.material.clone()
                };
                block.entities[layer] = Some(
                    commands
                        .spawn((
                            Mesh2d(handle),
                            MeshMaterial2d(material),
                            transform,
                            NoFrustumCulling,
                        ))
                        .id(),
                );
            }
        }
        block.keys = keys;
        block.band = band;
        block.theme = theme.fingerprint().to_owned();
        block.sort_z = sort_z;
        rebuilt += 1;
    }
    visuals.container_blocks = blocks;
    rebuilt
}
fn shift_depth(mesh: &mut Mesh, delta: f32) {
    if let Some(VertexAttributeValues::Float32x3(positions)) =
        mesh.attribute_mut(Mesh::ATTRIBUTE_POSITION)
    {
        for p in positions {
            p[2] += delta;
        }
    }
}
#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
