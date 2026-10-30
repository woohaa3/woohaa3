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
const NOTE_SHADOW_OFFSET: f32 = 3.0;
/// 投影扩散的层数。用几层低透明度叠出"柔化"的效果 ——
/// 单层实心偏移在便签这种小尺寸上会读成一条硬边（曾经就是这么画的）。
const NOTE_SHADOW_LAYERS: usize = 3;

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

    // 投影：几层低透明度、逐层放大并下沉的圆角形状叠出柔和边缘。
    // 单层实心偏移会读成一条硬边（参考稿里没有硬边，只有纸下一抹淡淡的灰）。
    for layer in 0..NOTE_SHADOW_LAYERS {
        let spread = layer as f32 * 1.5;
        let drop = NOTE_SHADOW_OFFSET + layer as f32 * 0.8;
        let points = rotate_points(
            &rounded_rect_points(
                x - spread,
                y - spread + drop,
                width + spread * 2.0,
                height + spread * 2.0,
                NOTE_RADIUS + spread,
            ),
            center,
            NOTE_TILT,
        );
        geometry.polygon_alpha(
            &points,
            z + 0.001 + layer as f32 * 0.0001,
            theme.token_u32("canvasStickyShadow"),
            0.16,
        );
    }

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
