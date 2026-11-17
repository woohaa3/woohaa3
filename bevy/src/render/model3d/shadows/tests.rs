use super::*;
use bevy::camera::visibility::VisibleMeshEntities;

#[test]
fn world_light_keeps_elevation_and_casts_beside_the_default_canvas_observer() {
    let observer = crate::isometric_grid::canvas_camera_rotation();
    let old_sun = observer * Vec3::Z;
    let sun = world_light_rotation() * Vec3::Z;
    assert!((sun.y - old_sun.y).abs() < 1e-6);
    // Project a unit-height caster's ground shadow into the default canvas.
    // With the old headlight this displacement was exactly behind the caster.
    let old_screen = observer.inverse() * (-old_sun / old_sun.y);
    assert!(old_screen.truncate().length() < 1e-5);
    let screen = observer.inverse() * (-sun / sun.y);
    assert!(screen.truncate().length() > 0.5);
}

#[test]
fn ground_shadows_follow_the_lower_left_to_upper_right_grid_axis() {
    let observer = crate::isometric_grid::canvas_camera_rotation();
    let sun = world_light_rotation() * Vec3::Z;
    let ground_ray = Vec3::new(-sun.x, 0.0, -sun.z);
    let screen = (observer.inverse() * ground_ray).truncate();
    let grid_axis = (observer.inverse() * -Vec3::Z).truncate();
    // View-space +Y is screen up, so both components must be positive.
    assert!(screen.x > 0.0 && screen.y > 0.0);
    assert!(screen.normalize().dot(grid_axis.normalize()) > 0.99999);
    assert!((screen.y / screen.x - crate::isometric_grid::CANVAS_CAMERA_PITCH.sin()).abs() < 1e-6);
}

#[test]
fn fixed_policy_is_metric_bounded_and_preserves_illumination() {
    let light = light();
    assert!(light.shadow_maps_enabled);
    assert_eq!(light.illuminance, 4000.0);
    assert_eq!(light.color, Color::srgb_u8(255, 245, 223));
    assert!(MAP_SIZE <= 2048 && MAP_SIZE.is_power_of_two());
    assert_eq!(
        cascades().bounds,
        vec![20.0 * super::super::CANVAS_UNITS_PER_METER]
    );
    assert_eq!(cascades_for_scale(1.0).bounds, vec![20.0]);
    assert!(light.shadow_depth_bias > 0.0 && light.shadow_normal_bias > 0.0);
}

#[test]
fn hidden_occluder_is_excluded_from_bound_view_and_reused_slot() {
    let mut app = App::new();
    app.add_systems(Update, isolate_cpu_casters);
    let target = app
        .world_mut()
        .spawn((Mesh3d::default(), RenderLayers::from_layers(&[0, 32])))
        .id();
    let hidden = app
        .world_mut()
        .spawn((Mesh3d::default(), RenderLayers::layer(0)))
        .id();
    let camera = app
        .world_mut()
        .spawn((Camera3d::default(), RenderLayers::layer(32)))
        .id();
    let world_camera = app.world_mut().spawn(Camera3d::default()).id();
    let light = app
        .world_mut()
        .spawn((
            light(),
            CascadesVisibleEntities {
                entities: [
                    (
                        camera,
                        vec![VisibleMeshEntities {
                            entities: vec![target, hidden],
                        }],
                    ),
                    (
                        world_camera,
                        vec![VisibleMeshEntities {
                            entities: vec![target, hidden],
                        }],
                    ),
                ]
                .into(),
            },
        ))
        .id();
    app.update();
    let visible = app.world().get::<CascadesVisibleEntities>(light).unwrap();
    assert_eq!(visible.entities[&camera][0].entities, vec![target]);
    assert_eq!(
        visible.entities[&world_camera][0].entities,
        vec![target, hidden]
    );
    // Lease release/reassignment: old target loses membership before reuse.
    app.world_mut()
        .entity_mut(target)
        .insert(RenderLayers::layer(0));
    app.world_mut()
        .entity_mut(hidden)
        .insert(RenderLayers::from_layers(&[0, 32]));
    app.world_mut()
        .get_mut::<CascadesVisibleEntities>(light)
        .unwrap()
        .entities
        .get_mut(&camera)
        .unwrap()[0]
        .entities = vec![target, hidden];
    app.update();
    assert_eq!(
        app.world()
            .get::<CascadesVisibleEntities>(light)
            .unwrap()
            .entities[&camera][0]
            .entities,
        vec![hidden]
    );
}

#[test]
fn render_shadow_views_use_camera_intersection_and_never_add_lights() {
    let mut app = App::new();
    app.add_systems(Update, isolate_shadow_views);
    let light = app.world_mut().spawn(light()).id();
    let cascade = app
        .world_mut()
        .spawn((
            bevy::pbr::LightEntity::Directional {
                light_entity: light,
                cascade_index: 0,
            },
            RenderLayers::from_layers(&[0, 7, 32, 33]),
        ))
        .id();
    let camera = app
        .world_mut()
        .spawn((
            bevy::pbr::ViewLightEntities {
                lights: vec![cascade],
            },
            RenderLayers::from_layers(&[32, 9]),
        ))
        .id();
    for _ in 0..5 {
        // prepare_lights resets this union every frame, before our narrowing.
        app.world_mut()
            .entity_mut(cascade)
            .insert(RenderLayers::from_layers(&[0, 7, 32, 33]));
        app.update();
        assert_eq!(
            *app.world().get::<RenderLayers>(cascade).unwrap(),
            RenderLayers::layer(32)
        );
    }
    app.world_mut()
        .entity_mut(camera)
        .insert(RenderLayers::layer(33));
    app.world_mut()
        .entity_mut(cascade)
        .insert(RenderLayers::from_layers(&[0, 7, 32, 33]));
    app.update();
    assert_eq!(
        *app.world().get::<RenderLayers>(cascade).unwrap(),
        RenderLayers::layer(33)
    );
    assert_eq!(
        app.world_mut()
            .query::<&DirectionalLight>()
            .iter(app.world())
            .count(),
        1
    );
}

#[test]
fn blend_exclusion_restores_opaque_unlit_and_preserves_helpers() {
    let mut app = App::new();
    app.init_resource::<Assets<StandardMaterial>>()
        .add_systems(Update, sync_transparent_casters);
    let opaque = app
        .world_mut()
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial {
            unlit: true,
            ..default()
        });
    let blend = app
        .world_mut()
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial {
            alpha_mode: bevy::material::AlphaMode::Blend,
            ..default()
        });
    let model = app.world_mut().spawn(MeshMaterial3d(opaque.clone())).id();
    let helper = app
        .world_mut()
        .spawn((MeshMaterial3d(opaque.clone()), NotShadowCaster))
        .id();
    app.update();
    assert!(app.world().get::<NotShadowCaster>(model).is_none());
    app.world_mut()
        .entity_mut(model)
        .insert(MeshMaterial3d(blend));
    app.update();
    assert!(app.world().get::<NotShadowCaster>(model).is_some());
    app.world_mut()
        .entity_mut(model)
        .insert(MeshMaterial3d(opaque));
    app.update();
    assert!(app.world().get::<NotShadowCaster>(model).is_none());
    assert!(app.world().get::<NotShadowCaster>(helper).is_some());
}

#[test]
fn repeated_setup_reuses_the_renderer_light_and_preserves_live_layers() {
    let mut world = World::new();
    for _ in 0..4 {
        install_light(
            &mut world.commands(),
            Quat::IDENTITY,
            RenderLayers::layer(0),
            true,
            64.0,
        );
        world.flush();
    }
    let mut query = world.query_filtered::<Entity, With<FixedModelLight>>();
    let lights: Vec<_> = query.iter(&world).collect();
    assert_eq!(lights.len(), 1);
    world
        .entity_mut(lights[0])
        .insert(RenderLayers::from_layers(&[0, 32]));
    install_light(
        &mut world.commands(),
        Quat::IDENTITY,
        RenderLayers::layer(7),
        true,
        64.0,
    );
    world.flush();
    assert_eq!(
        *world.get::<RenderLayers>(lights[0]).unwrap(),
        RenderLayers::from_layers(&[0, 7, 32])
    );
}

#[test]
fn global_light_defaults_on_and_toggle_survives_reinstallation() {
    let mut app = App::new();
    app.init_resource::<crate::app::CurrentScene>()
        .add_systems(Update, sync_global_light);
    let ambient = GlobalAmbientLight {
        brightness: 600.0,
        ..default()
    };
    app.insert_resource(ambient);
    install_light(
        &mut app.world_mut().commands(),
        Quat::IDENTITY,
        RenderLayers::layer(0),
        true,
        64.0,
    );
    app.world_mut().flush();
    app.update();
    let entity = app
        .world_mut()
        .query_filtered::<Entity, With<FixedModelLight>>()
        .single(app.world())
        .unwrap();
    assert_eq!(
        app.world()
            .get::<DirectionalLight>(entity)
            .unwrap()
            .illuminance,
        4000.0
    );
    app.world_mut()
        .resource_mut::<crate::app::CurrentScene>()
        .0
        .global_light_enabled = Some(false);
    app.update();
    let source = app.world().get::<DirectionalLight>(entity).unwrap();
    assert_eq!(source.illuminance, 0.0);
    assert!(!source.shadow_maps_enabled);
    assert_eq!(
        app.world().resource::<GlobalAmbientLight>().brightness,
        600.0
    );
    // A new view/setup cannot turn a disabled global light back on.
    install_light(
        &mut app.world_mut().commands(),
        Quat::IDENTITY,
        RenderLayers::layer(32),
        true,
        64.0,
    );
    app.world_mut().flush();
    app.update();
    assert_eq!(
        app.world()
            .get::<DirectionalLight>(entity)
            .unwrap()
            .illuminance,
        0.0
    );
    app.world_mut()
        .resource_mut::<crate::app::CurrentScene>()
        .0
        .global_light_enabled = Some(true);
    app.update();
    let source = app.world().get::<DirectionalLight>(entity).unwrap();
    assert_eq!(source.illuminance, 4000.0);
    assert!(source.shadow_maps_enabled);
    // Per-consumer shadow policy is retained when the global light is restored.
    install_light(
        &mut app.world_mut().commands(),
        Quat::IDENTITY,
        RenderLayers::layer(0),
        false,
        64.0,
    );
    app.world_mut().flush();
    app.update();
    assert!(
        !app.world()
            .get::<DirectionalLight>(entity)
            .unwrap()
            .shadow_maps_enabled
    );
    assert_eq!(
        app.world_mut()
            .query::<&FixedModelLight>()
            .iter(app.world())
            .count(),
        1
    );
}

#[test]
fn shooting_views_ignore_global_light_without_switching_off_the_canvas() {
    let mut app = App::new();
    app.init_resource::<crate::app::CurrentScene>()
        .add_systems(Update, sync_global_light);
    app.insert_resource(GlobalAmbientLight {
        color: Color::srgb(1.0, 0.0, 0.0),
        brightness: 9000.0,
        ..default()
    });
    let observer = app
        .world_mut()
        .spawn((Camera3d::default(), RenderLayers::layer(0)))
        .id();
    let ordinary = app
        .world_mut()
        .spawn((Camera3d::default(), RenderLayers::layer(33)))
        .id();
    let shooting = app
        .world_mut()
        .spawn((
            Camera3d::default(),
            camera_lighting(),
            RenderLayers::from_layers(&[crate::preview_layers::WORLD_CAMERA_CONTENT_LAYER, 32]),
        ))
        .id();
    install_light(
        &mut app.world_mut().commands(),
        world_light_rotation(),
        RenderLayers::from_layers(&[0, 11, 32, 33]),
        true,
        64.0,
    );
    app.world_mut().flush();
    app.update();
    let light = app
        .world_mut()
        .query_filtered::<Entity, With<FixedModelLight>>()
        .single(app.world())
        .unwrap();
    let layers = app.world().get::<RenderLayers>(light).unwrap();
    assert!(layers.intersects(app.world().get::<RenderLayers>(observer).unwrap()));
    assert!(layers.intersects(app.world().get::<RenderLayers>(ordinary).unwrap()));
    assert!(!layers.intersects(app.world().get::<RenderLayers>(shooting).unwrap()));
    let source = app.world().get::<DirectionalLight>(light).unwrap();
    assert_eq!(source.illuminance, 4000.0);
    assert!(source.shadow_maps_enabled);
    let ambient = app
        .world()
        .get::<bevy::light::AmbientLight>(shooting)
        .unwrap();
    assert_eq!(ambient.color, Color::WHITE);
    // 这个用例挂的是 `camera_lighting()`（原生模型预览的既有策略，仍与画布同环境光）；
    // 拍摄视图用的是 `world_camera_lighting()`，环境光见下方 `WORLD_CAMERA_AMBIENT`。
    assert_eq!(ambient.brightness, 600.0);
    // 拍摄视图的主光是聚光灯：它不能占用方向光槽位（WebGL2 只有 1 个），否则主画布的
    // 全局方向光与其投影会被挤掉。
    let (key, key_layers) = shooting_key_light(RenderLayers::from_layers(&[
        crate::preview_layers::WORLD_CAMERA_CONTENT_LAYER,
        crate::preview_layers::SHOOTING_KEY_LAYER,
    ]));
    assert!(!key.shadow_maps_enabled, "拍摄主光不得投影");
    assert_eq!(key.intensity, WORLD_CAMERA_KEY_LUMENS);
    assert!(
        key_layers.intersects(&RenderLayers::layer(crate::preview_layers::SHOOTING_KEY_LAYER)),
        "主光必须能被拍摄视图的层集合命中"
    );
    assert!(
        !key_layers.intersects(&RenderLayers::layer(0)),
        "主光不得覆盖主画布层"
    );
    // A released ordinary-preview layer is leased to a shooting camera. The
    // global light must drop the stale membership even with no switch change.
    app.world_mut().despawn(ordinary);
    app.world_mut()
        .entity_mut(shooting)
        .insert(RenderLayers::layer(33));
    app.update();
    assert!(
        !app.world()
            .get::<RenderLayers>(light)
            .unwrap()
            .intersects(&RenderLayers::layer(33))
    );
    app.world_mut().despawn(shooting);
    app.update();
    assert_eq!(
        app.world()
            .get::<DirectionalLight>(light)
            .unwrap()
            .illuminance,
        4000.0
    );
    assert_eq!(
        app.world()
            .resource::<crate::app::CurrentScene>()
            .0
            .global_light_enabled,
        None
    );
    assert_eq!(
        app.world().resource::<GlobalAmbientLight>().brightness,
        9000.0
    );
}
