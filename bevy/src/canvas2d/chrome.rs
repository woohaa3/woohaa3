//! 非卡片画布外壳：2D 组包围框与世界对象的“无外壳”语义。
//!
//! Render Scene v38 的 `node.chrome` 把「节点身份」和「内容卡片」拆开：
//! - `frame`：2D 组绘制包围成员的圆角框、轻薄背板与共享名称标签；
//! - `none`：共享世界实例只保留世界对象与选择身份，Bevy 不在这里画任何卡片。
//!
//! 这里只产生画布几何，不改变交互快照：节点矩形仍参与选择/动作命中，3D 世界对象的
//! 拾取由 `model3d::pick` 的可见表面负责。

use super::geometry::Geometry;
use super::labels::Label;
use crate::protocol::GraphNode;
use crate::theme::ThemeResource;
use bevy::prelude::*;

/// The frame has one retained contour for every state; blended backing stays below members.
pub(super) fn draw_frame(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
    style: crate::scope_visual::ScopeStyle,
) -> Vec<Label> {
    let path = crate::scope_visual::rounded_path(
        node.x,
        node.y,
        node.width,
        node.height,
        crate::scope_visual::FRAME_RADIUS,
    );
    geometry.polygon_alpha(&path, 9.9, theme.token_u32("canvasNodeSurface"), 0.35);
    if style.tint > 0.0 {
        geometry.polygon_alpha(
            &path,
            9.901,
            theme.token_u32("interactionAccent"),
            style.tint,
        );
    }
    // 单一圆角虚线框：选中/悬停只改变颜色与线宽，不再叠加实体方形边框。
    super::dash::dashed_rounded_rect(
        geometry,
        node.x,
        node.y,
        node.width,
        node.height,
        crate::scope_visual::FRAME_RADIUS,
        style.width,
        10.0 + index as f32 * 0.1,
        style.border,
    );
    Vec::new()
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
    fn frame_draws_border_and_semi_transparent_fill_without_title() {
        let theme = ThemeResource::default();
        let node = node(NodeChrome::Frame {
            group_id: "group".into(),
            member_node_ids: vec!["a".into()],
        });
        let mut geometry = Geometry::default();
        let labels = draw_frame(
            &mut geometry,
            &theme,
            &node,
            0,
            crate::scope_visual::ScopeStyle::resolve(&theme, false, 0.0),
        );
        assert!(geometry.build().count_vertices() > 0);
        assert!(labels.is_empty(), "名称由共享 scope label 层绘制");
    }
}
