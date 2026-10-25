//! group 结构容器的 2D 绘制（change: add-canvas-node-grouping，任务 2.2b / design D2）。
//!
//! group 的几何已由 Web 映射层投影为**绝对画布坐标**；本模块只负责把容器画在成员
//! **之下**：低 z 的圆角虚线框、左上角标题、成员计数。它不持有 parentId、相对坐标或
//! 成员关系，也不参与命中测试（命中顺序由 JS `hit-test` 决定）。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫），
//! 且 group 的绘制与普通卡片差异较大（虚线、无内容区、无端点）。

use bevy::prelude::*;

use crate::protocol::GroupPresentation;
use crate::theme::ThemeResource;

use super::dash::dashed_rounded_rect;
use super::geometry::Geometry;
use super::layout::{hex, shortened};

/// group 容器的 z 层：必须低于所有节点卡片（卡片为 `10.0 + index * 0.1`），
/// 也低于边草稿与删除按钮，使成员与控件始终浮在容器之上。
pub(crate) const GROUP_Z: f32 = 1.0;

/// 圆角半径与描边宽度。
const GROUP_RADIUS: f32 = 12.0;
const GROUP_BORDER: f32 = 1.5;

/// group 容器底的 alpha（change: fix-group-and-marquee-preview）。
///
/// 0.55 与参考实现 `rgba(42,42,48,.55)` 同量级：只暗示容器范围，不遮挡成员卡片边框。
const GROUP_FILL_ALPHA: f32 = 0.55;

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
    // 容器面：**半透明**（change: fix-group-and-marquee-preview）。此前用不透明
    // `canvasNodeSurface` 铺满包围盒，导致成员卡片边框与容器底连成一片而不可见；
    // 参考实现（旧版画布）用 `rgba(42,42,48,.55)` 只做轻微层次暗示。
    // 颜色取自既有 token，alpha 是呈现参数（不新增 token）。
    geometry.rounded_rect_alpha(
        x,
        y,
        width,
        height,
        GROUP_RADIUS,
        GROUP_Z,
        theme.token_u32("canvasNodeSurface"),
        GROUP_FILL_ALPHA,
    );
    if is_running(node) {
        let path = super::group_outline::path(node);
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
        dashed_rounded_rect(
            geometry,
            x,
            y,
            width,
            height,
            GROUP_RADIUS,
            GROUP_BORDER,
            GROUP_Z + 0.001,
            border,
        );
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
                title: "镜头发散".into(),
                member_count: 3,
                output_capable_leaf_count: 2,
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
                title: "   ".into(),
                member_count: 1,
                output_capable_leaf_count: 0,
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
                title: String::new(),
                member_count: 1,
                output_capable_leaf_count: 0,
                run_status: None,
            },
            false,
        );
        let mesh = geometry.build();
        let positions = mesh.attribute(Mesh::ATTRIBUTE_POSITION).unwrap();
        // 圆角矩形（36 点）+ 多段虚线与圆角短线，远超单个矩形。
        assert!(positions.len() > 40);
    }
}
