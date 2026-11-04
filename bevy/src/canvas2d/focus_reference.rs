//! Minimal focus reference: identity icon and a single-line title.
use super::{geometry::Geometry, labels::Label, layout::shortened};
use crate::{protocol::GraphNode, theme::ThemeResource};
use bevy::prelude::*;

pub(super) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    index: usize,
) -> Vec<Label> {
    let z = 10. + index as f32 * 0.1;
    geometry.rounded_rect(
        node.x,
        node.y,
        node.width,
        node.height,
        6.,
        z + 0.002,
        theme.token_u32("canvasNodeBorder"),
    );
    geometry.rounded_rect(
        node.x + 1.,
        node.y + 1.,
        node.width - 2.,
        node.height - 2.,
        5.,
        z + 0.003,
        theme.token_u32("canvasNodeSurface"),
    );
    let kind = node.card_label.as_deref().unwrap_or("model");
    let (accent, _, _) = theme.node_palette(kind);
    let center = Vec2::new(node.x + 18., node.y + node.height / 2.);
    let paths: &[&[(f32, f32)]] = match kind {
        "image" => &[&[
            (-7., -4.),
            (-3., -4.),
            (-1., -7.),
            (3., -7.),
            (5., -4.),
            (7., -4.),
            (7., 6.),
            (-7., 6.),
            (-7., -4.),
        ]],
        "video" => &[
            &[(-8., -5.), (2., -5.), (2., 5.), (-8., 5.), (-8., -5.)],
            &[(2., -2.), (8., -5.), (8., 5.), (2., 2.)],
        ],
        _ => &[
            &[
                (0., -8.),
                (7., -4.),
                (7., 4.),
                (0., 8.),
                (-7., 4.),
                (-7., -4.),
                (0., -8.),
            ],
            &[(-7., -4.), (0., 0.), (7., -4.)],
            &[(0., 0.), (0., 8.)],
        ],
    };
    for path in paths {
        for pair in path.windows(2) {
            geometry.line(
                center + Vec2::from(pair[0]),
                center + Vec2::from(pair[1]),
                1.3,
                z + 0.004,
                accent,
            );
        }
    }
    if kind == "image" {
        geometry.ring(center, 3., 1.2, z + 0.004, accent, 16);
    }
    let title = if node.title.trim().is_empty() {
        match kind {
            "video" => "动态镜头",
            "image" => "静态镜头",
            _ => "对象",
        }
    } else {
        &node.title
    };
    vec![(
        shortened(title, (node.width - 72.).max(1.), 13.),
        Vec2::new(node.x + 34., node.y + (node.height - 16.) / 2.),
        13.,
        theme.token_u32("canvasBodyText"),
    )]
}
