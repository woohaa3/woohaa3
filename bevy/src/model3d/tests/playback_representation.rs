//! Large static environment fixtures exercise ECS/geometry only, without a renderer/GPU.
use super::*;
use crate::{model3d::runtime::apply_motion_playback, protocol::AnimationPlayback};

pub(super) fn fixture() -> (Scene, ModelAssets) {
    let mut ops = vec![
        serde_json::json!({"t":"group","id":"environment"}),
        serde_json::json!({"t":"group","id":"actor","position":[2,3,4],"scale":[-1,2,1]}),
    ];
    for i in 0..1024 {
        ops.push(serde_json::json!({"t":"box","id":format!("p{i}"),"parent":"environment","size":[1,1,1],"position":[i % 128,0,i / 128],"color":"#ffffff"}));
    }
    for i in 0..8 {
        ops.push(serde_json::json!({"t":"sphere","id":format!("actor{i}"),"parent":"actor","radius":1,"color":"#ffffff"}));
    }
    ops.push(serde_json::json!({"t":"box","id":"reflected","parent":"actor","size":[1,1,1],"scale":[-1,1,1]}));
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({"sceneVersion":"woohaa-model-scene-ir-v2","signature":"large-motion","extent":128,"ops":ops})).unwrap();
    let node: GraphNode = serde_json::from_value(
        serde_json::json!({"id":"film","type":"model","x":0,"y":0,"width":256,"height":195}),
    )
    .unwrap();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    (scene_with(&node, Some(reference)), resources)
}
pub(super) fn playback(target: Option<&str>) -> AnimationPlayback {
    serde_json::from_value(serde_json::json!({
        "nodeId":"film","clipId":"a","sourceIdentity":"content-a","generation":1,
        "version":"woohaa-motion-ir-v1","time":1,"duration":4,"playing":true,
        "initialCamera":{"distance":8},
        "modelMotion":target.map(|target| vec![serde_json::json!({"targetId":target,"startTime":0,"endTime":4,"motion":{"kind":"move","axis":"x","speed":2,"range":[0,8]}})]).unwrap_or_default()
    })).unwrap()
}
fn apply(world: &mut World, scene: &Scene) {
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    apply_motion_playback(&mut world.commands(), &mut models, scene);
    world.flush();
    world.insert_resource(models);
}
fn bindings(world: &World) -> Vec<(Entity, bevy::asset::AssetId<Mesh>)> {
    world.resource::<ModelVisuals>().roots["film"]
        .batches
        .iter()
        .map(|b| (b.entity, b.asset.handle.id()))
        .collect()
}
#[test]
fn camera_and_object_group_keep_every_static_entity_and_handle() {
    let (mut scene, resources) = fixture();
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let before = bindings(&world);
    let entities = world.resource::<ModelVisuals>().roots["film"]
        .entities
        .clone();
    scene.animation_playback = Some(playback(None));
    for time in [0., 1., 3., 0.] {
        scene.animation_playback.as_mut().unwrap().time = time;
        run_sync(&mut world, &scene, &resources);
        apply(&mut world, &scene);
        assert_eq!(bindings(&world), before);
        assert_eq!(
            world.resource::<ModelVisuals>().roots["film"].entities,
            entities
        );
    }
    let mut p = playback(None);
    p.objects = vec![serde_json::from_value(serde_json::json!({"itemId":"actor","playback":{"duration":4},"partIds":{"root":"actor"},"modelMotion":playback(Some("root")).model_motion.iter().map(|_| serde_json::json!({"targetId":"root","motion":{"kind":"rotate","axis":"y","speed":1}})).collect::<Vec<_>>()})).unwrap()];
    scene.animation_playback = Some(p);
    run_sync(&mut world, &scene, &resources);
    apply(&mut world, &scene);
    assert_eq!(bindings(&world), before);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    let actor = root.part_entities["actor"];
    assert_ne!(
        world.entity(actor).get::<Transform>().unwrap().rotation,
        root.part_bases["actor"].rotation
    );
    assert_eq!(root.entities, entities);
    assert!(
        root.batches
            .iter()
            .any(|b| world.entity(b.entity).get::<ChildOf>().unwrap().parent() == actor)
    );
    scene.animation_playback = None;
    apply(&mut world, &scene);
    assert_eq!(
        *world.entity(actor).get::<Transform>().unwrap(),
        world.resource::<ModelVisuals>().roots["film"].part_bases["actor"]
    );
}
#[test]
fn local_targets_replace_only_their_blocks_and_repeat_without_any_geometry_work() {
    let (mut scene, resources) = fixture();
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let before = bindings(&world);
    let anchor = world.resource::<ModelVisuals>().roots["film"].entities[0];
    let affected = world.resource::<ModelVisuals>().roots["film"].part_batches["p0"];
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    apply(&mut world, &scene);
    let after = bindings(&world);
    for binding in before.iter().filter(|(entity, _)| *entity != affected) {
        assert!(after.contains(binding));
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.entities[0], anchor);
    let entity = root.part_entities["p0"];
    assert_eq!(
        root.batches
            .iter()
            .flat_map(|b| &b.ranges)
            .filter(|r| r.id == "p0")
            .count(),
        0
    );
    assert!(!root.part_batches.contains_key("p0"));
    assert_eq!(root.prepared_targets.len(), 1);
    assert!(
        !world
            .entity(entity)
            .contains::<bevy::camera::visibility::NoFrustumCulling>()
    );
    let count = world.entities().len();
    let builds = world
        .resource::<ModelVisuals>()
        .shared
        .batches
        .work
        .build_attempts;
    let analysis = world
        .resource::<ModelVisuals>()
        .motion_plan
        .clone()
        .unwrap();
    for generation in 2..12 {
        let p = scene.animation_playback.as_mut().unwrap();
        p.generation = generation;
        p.time = 3.;
        p.playing = generation % 2 == 0;
        run_sync(&mut world, &scene, &resources);
        apply(&mut world, &scene);
        assert!(Arc::ptr_eq(
            &analysis,
            world
                .resource::<ModelVisuals>()
                .motion_plan
                .as_ref()
                .unwrap()
        ));
    }
    scene.animation_playback = None;
    run_sync(&mut world, &scene, &resources);
    apply(&mut world, &scene);
    assert_eq!(
        *world.entity(entity).get::<Transform>().unwrap(),
        world.resource::<ModelVisuals>().roots["film"].part_bases["p0"]
    );
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(bindings(&world), after);
    assert_eq!(world.entities().len(), count);
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .shared
            .batches
            .work
            .build_attempts,
        builds
    );
    // B adds a target in another block. Returning to A never repacks either block.
    let unaffected: Vec<_> = bindings(&world)
        .into_iter()
        .filter(|(id, _)| {
            *id != world.resource::<ModelVisuals>().roots["film"].part_batches["p127"]
        })
        .collect();
    scene.animation_playback = Some(playback(Some("p127")));
    run_sync(&mut world, &scene, &resources);
    apply(&mut world, &scene);
    for binding in unaffected {
        assert!(bindings(&world).contains(&binding));
    }
    let builds = world
        .resource::<ModelVisuals>()
        .shared
        .batches
        .work
        .build_attempts;
    for target in ["p0", "p127", "p0"] {
        scene.animation_playback = Some(playback(Some(target)));
        run_sync(&mut world, &scene, &resources);
        apply(&mut world, &scene);
    }
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .shared
            .batches
            .work
            .build_attempts,
        builds
    );
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .prepared_targets
            .len(),
        2
    );
    scene.nodes.clear();
    scene.animation_playback = None;
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<Assets<Mesh>>().is_empty());
    assert!(world.resource::<Assets<StandardMaterial>>().is_empty());
}
#[test]
fn object_mapping_cannot_animate_another_objects_unmapped_runtime_id() {
    let (mut scene, resources) = fixture();
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let before = bindings(&world);
    let mut p = playback(None);
    p.objects = vec![serde_json::from_value(serde_json::json!({"itemId":"actor","playback":{"duration":4},"partIds":{"root":"actor"},"modelMotion":[{"targetId":"p0","motion":{"kind":"rotate","axis":"y","speed":1}}]})).unwrap()];
    scene.animation_playback = Some(p);
    run_sync(&mut world, &scene, &resources);
    apply(&mut world, &scene);
    assert_eq!(bindings(&world), before);
    assert!(
        !world.resource::<ModelVisuals>().roots["film"]
            .part_entities
            .contains_key("p0")
    );
}

#[test]
fn prepared_targets_release_on_content_replacement_and_offscreen_root_release() {
    let (mut scene, mut resources) = fixture();
    let mut world = world_with_resources();
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    let anchor = world.resource::<ModelVisuals>().roots["film"].entities[0];
    let reference = scene.nodes[0].model.as_mut().unwrap();
    let mut replacement = (*resources[&reference.resource_key]).clone();
    replacement.signature = "replacement".into();
    *reference = reference_for(&replacement, ModelPlacement::default());
    resources.insert(reference.resource_key.clone(), Arc::new(replacement));
    scene.animation_playback = None;
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_ne!(root.entities[0], anchor);
    assert!(root.prepared_targets.is_empty());
    assert!(root.part_batches.contains_key("p0"));
    scene.animation_playback = Some(playback(Some("p0")));
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .prepared_targets
            .len(),
        1
    );
    scene.animation_playback = None;
    world.resource_mut::<ModelVisuals>().demand = Some(Default::default());
    run_sync(&mut world, &scene, &resources);
    assert!(world.resource::<ModelVisuals>().roots.is_empty());
    assert!(world.resource::<Assets<Mesh>>().is_empty());
    world.resource_mut::<ModelVisuals>().demand = None;
    run_sync(&mut world, &scene, &resources);
    assert!(
        world.resource::<ModelVisuals>().roots["film"]
            .prepared_targets
            .is_empty()
    );
    assert!(
        world.resource::<ModelVisuals>().roots["film"]
            .part_batches
            .contains_key("p0")
    );
}

#[test]
fn prepared_rigid_geometry_has_local_mesh_bounds_and_lod_invalidates_stale_bounds() {
    use crate::model3d::{quality::Quality, runtime::sync_quality};
    use bevy::camera::primitives::{Aabb, MeshAabb};
    let (mut scene, resources) = fixture();
    scene.nodes[0].model_preview =
        serde_json::from_value(serde_json::json!({"azimuth":0,"elevation":0.4,"distanceScale":1}))
            .unwrap();
    scene.viewport.zoom = 0.01;
    scene.animation_playback = Some(playback(Some("actor0")));
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.quality, Quality::Low);
    let entity = root.part_entities["actor0"];
    let mesh = world.entity(entity).get::<Mesh3d>().unwrap().0.clone();
    let bounds = world
        .resource::<Assets<Mesh>>()
        .get(&mesh)
        .unwrap()
        .get_aabb()
        .unwrap();
    assert!(bounds.half_extents.abs_diff_eq(Vec3::ONE.into(), 1e-5));
    assert!(
        !world
            .entity(entity)
            .contains::<bevy::camera::visibility::NoFrustumCulling>()
    );
    world
        .entity_mut(entity)
        .insert(Aabb::from_min_max(Vec3::splat(-1000.), Vec3::splat(1000.)));
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    assert!(sync_quality(
        &mut world.commands(),
        &mut meshes,
        &mut models,
        &scene,
        None,
        1.,
        &std::collections::HashSet::from(["film".into()])
    ));
    world.flush();
    assert_eq!(models.roots["film"].part_entities["actor0"], entity);
    assert_eq!(models.roots["film"].quality, Quality::High);
    assert!(!world.entity(entity).contains::<Aabb>()); // CalculateBounds derives the new mesh's local AABB before culling.
    let mesh = world.entity(entity).get::<Mesh3d>().unwrap();
    let updated = meshes.get(&mesh.0).unwrap().get_aabb().unwrap();
    assert!(updated.half_extents.abs_diff_eq(Vec3::ONE.into(), 1e-5));
}

#[test]
fn shot_source_keeps_prepared_motion_parts_across_short_viewport_exit() {
    let (mut scene, resources) = fixture();
    scene.surface = Some(serde_json::from_value(serde_json::json!({"width":800,"height":600,"pixelRatio":1})).unwrap());
    scene.viewport.zoom = 1.;
    scene.nodes.push(serde_json::from_value(serde_json::json!({
        "id":"preview","type":"film-set-shot-preview","x":300,"y":0,"width":240,"height":185,
        "shotPreview":{"filmSetNodeId":"film","clipId":"a","kind":"dynamic","name":"镜头",
            "aspect":1.7777778,"duration":4,"state":"ready",
            "coverCamera":{"azimuth":0,"elevation":0.7,"distance":8,"focusOffset":[0,0,0]}}
    })).unwrap());
    let mut world = world_with_resources();
    scene.animation_playback = Some(playback(Some("p0")));
    super::super::demand::update(&mut world.resource_mut::<ModelVisuals>(), &scene, None, &Default::default(), 0.);
    run_sync(&mut world, &scene, &resources);
    let part = world.resource::<ModelVisuals>().roots["film"].part_entities["p0"];
    let before = world.resource::<ModelVisuals>().playback_events.iter()
        .filter(|event| event["event"] == "target-preparation").count();
    scene.animation_playback = None;
    scene.viewport.x = -10_000.;
    for now in [1., 5.] {
        super::super::demand::update(&mut world.resource_mut::<ModelVisuals>(), &scene, None, &Default::default(), now);
        run_sync(&mut world, &scene, &resources);
    }
    scene.viewport.x = 0.;
    scene.animation_playback = Some(playback(Some("p0")));
    super::super::demand::update(&mut world.resource_mut::<ModelVisuals>(), &scene, None, &Default::default(), 6.);
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["film"].part_entities["p0"], part);
    assert_eq!(models.playback_events.iter().filter(|event| event["event"] == "target-preparation").count(), before);
}
