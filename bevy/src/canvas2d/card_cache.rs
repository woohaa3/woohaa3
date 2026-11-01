//! Fixed document-order blocks retain ordinary-card GPU buffers on local changes.
//! All card primitives are opaque. Transparent groups and overlays remain in the
//! original shared mesh, so this partition does not change blend submission order.
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 输入改为 ECS 节点 Query，
//! 标签通过 `LabelRequests` 交给 `sync_canvas_labels`；块缓存仍只保存几何/资产。
use super::{CanvasMaterials, geometry::Geometry, labels::LabelRequest, labels::LabelRequests, labels::LabelStyle};
use crate::canvas_ecs::components::{CanvasLabelRole, CardVisual};
use crate::{
    protocol::{GraphNode, Scene},
    theme::ThemeResource,
};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

const BLOCK_SIZE: usize = 16;
// Owned exact draw inputs, rather than hashes or complete model/media payloads.
// Comparing borrows on warm frames avoids copying body strings and vertex data.
#[derive(PartialEq)]
struct HistoryKey {
    dots: Vec<(String, bool, bool)>,
    truncated: u32,
}
#[derive(PartialEq)]
struct DrawKey {
    id: String,
    kind: String,
    visual: crate::canvas_ecs::components::CardGeometryInput,
    /// 节点下方历史条呈现（change: 2026-10-12-unify-generation-history-strip）：
    /// `Some` 表示该普通节点应绘制历史条（含空圆点时仍画条与图标）；
    /// `None` 表示不应绘制（ghost）。圆点状态/当前装饰参与 key，运行态变化即时重建分块。
    history: Option<HistoryKey>,
    /// 该节点是拖动粘连 owner 时让位历史条（下方已被操作条占用）。
    hide_history: bool,
}
impl DrawKey {
    fn history(node: &GraphNode) -> Option<HistoryKey> {
        if !super::layout::has_history_strip(node) {
            return None;
        }
        let (dots, truncated) = match &node.history_strip {
            Some(strip) => (
                strip
                    .dots
                    .iter()
                    .map(|dot| (dot.state.clone(), dot.current, dot.selected.is_some()))
                    .collect(),
                strip.truncated,
            ),
            None => (Vec::new(), 0),
        };
        Some(HistoryKey { dots, truncated })
    }
    fn new(node: &GraphNode, attach_owner: Option<&str>) -> Self {
        Self {
            id: node.id.clone(),
            kind: node.kind.clone(),
            visual: CardVisual::from_node(node).geometry,
            history: Self::history(node),
            hide_history: attach_owner == Some(node.id.as_str()),
        }
    }
}

#[derive(Default)]
pub(super) struct Block {
    // Includes local document index: changing a group/card slot shifts z even
    // when the remaining ordinary cards have identical IDs and coordinates.
    keys: Vec<(usize, DrawKey)>,
    theme: String,
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    /// 上一帧提交给 `LabelRequests` 的文案；块命中时原样重提，避免 `begin` 清空后闪失。
    labels: Vec<LabelRequest>,
    /// Label-only inputs are tracked independently so a rename does not rebuild mesh geometry.
    label_keys: Vec<(Entity, String, String, String, Option<String>)>,
}

#[derive(Resource, Default)]
pub(crate) struct CardBlockCache {
    pub(super) blocks: Vec<Block>,
}
fn ordinary(_node: &GraphNode) -> bool {
    true
}

impl Block {
    fn clear(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        if let Some(entity) = self.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = self.mesh.take() {
            meshes.remove(mesh.id());
        }
        self.keys.clear();
        self.theme.clear();
        self.labels.clear();
        self.label_keys.clear();
    }
}

/// 一个由投影层提交的普通卡片输入（文档下标 + 实体 + 绘制 DTO）。
pub(super) struct CardInput<'a> {
    /// 文档下标（16 节点分块用）。
    pub(crate) index: usize,
    /// 投影层派生的渲染槽位（ghost 固定最低层）。
    pub(crate) render: usize,
    pub(crate) entity: Entity,
    pub(crate) node: &'a GraphNode,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut CardBlockCache,
    requests: &mut LabelRequests,
    cards: &[CardInput<'_>],
    document_len: usize,
    scene: &Scene,
    theme: &ThemeResource,
    materials: &CanvasMaterials,
) -> u64 {
    requests.begin(CanvasLabelRole::Card);
    let mut blocks = std::mem::take(&mut visuals.blocks);
    let count = document_len.div_ceil(BLOCK_SIZE);
    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    let attach_owner = scene
        .drag_attach
        .as_ref()
        .map(|attach| attach.node_id.as_str());
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let mut rebuilt = 0;
    for block_index in 0..count {
        let block = &mut blocks[block_index];
        let range = block_index * BLOCK_SIZE..((block_index + 1) * BLOCK_SIZE).min(document_len);
        let block_cards: Vec<&CardInput<'_>> = cards
            .iter()
            .filter(|card| range.contains(&card.index))
            .filter(|card| ordinary(card.node) && focused_id != Some(card.node.id.as_str()))
            .collect();
        let keys: Vec<(usize, DrawKey)> = block_cards
            .iter()
            .map(|card| (card.index, DrawKey::new(card.node, attach_owner)))
            .collect();
        let label_keys: Vec<_> = block_cards
            .iter()
            .map(|card| (card.entity, card.node.title.clone(), card.node.type_label.clone(), card.node.body.clone(), card.node.card_label.clone()))
            .collect();
        if block.theme == theme.fingerprint() && block.keys == keys {
            if block.label_keys != label_keys {
                block.labels = block_cards
                    .iter()
                    .map(|card| LabelRequest {
                        owner: card.entity,
                        labels: super::cards::labels(theme, card.node, card.render),
                        z: 10.0 + card.render as f32 * 0.1 + 0.02,
                        style: LabelStyle::Node,
                    })
                    .collect();
                block.label_keys = label_keys;
            }
            requests.extend(CanvasLabelRole::Card, &block.labels);
            continue;
        }
        if block_cards.is_empty() {
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            continue;
        }
        let mut geometry = Geometry::default();
        let mut block_requests = Vec::with_capacity(block_cards.len());
        for card in &block_cards {
            let node = card.node;
            let render_index = card.render;
            let labels = super::cards::labels(theme, node, render_index);
            super::cards::geometry(&mut geometry, theme, node, render_index);
            // 节点下方独立历史条（change: 2026-10-12-unify-generation-history-strip，design D4）：
            // 命中用 `canvas_query::layout::history_strip_rect`。拖动粘连 owner 期间其下方已被
            // 操作条占用，暂不让绘制历史条以免重叠。
            let key = DrawKey::new(node, attach_owner);
            if key.history.is_some() && !key.hide_history {
                super::history_strip::draw_history_strip(
                    &mut geometry,
                    theme,
                    node,
                    10.0 + render_index as f32 * 0.1 + 0.05,
                );
            }
            let request = LabelRequest {
                owner: card.entity,
                labels,
                z: 10.0 + render_index as f32 * 0.1 + 0.02,
                style: LabelStyle::Node,
            };
            requests.push_request(CanvasLabelRole::Card, request.clone());
            block_requests.push(request);
        }
        let handle = meshes.add(geometry.build());
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
        block.labels = block_requests;
        block.label_keys = label_keys;
        rebuilt += 1;
    }
    visuals.blocks = blocks;
    rebuilt
}

/// 供 producer system 从查询结果构造输入；`node` 来自 `NodeIndex` + focus 投影。
pub(super) fn input<'a>(
    entity: Entity,
    index: usize,
    render: usize,
    node: &'a GraphNode,
) -> CardInput<'a> {
    CardInput {
        index,
        render,
        entity,
        node,
    }
}

#[cfg(test)]
pub(super) fn clear(commands: &mut Commands, meshes: &mut Assets<Mesh>, blocks: &mut Vec<Block>) {
    for block in blocks.iter_mut() {
        block.clear(commands, meshes);
    }
    blocks.clear();
}

#[cfg(test)]
mod tests;
