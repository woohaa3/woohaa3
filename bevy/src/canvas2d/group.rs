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

/// group 容器的 z 层：必须低于所有节点卡片（卡片为 `10.0 + index * 0.1`），
/// 也低于边草稿与删除按钮，使成员与控件始终浮在容器之上。
pub(crate) const GROUP_Z: f32 = 1.0;

/// 圆角半径与描边宽度。
const GROUP_BORDER: f32 = 1.5;

/// group 容器底的 alpha（change: fix-group-and-marquee-preview）。
///
/// 0.55 与参考实现 `rgba(42,42,48,.55)` 同量级：只暗示容器范围，不遮挡成员卡片边框。
pub(super) const GROUP_FILL_ALPHA: f32 = 0.55;

pub(super) fn is_running(node: &crate::protocol::GraphNode) -> bool {
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
) -> (String, Vec2, f32, u32) {
    let (x, y, width, height) = (node.x, node.y, node.width, node.height);
    if selected && node.resizable { super::cards::draw_resize_grip(geometry, theme, node, GROUP_Z + 0.03); }
    // 选中态用更强的虚线框颜色表达，而不是铺一层不透明选中底：容器铺底会盖住成员
    // （change: fix-group-and-marquee-preview）。
    let border = if selected {
        theme.token_u32("canvasNodeBorderSelected")
    } else {
        theme.token_u32("canvasNodeBorder")
    };
    // Continuous group surfaces are drawn behind the model by group_surface, using the same
    // canvas camera. This overlay owns only the single perimeter, text and controls.
    let path = super::group_outline::path(node);
    if is_running(node) {
        let color = if selected {
            border
        } else {
            super::group_motion::mix(border, theme.token_u32("interactionAccent"), 0.55)
        };
        super::group_outline::stroke(
            geometry,
            &path,
            0.,
            super::group_outline::length(&path),
            2.,
            GROUP_Z + 0.001,
            color,
        );
    } else {
        dashed_polyline(
            geometry,
            &crate::canvas_query::group_model::frame_path(node),
            GROUP_BORDER,
            GROUP_Z + 0.001,
            border,
        );
    }
    let badge = crate::canvas_query::group_model::badge_path(node);
    if !badge.is_empty() {
        super::group_outline::stroke(
            geometry,
            &badge,
            0.,
            super::group_outline::length(&badge),
            GROUP_BORDER,
            GROUP_Z + 0.002,
            border,
        );
        let rect = crate::canvas_query::group_model::badge_rect(node);
        let center = Vec2::new(rect.x + rect.z - 10., rect.y + rect.w / 2.);
        let direction = if presentation.collapsed { 1. } else { -1. };
        let tip = center + Vec2::Y * (2.5 * direction);
        for side in [-1., 1.] {
            geometry.line(
                center + Vec2::new(side * 3., -2.5 * direction),
                tip,
                1.5,
                GROUP_Z + 0.003,
                theme.token_u32("canvasBodyText"),
            );
        }
    }
    if let Some(corner) = crate::canvas_query::group_model::resize_center(node) {
        let color = theme.token_u32("canvasResizeHandle");
        for length in [5., 9.] {
            geometry.line(
                corner - Vec2::X * length,
                corner - Vec2::Y * length,
                1.5,
                GROUP_Z + 0.02,
                color,
            );
        }
    }
    if selected && node.resizable {
        let corner = Vec2::new(x + width - 4., y + height - 4.);
        for length in [6., 11.] {
            geometry.line(
                corner - Vec2::X * length,
                corner - Vec2::Y * length,
                1.5,
                GROUP_Z + 0.02,
                theme.token_u32("canvasResizeHandle"),
            );
        }
    }
    // 左上角标题：`标题 · N 项`；无标题时只显示计数。
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
    // 聚合输出端点：至少一个递归叶子具备输出能力时才显示（change: add-canvas-node-grouping，
    // design D5）。它只表示「可从此处拉出成员的真实边」，不是持久化边端点。
    if presentation.output_capable_leaf_count > 0 {
        let port = Vec2::new(x + width, y + height / 2.0);
        geometry.circle(
            port,
            6.0,
            GROUP_Z + 0.01,
            theme.token_u32("canvasPortDefault"),
            20,
        );
        geometry.circle(
            port,
            3.7,
            GROUP_Z + 0.02,
            theme.token_u32("canvasPortFill"),
            20,
        );
    }
    (
        shortened(
            &label,
            (width
                - 24.
                - crate::canvas_query::layout::group_run_status_rect(node)
                    .map_or(0., |r| r.2 + 12.))
            .max(24.),
            12.,
        ),
        Vec2::new(x + 12., y + 8.),
        12.,
        theme.token_u32("canvasBodyText"),
    )
}

pub(crate) fn draw_run_status(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &crate::protocol::GraphNode,
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
    geometry.rounded_rect(x, y, width, height, 6., GROUP_Z + 0.03, background);
    if !active {
        geometry.circle(
            Vec2::new(x + 10., y + height / 2.),
            3.,
            GROUP_Z + 0.04,
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
            },
            false,
        );
        let mesh = geometry.build();
        let positions = mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap();
        assert!(positions.len() > 40);
        assert_eq!(label, "镜头发散 · 3 项");
        assert_eq!(position, Vec2::new(12.0, 8.0));
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
            },
            false,
        );
        assert_eq!(label, "1 项");
    }

    /// group 容器的 z 必须低于所有节点卡片，避免盖住成员。
    #[test]
    fn group_z_is_below_node_cards() {
        assert!(GROUP_Z < 10.0);
    }

    /// 虚线框会产生多段几何（用 mesh 顶点数间接验证，而非内部字段）。
    #[test]
    fn group_emits_dashed_geometry() {
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
            },
            false,
        );
        let mesh = geometry.build();
        let positions = mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap();
        // 圆角矩形（36 点）+ 多段虚线与圆角短线，远超单个矩形。
        assert!(positions.len() > 40);
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
                );
                let (opaque, blend) = geometry.into_layers();
                let Some(bevy::mesh::VertexAttributeValues::Float32x3(points)) =
                    opaque.attribute(Mesh::ATTRIBUTE_POSITION)
                else {
                    panic!("positions");
                };
                let layout = crate::canvas_query::group_model::for_node(&node).unwrap();
                assert!(points.iter().all(|p| -p[1]
                    <= node.y + node.height + crate::canvas_query::group_model::BADGE_OUTSET + 1.));
                assert!(
                    !points
                        .iter()
                        .any(|p| p[0] > layout.center.x - layout.radii.x + 2.
                            && p[0] < layout.center.x + layout.radii.x - 2.
                            && -p[1] > layout.center.y - layout.radii.y + 2.
                            && -p[1] < layout.center.y + layout.radii.y - 2.),
                    "unexpected stroke through footer model in selected={selected} running={running}"
                );
                // No model-covering fill can enter the higher camera-order overlay.
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
