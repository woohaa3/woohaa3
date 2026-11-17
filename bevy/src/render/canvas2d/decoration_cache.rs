//! Sparse per-block card hover-port buffers, independent of static labels/content and of
//! persistent selection outlines (owned by the Card selection producer).
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 输入改为 ECS 节点 Query；
//! 选中态不再参与块 key，也不再重建本缓存。
use super::{CanvasMaterials, geometry::Geometry};
use crate::{protocol::Scene, theme::ThemeResource};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};
pub(super) const BLOCK_SIZE: usize = 16;
#[derive(PartialEq)]
/// 单一悬停装饰输入；由当前 presentation DTO 派生，块比较只看这一份值。
struct DecorationInput {
    id: String,
    kind: String,
    index: usize,
    rect: [f32; 4],
    hover: Option<Option<String>>,
    cursor: Option<[f32; 2]>,
}
#[derive(Default)]
pub(super) struct Block {
    keys: Vec<DecorationInput>,
    theme: String,
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
}

#[derive(Resource, Default)]
pub(crate) struct CardDecorationCache {
    pub(super) blocks: Vec<Block>,
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

/// 一个需要端点半钮的卡片投影输入。
///
/// `index` 是文档槽，决定所在块；`render` 是绘制 rank，只参与几何 z。块内其余卡片不会改变
/// 这一项的绘制结果，因此位置帧可以只投影脏块对应的节点。
pub(super) struct HoverInput {
    pub(crate) index: usize,
    pub(crate) render: usize,
    pub(crate) node: std::borrow::Cow<'static, crate::protocol::GraphNode>,
}

pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut CardDecorationCache,
    scene: &Scene,
    theme: &ThemeResource,
    projected: &[HoverInput],
    materials: &CanvasMaterials,
    document_len: usize,
    dirty: Option<&std::collections::BTreeSet<u32>>,
) -> u64 {
    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    let mut rebuilt = 0;
    let mut blocks = std::mem::take(&mut visuals.blocks);
    let count = document_len.div_ceil(BLOCK_SIZE);
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    for block_index in 0..count {
        // 局部帧只比较被变更集合点名的块；其余块保留上一份几何。
        if dirty.is_some_and(|dirty| !dirty.contains(&(block_index as u32))) {
            continue;
        }
        let block = &mut blocks[block_index];
        let range = block_index * BLOCK_SIZE..((block_index + 1) * BLOCK_SIZE).min(document_len);
        let keys: Vec<_> = projected
            .iter()
            .filter(|input| range.contains(&input.index))
            .filter(|input| focused_id != Some(input.node.id.as_str()))
            .filter_map(|input| {
                let node = input.node.as_ref();
                let hover = scene
                    .hover
                    .as_ref()
                    .filter(|h| h.node_id.as_deref() == Some(node.id.as_str()));
                if hover.is_none() {
                    return None;
                }
                Some(DecorationInput {
                    id: node.id.clone(),
                    kind: node.kind.clone(),
                    index: input.index,
                    rect: [node.x, node.y, node.width, node.height],
                    hover: hover.map(|h| h.port.clone()),
                    cursor: hover.and_then(|h| h.cursor).map(|p| [p.x, p.y]),
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
            let input = projected
                .iter()
                .find(|input| input.index == key.index)
                .expect("hover key derives from projected input");
            super::cards::draw_hover_ports(
                &mut geometry,
                theme,
                input.node.as_ref(),
                scene.hover.as_ref(),
                input.render,
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
                        MeshMaterial2d(materials.solid.clone()),
                        NoFrustumCulling,
                    ))
                    .id(),
            );
        }
        block.keys = keys;
        block.theme = theme.fingerprint().to_owned();
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
