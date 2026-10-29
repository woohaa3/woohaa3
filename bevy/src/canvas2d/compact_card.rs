//! Small cards use a readable name row and a large preview; no duplicate type or oversized icon.
use super::{geometry::Geometry, labels::Label, layout};
use crate::{protocol::GraphNode, theme::ThemeResource};
use bevy::prelude::*;

pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    let z = 10.0 + index as f32 * 0.1;
    let radius = 6_f32.min(node.width / 4.).min(node.height / 4.);
    geometry.rounded_rect(
        node.x,
        node.y,
        node.width,
        node.height,
        radius,
        z + 0.002,
        theme.token_u32("canvasNodeBorder"),
    );
    geometry.rounded_rect(
        node.x + 1.,
        node.y + 1.,
        (node.width - 2.).max(1.),
        (node.height - 2.).max(1.),
        (radius - 1.).max(0.),
        z + 0.003,
        theme.token_u32("canvasNodeSurface"),
    );
    let (cx, cy, cw, ch) = layout::content_rect(node);
    geometry.rounded_rect(
        cx,
        cy,
        cw,
        ch,
        3.,
        z + 0.004,
        theme.token_u32("canvasNodeContent"),
    );
    let (_, _, category) = theme.node_palette(&node.kind);
    let title = if node.title.is_empty() {
        node.card_label.as_deref().unwrap_or(category)
    } else {
        &node.title
    };
    // 小卡片同样把名称放在预览下方，种类用符号标识排在名称前方；
    // 与普通卡片保持一致的读法。标签用 `Anchor::TOP_LEFT`，给的是文字顶部。
    let footer = layout::CARD_TITLE_ROW_HEIGHT.min(node.height * 0.4);
    let title_top = node.y + node.height - footer + (footer - layout::CARD_TITLE_FONT) / 2.;
    let text_left = node.x + layout::CARD_CONTENT_PAD;
    let text_width = (node.width - layout::CARD_CONTENT_PAD * 2.).max(1.);
    let glyph_scale = 0.55_f32.min(node.height / 160.);
    let glyph_advance = if node.type_label.is_empty() {
        0.0
    } else {
        geometry.kind_glyph(
            &node.kind,
            Vec2::new(
                text_left + 6.5 * glyph_scale,
                title_top + layout::CARD_TITLE_FONT / 2.0,
            ),
            z + 0.005,
            theme.token_u32("canvasCloseIcon"),
            glyph_scale,
        );
        13.0 * glyph_scale + 4.0
    };
    let mut labels = vec![(
        layout::shortened(title, (text_width - glyph_advance).max(20.), 13.),
        Vec2::new(text_left + glyph_advance, title_top),
        13.,
        theme.token_u32("canvasBodyText"),
    )];
    if node.shot_preview.is_some() {
        labels.extend(super::cards::draw_shot_preview(
            geometry, theme, node, index,
        ));
    } else if !node.texture && !node.busy && !(node.model_preview.is_some() && node.model.is_some())
    {
        for (i, line) in node
            .body
            .lines()
            .take((ch / 17.).floor().max(0.) as usize)
            .enumerate()
        {
            labels.push((
                layout::shortened(line, cw - 8., 12.),
                Vec2::new(cx + 4., cy + 4. + i as f32 * 17.),
                12.,
                theme.token_u32("canvasBodyText"),
            ));
        }
    }
    labels
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small_model_card_puts_the_kind_glyph_before_the_name_under_the_preview() {
        let node: GraphNode = serde_json::from_value(serde_json::json!({"id":"model","type":"model","x":8,"y":8,"width":184,"height":156,
            "title":"完整对象名称","typeLabel":"3D 模型","modelPreview":{"azimuth":0,"elevation":0.5,"distanceScale":1,"targetOffset":[0,0,0]},"model":{"resourceKey":"model"}})).unwrap();
        let labels = draw(
            &mut Geometry::default(),
            &ThemeResource::default(),
            &node,
            0,
        );
        // 种类已改成符号标识（不再是一段文字标签），所以标题行只有一个文字标签：名称。
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].0, "完整对象名称");
        assert_eq!(labels[0].2, 13.);
        // 名称用正文色，不用种类强调色。
        assert_eq!(labels[0].3, ThemeResource::default().token_u32("canvasBodyText"));
        // 有种类时名称让出符号的位置。
        assert!(labels[0].1.x > node.x + layout::CARD_CONTENT_PAD);
        // 标题行在预览下方：落在内容区底边之下、卡片之内。
        let (cx, cy, cw, ch) = layout::content_rect(&node);
        assert!(labels[0].1.y > cy);
        assert!(labels[0].1.y < node.y + node.height);
        // 预览仍占卡片高度的大部分。
        assert!(ch >= node.height * 0.7);
        assert!(
            cx >= node.x
                && cy >= node.y
                && cx + cw <= node.x + node.width
                && cy + ch <= node.y + node.height
        );
        // 内容区与标题行不重叠。
        assert!(labels[0].1.y >= cy + ch);
    }

    #[test]
    fn small_card_without_type_keeps_the_name_at_the_left_edge() {
        // 没有种类标识时名称贴着内容区左缘，不留空位。
        let node: GraphNode = serde_json::from_value(serde_json::json!({"id":"t","type":"text","x":0,"y":0,"width":180,"height":120,
            "title":"只有名称"})).unwrap();
        let labels = draw(&mut Geometry::default(), &ThemeResource::default(), &node, 0);
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].0, "只有名称");
        assert!((labels[0].1.x - layout::CARD_CONTENT_PAD).abs() < 0.001);
    }
}
