//! 便签卡片：一张纸色小卡，正文按行铺满，整体略微倾斜。
//!
//! 与普通卡片刻意画得不一样：没有内容区、没有种类符号、没有标题行 ——
//! 便签只有"一张纸 + 一段字"，读法越接近真便签越好。
//!
//! 颜色全部来自主题 token（`canvasSticky*`），亮暗主题各自一套；
//! 倾斜角是固定的呈现细节，不随主题变，所以写成常量。

use std::f32::consts::PI;

use super::{geometry::Geometry, labels::Label, layout};
use crate::{protocol::GraphNode, theme::ThemeResource};
use bevy::prelude::*;

/// 便签正文的字号。比卡片标题大一档 —— 便签是要被读的，不是被扫的。
const NOTE_FONT: f32 = 14.0;
/// 正文字距。
const NOTE_LINE_HEIGHT: f32 = 20.0;
/// 纸内边距（文字到纸边）。
const NOTE_PAD: f32 = 14.0;
/// 纸的圆角。便签是硬纸片，圆角要比卡片小，但不能是直角 ——
/// 参考稿里四角都是收圆的。
const NOTE_RADIUS: f32 = 6.0;
/// 纸的倾斜角（弧度）。参考稿里便签是斜着放的，这点倾斜让它一眼区别于卡片。
const NOTE_TILT: f32 = -0.035;
/// 投影的竖直偏移。参考稿的影很淡、只往下沉一点，不是一块贴在纸下的黑边。
const NOTE_SHADOW_OFFSET: f32 = 2.5;
/// 投影的水平偏移。参考稿光从左上来，影子略偏右。
const NOTE_SHADOW_DX: f32 = 1.0;
/// 投影相对画布底的浓度（0 = 与画布底同色即不可见，1 = 完全等于阴影色）。
///
/// 因为卡片走不透明材质，阴影必须是**实色**，所以浓淡靠与画布底混色表达，
/// 而不是顶点 alpha（那条路在不透明材质下会被忽略）。参考稿的影极淡，0.10 左右刚好。
const NOTE_SHADOW_STRENGTH: f32 = 0.10;

/// 选中时外发光比纸大出的距离。
const NOTE_SELECT_SPREAD: f32 = 4.0;
/// 选中描边的粗细（纸外沿那一圈色带的宽度）。
const NOTE_SELECT_WIDTH: f32 = 1.7;

/// 绕中心旋转点集。便签整张纸（含投影）都按同一角度转，
/// 否则纸转、影不转，看起来像两层东西叠在一起。
fn rotate_points(points: &[Vec2], center: Vec2, angle: f32) -> Vec<Vec2> {
    let (cos, sin) = (angle.cos(), angle.sin());
    points
        .iter()
        .map(|point| {
            let offset = *point - center;
            center + Vec2::new(offset.x * cos - offset.y * sin, offset.x * sin + offset.y * cos)
        })
        .collect()
}

/// 圆角矩形的顶点序列（未旋转）。
///
/// 与 `Geometry::rounded_rect_radii_alpha` 同一套弧段顺序（右下 → 左下 → 左上 → 右上），
/// 但先产出点、交给调用方旋转后再 `polygon` —— 便签需要"带圆角且倾斜"的形状，
/// 现成的 `rounded_rect*` 只能画轴对齐的。
fn rounded_rect_points(x: f32, y: f32, width: f32, height: f32, radius: f32) -> Vec<Vec2> {
    let limit = width.min(height) / 2.0;
    let r = radius.clamp(0.0, limit);
    if r <= 0.0 {
        return vec![
            Vec2::new(x, y),
            Vec2::new(x + width, y),
            Vec2::new(x + width, y + height),
            Vec2::new(x, y + height),
        ];
    }
    let mut points = Vec::with_capacity(36);
    for (cx, cy, start) in [
        (x + width - r, y + height - r, 0.0),
        (x + r, y + height - r, PI / 2.0),
        (x + r, y + r, PI),
        (x + width - r, y + r, PI * 1.5),
    ] {
        for i in 0..=8 {
            let angle = start + i as f32 * PI / 16.0;
            points.push(Vec2::new(cx + angle.cos() * r, cy + angle.sin() * r));
        }
    }
    points
}

pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    let z = 10.0 + index as f32 * 0.1;
    let (x, y) = (node.x, node.y);
    let (width, height) = (node.width, node.height);
    if width <= 0.0 || height <= 0.0 {
        return Vec::new();
    }

    let center = Vec2::new(x + width / 2.0, y + height / 2.0);

    // 投影：一层**实色**（不是半透明）。
    //
    // 卡片走的是块缓存 + 不透明材质，而 `Geometry::build()` 会把 blend 几何合进同一张
    // mesh，不透明材质**直接忽略顶点 alpha** —— 用 `polygon_alpha` 传 0.16 会原样画出
    // 纯黑（踩过，便签底下是一块黑板）。所以这里按现有卡片阴影的做法，把阴影色与画布底
    // 预先混成"看起来是半透明"的实色。
    //
    // 也不能叠多层：不透明绘制后画的完全覆盖先画的，只有最后一层可见。
    let shadow_color = super::group_motion::mix(
        theme.token_u32("webBackdrop"),
        theme.token_u32("canvasStickyShadow"),
        NOTE_SHADOW_STRENGTH,
    );
    let shadow = rotate_points(
        &rounded_rect_points(
            x + NOTE_SHADOW_DX,
            y + NOTE_SHADOW_OFFSET,
            width,
            height,
            NOTE_RADIUS,
        ),
        center,
        NOTE_TILT,
    );
    geometry.polygon(&shadow, z + 0.001, shadow_color);

    // 纸：圆角矩形，整张跟着倾斜。
    let paper = rotate_points(
        &rounded_rect_points(x, y, width, height, NOTE_RADIUS),
        center,
        NOTE_TILT,
    );
    geometry.polygon(&paper, z + 0.002, theme.token_u32("canvasStickyBorder"));
    // 内缩 1px 的纸面：描边就是纸边本身，不是额外一圈更深的框。
    let face = rotate_points(
        &rounded_rect_points(
            x + 1.0,
            y + 1.0,
            (width - 2.0).max(1.0),
            (height - 2.0).max(1.0),
            (NOTE_RADIUS - 1.0).max(0.0),
        ),
        center,
        NOTE_TILT,
    );
    geometry.polygon(&face, z + 0.003, theme.token_u32("canvasStickySurface"));

    let color = theme.token_u32("canvasStickyText");
    let text_width = (width - NOTE_PAD * 2.0).max(1.0);
    let max_lines = (((height - NOTE_PAD * 2.0) / NOTE_LINE_HEIGHT).floor().max(0.0)) as usize;
    let mut labels = Vec::with_capacity(max_lines.min(8));
    // 文字跟着纸一起倾斜，否则字是正的、纸是斜的，会像贴错位。
    let text_origin = Vec2::new(x + NOTE_PAD, y + NOTE_PAD);
    let place = |index: usize| -> Vec2 {
        let point = text_origin + Vec2::new(0.0, index as f32 * NOTE_LINE_HEIGHT);
        rotate_points(&[point], center, NOTE_TILT)[0]
    };

    let note = node.body.trim();
    if note.is_empty() {
        // 空便签给一行提示色很淡的占位，否则用户看到的是一块纯色纸，不知道能写东西。
        labels.push((
            "双击写点什么…".to_owned(),
            place(0),
            NOTE_FONT,
            theme.token_u32("canvasCloseIcon"),
        ));
        return labels;
    }

    // 正文按显式换行切段，再逐段按宽度折行 —— 便签的长句必须折行，
    // 否则超出纸面直接被裁掉，用户写的东西就"丢了"。
    for (line_index, line) in wrap_note(note, text_width, NOTE_FONT).into_iter().enumerate() {
        if line_index >= max_lines {
            // 放不下的部分用省略号收尾。便签是摘要，全文在编辑浮层里看。
            if let Some(last) = labels.last_mut() {
                last.0 = layout::shortened(&format!("{}…", last.0), text_width, NOTE_FONT);
            }
            break;
        }
        labels.push((line, place(line_index), NOTE_FONT, color));
    }
    labels
}

/// 便签的选中描边：沿纸的轮廓描一圈，跟着倾斜。
///
/// 不能复用卡片的 `draw_selection_outline` —— 那套是轴对齐外框套一圈卡片底色（白面），
/// 画到倾斜的便签上会露出白边、角度也对不齐（踩过，选中时便签像被框在白色卡纸里）。
///
/// **两层都必须画在纸的下层**（z 小于纸）：它们是比纸略大的**实心**多边形，
/// 靠"纸面盖住中间、只露外沿"形成一圈边。画在纸上面就是整张纸被填成选中色
/// （踩过，选中时便签整个变黑）。
pub(super) fn draw_selection_outline(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) {
    let z = 10.0 + index as f32 * 0.1;
    let (x, y) = (node.x, node.y);
    let (width, height) = (node.width, node.height);
    if width <= 0.0 || height <= 0.0 {
        return;
    }
    let center = Vec2::new(x + width / 2.0, y + height / 2.0);

    // 外发光：比纸略大一圈、圆角略大，压在最底下。
    let halo = rotate_points(
        &rounded_rect_points(
            x - NOTE_SELECT_SPREAD,
            y - NOTE_SELECT_SPREAD,
            width + NOTE_SELECT_SPREAD * 2.0,
            height + NOTE_SELECT_SPREAD * 2.0,
            NOTE_RADIUS + NOTE_SELECT_SPREAD,
        ),
        center,
        NOTE_TILT,
    );
    geometry.polygon(&halo, z + 0.0015, theme.token_u32("canvasNodeSelectedHalo"));

    // 选中描边：比纸大出一圈，纸面（z + 0.002 / 0.003）随后盖住中间，只留下外沿。
    let ring = rotate_points(
        &rounded_rect_points(
            x - NOTE_SELECT_WIDTH,
            y - NOTE_SELECT_WIDTH,
            width + NOTE_SELECT_WIDTH * 2.0,
            height + NOTE_SELECT_WIDTH * 2.0,
            NOTE_RADIUS + NOTE_SELECT_WIDTH,
        ),
        center,
        NOTE_TILT,
    );
    geometry.polygon(&ring, z + 0.0018, theme.token_u32("canvasNodeBorderSelected"));
}

/// 按宽度折行。优先在显式换行处分段；单段超宽时按字断行。
fn wrap_note(text: &str, max_width: f32, size: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        let mut width = 0.0;
        for c in paragraph.chars() {
            let advance = layout::estimated_char_width(c, size);
            if width + advance > max_width && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                width = 0.0;
            }
            line.push(if c.is_control() { ' ' } else { c });
            width += advance;
        }
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(body: &str) -> GraphNode {
        serde_json::from_value(serde_json::json!({
            "id": "n", "type": "sticky", "x": 0, "y": 0, "width": 220, "height": 180,
            "body": body
        }))
        .unwrap()
    }

    #[test]
    fn empty_note_shows_a_placeholder() {
        let labels = draw(&mut Geometry::default(), &ThemeResource::default(), &node(""), 0);
        assert_eq!(labels.len(), 1);
        assert!(labels[0].0.contains('…'));
    }

    /// 把画布坐标反旋转回「纸面坐标系」（纸未倾斜时的 x/y）。
    ///
    /// 便签整张是倾斜的，文字锚点也跟着转，所以不能用轴对齐的阈值去断言 ——
    /// 反旋转回去再比，才是"文字在纸内"的真正含义。
    fn unrotate(point: Vec2, width: f32, height: f32) -> Vec2 {
        let center = Vec2::new(width / 2.0, height / 2.0);
        let offset = point - center;
        let (cos, sin) = (NOTE_TILT.cos(), NOTE_TILT.sin());
        center + Vec2::new(offset.x * cos + offset.y * sin, -offset.x * sin + offset.y * cos)
    }

    #[test]
    fn note_text_starts_inside_the_paper() {
        let labels = draw(&mut Geometry::default(), &ThemeResource::default(), &node("保留通透感"), 0);
        assert_eq!(labels[0].0, "保留通透感");
        let local = unrotate(labels[0].1, 220.0, 180.0);
        assert!((local.x - NOTE_PAD).abs() < 0.01);
        assert!((local.y - NOTE_PAD).abs() < 0.01);
    }

    #[test]
    fn long_text_wraps_and_stays_inside_the_note() {
        let labels = draw(
            &mut Geometry::default(),
            &ThemeResource::default(),
            &node("保留通透感，以木色和浅石材为主，避免深色家具压住整体亮度"),
            0,
        );
        assert!(labels.len() > 1);
        for label in &labels {
            let local = unrotate(label.1, 220.0, 180.0);
            assert!(local.x >= 0.0 && local.x <= 220.0);
            // 文字顶部到底边不能超出纸面（留出字号高度）。
            assert!(local.y >= 0.0 && local.y + NOTE_FONT <= 180.0);
        }
    }
}
