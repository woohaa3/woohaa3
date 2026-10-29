//! group 结构容器的 2D 绘制（change: add-canvas-node-grouping，任务 2.2b / design D2）。
//!
//! group 的几何已由 Web 映射层投影为**绝对画布坐标**；本模块只负责把容器画在成员
//! **之下**：低 z 的圆角虚线框、左上角标题、成员计数。它不持有 parentId、相对坐标或
//! 成员关系，命中几何与 Rust canvas_query 共享。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫），
//! 且 group 的绘制与普通卡片差异较大（虚线、无内容区、无端点）。

use bevy::prelude::*;

use crate::protocol::GroupPresentation;
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::layout::{hex, shortened};

/// 组选择带等共享覆盖层使用的基础 z。
///
/// 组主体与组卡片的实际 z 由 `draw_order::render_index` 派生；该常量只保留给
/// 不携带节点层级的聚合选择带和几何测试。
pub(crate) const GROUP_Z: f32 = 1.0;

/// group 容器底实色（change: canvas-grouping-redesign）。
pub(super) const GROUP_FILL_ALPHA: f32 = 1.0;

/// 组面板圆角（change: canvas-grouping-redesign）。
const GROUP_PANEL_RADIUS: f32 = 16.;

pub(crate) fn is_running(node: &crate::protocol::GraphNode) -> bool {
    node.group
        .as_ref()
        .and_then(|g| g.run_status.as_ref())
        .is_some_and(|s| {
            matches!(
                s.state.as_str(),
                "preparing" | "root-created" | "accepted" | "queued" | "running" | "committing"
            )
        })
}

/// Build one transparent panel mesh for one group. It deliberately uses local
/// z=0; the caller puts the entity itself at the group's world z so Bevy's
/// Transparent2d phase can sort each panel independently.
///
/// 组**不铺底色**：成员卡片直接浮在画布上，组的身份只由左上角那块独立标签卡表达
/// （change: canvas-grouping-redesign，参考稿即如此）。这里只保留拖入时的强调层，
/// 让「松手会落进这个组」看得见。
pub(crate) fn draw_group_panel(
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
    presentation: &GroupPresentation,
) -> Mesh {
    let mut geometry = Geometry::default();
    if presentation.drop_target {
        panel(
            &mut geometry,
            node,
            0.001,
            theme.token_u32("interactionAccentSoft"),
            0.22,
        );
    }
    geometry.build()
}

/// 在组矩形内铺一层底色。徽标固定在矩形外侧，因此背板可以完整覆盖组内容。
fn panel(
    geometry: &mut Geometry,
    node: &crate::protocol::GraphNode,
    z: f32,
    color: u32,
    alpha: f32,
) {
    let radius = GROUP_PANEL_RADIUS;
    geometry.rounded_rect_radii_alpha(
        node.x,
        node.y,
        node.width,
        node.height,
        [radius; 4],
        z,
        color,
        alpha,
    );
}

/// 在共享几何里追加一个 group 容器的虚线框与标题装饰。
///
/// 返回标题标签的 `(文案, 位置, 字号, 颜色)`，由 `render.rs` 统一进 label 实体池，
/// 复用既有的标签增删改路径。
pub(crate) fn draw_group(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
    presentation: &GroupPresentation,
    selected: bool,
    z: f32,
) -> (String, Vec2, f32, u32) {
    let (x, y, width, _height) = (node.x, node.y, node.width, node.height);
    if selected && node.resizable { super::cards::draw_resize_grip(geometry, theme, node, z + 0.03); }
    // 运行中时画动态描边；选中态描边由 draw_group_selection 独立生产。
    if !selected && is_running(node) {
        let path = super::group_outline::path(node);
        super::group_outline::stroke(
            geometry,
            &path,
            0.,
            super::group_outline::length(&path),
            2.,
            z + 0.001,
            super::group_motion::mix(
                theme.token_u32("canvasNodeBorder"),
                theme.token_u32("interactionAccent"),
                0.55,
            ),
        );
    }
    if !selected && presentation.drop_target {
        let path = super::group_outline::path(node);
        super::group_outline::stroke(
            geometry,
            &path,
            0.,
            super::group_outline::length(&path),
            2.,
            z + 0.001,
            theme.token_u32("interactionAccent"),
        );
    }
    if let Some(corner) = crate::canvas_query::group_model::resize_center(node) {
        let color = theme.token_u32("canvasResizeHandle");
        for length in [5., 9.] {
            geometry.line(
                corner - Vec2::X * length,
                corner - Vec2::Y * length,
                1.5,
                z + 0.02,
                color,
            );
        }
    }

    // 左上角胶囊标签：`标题 · N 项`（change: canvas-grouping-redesign）。
    let title = if presentation.title.trim().is_empty() {
        String::new()
    } else {
        presentation.title.trim().to_owned()
    };
    let label = if title.is_empty() {
        format!("{} 项", presentation.member_count)
    } else {
        format!("{} · {} 项", title, presentation.member_count)
    };
    const PILL_FONT: f32 = 12.;
    const PILL_PAD_X: f32 = 8.;
    const PILL_HEIGHT: f32 = 24.;
    const PILL_RADIUS: f32 = 8.;
    const PILL_INSET: f32 = 10.;
    let max_label_width = (width - PILL_INSET * 2. - PILL_PAD_X * 2. - 24.).max(24.);
    let short_label = shortened(&label, max_label_width, PILL_FONT);
    let text_width = crate::canvas_query::layout::estimated_text_width(&short_label, PILL_FONT);
    let pill_width = (text_width + PILL_PAD_X * 2.).max(PILL_HEIGHT);
    geometry.rounded_rect(
        x + PILL_INSET,
        y + PILL_INSET,
        pill_width,
        PILL_HEIGHT,
        PILL_RADIUS,
        z + 0.002,
        theme.token_u32("canvasGroupLabel"),
    );
    (
        short_label,
        Vec2::new(
            x + PILL_INSET + PILL_PAD_X,
            y + PILL_INSET + (PILL_HEIGHT - PILL_FONT) / 2.,
        ),
        PILL_FONT,
        theme.token_u32("canvasGroupLabelText"),
    )
}

/// group 持久选中描边 producer：选中边框（虚线/运行描边）与选中 resize 抓手。
///
/// 与基础 group 几何互斥，同一位置不会产生两份描边。
pub(crate) fn draw_group_selection(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
    z: f32,
) {
    let color = theme.token_u32("canvasNodeBorderSelected");
    let path = super::group_outline::path(node);
    if is_running(node) {
        super::group_outline::stroke(
            geometry,
            &path,
            0.,
            super::group_outline::length(&path),
            2.,
            z + 0.001,
            color,
        );
    } else {
        super::group_outline::stroke(
            geometry,
            &path,
            0.,
            super::group_outline::length(&path),
            2.,
            z + 0.001,
            color,
        );
    }
    if node.resizable {
        let corner = Vec2::new(node.x + node.width - 4., node.y + node.height - 4.);
        for length in [6., 11.] {
            geometry.line(
                corner - Vec2::X * length,
                corner - Vec2::Y * length,
                1.5,
                z + 0.02,
                theme.token_u32("canvasResizeHandle"),
            );
        }
    }
}

pub(crate) fn draw_run_status(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
    z: f32,
) -> Option<(String, Vec2, f32, u32)> {
    let status = node.group.as_ref()?.run_status.as_ref()?;
    let (x, y, width, height) = crate::canvas_query::layout::group_run_status_rect(node)?;
    let token = match status.state.as_str() {
        "failed" => "statusDanger",
        "unknown" | "partial" => "statusWarning",
        "succeeded" => "statusSuccess",
        "cancelled" => "webTextMuted",
        _ => "interactionAccent",
    };
    let color = theme.token_u32(token);
    let active = is_running(node);
    let background = theme.token_u32(if active {
        "interactionAccentSoft"
    } else {
        "canvasNodeSurface"
    });
    geometry.rounded_rect(x, y, width, height, 6., z + 0.03, background);
    if !active {
        geometry.circle(
            Vec2::new(x + 10., y + height / 2.),
            3.,
            z + 0.04,
            color,
            16,
        );
    }
    Some((
        format!("{} ›", status.label),
        Vec2::new(x + 20., y + 5.),
        12.,
        color,
    ))
}

/// group 标签颜色辅助（供测试/调试）。
#[allow(dead_code)]
pub(crate) fn group_label_color(value: u32) -> Color {
    hex(value)
}

#[cfg(test)]
mod tests {
    use bevy::mesh::VertexAttributeValues;
    use super::*;

    fn node(width: f32, height: f32) -> crate::protocol::GraphNode {
        crate::protocol::GraphNode {
            model_preview: None,
            shot_preview: None,

            id: "g".into(),
            kind: "group".into(),
            x: 0.0,
            y: 0.0,
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
        }
    }

    #[test]
    fn group_draws_dashed_border_and_label() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        let (label, position, size, _color) = draw_group(
            &mut geometry,
            &theme,
            &node(400.0, 300.0),
            &GroupPresentation {
                collapsed: false,
                badge_scale: 1.,
                badge_resizable: false,
                title: "镜头发散".into(),
                member_count: 3,
                output_capable_leaf_count: 2,
                model_bounds: None,
                run_status: None,
                drop_target: false,
            },
            false,
            GROUP_Z,
        );
        let mesh = geometry.build();
        let positions = mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap();
        // 只剩左上角标签卡的胶囊底（虚线框已移除，change: canvas-grouping-redesign）。
        assert!(positions.len() > 8);
        assert_eq!(label, "镜头发散 · 3 项");
        // 胶囊内文字位置：距组左上各 10，再加 8 的左右内边距 / 垂直居中。
        assert_eq!(position, Vec2::new(18.0, 16.0));
        assert_eq!(size, 12.0);
    }

    #[test]
    fn group_without_title_shows_count_only() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        let (label, ..) = draw_group(
            &mut geometry,
            &theme,
            &node(200.0, 150.0),
            &GroupPresentation {
                collapsed: false,
                badge_scale: 1.,
                badge_resizable: false,
                title: "   ".into(),
                member_count: 1,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                drop_target: false,
            },
            false,
            GROUP_Z,
        );
        assert_eq!(label, "1 项");
    }

    /// group 容器的 z 必须低于所有节点卡片，避免盖住成员。
    #[test]
    fn group_z_is_below_node_cards() {
        assert!(GROUP_Z < 10.0);
    }

    /// 组不再画外框（虚线已移除），只剩左上角标签卡：胶囊底 + 文字。
    #[test]
    fn group_emits_only_the_label_pill() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        draw_group(
            &mut geometry,
            &theme,
            &node(400.0, 300.0),
            &GroupPresentation {
                collapsed: false,
                badge_scale: 1.,
                badge_resizable: false,
                title: String::new(),
                member_count: 1,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                drop_target: false,
            },
            false,
            GROUP_Z,
        );
        let mesh = geometry.build();
        let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
            panic!("label pill must be drawn");
        };
        // 胶囊底的顶点都聚集在组左上角附近，不会铺满整个组。
        assert!(points.iter().all(|point| point[0] < 200.0 && -point[1] < 100.0));
        assert!(!points.is_empty());
    }

    /// 普通组**不再**有背景面板：成员卡片直接浮在画布上
    /// （change: canvas-grouping-redesign，参考稿即如此）。
    #[test]
    fn ordinary_group_has_no_background_panel() {
        let theme = ThemeResource::default();
        let mesh = draw_group_panel(&theme, &node(400.0, 300.0), &panel_presentation(false));
        let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
            return;
        };
        // 空几何被换成屏幕外兜底三角形；只要没有真实顶点就说明没铺底。
        assert!(
            points.iter().all(|point| point[0] < -1.0e5),
            "普通组不应铺背景面板"
        );
    }

    fn panel_presentation(drop_target: bool) -> GroupPresentation {
        GroupPresentation {
            collapsed: false,
            badge_scale: 1.,
            badge_resizable: false,
            title: String::new(),
            member_count: 1,
            output_capable_leaf_count: 0,
            model_bounds: None,
            run_status: None,
            drop_target,
        }
    }

    fn model_group(width: f32, height: f32) -> crate::protocol::GraphNode {
        serde_json::from_value(serde_json::json!({
            "id":"g","type":"group","x":0.,"y":0.,"width":width,"height":height,
            "group":{"modelBounds":{"aabb":{"min":[-1,-1,-1],"max":[1,1,1]},"extent":2}},
            "model":{"resourceKey":"test:box","signature":"box"}
        }))
        .unwrap()
    }

    /// 组**不铺底色**：参考稿里成员卡片直接浮在画布上，组身份只由左上角标签卡表达
    /// （change: canvas-grouping-redesign）。
    #[test]
    fn group_panel_has_no_fill_without_drop_target() {
        let mesh = draw_group_panel(
            &ThemeResource::default(),
            &node(400.0, 300.0),
            &panel_presentation(false),
        );
        let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            return;
        };
        // 空几何会被 `build_mesh` 换成屏幕外的兜底三角形（3 个 -1e6 顶点）。
        assert!(
            points.iter().all(|point| point[0] < -1.0e5),
            "组不应铺底色，实际画了 {} 个真实顶点",
            points.iter().filter(|point| point[0] > -1.0e5).count()
        );
    }

    /// 拖入态仍要画出强调层，否则用户看不出「松手会落进这个组」。
    #[test]
    fn group_panel_shows_accent_only_when_drop_target() {
        let theme = ThemeResource::default();
        let mesh = draw_group_panel(&theme, &node(400., 300.), &panel_presentation(true));
        let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("drop target panel must carry positions");
        };
        assert!(points.iter().any(|point| point[0] > -1.0e5), "拖入态必须画出强调层");
        let Some(VertexAttributeValues::Float32x4(colors)) = mesh.attribute(Mesh::ATTRIBUTE_COLOR)
        else {
            panic!("drop target panel must carry vertex colors");
        };
        // 强调层是半透明叠加，不是实色底。
        assert!(colors.iter().all(|color| (color[3] - 0.22).abs() < 1e-6));
    }

    /// 带模型组与无模型组都不铺底，观感一致（3D 相机只画气泡尾巴）。
    #[test]
    fn model_presence_does_not_add_group_underlay() {
        let theme = ThemeResource::default();
        for mesh in [
            draw_group_panel(&theme, &node(400., 300.), &panel_presentation(false)),
            draw_group_panel(&theme, &model_group(400., 300.), &panel_presentation(false)),
        ] {
            let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            else {
                continue;
            };
            assert!(
                points.iter().all(|point| point[0] < -1.0e5),
                "带不带模型都不应铺组底色"
            );
        }
    }

    /// 带模型的组同样不铺背景板（change: canvas-grouping-redesign）。
    ///
    /// 组的身份只由左上角标签卡表达，成员卡片直接浮在画布上。
    #[test]
    fn model_group_has_no_background_panel() {
        let node = model_group(500., 300.);
        let mesh = draw_group_panel(
            &ThemeResource::default(),
            &node,
            &panel_presentation(false),
        );
        let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            return;
        };
        assert!(
            points.iter().all(|point| point[0] < -1.0e5),
            "带模型的组也不应铺背景板"
        );
    }

    #[test]
    fn prepared_group_has_one_continuous_outline_in_normal_selected_and_running_states() {
        let mut node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({
            "id":"g","type":"group","x":0,"y":0,"width":500,"height":300,
            "resizable":true,
            "model":{"resourceKey":"test:box","signature":"box"},
            "group":{"modelBounds":{"aabb":{"min":[-1,-1,-1],"max":[1,1,1]},"extent":2}}
        }))
        .unwrap();
        for selected in [false, true] {
            for running in [false, true] {
                node.group.as_mut().unwrap().run_status =
                    running.then(|| crate::protocol::GroupRunStatus {
                        label: "生成中".into(),
                        state: "running".into(),
                    });
                let mut geometry = Geometry::default();
                draw_group(
                    &mut geometry,
                    &ThemeResource::default(),
                    &node,
                    node.group.as_ref().unwrap(),
                    selected,
                    GROUP_Z,
                );
                let (opaque, blend) = geometry.into_layers();
                let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
                    opaque.attribute(Mesh::ATTRIBUTE_POSITION)
                else {
                    panic!("positions");
                };
                let layout = crate::canvas_query::group_model::for_node(&node).unwrap();
                let badge = crate::canvas_query::group_model::badge_rect(&node);
                assert!(points
                    .iter()
                    .all(|p| -p[1] <= badge.y + badge.w + 1.));
                assert!(
                    !points
                        .iter()
                        .any(|p| p[0] > layout.center.x - layout.radii.x + 2.
                            && p[0] < layout.center.x + layout.radii.x - 2.
                            && -p[1] > layout.center.y - layout.radii.y + 2.
                            && -p[1] < layout.center.y + layout.radii.y - 2.),
                    "unexpected stroke through footer model in selected={selected} running={running}"
                );
                // 组底现在由每组独立的透明 panel 实体绘制；共享 overlay 不得再携带覆盖模型的填充。
                // `Geometry::into_layers` 对空 blend 仍产出不可见兜底三角形（顶点在 -1e6），
                // 因此这里断言的是「没有真实填充」而不是属性缺失。
                let Some(bevy::mesh::VertexAttributeValues::Float32x3(fill)) =
                    blend.attribute(Mesh::ATTRIBUTE_POSITION)
                else {
                    panic!("fill");
                };
                assert!(fill.iter().all(|p| p[0] < -100000.));
            }
        }
    }
}
