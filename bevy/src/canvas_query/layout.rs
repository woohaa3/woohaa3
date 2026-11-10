//! 2D 画布纯布局/文案函数（change: refactor-bevy-runtime-modules，任务 3.1 / design D6）。
//!
//! 只依赖协议类型与 Bevy 数学/颜色，不持有 ECS 状态、不读写 bridge。

use bevy::prelude::*;

use crate::protocol::GraphNode;

/// 右下角 resize 抓手边长，必须与 contracts 的 `RESIZE_HANDLE_SIZE` 一致
/// （change: add-node-resize；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const RESIZE_HANDLE_SIZE: f32 = 20.0;

/// 节点右上角历史动作命中区边长；下载控件高度复用该数值。历史上的右上角历史动作已移除
/// （change: 2026-10-12-unify-generation-history-strip），保留常量供下载命中区沿用。
pub(crate) const NODE_HISTORY_ACTION_SIZE: f32 = 28.0;

/// 历史条视觉高度，必须与 contracts 的 `NODE_HISTORY_STRIP_HEIGHT` 一致
/// （change: 2026-10-12-unify-generation-history-strip）。
pub(crate) const NODE_HISTORY_STRIP_HEIGHT: f32 = 16.0;
/// 历史条圆点半径，必须与 contracts 的 `NODE_HISTORY_STRIP_DOT_RADIUS` 一致。
pub(crate) const NODE_HISTORY_STRIP_DOT_RADIUS: f32 = 2.6;
/// 历史条圆点间隙，必须与 contracts 的 `NODE_HISTORY_STRIP_DOT_GAP` 一致。
pub(crate) const NODE_HISTORY_STRIP_DOT_GAP: f32 = 6.0;
/// 历史条与节点下缘的间隙，必须与 contracts 的 `NODE_HISTORY_STRIP_GAP` 一致。
pub(crate) const NODE_HISTORY_STRIP_GAP: f32 = 4.0;
/// 历史条最左侧历史图标区域宽度，必须与 contracts 的 `NODE_HISTORY_STRIP_ICON_SIZE` 一致。
pub(crate) const NODE_HISTORY_STRIP_ICON_SIZE: f32 = 18.0;
/// 历史条整体左右内边距，必须与 contracts 的 `NODE_HISTORY_STRIP_PADDING` 一致。
pub(crate) const NODE_HISTORY_STRIP_PADDING: f32 = 6.0;
/// 历史条圆角半径，必须与 contracts 的 `NODE_HISTORY_STRIP_RADIUS` 一致。
pub(crate) const NODE_HISTORY_STRIP_RADIUS: f32 = 6.0;

/// 连线删除按钮边长，必须与 contracts 的 `EDGE_DELETE_BUTTON_SIZE` 一致
/// （change: add-edge-hover-delete；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const EDGE_DELETE_BUTTON_SIZE: f32 = 18.0;

/// 连线标签胶囊**最大**宽度，必须与 contracts 的 `EDGE_LABEL_MAX_WIDTH` 一致。
///
/// 实际宽度按文本内容收缩（`edge_label_width`）：固定 104px 会把两个字的标签画成八个字宽，
/// 并把删除按钮推到离曲线很远的位置（修复：标签过宽导致删除按钮点不到）。
pub(crate) const EDGE_LABEL_MAX_WIDTH: f32 = 104.0;
/// 连线标签胶囊高度，必须与 contracts 的 `EDGE_LABEL_HEIGHT` 一致。
pub(crate) const EDGE_LABEL_HEIGHT: f32 = 24.0;
/// 连线标签字号（世界单位），必须与 contracts 的 `EDGE_LABEL_FONT` 一致。
pub(crate) const EDGE_LABEL_FONT: f32 = 11.0;
/// 连线标签胶囊左右内边距（世界单位），必须与 contracts 的 `EDGE_LABEL_PADDING` 一致。
pub(crate) const EDGE_LABEL_PADDING: f32 = 8.0;
/// 标签与删除按钮之间的间隙，必须与 contracts 的 `EDGE_DELETE_BUTTON_GAP` 一致。
pub(crate) const EDGE_DELETE_BUTTON_GAP: f32 = 4.0;
/// 删除按钮的命中外扩，必须与 contracts 的 `EDGE_DELETE_HIT_PADDING` 一致
/// （修复：删除按钮悬停丢失）。
pub(crate) const EDGE_DELETE_HIT_PADDING: f32 = 4.0;
/// 悬停连线时「线体 → 标签 → 删除按钮」连续命中区的外扩，必须与 contracts 的
/// `EDGE_HOVER_BRIDGE_PADDING` 一致（修复：删除按钮悬停丢失）。
pub(crate) const EDGE_HOVER_BRIDGE_PADDING: f32 = 8.0;

/// 连线标签胶囊宽度：按文本内容收缩，超长文本封顶到 `EDGE_LABEL_MAX_WIDTH`。
///
/// 与 contracts `edgeLabelWidth` 同一启发式；空标签返回 0（不占位、按钮居中于中点）。
pub(crate) fn edge_label_width(label: &str) -> f32 {
    if label.is_empty() {
        return 0.0;
    }
    (estimated_text_width(label, EDGE_LABEL_FONT) + EDGE_LABEL_PADDING * 2.0)
        .min(EDGE_LABEL_MAX_WIDTH)
}

/// 连线标签的绘制文本：内容宽度未超过上限时原样保留，超长时才按最大文本宽度截断。
///
/// 不能直接把 `edge_label_width - padding` 交给 [`shortened`]：后者会固定预留一个省略号的
/// 宽度，即使文本本来放得下也会把最后一个字换成「…」（两个字变「图…」）。
pub(crate) fn edge_label_text(label: &str) -> String {
    let text_width = estimated_text_width(label, EDGE_LABEL_FONT);
    if text_width + EDGE_LABEL_PADDING * 2.0 <= EDGE_LABEL_MAX_WIDTH {
        label
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect()
    } else {
        shortened(
            label,
            EDGE_LABEL_MAX_WIDTH - EDGE_LABEL_PADDING * 2.0,
            EDGE_LABEL_FONT,
        )
    }
}

/// `0xRRGGBB` → sRGB 颜色。
pub(crate) fn hex(value: u32) -> Color {
    Color::srgb_u8((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

/// 节点「丰富卡片」的高度阈值（超过即显示正文/状态内容区）。
pub(crate) const RICH_NODE_HEIGHT: f32 = 116.0;

/// 节点是否有内容区（富内容卡片）。运行中进度环也复用该门禁
/// （change: add-node-running-progress）：只有会显示内容区的节点才用进度环替代它。
///
/// 旧卡片模型（`kind == "model"` 且没有世界实例）显示通用诊断卡片，正文就是诊断文案，
/// 因此普通内容区规则同样适用（change: 2026-11-10-remove-legacy-model-card-nodes）。
pub(crate) fn shows_content(node: &GraphNode) -> bool {
    node.chrome.is_card() && node.height > RICH_NODE_HEIGHT
}

/// 节点内容区矩形 `(x, y, width, height)`：左右与底部各留 16px 内边距，顶部为标签行
/// （52px）。状态文案已移除（change: add-node-running-progress），内容区不再为底部状态行
/// 预留空间，而是延伸到卡片底部内缘。
pub(crate) fn content_rect(node: &GraphNode) -> (f32, f32, f32, f32) {
    content_rect_for_bounds(node.x, node.y, node.width, node.height)
}

pub(crate) fn content_rect_for_bounds(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) -> (f32, f32, f32, f32) {
    (
        x + 16.,
        y + 52.,
        (width - 32.).max(1.),
        (height - 68.).max(24.),
    )
}

/// 内容区中心（纹理 Sprite 的锚点）。
pub(crate) fn content_center(node: &GraphNode) -> Vec2 {
    let (x, y, width, height) = content_rect(node);
    Vec2::new(x + width / 2., y + height / 2.)
}

/// 图片内容区尺寸：在节点内容框内按纹理自身宽高比 **contain**（不拉伸、不裁剪）。
/// 节点可自由缩放为任意宽高比；媒体始终按自身比例缩放并居中。
pub(crate) fn texture_size(node: &GraphNode, texture: Vec2) -> Vec2 {
    let (_, _, box_width, box_height) = content_rect(node);
    let scale = (box_width / texture.x).min(box_height / texture.y);
    Vec2::new((texture.x * scale).max(1.), (texture.y * scale).max(1.))
}

/// 命中半径（世界坐标）：随缩放放宽，与既有 JS `hitRadius` 一致
/// （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 2.4）。
pub(crate) fn hit_radius(zoom: f32) -> f32 {
    (10.0 / zoom).max(10.0)
}

/// A 24-unit button acquires at its normal hit radius, then follows for one
/// full button diameter. The anchor stays fixed so it cannot be dragged away.
pub(crate) fn magnetic_port_center(
    anchor: Vec2,
    hover: &crate::protocol::NodeHover,
    side: &str,
) -> Vec2 {
    if hover.port.as_deref() == Some(side)
        && let Some(cursor) = hover.cursor
    {
        return anchor + (Vec2::new(cursor.x, cursor.y) - anchor).clamp_length_max(24.0);
    }
    anchor
}

pub(crate) fn magnetic_port_radius(zoom: f32) -> f32 {
    hit_radius(zoom).max(12.0) + 24.0
}

/// 边命中距离（世界坐标）：7 / zoom，与既有 JS 判定一致。
pub(crate) fn edge_hit_distance(zoom: f32) -> f32 {
    7.0 / zoom
}

/// 历史条命中矩形 `(x, y, width, height)`；与 contracts 的 `bevyNodeHistoryStripRect` 同一
/// 公式：圆点行在节点内部底部，左右留空避让 resize 抓手。
/// （change: 2026-10-12-unify-generation-history-strip）。
pub(crate) fn history_strip_rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    (
        x + 24.0,
        y + height - NODE_HISTORY_STRIP_GAP - NODE_HISTORY_STRIP_HEIGHT,
        (width - 48.0).max(1.0),
        NODE_HISTORY_STRIP_HEIGHT,
    )
}

/// 历史条最左侧历史图标中心；与 contracts `bevyNodeHistoryStripIcon` 同公式。
pub(crate) fn history_strip_icon(x: f32, y: f32, width: f32, height: f32) -> Vec2 {
    let (sx, sy, _sw, sh) = history_strip_rect(x, y, width, height);
    Vec2::new(
        sx + NODE_HISTORY_STRIP_PADDING + NODE_HISTORY_STRIP_ICON_SIZE / 2.0,
        sy + sh / 2.0,
    )
}

/// Scope nameplate baseline dimensions; ground scopes follow the lower-left edge.
pub(crate) const SCENE_AREA_LABEL_HEIGHT: f32 = 22.0;
pub(crate) const SCENE_AREA_LABEL_TEXT_SIZE: f32 = 12.0;
/// Zoomed-out titles aim for an 18 CSS-pixel height when their edge has room.
const SCOPE_LABEL_MIN_SCREEN_HEIGHT: f32 = 18.0;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SceneAreaLabelGeometry {
    pub(crate) node_id: String,
    /// 标签中心（canvas 坐标，y 向下）。
    pub(crate) center: Vec2,
    /// 单位方向（canvas 坐标）；标签局部 +x 轴对齐该方向。
    pub(crate) axis: Vec2,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

fn safe_zoom(zoom: f32) -> f32 {
    if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    }
}

/// Only compensate below 18/22 zoom. Scale the full capsule uniformly, with
/// a 72% edge budget so tiny scopes retain their place in the visual hierarchy.
fn scope_label_scale(edge_length: f32, zoom: f32) -> f32 {
    let base_width = (edge_length * 0.72).clamp(56.0, 200.0);
    let desired =
        (SCOPE_LABEL_MIN_SCREEN_HEIGHT / (SCENE_AREA_LABEL_HEIGHT * safe_zoom(zoom))).max(1.0);
    desired.min((edge_length * 0.72 / base_width).max(1.0))
}

impl SceneAreaLabelGeometry {
    pub(crate) fn scale(&self) -> f32 {
        self.height / SCENE_AREA_LABEL_HEIGHT
    }
    pub(crate) fn text_size(&self) -> f32 {
        SCENE_AREA_LABEL_TEXT_SIZE * self.scale()
    }
    pub(crate) fn padding(&self) -> f32 {
        crate::scope_visual::LABEL_PADDING * self.scale()
    }
}

/// 地面 `(u, v)` → canvas 坐标（与 web `worldToCanvasPoint` 同一等距投影）。
fn scene_area_canvas_point(u: f64, v: f64) -> Vec2 {
    let [x, _, z] = crate::protocol::world_to_renderer([u, v, 0.0]);
    let point = crate::isometric_grid::view_rotation() * Vec3::new(x as f32, 0.0, z as f32);
    Vec2::new(point.x, -point.y)
}

/// 导演区地面范围的投影四角（canvas 坐标）；非法范围返回 `None`。
pub(crate) fn scene_area_canvas_corners(bounds: &crate::protocol::SceneAreaBounds) -> Option<[Vec2; 4]> {
    if ![bounds.min.u, bounds.min.v, bounds.max.u, bounds.max.v]
        .iter()
        .all(|value| value.is_finite())
        || bounds.min.u > bounds.max.u
        || bounds.min.v > bounds.max.v
    {
        return None;
    }
    Some([
        scene_area_canvas_point(bounds.min.u, bounds.min.v),
        scene_area_canvas_point(bounds.max.u, bounds.min.v),
        scene_area_canvas_point(bounds.max.u, bounds.max.v),
        scene_area_canvas_point(bounds.min.u, bounds.max.v),
    ])
}

/// 从导演区地面范围派生标签几何；非法/退化范围返回 `None`（不画也不命中）。
///
/// 标签放在投影后**左下**边框的中点，并旋转到与该边框平行，视觉上斜贴在 3D 线框上。
pub(crate) fn scene_area_label_geometry(
    area: &crate::protocol::SceneArea,
) -> Option<SceneAreaLabelGeometry> {
    scene_area_label_geometry_for_zoom(area, 1.0)
}

pub(crate) fn scene_area_label_geometry_for_zoom(
    area: &crate::protocol::SceneArea,
    zoom: f32,
) -> Option<SceneAreaLabelGeometry> {
    let corners = scene_area_canvas_corners(&area.bounds)?;
    // 标签固定在**左下边**：取投影后最左角与最下角之间的那条边框。
    let mut left = 0;
    let mut bottom = 0;
    for index in 1..4 {
        if corners[index].x < corners[left].x {
            left = index;
        }
        if corners[index].y > corners[bottom].y {
            bottom = index;
        }
    }
    let adjacent = |first: usize, second: usize| -> Option<(Vec2, Vec2)> {
        if (first + 1) % 4 == second {
            Some((corners[first], corners[second]))
        } else if (second + 1) % 4 == first {
            Some((corners[second], corners[first]))
        } else {
            None
        }
    };
    // 退化投影（某轴宽度为 0）时退回最靠左下的边。
    let fallback = (0..4)
        .map(|index| {
            let a = corners[index];
            let b = corners[(index + 1) % 4];
            ((a + b) * 0.5, a, b)
        })
        .max_by(|left, right| (left.0.y - left.0.x).total_cmp(&(right.0.y - right.0.x)))
        .map(|(_, a, b)| (a, b))?;
    let (a, b) = adjacent(left, bottom).unwrap_or(fallback);
    let length = a.distance(b);
    if !length.is_finite() || length <= 1e-4 {
        return None;
    }
    let mut axis = (b - a) / length;
    // 保证文字正向可读：局部 +x 不朝左；竖直边时朝上。
    if axis.x < -1e-4 || (axis.x.abs() <= 1e-4 && axis.y > 0.0) {
        axis = -axis;
    }
    Some(SceneAreaLabelGeometry {
        node_id: area.node_id.clone(),
        center: (a + b) * 0.5,
        axis,
        width: (length * 0.72).clamp(56.0, 200.0) * scope_label_scale(length, zoom),
        height: SCENE_AREA_LABEL_HEIGHT * scope_label_scale(length, zoom),
    })
}

/// 胶囊轮廓（canvas 坐标，y 向下）；绘制与命中共用同一几何。
pub(crate) fn scene_area_label_outline(geometry: &SceneAreaLabelGeometry) -> Vec<Vec2> {
    let radius = (crate::scope_visual::LABEL_RADIUS * geometry.height / SCENE_AREA_LABEL_HEIGHT)
        .min(geometry.width / 2.0)
        .min(geometry.height / 2.0);
    let local = crate::scope_visual::rounded_path(
        -geometry.width / 2.0,
        -geometry.height / 2.0,
        geometry.width,
        geometry.height,
        radius,
    );
    let (sin, cos) = (geometry.axis.y, geometry.axis.x);
    local
        .into_iter()
        .map(|point| {
            geometry.center
                + Vec2::new(point.x * cos - point.y * sin, point.x * sin + point.y * cos)
        })
        .collect()
}

/// 标签文字在 Bevy 2D（y 向上）中的旋转角。
pub(crate) fn scene_area_label_rotation(geometry: &SceneAreaLabelGeometry) -> f32 {
    -geometry.axis.y.atan2(geometry.axis.x)
}

/// 2D scope title uses the same dimensions and contour as ground scope labels.
pub(crate) fn workflow_group_label_geometry(node: &GraphNode) -> Option<SceneAreaLabelGeometry> {
    workflow_group_label_geometry_for_zoom(node, 1.0)
}

pub(crate) fn workflow_group_label_geometry_for_zoom(
    node: &GraphNode,
    zoom: f32,
) -> Option<SceneAreaLabelGeometry> {
    if !matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
        return None;
    }
    Some(workflow_group_label_for_bounds(
        &node.id,
        (node.x, node.y, node.width, node.height),
        zoom,
    ))
}

pub(crate) fn workflow_group_label_for_bounds(
    id: &str,
    (x, y, width, _height): (f32, f32, f32, f32),
    zoom: f32,
) -> SceneAreaLabelGeometry {
    let scale = scope_label_scale(width, zoom);
    let label_width = (width * 0.72).clamp(56.0, 200.0) * scale;
    SceneAreaLabelGeometry {
        node_id: id.to_owned(),
        center: Vec2::new(x + 12.0 + label_width / 2.0, y),
        axis: Vec2::X,
        width: label_width,
        height: SCENE_AREA_LABEL_HEIGHT * scale,
    }
}

/// All scope labels, shared by painting and pointer hit testing.
pub(crate) fn scene_area_labels(scene: &crate::protocol::Scene) -> Vec<SceneAreaLabelGeometry> {
    if scene.model_focus.is_some() || scene.image_focus.is_some() || scene.video_focus.is_some() {
        return Vec::new();
    }
    let zoom = scene.viewport.zoom;
    scene
        .scene_areas
        .iter()
        .filter_map(|area| scene_area_label_geometry_for_zoom(area, zoom))
        .chain(
            scene
                .nodes
                .iter()
                .filter_map(|node| workflow_group_label_geometry_for_zoom(node, zoom)),
        )
        .collect()
}

/// 第 `index` 个圆点中心，紧凑居中排列；与 contracts 同公式。
pub(crate) fn history_strip_dot(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    index: usize,
    count: usize,
) -> Vec2 {
    let (sx, sy, sw, sh) = history_strip_rect(x, y, width, height);
    let count = count.max(1);
    let usable = (sw - 2.0 * NODE_HISTORY_STRIP_PADDING).max(0.0);
    let step = if count > 1 {
        (usable / (count - 1) as f32).min(12.0)
    } else {
        0.0
    };
    let cx = sx + sw / 2.0 + (index as f32 - (count - 1) as f32 / 2.0) * step;
    Vec2::new(cx, sy + sh / 2.0)
}

/// 普通节点有至少两个版本时绘制内部圆点：非 ghost。
pub(crate) fn has_history_strip(node: &GraphNode) -> bool {
    node.chrome.is_card()
        && !node.ghost
        && node.history_strip.as_ref().is_some_and(|strip| {
            strip.dots.len() > 1
                || strip
                    .dots
                    .iter()
                    .any(|dot| dot.state != "succeeded" || dot.recoverable == Some(false))
        })
}

/// 运行中节点是否应显示逐帧进度环。
///
/// 覆盖所有普通运行节点（含紧凑节点与纯模型预览节点）：`shows_content` 只描述富内容卡片，
/// 会漏掉 196x64 的紧凑模型/纯模型节点。
pub(crate) fn shows_generation_ring(node: &GraphNode) -> bool {
    node.chrome.is_card() && node.busy
}

/// 运行进度环承载矩形：富内容节点用内容区；紧凑节点用卡片内缩矩形。
pub(crate) fn generation_ring_rect(node: &GraphNode) -> (f32, f32, f32, f32) {
    if shows_content(node) {
        return content_rect(node);
    }
    let inset = 6.0;
    (
        node.x + inset,
        node.y + inset,
        (node.width - inset * 2.0).max(1.0),
        (node.height - inset * 2.0).max(1.0),
    )
}

/// 右下角 resize 抓手命中矩形 `(x, y, width, height)`；与 contracts 的
/// `bevyResizeHandleRect` 同一公式（贴住右下角内缘）。
pub(crate) fn resize_rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
    (
        x + width - RESIZE_HANDLE_SIZE,
        y + height - RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE,
        RESIZE_HANDLE_SIZE,
    )
}

/// 普通卡片四角 resize 命中矩形，顺序 `nw, ne, sw, se`；抓手位于卡片内侧，
/// 这样空间索引仍能以卡片本体 AABB 覆盖所有命中区域。
pub(crate) fn resize_corner_rects(
    x: f32,
    y: f32,
    width: f32,
    height: f32,
) -> [(f32, f32, f32, f32); 4] {
    let size = RESIZE_HANDLE_SIZE;
    [
        (x, y, size, size),
        (x + width - size, y, size, size),
        (x, y + height - size, size, size),
        (x + width - size, y + height - size, size, size),
    ]
}

/// 连线删除按钮的**中心**：无标签时居中于两端口中点，有标签时排在标签胶囊右侧
/// （与 contracts `bevyEdgeDeleteRect` 同一公式）。`label_width` 由 `edge_label_width` 给出，
/// 因此窄标签不会把按钮推远。
pub(crate) fn edge_delete_center(source: Vec2, target: Vec2, label_width: f32) -> Vec2 {
    let mid = (source + target) / 2.0;
    if label_width > 0.0 {
        Vec2::new(
            mid.x + label_width / 2.0 + EDGE_DELETE_BUTTON_GAP + EDGE_DELETE_BUTTON_SIZE / 2.0,
            mid.y,
        )
    } else {
        mid
    }
}

/// 连线删除按钮的命中矩形 `(x, y, width, height)`（绕中心的正方形）。
pub(crate) fn edge_delete_rect(center: Vec2) -> (f32, f32, f32, f32) {
    (
        center.x - EDGE_DELETE_BUTTON_SIZE / 2.0,
        center.y - EDGE_DELETE_BUTTON_SIZE / 2.0,
        EDGE_DELETE_BUTTON_SIZE,
        EDGE_DELETE_BUTTON_SIZE,
    )
}

/// 连线删除按钮的**命中**矩形：视觉矩形外扩 `EDGE_DELETE_HIT_PADDING`。
///
/// 补上按钮与标签胶囊之间的间隙，并给 18px 的按钮留出点击余量
/// （修复：删除按钮悬停丢失）。
pub(crate) fn edge_delete_hit_rect(center: Vec2) -> (f32, f32, f32, f32) {
    let (x, y, width, height) = edge_delete_rect(center);
    (
        x - EDGE_DELETE_HIT_PADDING,
        y - EDGE_DELETE_HIT_PADDING,
        width + EDGE_DELETE_HIT_PADDING * 2.0,
        height + EDGE_DELETE_HIT_PADDING * 2.0,
    )
}

/// 连线标签胶囊矩形 `(x, y, width, height)`，与 Bevy 绘制标签背景共用同一中点与尺寸。
pub(crate) fn edge_label_rect(
    source: Vec2,
    target: Vec2,
    label_width: f32,
) -> (f32, f32, f32, f32) {
    let mid = (source + target) / 2.0;
    (
        mid.x - label_width / 2.0,
        mid.y - EDGE_LABEL_HEIGHT / 2.0,
        label_width,
        EDGE_LABEL_HEIGHT,
    )
}

/// 悬停连线时维持悬停的连续命中区 `(x, y, width, height)`。
///
/// 覆盖标签胶囊与删除按钮命中区（含外扩）：指针从线体经标签走到按钮时不再落进死区。
/// 该区域只维持悬停，不触发删除（修复：删除按钮悬停丢失）。
pub(crate) fn edge_hover_bridge_rect(
    source: Vec2,
    target: Vec2,
    label_width: f32,
) -> (f32, f32, f32, f32) {
    let center = edge_delete_center(source, target, label_width);
    let button = edge_delete_hit_rect(center);
    if label_width <= 0.0 {
        return button;
    }
    let label = edge_label_rect(source, target, label_width);
    expand(union(label, button), EDGE_HOVER_BRIDGE_PADDING)
}

/// 合并两个矩形 `(x, y, width, height)`。
fn union(a: (f32, f32, f32, f32), b: (f32, f32, f32, f32)) -> (f32, f32, f32, f32) {
    let left = a.0.min(b.0);
    let top = a.1.min(b.1);
    let right = (a.0 + a.2).max(b.0 + b.2);
    let bottom = (a.1 + a.3).max(b.1 + b.3);
    (left, top, right - left, bottom - top)
}

/// 四周外扩矩形。
fn expand(rect: (f32, f32, f32, f32), padding: f32) -> (f32, f32, f32, f32) {
    (
        rect.0 - padding,
        rect.1 - padding,
        rect.2 + padding * 2.0,
        rect.3 + padding * 2.0,
    )
}

/// 点是否落在矩形 `(x, y, width, height)` 内（边界包含）。
pub(crate) fn in_rect(point: Vec2, rect: (f32, f32, f32, f32)) -> bool {
    point.x >= rect.0
        && point.x <= rect.0 + rect.2
        && point.y >= rect.1
        && point.y <= rect.1 + rect.3
}

// ── 节点顶部操作横条布局（change: 2026-10-13-add-node-to-film-set-shortcut）──────────────
//
// 横条由 Bevy 在画布内绘制、由 Rust interaction snapshot 命中；绘制与命中共用本模块的同一
// 派生，保证「画在哪、点在哪」一致。尺寸与间距用**世界单位**，随画布 zoom 一起缩放，与历史
// 按钮/resize 抓手/拖动粘连操作条等既有画布内 chrome 一致。常量必须与 contracts
// `render-scene/node-action-toolbar.ts` 一致（由 `render-scene.test.ts` 断言两边相同）。

/// 横条与节点之间固定的世界间距（design D7「约 8px」）。
pub(crate) const NODE_ACTION_TOOLBAR_GAP: f32 = 8.0;
/// 单个动作控件高度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_HEIGHT: f32 = 32.0;
/// 横条容器上下内边距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_PAD: f32 = 4.0;
/// 单个动作控件的最小宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH: f32 = 56.0;
/// 动作标签与控件边缘的水平内边距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_ACTION_PAD: f32 = 8.0;
/// 图标与文字同时呈现时的图标格尺寸（与 contracts 同步）。
pub(crate) const NODE_ACTION_TOOLBAR_ICON_SIZE: f32 = 16.0;
/// 图标与文字之间的水平间距（与 contracts 同步）。
pub(crate) const NODE_ACTION_TOOLBAR_ICON_GAP: f32 = 6.0;
/// 设置箭头独立宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_CHEVRON_WIDTH: f32 = 24.0;

/// 节点动作槽里「图标 + 文案」整块的横向起点（屏幕像素，相对槽左边缘）。
///
/// 动作槽至少有 `NODE_ACTION_TOOLBAR_ACTION_MIN_WIDTH` 宽以保可点区域；短文案若始终贴左内边距，
/// 槽右侧会空出一大块看起来没对齐（「试听」这类两字动作最明显）。槽有富余时把整块内容居中，
/// 没有富余（文案把槽撑满）时退回左内边距。
pub(crate) fn node_action_content_x(slot_width: f32, label: &str, has_icon: bool) -> f32 {
    let icon_width = if has_icon {
        NODE_ACTION_TOOLBAR_ICON_SIZE + NODE_ACTION_TOOLBAR_ICON_GAP
    } else {
        0.0
    };
    let spare = slot_width - icon_width - estimated_text_width(label, NODE_ACTION_TOOLBAR_FONT);
    if spare > NODE_ACTION_TOOLBAR_ACTION_PAD * 2.0 {
        spare / 2.0
    } else {
        NODE_ACTION_TOOLBAR_ACTION_PAD
    }
}
/// 动作分组之间的细分隔线占位宽度（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SEPARATOR: f32 = 2.0;
/// 动作标签字号与模型名摘要字号（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_FONT: f32 = 13.0;
/// 模型名摘要与动作之间的水平间距（世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SUMMARY_GAP: f32 = 8.0;
/// 摘要最大宽度（超出省略，世界单位）。
pub(crate) const NODE_ACTION_TOOLBAR_SUMMARY_MAX_WIDTH: f32 = 280.0;
/// 顶部碰撞回退判定所用的视口安全边距（屏幕像素）。
pub(crate) const NODE_ACTION_TOOLBAR_VIEWPORT_MARGIN: f32 = 8.0;

mod node_action_toolbar;

pub(crate) use node_action_toolbar::{
    NodeActionLayout, NodeActionSlot, node_action_toolbar, node_action_toolbar_for_bounds,
    truncate_node_action_text,
};

/// 连接端口：输入在左中、输出在右中。
pub(crate) fn port(node: &GraphNode, output: bool) -> Vec2 {
    port_for_bounds(node.x, node.y, node.width, node.height, output)
}

pub(crate) fn port_for_bounds(x: f32, y: f32, width: f32, height: f32, output: bool) -> Vec2 {
    Vec2::new(x + if output { width } else { 0.0 }, y + height / 2.0)
}

/// 单字估算宽度：ASCII 约 0.62em，其余（含 CJK）按 1em；控制字符替换为空格（宽度同空格）。
pub(crate) fn estimated_char_width(c: char, size: f32) -> f32 {
    if c.is_control() {
        size * 0.62
    } else if c.is_ascii() {
        size * 0.62
    } else {
        size
    }
}

/// 逐字估算整段文本宽度（与 [`shortened`] 同一启发式，供标题底衬等需要实际宽度的场景复用）。
pub(crate) fn estimated_text_width(text: &str, size: f32) -> f32 {
    text.chars().map(|c| estimated_char_width(c, size)).sum()
}

/// 主 2D 覆盖层相机在聚焦/预览时是否可见。
///
/// 片场标题、虚线框与编辑抓手只由 2D 覆盖层相机绘制
/// （change: 2026-10-10-improve-film-set-editing-and-inspector，design D1）。聚焦镜头预览、
/// 截图、离屏历史预览与视频导出都切换为透视聚焦相机并停用这张 2D 相机，因此成片结构上
/// 不会包含标题或编辑工具。放在 host 可编译的纯模块，便于直接测试该不变量。
pub(crate) fn overlay_camera2d_active(focused: bool) -> bool {
    !focused
}

/// 标签实体池的纯生命周期规划：给定已有数量与期望数量，返回
/// `(需原地更新数量, 需补建数量, 需回收数量, 是否保留池条目)`。
///
/// 这是片场标题 `0 → 1 → 0 → 1` 反复显隐的核心不变量（change:
/// 2026-10-10-improve-film-set-editing-and-inspector，design D2）：
/// - 期望为空时 `retain == false`，池条目被移除，使下一次期望非空可以从零补建；
/// - 只 zip 已存在实体（旧实现）会让「先隐藏再显示」丢字，这里显式建模并测试。
pub(crate) fn label_pool_plan(existing: usize, desired: usize) -> (usize, usize, usize, bool) {
    (
        existing.min(desired),
        desired.saturating_sub(existing),
        existing.saturating_sub(desired),
        desired > 0,
    )
}

/// 内容区底部为历史条预留的高度（历史条自身 + 间隙）。
const BODY_FOOTER: f32 = 20.0;

/// 富内容卡片正文行数上限：正文从 `y + 56` 起、行距 18，按默认卡片高度留出底部历史条，
/// 与标签槽位数保持一致（每张卡片固定产出 `BODY_MAX_LINES` 个正文槽位，空槽位不显示）。
pub(crate) const BODY_MAX_LINES: usize = 6;

/// 富内容卡片正文可用行数：正文从 `y + 56` 起、行距 18，且不能压到底部历史条。
///
/// 默认高度（232）算满即达 `BODY_MAX_LINES`；卡片被压矮时减少行数，避免正文盖住底部历史条。
pub(crate) fn body_line_budget(height: f32) -> usize {
    let available = (height - BODY_FOOTER - 56.0).max(0.0);
    ((available / 18.0).floor() as usize).clamp(1, BODY_MAX_LINES)
}

/// 按估算宽度截断文本；超出时追加省略号，控制字符替换为空格。
pub(crate) fn shortened(text: &str, max_width: f32, size: f32) -> String {
    let mut width = 0.0;
    let mut result = String::new();
    for c in text.chars() {
        width += estimated_char_width(c, size);
        if width > max_width - size {
            result.push('…');
            break;
        }
        result.push(if c.is_control() { ' ' } else { c });
    }
    result
}

/// 按估算宽度贪心换行；只有超过 `max_lines` 才在最后一行追加省略号。
///
/// 卡片正文（尤其历史失败/取消原因）必须先用满预览区宽度再换行，不能在第一行提前省略。
/// 保留显式换行（`\n`）；控制字符替换为空格。断行优先落在词间空格，整行放得下的单词不拆开；
/// 单个超长单词（如无空格的 URL、哈希、长英文标识）才按字符切分。
pub(crate) fn wrapped_lines(
    text: &str,
    max_width: f32,
    size: f32,
    max_lines: usize,
) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let limit = max_width.max(size);
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        wrap_paragraph(paragraph, limit, size, &mut lines);
    }
    while lines.len() > 1 && lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        if let Some(last) = lines.last_mut() {
            *last = shortened(&format!("{last}…"), limit, size);
        }
    }
    lines
}

/// 贪心填充单个段落（不含 `\n`）到 `lines`。
///
/// 以空白分隔词，整词放得下就追加（词间保留一个空格）；放不下就换行后再放；只有单行都放不
/// 下的长词才按字符切分。空段落保留一个空行，与显式 `\n` 的语义一致。
fn wrap_paragraph(paragraph: &str, limit: f32, size: f32, lines: &mut Vec<String>) {
    let chars: Vec<char> = paragraph
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    // 空段落（含只有空白的段落）保留一行空行，避免正文里段落间隔被吞掉。
    if chars.iter().all(|c| c.is_whitespace()) {
        lines.push(String::new());
        return;
    }
    let mut line = String::new();
    let mut width = 0.0f32;
    let mut pending_space = false;
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_whitespace() {
            // 词间空白压缩成一个空格，行首空白丢弃。
            pending_space = !line.is_empty();
            index += 1;
            continue;
        }
        let start = index;
        while index < chars.len() && !chars[index].is_whitespace() {
            index += 1;
        }
        let word: String = chars[start..index].iter().collect();
        let space_width = if pending_space {
            estimated_char_width(' ', size)
        } else {
            0.0
        };
        let word_width = estimated_text_width(&word, size);
        if width + space_width + word_width <= limit {
            if pending_space {
                line.push(' ');
                width += space_width;
            }
            line.push_str(&word);
            width += word_width;
        } else if word_width <= limit {
            // 整词放不下但自己占得下一行：换行，不在行尾留空格。
            lines.push(std::mem::take(&mut line));
            line.push_str(&word);
            width = word_width;
        } else {
            // 单个长词超过整行：换行后按字符切分。
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                width = 0.0;
            }
            for c in word.chars() {
                let char_width = estimated_char_width(c, size);
                if width + char_width > limit && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    width = 0.0;
                }
                line.push(c);
                width += char_width;
            }
        }
        pending_space = false;
    }
    lines.push(line);
}

#[cfg(test)]
mod tests;
