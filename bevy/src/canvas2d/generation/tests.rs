use super::*;

fn setup() -> (World, Schedule, Vec<Entity>) {
    let mut world = World::new();
    let scene = crate::protocol::Scene {
        nodes: serde_json::from_value(serde_json::json!([
            {"id":"a","type":"image","x":0,"y":0,"width":180,"height":160,"mediaLoading":true},
            {"id":"b","type":"image","x":200,"y":0,"width":180,"height":160,"mediaLoading":true},
            {"id":"far","type":"image","x":10000,"y":0,"width":180,"height":160,"busy":true}
        ]))
        .unwrap(),
        viewport: crate::protocol::Viewport {
            x: 0.,
            y: 0.,
            zoom: 1.,
        },
        ..default()
    };
    let mut index = NodeIndex::default();
    index.rebuild(&scene);
    let owners = scene
        .nodes
        .iter()
        .enumerate()
        .map(|(i, node)| {
            world
                .spawn((
                    CanvasNodeId(node.id.clone()),
                    CanvasDepth {
                        index: i,
                        render: i,
                        z: 10. + i as f32 * 0.1,
                    },
                    CardPresentation {
                        busy: node.busy,
                        media_loading: node.media_loading,
                        ..default()
                    },
                    Transform::IDENTITY,
                    GlobalTransform::IDENTITY,
                    Visibility::Inherited,
                ))
                .id()
        })
        .collect();
    world.insert_resource(CurrentScene(scene));
    world.insert_resource(index);
    world.insert_resource(SurfaceState::with_size(Vec2::new(800., 600.)));
    world.insert_resource(Time::<()>::default());
    world.insert_resource(crate::theme::ThemeResource::default());
    world.insert_resource(super::super::CanvasMaterials {
        solid: default(),
        blend: default(),
        font: default(),
    });
    world.insert_resource(GenerationClock::default());
    world.insert_resource(Assets::<Mesh>::default());
    world.insert_resource(LabelRequests::default());
    let mut schedule = Schedule::default();
    schedule.add_systems(sync_generation);
    (world, schedule, owners)
}

fn frame(world: &mut World, schedule: &mut Schedule, seconds: f32) {
    world
        .resource_mut::<Time>()
        .advance_by(std::time::Duration::from_secs_f32(seconds));
    schedule.run(world);
    world.flush();
}

fn handles(world: &mut World) -> Vec<(Entity, bevy::asset::AssetId<Mesh>)> {
    let mut handles: Vec<_> = world
        .query::<(Entity, &Mesh2d)>()
        .iter(world)
        .map(|(entity, mesh)| (entity, mesh.0.id()))
        .collect();
    handles.sort_by_key(|(entity, _)| entity.to_bits());
    handles
}

#[test]
fn loading_animation_shares_meshes_and_does_not_repack_vertices() {
    let (mut world, mut schedule, _) = setup();
    frame(&mut world, &mut schedule, 0.);
    let before = handles(&mut world);
    assert_eq!(before.len(), 3, "one static layer and two visible spinners");
    assert_eq!(
        world.resource::<Assets<Mesh>>().len(),
        2,
        "identical rings share one mesh"
    );
    let spinner = world
        .query_filtered::<Entity, With<LoadingSpinner>>()
        .iter(&world)
        .next()
        .unwrap();
    let rotation = world.get::<Transform>(spinner).unwrap().rotation;
    world.clear_trackers();
    frame(&mut world, &mut schedule, 0.05);
    assert_eq!(handles(&mut world), before);
    assert_ne!(world.get::<Transform>(spinner).unwrap().rotation, rotation);
    assert_eq!(
        world
            .query_filtered::<Entity, Changed<Mesh2d>>()
            .iter(&world)
            .count(),
        0
    );
    assert_eq!(world.resource::<Assets<Mesh>>().len(), 2);
}

#[test]
fn completion_clears_once_and_loading_can_resume() {
    let (mut world, mut schedule, owners) = setup();
    frame(&mut world, &mut schedule, 0.);
    for (i, owner) in owners.iter().take(2).enumerate() {
        world.resource_mut::<CurrentScene>().0.nodes[i].media_loading = false;
        world
            .get_mut::<CardPresentation>(*owner)
            .unwrap()
            .media_loading = false;
    }
    frame(&mut world, &mut schedule, 0.1);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 0);
    assert_eq!(
        world.resource::<Assets<Mesh>>().len(),
        1,
        "unused shared ring released"
    );
    let cleared = handles(&mut world);
    frame(&mut world, &mut schedule, 0.1);
    assert_eq!(
        handles(&mut world),
        cleared,
        "empty layer must not replace its mesh each frame"
    );
    world.resource_mut::<CurrentScene>().0.nodes[0].media_loading = true;
    world
        .get_mut::<CardPresentation>(owners[0])
        .unwrap()
        .media_loading = true;
    frame(&mut world, &mut schedule, 0.1);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 1);
    assert_eq!(world.resource::<Assets<Mesh>>().len(), 2);
    world.despawn(owners[0]);
    frame(&mut world, &mut schedule, 0.1);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 0);
}

#[test]
fn offscreen_busy_clock_survives_pan_and_integer_progress_reuses_mesh() {
    let (mut world, mut schedule, owners) = setup();
    frame(&mut world, &mut schedule, 0.);
    assert_eq!(
        world.resource::<GenerationClock>().started.get("far"),
        Some(&0.)
    );
    frame(&mut world, &mut schedule, 5.);
    world.resource_mut::<CurrentScene>().0.viewport.x = -10000.;
    frame(&mut world, &mut schedule, 0.);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 0);
    assert_eq!(
        world.resource::<GenerationClock>().started.get("far"),
        Some(&0.)
    );
    let before = handles(&mut world);
    frame(&mut world, &mut schedule, 0.01);
    assert_eq!(handles(&mut world), before);
    frame(&mut world, &mut schedule, 1.);
    assert_ne!(
        handles(&mut world),
        before,
        "displayed progress advancing updates its ring"
    );
    world.resource_mut::<CurrentScene>().0.viewport.x = 0.;
    frame(&mut world, &mut schedule, 0.);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 2);
    world.resource_mut::<CurrentScene>().0.image_focus = Some(
        serde_json::from_value(serde_json::json!({
            "version":"woohaa-image-focus-v1", "nodeId":"a", "sourceWidth":128, "sourceHeight":128,
            "viewport":{"x":0,"y":0,"zoom":1}
        }))
        .unwrap(),
    );
    world.entity_mut(owners[2]).remove::<CardPresentation>();
    frame(&mut world, &mut schedule, 1.);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 0);
    assert_eq!(
        world.resource::<GenerationClock>().started.get("far"),
        Some(&0.),
        "a focus projection omitting busy owners must not reset their clocks"
    );
    world.resource_mut::<CurrentScene>().0.image_focus = None;
    world.entity_mut(owners[2]).insert(CardPresentation {
        busy: true,
        ..default()
    });
    frame(&mut world, &mut schedule, 0.);
    assert_eq!(world.query::<&LoadingSpinner>().iter(&world).count(), 2);
}

#[test]
fn three_thousand_visible_loading_nodes_keep_two_mesh_assets_across_animation_frames() {
    let (mut world, mut schedule, owners) = setup();
    for owner in owners {
        world.despawn(owner);
    }
    let nodes: Vec<crate::protocol::GraphNode> = (0..3000)
        .map(|i| {
            serde_json::from_value(serde_json::json!({
                "id":format!("image-{i}"), "type":"image", "x":(i % 60) * 200,
                "y":(i / 60) * 180, "width":180, "height":160, "mediaLoading":true,
            }))
            .unwrap()
        })
        .collect();
    for (i, node) in nodes.iter().enumerate() {
        world.spawn((
            CanvasNodeId(node.id.clone()),
            CanvasDepth {
                index: i,
                render: i,
                z: 10. + i as f32 * 0.1,
            },
            CardPresentation {
                media_loading: true,
                ..default()
            },
            Transform::IDENTITY,
            GlobalTransform::IDENTITY,
            Visibility::Inherited,
        ));
    }
    let mut scene = world.resource_mut::<CurrentScene>();
    scene.0.nodes = nodes;
    scene.0.viewport.zoom = 0.1;
    let scene = scene.0.clone();
    world.resource_mut::<NodeIndex>().rebuild(&scene);
    world.resource_mut::<SurfaceState>().size = Vec2::new(1600., 1200.);
    frame(&mut world, &mut schedule, 0.);
    let before = handles(&mut world);
    assert_eq!(before.len(), 3001);
    assert_eq!(world.resource::<Assets<Mesh>>().len(), 2);
    world.clear_trackers();
    for _ in 0..4 {
        frame(&mut world, &mut schedule, 0.016);
    }
    assert_eq!(handles(&mut world), before);
    assert_eq!(world.resource::<Assets<Mesh>>().len(), 2);
    assert_eq!(
        world
            .query_filtered::<Entity, Changed<Mesh2d>>()
            .iter(&world)
            .count(),
        0
    );
}
