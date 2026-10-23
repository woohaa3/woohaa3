//! Fixed document-order blocks retain ordinary-card GPU buffers on local changes.
//! All card primitives are opaque. Transparent groups and overlays remain in the
//! original shared mesh, so this partition does not change blend submission order.
use super::{Visuals, geometry::Geometry, labels::sync_labels, text_presentation::LogicalText};
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
    rect: [f32; 4],
    title: String,
    type_label: String,
    body: String,
    card_label: Option<String>,
    flags: [bool; 5],
    /// 节点下方历史条呈现（change: 2026-10-12-unify-generation-history-strip）：
    /// `Some` 表示该普通节点应绘制历史条（含空圆点时仍画条与图标）；
    /// `None` 表示不应绘制（ghost）。圆点状态/当前装饰参与 key，运行态变化即时重建分块。
    history: Option<HistoryKey>,
    /// 该节点是拖动粘连 owner 时让位历史条（下方已被操作条占用）。
    hide_history: bool,
    /// 拍摄镜头预览卡片呈现（change: 2026-10-15-add-film-set-shooting-shot-previews）：
    /// 状态/类型/播放进度变化即时重建内容面与进度条（只读投影，不进入 canonical）。
    shot_preview: Option<crate::protocol::ShotPreviewPresentation>,
}
impl DrawKey {
    fn flags(node: &GraphNode) -> [bool; 5] {
        [
            node.texture,
            node.busy,
            node.model.is_some(),
            node.model_preview.is_some(),
            node.ghost,
        ]
    }
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
            rect: [node.x, node.y, node.width, node.height],
            title: node.title.clone(),
            type_label: node.type_label.clone(),
            body: node.body.clone(),
            card_label: node.card_label.clone(),
            flags: Self::flags(node),
            history: Self::history(node),
            hide_history: attach_owner == Some(node.id.as_str()),
            shot_preview: node.shot_preview.clone(),
        }
    }
    fn matches(&self, node: &GraphNode, attach_owner: Option<&str>) -> bool {
        self.id == node.id
            && self.kind == node.kind
            && self.rect == [node.x, node.y, node.width, node.height]
            && self.title == node.title
            && self.type_label == node.type_label
            && self.body == node.body
            && self.card_label == node.card_label
            && self.flags == Self::flags(node)
            && self.history == Self::history(node)
            && self.hide_history == (attach_owner == Some(node.id.as_str()))
            && self.shot_preview == node.shot_preview
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
}
fn ordinary(node: &GraphNode) -> bool {
    node.group.is_none() && node.composite_asset.is_none()
}

impl Block {
    fn matches(
        &self,
        nodes: &[GraphNode],
        theme: &str,
        attach_owner: Option<&str>,
        focused_id: Option<&str>,
    ) -> bool {
        self.theme == theme
            && self.keys.len() == nodes.iter().filter(|n| ordinary(n) && focused_id != Some(n.id.as_str())).count()
            && self
                .keys
                .iter()
                .zip(nodes.iter().enumerate().filter(|(_, n)| ordinary(n) && focused_id != Some(n.id.as_str())))
                .all(|((old_index, key), (index, node))| {
                    *old_index == index && key.matches(node, attach_owner)
                })
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

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    visuals: &mut Visuals,
    text: &mut Query<(&mut Text2d, &mut Transform, &mut TextColor, &mut LogicalText), Without<Sprite>>,
    scene: &Scene,
    theme: &ThemeResource,
) -> u64 {
    let mut blocks = std::mem::take(&mut visuals.card_blocks);
    let count = scene.nodes.len().div_ceil(BLOCK_SIZE);
    let focused_id = super::image_focus::presented_media_focus(scene).map(|focus| focus.node_id);
    let attach_owner = scene.drag_attach.as_ref().map(|attach| attach.node_id.as_str());
    for block in blocks.iter_mut().skip(count) {
        block.clear(commands, meshes);
    }
    blocks.truncate(count);
    blocks.resize_with(count, Block::default);
    let mut rebuilt = 0;
    for (block_index, nodes) in scene.nodes.chunks(BLOCK_SIZE).enumerate() {
        let block = &mut blocks[block_index];
        if block.matches(nodes, theme.fingerprint(), attach_owner, focused_id) {
            continue;
        }
        if !nodes.iter().any(|node| ordinary(node) && focused_id != Some(node.id.as_str())) {
            block.clear(commands, meshes);
            block.theme = theme.fingerprint().to_owned();
            continue;
        }
        let mut geometry = Geometry::default();
        block.keys.clear();
        for (local_index, node) in nodes.iter().enumerate().filter(|(_, n)| ordinary(n) && focused_id != Some(n.id.as_str())) {
            let index = block_index * BLOCK_SIZE + local_index;
            let key = DrawKey::new(node, attach_owner);
            let labels = super::cards::draw_static(&mut geometry, theme, node, index);
            // 节点下方独立历史条（change: 2026-10-12-unify-generation-history-strip，design D4）：
            // 命中用 `canvas_query::layout::history_strip_rect`。拖动粘连 owner 期间其下方已被
            // 操作条占用，暂不让绘制历史条以免重叠。
            if key.history.is_some() && !key.hide_history {
                super::history_strip::draw_history_strip(&mut geometry, theme, node, 10.0 + index as f32 * 0.1 + 0.05);
            }
            sync_labels(
                commands,
                visuals,
                text,
                &node.id,
                labels,
                10.0 + index as f32 * 0.1 + 0.02,
            );
            block.keys.push((local_index, key));
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
                        MeshMaterial2d(visuals.material.clone()),
                        NoFrustumCulling,
                    ))
                    .id(),
            );
        }
        block.theme = theme.fingerprint().to_owned();
        rebuilt += 1;
    }
    visuals.card_blocks = blocks;
    rebuilt
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
