//! Retained edge/label blocks. Warm changes compare borrowed endpoints and draw inputs.
use super::{Visuals, geometry::Geometry, layout::port};
use crate::{
    protocol::{Edge, GraphNode, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
use std::collections::HashMap;
const BLOCK_SIZE: usize = 16;
type Bounds = Option<([f32; 2], [f32; 2])>;
fn bounds(edge: &Edge, nodes: &HashMap<&str, &GraphNode>) -> Bounds {
    Some((
        port(nodes.get(edge.source.as_str())?, true).to_array(),
        port(nodes.get(edge.target.as_str())?, false).to_array(),
    ))
}
fn hovered(scene: &Scene, edge: &Edge) -> bool {
    scene
        .hover
        .as_ref()
        .is_some_and(|h| h.edge_id.as_deref() == Some(edge.id.as_str()))
}
struct Key {
    id: String,
    source: String,
    target: String,
    label: String,
    bounds: Bounds,
    selected: bool,
    hover: bool,
    overlay_z: Option<f32>,
}
impl Key {
    fn new(edge: &Edge, scene: &Scene, nodes: &HashMap<&str, &GraphNode>, overlay_z: f32) -> Self {
        Self {
            id: edge.id.clone(),
            source: edge.source.clone(),
            target: edge.target.clone(),
            label: edge.label.clone(),
            bounds: bounds(edge, nodes),
            selected: scene.selection.edge.as_ref() == Some(&edge.id),
            hover: hovered(scene, edge),
            overlay_z: hovered(scene, edge).then_some(overlay_z),
        }
    }
    fn matches(
        &self,
        edge: &Edge,
        scene: &Scene,
        nodes: &HashMap<&str, &GraphNode>,
        overlay_z: f32,
    ) -> bool {
        self.id == edge.id
            && self.source == edge.source
            && self.target == edge.target
            && self.label == edge.label
            && self.bounds == bounds(edge, nodes)
            && self.selected == (scene.selection.edge.as_ref() == Some(&edge.id))
            && self.hover == hovered(scene, edge)
            && self.overlay_z == hovered(scene, edge).then_some(overlay_z)
    }
}
#[derive(Default)]
pub(super) struct Block {
    keys: Vec<Key>,
    theme: String,
    depth_offset: f32,
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    labels: Vec<Entity>,
}
impl Block {
    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        if let Some(entity) = self.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = self.mesh.take() {
            meshes.remove(mesh.id());
        }
        for entity in self.labels.drain(..) {
            commands.entity(entity).despawn();
        }
        self.keys.clear();
        self.theme.clear();
    }
    #[cfg(test)]
    pub(super) fn state(&self) -> (bevy::asset::AssetId<Mesh>, Vec<Entity>) {
        (self.mesh.as_ref().unwrap().id(), self.labels.clone())
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut Visuals,
    scene: &Scene,
    theme: &ThemeResource,
    nodes: &HashMap<&str, &GraphNode>,
    overlay_z: f32,
) -> u64 {
    let mut rebuilt = 0;
    let mut blocks = std::mem::take(&mut visuals.edge_blocks);
    let count = scene.edges.len().div_ceil(BLOCK_SIZE);
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    for (index, edges) in scene.edges.chunks(BLOCK_SIZE).enumerate() {
        let block = &mut blocks[index];
        // Distinct block depths reproduce later-edge wins at crossings independently
        // of GPU batch order. Keep curves below GROUP_Z=1 and all label backgrounds
        // below draft z=2; all label text stays above all label backgrounds.
        let depth_offset = -0.05 * (count - index) as f32 / (count + 1) as f32;
        if block.theme == theme.fingerprint()
            && block.depth_offset == depth_offset
            && block.keys.len() == edges.len()
            && block
                .keys
                .iter()
                .zip(edges)
                .all(|(key, edge)| key.matches(edge, scene, nodes, overlay_z))
        {
            continue;
        }
        for entity in block.labels.drain(..) {
            commands.entity(entity).despawn();
        }
        let mut geometry = Geometry::default();
        block.labels = super::render_edges::draw_block(
            commands,
            edges,
            nodes,
            scene,
            theme,
            &visuals.font,
            &mut geometry,
            overlay_z,
            depth_offset,
        );
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
        block.keys = edges
            .iter()
            .map(|edge| Key::new(edge, scene, nodes, overlay_z))
            .collect();
        block.theme = theme.fingerprint().to_owned();
        block.depth_offset = depth_offset;
    }
    visuals.edge_blocks = blocks;
    rebuilt
}
#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
