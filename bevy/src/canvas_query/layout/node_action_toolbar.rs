//! 节点顶部操作横条的布局派生（change: 2026-10-13-add-node-to-film-set-shortcut）。
//!
//! 横条由 Bevy 在画布内绘制、由 Rust interaction snapshot 命中，绘制与命中共用本模块同一派生，
//! 保证「画在哪、点在哪」一致。`NODE_ACTION_TOOLBAR_*` 常量保留在父模块 `layout` 中，供
//! contracts 一致性测试（`render-scene.test.ts`）读取同一处来源。

use bevy::prelude::*;

use super::*;
use crate::protocol::GraphNode;

/// 一个已布局的动作：命中矩形、是否带独立箭头、文案与可用性（供绘制）。
#[derive(Clone)]
pub(crate) struct NodeActionSlot {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) tone: String,
    pub(crate) icon: Option<String>,
    pub(crate) icon_only: bool,
    /// 动作本体矩形 `(x, y, width, height)`。
    pub(crate) rect: (f32, f32, f32, f32),
    /// 独立设置箭头矩形（仅 `menu` 动作）。
    pub(crate) menu: Option<(f32, f32, f32, f32)>,
}

/// 横条布局结果：容器、动作槽、可选摘要与最终位置。
#[derive(Clone)]
pub(crate) struct NodeActionLayout {
    pub(crate) bar: (f32, f32, f32, f32),
    pub(crate) slots: Vec<NodeActionSlot>,
    /// 摘要（截断后文本与矩形）。
    pub(crate) summary: Option<(String, (f32, f32, f32, f32))>,
    /// 顶部放不下时回退到节点下方（用于绘制时的锚点记录）。
    pub(crate) below: bool,
}

/// 按最大宽度截断文本（超出加省略号）；与 contracts `truncateNodeActionText` 同一启发式。
pub(crate) fn truncate_node_action_text(text: &str, size: f32, max_width: f32) -> String {
    if estimated_text_width(text, size) <= max_width {
        return text.to_owned();
    }
    let ellipsis = "…";
    let budget = max_width - estimated_text_width(ellipsis, size);
    let mut width = 0.0;
    let mut result = String::new();
    for c in text.chars() {
        let char_width = estimated_char_width(c, size);
        if width + char_width > budget {
            break;
        }
        width += char_width;
        result.push(c);
    }
    result.push('…');
    result
}

/// 计算横条及其各动作矩形（世界坐标）；无动作时返回 `None`。
///
/// 按屏幕像素排版，再还原为世界命中矩形；视口决定边缘避让。
pub(crate) fn node_action_toolbar(
    node: &GraphNode,
    actions: &crate::protocol::NodeActions,
    viewport: Option<(f32, f32, f32)>,
    surface: Option<(f32, f32)>,
) -> Option<NodeActionLayout> {
    let bounds = (node.x, node.y, node.width, node.height);
    node_action_toolbar_for_bounds(bounds, actions, viewport, surface)
}

pub(crate) fn node_action_toolbar_for_bounds(
    (x, y, width, node_height): (f32, f32, f32, f32),
    actions: &crate::protocol::NodeActions,
    viewport: Option<(f32, f32, f32)>,
    surface: Option<(f32, f32)>,
) -> Option<NodeActionLayout> {
    if actions.actions.is_empty() {
        return None;
    }
    let zoom = viewport
        .map(|(_, _, zoom)| zoom)
        .filter(|zoom| zoom.is_finite() && *zoom > 0.0)
        .unwrap_or(1.0);
    let height = NODE_ACTION_TOOLBAR_ACTION_HEIGHT;

    let summary_text = actions
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            truncate_node_action_text(
                text,
                NODE_ACTION_TOOLBAR_FONT,
                NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH,
            )
        });
    let summary_width = summary_text
        .as_deref()
        .map(|text| estimated_text_width(text, NODE_ACTION_TOOLBAR_FONT))
        .unwrap_or(0.0);

    let action_widths: Vec<f32> = actions
        .actions
        .iter()
        .map(|action| {
            if action.icon_only {
                return NODE_ACTION_TOOLBAR_ACTION_HEIGHT;
            }
            let icon = if action.icon.is_some() {
                NODE_ACTION_TOOLBAR_ICON_SIZE + NODE_ACTION_TOOLBAR_ICON_GAP
            } else {
                0.0
            };
            (estimated_text_width(&action.label, NODE_ACTION_TOOLBAR_FONT)
                + icon
                + NODE_ACTION_TOOLBAR_ACTION_PAD * 2.0)
                .max(NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH)
                .ceil()
        })
        .collect();
    let chevron_count = actions.actions.iter().filter(|action| action.menu).count() as f32;
    let separator_width =
        (actions.actions.len().saturating_sub(1)) as f32 * NODE_ACTION_TOOLBAR_SEPARATOR;
    let content_width = action_widths.iter().sum::<f32>()
        + chevron_count * NODE_ACTION_TOOLBAR_CHEVRON_WIDTH
        + separator_width
        + if summary_text.is_some() {
            summary_width + NODE_ACTION_TOOLBAR_SUMMARY_GAP
        } else {
            0.0
        };
    let bar_width = content_width + NODE_ACTION_TOOLBAR_PAD * 2.0;
    let bar_height = height + NODE_ACTION_TOOLBAR_PAD * 2.0;

    let centered_x = (x + width / 2.0) * zoom - bar_width / 2.0;
    let above_y = y * zoom - NODE_ACTION_TOOLBAR_GAP - bar_height;
    let below_y = (y + node_height) * zoom + NODE_ACTION_TOOLBAR_GAP;

    let mut below = false;
    if let (Some((_, viewport_y, _)), Some(_)) = (viewport, surface) {
        let screen_top_above = above_y + viewport_y;
        if screen_top_above < NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN {
            below = true;
        }
    }
    let mut bar_y = if below { below_y } else { above_y };
    let mut bar_x = centered_x;
    if let (Some((vx, vy, _)), Some((sw, sh))) = (viewport, surface) {
        let margin = NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN;
        bar_x = bar_x.min(sw - margin - bar_width - vx).max(margin - vx);
        bar_y = bar_y.min(sh - margin - bar_height - vy).max(margin - vy);
    }
    let bar = (bar_x, bar_y, bar_width, bar_height);

    let mut cursor = bar.0 + NODE_ACTION_TOOLBAR_PAD;
    let summary = summary_text.map(|text| {
        let rect = (
            cursor,
            bar.1 + NODE_ACTION_TOOLBAR_PAD,
            summary_width,
            height,
        );
        cursor += summary_width + NODE_ACTION_TOOLBAR_SUMMARY_GAP;
        (text, rect)
    });
    let mut slots = Vec::with_capacity(actions.actions.len());
    for (index, action) in actions.actions.iter().enumerate() {
        let width = action_widths[index];
        let rect = (cursor, bar.1 + NODE_ACTION_TOOLBAR_PAD, width, height);
        cursor += width;
        let menu = if action.menu {
            let menu_rect = (
                cursor,
                bar.1 + NODE_ACTION_TOOLBAR_PAD,
                NODE_ACTION_TOOLBAR_CHEVRON_WIDTH,
                height,
            );
            cursor += NODE_ACTION_TOOLBAR_CHEVRON_WIDTH;
            Some(menu_rect)
        } else {
            None
        };
        if index + 1 < actions.actions.len() {
            cursor += NODE_ACTION_TOOLBAR_SEPARATOR;
        }
        slots.push(NodeActionSlot {
            id: action.id.clone(),
            label: action.label.clone(),
            enabled: action.enabled,
            tone: action.tone.clone(),
            icon: action.icon.clone(),
            icon_only: action.icon_only,
            rect,
            menu,
        });
    }

    let world =
        |rect: (f32, f32, f32, f32)| (rect.0 / zoom, rect.1 / zoom, rect.2 / zoom, rect.3 / zoom);
    for slot in &mut slots {
        slot.rect = world(slot.rect);
        slot.menu = slot.menu.map(world);
    }
    Some(NodeActionLayout {
        bar: world(bar),
        slots,
        summary: summary.map(|(text, rect)| (text, world(rect))),
        below,
    })
}

impl NodeActionLayout {
    /// 全部矩形有限性（拖动预览的派生几何校验）。
    pub(crate) fn rects_finite(&self) -> bool {
        let mut rects = vec![self.bar];
        for slot in &self.slots {
            rects.push(slot.rect);
            if let Some(menu) = slot.menu {
                rects.push(menu);
            }
        }
        if let Some((_, rect)) = &self.summary {
            rects.push(*rect);
        }
        rects.iter().all(|rect| {
            [
                rect.0,
                rect.1,
                rect.2,
                rect.3,
                rect.0 + rect.2,
                rect.1 + rect.3,
            ]
            .iter()
            .all(|value| value.is_finite())
        })
    }
}
