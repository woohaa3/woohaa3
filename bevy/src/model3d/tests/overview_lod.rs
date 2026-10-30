//! 片场总览 primitive LOD 的非渲染回归（change: 2026-10-15-add-film-set-overview-lod）。
//!
//! 覆盖 design D1–D6：显式 opt-in 的世界投影/迟滞/缓存、每几何有效档位与分帧原子发布、
//! 播放身份、High 优先与有界诊断。全部只跑纯 ECS/几何，不依赖渲染器或 GPU。
//!
//! 关注点分离：默认 Spatial 策略会把不透明静态图元合并为批次，因此档位落点主要通过
//! `overview_work` 计数与 `budget_json` 断言；每几何有效档位（球体 Low / 盒体与自定义 Mesh
//! High）用 Automatic 策略逐实体核对，并单独单测 `mesh::effective_quality`。
use super::super::quality::Quality;
use super::super::runtime::{ModelVisuals, sync_quality, sync_quality_with_demand};
use super::*;
use std::collections::HashSet;
use std::sync::Arc;

/// 声明总览 LOD 的片场节点（复合资产根）。
fn film_set_node(id: &str) -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id": id, "type": "model", "x": 0, "y": 0, "width": 260, "height": 195,
        "compositeAsset": {
            "x": 0, "y": 0, "width": 260, "height": 195,
            "geometryQuality": "overview-primitives-v1"
        }
    }))
    .unwrap()
}

fn surface(pixel_ratio: f32) -> crate::protocol::SurfaceSize {
    surface_wh(800.0, 600.0, pixel_ratio)
}

fn surface_wh(width: f32, height: f32, pixel_ratio: f32) -> crate::protocol::SurfaceSize {
    serde_json::from_value(serde_json::json!({
        "width": width, "height": height, "pixelRatio": pixel_ratio
    }))
    .unwrap()
}

/// 混合图元片场：`spheres` 个球 + `boxes` 个盒（同材质，可合批）。
fn mixed_snapshot(signature: &str, spheres: usize, boxes: usize) -> ModelSnapshot {
    let mut ops = vec![serde_json::json!({"t":"group","id":"root"})];
    for i in 0..spheres {
        ops.push(serde_json::json!({"t":"sphere","id":format!("s{i}"),"parent":"root","radius":1,"color":"#ffffff"}));
    }
    for i in 0..boxes {
        ops.push(serde_json::json!({"t":"box","id":format!("b{i}"),"parent":"root","size":[1,1,1],"color":"#ffffff"}));
    }
    serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": signature, "extent": 12, "ops": ops
    }))
    .unwrap()
}

fn fixture(snapshot: ModelSnapshot, zoom: f32, pixel_ratio: f32) -> (Scene, ModelAssets) {
    let mut node = film_set_node("film");
    node.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let reference = node.model.as_ref().unwrap();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, node.model.clone());
    scene.viewport.zoom = zoom;
    scene.surface = Some(surface(pixel_ratio));
    (scene, resources)
}

fn quality(
    world: &mut World,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &HashSet<String>,
) {
    quality_with_demand(world, scene, focus, now, pins, pins);
}

fn quality_with_demand(
    world: &mut World,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &HashSet<String>,
    high_demand: &HashSet<String>,
) {
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    let mut meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    sync_quality_with_demand(
        &mut world.commands(),
        &mut meshes,
        &mut models,
        scene,
        focus,
        now,
        pins,
        high_demand,
    );
    world.flush();
    world.insert_resource(meshes);
    world.insert_resource(models);
}

/// 推进 sync_quality 直到根档位与期望一致且无在途准备（分帧预算可能跨多帧）。
fn settle(world: &mut World, scene: &Scene, now: &mut f64, expected: Quality) {
    for _ in 0..64 {
        quality(world, scene, None, *now, &HashSet::new());
        *now += 0.5;
        let models = world.resource::<ModelVisuals>();
        let root = &models.roots["film"];
        if root.quality.tier() == expected
            && root.quality == root.overview_desired
            && models.pending.is_none()
        {
            return;
        }
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    panic!(
        "总览档位未稳定为 {expected:?}（当前 {:?}/desired {:?} reason {}）",
        root.quality.tier(),
        root.overview_desired,
        root.overview_reason
    );
}

#[test]
#[cfg(feature = "canvas-core")]
fn visible_shot_card_keeps_source_resident_without_forcing_high() {
    let (mut scene, resources) = fixture(mixed_snapshot("shot-source", 3, 3), 0.05, 1.0);
    scene.nodes.push(
        serde_json::from_value(serde_json::json!({
            "id":"shot","type":"film-set-shot-preview","x":0,"y":0,"width":240,"height":167,
            "shotPreview":{"filmSetNodeId":"film","clipId":"clip","kind":"static","name":"shot",
                "aspect":1.7777778,"duration":0,"state":"preparing",
                "coverCamera":{"azimuth":0,"elevation":0.5,"distance":200,"focusOffset":[0,0,0]}}
        }))
        .unwrap(),
    );
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let mut pins = HashSet::new();
    crate::shot_node_preview::pin_visible_owners(&scene, &mut pins);
    assert!(pins.contains("film"));
    // 可见卡片只让源片场保持驻留：参考内容已固化，缩到总览时不升 High
    // （2026-10-28）。
    for _ in 0..16 {
        now += 0.1;
        quality_with_demand(&mut world, &scene, None, now, &pins, &HashSet::new());
    }
    assert_eq!(
        world.resource::<ModelVisuals>().quality("film").tier(),
        Quality::Low
    );
    // 进行中的截图/导出请求仍然把源片场升到 High。
    for _ in 0..64 {
        now += 0.1;
        quality_with_demand(&mut world, &scene, None, now, &pins, &pins);
        if world.resource::<ModelVisuals>().quality("film") == Quality::High {
            break;
        }
    }
    assert_eq!(
        world.resource::<ModelVisuals>().quality("film"),
        Quality::High
    );
}

#[test]
fn declared_overview_root_publishes_low_and_high_by_viewport_fraction() {
    // 小投影使用 Low，大投影先 Medium，停留后升 High。
    let (mut scene, resources) = fixture(mixed_snapshot("overview", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    {
        let root = &world.resource::<ModelVisuals>().roots["film"];
        assert!(root.overview_lod);
        assert!(
            root.overview_fraction
                .is_some_and(|f| f < Quality::OVERVIEW_MEDIUM_ENTER)
        );
    }
    // 同一配置放大进入 Medium，连续停留后实际发布 High。
    scene.viewport.zoom = 8.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    assert!(
        world.resource::<ModelVisuals>().roots["film"]
            .overview_fraction
            .unwrap()
            > Quality::OVERVIEW_MEDIUM_ENTER
    );
}

#[test]
fn viewport_fraction_scales_with_height_and_ignores_dpr() {
    // 占比 = `2 × radius × zoom ÷ 可视窗口高度`：DPR 不进入判据，窗口变高则占比变小。
    let (mut scene, resources) = fixture(mixed_snapshot("fraction", 3, 3), 0.2, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    let base = world.resource::<ModelVisuals>().roots["film"]
        .overview_fraction
        .unwrap();
    assert!(base > 0.0);
    // 同 zoom、同窗口高度，仅 DPR 2×：占比与档位均不改变。
    scene.surface = Some(surface(2.0));
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    let with_dpr = world.resource::<ModelVisuals>().roots["film"]
        .overview_fraction
        .unwrap();
    assert!((with_dpr - base).abs() < 1e-6, "DPR 不得进入屏幕占比");
    // 窗口高度 2×：占比减半。
    scene.surface = Some(surface_wh(1600.0, 1200.0, 1.0));
    quality(&mut world, &scene, None, now, &HashSet::new());
    let doubled = world.resource::<ModelVisuals>().roots["film"]
        .overview_fraction
        .unwrap();
    assert!(
        (doubled - base * 0.5).abs() < 1e-6,
        "占比应与可视窗口高度成反比"
    );
}

#[test]
fn overview_fraction_thresholds_and_hysteresis() {
    // 原 Medium 区域全部归 Low；原 High 区域先使用 Medium。
    for fraction in [0.1, 0.4, 0.5, 0.7, 0.8] {
        assert_eq!(
            Quality::for_overview_fraction(fraction, Quality::Low),
            Quality::Low
        );
    }
    assert_eq!(
        Quality::for_overview_fraction(0.81, Quality::Low),
        Quality::Medium
    );
    for current in [Quality::Medium, Quality::High] {
        assert_eq!(
            Quality::for_overview_fraction(0.66, current),
            Quality::Medium
        );
        assert_eq!(Quality::for_overview_fraction(0.65, current), Quality::Low);
    }
    for invalid in [f32::NAN, f32::INFINITY, 0.0, -1.0] {
        assert_eq!(
            Quality::for_overview_fraction(invalid, Quality::Low),
            Quality::High
        );
    }
}

#[test]
fn no_declaration_keeps_world_high() {
    // 未声明策略的 World 内容保持 High（炉体/第三方不被默认降档）。
    let (mut scene, resources) = fixture(mixed_snapshot("plain", 3, 3), 0.05, 1.0);
    scene.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .geometry_quality = None;
    scene.nodes[0].model_preview = None;
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    for _ in 0..8 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert!(!root.overview_lod);
    assert_eq!(root.quality.tier(), Quality::High);
}

#[test]
fn declaration_withdrawal_restores_high() {
    // 撤回声明（adapter 卸载）：下一次接受场景恢复 High，不保留低档表示。
    let (mut scene, resources) = fixture(mixed_snapshot("withdraw", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    scene.nodes[0]
        .composite_asset
        .as_mut()
        .unwrap()
        .geometry_quality = None;
    for _ in 0..4 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
}

#[test]
fn invalid_bounds_falls_back_to_high_with_degenerate_reason() {
    // 非有限规范 bounds → world_projection 返回 None → 保守 High 并报告 degenerate。
    let (mut scene, resources) = fixture(mixed_snapshot("degenerate", 3, 3), 0.05, 1.0);
    scene.nodes[0].composite_asset.as_mut().unwrap().layout_aabb =
        Some(crate::protocol::ModelAabbDto {
            min: [f32::NAN; 3],
            max: [f32::NAN; 3],
        });
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    for _ in 0..8 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.quality.tier(), Quality::High);
    assert_eq!(root.overview_reason, "degenerate");
}

#[test]
fn missing_surface_falls_back_to_high() {
    // 占比需要可视窗口高度：无 surface 无法判定 → 保守 High 并报告 degenerate。
    let (mut scene, resources) = fixture(mixed_snapshot("nosurface", 3, 3), 0.05, 1.0);
    scene.surface = None;
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    for _ in 0..8 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.quality.tier(), Quality::High);
    assert_eq!(root.overview_reason, "degenerate");
    assert!(root.overview_fraction.is_none());
}

#[test]
fn panning_does_not_recompute_and_zoom_does() {
    // 纯平移不改变正交档位，也不重算 bounds；zoom 变化才重算一次。
    let (mut scene, resources) = fixture(mixed_snapshot("pan", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let baseline = world
        .resource::<ModelVisuals>()
        .overview_work
        .bounds_rebuilds;
    // 平移到仍可见的小偏移（保持节点在视口内），key 不含平移，不重算 bounds。
    scene.viewport.x = -6.0;
    scene.viewport.y = -5.0;
    scene.nodes[0].x = 120.0;
    scene.nodes[0].y = 90.0;
    scene.nodes[0].composite_asset.as_mut().unwrap().x = 120.0;
    scene.nodes[0].composite_asset.as_mut().unwrap().y = 90.0;
    for _ in 0..4 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .overview_work
            .bounds_rebuilds,
        baseline,
        "平移不得重算投影 bounds"
    );
    scene.viewport.zoom = 0.5;
    quality(&mut world, &scene, None, now, &HashSet::new());
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .overview_work
            .bounds_rebuilds,
        baseline + 1,
        "zoom 变化应重算投影 bounds 一次"
    );
}

#[test]
fn placement_change_recomputes_and_repeats_are_cache_hits() {
    // fit/placement/旋转进入投影 key；相同输入重复提交不重算。
    let (mut scene, resources) = fixture(mixed_snapshot("placement", 3, 3), 0.2, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let baseline = world
        .resource::<ModelVisuals>()
        .overview_work
        .bounds_rebuilds;
    scene.nodes[0].model.as_mut().unwrap().placement.yaw = 33.0;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert!(
        world
            .resource::<ModelVisuals>()
            .overview_work
            .bounds_rebuilds
            > baseline,
        "placement 变化必须重算"
    );
    let baseline = world
        .resource::<ModelVisuals>()
        .overview_work
        .bounds_rebuilds;
    for _ in 0..3 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .overview_work
            .bounds_rebuilds,
        baseline,
        "相同输入重复提交不得重算"
    );
}

#[test]
fn offscreen_root_stays_low_without_chasing_zoom_and_updates_on_return() {
    // 屏外保留期间不随缩放反复准备；返回视口按最新投影更新为 High。
    let (mut scene, resources) = fixture(mixed_snapshot("offscreen", 3, 3), 0.05, 1.0);
    scene.nodes[0].x = 100_000.0;
    scene.nodes[0].composite_asset.as_mut().unwrap().x = 100_000.0;
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    {
        let root = &world.resource::<ModelVisuals>().roots["film"];
        assert_eq!(root.quality.tier(), Quality::Low);
        assert_eq!(root.overview_reason, "offscreen");
    }
    let generation = world.resource::<ModelVisuals>().roots["film"].representation_generation;
    let publishes = world.resource::<ModelVisuals>().overview_work.publishes;
    scene.viewport.zoom = 4.0;
    for _ in 0..4 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    {
        let models = world.resource::<ModelVisuals>();
        assert_eq!(
            models.roots["film"].representation_generation, generation,
            "屏外根不得随缩放反复准备"
        );
        assert_eq!(models.overview_work.publishes, publishes);
    }
    // 返回真实视口：按最新大投影先 Medium，停留后更新为 High。
    scene.nodes[0].x = 0.0;
    scene.nodes[0].composite_asset.as_mut().unwrap().x = 0.0;
    settle(&mut world, &scene, &mut now, Quality::High);
}

#[test]
fn high_owner_bypasses_offscreen_gate_and_hold_time() {
    // focus/capture 显式 High：越过屏外门禁与 250ms 保持时间。
    let (mut scene, resources) = fixture(mixed_snapshot("owner", 3, 3), 0.05, 1.0);
    scene.nodes[0].x = 100_000.0;
    scene.nodes[0].composite_asset.as_mut().unwrap().x = 100_000.0;
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::Low
    );
    // 同一保持窗口内（now 未推进超过 250ms）请求 capture pin。
    let pins: HashSet<String> = HashSet::from(["film".into()]);
    quality(&mut world, &scene, None, now, &pins);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(
        root.quality.tier(),
        Quality::High,
        "capture pin 必须立即提升"
    );
    assert_eq!(root.overview_desired, Quality::High);
}

#[test]
fn focus_owner_restores_high_for_overview_root() {
    // 进入聚焦：purpose Focus 覆盖 WorldOverview，恢复 High；退出后按当前投影重新决策。
    let (mut scene, resources) = fixture(mixed_snapshot("focus", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    scene.model_focus = serde_json::from_value(serde_json::json!({
        "version":"woohaa-model-focus-v1","nodeId":"film","target":[0,0,0],
        "yaw":0,"pitch":0,"distance":10,"fov":0.87
    }))
    .unwrap();
    quality(&mut world, &scene, Some("film"), now, &HashSet::new());
    now += 0.5;
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
    scene.model_focus = None;
    settle(&mut world, &scene, &mut now, Quality::Low);
}

#[test]
fn local_motion_playback_keeps_low_and_unbatches_parts() {
    // 低档片场播放：不因 playing 强制 High；带部件动作时切换非合批表示，保留真实层级。
    let (mut scene, resources) = fixture(mixed_snapshot("motion", 40, 0), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let mut playback: crate::protocol::AnimationPlayback =
        serde_json::from_value(serde_json::json!({
            "nodeId":"film","clipId":"a","sourceIdentity":"content-a","generation":1,
            "version":"woohaa-motion-ir-v1","time":1,"duration":4,"playing":true,
            "initialCamera":{"distance":8},
            "modelMotion":[{"targetId":"s0","startTime":0,"endTime":4,
                "motion":{"kind":"move","axis":"x","speed":2,"range":[0,8]}}]
        }))
        .unwrap();
    for generation in 1..5 {
        playback.generation = generation;
        playback.time = generation as f32;
        scene.animation_playback = Some(playback.clone());
        run_sync(&mut world, &scene, &resources);
        let instances = super::opacity_instances(&mut world);
        let mut models = world.remove_resource::<ModelVisuals>().unwrap();
        let mut materials = world
            .remove_resource::<Assets<StandardMaterial>>()
            .unwrap_or_default();
        super::super::runtime::apply_motion_playback(
            &mut world.commands(),
            &mut models,
            &mut materials,
            &instances,
            &scene,
        );
        world.flush();
        world.insert_resource(materials);
        world.insert_resource(models);
    }
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.quality.tier(), Quality::Low, "播放不得强制 High");
    assert!(!root.batched, "带部件动作的播放必须使用非合批表示");
    assert!(root.batches.is_empty());
    assert!(root.part_entities.contains_key("s0"));
}

#[test]
fn shared_custom_mesh_stays_high_for_overview_while_card_uses_low() {
    // 片场与普通卡片共享同一自定义 Mesh：片场消费原 High，卡片沿用 Low 简化。
    use crate::model3d::{scene::ModelGeometry, simplification::tests::sphere};
    let ModelGeometry::Mesh { vertices, faces, .. } = sphere() else {
        panic!()
    };
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2","signature":"shared","extent":2,
        "ops":[{"t":"mesh","id":"m","vertices":vertices,"faces":faces,
            "position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff"}]
    }))
    .unwrap();
    let mut film = film_set_node("film");
    film.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let mut card: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"card","type":"model","x":0,"y":0,"width":120,"height":100,
        "modelPreview":{"azimuth":0,"elevation":0.4,"distanceScale":1}
    }))
    .unwrap();
    card.model = film.model.clone();
    let reference = film.model.as_ref().unwrap();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = Scene {
        nodes: vec![film, card],
        ..Scene::default()
    };
    scene.viewport.zoom = 0.02;
    scene.surface = Some(surface(1.0));
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    for _ in 0..24 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
        if world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier()
            == Quality::Low
            && world.resource::<ModelVisuals>().pending.is_none()
        {
            break;
        }
    }
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["film"].quality.tier(), Quality::Low);
    // 片场自定义 Mesh 的实际 handle 必须是原 High 面数。
    let entity = models.roots["film"]
        .geometries
        .first()
        .map(|(entity, ..)| *entity)
        .expect("自定义 Mesh 实体存在");
    let mesh = world.entity(entity).get::<Mesh3d>().unwrap().0.clone();
    let triangles = world
        .resource::<Assets<Mesh>>()
        .get(&mesh)
        .map(|mesh| mesh.indices().map_or(0, |i| i.len() / 3))
        .unwrap();
    let original = super::super::mesh::build_mesh_quality(
        &ModelGeometry::Mesh {
            vertices: vertices.clone(),
            faces: faces.clone(),
            normals: None,
            uvs: None,
            colors: None,
        },
        Quality::High,
    )
    .unwrap();
    assert_eq!(triangles, original.indices().unwrap().len() / 3);
    // 卡片仍按 Low 准备（沿用既有简化行为）。
    assert_eq!(models.roots["card"].quality.tier(), Quality::Low);
}

#[test]
fn frame_budget_limits_specs_and_merges_latest_target() {
    // 重片场跨帧准备；每帧至多一个满批次（256 source specs）；High 优先合并最新目标。
    let (mut scene, resources) = fixture(mixed_snapshot("heavy", 600, 0), 4.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    // Medium 停留后已升 High。
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
    // 缩小触发 Low：首帧预算只推进部分 specs。
    let prepared_before = world
        .resource::<ModelVisuals>()
        .overview_work
        .specs_prepared;
    scene.viewport.zoom = 0.05;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    let work = &world.resource::<ModelVisuals>().overview_work;
    assert!(
        work.specs_prepared - prepared_before <= 256,
        "每帧至多 256 source specs（一个满批次）"
    );
    assert!(work.specs_prepared - prepared_before >= 1);
    assert!(work.prepare_calls >= 1);
    // 完整就绪前保留旧 High 表示。
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
    settle(&mut world, &scene, &mut now, Quality::Low);
    // 连续跨档：立即请求 High owner，合并到最新目标。
    let pins: HashSet<String> = HashSet::from(["film".into()]);
    quality(&mut world, &scene, None, now, &pins);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].overview_desired,
        Quality::High
    );
}

#[test]
fn failed_preparation_keeps_old_representation_and_reports_reason() {
    // 任一 replacement 失败：保持完整旧表示，不部分切档。
    let (mut scene, resources) = fixture(mixed_snapshot("fail", 3, 3), 4.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
    let generation = world.resource::<ModelVisuals>().roots["film"].representation_generation;
    // 注入一个非法几何部件（球半径 0 无法建网格）。
    world
        .resource_mut::<ModelVisuals>()
        .roots
        .get_mut("film")
        .unwrap()
        .geometries
        .push((
            Entity::PLACEHOLDER,
            "invalid".into(),
            Arc::new(crate::model3d::scene::ModelGeometry::Sphere { radius: 0.0 }),
        ));
    scene.viewport.zoom = 0.05;
    quality(&mut world, &scene, None, now, &HashSet::new());
    let models = world.resource::<ModelVisuals>();
    assert_eq!(
        models.roots["film"].quality.tier(),
        Quality::High,
        "失败不得部分切档"
    );
    assert_eq!(models.roots["film"].representation_generation, generation);
    assert!(models.overview_work.prepare_failures >= 1);
    assert_eq!(models.roots["film"].overview_reason, "prepare-failed");
}

#[test]
fn content_replacement_cancels_in_flight_preparation() {
    // 内容替换使在途旧准备失效，不发布旧布局。
    let (mut scene, resources) = fixture(mixed_snapshot("a", 600, 0), 4.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    scene.viewport.zoom = 0.05;
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert!(
        world.resource::<ModelVisuals>().pending.is_some(),
        "重片场应分帧准备"
    );
    let mut resources = resources;
    let mut replacement = mixed_snapshot("b", 600, 0);
    replacement.signature = "b".into();
    let reference = scene.nodes[0].model.as_mut().unwrap();
    *reference = reference_for(&replacement, ModelPlacement::default());
    resources.insert(reference.resource_key.clone(), Arc::new(replacement));
    run_sync(&mut world, &scene, &resources);
    quality(&mut world, &scene, None, now, &HashSet::new());
    assert!(
        world.resource::<ModelVisuals>().overview_work.cancels >= 1,
        "内容替换必须作废在途准备"
    );
}

#[test]
fn diagnostics_are_bounded_and_report_actual_work() {
    // 有界诊断：每根占比、desired/published/原因/代数与工作量计数来自实际 handle。
    // 从 High 缩到 Low 以产生一次真实发布。
    let (mut scene, resources) = fixture(mixed_snapshot("diag", 3, 3), 8.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::High
    );
    scene.viewport.zoom = 0.05;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let materials = world.remove_resource::<Assets<StandardMaterial>>().unwrap();
    let models = world.resource::<ModelVisuals>();
    let budget: serde_json::Value =
        serde_json::from_str(&models.budget_json(&meshes, &materials)).unwrap();
    let overview = &budget["overviewLod"];
    assert_eq!(overview["total"], 1);
    assert_eq!(overview["truncated"], 0);
    assert_eq!(overview["roots"][0]["nodeId"], "film");
    assert_eq!(overview["roots"][0]["published"], "Low");
    assert_eq!(overview["roots"][0]["desired"], "Low");
    assert!(
        overview["roots"][0]["viewportFraction"].as_f64().unwrap()
            < Quality::OVERVIEW_MEDIUM_ENTER as f64
    );
    assert!(overview["roots"][0]["activeMeshes"].as_u64().unwrap() > 0);
    assert!(overview["work"]["publishes"].as_u64().unwrap() >= 1);
    assert!(overview["work"]["specsPrepared"].as_u64().unwrap() >= 1);
    // 重复读取不累加计数。
    let publishes = overview["work"]["publishes"].clone();
    let again: serde_json::Value =
        serde_json::from_str(&models.budget_json(&meshes, &materials)).unwrap();
    assert_eq!(again["overviewLod"]["work"]["publishes"], publishes);
    world.insert_resource(meshes);
    world.insert_resource(materials);
    let _ = &mut scene;
}

#[test]
fn unpublished_low_reports_published_high_and_high_handles() {
    // 目标 Low 尚未准备完成：诊断同时报告 desired Low、published High 与准备状态；
    // 活动面数按 High handle 统计，不提前宣称减量。
    let (mut scene, resources) = fixture(mixed_snapshot("pending", 600, 0), 4.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    quality(&mut world, &scene, None, now, &HashSet::new());
    now += 0.5;
    scene.viewport.zoom = 0.05;
    quality(&mut world, &scene, None, now, &HashSet::new());
    let meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let materials = world.remove_resource::<Assets<StandardMaterial>>().unwrap();
    let models = world.resource::<ModelVisuals>();
    let value: serde_json::Value =
        serde_json::from_str(&models.budget_json(&meshes, &materials)).unwrap();
    let root = &value["overviewLod"]["roots"][0];
    assert_eq!(root["desired"], "Low");
    assert_eq!(root["published"], "High");
    assert!(models.pending.is_some());
    world.insert_resource(meshes);
    world.insert_resource(materials);
}

#[test]
fn no_publish_for_content_without_geometry() {
    // 空片场/纯媒体：无图元时保持合法（High），不建立准备。
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2","signature":"empty","extent":1,
        "ops":[{"t":"group","id":"root"}]
    }))
    .unwrap();
    let (scene, resources) = fixture(snapshot, 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    for _ in 0..4 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    let models = world.resource::<ModelVisuals>();
    assert_eq!(models.roots["film"].quality.tier(), Quality::High);
    assert!(models.pending.is_none());
    assert_eq!(models.overview_work.publishes, 0);
}

#[test]
fn motion_scale_promotes_conservatively_without_reevaluating() {
    // 已有动作采样放大几何：总览根保守提升 High 并报告原因；不额外执行动作求值。
    let (mut scene, resources) = fixture(mixed_snapshot("scale-motion", 40, 0), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    scene.animation_playback =
        Some(serde_json::from_value(serde_json::json!({
            "nodeId":"film","clipId":"a","sourceIdentity":"content-a","generation":1,
            "version":"woohaa-motion-ir-v1","time":1,"duration":4,"playing":true,
            "initialCamera":{"distance":8},
            "modelMotion":[{"targetId":"s0","startTime":0,"endTime":4,
                "motion":{"kind":"oscillate","axis":"x","mode":"scale","speed":1,"amplitude":8,"phase":0}}]
        }))
        .unwrap());
    run_sync(&mut world, &scene, &resources);
    // 动作计划解析后，总览根保守提升 High。
    settle(&mut world, &scene, &mut now, Quality::High);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].overview_reason,
        "motion-bounds"
    );
    // 动作计划身份与分辨率：重复同输入不重复解析。
    let plan = world
        .resource::<ModelVisuals>()
        .motion_plan
        .clone()
        .unwrap();
    for generation in 2..5 {
        let playback = scene.animation_playback.as_mut().unwrap();
        playback.generation = generation;
        playback.time = generation as f32;
        run_sync(&mut world, &scene, &resources);
        assert!(Arc::ptr_eq(
            &plan,
            world
                .resource::<ModelVisuals>()
                .motion_plan
                .as_ref()
                .unwrap()
        ));
    }
}

#[test]
fn ordinary_playing_does_not_force_high_without_scale_motion() {
    // 普通平移/旋转播放不因 playing 永久钉 High（无 scale 动作时仍按投影决策）。
    let (mut scene, resources) = fixture(mixed_snapshot("move-motion", 40, 0), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    scene.animation_playback = Some(
        serde_json::from_value(serde_json::json!({
            "nodeId":"film","clipId":"a","sourceIdentity":"content-a","generation":1,
            "version":"woohaa-motion-ir-v1","time":1,"duration":4,"playing":true,
            "initialCamera":{"distance":8},
            "modelMotion":[{"targetId":"s0","startTime":0,"endTime":4,
                "motion":{"kind":"move","axis":"x","speed":2,"range":[0,8]}}]
        }))
        .unwrap(),
    );
    for generation in 1..5 {
        let playback = scene.animation_playback.as_mut().unwrap();
        playback.generation = generation;
        playback.time = generation as f32;
        run_sync(&mut world, &scene, &resources);
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.5;
    }
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"]
            .quality
            .tier(),
        Quality::Low,
        "普通播放不得强制 High"
    );
}

#[test]
fn stable_tiers_do_not_regenerate_or_republish() {
    // 稳定档位、纯平移与稳定播放不得反复生成/发布。
    let (scene, resources) = fixture(mixed_snapshot("stable", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let publishes = world.resource::<ModelVisuals>().overview_work.publishes;
    let builds = world.resource::<ModelVisuals>().shared.work.built_meshes;
    let batch_builds = world
        .resource::<ModelVisuals>()
        .shared
        .batches
        .work
        .build_attempts;
    for _ in 0..10 {
        quality(&mut world, &scene, None, now, &HashSet::new());
        now += 0.25;
    }
    let models = world.resource::<ModelVisuals>();
    assert_eq!(
        models.overview_work.publishes, publishes,
        "稳定档位不得反复发布"
    );
    assert_eq!(
        models.shared.work.built_meshes, builds,
        "稳定档位不得反复生成网格"
    );
    assert_eq!(
        models.shared.batches.work.build_attempts, batch_builds,
        "稳定档位不得反复构建批次"
    );
}

/// 任务 5.3：用实际 Bevy Mesh 核对 `notes/geometry-budget.json` 的图元档位三角面表，
/// 防止工具表与运行时细分漂移（工具脚本的 `TIER_TRIANGLES` 必须与此一致）。
#[test]
fn bevy_overview_tier_triangles_match_tool_table() {
    use crate::model3d::scene::ModelGeometry;
    let table = [
        (
            ModelGeometry::Box {
                size: [1.0, 1.0, 1.0],
            },
            [12, 12, 12],
        ),
        (ModelGeometry::Sphere { radius: 1.0 }, [528, 120, 24]),
        (
            ModelGeometry::Cylinder {
                radius: 1.0,
                height: 2.0,
            },
            [92, 44, 20],
        ),
        (
            ModelGeometry::Capsule {
                radius: 1.0,
                height: 3.0,
            },
            [288, 96, 48],
        ),
    ];
    for (geometry, expected) in table {
        let actual =
            [Quality::High, Quality::OverviewMedium, Quality::OverviewLow].map(|quality| {
                let mesh = super::super::mesh::build_mesh_quality(&geometry, quality)
                    .expect("legal primitive");
                mesh.indices().expect("indexed").len() / 3
            });
        assert_eq!(actual, expected, "{geometry:?} 档位三角面必须与工具表一致");
    }
}

/// 任务 5.3：自定义 Mesh 各档保留原始面数（片场策略不新增自定义网格简化）。
#[test]
fn custom_mesh_retains_authored_faces_at_every_tier() {
    use crate::model3d::{scene::ModelGeometry, simplification::tests::sphere};
    let ModelGeometry::Mesh { vertices, faces, .. } = sphere() else {
        panic!()
    };
    let authored = faces.len();
    let geometry = ModelGeometry::Mesh {
        vertices,
        faces,
        normals: None,
        uvs: None,
        colors: None,
    };
    for quality in [Quality::High, Quality::Medium, Quality::Low] {
        let mesh = super::super::mesh::build_mesh_quality(&geometry, quality).unwrap();
        assert_eq!(
            mesh.indices().unwrap().len() / 3,
            authored,
            "自定义 Mesh 在 {quality:?} 必须保留原面数"
        );
    }
}

/// 任务 5.3：有效档位只降受支持图元；Box 与总览根自定义 Mesh 保持 High。
#[test]
fn effective_quality_only_lowers_supported_primitives() {
    use crate::model3d::{mesh::effective_quality, scene::ModelGeometry};
    let box_geometry = ModelGeometry::Box {
        size: [1.0, 1.0, 1.0],
    };
    let sphere_geometry = ModelGeometry::Sphere { radius: 1.0 };
    let custom = ModelGeometry::Mesh {
        vertices: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        faces: vec![[0, 1, 2]],
        normals: None,
        uvs: None,
        colors: None,
    };
    assert_eq!(
        effective_quality(&box_geometry, Quality::Low, true),
        Quality::High
    );
    assert_eq!(
        effective_quality(&sphere_geometry, Quality::Low, true),
        Quality::Low
    );
    assert_eq!(
        effective_quality(&custom, Quality::Low, true),
        Quality::High
    );
    // 普通卡片（overview=false）沿用既有简化行为：自定义 Mesh 用请求档位。
    assert_eq!(
        effective_quality(&custom, Quality::Low, false),
        Quality::Low
    );
    assert_eq!(
        effective_quality(&sphere_geometry, Quality::Medium, false),
        Quality::Medium
    );
}

#[test]
fn zoom_within_low_preserves_meshes_and_batches() {
    let (mut scene, resources) = fixture(mixed_snapshot("fixed-subdivisions", 8, 0), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let models = world.resource::<ModelVisuals>();
    let quality = models.roots["film"].quality;
    let generation = models.roots["film"].representation_generation;
    let builds = models.shared.batches.work.build_attempts;
    for zoom in [0.7, 0.05] {
        scene.viewport.zoom = zoom;
        settle(&mut world, &scene, &mut now, Quality::Low);
        let models = world.resource::<ModelVisuals>();
        assert_eq!(models.roots["film"].quality, quality);
        assert_eq!(models.roots["film"].representation_generation, generation);
        assert_eq!(models.shared.batches.work.build_attempts, builds);
    }
}

#[test]
fn medium_dwell_promotes_only_after_ten_seconds_and_resets() {
    let (mut scene, resources) = fixture(mixed_snapshot("dwell", 3, 3), 8.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewMedium
    );
    quality(&mut world, &scene, None, 10.0, &HashSet::new());
    quality(&mut world, &scene, None, 19.99, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewMedium
    );
    quality(&mut world, &scene, None, 20.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
    quality(&mut world, &scene, None, 25.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
    scene.viewport.zoom = 0.05;
    quality(&mut world, &scene, None, 26.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewLow
    );
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].overview_medium_since,
        None
    );
    scene.viewport.zoom = 8.0;
    quality(&mut world, &scene, None, 27.0, &HashSet::new());
    quality(&mut world, &scene, None, 36.99, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewMedium
    );
    quality(&mut world, &scene, None, 37.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
}

#[test]
fn selection_promotes_immediately_and_deselection_restores_overview() {
    let (mut scene, resources) = fixture(mixed_snapshot("selected", 3, 3), 0.05, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    quality(&mut world, &scene, None, 1.0, &HashSet::new());
    scene.selection.nodes.push("film".into());
    quality(&mut world, &scene, None, 1.01, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
    scene.selection.nodes.clear();
    quality(&mut world, &scene, None, 2.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewLow
    );
    // 已选中的片场首次创建直接使用 High。
    scene.selection.nodes.push("film".into());
    let mut selected_world = world_with_resources();
    run_sync(&mut selected_world, &scene, &resources);
    assert_eq!(
        selected_world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
}

#[test]
fn offscreen_time_does_not_count_towards_medium_dwell() {
    let (mut scene, resources) = fixture(mixed_snapshot("offscreen-dwell", 3, 3), 8.0, 1.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    quality(&mut world, &scene, None, 1.0, &HashSet::new());
    scene.viewport.x = -100_000.0;
    quality(&mut world, &scene, None, 2.0, &HashSet::new());
    scene.viewport.x = 0.0;
    quality(&mut world, &scene, None, 20.0, &HashSet::new());
    quality(&mut world, &scene, None, 29.99, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::OverviewMedium
    );
    quality(&mut world, &scene, None, 30.0, &HashSet::new());
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].quality,
        Quality::High
    );
}

/// 片场 group 的徽标场景：组合资源按 binding 前缀拆分，但总览 LOD 仍以 group owner 为根。
fn group_film_set_fixture(declared: bool, zoom: f32) -> (Scene, ModelAssets) {
    let mut ops = vec![serde_json::json!({"t":"group","id":"1:a"})];
    for i in 0..3 {
        ops.push(serde_json::json!({"t":"sphere","id":format!("1:a4:s{i}"),"parent":"1:a","radius":1,"color":"#ffffff"}));
    }
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "group-overview", "extent": 12, "ops": ops
    }))
    .unwrap();
    let mut group = serde_json::json!({
        "title": "", "memberCount": 1, "outputCapableLeafCount": 0, "badgeScale": 3
    });
    if declared {
        group["geometryQuality"] = serde_json::json!("overview-primitives-v1");
    }
    let mut node: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "film", "type": "group", "x": 0, "y": 0, "width": 400, "height": 300,
        "group": group
    }))
    .unwrap();
    node.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let reference = node.model.as_ref().unwrap();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, node.model.clone());
    scene.viewport.zoom = zoom;
    scene.surface = Some(surface(1.0));
    scene.film_set_groups = vec![serde_json::from_value(serde_json::json!({
        "schemaVersion": "woohaa-film-set-group-render-v1",
        "ownerId": "film",
        "badgeOrigin": {"x": 200.0, "y": 300.0},
        "bindings": [{
            "bindingId": "a", "sourceNodeId": "source", "kind": "model3d", "contentKey": "model3d:v1",
            "transform": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0, "scale": 1.0}, "visible": true
        }]
    }))
    .unwrap()];
    (scene, resources)
}

#[test]
fn group_owned_film_set_badge_keeps_overview_lod() {
    let (mut scene, resources) = group_film_set_fixture(true, 0.05);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    {
        let root = &world.resource::<ModelVisuals>().roots["film"];
        assert!(root.overview_lod);
        assert_eq!(root.group_children.len(), 1);
        assert!(root.group_children["a"].overview_lod);
    }
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    scene.viewport.zoom = 8.0;
    settle(&mut world, &scene, &mut now, Quality::High);
}

#[test]
fn group_without_declaration_stays_high() {
    let (scene, resources) = group_film_set_fixture(false, 0.05);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert!(!root.overview_lod);
    assert_eq!(root.quality, Quality::High);
}

/// 合批回归用片场：单个 binding 下 `parts` 个同材质球体，binding 带非零摆放。
fn group_badge_batch_fixture(parts: usize, binding_x: f32) -> (Scene, ModelAssets) {
    let mut ops = vec![serde_json::json!({"t":"group","id":"1:a"})];
    for i in 0..parts {
        ops.push(serde_json::json!({"t":"sphere","id":format!("1:a4:s{i}"),"parent":"1:a","radius":1,"color":"#ffffff"}));
    }
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": format!("group-batch-{parts}"), "extent": 12, "ops": ops
    }))
    .unwrap();
    let mut node: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "film", "type": "group", "x": 0, "y": 0, "width": 400, "height": 300,
        "group": {"title":"","memberCount":1,"outputCapableLeafCount":0,"badgeScale":3,
                  "geometryQuality":"overview-primitives-v1"}
    }))
    .unwrap();
    node.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let reference = node.model.as_ref().unwrap().clone();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    scene.viewport.zoom = 0.05;
    scene.surface = Some(surface(1.0));
    scene.film_set_groups = vec![serde_json::from_value(serde_json::json!({
        "schemaVersion": "woohaa-film-set-group-render-v1",
        "ownerId": "film",
        "badgeOrigin": {"x": 200.0, "y": 300.0},
        "bindings": [{
            "bindingId": "a", "sourceNodeId": "source", "kind": "model3d", "contentKey": "model3d:v1",
            "transform": {"x": binding_x, "y": 0.0, "z": 0.0, "yaw": 0.0, "scale": 1.0}, "visible": true
        }]
    }))
    .unwrap()];
    (scene, resources)
}

/// 多 binding 的片场 ops：每个 binding 各指定数量个同材质球体。
fn group_badge_ops(bindings: &[(&str, usize)]) -> Vec<serde_json::Value> {
    let mut ops = Vec::new();
    for (binding, parts) in bindings {
        let prefix = binding.len();
        ops.push(serde_json::json!({"t":"group","id":format!("{prefix}:{binding}")}));
        for i in 0..*parts {
            ops.push(serde_json::json!({
                "t":"sphere","id":format!("{prefix}:{binding}4:s{i}"),
                "parent":format!("{prefix}:{binding}"),"radius":1,"color":"#ffffff"
            }));
        }
    }
    ops
}

/// 多 binding 片场：每个 binding 各 `parts` 个同材质球体，binding 摆放沿 x 递增。
fn group_badge_multi_binding_fixture(bindings: &[&str], parts: usize) -> (Scene, ModelAssets) {
    let counts: Vec<_> = bindings.iter().map(|binding| (*binding, parts)).collect();
    let ops = group_badge_ops(&counts);
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "group-batch-multi", "extent": 12, "ops": ops
    }))
    .unwrap();
    let mut node: GraphNode = serde_json::from_value(serde_json::json!({
        "id": "film", "type": "group", "x": 0, "y": 0, "width": 400, "height": 300,
        "group": {"title":"","memberCount":1,"outputCapableLeafCount":0,"badgeScale":3,
                  "geometryQuality":"overview-primitives-v1"}
    }))
    .unwrap();
    node.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let reference = node.model.as_ref().unwrap().clone();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    scene.viewport.zoom = 0.05;
    scene.surface = Some(surface(1.0));
    let bindings: Vec<_> = bindings
        .iter()
        .enumerate()
        .map(|(index, id)| {
            serde_json::json!({
                "bindingId": id, "sourceNodeId": format!("source-{id}"), "kind": "model3d",
                "contentKey": "model3d:v1",
                "transform": {"x": index as f32 * 4.0, "y": 0.0, "z": 0.0, "yaw": 0.0, "scale": 1.0},
                "visible": true
            })
        })
        .collect();
    scene.film_set_groups = vec![serde_json::from_value(serde_json::json!({
        "schemaVersion": "woohaa-film-set-group-render-v1",
        "ownerId": "film",
        "badgeOrigin": {"x": 200.0, "y": 300.0},
        "bindings": bindings
    }))
    .unwrap()];
    (scene, resources)
}

/// draw call 代理：多个 binding 的同材质球体应合成「每 binding 一个批次」，而不是逐部件。
#[test]
fn group_badge_draw_call_proxy_is_one_batch_per_binding() {
    let (scene, resources) = group_badge_multi_binding_fixture(&["a", "b", "c"], 40);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.batches.len(), 3, "每个 binding 各一个同材质批次");
    assert_eq!(root.part_batches.len(), 120);
    assert!(root.geometries.is_empty(), "合批后不再逐部件提交");
    for binding in ["a", "b", "c"] {
        let binding_root = root.part_entities[&format!("1:{binding}")];
        let batch = root
            .batches
            .iter()
            .find(|batch| {
                world.entity(batch.entity).get::<ChildOf>().unwrap().parent() == binding_root
            })
            .unwrap_or_else(|| panic!("binding {binding} 的批次必须挂在它的根实体下"));
        assert_eq!(batch.source.specs.len(), 40);
    }
    // 主通道 Mesh3d 实体数 = 实际提交的绘制实体数（3 批），远小于 120 个部件。
    let mesh_entities = world
        .iter_entities()
        .filter(|entity| entity.contains::<Mesh3d>())
        .count();
    assert_eq!(mesh_entities, 3);

    // 诊断字段是真实 GPU 上 draw call 变化的 CPU 代理，必须如实反映徽标内的批次。
    let meshes = world.remove_resource::<Assets<Mesh>>().unwrap();
    let materials = world.remove_resource::<Assets<StandardMaterial>>().unwrap();
    let models = world.resource::<ModelVisuals>();
    let budget: serde_json::Value =
        serde_json::from_str(&models.budget_json(&meshes, &materials)).unwrap();
    world.insert_resource(meshes);
    world.insert_resource(materials);
    assert_eq!(budget["staticBatches"], 3);
    assert_eq!(budget["batchedParts"], 120);
    let root = &budget["overviewLod"]["roots"][0];
    assert_eq!(root["batches"], 3);
    assert_eq!(root["batchedParts"], 120);
    assert_eq!(root["unbatchedParts"], 0);
}

/// 单个 binding 内容变化时只重建该 binding：其它 binding 的批次仍由 owner 持有且实体有效。
#[test]
fn unrelated_binding_rebuild_keeps_other_binding_batches() {
    let (mut scene, mut resources) = group_badge_multi_binding_fixture(&["a", "b"], 10);
    let key = scene.nodes[0].model.as_ref().unwrap().resource_key.clone();
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let a_root = world.resource::<ModelVisuals>().roots["film"].part_entities["1:a"];
    let a_batch = world
        .resource::<ModelVisuals>()
        .roots["film"]
        .batches
        .iter()
        .find(|batch| {
            world.entity(batch.entity).get::<ChildOf>().unwrap().parent() == a_root
        })
        .map(|batch| batch.entity)
        .expect("binding a 批次");

    // 只有 binding b 的内容变化（a 的 ops 逐字节不变）。
    let ops = group_badge_ops(&[("a", 10), ("b", 11)]);
    let replacement: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "group-batch-multi-v2",
        "extent": 12, "ops": ops
    }))
    .unwrap();
    resources.insert(key.clone(), Arc::new(replacement));
    run_sync(&mut world, &scene, &resources);

    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.batches.len(), 2, "a 的批次不能被 b 的重建挤掉");
    assert_eq!(root.part_batches.len(), 21);
    assert!(root.batches.iter().any(|batch| batch.entity == a_batch));
    assert!(
        world.get_entity(a_batch).is_ok(),
        "未变化 binding 的批次实体必须保留"
    );

    // 移除 binding b：只摘除 b 的批次条目与实体，a 仍保留。
    let b_root = world.resource::<ModelVisuals>().roots["film"].part_entities["1:b"];
    let b_batch = world
        .resource::<ModelVisuals>()
        .roots["film"]
        .batches
        .iter()
        .find(|batch| batch.entity != a_batch)
        .map(|batch| batch.entity)
        .expect("binding b 批次");
    assert_eq!(world.entity(b_batch).get::<ChildOf>().unwrap().parent(), b_root);
    let ops = group_badge_ops(&[("a", 10)]);
    let replacement: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "group-batch-multi-v3",
        "extent": 12, "ops": ops
    }))
    .unwrap();
    resources.insert(key.clone(), Arc::new(replacement));
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.batches.len(), 1);
    assert_eq!(root.part_batches.len(), 10);
    assert!(root.batches.iter().any(|batch| batch.entity == a_batch));
    assert!(world.get_entity(a_batch).is_ok());
    assert!(world.get_entity(b_batch).is_err(), "移除的 binding 批次必须销毁");
}

/// 批量大小是 draw call 的 CPU 代理：同材质部件必须收进一个批次实体，且批次仍挂在
/// binding 根实体下（运行时摆放/显隐写在那一层，不能被平铺到子根）。
#[test]
fn group_badge_batches_same_material_parts_under_binding_root() {
    let (mut scene, resources) = group_badge_batch_fixture(12, 3.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let binding_root = {
        let root = &world.resource::<ModelVisuals>().roots["film"];
        assert_eq!(root.batches.len(), 1, "12 个同材质球应合成一个批次");
        assert_eq!(root.part_batches.len(), 12);
        assert!(root.geometries.is_empty(), "合批后不再逐部件提交");
        let binding_root = root.part_entities["1:a"];
        let batch_entity = root.batches[0].entity;
        assert_eq!(
            world.entity(batch_entity).get::<ChildOf>().unwrap().parent(),
            binding_root,
            "批次必须挂在 binding 根实体下"
        );
        binding_root
    };

    // 运行时摆放写到 binding 根；批次作为子实体继承同一 transform/可见性。
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    let mut commands = world.commands();
    crate::model3d::item_placement::sync(&mut commands, &mut models, &scene);
    world.flush();
    world.insert_resource(models);
    assert_eq!(
        world.get::<Transform>(binding_root).unwrap().translation.x,
        3.0
    );
    assert_eq!(
        *world.get::<Visibility>(binding_root).unwrap(),
        Visibility::Inherited
    );

    // 隐藏 binding：写在 binding 根上，批次作为子实体随层级一起不可见。
    scene.film_set_groups[0].bindings[0].visible = false;
    let mut models = world.remove_resource::<ModelVisuals>().unwrap();
    let mut commands = world.commands();
    crate::model3d::item_placement::sync(&mut commands, &mut models, &scene);
    world.flush();
    world.insert_resource(models);
    assert_eq!(
        *world.get::<Visibility>(binding_root).unwrap(),
        Visibility::Hidden
    );
}

/// 片场 group 的 hover 预览必须保留 authored 层级：总览合批会把只做平移的父级组
/// 平铺到 binding 根，导致 `apply_motion_playback` 写到组实体上的旋转没有可见几何。
/// （回归：hover 镜头节点只看到镜头环绕，聚焦后人物四肢才动。）
#[test]
fn group_part_motion_playback_unbatches_binding_hierarchy() {
    let snapshot: ModelSnapshot = serde_json::from_value(serde_json::json!({
        "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"group-motion-hierarchy", "extent":12,
        "ops":[
            {"t":"group","id":"1:a"},
            {"t":"group","id":"1:a4:root","parent":"1:a","position":[0,0,0]},
            {"t":"group","id":"1:a5:torso","parent":"1:a4:root","position":[0,1,0]},
            {"t":"box","id":"1:a3:arm","parent":"1:a5:torso","position":[0,-0.5,0],
             "size":[0.2,1,0.2],"color":"#ffffff"}
        ]
    }))
    .unwrap();
    let mut node: GraphNode = serde_json::from_value(serde_json::json!({
        "id":"film", "type":"group", "x":0, "y":0, "width":400, "height":300,
        "group": {"title":"", "memberCount":1, "outputCapableLeafCount":0, "badgeScale":3,
                  "geometryQuality":"overview-primitives-v1"}
    }))
    .unwrap();
    node.model = Some(reference_for(&snapshot, ModelPlacement::default()));
    let reference = node.model.as_ref().unwrap().clone();
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = scene_with(&node, Some(reference));
    scene.viewport.zoom = 0.05;
    scene.surface = Some(surface(1.0));
    scene.film_set_groups = vec![serde_json::from_value(serde_json::json!({
        "schemaVersion":"woohaa-film-set-group-render-v1",
        "ownerId":"film",
        "badgeOrigin":{"x":200.0,"y":300.0},
        "bindings":[{
            "bindingId":"a", "sourceNodeId":"source", "kind":"model3d", "contentKey":"model3d:v1",
            "transform":{"x":0.0,"y":0.0,"z":0.0,"yaw":0.0,"scale":1.0}, "visible":true
        }]
    }))
    .unwrap()];
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);

    // 合批后手臂几何被平铺到 binding 根，torso 组实体没有子几何。
    {
        let models = world.resource::<ModelVisuals>();
        let root = &models.roots["film"];
        assert!(root.batched);
        let arm = root.part_entities["1:a3:arm"];
        let torso = root.part_entities["1:a5:torso"];
        assert_ne!(
            world.get::<ChildOf>(arm).expect("arm parent").parent(),
            torso,
            "flattened arm must leave the torso hierarchy"
        );
    }

    // 带 object 动作的 hover 预览必须切换非合批表示，手臂重新挂回 torso。
    scene.animation_playback = Some(serde_json::from_value(serde_json::json!({
        "clipId":"clip", "sourceIdentity":"s", "generation":1,
        "viewMode":"shot-node-preview", "targetPreviewNodeId":"preview", "nodeId":"film",
        "version":"woohaa-motion-ir-v1", "time":0.5, "duration":4, "looped":true, "playing":true,
        "initialCamera":{"aspect":"16:9","azimuth":0,"elevation":0.4,"distance":5,"focusOffset":[0,0,0]},
        "cameraMotion":[],
        "objects":[{
            "itemId":"a",
            "playback":{"startTime":0,"duration":4,"timeScale":1,"loop":true},
            "partIds":{"root":"1:a4:root","torso":"1:a5:torso"},
            "modelMotion":[{"targetId":"1:a5:torso","motion":{"kind":"rotate","axis":"y","speed":1}}]
        }]
    }))
    .unwrap());
    run_sync(&mut world, &scene, &resources);
    let models = world.resource::<ModelVisuals>();
    let root = &models.roots["film"];
    assert!(!root.batched, "带 object 动作的 hover 预览必须切换非合批表示");
    assert_eq!(
        world
            .get::<ChildOf>(root.part_entities["1:a3:arm"])
            .expect("arm parent")
            .parent(),
        root.part_entities["1:a5:torso"],
        "非合批表示必须保留 authored torso 层级"
    );
}

/// 进入模型聚焦/对象编辑时恢复逐部件表示，退出后重新合批（LOD 发布与动画替换都要求
/// 部件索引与批次归属一致）。
#[test]
fn group_badge_rebuilds_between_batched_and_focused_representations() {
    let (mut scene, resources) = group_badge_batch_fixture(12, 0.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world.resource::<ModelVisuals>().roots["film"].batches.len(),
        1
    );

    scene.model_focus = serde_json::from_value(serde_json::json!({
        "version":"woohaa-model-focus-v1","nodeId":"film","target":[0,0,0],
        "yaw":0,"pitch":0,"distance":10,"fov":0.87
    }))
    .unwrap();
    run_sync(&mut world, &scene, &resources);
    {
        let root = &world.resource::<ModelVisuals>().roots["film"];
        assert!(root.batches.is_empty(), "聚焦时必须逐部件提交");
        assert!(root.part_batches.is_empty());
        assert_eq!(root.geometries.len(), 12);
        assert_eq!(root.part_entities.len(), 13, "binding 根 + 12 个部件");
    }

    scene.model_focus = None;
    run_sync(&mut world, &scene, &resources);
    let root = &world.resource::<ModelVisuals>().roots["film"];
    assert_eq!(root.batches.len(), 1, "退出聚焦后重新合批");
    assert_eq!(root.part_batches.len(), 12);
    assert!(root.geometries.is_empty());
}

/// 总览切档必须同时重建批次几何，而不是只更新逐部件实体。
#[test]
fn group_badge_batches_follow_overview_quality_changes() {
    let (mut scene, resources) = group_badge_batch_fixture(12, 0.0);
    let mut world = world_with_resources();
    run_sync(&mut world, &scene, &resources);
    let mut now = 1.0;
    settle(&mut world, &scene, &mut now, Quality::Low);
    let low = world.resource::<ModelVisuals>().roots["film"].batches[0]
        .asset
        .handle
        .clone();
    scene.viewport.zoom = 8.0;
    settle(&mut world, &scene, &mut now, Quality::High);
    let high = world.resource::<ModelVisuals>().roots["film"].batches[0]
        .asset
        .handle
        .clone();
    assert_ne!(low.id(), high.id(), "切档必须替换批次几何");
}
