use super::*;
use bevy::ecs::system::RunSystemOnce;

fn area() -> crate::protocol::SceneArea {
    serde_json::from_value(serde_json::json!({"nodeId":"area", "title":"场景 A",
        "bounds":{"min":{"u":-2,"v":-1},"max":{"u":3,"v":4}}}))
    .unwrap()
}
fn text_world() -> World {
    let mut world = World::new();
    world.init_resource::<Assets<Font>>();
    world.init_resource::<Assets<Image>>();
    world.init_resource::<FontAtlasSet>();
    world.init_resource::<TextPipeline>();
    world.init_resource::<FontCx>();
    world.init_resource::<LayoutCx>();
    world.init_resource::<ScaleCx>();
    world.init_resource::<RemSize>();
    world
}
#[test]
fn nameplate_is_coplanar_with_outline_and_keeps_shared_hit_projection() {
    let geometry = layout::scene_area_label_geometry(&area()).unwrap();
    let style = ScopeStyle::for_node(
        &crate::protocol::Scene::default(),
        &ThemeResource::default(),
        "area",
    );
    let mesh = body_mesh(&geometry, style);
    let Some(VertexAttributeValues::Float32x3(points)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION)
    else {
        panic!("ground vertices");
    };
    assert!(points.len() > 4);
    assert!(points.iter().all(|point| point[1] == GROUND_SCOPE_HEIGHT));
    let projected_height = crate::isometric_grid::view_rotation() * (Vec3::Y * GROUND_SCOPE_HEIGHT);
    for local in [
        Vec2::ZERO,
        Vec2::new(geometry.width * 0.5, geometry.height * 0.5),
    ] {
        let world = label_point(&geometry, local);
        let projected = crate::isometric_grid::view_rotation() * world - projected_height;
        let expected = geometry.center + geometry.axis * local.x - geometry.axis.perp() * local.y;
        assert!((Vec2::new(projected.x, -projected.y) - expected).length() < 0.001);
    }
    let a = crate::isometric_grid::view_rotation() * label_point(&geometry, Vec2::new(-20.0, 0.0));
    let b = crate::isometric_grid::view_rotation() * label_point(&geometry, Vec2::new(20.0, 0.0));
    assert!(
        (a.z - b.z).abs() > 1.0,
        "label uses varying world depth along the edge"
    );
}

#[test]
fn real_font_glyphs_are_3d_ground_meshes_with_stable_size_across_raster_steps() {
    let mut world = text_world();
    let font = world.resource_mut::<Assets<Font>>().add(Font::from_bytes(
        include_bytes!("../../../assets/fonts/NotoSansSC-Regular.otf").to_vec(),
    ));
    world
        .run_system_once(bevy::text::load_font_assets_into_font_collection)
        .unwrap();
    let geometry = layout::scene_area_label_geometry(&area()).unwrap();
    let entity = world.spawn_empty().id();
    let mut widths = Vec::new();
    for zoom in [1.0, 4.0] {
        let font = font.clone();
        let info = world
            .run_system_once(move |mut resources: TextResources| {
                resources.shape(
                    entity,
                    "场景 A",
                    font.clone(),
                    12.0 * zoom,
                    2.0,
                    Vec2::new(1024.0, 768.0),
                )
            })
            .unwrap()
            .expect("real font layout");
        assert!(!info.glyphs.is_empty());
        let scale = 1.0 / (zoom * 2.0);
        widths.push(info.size.x * scale);
        let batches = glyph_meshes(&info, &geometry, scale, world.resource::<Assets<Image>>());
        assert!(!batches.is_empty());
        for batch in batches.into_values() {
            assert!(batch
                .positions
                .iter()
                .all(|point| point[1] == GROUND_SCOPE_HEIGHT));
            assert!(batch
                .uvs
                .iter()
                .all(|uv| uv.iter().all(|v| (0.0..=1.0).contains(v))));
            assert!(batch
                .indices
                .iter()
                .all(|index| (*index as usize) < batch.positions.len()));
        }
    }
    assert!(
        (widths[0] - widths[1]).abs() < 1.0,
        "raster size must not change label layout"
    );
}

#[test]
fn ground_label_reuses_entities_and_releases_assets_when_area_disappears() {
    let mut app = App::new();
    app.init_resource::<Assets<Font>>()
        .init_resource::<Assets<Image>>()
        .init_resource::<FontAtlasSet>()
        .init_resource::<TextPipeline>()
        .init_resource::<FontCx>()
        .init_resource::<LayoutCx>()
        .init_resource::<ScaleCx>()
        .init_resource::<RemSize>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .init_resource::<CurrentScene>()
        .init_resource::<SurfaceState>()
        .init_resource::<ThemeResource>()
        .insert_resource(CanvasOverlayCache::default_for_test());
    app.add_systems(Update, sync);
    app.world_mut()
        .resource_mut::<Assets<Font>>()
        .insert(
            AssetId::<Font>::default(),
            Font::from_bytes(
                include_bytes!("../../../assets/fonts/NotoSansSC-Regular.otf").to_vec(),
            ),
        )
        .unwrap();
    app.world_mut()
        .run_system_once(bevy::text::load_font_assets_into_font_collection)
        .unwrap();
    app.world_mut().resource_mut::<CurrentScene>().0.scene_areas = vec![area()];
    app.update();
    let world = app.world_mut();
    let visuals: Vec<_> = world
        .query_filtered::<(Entity, &MeshMaterial3d<StandardMaterial>), With<GroundScopeLabel>>()
        .iter(world)
        .map(|(entity, material)| (entity, material.0.clone()))
        .collect();
    assert!(visuals.len() > 1, "must include actual font glyph meshes");
    let (entity, material) = visuals
        .iter()
        .find(|(_, material)| {
            world
                .resource::<Assets<StandardMaterial>>()
                .get(material)
                .unwrap()
                .alpha_mode
                == AlphaMode::Opaque
        })
        .cloned()
        .unwrap();
    for (_, material) in &visuals {
        let material = world
            .resource::<Assets<StandardMaterial>>()
            .get(material)
            .unwrap();
        assert!(
            material.depth_bias.abs() <= 2.0,
            "only a coplanar bias, never a topmost depth band"
        );
    }
    let body = world
        .resource::<Assets<StandardMaterial>>()
        .get(&material)
        .unwrap();
    assert!(body.unlit);
    assert_eq!(
        body.alpha_mode,
        AlphaMode::Opaque,
        "nameplate must write scene depth"
    );
    assert_eq!(
        *world.get::<RenderLayers>(entity).unwrap(),
        RenderLayers::from_layers(&[
            crate::world_camera::WORLD_CAMERA_GIZMO_LAYER,
            crate::world_camera_preview::EDITOR_GUIDE_LAYER,
        ])
    );
    world.resource_mut::<CurrentScene>().0.selection.nodes = vec!["area".into()];
    app.update();
    assert!(app.world().get_entity(entity).is_ok());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), visuals.len());
    assert!(visuals
        .iter()
        .all(|(entity, _)| app.world().get_entity(*entity).is_ok()));
    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .scene_areas
        .clear();
    app.update();
    assert!(app.world().get_entity(entity).is_err());
    assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 0);
    assert_eq!(app.world().resource::<Assets<StandardMaterial>>().len(), 0);
}
