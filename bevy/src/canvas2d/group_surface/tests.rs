use super::*;
use bevy::mesh::VertexAttributeValues;

fn node() -> crate::protocol::GraphNode {
    serde_json::from_value(serde_json::json!({
        "id":"g", "type":"group", "x":130., "y":270., "width":500., "height":300.,
        "group":{"modelBounds":{"aabb":{"min":[-1,-1,-1],"max":[1,1,1]},"extent":2}},
        "model":{"resourceKey":"test:box","signature":"box"}
    }))
    .unwrap()
}
fn app() -> App {
    let mut app = App::new();
    app.init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .init_resource::<ThemeResource>()
        .init_resource::<FrameFlags>()
        .insert_resource(CurrentScene(crate::protocol::Scene {
            nodes: vec![node()],
            ..default()
        }))
        .add_systems(Update, sync);
    app.world_mut().resource_mut::<FrameFlags>().changed = true;
    app
}
fn surface(app: &mut App) -> (Entity, Handle<Mesh>, Transform) {
    app.world_mut()
        .query_filtered::<(Entity, &Mesh3d, &Transform), With<GroupSurface>>()
        .single(app.world())
        .map(|(entity, mesh, transform)| (entity, mesh.0.clone(), *transform))
        .unwrap()
}

#[test]
fn continuous_surface_is_between_grid_and_model_and_excluded_from_capture() {
    let mut app = app();
    app.update();
    let (entity, handle, transform) = surface(&mut app);
    let node = node();
    let mesh = app.world().resource::<Assets<Mesh>>().get(&handle).unwrap();
    let Some(VertexAttributeValues::Float32x3(positions)) =
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
    else {
        panic!();
    };
    for view in [
        crate::isometric_grid::IsometricGridView::default(),
        crate::isometric_grid::IsometricGridView {
            x: -300.,
            y: 450.,
            zoom: 0.35,
        },
        crate::isometric_grid::IsometricGridView {
            x: 80.,
            y: -900.,
            zoom: 12.,
        },
    ] {
        for p in positions {
            let world = transform.transform_point(Vec3::from_array(*p));
            let camera_space = crate::isometric_grid::view_rotation() * world;
            assert!(camera_space.z > crate::isometric_grid::GRID_DEPTH);
            assert!(camera_space.z < 0.001);
            let screen = crate::isometric_grid::screen_point_from_world(world, &view);
            let expected = Vec2::new(
                node.x + node.width / 2. + p[0],
                node.y + node.height / 2. - p[1],
            ) * view.zoom
                + Vec2::new(view.x, view.y);
            assert!(
                screen.distance(expected) < 0.03,
                "surface projection drift: {screen:?} {expected:?}"
            );
        }
    }
    let layers = app.world().get::<RenderLayers>(entity).unwrap();
    assert_eq!(*layers, RenderLayers::layer(0));
    let material = &app
        .world()
        .get::<MeshMaterial3d<StandardMaterial>>(entity)
        .unwrap()
        .0;
    let value = app
        .world()
        .resource::<Assets<StandardMaterial>>()
        .get(material)
        .unwrap();
    assert!(value.unlit);
    assert_eq!(value.alpha_mode, AlphaMode::Blend);
    let Some(VertexAttributeValues::Float32x4(colors)) = mesh.attribute(Mesh::ATTRIBUTE_COLOR)
    else {
        panic!();
    };
    // 3D 帧只剩不透明徽章底座；半透明组底由 2D 面板唯一拥有
    // （change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D4）。
    assert!(
        colors.iter().all(|c| c[3] == 1.),
        "3D group surface must not contain translucent fill geometry"
    );
    let badge = group_model::badge_rect(&node);
    let origin = Vec2::new(node.x + node.width / 2., node.y + node.height / 2.);
    for p in positions {
        let x = p[0] + origin.x;
        let y = origin.y - p[1];
        assert!(x >= badge.x - 0.001 && x <= badge.x + badge.z + 0.001);
        assert!(y >= badge.y - 0.001 && y <= badge.y + badge.w + 0.001);
    }
    // 徽章底座只比本组深度平面退后一个极小 ε（逐像素合成，不再是深度带后沿）。
    let camera_depth = (crate::isometric_grid::view_rotation() * transform.translation).z;
    assert!((camera_depth - crate::depth_order::group_badge_depth("g")).abs() < 0.001);
}

#[test]
fn pan_selection_and_group_moves_reuse_meshes_resize_rebuilds_and_delete_reclaims() {
    let mut app = app();
    app.update();
    let (entity, original, initial_transform) = surface(&mut app);
    {
        let mut scene = app.world_mut().resource_mut::<CurrentScene>();
        scene.0.viewport.x = 200.;
        scene.0.viewport.zoom = 0.5;
        scene.0.selection.nodes = vec!["g".into()];
    }
    app.update();
    assert_eq!(surface(&mut app).1, original);
    app.world_mut()
        .resource_mut::<ThemeResource>()
        .0
        .tokens
        .insert("canvasNodeSurface".into(), "#183b2d".into());
    app.update();
    assert_eq!(surface(&mut app).1, original);
    let material = &app
        .world()
        .get::<MeshMaterial3d<StandardMaterial>>(entity)
        .unwrap()
        .0;
    assert_eq!(
        app.world()
            .resource::<Assets<StandardMaterial>>()
            .get(material)
            .unwrap()
            .base_color,
        Color::srgb_u8(24, 59, 45)
    );
    {
        let mut scene = app.world_mut().resource_mut::<CurrentScene>();
        scene.0.nodes[0].x += 700.;
        scene.0.nodes[0].y -= 900.;
    }
    app.update();
    let (same, moved, moved_transform) = surface(&mut app);
    assert_eq!(same, entity);
    assert_eq!(moved, original);
    let delta = crate::isometric_grid::view_rotation()
        * (moved_transform.translation - initial_transform.translation);
    assert!(delta.distance(Vec3::new(700., 900., 0.)) < 0.003);
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].width = 200.;
    app.update();
    let resized = surface(&mut app).1;
    assert_ne!(resized, original);
    assert!(
        app.world()
            .resource::<Assets<Mesh>>()
            .get(&original)
            .is_none()
    );
    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .nodes
        .clear();
    app.update();
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 0);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 0);
    assert!(app.world().get_entity(entity).is_err());
}

#[test]
fn focus_removes_group_chrome_and_return_restores_current_surface() {
    let mut app = app();
    app.update();
    let (entity, _, _) = surface(&mut app);
    app.world_mut().resource_mut::<CurrentScene>().0.model_focus=Some(serde_json::from_value(
        serde_json::json!({"version":crate::protocol::MODEL_FOCUS_VERSION,"nodeId":"film","distance":300.,"target":[0.,0.,0.],"yaw":0.,"pitch":0.5,"fov":0.87,"radius":1.})
    ).unwrap());
    app.update();
    assert!(app.world().get_entity(entity).is_err());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 0);
    app.world_mut().resource_mut::<CurrentScene>().0.model_focus = None;
    app.update();
    assert_ne!(surface(&mut app).0, entity);
}

#[test]
fn world_surface_follows_model_presence_and_reclaims_assets() {
    let mut app = app();
    app.update();
    let (with_badge, badge_mesh, _) = surface(&mut app);
    assert!(
        app.world()
            .resource::<Assets<Mesh>>()
            .get(&badge_mesh)
            .is_some()
    );
    // 普通组改由 2D 面板铺底；再画一层 55% 的 3D 面会把背板叠深，因此没有模型时必须释放。
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].model = None;
    app.update();
    assert!(app.world().get_entity(with_badge).is_err());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 0);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 0);
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].model = node().model;
    app.update();
    let (restored, restored_mesh, _) = surface(&mut app);
    assert_ne!(restored, with_badge);
    assert!(
        app.world()
            .resource::<Assets<Mesh>>()
            .get(&restored_mesh)
            .is_some()
    );
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 1);
}

#[test]
fn badge_scale_rebuilds_only_surface_geometry_and_releases_old_mesh() {
    let mut app = app();
    app.update();
    let (entity, old, _) = surface(&mut app);
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0]
        .group
        .as_mut()
        .unwrap()
        .badge_scale = 2.;
    app.update();
    let (same, resized, _) = surface(&mut app);
    assert_eq!(entity, same);
    assert_ne!(old, resized);
    assert!(app.world().resource::<Assets<Mesh>>().get(&old).is_none());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 1);
    app.update();
    assert_eq!(surface(&mut app).1, resized);
}
