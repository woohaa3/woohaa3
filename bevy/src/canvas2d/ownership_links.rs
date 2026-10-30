//! Derived ownership links: owner anchor → target card bottom, without edge hit targets
//! （change: 2026-10-28-generic-extension-content-ownership 任务 4.3：场景级通用原语）。
//!
//! 起点由映射层投影为画布 2D 点（`OwnershipLink.start`）或给出模型局部 3D 锚点
//! （`OwnershipLink.anchor`，携带 owner 模型资源时投影）；终点复用卡片左侧中点几何。
//! 本模块不读取任何业务字段，也不遍历 owner 内容。
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

fn link_start(
    scene: &Scene,
    resources: &ModelAssets,
    link: &crate::protocol::OwnershipLink,
    nodes: &HashMap<&str, &crate::protocol::GraphNode>,
) -> Option<Vec2> {
    if let Some(start) = &link.start {
        let point = Vec2::new(start.x, start.y);
        return point.is_finite().then_some(point);
    }
    let anchor = link.anchor?;
    let owner = *nodes.get(link.owner_node_id.as_str())?;
    let reference = owner.model.as_ref()?;
    let model = resources.get(&reference.resource_key)?;
    let root = film_set_root_transform(owner, model, &reference.placement);
    let world = root.transform_point(Vec3::from_array(anchor));
    if let Some(focus) = &scene.model_focus {
        let surface = scene.surface.as_ref()?;
        let view = crate::gizmo_layout::GizmoView::orbit(
            Vec3::from_array(focus.target),
            focus.yaw,
            focus.pitch,
            focus.distance,
            Vec2::new(surface.width, surface.height),
            focus.fov,
        )?;
        view.project(world)
    } else {
        Some(crate::isometric_grid::screen_point_from_world(world, &default()))
    }
}

pub(super) fn segments(scene: &Scene, resources: &ModelAssets) -> Vec<([f32; 2], [f32; 2])> {
    let nodes: HashMap<_, _> = scene.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut result = Vec::new();
    for link in &scene.ownership_links {
        // 聚焦模式下只保留聚焦 owner 的归属线。
        if scene
            .model_focus
            .as_ref()
            .is_some_and(|focus| focus.node_id != link.owner_node_id)
        {
            continue;
        }
        let Some(start) = link_start(scene, resources, link, &nodes) else {
            continue;
        };
        let mut seen = HashSet::new();
        for id in &link.target_node_ids {
            if id == &link.owner_node_id || !seen.insert(id) {
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
        let scene = Scene {
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"owner","type":"model","x":100,"y":200,"width":200,"height":180,
                    "model":{"resourceKey":"base"},
                    "compositeAsset":{"x":100,"y":200,"width":200,"height":180,
                        "layoutAabb":{"min":[-0.5,0,-0.5],"max":[0.5,0.35,0.5]}}},
                {"id":"card","type":"text","x":500,"y":20,"width":280,"height":210},
                {"id":"reference","type":"model","x":0,"y":0,
                    "compositeAsset":{"x":10,"y":30,"width":120,"height":90}}
            ]))
            .unwrap(),
            ownership_links: serde_json::from_value(serde_json::json!([{
                "id":"link:owner:shots",
                "ownerNodeId":"owner",
                "start":{"x":100,"y":250},
                "targetNodeIds":["card","reference","missing","card"]
            }]))
            .unwrap(),
            ..Default::default()
        };
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
    fn links_use_projected_start_and_target_bottom_geometry() {
        let (scene, resources) = fixture();
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 2); // Missing and duplicate targets do not create extra lines.
        assert_eq!(original[0].0, [100., 250.]);
        assert_eq!(original[1].0, [100., 250.]);
        assert_eq!(original[0].1, [640., 230.]);
        assert_eq!(original[1].1, [70., 120.]);
        assert!(scene.edges.is_empty());
    }

    #[test]
    fn links_follow_targets_without_viewport_or_document_edges() {
        let (mut scene, resources) = fixture();
        let original = segments(&scene, &resources);
        scene.viewport.x = 40.;
        scene.viewport.y = -20.;
        scene.viewport.zoom = 2.;
        assert_eq!(segments(&scene, &resources), original);
        scene.nodes[1].x -= 10.;
        scene.nodes[1].y += 20.;
        let moved = segments(&scene, &resources);
        assert_eq!(moved[0].0, original[0].0, "起点由宿主投影，不随目标移动");
        assert_eq!(moved[0].1, [630., 250.]);
        assert_eq!(moved[1], original[1]);
        scene.nodes.remove(1);
        assert_eq!(segments(&scene, &resources).len(), 1);
        // 起点已提供时不需要模型资源。
        assert_eq!(segments(&scene, &ModelAssets::new()), segments(&scene, &resources));
        scene.ownership_links.clear();
        assert!(segments(&scene, &resources).is_empty());
        assert!(scene.edges.is_empty());
    }

    #[test]
    fn focus_links_only_keep_the_focused_owner_and_visible_targets() {
        let (mut scene, resources) = fixture();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({"width":1200,"height":800,"pixelRatio":1}))
                .unwrap(),
        );
        scene.model_focus = Some(
            serde_json::from_value(serde_json::json!({
                "version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],
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
        assert_eq!(original[0].0, [100., 250.]);
        assert_eq!(original[0].1, [112., 192.]);
        scene.model_focus.as_mut().unwrap().node_id = "other".into();
        assert!(segments(&scene, &resources).is_empty());
        scene.model_focus.as_mut().unwrap().node_id = "owner".into();
        scene.model_focus_context.clear();
        assert!(segments(&scene, &resources).is_empty());
    }

    #[test]
    fn separate_links_keep_independent_starts() {
        let (mut scene, resources) = fixture();
        scene.surface = Some(
            serde_json::from_value(serde_json::json!({"width":1200,"height":800,"pixelRatio":1}))
                .unwrap(),
        );
        scene.ownership_links = serde_json::from_value(serde_json::json!([
            {"id":"link:a","ownerNodeId":"owner","start":{"x":10,"y":20},"targetNodeIds":["card"]},
            {"id":"link:b","ownerNodeId":"owner","start":{"x":30,"y":40},"targetNodeIds":["reference"]}
        ]))
        .unwrap();
        scene.model_focus = Some(serde_json::from_value(serde_json::json!({"version":"woohaa-model-focus-v1","nodeId":"owner","target":[0,0,0],"yaw":0.4,"pitch":-0.5,"distance":10,"fov":0.87})).unwrap());
        scene.model_focus_context = serde_json::from_value(serde_json::json!([
            {"nodeId":"card","x":20,"y":20,"width":184,"height":172},
            {"nodeId":"reference","x":220,"y":20,"width":184,"height":172}
        ]))
        .unwrap();
        let original = segments(&scene, &resources);
        assert_eq!(original.len(), 2);
        assert_ne!(original[0].0, original[1].0);
        assert_eq!(original[0].1, [112., 192.]);
        assert_eq!(original[1].1, [312., 192.]);
    }

    #[test]
    fn anchor_only_link_projects_through_the_owner_model() {
        let (mut scene, resources) = fixture();
        scene.ownership_links = serde_json::from_value(serde_json::json!([{
            "id":"link:anchor","ownerNodeId":"owner","anchor":[0.0,0.35,0.0],
            "targetNodeIds":["card"]
        }]))
        .unwrap();
        let projected = segments(&scene, &resources);
        assert_eq!(projected.len(), 1);
        assert!(projected[0].0.iter().all(|value| value.is_finite()));
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
