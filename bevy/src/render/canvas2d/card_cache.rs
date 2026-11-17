//! Fixed document-order blocks retain ordinary-card GPU buffers on local changes.
//! All card primitives are opaque. Transparent groups and overlays remain in the
//! original shared mesh, so this partition does not change blend submission order.
//!
//! change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs —— 输入改为 ECS 节点 Query，
//! 标签通过 `LabelRequests` 交给 `sync_canvas_labels`；块缓存仍只保存几何/资产。
use super::{
    CanvasMaterials,
    geometry::Geometry,
    labels::{Label, LabelOwner, LabelRequests, LabelStyle, LabelWriter},
};
use crate::canvas_ecs::components::{CanvasLabelRole, CardVisual};
use crate::{
    protocol::{GraphNode, Scene},
    theme::ThemeResource,
};
use crate::canvas_runtime::{Aabb, Workset, WorksetIndex};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

pub(super) const BLOCK_SIZE: usize = 16;
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
    /// Locked presentation changes every painted primitive; include it so the
    /// retained mesh is rebuilt when switching back to edit.
    scope_mode: String,
    /// 0 card / 1 frame / 2 none；外壳变化必须重建几何分块。
    chrome: u8,
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
            scope_mode: node
                .edit_scope
                .as_ref()
                .map_or_else(|| "edit".to_owned(), |scope| scope.mode.clone()),
            chrome: match &node.chrome {
                crate::protocol::NodeChrome::Card => 0,
                crate::protocol::NodeChrome::Frame { .. } => 1,
                crate::protocol::NodeChrome::None => 2,
            },
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
    /// 已提交标签的稳定节点 id。块清空或节点离开时按这份名单删除，命中时不重提。
    label_ids: Vec<String>,
    /// Label-only inputs are tracked independently so a rename does not rebuild mesh geometry.
    label_keys: Vec<(Entity, String, String, String, Option<String>, String)>,
}

#[derive(Resource, Default)]
pub(crate) struct CardBlockCache {
    pub(super) blocks: Vec<Block>,
    workset_index: WorksetIndex,
    workset: Workset,
    owner_blocks: HashMap<Entity, u32>,
    labels_ready: bool,
    new_block_visibility: BTreeSet<u32>,
    pending_label_visibility: BTreeSet<u32>,
    #[cfg(test)]
    pub(super) visibility_writes: usize,
}

impl CardBlockCache {
    pub(crate) fn can_update_blocks(&self, node_count: usize) -> bool {
        self.labels_ready && self.blocks.len() == node_count.div_ceil(BLOCK_SIZE)
    }
    pub(crate) fn sync_workset(
        &mut self,
        commands: &mut Commands,
        viewport: crate::protocol::Viewport,
        surface: Vec2,
    ) {
        let zoom = viewport.zoom.max(0.01);
        let visible = Aabb::from_viewport(&viewport, surface.to_array());
        let next = if cfg!(feature = "canvas-reference") {
            (0..self.blocks.len() as u32).collect()
        } else { self.workset_index.query_with_hysteresis(
            visible,
            64.0 / zoom,
            80.0 / zoom,
            self.workset.active(),
        ) };
        let delta = self.workset.update(next);
        let mut changed = std::mem::take(&mut self.new_block_visibility);
        changed.extend(delta.entered);
        changed.extend(delta.left);
        self.pending_label_visibility.extend(changed.iter().copied());
        #[cfg(test)]
        { self.visibility_writes = 0; }
        for index in changed {
            let Some(entity) = self.blocks.get(index as usize).and_then(|block| block.entity) else { continue };
            let visibility = if self.workset.active().contains(&index) {
                Visibility::Visible
            } else {
                Visibility::Hidden
            };
            commands.entity(entity).insert(visibility);
            #[cfg(test)]
            { self.visibility_writes += 1; }
        }
    }

    pub(crate) fn owner_visible(&self, owner: Entity) -> bool {
        self.owner_blocks.get(&owner).is_some_and(|block| {
            self.workset.active().contains(block)
        })
    }

    pub(crate) fn take_visibility_owners(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_label_visibility).into_iter()
            .filter_map(|index| self.blocks.get(index as usize))
            .flat_map(|block| block.label_ids.iter().cloned())
            .collect()
    }

    /// 换画布后几何键可能仍命中。清掉标签键，让下一帧只重提标签、不重建 mesh。
    pub(crate) fn invalidate_labels(&mut self) {
        self.labels_ready = false;
        for block in &mut self.blocks {
            block.label_keys.clear();
            block.label_ids.clear();
        }
    }
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
        self.label_ids.clear();
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
    dirty_blocks: Option<&BTreeSet<u32>>,
) -> u64 {
    let mut blocks = std::mem::take(&mut visuals.blocks);
    let count = document_len.div_ceil(BLOCK_SIZE);
    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    let attach_owner = scene
        .drag_attach
        .as_ref()
        .map(|attach| attach.node_id.as_str());
    for block in blocks.iter_mut().skip(count) {
        release_card_labels(requests, block);
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let dirty_blocks = dirty_blocks.filter(|_| visuals.labels_ready && blocks.len() == count);
    if dirty_blocks.is_none() {
        visuals.owner_blocks.clear();
    }
    let mut rebuilt = 0;
    // 一次按文档槽分桶。块内顺序仍是 `cards` 的出现顺序，与原先每个块 `filter(range)` 相同。
    // `index >= document_len` 不进任何块：旧 range 止于 `document_len`。
    let mut buckets: BTreeMap<usize, Vec<&CardInput<'_>>> = BTreeMap::new();
    for card in cards {
        if card.index >= document_len {
            continue;
        }
        if !(ordinary(card.node) && focused_id != Some(card.node.id.as_str())) {
            continue;
        }
        buckets.entry(card.index / BLOCK_SIZE).or_default().push(card);
    }
    let indices: Box<dyn Iterator<Item = usize> + '_> = match dirty_blocks {
        Some(dirty) => Box::new(dirty.iter().map(|&index| index as usize).filter(|&index| index < count)),
        None => Box::new(0..count),
    };
    for block_index in indices {
        visuals.pending_label_visibility.insert(block_index as u32);
        let block = &mut blocks[block_index];
        let block_cards = buckets.get(&block_index).map_or(&[][..], Vec::as_slice);
        for card in block_cards {
            visuals.owner_blocks.insert(card.entity, block_index as u32);
        }
        let keys: Vec<(usize, DrawKey)> = block_cards
            .iter()
            .map(|card| (card.index, DrawKey::new(card.node, attach_owner)))
            .collect();
        let label_keys: Vec<_> = block_cards
            .iter()
            .map(|card| {
                (
                    card.entity,
                    card.node.title.clone(),
                    card.node.type_label.clone(),
                    card.node.body.clone(),
                    card.node.card_label.clone(),
                    card.node
                        .edit_scope
                        .as_ref()
                        .map_or_else(|| "edit".to_owned(), |scope| scope.mode.clone()),
                )
            })
            .collect();
        if !cfg!(feature = "canvas-reference") && block.theme == theme.fingerprint() && block.keys == keys {
            if block.label_keys != label_keys {
                let submissions = block_cards
                    .iter()
                    .map(|card| card_submission(theme, card))
                    .collect();
                submit_card_labels(requests, block, submissions);
                block.label_keys = label_keys;
            }
            continue;
        }
        if block_cards.is_empty() {
            release_card_labels(requests, block);
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            continue;
        }
        let mut geometry = Geometry::default();
        let mut submissions = Vec::with_capacity(block_cards.len());
        for card in block_cards {
            let node = card.node;
            let render_index = card.render;
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
            submissions.push(card_submission(theme, card));
        }
        let handle = meshes.add(geometry.build());
        if let Some(old) = block.mesh.replace(handle.clone()) {
            meshes.remove(old.id());
        }
        if let Some(entity) = block.entity {
            commands.entity(entity).insert(Mesh2d(handle));
        } else {
            visuals.new_block_visibility.insert(block_index as u32);
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
        submit_card_labels(requests, block, submissions);
        block.label_keys = label_keys;
        rebuilt += 1;
    }
    visuals.blocks = blocks;
    visuals.labels_ready = true;
    if let Some(dirty) = dirty_blocks {
        for &index in dirty {
            visuals.workset_index.remove(index);
            if let Some((min, max)) = visuals.blocks.get(index as usize).and_then(block_bounds) {
                visuals.workset_index.insert(index, Aabb { min, max });
            }
        }
    } else {
        visuals.workset_index.clear();
        for (index, block) in visuals.blocks.iter().enumerate() {
            if let Some((min, max)) = block_bounds(block) {
                visuals.workset_index.insert(index as u32, Aabb { min, max });
            }
        }
    }
    // Recompute visibility from the current view after rebuilding block bounds.
    visuals.sync_workset(commands, super::render::workset_viewport(scene), Vec2::new(
        scene.surface.as_ref().map_or(1.0, |surface| surface.width),
        scene.surface.as_ref().map_or(1.0, |surface| surface.height),
    ));
    rebuilt
}

fn block_bounds(block: &Block) -> Option<([f32; 2], [f32; 2])> {
    let mut min = [f32::INFINITY; 2];
    let mut max = [f32::NEG_INFINITY; 2];
    for (_, key) in &block.keys {
        let [x, y, width, height] = key.visual.bounds;
        min[0] = min[0].min(x.min(x + width));
        min[1] = min[1].min(y.min(y + height));
        max[0] = max[0].max(x.max(x + width));
        max[1] = max[1].max(y.max(y + height));
    }
    min.iter().chain(max.iter()).all(|value| value.is_finite()).then_some((min, max))
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

fn card_submission(
    theme: &ThemeResource,
    card: &CardInput<'_>,
) -> (String, Entity, Vec<Label>, f32) {
    (
        card.node.id.clone(),
        card.entity,
        super::cards::labels(theme, card.node, card.render),
        10.0 + card.render as f32 * 0.1 + 0.02,
    )
}

fn submit_card_labels(
    requests: &mut LabelRequests,
    block: &mut Block,
    submissions: Vec<(String, Entity, Vec<Label>, f32)>,
) {
    for (id, entity, _, _) in &submissions {
        requests.bind(LabelOwner::Node(id.clone()), *entity);
    }
    let new_ids: Vec<String> = submissions.iter().map(|(id, _, _, _)| id.clone()).collect();
    let mut txn = requests.transaction(LabelWriter::Card);
    for id in block
        .label_ids
        .iter()
        .filter(|id| !new_ids.iter().any(|next| next == *id))
    {
        txn.replace_owner(
            CanvasLabelRole::Card,
            LabelOwner::Node(id.clone()),
            Vec::new(),
            0.0,
            LabelStyle::Node,
        );
    }
    for (id, _, labels, z) in submissions {
        txn.replace_owner(
            CanvasLabelRole::Card,
            LabelOwner::Node(id),
            labels,
            z,
            LabelStyle::Node,
        );
    }
    let _ = txn.commit();
    block.label_ids = new_ids;
}

fn release_card_labels(requests: &mut LabelRequests, block: &mut Block) {
    if block.label_ids.is_empty() {
        return;
    }
    let mut txn = requests.transaction(LabelWriter::Card);
    for id in block.label_ids.drain(..) {
        txn.replace_owner(
            CanvasLabelRole::Card,
            LabelOwner::Node(id),
            Vec::new(),
            0.0,
            LabelStyle::Node,
        );
    }
    let _ = txn.commit();
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
