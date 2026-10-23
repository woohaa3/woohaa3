//! Derived composite ownership links: actual model root → card bottom, without edge hit targets.
use super::geometry::Geometry;
use crate::{
    model3d::{ModelAssets, film_set_root_transform},
    protocol::Scene,
    theme::ThemeResource,
};
use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

pub(super) fn segments(scene: &Scene, resources: &ModelAssets) -> Vec<([f32; 2], [f32; 2])> {
    let nodes: HashMap<_, _> = scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut result = Vec::new();
    for node in &scene.nodes {
        let Some(links) = node
            .composite_asset
            .as_ref()
            .and_then(|asset| asset.ownership_links.as_ref())
        else {
            continue;
        };
        let Some(reference) = &node.model else {
            continue;
        };
        let Some(model) = resources.get(&reference.resource_key) else {
            continue;
        };
        let root = film_set_root_transform(node, model, &reference.placement);
        let world = root.transform_point(Vec3::from_array(links.anchor));
        let start = crate::isometric_grid::screen_point_from_world(world, &default());
        if !start.is_finite() {
            continue;
        }
        let mut seen = HashSet::new();
        for id in &links.target_node_ids {
            if id == &node.id || !seen.insert(id) {
                continue;
            }
            let Some(target) = nodes.get(id.as_str()) else {
                continue;
            };
            let end = if target.composite_asset.is_some() {
                let scope = crate::canvas_query::scope::node_scope(target);
                Vec2::new(
                    scope.aabb.x + scope.aabb.width / 2.,
                    scope.aabb.y + scope.aabb.height,
                )
            } else {
                Vec2::new(target.x + target.width / 2., target.y + target.height)
            };
            if end.is_finite() {
                result.push((start.to_array(), end.to_array()));
            }
        }
    }
    result
}

pub(super) fn draw(geometry: &mut Geometry, links: &[([f32; 2], [f32; 2])], theme: &ThemeResource) {
    for &(start, end) in links {
        let a = Vec2::from_array(start);
        let b = Vec2::from_array(end);
        let bend = ((b.y - a.y).abs() * 0.5).max(65.);
        geometry.curve_with_controls(
            a,
            a - Vec2::Y * bend,
            b + Vec2::Y * bend,
            b,
            1.5,
            0.8,
            theme.token_u32("canvasEdgeDefault"),
            true,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ModelSnapshot;
    fn fixture() -> (Scene, ModelAssets) {
        let scene = Scene { nodes: serde_json::from_value(serde_json::json!([
                {"id":"owner","type":"model","x":100,"y":200,"width":200,"height":180,
                    "model":{"resourceKey":"base"},
                    "compositeAsset":{"x":100,"y":200,"width":200,"height":180,
                        "layoutAabb":{"min":[-0.5,0,-0.5],"max":[0.5,0.35,0.5]},
                        "ownershipLinks":{"anchor":[-0.32,0.35,-0.32],"targetNodeIds":["card","reference","missing","card"]}}},
                {"id":"card","type":"text","x":500,"y":20,"width":280,"height":210},
                {"id":"reference","type":"model","x":0,"y":0,
                    "compositeAsset":{"x":10,"y":30,"width":120,"height":90}}
            ])).unwrap(), ..default() };
        let model: ModelSnapshot = serde_json::from_value(serde_json::json!({
            "ops":[],"extent":1,"aabb":{"min":[-0.5,0,-0.5],"max":[0.5,0.35,0.5]}
        }))
        .unwrap();
        (
            scene,
            HashMap::from([("base".into(), std::sync::Arc::new(model))]),
        )
    }

    #[test]
    fn ownership_links_follow_both_endpoints_without_viewport_or_document_edges() {
        let (mut scene, resources) = fixture();
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 2); // Missing and duplicate targets do not create lines.
        assert_eq!(original[0].1, [640., 230.]);
        assert_eq!(original[1].1, [70., 120.]);
        assert!(original[0].0[1] < 290.); // Top face is above the layout center.
        scene.viewport.x = 40.;
        scene.viewport.y = -20.;
        scene.viewport.zoom = 2.;
        assert_eq!(segments(&scene, &resources), original);
        scene.nodes[0].x += 40.;
        scene.nodes[0].y += 30.;
        scene.nodes[1].x -= 10.;
        scene.nodes[1].y += 20.;
        let moved = segments(&scene, &resources);
        assert!((moved[0].0[0] - original[0].0[0] - 40.).abs() < 0.001);
        assert!((moved[0].0[1] - original[0].0[1] - 30.).abs() < 0.001);
        assert_eq!(moved[0].1, [630., 250.]);
        scene.nodes.remove(1);
        assert_eq!(segments(&scene, &resources).len(), 1);
        assert!(segments(&scene, &ModelAssets::new()).is_empty());
        scene.nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .ownership_links = None;
        assert!(segments(&scene, &resources).is_empty());
        assert!(scene.edges.is_empty());
    }

    #[test]
    fn ownership_links_draw_dashed_cubic_geometry() {
        let mut geometry = Geometry::default();
        draw(
            &mut geometry,
            &[([100., 100.], [400., 200.])],
            &ThemeResource::default(),
        );
        let dashed = geometry.build().count_vertices();
        let mut solid = Geometry::default();
        solid.curve_with_controls(
            Vec2::new(100., 100.),
            Vec2::new(100., 35.),
            Vec2::new(400., 265.),
            Vec2::new(400., 200.),
            1.5,
            0.8,
            0xffffff,
            false,
        );
        assert!(dashed > 0 && dashed < solid.build().count_vertices());
    }
}
