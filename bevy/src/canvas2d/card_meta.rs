//! 卡片上方的名称与尺寸行（仅选中/悬停时显示）。
//!
//! 卡片本体只保留四边等宽窄边 + 内容（图片铺满整张卡），名称与像素尺寸因此移到卡片
//! **外侧上方**：左侧是名称，右侧是「宽 x 高」。
//!
//! 只产出标签、不产出几何，所以不进卡片块缓存：选中/悬停变化只重建这一行文字，
//! 不会让所有卡片重新上传 mesh（卡片块缓存按 key 命中时保留 GPU 句柄）。

use bevy::prelude::*;

use crate::canvas_ecs::components::{CanvasLabelRole, CanvasNodeId, CanvasSelection, CanvasTextureSprite, CardPresentation};
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;

use super::labels::{Label, LabelRequests, LabelStyle};
use super::layout::{estimated_text_width, shortened, CARD_CONTENT_PAD, CARD_META_GAP, CARD_TITLE_FONT};

use crate::app::{CurrentScene, NodeIndex};

/// 名称与尺寸行的竖向位置（文字顶部，锚点 `TOP_LEFT`）。
pub(crate) fn meta_top(node: &GraphNode) -> f32 {
    node.y - CARD_META_GAP - CARD_TITLE_FONT
}

/// 富内容卡（非紧凑）才有卡片外的名称行。
fn rich(node: &GraphNode) -> bool {
    !super::layout::compact_card(node) && node.group.is_none() && node.composite_asset.is_none()
}

/// 尺寸文案：`5460 x 3072`（原图像素）。
pub(crate) fn size_label(texture_px: [u32; 2]) -> Option<String> {
    let [width, height] = texture_px;
    (width > 0 && height > 0).then(|| format!("{width} x {height}"))
}

/// 构造一行：名称在左、尺寸在右（右端与卡片右缘对齐）。
pub(crate) fn meta_labels(
    node: &GraphNode,
    title: &str,
    size: Option<&str>,
    title_color: u32,
    size_color: u32,
) -> Vec<Label> {
    let left = node.x + CARD_CONTENT_PAD;
    let right = node.x + node.width - CARD_CONTENT_PAD;
    let top = meta_top(node);
    let size_width = size.map(|text| estimated_text_width(text, CARD_TITLE_FONT)).unwrap_or(0.0);
    // 名称最多占到尺寸文字左侧（留 12 的间隙），避免两者叠在一起。
    let title_width = (node.width - CARD_CONTENT_PAD * 2.0 - if size.is_some() { size_width + 12.0 } else { 0.0 }).max(24.0);
    let mut labels: Vec<Label> = Vec::with_capacity(2);
    if !title.is_empty() {
        labels.push((
            shortened(title, title_width, CARD_TITLE_FONT),
            Vec2::new(left, top),
            CARD_TITLE_FONT,
            title_color,
        ));
    }
    if let Some(text) = size {
        labels.push((
            text.to_owned(),
            Vec2::new(right - size_width, top),
            CARD_TITLE_FONT,
            size_color,
        ));
    }
    labels
}

/// 每帧产出选中/悬停卡片上方的名称与尺寸行。
pub(crate) fn produce_card_meta(
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    theme: Res<ThemeResource>,
    mut requests: ResMut<LabelRequests>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasSelection, &CardPresentation)>,
    textures: Query<&CanvasTextureSprite>,
) {
    requests.begin(CanvasLabelRole::CardMeta);
    let hovered = scene.0.hover.as_ref().and_then(|hover| hover.node_id.as_deref());
    if hovered.is_none() && scene.0.selection.nodes.is_empty() {
        return;
    }
    // 聚焦中的节点由聚焦工作区呈现，不再画卡片上方这一行。
    let focused = super::image_focus::presented_media_focus(&scene.0).map(|focus| focus.node_id.clone());
    // 原图像素尺寸随贴图 Sprite 记着，按节点 id 建一次小表（只含已上传的贴图节点）。
    let sizes: std::collections::HashMap<&str, [u32; 2]> = textures
        .iter()
        .map(|sprite| (sprite.node_id.as_str(), sprite.texture_px))
        .collect();
    let title_color = theme.token_u32("canvasBodyText");
    let size_color = theme.token_u32("webTextMuted");
    for (entity, id, selection, _) in &nodes {
        if !selection.selected && hovered != Some(id.0.as_str()) {
            continue;
        }
        if focused.as_deref() == Some(id.0.as_str()) {
            continue;
        }
        let Some(node) = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0) else {
            continue;
        };
        let node = node.as_ref();
        if !rich(node) {
            continue;
        }
        let title = if node.title.is_empty() {
            node.card_label.clone().unwrap_or_default()
        } else {
            node.title.clone()
        };
        let size = sizes.get(node.id.as_str()).and_then(|px| size_label(*px));
        let labels = meta_labels(node, &title, size.as_deref(), title_color, size_color);
        if labels.is_empty() {
            continue;
        }
        let render = scene.0.nodes.iter().position(|candidate| candidate.id == node.id).unwrap_or(0);
        requests.push(
            CanvasLabelRole::CardMeta,
            entity,
            labels,
            10.0 + render as f32 * 0.1 + 0.03,
            LabelStyle::Node,
        );
    }
}
