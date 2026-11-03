//! 非卡片画布外壳：2D 组包围框与世界对象的“无外壳”语义。
//!
//! Render Scene v38 的 `node.chrome` 把「节点身份」和「内容卡片」拆开：
//! - `frame`：2D 组只画包围成员的框和标题，不画内容底；
//! - `none`：共享世界实例只保留世界对象与选择身份，Bevy 不在这里画任何卡片。
//!
//! 这里只产生画布几何，不改变交互快照：节点矩形仍参与选择/动作命中，3D 世界对象的
//! 拾取由 `model3d::pick` 的可见表面负责。

use super::geometry::Geometry;
use super::labels::Label;
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;
use bevy::prelude::*;

/// 2D 组框的标题与边框（idle）。
pub(super) fn draw_frame(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
    selected: bool,
) -> Vec<Label> {
    let (x, y, z) = (node.x, node.y, 10.0 + index as f32 * 0.1);
    let (width, height) = (node.width, node.height);
    let color = if selected {
        theme.token_u32("canvasNodeBorderSelected")
    } else {
        theme.token_u32("canvasNodeBorder")
    };
    let line = if selected { 2.4 } else { 1.2 };
    // 只描边，不填内容底：成员卡片/世界对象必须保持原样可见。
    geometry.line(Vec2::new(x, y), Vec2::new(x + width, y), line, z, color);
    geometry.line(
        Vec2::new(x + width, y),
        Vec2::new(x + width, y + height),
        line,
        z,
        color,
    );
    geometry.line(
        Vec2::new(x + width, y + height),
        Vec2::new(x, y + height),
        line,
        z,
        color,
    );
    geometry.line(Vec2::new(x, y + height), Vec2::new(x, y), line, z, color);
    if selected {
        // 选中时补一层低对比内虚线感外框；仍不覆盖成员。
        let inset = 4.0;
        geometry.line(
            Vec2::new(x + inset, y + inset),
            Vec2::new(x + width - inset, y + inset),
            1.0,
            z + 0.0001,
            theme.token_u32("canvasNodeSelectedHalo"),
        );
        geometry.line(
            Vec2::new(x + inset, y + height - inset),
            Vec2::new(x + width - inset, y + height - inset),
            1.0,
            z + 0.0001,
            theme.token_u32("canvasNodeSelectedHalo"),
        );
    }
    let title = if node.title.is_empty() {
        node.card_label.clone().unwrap_or_else(|| "2D 组".to_owned())
    } else {
        node.title.clone()
    };
    // 标题放在框上方，避免遮住成员卡片；宽度只限制单行省略。
    vec![(
        shortened(&title, (width - 16.0).max(48.0)),
        Vec2::new(x, (y - 22.0).max(0.0)),
        12.0,
        theme.token_u32("interactionAccent"),
    )]
}

/// 2D 组框的选中/悬停描边。普通卡片仍走 `cards::draw_selection_outline`。
pub(super) fn draw_frame_selection(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) {
    let (x, y, z) = (node.x, node.y, 10.0 + index as f32 * 0.1 + 0.0031);
    let (width, height) = (node.width, node.height);
    let color = theme.token_u32("canvasNodeBorderSelected");
    for (a, b) in [
        (Vec2::new(x, y), Vec2::new(x + width, y)),
        (Vec2::new(x + width, y), Vec2::new(x + width, y + height)),
        (
            Vec2::new(x + width, y + height),
            Vec2::new(x, y + height),
        ),
        (Vec2::new(x, y + height), Vec2::new(x, y)),
    ] {
        geometry.line(a, b, 2.4, z, color);
    }
}

/// 单行字符截断（按逻辑字号近似），与卡片标题保持同一视觉密度。
fn shortened(text: &str, max_width: f32) -> String {
    let max_chars = (max_width / 12.0).max(1.0) as usize;
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars.saturating_sub(1) {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::NodeChrome;

    fn node(chrome: NodeChrome) -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "g", "type": "workflow-group-2d", "x": 10.0, "y": 20.0,
            "width": 200.0, "height": 120.0,
            "chrome": match &chrome {
                NodeChrome::Card => serde_json::json!({"kind":"card"}),
                NodeChrome::Frame { group_id, member_node_ids } => serde_json::json!({
                    "kind": "frame", "groupId": group_id, "memberNodeIds": member_node_ids,
                }),
                NodeChrome::None => serde_json::json!({"kind":"none"}),
            }
        }))
        .unwrap()
    }

    fn is_offscreen_fallback(geometry: Geometry) -> bool {
        use bevy::render::mesh::VertexAttributeValues;
        let mesh = geometry.build();
        let Some(VertexAttributeValues::Float32x3(positions)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            return false;
        };
        !positions.is_empty() && positions.iter().all(|position| position[0] < -1000.0)
    }

    #[test]
    fn none_chrome_suppresses_content_card() {
        let theme = ThemeResource::default();
        let node = node(NodeChrome::None);
        let mut geometry = Geometry::default();
        let labels = super::super::cards::draw_static(&mut geometry, &theme, &node, 0);
        assert!(is_offscreen_fallback(geometry));
        assert!(labels.is_empty());
        let mut selection = Geometry::default();
        super::super::cards::draw_selection_outline(&mut selection, &theme, &node, 0);
        assert!(is_offscreen_fallback(selection));
    }

    #[test]
    fn frame_draws_border_and_title_without_fill() {
        let theme = ThemeResource::default();
        let node = node(NodeChrome::Frame {
            group_id: "group".into(),
            member_node_ids: vec!["a".into()],
        });
        let mut geometry = Geometry::default();
        let labels = draw_frame(&mut geometry, &theme, &node, 0, false);
        assert!(geometry.build().count_vertices() > 0);
        assert!(labels.iter().any(|(text, ..)| !text.is_empty()));
    }
}
