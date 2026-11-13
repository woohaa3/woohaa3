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
    // 正文优先用满预览区宽度换行，行数由卡片实际高度派生；只有超出预算才在末行省略。
    // 历史失败/取消原因尤其依赖这条路径，否则 240 字的报错只剩第一行。
    let body_lines = if show_content && !node.texture && !node.busy {
        super::layout::wrapped_lines(
            &node.body,
            width - 48.,
            12.,
            super::layout::body_line_budget(height),
        )
    } else {
        Vec::new()
    };
    for i in 0..super::layout::BODY_MAX_LINES {
        labels.push((
            body_lines.get(i).cloned().unwrap_or_default(),
            Vec2::new(x + 24., y + 56. + i as f32 * 18.),
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

/// 四角 L 形 resize 抓手；交互复用同一 `canvas_query::grip::ResizeGrip` 命中区域。
pub(super) fn draw_resize_grip(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let grips = crate::canvas_query::grip::ResizeGrip::all_for_bounds(
        node.x, node.y, node.width, node.height,
    );
    let color = theme.token_u32("canvasResizeHandle");
    for grip in grips {
        let (sx, sy) = match grip.handle {
            "nw" => (1.0, 1.0),
            "ne" => (-1.0, 1.0),
            "sw" => (1.0, -1.0),
            _ => (-1.0, -1.0),
        };
        let corner = match grip.handle {
            "nw" => Vec2::new(node.x, node.y),
            "ne" => Vec2::new(node.x + node.width, node.y),
            "sw" => Vec2::new(node.x, node.y + node.height),
            _ => Vec2::new(node.x + node.width, node.y + node.height),
        };
        let inset = Vec2::new(sx * 3.0, sy * 3.0);
        let start = corner + inset;
        geometry.line(start, start + Vec2::X * sx * 10.0, 3.0, z, color);
        geometry.line(start, start + Vec2::Y * sy * 10.0, 3.0, z, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(body: &str, width: f32, height: f32) -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "n", "type": "text", "x": 0, "y": 0,
            "width": width, "height": height,
            "title": "节点", "body": body
        }))
        .unwrap()
    }

    /// 卡片正文按预览区宽度换行：历史失败/取消原因不能被单行截断。
    #[test]
    fn long_failure_reason_wraps_into_multiple_body_lines() {
        let node = card(&format!("失败：{}", "模型调用超时并重试失败".repeat(12)), 248.0, 232.0);
        let labels = super::draw_static(
            &mut Geometry::default(),
            &ThemeResource::default(),
            &node,
            0,
        );
        let body: Vec<&str> = labels
            .iter()
            .map(|label| label.0.as_str())
            .filter(|text| !text.is_empty() && (text.contains("失败：") || text.contains("模型调用超时")))
            .collect();
        assert!(
            body.len() > 1,
            "长报错必须换行，实际只有 {} 行：{:?}",
            body.len(),
            body
        );
        assert!(body[0].contains("失败："));
        // 每行都不超过正文可用宽度（width - 48）。
        for line in &body {
            assert!(
                crate::canvas_query::layout::estimated_text_width(line, 12.0) <= 200.0 + 12.0,
                "行超宽：{line}"
            );
        }
    }

    /// 正文为空时不产生可见正文行（槽位仍存在但不显示文字）。
    #[test]
    fn empty_body_produces_no_visible_body_lines() {
        let node = card("", 248.0, 232.0);
        let labels = super::draw_static(
            &mut Geometry::default(),
            &ThemeResource::default(),
            &node,
            0,
        );
        assert!(labels.iter().skip(2).all(|label| label.0.is_empty()));
    }
}

