//! Unified dispatch for persistent selection outlines.
//!
//! The visual variants keep their own geometry, but all persistent node-selection rendering comes
//! through this module. Marquee and aggregate selection bands are transient range overlays and do
//! not use this path.

use crate::{
    protocol::{GraphNode, GroupPresentation},
    theme::ThemeResource,
};

use super::{dash::dashed_polyline, geometry::Geometry, group_outline, scope};

const GROUP_BORDER: f32 = 1.5;

pub(super) enum Target<'a> {
    Card {
        node: &'a GraphNode,
        z: f32,
    },
    Group {
        node: &'a GraphNode,
        presentation: &'a GroupPresentation,
        selected: bool,
        running: bool,
        z: f32,
    },
    FilmSet {
        node: &'a GraphNode,
        selected: bool,
        hovered: bool,
        z: f32,
    },
}

pub(super) fn draw(geometry: &mut Geometry, theme: &ThemeResource, target: Target<'_>) {
    match target {
        Target::Card { node, z } => draw_card(geometry, theme, node, z),
        Target::Group {
            node,
            presentation,
            selected,
            running,
            z,
        } => draw_group(geometry, theme, node, presentation, selected, running, z),
        Target::FilmSet {
            node,
            selected,
            hovered,
            z,
        } => draw_film_set(geometry, theme, node, selected, hovered, z),
    }
}

fn draw_card(geometry: &mut Geometry, theme: &ThemeResource, node: &GraphNode, z: f32) {
    let (x, y, width, height) = (node.x, node.y, node.width, node.height);
    geometry.rounded_rect(
        x - 4.,
        y - 4.,
        width + 8.,
        height + 8.,
        11.,
        z,
        theme.token_u32("canvasNodeSelectedHalo"),
    );
    geometry.rounded_rect(
        x,
        y,
        width,
        height,
        8.,
        z + 0.0031,
        theme.token_u32("canvasNodeBorderSelected"),
    );
    let border = 1.7;
    geometry.rounded_rect(
        x + border,
        y + border,
        width - border * 2.,
        height - border * 2.,
        7.,
        z + 0.0032,
        theme.token_u32("canvasNodeSurface"),
    );
}

fn draw_group(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    presentation: &GroupPresentation,
    selected: bool,
    running: bool,
    z: f32,
) {
    let border = if presentation.drop_target {
        theme.token_u32("interactionAccent")
    } else if selected {
        theme.token_u32("canvasNodeBorderSelected")
    } else {
        theme.token_u32("canvasNodeBorder")
    };
    let path = group_outline::path(node);
    if running {
        let color = if selected {
            border
        } else {
            mix(border, theme.token_u32("interactionAccent"), 0.55)
        };
        group_outline::stroke(
            geometry,
            &path,
            0.,
            group_outline::length(&path),
            2.,
            z + 0.001,
            color,
        );
    } else {
        dashed_polyline(
            geometry,
            &crate::canvas_query::group_model::frame_path(node),
            GROUP_BORDER,
            z + 0.001,
            border,
        );
    }
}

fn draw_film_set(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    node: &GraphNode,
    selected: bool,
    hovered: bool,
    z: f32,
) {
    if !selected && !hovered {
        return;
    }
    let scope = scope::node_scope(node);
    let color = if selected {
        theme.token_u32("canvasNodeBorderSelected")
    } else {
        theme.token_u32("canvasNodeBorder")
    };
    if scope::is_diamond(scope.shape) {
        super::dash::dashed_polygon(geometry, &scope.vertices, 1.5, z, color);
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
            z,
            color,
        );
    }
}

fn mix(a: u32, b: u32, t: f32) -> u32 {
    let mut result = 0;
    for shift in [0, 8, 16] {
        let x = ((a >> shift) & 255) as f32;
        let y = ((b >> shift) & 255) as f32;
        result |= ((x + (y - x) * t).round() as u32) << shift;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::{mesh::VertexAttributeValues, prelude::Mesh};

    fn node(value: serde_json::Value) -> GraphNode {
        serde_json::from_value(value).expect("valid outline node")
    }

    fn has_geometry(geometry: Geometry) -> bool {
        geometry
            .build()
            .attribute(Mesh::ATTRIBUTE_POSITION)
            .is_some_and(|positions| !positions.is_empty())
    }

    #[test]
    fn dispatches_card_group_and_film_set_variants() {
        let theme = ThemeResource::default();
        let card = node(serde_json::json!({
            "id": "card", "type": "image", "x": 0., "y": 0., "width": 120., "height": 80.
        }));
        let group = node(serde_json::json!({
            "id": "group", "type": "group", "x": 0., "y": 0., "width": 300., "height": 200.,
            "group": {"memberCount": 1}
        }));
        let film_set = node(serde_json::json!({
            "id": "film", "type": "film-set", "x": 0., "y": 0., "width": 300., "height": 200.,
            "compositeAsset": {"x": 0., "y": 0., "width": 300., "height": 200.}
        }));
        let presentation = group.group.as_ref().expect("group presentation");

        let targets = [
            Target::Card {
                node: &card,
                z: 10.,
            },
            Target::Group {
                node: &group,
                presentation,
                selected: true,
                running: false,
                z: 1.,
            },
            Target::FilmSet {
                node: &film_set,
                selected: true,
                hovered: false,
                z: 10.,
            },
        ];
        for target in targets {
            let mut geometry = Geometry::default();
            draw(&mut geometry, &theme, target);
            assert!(has_geometry(geometry));
        }
    }

    #[test]
    fn film_set_variant_stays_empty_when_not_active() {
        let theme = ThemeResource::default();
        let film_set = node(serde_json::json!({
            "id": "film", "type": "film-set", "x": 0., "y": 0., "width": 300., "height": 200.,
            "compositeAsset": {"x": 0., "y": 0., "width": 300., "height": 200.}
        }));
        let mut geometry = Geometry::default();
        draw(
            &mut geometry,
            &theme,
            Target::FilmSet {
                node: &film_set,
                selected: false,
                hovered: false,
                z: 10.,
            },
        );
        let mesh = geometry.build();
        let VertexAttributeValues::Float32x3(positions) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION).expect("positions")
        else {
            panic!("unexpected position format");
        };
        assert!(positions.iter().all(|position| position[0] < -1.0e5));
    }
}
