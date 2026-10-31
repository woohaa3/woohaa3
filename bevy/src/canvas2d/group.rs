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

use super::dash::dashed_polyline;
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

/// 组描边宽度（收起组按徽标路径描边时使用）。
const GROUP_BORDER: f32 = 1.5;

/// 组四角缩放抓手的圆点半径与浅色外圈半径；外圈保证圆点在深色底图上也能看清。
const CORNER_HANDLE_RADIUS: f32 = 4.5;
const CORNER_HANDLE_HALO: f32 = 6.5;

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

/// Build one transparent panel mesh for one group. The mesh is **group-local**
/// (origin at the group's top-left corner) and uses local z=0: the caller places
/// the entity at the group's canvas position and world z, so pure move increments
/// only update the transform (Bevy's Transparent2d phase sorts each panel by the
/// entity z) and never rebuild the mesh.
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
    // 收起组只保留徽标卡片（由卡片通路绘制），这里不铺任何底板
    // （change: 2026-10-28-migrate-film-set-to-groups）。普通组也不铺底色：
    // 参考稿里成员卡片直接浮在画布上，组的身份只由左上角的标签卡表达
    // （change: canvas-grouping-redesign）。
    if presentation.collapsed {
        return geometry.build();
    }
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

/// 在组本地矩形内铺一层底色（原点在组左上角，位置由实体 transform 承担）。
/// 徽标固定在矩形外侧，因此背板可以完整覆盖组内容。
fn panel(
    geometry: &mut Geometry,
    node: &crate::protocol::GraphNode,
    z: f32,
    color: u32,
    alpha: f32,
) {
    let radius = GROUP_PANEL_RADIUS;
    geometry.rounded_rect_radii_alpha(
        0.,
        0.,
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
    let (x, y, width, height) = (node.x, node.y, node.width, node.height);
    let _ = selected;
    // 收起组只保留徽标卡片（由卡片通路绘制），气泡背板/尾巴一律不画
    // （change: 2026-10-28-migrate-film-set-to-groups）。
    if presentation.collapsed {
        return (
            String::new(),
            Vec2::ZERO,
            0.,
            theme.token_u32("canvasBodyText"),
        );
    }
    // 选中抓手不再走卡片态的右下角三角+条纹：组的四个角统一由 `draw_group_selection`
    // 画同一套角标，否则右下角会多出一个形状不同的旧抓手。
    // 选中态边框由 `draw_group_selection` 独立生产：这里跳过，避免同一位置重复几何。
    // 运行中时画动态描边；选中态描边由 draw_group_selection 独立生产。
    // 空闲且未选中的组不画外框：组的身份只由左上角标签卡表达
    // （change: canvas-grouping-redesign，参考稿即如此）。
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

    // 组名标签：浮在组框**上方外侧**，像一枚独立的小卡片（change: canvas-grouping-redesign）。
    // 参考稿里组没有底板，标签是唯一可见的组身份，所以它不能压在成员身上。
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
    const PILL_FONT: f32 = 16.;
    const PILL_PAD_X: f32 = 14.;
    const PILL_HEIGHT: f32 = 36.;
    const PILL_RADIUS: f32 = 12.;
    /// 标签底边到组框顶边的间隙。
    const PILL_GAP: f32 = 8.;
    let max_label_width = (width - PILL_PAD_X * 2.).max(48.);
    let short_label = shortened(&label, max_label_width, PILL_FONT);
    let text_width = crate::canvas_query::layout::estimated_text_width(&short_label, PILL_FONT);
    let pill_width = (text_width + PILL_PAD_X * 2.).max(PILL_HEIGHT);
    geometry.rounded_rect(
        x,
        y - PILL_GAP - PILL_HEIGHT,
        pill_width,
        PILL_HEIGHT,
        PILL_RADIUS,
        z + 0.002,
        theme.token_u32("canvasGroupLabel"),
    );
    (
        short_label,
        Vec2::new(
            x + PILL_PAD_X,
            y - PILL_GAP - PILL_HEIGHT + (PILL_HEIGHT - PILL_FONT) / 2.,
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
    if node.group.as_ref().is_some_and(|group| group.collapsed) {
        // 收起组只呈现徽标：选中描边贴在模型投影范围上；没有可呈现模型时保留结构矩形，
        // 不虚构空徽标范围。
        let badge = crate::canvas_query::group_model::badge_polygon(node);
        let path = if badge.is_empty() {
            crate::canvas_query::group_model::frame_path(node)
        } else {
            badge
        };
        dashed_polyline(geometry, &path, GROUP_BORDER, z + 0.001, color);
    } else if is_running(node) {
        // 运行中：实线描边（沿轮廓流动的效果由 `group_motion` 叠加）。
        let path = super::group_outline::path(node);
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
        // 空闲选中：虚线描边。两态必须画出不同的几何 —— 都画实线的话，
        // "运行中"在选中态下就没有任何视觉区分（这里两个分支曾经逐字节相同，踩过）。
        let path = super::group_outline::path(node);
        super::dash::dashed_polygon(geometry, &path, 2., z + 0.001, color);
    }
    if node.resizable && !node.group.as_ref().is_some_and(|group| group.collapsed) {
        draw_resize_corners(geometry, theme, node, z);
    }
}

/// 组四角缩放抓手：压在外框角点上的小圆点，贴合圆角气泡的轮廓语言。
///
/// 圆心与 `layout::resize_corner_rects` 的 20×20 命中框同心，四角完全同形；浅色外圈让
/// 抓手在气泡半透明底色与画布背景上都保持对比。
fn draw_resize_corners(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
    z: f32,
) {
    let core = theme.token_u32("canvasResizeHandle");
    let halo = theme.token_u32("canvasNodeSurface");
    for corner in crate::canvas_query::group_model::resize_corners(node) {
        geometry.circle(corner, CORNER_HANDLE_HALO, z + 0.02, halo, 24);
        geometry.circle(corner, CORNER_HANDLE_RADIUS, z + 0.021, core, 24);
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
        geometry.circle(Vec2::new(x + 10., y + height / 2.), 3., z + 0.04, color, 16);
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
    use super::*;
    use bevy::mesh::VertexAttributeValues;

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
            progress_started_at: None,
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
                badge_top_anchor: false,
                collapsed: false,
                action_bar: false,
                title: "镜头发散".into(),
                member_count: 3,
                output_capable_leaf_count: 2,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            
                overview_cache: None,
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
        // 标签浮在框顶上方：x 为左内边距，y 为「框顶 - 间隙 - 标签高 + 垂直居中偏移」。
        assert_eq!(position, Vec2::new(14.0, -34.0));
        assert_eq!(size, 16.0);
    }

    #[test]
    fn collapsed_group_does_not_draw_small_group_bubble() {
        let theme = ThemeResource::default();
        let mut geometry = Geometry::default();
        let (label, position, size, _color) = draw_group(
            &mut geometry,
            &theme,
            &node(400.0, 300.0),
            &GroupPresentation {
                badge_top_anchor: false,
                collapsed: true,
                action_bar: false,
                title: "镜头发散".into(),
                member_count: 3,
                output_capable_leaf_count: 2,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            
                overview_cache: None,
        },
            false,
            GROUP_Z,
        );
        assert_eq!(
            geometry
                .build()
                .attribute(Mesh::ATTRIBUTE_POSITION)
                .unwrap()
                .len(),
            3
        );
        assert!(label.is_empty());
        assert_eq!(position, Vec2::ZERO);
        assert_eq!(size, 0.);
        let panel = draw_group_panel(
            &theme,
            &node(400.0, 300.0),
            &GroupPresentation {
                badge_top_anchor: false,
                collapsed: true,
                action_bar: false,
                title: String::new(),
                member_count: 3,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            
                overview_cache: None,
        },
        );
        assert_eq!(panel.attribute(Mesh::ATTRIBUTE_POSITION).unwrap().len(), 3);
    }

    /// 收起后选中不能沿结构矩形的气泡轮廓描边：描边必须收到徽标范围内，
    /// 否则会留下「属于气泡位置的虚线框」（现场反馈）。
    #[test]
    fn collapsed_group_selection_outline_stays_on_the_badge() {
        let mut node = model_group(500., 300.);
        node.group.as_mut().unwrap().collapsed = true;
        let mut geometry = Geometry::default();
        draw_group_selection(&mut geometry, &ThemeResource::default(), &node, GROUP_Z);
        let mesh = geometry.build();
        let Some(VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("selection outline needs positions");
        };
        assert!(!points.is_empty());
        let badge = crate::canvas_query::group_model::badge_rect(&node).unwrap();
        for point in points {
            let canvas = Vec2::new(point[0], -point[1]);
            assert!(
                canvas.x >= badge.x - 2.
                    && canvas.x <= badge.x + badge.z + 2.
                    && canvas.y >= badge.y - 2.
                    && canvas.y <= badge.y + badge.w + 2.,
                "收起选中描边必须落在模型投影范围内：{canvas:?} vs {badge:?}"
            );
        }
    }

    /// 没有可呈现模型的组收起时保留结构矩形，不虚构空徽标范围。
    #[test]
    fn collapsed_group_without_model_keeps_the_structural_rect() {
        let mut plain = node(500., 300.);
        plain.group = Some(
            serde_json::from_value(serde_json::json!({ "collapsed": true, "title": "组" }))
                .unwrap(),
        );
        assert!(crate::canvas_query::group_model::badge_rect(&plain).is_none());
        let mut geometry = Geometry::default();
        draw_group_selection(&mut geometry, &ThemeResource::default(), &plain, GROUP_Z);
        let mesh = geometry.build();
        let Some(VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("selection outline needs positions");
        };
        let farthest_y = points.iter().map(|p| -p[1]).fold(f32::MIN, f32::max);
        assert!(
            (farthest_y - (plain.y + plain.height)).abs() < 2.,
            "无模型收起仍按结构矩形描边：{farthest_y}"
        );
    }

    /// 展开态保持原有气泡描边（含尾巴），确认收起分支没有影响正常组。
    #[test]
    fn expanded_group_selection_outline_follows_the_bubble() {
        let node = model_group(500., 300.);
        let mut geometry = Geometry::default();
        draw_group_selection(&mut geometry, &ThemeResource::default(), &node, GROUP_Z);
        let mesh = geometry.build();
        let Some(VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("selection outline needs positions");
        };
        assert!(
            points
                .iter()
                .any(|point| -point[1] <= node.y + node.height + 0.01),
            "展开态选中描边应覆盖气泡轮廓"
        );
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
                badge_top_anchor: false,
                collapsed: false,
                action_bar: false,
                title: "   ".into(),
                member_count: 1,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            
                overview_cache: None,
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
                badge_top_anchor: false,
                collapsed: false,
                action_bar: false,
                title: String::new(),
                member_count: 1,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            
                overview_cache: None,
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
            badge_top_anchor: false,
            collapsed: false,
            action_bar: false,
            title: String::new(),
            member_count: 1,
            output_capable_leaf_count: 0,
            model_bounds: None,
            run_status: None,
            geometry_quality: None,
            drop_target,
        
     
            overview_cache: None,
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
        let mesh = draw_group_panel(&ThemeResource::default(), &node, &panel_presentation(false));
        let Some(VertexAttributeValues::Float32x3(points)) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            return;
        };
        assert!(
            points.iter().all(|point| point[0] < -1.0e5),
            "带模型的组也不应铺背景板"
        );
    }

    /// 徽标就是模型本体：选中组不再绘制徽标线框或右下角缩放手柄。
    #[test]
    fn selected_model_group_draws_no_badge_frame_or_resize_handle() {
        let mut node = model_group(500., 300.);
        node.resizable = true;
        let mut geometry = Geometry::default();
        draw_group(
            &mut geometry,
            &ThemeResource::default(),
            &node,
            node.group.as_ref().unwrap(),
            true,
            GROUP_Z,
        );
        draw_group_selection(&mut geometry, &ThemeResource::default(), &node, GROUP_Z);
        let (_, blend) = geometry.into_layers();
        let Some(VertexAttributeValues::Float32x3(points)) =
            blend.attribute(Mesh::ATTRIBUTE_POSITION)
        else {
            panic!("blend fallback");
        };
        assert!(
            points.iter().all(|point| point[0] < -100000.),
            "徽标区域没有线框或手柄，只剩组结构描边"
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
                // 选中态边框与四角抓手由 `draw_group_selection` 生产（`draw_group` 只画未选中
                // 边框），所以这里合并两者，继续断言「整组只有一条连续外周」。
                if selected {
                    draw_group_selection(&mut geometry, &ThemeResource::default(), &node, GROUP_Z);
                }
                let (opaque, blend) = geometry.into_layers();
                let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
                    opaque.attribute(Mesh::ATTRIBUTE_POSITION)
                else {
                    panic!("positions");
                };
                // 组框只有一条闭合结构外周：不再绕徽标描边、不再有气泡尖尾，也不会
                // 从组底继续向下伸出。
                let bottom = node.y + node.height;
                assert!(
                    points.iter().all(|p| -p[1] <= bottom + 8.),
                    "group outline must stop at the structural bottom (corner handles may extend a few units; selected={selected} running={running})"
                );
                let frame = crate::canvas_query::group_model::frame_path(&node);
                assert!(frame.len() > 4 && frame.first() == frame.last());
                // 空闲且未选中的组不画外框（change: canvas-grouping-redesign），只有选中或
                // 运行中才有外周可断言。
                if selected || running {
                    assert!(
                        points.iter().any(|p| p[0] >= node.x
                            && p[0] <= node.x + node.width
                            && (bottom + p[1]).abs() < 2.),
                        "closed outline must include the structural bottom edge"
                    );
                }
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
