//! Ordinary card drawing.
use super::layout::{port, shortened, shows_content};
use super::{geometry::Geometry, labels::Label};
use crate::{
    protocol::{GraphNode, NodeChrome, NodeHover},
    theme::ThemeResource,
};
use bevy::prelude::*;

pub(super) fn draw_static(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    if node.kind.starts_with("focus-reference") {
        return super::focus_reference::draw(geometry, theme, node, index);
    }
    match &node.chrome {
        NodeChrome::Card => {}
        NodeChrome::Frame { .. } => {
            // Scope chrome is drawn once in the shared overlay, including hover/selection.
            return Vec::new();
        }
        NodeChrome::None => return Vec::new(),
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
    if show_content {
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
    // 正文画在内容区内部。
    let (bcx, bcy, bcw, _bch) = super::layout::content_rect(node);
    let body_lines: Vec<&str> = node.body.lines().collect();
    for i in 0..6 {
        labels.push((
            if show_content
                && !node.texture
                && !node.busy
                && !(node.model_preview.is_some() && node.model.is_some())
            {
                shortened(body_lines.get(i).unwrap_or(&""), (bcw - 16.).max(1.), 12.)
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
    if !node.chrome.is_card() {
        return;
    }
    let (accent, _, _) = theme.node_palette(&node.kind);
    let (_, _, z) = (node.x, node.y, 10.0 + index as f32 * 0.1);
    // 端点：静止时 MUST NOT 绘制常驻图形；仅指针悬停该节点时在左右中点显示「+」圆钮
    // （change: add-node-endpoint-hover）。指针落在某侧端点命中区时该侧用节点强调色。
    if let Some(hover) = hover.filter(|hover| hover.node_id.as_deref() == Some(node.id.as_str())) {
        let hovered_port = hover.port.as_deref();
        for (output, side) in [(false, "input"), (true, "output")] {
            let p =
                crate::canvas_query::layout::magnetic_port_center(port(node, output), hover, side);
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
    match &node.chrome {
        NodeChrome::Card => {}
        NodeChrome::Frame { .. } => {
            // Scope overlay owns the single rounded contour for all interaction states.
            return;
        }
        NodeChrome::None => return,
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

/// 右下角矩形 resize 抓手；交互复用同一 `canvas_query::grip::ResizeGrip`。
pub(super) fn draw_resize_grip(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let grip =
        crate::canvas_query::grip::ResizeGrip::for_bounds(node.x, node.y, node.width, node.height);
    let color = theme.token_u32("canvasResizeHandle");
    geometry.rounded_rect(grip.x, grip.y, grip.width, grip.height, 2.0, z, color);
}
