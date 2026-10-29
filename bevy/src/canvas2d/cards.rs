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
    if super::layout::compact_card(node) {
        return super::compact_card::draw(geometry, theme, node, index);
    }
    let (accent, tint, category) = theme.node_palette(&node.kind);
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
    geometry.rounded_rect(x + 14., y + 12., 28., 28., 6., z + 0.004, tint);
    geometry.icon(&node.kind, Vec2::new(x + 28., y + 26.), z + 0.005, accent);
    // 卡片“×”删除入口已移除（change: 2026-10-09-improve-canvas-workflow，任务 1.7）：
    // 删除只经“删除作品”菜单与键盘 Delete/Backspace，避免误删与语义歧义。
    // 历史动作图标已移除（迁移到节点下方独立历史条，
    // change: 2026-10-12-unify-generation-history-strip，design D4）；
    // 下载入口也移出卡片（迁移到节点顶部 Bevy 横条，
    // change: 2026-10-13-add-node-to-film-set-shortcut）。
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
    // 主标题与类型小标记独立布局（change: 2026-10-09-improve-canvas-workflow，任务 2.2）：
    // 作品名称优先、类型退居次要；先给历史/下载控件留空间再截断主标题。
    // 顶部图标占 x+14..x+42，历史/下载控件占右侧约 62px，因此标题可用宽度 = width - 112。
    let fallback_label = node
        .card_label
        .clone()
        .unwrap_or_else(|| category.to_owned());
    let title_text = if node.title.is_empty() {
        fallback_label.clone()
    } else {
        node.title.clone()
    };
    let title_width = (width - 112.).max(48.);
    let mut labels = vec![(
        shortened(&title_text, title_width, 12.),
        Vec2::new(x + 50., y + 17.),
        12.,
        accent,
    )];
    // 类型小标记：主标题下方的次要信息，缺省（旧帧）时不绘制。
    if !node.type_label.is_empty() {
        labels.push((
            shortened(&node.type_label, width - 112., 10.),
            Vec2::new(x + 50., y + 34.),
            10.,
            theme.token_u32("canvasCloseIcon"),
        ));
    }
    if super::shot_preview::is_shot_preview_node(node) {
        labels.extend(draw_shot_preview(geometry, theme, node, index));
        return labels;
    }
    let body_lines: Vec<&str> = node.body.lines().collect();
    for i in 0..6 {
        labels.push((
            if show_content
                && !node.texture
                && !node.busy
                && !(node.model_preview.is_some() && node.model.is_some())
            {
                shortened(body_lines.get(i).unwrap_or(&""), width - 48., 12.)
            } else {
                String::new()
            },
            Vec2::new(x + 24., y + 56. + i as f32 * 18.),
            12.,
            theme.token_u32("canvasBodyText"),
        ));
    }
    labels
}

/// 悬停端点半钮（非选中态装饰）。持久选中描边由 selection producer 生产。
pub(super) fn draw_hover_ports(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    hover: Option<&NodeHover>,
    index: usize,
) {
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
