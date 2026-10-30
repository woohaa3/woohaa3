//! Advancement of page-admitted overview render jobs.

use bevy::{camera::visibility::RenderLayers, ecs::system::SystemParam, prelude::*};
use std::collections::{HashMap, VecDeque};

use super::{geometry::Bounds2d, gpu::{self, OverviewDisplayed, OverviewTargets}, OverviewSourceLayer, OverviewSourceLayers};
use crate::{app::{CurrentScene, NodeIndex, PreviewLayerPool}, canvas_ecs::components::{CanvasNodeId, OverviewCacheOwner}, model3d, model_preview::Ready};

#[derive(Clone, Debug)]
pub(crate) struct AdmittedJob {
    pub(crate) owner: String,
    pub(crate) fingerprint: u64,
    pub(crate) generation: u64,
    pub(crate) epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobResult {
    pub(crate) owner: String,
    pub(crate) generation: u64,
    pub(crate) epoch: u64,
    pub(crate) success: bool,
    pub(crate) cancelled: bool,
}

struct ActiveJob {
    request: AdmittedJob,
    entity: Entity,
    slot: crate::preview_layers::LayerSlot,
    frames: u32,
    cancelled: bool,
}

/// Only jobs already admitted by the page may enter this queue.
#[derive(Resource, Default)]
pub(crate) struct OverviewDispatch {
    pub(crate) queue: VecDeque<AdmittedJob>,
    pub(crate) results: VecDeque<JobResult>,
    pending_results: VecDeque<JobResult>,
    pending_releases: VecDeque<super::wire::ReleaseEntry>,
    releases: VecDeque<super::wire::ReleaseEntry>,
    active: Option<ActiveJob>,
    published: HashMap<String, (Entity, u64, u64, u64)>,
    epoch: u64,
}

impl OverviewDispatch {
    pub(crate) fn has_pending(&self) -> bool { self.active.is_some() || !self.queue.is_empty() || !self.pending_releases.is_empty() || !self.pending_results.is_empty() }
}

#[derive(SystemParam)]
pub(crate) struct RenderResources<'w> {
    scene: Res<'w, CurrentScene>,
    index: Res<'w, NodeIndex>,
    models: Res<'w, model3d::ModelVisuals>,
    media: Res<'w, model3d::film_set_media::FilmSetMediaVisuals>,
    ready: Res<'w, Ready>,
    targets: ResMut<'w, OverviewTargets>,
    displayed: ResMut<'w, OverviewDisplayed>,
    sources: ResMut<'w, OverviewSourceLayers>,
    pool: ResMut<'w, PreviewLayerPool>,
    images: ResMut<'w, Assets<Image>>,
    meshes: ResMut<'w, Assets<Mesh>>,
    materials: ResMut<'w, Assets<StandardMaterial>>,
}

fn layout(node: &crate::protocol::GraphNode, tier: u32) -> Option<(UVec2, Transform, OrthographicProjection, Transform, Vec2)> {
    let bounds = super::subject::content_bounds(node)?;
    let width = bounds.max_x - bounds.min_x;
    let height = bounds.max_y - bounds.min_y;
    if width <= 0. || height <= 0. { return None; }
    let margin = width.max(height) * 0.01;
    let width = width + 2. * margin;
    let height = height + 2. * margin;
    let edge = width.max(height);
    let size = UVec2::new((tier as f32 * width / edge).ceil() as u32, (tier as f32 * height / edge).ceil() as u32);
    let (camera, projection, plane, plane_size) = gpu::view_for_bounds(bounds, size.x as f32 / size.y as f32, margin, crate::depth_order::depth_of(&node.id))?;
    Some((size, camera, projection, plane, plane_size))
}

/// Advances only admitted work; an absent/invalid owner remains on the direct path.
pub(crate) fn sync(
    mut commands: Commands,
    mut dispatch: ResMut<OverviewDispatch>,
    mut r: RenderResources,
    owners: Query<(Entity, &CanvasNodeId, &OverviewCacheOwner)>,
    mesh_components: Query<&Mesh3d>,
    mut lights: Query<&mut RenderLayers, With<DirectionalLight>>,
) {
    let pending_releases = std::mem::take(&mut dispatch.pending_releases);
    dispatch.releases.extend(pending_releases);
    let pending_results = std::mem::take(&mut dispatch.pending_results);
    dispatch.results.extend(pending_results);
    let mut reset_epoch = false;
    for command in super::wire::take_commands() {
        match command {
            super::wire::Command::Render { owner, fingerprint, generation, epoch } => {
                if epoch < dispatch.epoch { continue; }
                if epoch > dispatch.epoch {
                    reset_epoch = dispatch.epoch != 0;
                    dispatch.queue.clear();
                    if let Some(active) = dispatch.active.as_mut() { active.cancelled = true; }
                }
                dispatch.epoch = epoch;
                if let Ok(fingerprint) = u64::from_str_radix(&fingerprint, 16) {
                    dispatch.queue.push_back(AdmittedJob { owner, fingerprint, generation, epoch });
                }
            }
            super::wire::Command::Cancel { owner, generation, epoch } => {
                dispatch.results.retain(|result| !(result.owner == owner && result.generation == generation && result.epoch == epoch));
                dispatch.pending_results.retain(|result| !(result.owner == owner && result.generation == generation && result.epoch == epoch));
                let mut active_match = false;
                if let Some(active) = dispatch.active.as_mut() {
                    if active.request.owner == owner && active.request.generation == generation && active.request.epoch == epoch { active.cancelled = true; active_match = true; }
                }
                dispatch.queue.retain(|job| !(job.owner == owner && job.generation == generation && job.epoch == epoch));
                if dispatch.published.get(&owner).is_some_and(|(_, _, published_epoch, published_generation)| *published_epoch == epoch && *published_generation == generation) {
                    let RenderResources { ref mut displayed, ref mut meshes, ref mut materials, ref mut images, .. } = r;
                    displayed.remove(&owner, &mut commands, meshes, materials, images);
                    dispatch.published.remove(&owner);
                    r.sources.owners.remove(&owner);
                }
                if !active_match { dispatch.pending_results.push_back(JobResult { owner, generation, epoch, success: false, cancelled: true }); }
            }
            super::wire::Command::Release { owner, epoch, generation, request_id } => {
                if dispatch.published.get(&owner).is_some_and(|(_, _, published_epoch, published_generation)| *published_epoch == epoch && *published_generation == generation) {
                    let RenderResources { ref mut displayed, ref mut meshes, ref mut materials, ref mut images, .. } = r;
                    displayed.remove(&owner, &mut commands, meshes, materials, images);
                    dispatch.published.remove(&owner);
                    r.sources.owners.remove(&owner);
                }
                dispatch.pending_releases.push_back(super::wire::ReleaseEntry { owner, epoch, request_id });
            }
        }
    }
    if reset_epoch {
        let owners: Vec<_> = dispatch.published.keys().cloned().collect();
        for owner in owners {
            let RenderResources { ref mut displayed, ref mut meshes, ref mut materials, ref mut images, .. } = r;
            displayed.remove(&owner, &mut commands, meshes, materials, images);
            r.sources.owners.remove(&owner);
        }
        dispatch.published.clear();
    }
    while dispatch.results.len() > 128 { dispatch.results.pop_front(); }
    while dispatch.releases.len() > 128 { dispatch.releases.pop_front(); }
    let candidates = owners.iter().filter(|(_, _, state)| state.enabled).map(|(_, id, state)| {
        let tier = state.tier.map_or(128, |tier| tier.edge());
        let node = r.index.node(&r.scene.0, &id.0).map(|(_, node)| node);
        let media_declared = super::subject::declared_media(super::subject::preparation(&r.scene.0, &id.0));
        let size = r.index.node(&r.scene.0, &id.0).and_then(|(_, node)| layout(node, tier));
        let pixels = size.as_ref().map_or(0, |(size, ..)| u64::from(size.x) * u64::from(size.y));
        super::wire::Candidate { owner_id: id.0.clone(), fingerprint: format!("{:016x}", state.input_fingerprint), tier,
            bytes: pixels * 4, attachment_bytes: pixels * 32, eligible: state.fallback.is_none() && state.tier.is_some() && pixels > 0,
            reason: state.fallback.map(|reason| format!("{reason:?}")),
            model_declared: node.is_some_and(|node| node.model.is_some()),
            model_ready: r.models.has_root(&id.0),
            media_declared,
            media_ready: r.media.owner_dependencies_ready(&id.0, media_declared, &r.materials, &r.images) }
    }).collect();
    super::wire::set_snapshot(&super::wire::Snapshot { candidates, releases: dispatch.releases.iter().cloned().collect(), results: dispatch.results.iter().map(|result| super::wire::ResultEntry {
        owner: result.owner.clone(), generation: result.generation, epoch: result.epoch, success: result.success, cancelled: result.cancelled
    }).collect() });
    let published: Vec<_> = dispatch.published.iter().map(|(owner, value)| (owner.clone(), *value)).collect();
    for (id, (entity, fingerprint, _, _)) in published {
        let valid = owners.get(entity).ok().filter(|(_, owner_id, state)|
            owner_id.0 == id && state.enabled && state.fallback.is_none() && state.input_fingerprint == fingerprint);
        let geometry = valid.and_then(|(_, _, state)| r.index.node(&r.scene.0, &id)
            .and_then(|(_, node)| state.tier.and_then(|tier| layout(node, tier.edge()))));
        if let Some((_, _, _, transform, _)) = geometry {
            r.displayed.move_to(&id, transform, &mut commands);
        } else {
            let RenderResources { ref mut displayed, ref mut meshes, ref mut materials, ref mut images, .. } = r;
            displayed.remove(&id, &mut commands, meshes, materials, images);
            dispatch.published.remove(&id);
            r.sources.owners.remove(&id);
        }
    }
    if let Some(mut active) = dispatch.active.take() {
        let current = owners.get(active.entity).ok().filter(|(_, id, owner)| id.0 == active.request.owner && owner.enabled && owner.fallback.is_none() && owner.tier.is_some() && owner.input_fingerprint == active.request.fingerprint);
        active.cancelled |= current.is_none();
        if active.cancelled {
            r.sources.owners.insert(active.request.owner.clone(), OverviewSourceLayer { layer: Some(active.slot.layer), cached: false });
        } else if let Some((_, node)) = r.index.node(&r.scene.0, &active.request.owner) {
            if let Some((_, camera, projection, _, _)) = layout(node, current.unwrap().2.tier.unwrap().edge()) {
                if let Some(target) = r.targets.get(&active.request.owner) {
                    commands.entity(target.camera).insert((camera, Projection::Orthographic(projection)));
                }
            }
        }
        active.frames = active.frames.saturating_add(1);
        let ready = r.targets.get(&active.request.owner).is_some_and(|target| r.ready.matches(target.camera, active.request.generation));
        if ready || active.frames > 240 {
            let mut success = false;
            if ready && !active.cancelled {
                if let Some((_, node)) = r.index.node(&r.scene.0, &active.request.owner) {
                    if let Some((_, _, _, transform, size)) = layout(node, current.unwrap().2.tier.unwrap().edge()) {
                        let RenderResources { ref mut targets, ref mut pool, ref ready, .. } = r;
                        if let Some(image) = targets.finish(&active.request.owner, active.slot, active.request.generation, &mut commands, &mut pool.0, ready) {
                            let RenderResources { ref mut displayed, ref mut meshes, ref mut materials, ref mut images, .. } = r;
                            success = displayed.publish(&active.request.owner, active.entity, image.clone(), size, transform, &mut commands, meshes, materials, images);
                            if !success { images.remove(image.id()); }
                        }
                    }
                }
            }
            if !success {
                let RenderResources { ref mut targets, ref mut images, ref mut pool, ref ready, .. } = r;
                targets.release(&active.request.owner, active.slot, &mut commands, images, &mut pool.0, ready);
            }
            if success {
                dispatch.published.insert(active.request.owner.clone(), (active.entity, active.request.fingerprint, active.request.epoch, active.request.generation));
                r.sources.owners.insert(active.request.owner.clone(), OverviewSourceLayer { layer: None, cached: true });
            }
            else { r.sources.owners.remove(&active.request.owner); }
            dispatch.pending_results.push_back(JobResult { owner: active.request.owner, generation: active.request.generation, epoch: active.request.epoch, success, cancelled: active.cancelled });
        } else {
            dispatch.active = Some(active);
        }
        return;
    }
    let Some(request) = dispatch.queue.pop_front() else { return; };
    let owner = owners.iter().find(|(_, id, state)| id.0 == request.owner && state.enabled && state.fallback.is_none() && state.input_fingerprint == request.fingerprint);
    let Some((entity, _, state)) = owner else {
        dispatch.pending_results.push_back(JobResult { owner: request.owner, generation: request.generation, epoch: request.epoch, success: false, cancelled: false });
        return;
    };
    let Some((_, node)) = r.index.node(&r.scene.0, &request.owner) else {
        dispatch.pending_results.push_back(JobResult { owner: request.owner, generation: request.generation, epoch: request.epoch, success: false, cancelled: false });
        return;
    };
    let Some((size, camera, projection, _, _)) = state.tier.and_then(|tier| layout(node, tier.edge())) else {
        dispatch.pending_results.push_back(JobResult { owner: request.owner, generation: request.generation, epoch: request.epoch, success: false, cancelled: false });
        return;
    };
    let slot = {
        let RenderResources { ref mut targets, ref mut images, ref mut pool, .. } = r;
        targets.allocate(&request.owner, &mut commands, images, &mut pool.0, size, camera, projection)
    };
    let Some(slot) = slot else {
        dispatch.pending_results.push_back(JobResult { owner: request.owner, generation: request.generation, epoch: request.epoch, success: false, cancelled: false });
        return;
    };
    let declared_media = super::subject::declared_media(super::subject::preparation(&r.scene.0, &request.owner));
    let armed = r.targets.get(&request.owner).is_some_and(|target| target.arm_subject(&mut commands, request.generation, node, declared_media, &r.models, &r.media, &mesh_components, &r.materials, &r.images));
    if !armed {
        let RenderResources { ref mut targets, ref mut images, ref mut pool, ref ready, .. } = r;
        targets.release(&request.owner, slot, &mut commands, images, &mut pool.0, ready);
        dispatch.pending_results.push_back(JobResult { owner: request.owner, generation: request.generation, epoch: request.epoch, success: false, cancelled: false });
        return;
    }
    for mut light in &mut lights { *light = light.clone().with(slot.layer); }
    r.sources.owners.insert(request.owner.clone(), OverviewSourceLayer { layer: Some(slot.layer), cached: false });
    dispatch.active = Some(ActiveJob { request, entity, slot, frames: 0, cancelled: false });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::{FilmSetTextureBatch, FrameFlags, ModelAssetTable}, canvas_ecs::overview_cache::geometry::OverviewTier, protocol::{GraphNode, Scene}};

    fn app_with_media() -> (App, Entity) {
        let node: GraphNode = serde_json::from_value(serde_json::json!({
            "id":"film", "type":"group", "x":0, "y":0, "width":200, "height":150,
            "group": {"title":"set", "memberCount":1, "overviewCache":"transparent-world-v1"}
        })).unwrap();
        let prep = serde_json::from_value(serde_json::json!({
            "schemaVersion":"woohaa-film-set-group-render-v1", "ownerId":"film",
            "badgeOrigin":{"x":100,"y":150},
            "bindings":[{"bindingId":"image", "sourceNodeId":"image-1", "kind":"image",
                "contentKey":"key", "transform":{"x":0,"y":0,"z":0,"yaw":0,"scale":1}}]
        })).unwrap();
        let scene = Scene { nodes: vec![node], film_set_groups: vec![prep], ..default() };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let mut app = App::new();
        app.insert_resource(CurrentScene(scene)).insert_resource(index)
            .insert_resource(FrameFlags { changed: true, ..default() })
            .insert_resource(FilmSetTextureBatch(HashMap::from([("film::image".into(), (1, 1, vec![255, 255, 255, 255]))])))
            .init_resource::<ModelAssetTable>().init_resource::<model3d::ModelVisuals>()
            .init_resource::<model3d::film_set_media::FilmSetMediaVisuals>()
            .init_resource::<Ready>().init_resource::<OverviewTargets>().init_resource::<OverviewDisplayed>()
            .init_resource::<OverviewSourceLayers>().init_resource::<PreviewLayerPool>().init_resource::<OverviewDispatch>()
            .init_resource::<Assets<Image>>().init_resource::<Assets<Mesh>>().init_resource::<Assets<StandardMaterial>>()
            .add_systems(Update, (model3d::film_set_media::sync_film_set_planes, model3d::film_set_media::sync_film_set_textures, sync).chain());
        let owner = app.world_mut().spawn((CanvasNodeId("film".into()), OverviewCacheOwner {
            enabled: true, input_fingerprint: 7, tier: Some(OverviewTier::T256), ..default()
        })).id();
        app.world_mut().resource_mut::<OverviewDispatch>().queue.push_back(AdmittedJob { owner: "film".into(), fingerprint: 7, generation: 3, epoch: 1 });
        (app, owner)
    }

    #[test]
    fn admitted_media_job_waits_for_ready_then_publishes() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        let (mut app, _) = app_with_media();
        app.update();
        let camera = app.world().resource::<OverviewTargets>().get("film").unwrap().camera;
        assert!(app.world().resource::<OverviewDispatch>().has_pending());
        assert!(!app.world().resource::<OverviewSourceLayers>().owners["film"].cached);
        app.world().resource::<Ready>().mark_for_test(camera, 3);
        app.update();
        let dispatch = app.world().resource::<OverviewDispatch>();
        assert_eq!(dispatch.pending_results.back().unwrap(), &JobResult { owner: "film".into(), generation: 3, epoch: 1, success: true, cancelled: false });
        assert!(app.world().resource::<OverviewSourceLayers>().owners["film"].cached);
        assert_eq!(app.world().resource::<PreviewLayerPool>().0.active(), 0);
    }

    #[test]
    fn stale_job_never_publishes_after_owner_changes() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        let (mut app, owner) = app_with_media();
        app.update();
        let camera = app.world().resource::<OverviewTargets>().get("film").unwrap().camera;
        app.world_mut().get_mut::<OverviewCacheOwner>(owner).unwrap().input_fingerprint = 8;
        app.world().resource::<Ready>().mark_for_test(camera, 3);
        app.update();
        assert!(!app.world().resource::<OverviewDispatch>().pending_results.back().unwrap().success);
        assert!(!app.world().resource::<OverviewSourceLayers>().owners.contains_key("film"));
        assert_eq!(app.world().resource::<PreviewLayerPool>().0.active(), 0);
    }

    #[test]
    fn published_plane_follows_translation_and_is_removed_on_fallback() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        let (mut app, owner) = app_with_media();
        app.update();
        let camera = app.world().resource::<OverviewTargets>().get("film").unwrap().camera;
        app.world().resource::<Ready>().mark_for_test(camera, 3);
        app.update();
        let plane = app.world().resource::<OverviewDisplayed>().plane_entity("film").unwrap();
        let before = *app.world().get::<Transform>(plane).unwrap();
        {
            let mut scene = app.world_mut().resource_mut::<CurrentScene>();
            // 纯平移：绝对位置不进入 fingerprint，已发布平面跟随新布局移动。
            scene.0.nodes[0].x += 40.;
        }
        app.update();
        assert_ne!(*app.world().get::<Transform>(plane).unwrap(), before);
        app.world_mut().get_mut::<OverviewCacheOwner>(owner).unwrap().fallback = Some(super::super::eligibility::Fallback::Dynamic);
        app.update();
        assert!(app.world().resource::<OverviewDisplayed>().plane_entity("film").is_none());
        assert!(!app.world().resource::<OverviewSourceLayers>().owners.contains_key("film"));
    }

    #[test]
    fn bridge_command_crosses_threads_into_the_frame_system() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        super::super::wire::take_commands();
        let (mut app, _) = app_with_media();
        app.world_mut().resource_mut::<OverviewDispatch>().queue.clear();
        std::thread::spawn(|| super::super::wire::enqueue(r#"{"kind":"render","owner":"film","fingerprint":"0000000000000007","generation":3,"epoch":1}"#).unwrap()).join().unwrap();
        app.update();
        assert!(app.world().resource::<OverviewTargets>().get("film").is_some());
        let snapshot: serde_json::Value = serde_json::from_str(&super::super::wire::snapshot()).unwrap();
        assert_eq!(snapshot["candidates"][0]["ownerId"], "film");
    }

    #[test]
    fn release_ack_waits_for_next_frame_and_rejects_old_generation() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        super::super::wire::take_commands();
        let (mut app, _) = app_with_media();
        app.update();
        let camera = app.world().resource::<OverviewTargets>().get("film").unwrap().camera;
        app.world().resource::<Ready>().mark_for_test(camera, 3);
        app.update();
        super::super::wire::enqueue(r#"{"kind":"release","owner":"film","generation":2,"epoch":1,"requestId":9}"#).unwrap();
        app.update();
        assert!(app.world().resource::<OverviewDisplayed>().plane_entity("film").is_some());
        let first: serde_json::Value = serde_json::from_str(&super::super::wire::snapshot()).unwrap();
        assert!(first["releases"].as_array().unwrap().is_empty());
        app.update();
        let next: serde_json::Value = serde_json::from_str(&super::super::wire::snapshot()).unwrap();
        assert_eq!(next["releases"][0]["requestId"], 9);
        super::super::wire::enqueue(r#"{"kind":"release","owner":"film","generation":3,"epoch":1,"requestId":10}"#).unwrap();
        app.update();
        assert!(app.world().resource::<OverviewDisplayed>().plane_entity("film").is_none());
        app.update();
        let last: serde_json::Value = serde_json::from_str(&super::super::wire::snapshot()).unwrap();
        assert_eq!(last["releases"][1]["requestId"], 10);
    }

    #[test]
    fn late_cancel_removes_published_image_before_cancel_ack() {
        let _guard = super::super::wire::TEST_WIRE_LOCK.lock().unwrap();
        super::super::wire::take_commands();
        let (mut app, _) = app_with_media();
        app.update();
        let camera = app.world().resource::<OverviewTargets>().get("film").unwrap().camera;
        app.world().resource::<Ready>().mark_for_test(camera, 3);
        app.update();
        super::super::wire::enqueue(r#"{"kind":"cancel","owner":"film","generation":3,"epoch":1}"#).unwrap();
        app.update();
        assert!(app.world().resource::<OverviewDisplayed>().plane_entity("film").is_none());
        assert!(!app.world().resource::<OverviewDispatch>().results.iter().any(|result| result.generation == 3));
        app.update();
        assert!(app.world().resource::<OverviewDispatch>().results.iter().any(|result| result.generation == 3 && result.cancelled));
    }
}
