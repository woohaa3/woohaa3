//! Sparse per-block card selection/hover/resize buffers, independent of static labels/content.
use super::{Visuals, geometry::Geometry};
use crate::{protocol::Scene, theme::ThemeResource};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
const BLOCK_SIZE: usize = 16;
#[derive(PartialEq)]
struct Key {
    id: String,
    kind: String,
    index: usize,
    rect: [f32; 4],
    selected: bool,
    resizable: bool,
    hover: Option<Option<String>>,
}
#[derive(Default)]
pub(super) struct Block {
    keys: Vec<Key>,
    theme: String,
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
}
impl Block {
    #[cfg(test)]
    pub(super) fn handle(&self) -> Option<bevy::asset::AssetId<Mesh>> {
        self.mesh.as_ref().map(Handle::id)
    }

    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        if let Some(entity) = self.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = self.mesh.take() {
            meshes.remove(mesh.id());
        }
        self.keys.clear();
        self.theme.clear();
    }
}
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut Visuals,
    scene: &Scene,
    theme: &ThemeResource,
) -> u64 {
    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    let mut rebuilt = 0;
    let selected: std::collections::HashSet<_> =
        scene.selection.nodes.iter().map(String::as_str).collect();
    let mut blocks = std::mem::take(&mut visuals.card_decorations);
    let count = scene.nodes.len().div_ceil(BLOCK_SIZE);
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    for (block_index, nodes) in scene.nodes.chunks(BLOCK_SIZE).enumerate() {
        let block = &mut blocks[block_index];
        let keys: Vec<_> = nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| {
                n.group.is_none()
                    && n.composite_asset.is_none()
                    && focused_id != Some(n.id.as_str())
            })
            .filter_map(|(local, node)| {
                let selected = selected.contains(node.id.as_str());
                let hover = scene
                    .hover
                    .as_ref()
                    .filter(|h| h.node_id.as_deref() == Some(node.id.as_str()));
                if !selected && !node.resizable && hover.is_none() {
                    return None;
                }
                Some(Key {
                    id: node.id.clone(),
                    kind: node.kind.clone(),
                    index: block_index * BLOCK_SIZE + local,
                    rect: [node.x, node.y, node.width, node.height],
                    selected,
                    resizable: node.resizable,
                    hover: hover.map(|h| h.port.clone()),
                })
            })
            .collect();
        if block.keys == keys && block.theme == theme.fingerprint() {
            continue;
        }
        if keys.is_empty() {
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            continue;
        }
        let mut geometry = Geometry::default();
        for key in &keys {
            let node = &scene.nodes[key.index];
            super::cards::draw_decorations(
                &mut geometry,
                theme,
                node,
                key.selected,
                scene.hover.as_ref(),
                super::draw_order::render_index(&scene.nodes, key.index),
            );
        }
        let handle = meshes.add(geometry.build());
        rebuilt += 1;
        if let Some(old) = block.mesh.replace(handle.clone()) {
            meshes.remove(old.id());
        }
        if let Some(entity) = block.entity {
            commands.entity(entity).insert(Mesh2d(handle));
        } else {
            block.entity = Some(
                commands
                    .spawn((
                        Mesh2d(handle),
                        MeshMaterial2d(visuals.material.clone()),
                        NoFrustumCulling,
                    ))
                    .id(),
            );
        }
        block.keys = keys;
        block.theme = theme.fingerprint().to_owned();
    }
    visuals.card_decorations = blocks;
    rebuilt
}
#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
