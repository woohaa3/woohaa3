//! Retained edge/label blocks. Warm changes compare borrowed endpoints and draw inputs.
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 端点读取 ECS `CanvasLayout`，
//! 连线标签通过 `LabelRequests`（owner = 边批次实体）同步，块内不再保存标签实体。
use super::{CanvasMaterials, geometry::Geometry, labels::Label, labels::LabelRequests, labels::LabelStyle};
use crate::canvas_ecs::components::{CanvasLabelRole, CanvasLayout, EdgeVisual};
use crate::{
    protocol::{Edge, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
use std::collections::HashMap;
const BLOCK_SIZE: usize = 16;
type Bounds = Option<([f32; 2], [f32; 2])>;
fn bounds(edge: &Edge, layouts: &HashMap<&str, CanvasLayout>) -> Bounds {
    Some((
        layouts.get(edge.source.as_str())?.port(true).to_array(),
        layouts.get(edge.target.as_str())?.port(false).to_array(),
    ))
}
fn hovered(scene: &Scene, edge: &Edge) -> bool {
    scene
        .hover
        .as_ref()
        .is_some_and(|h| h.edge_id.as_deref() == Some(edge.id.as_str()))
}
type Key = EdgeVisual;
impl Key {
    fn new(edge: &Edge, scene: &Scene, layouts: &HashMap<&str, CanvasLayout>, overlay_z: f32) -> Self {
        Self {
            id: edge.id.clone(),
            source: edge.source.clone(),
            target: edge.target.clone(),
            label: edge.label.clone(),
            bounds: bounds(edge, layouts),
            selected: scene.selection.edge.as_ref() == Some(&edge.id),
            hovered: hovered(scene, edge),
            overlay_z: hovered(scene, edge).then_some(overlay_z),
        }
    }
    fn matches(
        &self,
        edge: &Edge,
        scene: &Scene,
        layouts: &HashMap<&str, CanvasLayout>,
        overlay_z: f32,
    ) -> bool {
        self == &Self::new(edge, scene, layouts, overlay_z)
    }
}
#[derive(Default)]
pub(super) struct Block {
    keys: Vec<Key>,
    theme: String,
    depth_offset: f32,
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    labels: Vec<Label>,
}

#[derive(Resource, Default)]
pub(crate) struct EdgeBlockCache {
    pub(super) blocks: Vec<Block>,
}
impl Block {
    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        if let Some(entity) = self.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = self.mesh.take() {
            meshes.remove(mesh.id());
        }
        self.labels.clear();
        self.keys.clear();
        self.theme.clear();
    }
    #[cfg(test)]
    pub(super) fn state(&self) -> (bevy::asset::AssetId<Mesh>, usize) {
        (self.mesh.as_ref().unwrap().id(), self.labels.len())
    }
}
#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut EdgeBlockCache,
    requests: &mut LabelRequests,
    scene: &Scene,
    theme: &ThemeResource,
    layouts: &HashMap<&str, CanvasLayout>,
    overlay_z: f32,
    materials: &CanvasMaterials,
) -> u64 {
    requests.begin(CanvasLabelRole::Edge);
    let mut rebuilt = 0;
    let mut blocks = std::mem::take(&mut visuals.blocks);
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
                .all(|(key, edge)| key.matches(edge, scene, layouts, overlay_z))
        {
            // 缓存命中：块实体已在，标签请求沿用上一帧文案（不重建、不闪失）。
            if let Some(entity) = block.entity {
                requests.push(
                    CanvasLabelRole::Edge,
                    entity,
                    block.labels.clone(),
                    2.1 + depth_offset,
                    LabelStyle::Edge,
                );
            }
            continue;
        }
        let entity = match block.entity {
            Some(entity) => entity,
            None => {
                let entity = commands
                    .spawn((
                        Transform::IDENTITY,
                        Name::new(format!("canvas-edge-block:{index}")),
                    ))
                    .id();
                block.entity = Some(entity);
                entity
            }
        };
        let mut geometry = Geometry::default();
        block.labels = super::render_edges::draw_block(
            edges,
            layouts,
            scene,
            theme,
            &mut geometry,
            overlay_z,
            depth_offset,
        );
        requests.push(
            CanvasLabelRole::Edge,
            entity,
            block.labels.clone(),
            2.1 + depth_offset,
            LabelStyle::Edge,
        );
        let handle = meshes.add(geometry.build());
        rebuilt += 1;
        if let Some(old) = block.mesh.replace(handle.clone()) {
            meshes.remove(old.id());
        }
        commands.entity(entity).insert((
            Mesh2d(handle),
            MeshMaterial2d(materials.solid.clone()),
            NoFrustumCulling,
        ));
        block.keys = edges
            .iter()
            .map(|edge| Key::new(edge, scene, layouts, overlay_z))
            .collect();
        block.theme = theme.fingerprint().to_owned();
        block.depth_offset = depth_offset;
    }
    visuals.blocks = blocks;
    rebuilt
}
#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
