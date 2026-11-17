//! Retained edge/label blocks. Warm changes compare borrowed endpoints and draw inputs.
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 端点读取 ECS `CanvasLayout`，
//! 连线标签通过 `LabelRequests`（owner = 边批次实体）同步，块内不再保存标签实体。
use super::{
    geometry::Geometry,
    labels::{Label, LabelOwner, LabelRequests, LabelStyle, LabelWriter},
    CanvasMaterials,
};
use crate::canvas_ecs::components::{CanvasLabelRole, CanvasLayout, EdgeVisual};
use crate::canvas_runtime::{Aabb, Workset, WorksetIndex};
use crate::{
    protocol::{Edge, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
use std::collections::HashMap;
use std::collections::BTreeSet;
pub(super) const BLOCK_SIZE: usize = 16;
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
    fn new(
        edge: &Edge,
        scene: &Scene,
        layouts: &HashMap<&str, CanvasLayout>,
        overlay_z: f32,
        index: &crate::app::NodeIndex,
    ) -> Self {
        Self {
            id: edge.id.clone(),
            source: edge.source.clone(),
            target: edge.target.clone(),
            label: edge.label.clone(),
            bounds: bounds(edge, layouts),
            selected: scene.selection.edge.as_ref() == Some(&edge.id),
            locked: index.is_locked(&edge.source) || index.is_locked(&edge.target),
            hovered: hovered(scene, edge),
            hover_cursor: scene
                .hover
                .as_ref()
                .filter(|_| hovered(scene, edge))
                .and_then(|h| h.cursor)
                .map(|p| [p.x, p.y]),
            overlay_z: hovered(scene, edge).then_some(overlay_z),
        }
    }
    fn matches(
        &self,
        edge: &Edge,
        scene: &Scene,
        layouts: &HashMap<&str, CanvasLayout>,
        overlay_z: f32,
        index: &crate::app::NodeIndex,
    ) -> bool {
        self == &Self::new(edge, scene, layouts, overlay_z, index)
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
    /// 换画布后几何键可能仍命中。置位后下一帧重提已保留的 `block.labels`，不重建 mesh。
    labels_stale: bool,
    workset_index: WorksetIndex,
    workset: Workset,
    new_block_visibility: BTreeSet<u32>,
}

impl EdgeBlockCache {
    pub(crate) fn can_update_blocks(&self, edge_count: usize) -> bool {
        !self.labels_stale && self.blocks.len() == edge_count.div_ceil(BLOCK_SIZE)
    }

    pub(crate) fn invalidate_labels(&mut self) {
        self.labels_stale = true;
    }

    pub(crate) fn sync_workset(&mut self, commands: &mut Commands, viewport: &crate::protocol::Viewport, surface: Vec2) {
        let zoom = viewport.zoom.max(0.01);
        let visible = Aabb::from_viewport(viewport, surface.to_array());
        let next = if cfg!(feature = "canvas-reference") {
            (0..self.blocks.len() as u32).collect()
        } else {
            self.workset_index.query_with_hysteresis(visible, 64.0 / zoom, 80.0 / zoom, self.workset.active())
        };
        let delta = self.workset.update(next);
        let mut changed = std::mem::take(&mut self.new_block_visibility);
        changed.extend(delta.entered);
        changed.extend(delta.left);
        for index in changed {
            if let Some(entity) = self.blocks.get(index as usize).and_then(|block| block.entity) {
                let visibility = if self.workset.active().contains(&index) { Visibility::Visible } else { Visibility::Hidden };
                commands.entity(entity).insert(visibility);
            }
        }
    }
}

/// Bézier curves lie inside their control-point hull. The extra extent also
/// covers edge labels, line width, and the hover/delete control.
fn block_bounds(block: &Block) -> Option<Aabb> {
    let mut min = Vec2::splat(f32::INFINITY);
    let mut max = Vec2::splat(f32::NEG_INFINITY);
    let mut any = false;
    for key in &block.keys {
        let Some((a, b)) = key.bounds else { continue };
        let (a, b) = (Vec2::from_array(a), Vec2::from_array(b));
        let (c1, c2) = crate::canvas_query::curve::edge_control_points(a, b);
        let margin = super::layout::edge_label_width(&key.label) / 2.0 + 64.0;
        for point in [a, b, c1, c2] {
            min = min.min(point - Vec2::splat(margin));
            max = max.max(point + Vec2::splat(margin));
        }
        any = true;
    }
    any.then_some(Aabb { min: min.to_array(), max: max.to_array() })
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
    #[cfg(test)]
    pub(super) fn entity(&self) -> Entity {
        self.entity.unwrap()
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
    dirty_blocks: Option<&BTreeSet<u32>>,
    node_index: &crate::app::NodeIndex,
) -> u64 {
    let mut rebuilt = 0;
    let mut blocks = std::mem::take(&mut visuals.blocks);
    let count = scene.edges.len().div_ceil(BLOCK_SIZE);
    let dirty_blocks = dirty_blocks.filter(|_| blocks.len() == count && !visuals.labels_stale);
    for (index, block) in blocks.iter_mut().enumerate().skip(count) {
        release_edge_block(requests, index);
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let indices: Box<dyn Iterator<Item = usize> + '_> = match dirty_blocks {
        Some(dirty) => Box::new(dirty.iter().map(|&index| index as usize).filter(|&index| index < count)),
        None => Box::new(0..count),
    };
    for index in indices {
        let start = index * BLOCK_SIZE;
        let edges = &scene.edges[start..(start + BLOCK_SIZE).min(scene.edges.len())];
        let block = &mut blocks[index];
        // Distinct block depths reproduce later-edge wins at crossings independently
        // of GPU batch order. Keep curves below GROUP_Z=1 and all label backgrounds
        // below draft z=2; all label text stays above all label backgrounds.
        let depth_offset = -0.05 * (count - index) as f32 / (count + 1) as f32;
        if !cfg!(feature = "canvas-reference") && block.theme == theme.fingerprint()
            && block.depth_offset == depth_offset
            && block.keys.len() == edges.len()
            && block
                .keys
                .iter()
                .zip(edges)
                .all(|(key, edge)| key.matches(edge, scene, layouts, overlay_z, node_index))
        {
            if let Some(entity) = block.entity {
                requests.bind(edge_owner(index), entity);
                if visuals.labels_stale {
                    submit_edge_labels(
                        requests,
                        edge_owner(index),
                        &block.labels,
                        2.1 + depth_offset,
                    );
                }
            }
            continue;
        }
        let entity = match block.entity {
            Some(entity) => entity,
            None => {
                visuals.new_block_visibility.insert(index as u32);
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
        let labels = super::render_edges::draw_block(
            edges,
            layouts,
            scene,
            theme,
            &mut geometry,
            overlay_z,
            depth_offset,
            node_index,
        );
        let owner = edge_owner(index);
        requests.bind(owner.clone(), entity);
        submit_edge_labels(requests, owner, &labels, 2.1 + depth_offset);
        block.labels = labels;
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
            .map(|edge| Key::new(edge, scene, layouts, overlay_z, node_index))
            .collect();
        block.theme = theme.fingerprint().to_owned();
        block.depth_offset = depth_offset;
    }
    visuals.blocks = blocks;
    visuals.labels_stale = false;
    if let Some(dirty) = dirty_blocks {
        for &index in dirty {
            visuals.workset_index.remove(index);
            if let Some(bounds) = visuals.blocks.get(index as usize).and_then(block_bounds) {
                visuals.workset_index.insert(index, bounds);
            }
        }
    } else {
        visuals.workset_index.clear();
        for (index, block) in visuals.blocks.iter().enumerate() {
            if let Some(bounds) = block_bounds(block) {
                visuals.workset_index.insert(index as u32, bounds);
            }
        }
    }
    rebuilt
}

/// 测试只打保留向量克隆计数，不重建边几何。
#[cfg(test)]
pub(crate) fn submit_edge_labels_for_test(
    requests: &mut LabelRequests,
    owner: LabelOwner,
    labels: &[Label],
    z: f32,
) {
    submit_edge_labels(requests, owner, labels, z);
}

fn submit_edge_labels(requests: &mut LabelRequests, owner: LabelOwner, labels: &[Label], z: f32) {
    requests.note_request_clones(labels.len() as u64);
    let mut txn = requests.transaction(LabelWriter::Edge);
    txn.replace_owner(
        CanvasLabelRole::Edge,
        owner,
        labels.to_vec(),
        z,
        LabelStyle::Edge,
    );
    let _ = txn.commit();
}

fn edge_owner(index: usize) -> LabelOwner {
    LabelOwner::Block((index * BLOCK_SIZE) as u32)
}

fn release_edge_block(requests: &mut LabelRequests, index: usize) {
    let mut txn = requests.transaction(LabelWriter::Edge);
    txn.replace_owner(
        CanvasLabelRole::Edge,
        edge_owner(index),
        Vec::new(),
        0.0,
        LabelStyle::Edge,
    );
    let _ = txn.commit();
}

#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}
