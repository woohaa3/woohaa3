//! 2D 画布纯布局/文案函数（change: refactor-bevy-runtime-modules，任务 3.1 / design D6）。
//!
//! 只依赖协议类型与 Bevy 数学/颜色，不持有 ECS 状态、不读写 bridge。

use bevy::prelude::*;

use crate::protocol::GraphNode;

/// 右下角 resize 抓手边长，必须与 contracts 的 `RESIZE_HANDLE_SIZE` 一致
/// （change: add-node-resize；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const RESIZE_HANDLE_SIZE: f32 = 20.0;

/// 节点右上角历史动作命中区边长；下载控件高度复用该数值。历史上的右上角历史动作已移除
/// （change: 2026-10-12-unify-generation-history-strip），保留常量供下载命中区沿用。
pub(crate) const NODE_HISTORY_ACTION_SIZE: f32 = 28.0;

/// 历史条视觉高度，必须与 contracts 的 `NODE_HISTORY_STRIP_HEIGHT` 一致
/// （change: 2026-10-12-unify-generation-history-strip）。
pub(crate) const NODE_HISTORY_STRIP_HEIGHT: f32 = 16.0;
/// 历史条圆点半径，必须与 contracts 的 `NODE_HISTORY_STRIP_DOT_RADIUS` 一致。
pub(crate) const NODE_HISTORY_STRIP_DOT_RADIUS: f32 = 2.6;
/// 历史条圆点间隙，必须与 contracts 的 `NODE_HISTORY_STRIP_DOT_GAP` 一致。
pub(crate) const NODE_HISTORY_STRIP_DOT_GAP: f32 = 6.0;
/// 历史条与节点下缘的间隙，必须与 contracts 的 `NODE_HISTORY_STRIP_GAP` 一致。
pub(crate) const NODE_HISTORY_STRIP_GAP: f32 = 4.0;
/// 历史条最左侧历史图标区域宽度，必须与 contracts 的 `NODE_HISTORY_STRIP_ICON_SIZE` 一致。
pub(crate) const NODE_HISTORY_STRIP_ICON_SIZE: f32 = 18.0;
/// 历史条整体左右内边距，必须与 contracts 的 `NODE_HISTORY_STRIP_PADDING` 一致。
pub(crate) const NODE_HISTORY_STRIP_PADDING: f32 = 6.0;
/// 历史条圆角半径，必须与 contracts 的 `NODE_HISTORY_STRIP_RADIUS` 一致。
pub(crate) const NODE_HISTORY_STRIP_RADIUS: f32 = 6.0;

/// 连线删除按钮边长，必须与 contracts 的 `EDGE_DELETE_BUTTON_SIZE` 一致
/// （change: add-edge-hover-delete；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const EDGE_DELETE_BUTTON_SIZE: f32 = 18.0;

/// 连线标签胶囊宽度，必须与 contracts 的 `EDGE_LABEL_WIDTH` 一致。
pub(crate) const EDGE_LABEL_WIDTH: f32 = 104.0;
/// 连线标签胶囊高度，必须与 contracts 的 `EDGE_LABEL_HEIGHT` 一致。
pub(crate) const EDGE_LABEL_HEIGHT: f32 = 24.0;
/// 标签与删除按钮之间的间隙，必须与 contracts 的 `EDGE_DELETE_BUTTON_GAP` 一致。
pub(crate) const EDGE_DELETE_BUTTON_GAP: f32 = 4.0;

/// `0xRRGGBB` → sRGB 颜色。
pub(crate) fn hex(value: u32) -> Color {
    Color::srgb_u8((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

/// 节点「丰富卡片」的高度阈值（超过即显示正文/状态内容区）。
pub(crate) const RICH_NODE_HEIGHT: f32 = 116.0;

/// 节点是否有内容区（富内容卡片且非 3D 模型节点）。运行中进度环也复用该门禁
/// （change: add-node-running-progress）：只有会显示内容区的节点才用进度环替代它。
pub(crate) fn shows_content(node: &GraphNode) -> bool {
    node.height > RICH_NODE_HEIGHT && node.composite_asset.is_none() && node.group.is_none()
}

/// 节点内容区矩形 `(x, y, width, height)`：左右与底部各留 16px 内边距，顶部为标签行
/// （52px）。状态文案已移除（change: add-node-running-progress），内容区不再为底部状态行
/// 预留空间，而是延伸到卡片底部内缘。
pub(crate) fn content_rect(node: &GraphNode) -> (f32, f32, f32, f32) {
    content_rect_for_bounds(node.x, node.y, node.width, node.height)
}

pub(crate) fn content_rect_for_bounds(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    (x + 16., y + 52., (width - 32.).max(1.), (height - 68.).max(24.))
}

/// 内容区中心（纹理 Sprite 的锚点）。
pub(crate) fn content_center(node: &GraphNode) -> Vec2 {
    let (x, y, width, height) = content_rect(node);
    Vec2::new(x + width / 2., y + height / 2.)
}

/// 图片内容区尺寸：在节点内容框内按纹理自身宽高比 **contain**（不拉伸、不裁剪）。
/// 节点可自由缩放为任意宽高比；媒体始终按自身比例缩放并居中。
pub(crate) fn texture_size(node: &GraphNode, texture: Vec2) -> Vec2 {
    let (_, _, box_width, box_height) = content_rect(node);
    let scale = (box_width / texture.x).min(box_height / texture.y);
    Vec2::new((texture.x * scale).max(1.), (texture.y * scale).max(1.))
}

/// 命中半径（世界坐标）：随缩放放宽，与既有 JS `hitRadius` 一致
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.4）。
pub(crate) fn hit_radius(zoom: f32) -> f32 {
    (10.0 / zoom).max(10.0)
}

/// 边命中距离（世界坐标）：7 / zoom，与既有 JS 判定一致。
pub(crate) fn edge_hit_distance(zoom: f32) -> f32 {
    7.0 / zoom
}

/// 历史条命中矩形 `(x, y, width, height)`；与 contracts 的 `bevyNodeHistoryStripRect` 同一
/// 公式：圆点行在节点内部底部，左右留空避让 resize 抓手。
/// （change: 2026-10-12-unify-generation-history-strip）。
pub(crate) fn history_strip_rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    (
        x + 24.0,
        y + height - NODE_HISTORY_STRIP_GAP - NODE_HISTORY_STRIP_HEIGHT,
        (width - 48.0).max(1.0),
        NODE_HISTORY_STRIP_HEIGHT,
    )
}

/// 历史条最左侧历史图标中心；与 contracts `bevyNodeHistoryStripIcon` 同公式。
pub(crate) fn history_strip_icon(x: f32, y: f32, width: f32, height: f32) -> Vec2 {
    let (sx, sy, _sw, sh) = history_strip_rect(x, y, width, height);
    Vec2::new(
        sx + NODE_HISTORY_STRIP_PADDING + NODE_HISTORY_STRIP_ICON_SIZE / 2.0,
        sy + sh / 2.0,
    )
}

/// 第 `index` 个圆点中心，紧凑居中排列；与 contracts 同公式。
pub(crate) fn history_strip_dot(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    index: usize,
    count: usize,
) -> Vec2 {
    let (sx, sy, sw, sh) = history_strip_rect(x, y, width, height);
    let count = count.max(1);
    let usable = (sw - 2.0 * NODE_HISTORY_STRIP_PADDING).max(0.0);
    let step = if count > 1 {
        (usable / (count - 1) as f32).min(12.0)
    } else {
        0.0
    };
    let cx = sx + sw / 2.0 + (index as f32 - (count - 1) as f32 / 2.0) * step;
    Vec2::new(cx, sy + sh / 2.0)
}

/// 普通节点有至少两个版本时绘制内部圆点：非 group、非复合资产、非 ghost。
pub(crate) fn has_history_strip(node: &GraphNode) -> bool {
    !node.ghost
        && node.group.is_none()
        && node.composite_asset.is_none()
        && node
            .history_strip
            .as_ref()
            .is_some_and(|strip| strip.dots.len() > 1 || strip.dots.iter().any(|dot| dot.state != "succeeded" || dot.recoverable == Some(false)))
}

/// 运行中节点是否应显示逐帧进度环。
///
/// 覆盖所有普通运行节点（含紧凑节点与纯模型预览节点）：`shows_content` 只描述富内容卡片，
/// 会漏掉 196x64 的紧凑模型/纯模型节点。聚合节点（复合资产）用运行遮罩、group 用容器呈现，
/// 都不走进度环（change: 2026-10-12-unify-generation-history-strip）。
pub(crate) fn shows_generation_ring(node: &GraphNode) -> bool {
    node.busy && node.group.is_none() && node.composite_asset.is_none()
}

/// 运行进度环承载矩形：富内容节点用内容区；紧凑节点用卡片内缩矩形。
pub(crate) fn generation_ring_rect(node: &GraphNode) -> (f32, f32, f32, f32) {
    if shows_content(node) {
        return content_rect(node);
    }
    let inset = 6.0;
    (
        node.x + inset,
        node.y + inset,
        (node.width - inset * 2.0).max(1.0),
        (node.height - inset * 2.0).max(1.0),
    )
}

/// 右下角 resize 抓手命中矩形 `(x, y, width, height)`；与 contracts 的
/// `bevyResizeHandleRect` 同一公式（贴住右下角内缘）。
pub(crate) fn resize_rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    (
        x + width - RESIZE_HANDLE_SIZE,
        y + height - RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE,
    )
}

/// 连线删除按钮的**中心**：无标签时居中于两端口中点，有标签时排在标签胶囊右侧
/// （与 contracts `bevyEdgeDeleteRect` 同一公式）。
pub(crate) fn edge_delete_center(source: Vec2, target: Vec2, has_label: bool) -> Vec2 {
    let mid = (source + target) / 2.0;
    if has_label {
        Vec2::new(
            mid.x + EDGE_LABEL_WIDTH / 2.0 + EDGE_DELETE_BUTTON_GAP + EDGE_DELETE_BUTTON_SIZE / 2.0,
            mid.y,
        )
    } else {
        mid
    }
}

/// 连线删除按钮的命中矩形 `(x, y, width, height)`（绕中心的正方形）。
pub(crate) fn edge_delete_rect(center: Vec2) -> (f32, f32, f32, f32) {
    (
        center.x - EDGE_DELETE_BUTTON_SIZE / 2.0,
        center.y - EDGE_DELETE_BUTTON_SIZE / 2.0,
        EDGE_DELETE_BUTTON_SIZE,
        EDGE_DELETE_BUTTON_SIZE,
    )
}

/// 点是否落在矩形 `(x, y, width, height)` 内（边界包含）。
pub(crate) fn in_rect(point: Vec2, rect: (f32, f32, f32, f32)) -> bool {
    point.x >= rect.0 && point.x <= rect.0 + rect.2 && point.y >= rect.1 && point.y <= rect.1 + rect.3
}

// ── 节点顶部操作横条布局（change: 2026-10-13-add-node-to-film-set-shortcut）──────────────
//
// 横条由 Bevy 在画布内绘制、由 Rust interaction snapshot 命中；绘制与命中共用本模块的同一
// 派生，保证「画在哪、点在哪」一致。尺寸与间距用**世界单位**，随画布 zoom 一起缩放，与历史
// 按钮/resize 抓手/拖动粘连操作条等既有画布内 chrome 一致。常量必须与 contracts
// `render-scene/node-action-toolbar.ts` 一致（由 `render-scene.test.ts` 断言两边相同）。

/// 横条与节点之间固定的世界间距（design D7「约 8px」）。
pub(crate) const NODE_ACTION_TOOLBAR_GAP: f32 = 8.0;
/// 单个动作控件高度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_HEIGHT: f32 = 32.0;
/// 横条容器上下内边距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_PAD: f32 = 4.0;
/// 单个动作控件的最小宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH: f32 = 56.0;
/// 动作标签与控件边缘的水平内边距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_PAD: f32 = 8.0;
/// 设置箭头独立宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_CHEVRON_WIDTH: f32 = 24.0;
/// 动作分组之间的细分隔线占位宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SEPARATOR: f32 = 2.0;
/// 动作标签字号与模型名摘要字号（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_FONT: f32 = 13.0;
/// 模型名摘要与动作之间的水平间距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SUMMARY_GAP: f32 = 8.0;
/// 摘要最大宽度（超出省略，世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH: f32 = 140.0;
/// 顶部碰撞回退判定所用的视口安全边距（屏幕像素）。
pub(crate) const NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN: f32 = 8.0;

mod node_action_toolbar;
mod group_run_status;
pub(crate) use group_run_status::group_run_status_rect;

pub(crate) use node_action_toolbar::{
    NodeActionLayout, NodeActionSlot, node_action_toolbar, node_action_toolbar_for_bounds,
    truncate_node_action_text,
};


/// 连接端口：输入在左中、输出在右中。
pub(crate) fn port(node: &GraphNode, output: bool) -> Vec2 {
    port_for_bounds(node.x, node.y, node.width, node.height, output)
}

pub(crate) fn port_for_bounds(x: f32, y: f32, width: f32, height: f32, output: bool) -> Vec2 {
    Vec2::new(
        x + if output { width } else { 0.0 },
        y + height / 2.0,
    )
}

/// 单字估算宽度：ASCII 约 0.62em，其余（含 CJK）按 1em；控制字符替换为空格（宽度同空格）。
pub(crate) fn estimated_char_width(c: char, size: f32) -> f32 {
    if c.is_control() {
        size * 0.62
    } else if c.is_ascii() {
        size * 0.62
    } else {
        size
    }
}

/// 逐字估算整段文本宽度（与 [`shortened`] 同一启发式，供标题底衬等需要实际宽度的场景复用）。
pub(crate) fn estimated_text_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| estimated_char_width(c, size))
        .sum()
}

/// 片场标题字号。
pub(crate) const FILM_TITLE_FONT: f32 = 32.0;
/// 片场标题面板内类型标记（聚合节点业务类型名）字号。
pub(crate) const FILM_TITLE_TYPE_FONT: f32 = 20.0;
/// 片场标题面板左右内边距（文字与面板边缘的间隙）。
pub(crate) const FILM_TITLE_CHIP_PAD: f32 = 24.0;
/// 片场标题面板上下内边距。
pub(crate) const FILM_TITLE_VPAD: f32 = 12.0;
/// 标题行与类型标记行之间的竖直间隙。
pub(crate) const FILM_TITLE_LINE_GAP: f32 = 6.0;
/// 片场标题面板与范围顶部之间的竖直间隙。
pub(crate) const FILM_TITLE_GAP: f32 = 20.0;
/// 片场标题面板最小宽度。
pub(crate) const FILM_TITLE_MIN_WIDTH: f32 = 64.0;
/// 片场标题/类型名可读的最小文案宽度（约 6 个中文字符，含 `shortened` 预留的省略号宽度）。
///
/// 地面范围可能远窄于模型（小地面、较高的模型），若文案可用宽度严格跟随范围/内容宽度，标题会
/// 退化为单个字加省略号。面板浮在**范围与模型内容包围盒之上**、不侵占两者内部，因此允许它宽于
/// 内容以保住可读性。
pub(crate) const FILM_TITLE_MIN_TEXT_WIDTH: f32 = 224.0;

/// 片场标题面板高度：上下内边距 + 标题行（+ 可选类型标记行）。
pub(crate) fn film_title_chip_height(has_type: bool) -> f32 {
    FILM_TITLE_VPAD * 2.0
        + FILM_TITLE_FONT
        + if has_type {
            FILM_TITLE_LINE_GAP + FILM_TITLE_TYPE_FONT
        } else {
            0.0
        }
}

/// 片场标题面板的纯布局：面板矩形、标题行与类型标记行的文案与落点。
///
/// 面板浮在范围顶部与**模型内容包围盒**顶部较高者之上、水平居中于内容包围盒（不落在平行
/// 四边形内部，也不遮住模型身体）；文案优先按内容宽度有界省略，但保留可读下限（面板可宽于很
/// 小的地面范围）。第二行是节点业务类型名
/// （`GraphNode.type_label`，如「片场」「游戏炼丹炉」，由映射层按可信 adapter 身份派生），
/// 缺失时只画标题行。绘制（`canvas2d::film_set`）与测试共用本函数；显隐仍由 hover/选中决定
/// （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D7 修订）。
pub(crate) struct FilmTitleLayout {
    /// 截断后的标题文案。
    pub(crate) title: String,
    /// 截断后的业务类型名（空即不绘制第二行）。
    pub(crate) type_label: String,
    /// 面板矩形 `(x, y, width, height)`。
    pub(crate) chip: (f32, f32, f32, f32),
    /// 标题行左上落点。
    pub(crate) title_pos: Vec2,
    /// 类型标记行左上落点。
    pub(crate) type_pos: Vec2,
}

pub(crate) fn film_title_layout(node: &GraphNode) -> FilmTitleLayout {
    let scope = super::scope::node_scope(node);
    let aabb = scope.aabb;
    // 文案可用宽度：优先与模型内容包围盒等宽（减去左右内边距），无内容时回落到范围宽度；
    // 不低于可读下限，避免小地面把标题压成「…」。
    let content = scope.content;
    let available_width = content.map(|bounds| bounds.width).unwrap_or(aabb.width);
    let max_text = (available_width - FILM_TITLE_CHIP_PAD * 2.0).max(FILM_TITLE_MIN_TEXT_WIDTH);
    let title = shortened(&node.title, max_text, FILM_TITLE_FONT);
    let raw_type = node.type_label.trim();
    let type_label = shortened(raw_type, max_text, FILM_TITLE_TYPE_FONT);
    let has_type = !type_label.is_empty();
    let chip_width = (estimated_text_width(&title, FILM_TITLE_FONT)
        .max(estimated_text_width(&type_label, FILM_TITLE_TYPE_FONT))
        + FILM_TITLE_CHIP_PAD * 2.0)
        .max(FILM_TITLE_MIN_WIDTH);
    let chip_height = film_title_chip_height(has_type);
    // 浮在范围顶部与模型内容包围盒顶部**较高者**之上：小地面 + 高模型时标题不再压住模型
    // 身体；平铺内容时仍保持在范围顶部之上。水平居中于内容包围盒（无内容时居中于范围）。
    let anchor_top = content.map(|bounds| bounds.y).unwrap_or(aabb.y).min(aabb.y);
    let chip_bottom = anchor_top - FILM_TITLE_GAP;
    let chip_top = chip_bottom - chip_height;
    let center_x = content
        .map(|bounds| bounds.x + bounds.width / 2.0)
        .unwrap_or(aabb.x + aabb.width / 2.0);
    let chip_left = center_x - chip_width / 2.0;
    let title_pos = Vec2::new(chip_left + FILM_TITLE_CHIP_PAD, chip_top + FILM_TITLE_VPAD);
    let type_pos = Vec2::new(
        title_pos.x,
        title_pos.y + FILM_TITLE_FONT + FILM_TITLE_LINE_GAP,
    );
    FilmTitleLayout {
        title,
        type_label,
        chip: (chip_left, chip_top, chip_width, chip_height),
        title_pos,
        type_pos,
    }
}

/// 主 2D 覆盖层相机在聚焦/预览时是否可见。
///
/// 片场标题、虚线框与编辑抓手只由 2D 覆盖层相机绘制
/// （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。聚焦镜头预览、
/// 截图、离屏历史预览与视频导出都切换为透视聚焦相机并停用这张 2D 相机，因此成片结构上
/// 不会包含标题或编辑工具。放在 host 可编译的纯模块，便于直接测试该不变量。
pub(crate) fn overlay_camera2d_active(focused: bool) -> bool {
    !focused
}

/// 标签实体池的纯生命周期规划：给定已有数量与期望数量，返回
/// `(需原地更新数量, 需补建数量, 需回收数量, 是否保留池条目)`。
///
/// 这是片场标题 `0 → 1 → 0 → 1` 反复显隐的核心不变量（change:
/// 2026-10-10-improve-film-set-editing-and-inspector，design D2）：
/// - 期望为空时 `retain == false`，池条目被移除，使下一次期望非空可以从零补建；
/// - 只 zip 已存在实体（旧实现）会让「先隐藏再显示」丢字，这里显式建模并测试。
pub(crate) fn label_pool_plan(existing: usize, desired: usize) -> (usize, usize, usize, bool) {
    (
        existing.min(desired),
        desired.saturating_sub(existing),
        existing.saturating_sub(desired),
        desired > 0,
    )
}

/// 按估算宽度截断文本；超出时追加省略号，控制字符替换为空格。
pub(crate) fn shortened(text: &str, max_width: f32, size: f32) -> String {
    let mut width = 0.0;
    let mut result = String::new();
    for c in text.chars() {
        width += estimated_char_width(c, size);
        if width > max_width - size {
            result.push('…');
            break;
        }
        result.push(if c.is_control() { ' ' } else { c });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    mod film_title;

    fn node(width: f32, height: f32) -> GraphNode {
        GraphNode {
            model_preview: None,
            id: "n".into(),
            kind: "text".into(),
            x: 10.0,
            y: 20.0,
            width,
            height,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            group: None,
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
        shot_preview: None,
        }
    }

    fn kind_node(kind: &str, width: f32, height: f32, busy: bool) -> GraphNode {
        GraphNode {
            kind: kind.into(),
            busy,
            ..node(width, height)
        }
    }

    #[test]
    fn ring_gate_covers_compact_and_pure_model_nodes() {
        // 富内容图片节点。
        assert!(shows_generation_ring(&kind_node("image", 248.0, 232.0, true)));
        // 紧凑节点（<=116 高）此前被 shows_content 门禁漏掉。
        assert!(shows_generation_ring(&kind_node("image", 196.0, 64.0, true)));
        // 纯模型节点（无 model_preview）此前被 shows_content 漏掉。
        assert!(shows_generation_ring(&kind_node("model", 196.0, 64.0, true)));
        // 非 busy 不显示。
        assert!(!shows_generation_ring(&kind_node("image", 248.0, 232.0, false)));
    }

    #[test]
    fn ring_gate_excludes_aggregate_and_group() {
        // 复合资产（片场）用运行遮罩而非进度环。
        let mut film = kind_node("model", 260.0, 195.0, true);
        film.composite_asset = Some(crate::protocol::CompositeAssetPresentation { panel: None, ownership_links: None, root_placement: None, content_extent: None,
            layout_aabb: None,
            geometry_quality: None,
            scope_shape: crate::protocol::CompositeAssetScopeShape::Rect,
            scope_ground: None,
            x: 0.0,
            y: 0.0,
            width: 260.0,
            height: 195.0,
            media: Vec::new(),
            item_roots: std::collections::HashMap::new(),
            item_placements: std::collections::HashMap::new(),
        });
        assert!(!shows_generation_ring(&film));
        // group 无进度环。
        let mut group = kind_node("group", 400.0, 300.0, true);
        group.group = Some(crate::protocol::GroupPresentation {
            title: String::new(),
            member_count: 1,
            output_capable_leaf_count: 1,
            run_status: None,
        });
        assert!(!shows_generation_ring(&group));
    }

    #[test]
    fn ring_rect_uses_compact_inset_for_compact_nodes() {
        // node() 位于 (10,20)；紧凑节点按 6px 内缩。
        let (x, y, w, h) = generation_ring_rect(&kind_node("model", 196.0, 64.0, true));
        assert_eq!((x, y), (16.0, 26.0));
        assert_eq!((w, h), (184.0, 52.0));
    }

    #[test]
    fn history_dots_are_centered_inside_node_bottom() {
        let (sx, sy, sw, sh) = history_strip_rect(0.0, 0.0, 248.0, 232.0);
        assert_eq!((sx, sy, sw, sh), (24.0, 212.0, 200.0, 16.0));
        let first = history_strip_dot(0.0, 0.0, 248.0, 232.0, 0, 3);
        let last = history_strip_dot(0.0, 0.0, 248.0, 232.0, 2, 3);
        assert_eq!(first, Vec2::new(112.0, 220.0));
        assert_eq!(last, Vec2::new(136.0, 220.0));
        assert!(sx + sw <= 248.0 - RESIZE_HANDLE_SIZE);
    }

    #[test]
    fn content_rect_fills_to_uniform_padding() {
        // 状态文案已移除：内容区不再为底部状态行预留 42px，而是延伸到底部内缘，
        // 与左右 16px 内边距对称（change: add-node-running-progress）。
        let (x, y, w, h) = content_rect(&node(224.0, 300.0));
        assert_eq!((x, y), (26.0, 72.0));
        assert_eq!(w, 192.0);
        assert_eq!(h, 232.0);
        // 内容区底边 = 节点底边 - 16px。
        assert_eq!(y + h, 72.0 + 232.0);
    }

    #[test]
    fn content_rect_clamps_tiny_nodes() {
        let (_, _, w, h) = content_rect(&node(10.0, 10.0));
        assert_eq!(w, 1.0);
        assert_eq!(h, 24.0);
    }

    #[test]
    fn texture_contain_preserves_aspect() {
        let size = texture_size(&node(224.0, 300.0), Vec2::new(400.0, 100.0));
        assert!((size.x / size.y - 4.0).abs() < 1e-4);
        assert!(size.x <= 192.0 + 1e-4);
    }

    #[test]
    fn port_sides() {
        assert_eq!(port(&node(224.0, 100.0), false), Vec2::new(10.0, 70.0));
        assert_eq!(port(&node(224.0, 100.0), true), Vec2::new(234.0, 70.0));
    }

    #[test]
    fn shortened_handles_ascii_cjk_and_controls() {
        assert_eq!(shortened("abc", 100.0, 12.0), "abc");
        assert_eq!(shortened("中\u{0007}文", 100.0, 12.0), "中 文");
        assert!(shortened(&"宽".repeat(50), 40.0, 12.0).ends_with('…'));
    }

    #[test]
    fn overlay_camera2d_hidden_during_focus_keeps_titles_out_of_final_cut() {
        // 片场标题/虚线/抓手只由 2D 覆盖层绘制；聚焦与预览（截图/离屏历史/视频导出）都
        // 进入 focused 状态，此时 2D 相机必须停用，成片结构上不含标题
        // （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。
        assert!(!overlay_camera2d_active(true));
        assert!(overlay_camera2d_active(false));
    }

    #[test]
    fn label_pool_plan_supports_toggle_and_resize() {
        // 首次显示：无实体、需补建 1、不保留空池。
        assert_eq!(label_pool_plan(0, 1), (0, 1, 0, true));
        // 隐藏：回收 1、不保留（下次可重建）。
        assert_eq!(label_pool_plan(1, 0), (0, 0, 1, false));
        // 再次显示：仍然从零补建（0→1→0→1 的关键）。
        assert_eq!(label_pool_plan(0, 1), (0, 1, 0, true));
        // 卡片正文缩减/增长：更新重叠、回收多余、补建不足。
        assert_eq!(label_pool_plan(6, 2), (2, 0, 4, true));
        assert_eq!(label_pool_plan(2, 6), (2, 4, 0, true));
        // 长按/稳定：数量一致只原地更新。
        assert_eq!(label_pool_plan(3, 3), (3, 0, 0, true));
    }

    fn action_node(x: f32, y: f32) -> GraphNode {
        GraphNode {
            model_preview: None,
            id: "n1".into(),
            kind: "image".into(),
            x,
            y,
            width: 200.0,
            height: 120.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            group: None,
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
        shot_preview: None,
        }
    }

    fn action_list(summary: Option<&str>) -> crate::protocol::NodeActions {
        crate::protocol::NodeActions {
            actions: vec![
                crate::protocol::NodeAction {
                    id: "download".into(),
                    label: "下载".into(),
                    enabled: true,
                    menu: false,
                    ..Default::default()
                },
                crate::protocol::NodeAction {
                    id: "convert".into(),
                    label: "转为片场".into(),
                    enabled: true,
                    menu: true,
                    ..Default::default()
                },
            ],
            summary: summary.map(str::to_owned),
        }
    }

    #[test]
    fn node_action_toolbar_is_centered_above_with_fixed_gap() {
        let node = action_node(500.0, 300.0);
        let layout = node_action_toolbar(&node, &action_list(None), None, None).expect("layout");
        // 底边 = 节点顶边 - GAP；水平居中于节点。
        assert!((layout.bar.1 + layout.bar.3 - (node.y - NODE_ACTION_TOOLBAR_GAP)).abs() < 1e-3);
        assert!(
            (layout.bar.0 + layout.bar.2 / 2.0 - (node.x + node.width / 2.0)).abs() < 1e-3
        );
        assert!(!layout.below);
    }

    #[test]
    fn node_action_toolbar_actions_do_not_overlap_and_chevron_follows_menu() {
        let node = action_node(500.0, 300.0);
        let layout = node_action_toolbar(&node, &action_list(Some("gpt-5")), None, None).expect("layout");
        assert_eq!(layout.slots.len(), 2);
        let first = layout.slots[0].rect;
        let second = layout.slots[1].rect;
        assert!(second.0 >= first.0 + first.2);
        let chevron = layout.slots[1].menu.expect("chevron");
        assert!(chevron.0 >= second.0 + second.2);
        let (_, summary) = layout.summary.as_ref().expect("summary");
        assert!(summary.0 >= chevron.0 + chevron.2);
        assert!(summary.0 + summary.2 <= layout.bar.0 + layout.bar.2 + 1e-3);
    }

    #[test]
    fn node_action_toolbar_falls_below_when_no_room_above() {
        let node = action_node(500.0, 0.0);
        let layout =
            node_action_toolbar(&node, &action_list(None), Some((0.0, 0.0, 1.0)), Some((1000.0, 800.0)))
                .expect("layout");
        assert!(layout.below);
        assert!((layout.bar.1 - (node.y + node.height + NODE_ACTION_TOOLBAR_GAP)).abs() < 1e-3);
    }

    #[test]
    fn node_action_toolbar_empty_actions_is_none() {
        let node = action_node(500.0, 300.0);
        let empty = crate::protocol::NodeActions {
            actions: Vec::new(),
            summary: None,
        };
        assert!(node_action_toolbar(&node, &empty, None, None).is_none());
    }

    #[test]
    fn node_action_toolbar_summary_is_truncated_to_max_width() {
        let node = action_node(500.0, 300.0);
        let long = "一个非常非常非常非常非常非常非常非常长的模型名称";
        let layout = node_action_toolbar(&node, &action_list(Some(long)), None, None).expect("layout");
        let (text, rect) = layout.summary.as_ref().expect("summary");
        assert!(text.ends_with('…'));
        assert!(rect.2 <= NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH + 1e-3);
    }
}
