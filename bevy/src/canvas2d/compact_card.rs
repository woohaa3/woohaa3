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
    let mut labels = vec![(
        layout::shortened(title, (node.width - 20.).max(1.), 13.),
        Vec2::new(node.x + 10., node.y + 7.),
        13.,
        theme.token_u32("canvasBodyText"),
    )];
    if !node.texture && !node.busy && !(node.model_preview.is_some() && node.model.is_some()) {
        let max_lines = ((ch / 17.).floor() as usize).max(1);
        for (i, line) in layout::wrapped_lines(&node.body, cw - 8., 12., max_lines)
            .into_iter()
            .enumerate()
        {
            labels.push((
                line,
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
    fn small_model_card_keeps_its_name_and_gives_most_height_to_the_preview() {
        let node: GraphNode = serde_json::from_value(serde_json::json!({"id":"model","type":"model","x":8,"y":8,"width":184,"height":156,
            "title":"完整对象名称","typeLabel":"3D 模型","modelPreview":{"azimuth":0,"elevation":0.5,"distanceScale":1,"targetOffset":[0,0,0]},"model":{"resourceKey":"model"}})).unwrap();
        let labels = draw(
            &mut Geometry::default(),
            &ThemeResource::default(),
            &node,
            0,
        );
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].0, "完整对象名称");
        assert_eq!(labels[0].2, 13.);
        let (x, y, width, height) = layout::content_rect(&node);
        assert!(height >= node.height * 0.7);
        assert!(
            x >= node.x
                && y >= node.y
                && x + width <= node.x + node.width
                && y + height <= node.y + node.height
        );
    }
}
