//! Ordinary card drawing. Groups and film scopes keep their shared overlay order.
use super::layout::{port, shortened, shows_content};
use super::{geometry::Geometry, labels::Label};
use crate::{
    protocol::{GraphNode, NodeHover},
    theme::ThemeResource,
};
use bevy::prelude::*;

/// 拍摄镜头预览卡片正文与装饰
/// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D8）。
///
/// 预览节点复用普通卡片外壳（标题/类型已在映射层投影为镜头名/静态·动态），但内容区改为
/// **实时取景窗口**：GPU Sprite 由 `shot_node_preview` 摆放，这里只画标题区与状态承载面。
/// 只显示状态文案（准备中/待更新/失败），不绘制播放按钮或进度条。
/// `ready` 且无诊断时不覆盖内容面（交给实时画面）。
pub(super) fn draw_shot_preview(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    let z = 10.0 + index as f32 * 0.1 + 0.004;
    let (cx, cy, cw, ch) = super::shot_preview::content_rect_of(node);
    // 内容承载面：实时画面尚未就绪/待更新/失败时用主题内容底衬，保证状态文案可辨认。
    geometry.rounded_rect(cx, cy, cw, ch, 3., z, theme.token_u32("canvasNodeContent"));
    let mut labels = Vec::new();
    // 状态文案：`ready` 且无诊断时返回空串（不覆盖实时画面），否则在内容区上沿展示。
    let status = super::shot_preview::status_text(node, &shortened);
    if !status.is_empty() {
        labels.push((
            status,
            Vec2::new(cx + 12.0, cy + 10.0),
            12.0,
            theme.token_u32("canvasBodyText"),
        ));
    }
    labels
}

pub(super) fn draw_static(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    if node.kind.starts_with("focus-reference") {
        return super::focus_reference::draw(geometry, theme, node, index);
    }
    // 便签整体换一套画法：没有内容区/种类符号/标题行，只画一张纸和正文。
    // 必须先于 `compact_card` 判断 —— 便签缩到很小时也该保持便签的样子，不能退化成小卡片。
    if node.kind == "sticky" {
        return super::sticky_note::draw(geometry, theme, node, index);
    }
    if super::layout::compact_card(node) {
        return super::compact_card::draw(geometry, theme, node, index);
    }
    let (_, _tint, _category) = theme.node_palette(&node.kind);
    let (x, y, z) = (node.x, node.y, 10.0 + index as f32 * 0.1);
    let (width, height) = (node.width, node.height);
    let show_content = shows_content(node);
    geometry.rounded_rect(
        x,
        y + 3.,
        width,
        height,
        8.,
        z + 0.001,
        theme.token_u32("canvasNodeShadow"),
    );
    geometry.rounded_rect(
        x,
        y,
        width,
        height,
        8.,
        z + 0.002,
        theme.token_u32("canvasNodeBorder"),
    );
    let border = 1.0;
    geometry.rounded_rect(
        x + border,
        y + border,
        width - border * 2.,
        height - border * 2.,
        7.,
        z + 0.003,
        theme.token_u32("canvasNodeSurface"),
    );
    if show_content && !super::shot_preview::is_shot_preview_node(node) {
        let (cx, cy, cw, ch) = super::layout::content_rect(node);
        geometry.rounded_rect(
            cx,
            cy,
            cw,
            ch,
            3.,
            z + 0.004,
            theme.token_u32("canvasNodeContent"),
        );
        // 运行中节点的进度环由 `generation::sync_generation` 每帧绘制在内容面上；
        // 这里不再画底部状态行、进度条或静态进度环。
    }
    // 名称与尺寸不再画在卡片内部：选中/悬停时画在卡片上方外侧（见 `card_meta`）。
    // 卡片本身只留四边等宽窄边 + 内容，图片因此能铺满整张卡。
    let mut labels: Vec<Label> = Vec::new();
    if super::shot_preview::is_shot_preview_node(node) {
        labels.extend(draw_shot_preview(geometry, theme, node, index));
        return labels;
    }
    // 正文画在内容区内部（标题行已移到卡片底部，不再占用顶部）。
    let (bcx, bcy, bcw, _bch) = super::layout::content_rect(node);
    // 换行宽度取内容区实际宽度（main 的 wrapped_lines + sixi 的窄内边距）：
    // 先用满可用宽度换行，超过 6 行才在最后一行省略，而不是一行提前截断。
    let body_lines = super::layout::wrapped_lines(&node.body, (bcw - 16.).max(1.), 12., 6);
    for i in 0..6 {
        labels.push((
            if show_content
                && !node.texture
                && !node.busy
                && !(node.model_preview.is_some() && node.model.is_some())
            {
                // 已在 `wrapped_lines` 里换行并截断，这里原样取用。
                body_lines.get(i).cloned().unwrap_or_default()
            } else {
                String::new()
            },
            Vec2::new(bcx + 8., bcy + 4. + i as f32 * 18.),
            12.,
            theme.token_u32("canvasBodyText"),
        ));
    }
    labels
}

/// Produce the card geometry input. Kept as a separate entry point so cache producers can
/// invalidate mesh blocks independently from label requests.
pub(super) fn geometry(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) {
    let _ = draw_static(geometry, theme, node, index);
}

/// Produce only label requests for a card. The temporary geometry sink preserves the existing
/// layout helpers while keeping label refreshes out of the GPU mesh replacement path.
pub(super) fn labels(theme: &ThemeResource, node: &GraphNode, index: usize) -> Vec<Label> {
    draw_static(&mut Geometry::default(), theme, node, index)
}

/// 悬停端点半钮（非选中态装饰）。持久选中描边由 selection producer 生产。
pub(super) fn draw_hover_ports(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    hover: Option<&NodeHover>,
    index: usize,
) {
    // 便签不连线，悬停时也不该冒出接线端点 —— 那是"可以拉线"的暗示，会误导用户去拖。
    // 与 `bevyKindHasInput/HasOutput` 对 sticky 返回 false 是同一条规则的两层落点。
    if node.kind == "sticky" {
        return;
    }
    let (accent, _, _) = theme.node_palette(&node.kind);
    let (_, _, z) = (node.x, node.y, 10.0 + index as f32 * 0.1);
    // 端点：静止时 MUST NOT 绘制常驻图形；仅指针悬停该节点时在左右中点显示「+」圆钮
    // （change: add-node-endpoint-hover）。指针落在某侧端点命中区时该侧用节点强调色。
    if let Some(hover) = hover.filter(|hover| hover.node_id.as_deref() == Some(node.id.as_str())) {
        let hovered_port = hover.port.as_deref();
        for (output, side) in [(false, "input"), (true, "output")] {
            let p = port(node, output);
            let ring = if hovered_port == Some(side) {
                accent
            } else {
                theme.token_u32("canvasPortDefault")
            };
            // 圆钮面 + 描边环（外径 12 ≈ 参考实现 24px 直径）。
            geometry.circle(p, 12.0, z + 0.006, theme.token_u32("canvasNodeSurface"), 28);
            geometry.ring(p, 11.0, 2.0, z + 0.007, ring, 28);
            // 「+」字形：两条正交短线。
            geometry.line(p - Vec2::X * 5.5, p + Vec2::X * 5.5, 1.8, z + 0.008, ring);
            geometry.line(p - Vec2::Y * 5.5, p + Vec2::Y * 5.5, 1.8, z + 0.008, ring);
        }
    }
}

/// 普通卡片的持久选中描边 producer 几何：外发光、选中边框/面与 resize 抓手。
///
/// 与 `draw_hover_ports` 分离后，selection producer 只按 `CanvasSelection` 查询写入
/// `SelectionOutlineBatch`，不再要求卡片装饰块随选中状态重建。
pub(crate) fn draw_selection_outline(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) {
    // 便签有自己的一套选中描边：它是倾斜的圆角纸片，套用卡片的轴对齐外框 +
    // 卡片底色内层（白面）会露出一圈白边、且与纸的角度对不齐。
    if node.kind == "sticky" {
        super::sticky_note::draw_selection_outline(geometry, theme, node, index);
        return;
    }
    let (x, y, z) = (node.x, node.y, 10.0 + index as f32 * 0.1);
    let (width, height) = (node.width, node.height);
    geometry.rounded_rect(
        x - 4.,
        y - 4.,
        width + 8.,
        height + 8.,
        11.,
        z,
        theme.token_u32("canvasNodeSelectedHalo"),
    );
    // Cover the normal rim while staying below static icons/content and media.
    geometry.rounded_rect(
        x,
        y,
        width,
        height,
        8.,
        z + 0.0031,
        theme.token_u32("canvasNodeBorderSelected"),
    );
    let border = 1.7;
    geometry.rounded_rect(
        x + border,
        y + border,
        width - border * 2.,
        height - border * 2.,
        7.,
        z + 0.0032,
        theme.token_u32("canvasNodeSurface"),
    );
    if node.resizable {
        draw_resize_grip(geometry, theme, node, z + 0.005);
    }
}

#[cfg(test)]
pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    hover: Option<&NodeHover>,
    index: usize,
) -> Vec<Label> {
    let labels = draw_static(geometry, theme, node, index);
    if selected {
        draw_selection_outline(geometry, theme, node, index);
    }
    draw_hover_ports(geometry, theme, node, hover, index);
    labels
}

/// Shared rectangle grip; interaction uses the same layout::resize_rect.
pub(super) fn draw_resize_grip(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let (x, y, w, h) = super::layout::resize_rect(node.x, node.y, node.width, node.height);
    super::film_set::draw_scope_grip(
        geometry,
        theme,
        &super::scope::ScopeGrip::Rect(super::scope::ScopeRect {
            x,
            y,
            width: w,
            height: h,
        }),
        z,
    );
}
