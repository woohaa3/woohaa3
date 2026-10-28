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

/// Crate extension point for a persistent selection outline.
///
/// Implementations own their geometry and state. New node kinds can add another implementation
/// without changing a central enum or this dispatch function.
pub(crate) trait SelectionOutline {
    fn render(&self, geometry: &mut Geometry, theme: &ThemeResource);
}

pub(crate) fn draw(geometry: &mut Geometry, theme: &ThemeResource, outline: &dyn SelectionOutline) {
    outline.render(geometry, theme);
}

pub(crate) struct Card<'a> {
    pub(super) node: &'a GraphNode,
    pub(super) z: f32,
}

impl SelectionOutline for Card<'_> {
    fn render(&self, geometry: &mut Geometry, theme: &ThemeResource) {
        draw_card(geometry, theme, self.node, self.z);
    }
}

pub(crate) struct Group<'a> {
    pub(super) node: &'a GraphNode,
    pub(super) presentation: &'a GroupPresentation,
    pub(super) selected: bool,
    pub(super) running: bool,
    pub(super) z: f32,
}

impl SelectionOutline for Group<'_> {
    fn render(&self, geometry: &mut Geometry, theme: &ThemeResource) {
        draw_group(
            geometry,
            theme,
            self.node,
            self.presentation,
            self.selected,
            self.running,
            self.z,
        );
    }
}

pub(crate) struct FilmSet<'a> {
    pub(super) node: &'a GraphNode,
    pub(super) selected: bool,
    pub(super) hovered: bool,
    pub(super) z: f32,
}

impl SelectionOutline for FilmSet<'_> {
    fn render(&self, geometry: &mut Geometry, theme: &ThemeResource) {
        draw_film_set(
            geometry,
            theme,
            self.node,
            self.selected,
            self.hovered,
            self.z,
        );
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

        let card_outline = Card {
            node: &card,
            z: 10.,
        };
        let group_outline = Group {
            node: &group,
            presentation,
            selected: true,
            running: false,
            z: 1.,
        };
        let film_set_outline = FilmSet {
            node: &film_set,
            selected: true,
            hovered: false,
            z: 10.,
        };
        let targets: [&dyn SelectionOutline; 3] =
            [&card_outline, &group_outline, &film_set_outline];
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
        let outline = FilmSet {
            node: &film_set,
            selected: false,
            hovered: false,
            z: 10.,
        };
        let mut geometry = Geometry::default();
        draw(&mut geometry, &theme, &outline);
        let mesh = geometry.build();
        let VertexAttributeValues::Float32x3(positions) =
            mesh.attribute(Mesh::ATTRIBUTE_POSITION).expect("positions")
        else {
            panic!("unexpected position format");
        };
        assert!(positions.iter().all(|position| position[0] < -1.0e5));
    }
}
