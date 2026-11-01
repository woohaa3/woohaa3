//! 片场（composite-asset）纯模型呈现的 2D 绘制
//! （change: 2026-10-08-make-film-set-model-only，design D1；
//!  change: 2026-10-12-align-film-set-scope-with-isometric-grid 地面平行四边形范围）。
//!
//! 片场不绘制顶部卡片、标题/状态与端口；这里只在 hover 或 selection 活跃时绘制范围虚线框、
//! 选中时的范围抓手，以及浮在范围顶部之上的名称小面板
//! （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。范围与标题几何由
//! `canvas_query::scope` / `canvas_query::layout` 的共享纯函数派生，绘制、标题、测试与命中
//! 共用同一事实源：`rect` 形状画矩形、地面矩形画与地面轴平行的闭合平行四边形（地面宽深相等
//! 时为菱形），抓手分别用 8 个方形或普通矩形右下角方形。
//!
//! 抽出独立模块的理由与 `group.rs` 相同：`render.rs` 接近文件体积上限
//! （`tests/file_size.rs` 守卫），且片场呈现与普通卡片差异较大。

use bevy::prelude::*;

use crate::protocol::GraphNode;
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::labels::Label;

/// Scene badge bounds stay readable at rest and carry selection independently of the group frame.
///
/// Film sets are authored at absolute metric scale, so the badge can range from a few hundred to
/// several thousand canvas pixels wide. A fixed hairline disappears on a large set (a 150 m street
/// filmset is ~9 000 px across, so 1 canvas unit is well below a pixel at the zoom used to frame
/// it) and looks coarse on a small one. The floor outline therefore scales its stroke with the
/// projected size of the model box, clamped so ordinary sets keep the structural-frame weight and
/// huge sets stay readable.
pub(crate) fn draw_group_badge_bottom(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    z: f32,
) {
    let Some(path) = crate::canvas_query::group_model::badge_bottom_polygon(node) else {
        return;
    };
    let (color, alpha, width) = if selected {
        (
            theme.token_u32("canvasNodeBorderSelected"),
            1.,
            (floor_stroke_width(&path) + 1.).min(BADGE_FLOOR_STROKE_MAX + 2.),
        )
    } else {
        (
            theme.token_u32("canvasBodyText"),
            0.55,
            floor_stroke_width(&path),
        )
    };
    for pair in path.windows(2) {
        geometry.line_alpha(pair[0], pair[1], width, z + 0.001, color, alpha);
    }
}

/// Stroke weight for the projected floor outline, proportional to the model box footprint.
///
/// The ratio is chosen so a badge that fills the viewport keeps a ~1 px line; the clamp keeps a
/// normal film set at the structural-frame weight and stops an interior close-up from turning the
/// outline into a slab.
const BADGE_FLOOR_STROKE_RATIO: f32 = 0.0015;
const BADGE_FLOOR_STROKE_MIN: f32 = 1.5;
const BADGE_FLOOR_STROKE_MAX: f32 = 7.0;

fn floor_stroke_width(path: &[Vec2; 5]) -> f32 {
    let (mut min, mut max) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
    for point in path {
        min = min.min(*point);
        max = max.max(*point);
    }
    let span = (max.x - min.x).max(max.y - min.y);
    if !span.is_finite() {
        return BADGE_FLOOR_STROKE_MIN;
    }
    (span * BADGE_FLOOR_STROKE_RATIO).clamp(BADGE_FLOOR_STROKE_MIN, BADGE_FLOOR_STROKE_MAX)
}

/// Persistent running backdrop, clipped to the same scope polygon used by drawing and picking.
pub(crate) fn draw_film_set_run_mask(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    z: f32,
) {
    let scope = super::scope::node_scope(node);
    geometry.polygon_alpha(
        &scope.vertices,
        z,
        theme.token_u32("canvasNodeContent"),
        0.45,
    );
}

/// 绘制片场范围虚线框与条件可见的顶部浮动名称面板，返回其标签（标题 + 可选业务类型名）。
///
/// 范围绘制、hover、选择、框选、双击与 drop 命中复用同一几何，因此这里不重新计算 bounds，
/// 只消费 `canvas_query::scope::node_scope`（面板布局由 `layout::film_title_layout` 派生）。
/// 返回 `None` 表示未激活（既不选中也不 hover），此时标签必须从实体池回收，不能残留文字。
///
/// `base_z` 为节点在文档中的真实 z 带（`10.0 + index * 0.1`），保证片场与普通卡片之间
/// 按文档顺序被深度遮挡（change: 2026-10-09-fix-model-preview-layering-and-projection）。
pub(crate) fn draw_film_set_scope(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    hovered: bool,
    base_z: f32,
) -> Option<Vec<Label>> {
    if !selected && !hovered {
        return None;
    }
    // 选中边框由 selection producer 独占；这里只在非选中态画范围框。
    if !selected {
        draw_scope_frame(geometry, theme, node, false, base_z);
    }
    Some(draw_scope_title(geometry, theme, node, base_z))
}

fn draw_scope_frame(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    base_z: f32,
) {
    let scope = super::scope::node_scope(node);
    let color = if selected {
        theme.token_u32("canvasNodeBorderSelected")
    } else {
        theme.token_u32("canvasNodeBorder")
    };
    if super::scope::is_diamond(scope.shape) {
        super::dash::dashed_polygon(geometry, &scope.vertices, 1.5, base_z, color);
    } else {
        let aabb = scope.aabb;
        super::dash::dashed_rounded_rect(
            geometry,
            aabb.x,
            aabb.y,
            aabb.width,
            aabb.height,
            8.,
            1.5,
            base_z,
            color,
        );
    }
}

/// 片场持久选中描边 producer：选中范围框 + 范围抓手（8 方形/右下角方形）。
pub(crate) fn draw_film_set_selection(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    base_z: f32,
) {
    draw_scope_frame(geometry, theme, node, true, base_z);
    if node.resizable {
        let scope = super::scope::node_scope(node);
        draw_scope_grip(geometry, theme, &super::scope::grip(&scope), base_z);
    }
}

/// 浮在范围顶部之上的小面板：主题底衬 + 有界省略的标题行与业务类型名行。
///
/// 使用节点已有的解析名称与业务类型名（`GraphNode.title` / `GraphNode.type_label`，由映射层按
/// 共享规则与可信 adapter 身份派生），不读草稿、不写默认名称。位置由 `layout::film_title_layout`
/// 派生：水平居中于模型内容包围盒、浮在范围顶部与内容包围盒顶部较高者之上固定间隙处，
/// 不侵占范围内部、不遮住模型身体、不与抓手重叠。
/// 显隐仍由 hover/选中决定（`draw_film_set_scope` 的提前返回）。
fn draw_scope_title(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    base_z: f32,
) -> Vec<Label> {
    let layout = super::layout::film_title_layout(node);
    let (chip_x, chip_y, chip_width, chip_height) = layout.chip;
    geometry.rounded_rect(
        chip_x,
        chip_y,
        chip_width,
        chip_height,
        6.,
        base_z + 0.003,
        theme.token_u32("canvasEdgeLabelBackground"),
    );
    let mut labels = vec![(
        layout.title,
        layout.title_pos,
        super::layout::FILM_TITLE_FONT,
        theme.token_u32("canvasEdgeLabelText"),
    )];
    if !layout.type_label.is_empty() {
        labels.push((
            layout.type_label,
            layout.type_pos,
            super::layout::FILM_TITLE_TYPE_FONT,
            theme.token_u32("canvasCloseIcon"),
        ));
    }
    labels
}

/// 范围抓手：地面矩形 8 个方形（四顶点 + 四边中点）；普通矩形右下角方形（与普通节点一致）。
pub(super) fn draw_scope_grip(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    grip: &super::scope::ScopeGrip,
    base_z: f32,
) {
    match grip {
        // 组容器的四角角标由 `super::group::draw_group_selection` 统一绘制，这里不再重复。
        super::scope::ScopeGrip::Corners(_) => {}
        super::scope::ScopeGrip::Handles(handles) => {
            let half = super::scope::DIAMOND_GRIP_LEG / 2.0;
            for handle in handles {
                geometry.polygon(
                    &[
                        Vec2::new(handle.x - half, handle.y - half),
                        Vec2::new(handle.x + half, handle.y - half),
                        Vec2::new(handle.x + half, handle.y + half),
                        Vec2::new(handle.x - half, handle.y + half),
                    ],
                    base_z + 0.001,
                    theme.token_u32("canvasResizeHandle"),
                );
            }
        }
        super::scope::ScopeGrip::Rect(rect) => {
            let (handle_right, handle_bottom, handle_left, handle_top) =
                (rect.x + rect.width, rect.y + rect.height, rect.x, rect.y);
            geometry.polygon(
                &[
                    Vec2::new(handle_right, handle_bottom),
                    Vec2::new(handle_left, handle_bottom),
                    Vec2::new(handle_right, handle_top),
                ],
                base_z + 0.001,
                theme.token_u32("canvasResizeHandle"),
            );
            for offset in [5.0_f32, 10.0] {
                geometry.line(
                    Vec2::new(handle_left + offset, handle_bottom - 2.5),
                    Vec2::new(handle_right - 2.5, handle_top + offset),
                    1.0,
                    base_z + 0.002,
                    theme.token_u32("canvasResizeHandleStripe"),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Projected footprint of a model box, as `badge_bottom_polygon` emits it.
    fn floor(span: f32) -> [Vec2; 5] {
        [
            Vec2::ZERO,
            Vec2::new(span, 0.),
            Vec2::new(span, span * 0.4),
            Vec2::new(0., span * 0.4),
            Vec2::ZERO,
        ]
    }

    #[test]
    fn floor_outline_stroke_scales_with_the_model_box_and_stays_bounded() {
        // A few-metre film set keeps the structural-frame hairline weight.
        assert_eq!(floor_stroke_width(&floor(300.)), BADGE_FLOOR_STROKE_MIN);
        // A migrated ~150 m street set (~9 000 canvas px) grows with the box instead of vanishing.
        assert!(floor_stroke_width(&floor(9_000.)) >= 6.);
        // Interior close-ups never turn the outline into a slab.
        assert_eq!(
            floor_stroke_width(&floor(1_000_000.)),
            BADGE_FLOOR_STROKE_MAX
        );
        // Between the bounds the width is proportional to the footprint.
        assert!((floor_stroke_width(&floor(2_000.)) - 3.0).abs() < 0.001);
    }
}
