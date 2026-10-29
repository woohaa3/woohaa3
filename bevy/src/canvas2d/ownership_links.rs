//! Derived composite ownership links: actual model root → card bottom, without edge hit targets.
use super::geometry::Geometry;
use crate::{
    model3d::{ModelAssets, film_set_root_transform},
    protocol::Scene,
    theme::ThemeResource,
};
use bevy::prelude::*;
use std::collections::{HashMap, HashSet};

/// Focus links recede behind the content (80% transparent); overview links remain opaque.
pub(super) const FOCUS_LINK_OPACITY: f32 = 0.2;

fn object_anchors(
    node: &crate::protocol::GraphNode,
    model: &crate::protocol::ModelSnapshot,
    target_item_ids: &HashMap<String, String>,
) -> HashMap<String, Vec3> {
    let Some(asset) = &node.composite_asset else {
        return HashMap::new();
    };
    let wanted: HashSet<_> = target_item_ids.values().collect();
    let roots = asset
        .item_roots
        .iter()
        .filter(|(id, _)| wanted.contains(id))
        .map(|(id, root)| (id.clone(), root.clone()))
        .collect();
    let placement = &node.model.as_ref().unwrap().placement;
    let (bounds, _) =
        crate::model3d::film_set_item_world_aabbs_counted(node, model, placement, &roots);
    let mut anchors: HashMap<_, _> = bounds
        .into_iter()
        .map(|(id, bounds)| {
            let center = bounds.center();
            (id, Vec3::new(center.x, bounds.max[1], center.z))
        })
        .collect();
    for plane in &asset.media {
        if !wanted.iter().any(|id| id.as_str() == plane.item_id) {
            continue;
        }
        let bounds = crate::model3d::media_geometry::item_candidate(node, Some(model), plane);
        anchors.insert(
            plane.item_id.clone(),
            Vec3::new(
                (bounds.min[0] + bounds.max[0]) * 0.5,
                bounds.max[1],
                (bounds.min[2] + bounds.max[2]) * 0.5,
            ),
        );
    }
    anchors
}

pub(super) fn segments(scene: &Scene, resources: &ModelAssets) -> Vec<([f32; 2], [f32; 2])> {
    let nodes: HashMap<_, _> = scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut result = Vec::new();
    for node in &scene.nodes {
        if scene
            .model_focus
            .as_ref()
            .is_some_and(|focus| focus.node_id != node.id)
        {
            continue;
        }
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
        let view = if let Some(focus) = &scene.model_focus {
            let Some(surface) = &scene.surface else {
                continue;
            };
            let Some(view) = crate::gizmo_layout::GizmoView::orbit(
                Vec3::from_array(focus.target),
                focus.yaw,
                focus.pitch,
                focus.distance,
                Vec2::new(surface.width, surface.height),
                focus.fov,
            ) else {
                continue;
            };
            Some(view)
        } else {
            None
        };
        let anchors = view
            .as_ref()
            .map(|_| object_anchors(node, model, &links.target_item_ids))
            .unwrap_or_default();
        let mut seen = HashSet::new();
        for id in &links.target_node_ids {
            if id == &node.id || !seen.insert(id) {
                continue;
            }
            let Some(target) = nodes.get(id.as_str()) else {
                continue;
            };
            if crate::canvas_query::shot_preview::hidden(target) {
                continue;
            }
            if scene.model_focus.is_some()
                && !crate::canvas_query::focus_context::contains(scene, id)
            {
                continue;
            }
            let start = if let Some(view) = &view {
                let world = if let Some(item_id) = links.target_item_ids.get(id) {
                    let Some(anchor) = anchors.get(item_id) else {
                        continue;
                    };
                    *anchor
                } else if let Some(shot) = &target.shot_preview {
                    if shot.film_set_node_id != node.id {
                        continue;
                    }
                    let Some(aabb) = node
                        .composite_asset
                        .as_ref()
                        .and_then(|asset| asset.layout_aabb)
                    else {
                        continue;
                    };
                    let bounds = crate::model3d::scene::ModelAabb::new(aabb.min, aabb.max)
                        .transformed(&root);
                    let bounds = crate::model3d::shot_adapter::ModelBounds {
                        center: bounds.center(),
                        radius: bounds.radius(),
                    };
                    let camera = crate::motion::CameraState {
                        azimuth: shot.cover_camera.azimuth,
                        elevation: shot.cover_camera.elevation,
                        distance: shot.cover_camera.distance,
                        focus_offset: Vec3::from_array(shot.cover_camera.focus_offset),
                    };
                    let display = crate::model3d::shot_adapter::display_unit_for_node(
                        scene, resources, &node.id,
                    );
                    let Some((_, camera)) =
                        crate::model3d::shot_adapter::sampled_camera_pose(bounds, display, &camera)
                    else {
                        continue;
                    };
                    camera
                } else {
                    world
                };
                let Some(start) = view.project(world) else {
                    continue;
                };
                start
            } else {
                crate::isometric_grid::screen_point_from_world(world, &default())
            };
            if !start.is_finite() {
                continue;
            }
            let display = crate::canvas_query::focus_context::node(scene, target);
            let target = display.as_ref();
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

pub(super) fn draw(
    geometry: &mut Geometry,
    links: &[([f32; 2], [f32; 2])],
    theme: &ThemeResource,
    opacity: f32,
) {
    for &(start, end) in links {
        let a = Vec2::from_array(start);
        let b = Vec2::from_array(end);
        let bend = ((b.y - a.y).abs() * 0.5).max(65.);
        geometry.curve_with_controls_alpha(
            a,
            a - Vec2::Y * bend,
            b + Vec2::Y * bend,
            b,
            1.5,
            0.8,
            theme.token_u32("canvasEdgeDefault"),
            true,
            opacity,
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
    fn focused_shot_links_start_at_each_camera_and_use_the_tag_bottom() {
        let (mut scene, resources) = fixture();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({"width":1200,"height":800,"pixelRatio":1}))
                .unwrap(),
        );
        scene.model_focus = Some(serde_json::from_value(serde_json::json!({"version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],"yaw":0.4,"pitch":-0.5,"distance":1000,"fov":0.87})).unwrap());
        scene.model_focus_context = serde_json::from_value(serde_json::json!([
            {"nodeId":"card","x":20,"y":20,"width":184,"height":36},
            {"nodeId":"reference","x":212,"y":20,"width":184,"height":36}
        ]))
        .unwrap();
        for index in [1, 2] {
            scene.nodes[index].shot_preview = Some(serde_json::from_value(serde_json::json!({"filmSetNodeId":"owner","clipId":format!("shot-{index}"),"kind":if index == 1 {"static"} else {"dynamic"},"name":"镜头","aspect":1.7778,"duration":0,"state":"ready","coverCamera":{"azimuth":index as f32,"elevation":0.4,"distance":4,"focusOffset":[0,0,0]}})).unwrap());
        }
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 2);
        assert_ne!(original[0].0, original[1].0);
        assert_eq!(original[0].1, [112., 56.]);
        assert_eq!(original[1].1, [304., 56.]);
        scene.nodes[1]
            .shot_preview
            .as_mut()
            .unwrap()
            .cover_camera
            .azimuth += 0.5;
        let moved = segments(&scene, &resources);
        assert_ne!(moved[0].0, original[0].0);
        assert_eq!(moved[1], original[1]);
        assert!(scene.edges.is_empty());
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
    fn focus_links_follow_the_observer_and_end_at_the_visible_reference_bottom() {
        let (mut scene, resources) = fixture();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({"width":1200,"height":800,"pixelRatio":1}))
                .unwrap(),
        );
        let owner = &scene.nodes[0];
        let reference = owner.model.as_ref().unwrap();
        let root = film_set_root_transform(
            owner,
            &resources[&reference.resource_key],
            &reference.placement,
        );
        let world = root.transform_point(Vec3::from_array(
            owner
                .composite_asset
                .as_ref()
                .unwrap()
                .ownership_links
                .as_ref()
                .unwrap()
                .anchor,
        ));
        scene.model_focus = Some(
            serde_json::from_value(serde_json::json!({
                "version":"woohaa-model-focus-v1","nodeId":"owner","target":world.to_array(),
                "yaw":0.5,"pitch":0.5,"distance":10,"fov":0.87
            }))
            .unwrap(),
        );
        scene.model_focus_context = serde_json::from_value(serde_json::json!([
            {"nodeId":"reference","x":20,"y":20,"width":184,"height":172}
        ]))
        .unwrap();
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 1); // No line to the hidden card.
        assert!((original[0].0[0] - 600.).abs() < 0.01);
        assert!((original[0].0[1] - 400.).abs() < 0.01);
        assert_eq!(original[0].1, [112., 192.]);
        assert_eq!(scene.nodes[2].composite_asset.as_ref().unwrap().x, 10.);
        scene.model_focus.as_mut().unwrap().target[0] += 0.3;
        let moved = segments(&scene, &resources);
        assert_ne!(moved[0].0, original[0].0);
        assert_eq!(moved[0].1, original[0].1);
        scene.model_focus_context.clear();
        assert!(segments(&scene, &resources).is_empty());
    }

    #[test]
    fn focus_links_start_at_separate_objects_and_follow_object_placement() {
        let (mut scene, mut resources) = fixture();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({"width":1200,"height":800,"pixelRatio":1}))
                .unwrap(),
        );
        scene.model_focus = Some(serde_json::from_value(serde_json::json!({"version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],"yaw":0.4,"pitch":-0.5,"distance":1000,"fov":0.87})).unwrap());
        scene.model_focus_context = serde_json::from_value(serde_json::json!([
            {"nodeId":"card","x":20,"y":20,"width":184,"height":172},
            {"nodeId":"reference","x":220,"y":20,"width":184,"height":172}
        ]))
        .unwrap();
        let asset = scene.nodes[0].composite_asset.as_mut().unwrap();
        asset.item_roots =
            HashMap::from([("a".into(), "root-a".into()), ("b".into(), "root-b".into())]);
        asset.ownership_links.as_mut().unwrap().target_item_ids = HashMap::from([
            ("card".into(), "a".into()),
            ("reference".into(), "b".into()),
        ]);
        resources.insert("base".into(), std::sync::Arc::new(serde_json::from_value(serde_json::json!({"extent":8,"ops":[
            {"t":"group","id":"root-a","position":[-2,0,0]}, {"t":"box","id":"body-a","parent":"root-a","size":[1,2,1]},
            {"t":"group","id":"root-b","position":[2,0,0]}, {"t":"box","id":"body-b","parent":"root-b","size":[1,1,1]}
        ]})).unwrap()));
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 2);
        assert_ne!(original[0].0, original[1].0);
        assert_eq!(original[0].1, [112., 192.]);
        scene.nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .item_placements
            .insert(
                "root-a".into(),
                serde_json::from_value(
                    serde_json::json!({"offset":{"x":-4,"y":0,"z":1},"scale":1,"yaw":30}),
                )
                .unwrap(),
            );
        let moved = segments(&scene, &resources);
        assert_ne!(moved[0].0, original[0].0);
        assert_eq!(moved[1], original[1]);
        assert_eq!(moved[0].1, original[0].1);
        scene.nodes[0]
            .composite_asset
            .as_mut()
            .unwrap()
            .item_roots
            .remove("a");
        assert_eq!(segments(&scene, &resources).len(), 1); // Missing object cannot silently attach to the film-set root.
        scene.model_focus = None;
        let overview = segments(&scene, &resources);
        assert_eq!(overview[0].0, overview[1].0); // Overview presentation is preserved.
    }

    #[test]
    fn focus_links_use_transparent_geometry_while_overview_remains_opaque() {
        let mut geometry = Geometry::default();
        draw(
            &mut geometry,
            &[([100., 400.], [200., 180.])],
            &ThemeResource::default(),
            FOCUS_LINK_OPACITY,
        );
        let (opaque, blend) = geometry.into_layers();
        assert_eq!(opaque.count_vertices(), 3); // Invisible fallback: no opaque line vertices.
        let Some(bevy::mesh::VertexAttributeValues::Float32x4(colors)) =
            blend.attribute(Mesh::ATTRIBUTE_COLOR)
        else {
            panic!("colors");
        };
        assert!(colors.len() > 3);
        assert!(colors.iter().all(|c| (c[3] - 0.2).abs() < 1e-5));
        let mut geometry = Geometry::default();
        draw(
            &mut geometry,
            &[([100., 400.], [200., 180.])],
            &ThemeResource::default(),
            1.,
        );
        let (opaque, _) = geometry.into_layers();
        assert!(opaque.count_vertices() > 3);
    }

    #[test]
    fn ownership_links_draw_dashed_cubic_geometry() {
        let mut geometry = Geometry::default();
        draw(
            &mut geometry,
            &[([100., 100.], [400., 200.])],
            &ThemeResource::default(),
            1.,
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
