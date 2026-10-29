use super::*;
use crate::isometric_grid::{IsometricGridView, screen_point_from_world};
use crate::protocol::{GraphNode, Scene};

fn node() -> GraphNode {
    serde_json::from_value(serde_json::json!({"id":"empty", "type":"model", "x":0,"y":0,
            "width":200,"height":150,"compositeAsset":{"x":0,"y":0,"width":200,"height":150,"emptyPlaceholder":"brand-plinth-v1"}})).unwrap()
}

fn scoped_node(width: f32, height: f32, diamond: bool) -> GraphNode {
    let mut n = node();
    let asset = n.composite_asset.as_mut().unwrap();
    asset.width = width;
    asset.height = height;
    if diamond {
        asset.scope_shape = crate::protocol::CompositeAssetScopeShape::IsometricDiamond;
        asset.scope_ground = Some(crate::protocol::ScopeGroundDto {
            cx: width / 2.,
            cy: height / 2.,
            hx: width / 2.,
            hz: height / 2.,
        });
    }
    n
}

fn app() -> App {
    let mut app = App::new();
    app.init_resource::<CurrentScene>()
        .init_resource::<FocusRig>()
        .init_resource::<Placeholders>()
        .init_resource::<ThemeResource>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .add_systems(Update, sync);
    app
}

/// Canonical film-set group: a group container whose own model is the composed scene.
fn film_set_scene(with_content: bool, badge_scale: f32) -> Scene {
    let node: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"set",
        "type":"group",
        "x":100,"y":60,
        "width":320,"height":240,
        "group":{"title":"片场","memberCount":0,"badgeScale":badge_scale},
        "model":{"resourceKey":"empty-film-set","signature":"empty"}
    }))
    .unwrap();
    let group: crate::protocol::FilmSetGroupPreparation =
        serde_json::from_value(serde_json::json!({
            "schemaVersion":"woohaa-film-set-group-render-v1",
            "ownerId":"set",
            "badgeOrigin":{"x":260,"y":300},
            "bindings":[],
            "ground": if with_content { Some(serde_json::json!({"width":10.0,"depth":10.0})) } else { None }
        }))
        .unwrap();
    Scene {
        nodes: vec![node],
        film_set_groups: vec![group],
        ..Default::default()
    }
}

#[test]
fn empty_film_set_group_shows_brand_plinth_inside_the_identity_badge() {
    // MCP/menu-created sets default to scale 1, service-created sets use 3, and the contract
    // floors the badge at 0.5. The plinth must stay inside the badge at all of them.
    for scale in [0.5, 1., 3.] {
        let mut app = app();
        app.world_mut().resource_mut::<CurrentScene>().0 = film_set_scene(false, scale);
        app.update();

        let node = &app.world().resource::<CurrentScene>().0.nodes[0];
        assert!(group_model::has_badge(node));
        let badge = group_model::badge_rect(node);
        let state = app.world().resource::<Placeholders>();
        let entry = state
            .entries
            .get("set")
            .expect("empty film set keeps a badge model");
        let center = app
            .world()
            .get::<Transform>(entry.body)
            .map(|transform| transform.translation)
            .unwrap_or(Vec3::ZERO);
        let view = IsometricGridView::default();
        for i in 0..4 {
            let a = entry.top_vertices[i];
            let b = entry.top_vertices[(i + 1) % 4];
            for point in [a, a - Vec3::Y * entry.depth, b - Vec3::Y * entry.depth, b] {
                let canvas = screen_point_from_world(center + point, &view);
                assert!(
                    canvas.x >= badge.x - 0.01
                        && canvas.x <= badge.x + badge.z + 0.01
                        && canvas.y >= badge.y - 0.01
                        && canvas.y <= badge.y + badge.w + 0.01,
                    "scale {scale}: plinth vertex {canvas:?} outside badge {badge:?}"
                );
            }
        }
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);
        assert_eq!(entry.labels.iter().flatten().count(), 2);
    }
}

#[test]
fn first_ground_or_binding_replaces_the_badge_plinth() {
    let mut app = app();
    app.world_mut().resource_mut::<CurrentScene>().0 = film_set_scene(true, 3.);
    app.update();
    assert!(
        app.world()
            .resource::<Placeholders>()
            .entries
            .get("set")
            .is_none(),
        "authored ground is non-empty content"
    );
}

#[test]
fn ordinary_groups_and_badgeless_film_sets_never_show_the_plinth() {
    let mut app = app();
    // A plain group is not a film set even if nothing is assembled.
    app.world_mut().resource_mut::<CurrentScene>().0 = film_set_scene(false, 3.);
    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .film_set_groups
        .clear();
    app.update();
    assert!(
        app.world()
            .resource::<Placeholders>()
            .entries
            .get("set")
            .is_none()
    );
    // A film set without a model reference has no badge, so there is nothing to fill.
    app.world_mut().resource_mut::<CurrentScene>().0 = film_set_scene(false, 3.);
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].model = None;
    app.update();
    assert!(
        app.world()
            .resource::<Placeholders>()
            .entries
            .get("set")
            .is_none()
    );
}

#[test]
fn plinth_vertices_and_label_corners_stay_inside_accepted_scope() {
    let view = IsometricGridView::default();
    for (width, height) in [(260., 195.), (200., 150.), (40., 20.)] {
        for diamond in [false, true] {
            let accepted = scope::node_scope(&scoped_node(width, height, diamond));
            let layout = plinth_layout(&accepted);
            assert!(layout.depth > 0.0);
            for i in 0..4 {
                let a = layout.top[i];
                let b = layout.top[(i + 1) % 4];
                for point in [a, a - Vec3::Y * layout.depth, b - Vec3::Y * layout.depth, b] {
                    let screen = screen_point_from_world(layout.center + point, &view);
                    assert!(
                        scope::contains(&accepted, screen),
                        "{width}x{height} diamond={diamond}: {screen:?}"
                    );
                }
            }
            assert_eq!(layout.labels.len(), 2);
            for label in &layout.labels {
                let right = Vec3::Y.cross(label.normal).normalize();
                let up = Vec3::Y * (label.height * 0.5);
                let across = right * (label.width * 0.5);
                for sx in [-1.0, 1.0] {
                    for sy in [-1.0, 1.0] {
                        let base = layout.center + label.center + across * sx + up * sy;
                        for point in [base, base + label.normal * label.depth] {
                            let screen = screen_point_from_world(point, &view);
                            assert!(
                                scope::contains(&accepted, screen),
                                "label {width}x{height} diamond={diamond}: {screen:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}

fn assert_text_mesh(json: &str, expected_width: f32) {
    let data: TextMeshData = serde_json::from_str(json).unwrap();
    assert!(!data.positions.is_empty());
    assert!(!data.indices.is_empty());
    assert_eq!(data.indices.len() % 3, 0);
    assert!((data.width - expected_width).abs() < 0.001);
    let min_x = data
        .positions
        .iter()
        .map(|p| p[0])
        .fold(f32::INFINITY, f32::min);
    let max_x = data
        .positions
        .iter()
        .map(|p| p[0])
        .fold(f32::NEG_INFINITY, f32::max);
    let min_y = data
        .positions
        .iter()
        .map(|p| p[1])
        .fold(f32::INFINITY, f32::min);
    let max_y = data
        .positions
        .iter()
        .map(|p| p[1])
        .fold(f32::NEG_INFINITY, f32::max);
    let min_z = data
        .positions
        .iter()
        .map(|p| p[2])
        .fold(f32::INFINITY, f32::min);
    let max_z = data
        .positions
        .iter()
        .map(|p| p[2])
        .fold(f32::NEG_INFINITY, f32::max);
    assert!((min_x + max_x).abs() < 0.001);
    assert!((min_y + max_y).abs() < 0.001);
    assert!((min_y - -0.5).abs() < 0.001);
    assert!((max_y - 0.5).abs() < 0.001);
    assert!(min_z.abs() < 0.001);
    assert!((max_z - TEXT_DEPTH_RATIO).abs() < 0.001);
    assert!(
        data.indices
            .iter()
            .all(|&i| (i as usize) < data.positions.len())
    );
    let mut front = 0;
    let mut back = 0;
    let mut walls = 0;
    for triangle in data.indices.chunks_exact(3) {
        let z = |index: u32| data.positions[index as usize][2];
        match (z(triangle[0]), z(triangle[1]), z(triangle[2])) {
            (first, second, third)
                if (first - TEXT_DEPTH_RATIO).abs() < 0.001
                    && (second - TEXT_DEPTH_RATIO).abs() < 0.001
                    && (third - TEXT_DEPTH_RATIO).abs() < 0.001 =>
            {
                let [a, b, c] = [triangle[0], triangle[1], triangle[2]]
                    .map(|i| Vec3::from_array(data.positions[i as usize]));
                assert!(
                    (b - a).cross(c - a).z > 0.0,
                    "front cap normal must face +Z"
                );
                front += 1;
            }
            (first, second, third)
                if first.abs() < 0.001 && second.abs() < 0.001 && third.abs() < 0.001 =>
            {
                let [a, b, c] = [triangle[0], triangle[1], triangle[2]]
                    .map(|i| Vec3::from_array(data.positions[i as usize]));
                assert!((b - a).cross(c - a).z < 0.0, "back cap normal must face -Z");
                back += 1;
            }
            _ => walls += 1,
        }
    }
    assert!(front > 100, "front cap triangles: {front}");
    assert!(back > 100, "back cap triangles: {back}");
    assert!(walls > 100, "extruded side-wall triangles: {walls}");
    let mesh = text_mesh(json).expect("valid embedded label mesh");
    assert!(mesh.count_vertices() > 0);
}

#[test]
fn embedded_text_meshes_match_layout_constants() {
    assert_text_mesh(WOOHAA3_JSON, WOOHAA3_WIDTH);
    assert_text_mesh(PIANCHANG_JSON, PIANCHANG_WIDTH);
}

#[test]
fn labels_sit_on_the_two_camera_facing_sides_and_read_upright() {
    let accepted = scope::node_scope(&node());
    let layout = plinth_layout(&accepted);
    assert_eq!(layout.labels.len(), 2);
    assert_eq!(layout.labels[0].text, "WOOHAA3");
    assert_eq!(layout.labels[1].text, "片场");
    let toward_camera = canvas_camera_rotation() * Vec3::Z;
    let left = (view_rotation() * (layout.center + layout.labels[0].center)).x;
    let right = (view_rotation() * (layout.center + layout.labels[1].center)).x;
    assert!(
        left < right,
        "labels must be ordered left-to-right on screen"
    );
    for label in &layout.labels {
        assert!(
            label.normal.dot(toward_camera) > 0.0,
            "label {:?} normal {:?} camera {:?}",
            label.text,
            label.normal,
            toward_camera
        );
        let transform = label_transform(label);
        assert!((transform.rotation * Vec3::Y).dot(Vec3::Y) > 0.99);
        assert!((transform.rotation * Vec3::Z).dot(label.normal) > 0.99);
        assert!(
            (view_rotation() * (transform.rotation * Vec3::X)).x > 0.0,
            "label {:?} local +X must read left-to-right",
            label.text
        );
        assert!((transform.scale - Vec3::splat(label.height)).length() < 1e-5);
        assert!(label.width > 0.0);
        assert!((label.depth - label.height * TEXT_DEPTH_RATIO).abs() < 1e-5);
    }
}

#[test]
fn placeholder_does_not_change_scope_or_content() {
    let placeholder = RenderLayers::layer(FILM_SET_PLACEHOLDER_LAYER);
    assert!(overview_layers(true).intersects(&placeholder));
    assert!(!overview_layers(false).intersects(&placeholder));
    let mut n = node();
    let before = scope::node_scope(&n);
    let content = n.composite_asset.as_ref().unwrap();
    assert!(content.item_roots.is_empty());
    assert!(content.layout_aabb.is_none());
    assert!(content.content_extent.is_none());
    n.composite_asset.as_mut().unwrap().empty_placeholder = None;
    assert_eq!(before, scope::node_scope(&n));
}

#[test]
fn lifecycle_rebuilds_only_on_dimension_change_and_reuses_shared_assets() {
    let mut app = app();
    app.world_mut().resource_mut::<CurrentScene>().0.nodes = vec![node()];
    app.update();
    let (initial_body, initial_top, initial_labels) = {
        let state = app.world().resource::<Placeholders>();
        let entry = &state.entries["empty"];
        (entry.body, entry.top, entry.labels)
    };
    let initial = std::iter::once(initial_body)
        .chain(std::iter::once(initial_top))
        .chain(initial_labels.into_iter().flatten())
        .collect::<Vec<_>>();
    assert_eq!(initial.len(), 4);
    for entity in &initial {
        let layers = app.world().get::<RenderLayers>(*entity).unwrap();
        assert_eq!(*layers, RenderLayers::layer(FILM_SET_PLACEHOLDER_LAYER));
        assert!(!super::super::shot_adapter::shot_view_layers().intersects(layers));
    }
    {
        let labels = app.world().resource::<Assets<StandardMaterial>>();
        let text = app
            .world()
            .resource::<ThemeResource>()
            .token_color("interactionOnAccent");
        for entity in initial_labels.into_iter().flatten() {
            let material = app
                .world()
                .get::<MeshMaterial3d<StandardMaterial>>(entity)
                .unwrap();
            let material = labels.get(&material.0).unwrap();
            assert_eq!(material.base_color, text);
            assert!(material.base_color_texture.is_none());
            assert!(!material.unlit);
        }
    }
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 3);

    // Moving the node updates only the body transform; entities and assets stay.
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].x = 40.;
    app.update();
    assert_eq!(
        app.world().resource::<Placeholders>().entries["empty"].body,
        initial_body
    );
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);

    // Resizing rebuilds the per-node prism/top meshes; the two shared 3D text meshes and
    // three materials remain renderer-lifetime assets.
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .width = 260.;
    app.update();
    let (resized, resized_top, resized_labels) = {
        let state = app.world().resource::<Placeholders>();
        let entry = &state.entries["empty"];
        (entry.body, entry.top, entry.labels)
    };
    assert_ne!(resized, initial_body);
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 3);

    // Theme-only change swaps materials without rebuilding geometry.
    {
        let mut theme = app.world_mut().resource_mut::<ThemeResource>();
        theme.0.fingerprint = "sentinel".into();
        theme
            .0
            .tokens
            .insert("interactionAccent".into(), "#010203".into());
    }
    app.update();
    assert_eq!(
        app.world().resource::<Placeholders>().entries["empty"].body,
        resized
    );
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);
    let expected = app
        .world()
        .resource::<ThemeResource>()
        .token_color("interactionAccent");
    let material = app
        .world()
        .get::<MeshMaterial3d<StandardMaterial>>(resized)
        .unwrap();
    let expected_top = app
        .world()
        .resource::<ThemeResource>()
        .token_color("interactionAccentSoft");
    let expected_text = app
        .world()
        .resource::<ThemeResource>()
        .token_color("interactionOnAccent");
    let materials = app.world().resource::<Assets<StandardMaterial>>();
    assert_eq!(materials.get(&material.0).unwrap().base_color, expected);
    let top_material = app
        .world()
        .get::<MeshMaterial3d<StandardMaterial>>(resized_top)
        .unwrap();
    assert_eq!(
        materials.get(&top_material.0).unwrap().base_color,
        expected_top
    );
    for entity in resized_labels.into_iter().flatten() {
        let handle = app
            .world()
            .get::<MeshMaterial3d<StandardMaterial>>(entity)
            .unwrap();
        assert_eq!(materials.get(&handle.0).unwrap().base_color, expected_text);
    }

    // Removing the declaration (the first real item) or focusing drops entities and per-node
    // meshes; the two shared 3D text meshes remain.
    let declaration = app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .empty_placeholder
        .take();
    app.update();
    assert!(app.world().resource::<Placeholders>().entries.is_empty());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 2);
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .empty_placeholder = declaration;
    app.update();
    assert_eq!(app.world().resource::<Placeholders>().entries.len(), 1);
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 4);

    let body = app.world().resource::<Placeholders>().entries["empty"].body;
    app.world_mut().resource_mut::<FocusRig>().focus_node = Some("empty".into());
    app.update();
    assert!(app.world().resource::<Placeholders>().entries.is_empty());
    assert!(app.world().get_entity(body).is_err());
    app.world_mut().resource_mut::<FocusRig>().focus_node = None;
    app.update();
    assert_eq!(app.world().resource::<Placeholders>().entries.len(), 1);

    app.world_mut().resource_mut::<CurrentScene>().0 = Scene::default();
    app.update();
    assert!(app.world().resource::<Placeholders>().entries.is_empty());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 2);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 3);
}
