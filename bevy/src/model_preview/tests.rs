use super::*;

#[test]
fn ordinary_preview_refresh_preserves_shot_camera_illumination() {
    let mut world = World::new();
    let light = world.spawn((DirectionalLight::default(), RenderLayers::from_layers(&[0, 7, 40, 41]))).id();
    for layers in [RenderLayers::from_layers(&[0, 7, 8]), RenderLayers::from_layers(&[0, 7, 9])] {
        merge_scene_light_layers(&mut world, &layers);
        let actual = world.get::<RenderLayers>(light).unwrap();
        for layer in [0, 7, 40, 41] {
            assert!(actual.intersects(&RenderLayers::layer(layer)));
        }
        assert!(actual.intersects(&layers));
    }
}

/// 单张模型卡片的 app；模型根由调用方显式推进（生产里由 `scene3d::sync_models` 完成）。
fn model_card_app() -> App {
    let nodes = serde_json::from_str(
        r#"[{ "id": "m", "type": "model", "x": 0, "y": 0,
            "width": 272, "height": 248,
            "model": { "resourceKey": "model", "signature": "s" },
            "modelPreview": { "azimuth": 0.5, "elevation": 0.4, "distanceScale": 1 }
        }]"#,
    )
    .unwrap();
    let scene = crate::protocol::Scene { nodes, ..default() };
    let snapshot: crate::protocol::ModelSnapshot = serde_json::from_str(
        r##"{
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "s", "extent": 1,
        "ops": [{ "t": "sphere", "id": "body", "radius": 1,
            "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1], "color": "#ffffff" }]
    }"##,
    )
    .unwrap();
    let mut app = App::new();
    app.init_resource::<Previews>()
        .init_resource::<crate::app::PreviewLayerPool>()
        .init_resource::<Time>()
        .init_resource::<crate::app::FocusRig>()
        .init_resource::<Ready>()
        .init_resource::<render_work::RenderWork>()
        .init_resource::<Assets<Image>>()
        .init_resource::<Assets<Mesh>>()
        .init_resource::<Assets<StandardMaterial>>()
        .init_resource::<model3d::ModelVisuals>()
        .init_resource::<model3d::FocusVisuals>()
        .init_resource::<crate::theme::ThemeResource>()
        .insert_resource(CurrentScene(scene))
        .insert_resource(SurfaceState::with_size(Vec2::new(1200.0, 800.0)))
        .insert_resource(crate::app::FrameFlags {
            changed: true,
            ..default()
        })
        .insert_resource(ModelAssetTable(HashMap::from([(
            "model".into(),
            Arc::new(snapshot),
        )])))
        .add_systems(Update, sync);
    app
}

/// 复刻 `scene3d::sync_models` 的职责：把当前场景与资源表推进为模型根。
fn spawn_model_roots(app: &mut App) {
    let resources = app.world().resource::<ModelAssetTable>().0.clone();
    let scene = app.world().resource::<CurrentScene>().0.clone();
    let mut models = app.world_mut().remove_resource::<model3d::ModelVisuals>().unwrap();
    let mut focus = app
        .world_mut()
        .remove_resource::<model3d::FocusVisuals>()
        .unwrap_or_default();
    let mut meshes = app.world_mut().remove_resource::<Assets<Mesh>>().unwrap();
    let mut materials = app
        .world_mut()
        .remove_resource::<Assets<StandardMaterial>>()
        .unwrap();
    {
        let world = app.world_mut();
        let mut commands = world.commands();
        model3d::sync_models(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut models,
            &mut focus,
            &resources,
            &scene,
        );
    }
    app.world_mut().flush();
    app.world_mut().insert_resource(models);
    app.world_mut().insert_resource(focus);
    app.world_mut().insert_resource(meshes);
    app.world_mut().insert_resource(materials);
}

/// 单张卡片实际写进模型 mesh 实体的渲染层。
fn model_mesh_layers(app: &mut App) -> Vec<Vec<usize>> {
    let world = app.world_mut();
    let mut query = world.query_filtered::<Option<&RenderLayers>, With<Mesh3d>>();
    query
        .iter(world)
        .map(|layers| {
            layers
                .map(|layers| layers.iter().collect())
                .unwrap_or_default()
        })
        .collect()
}

#[test]
fn preview_covers_physical_pixels_at_high_dpi_and_zoom() {
    for (zoom, dpr) in [(1.0, 1.0), (1.0, 2.0), (2.0, 1.0), (2.0, 3.0)] {
        let size = preview_target_size(240.0, 180.0, zoom, dpr);
        assert!(size.x as f32 >= 240.0 * zoom * dpr);
        assert!(size.y as f32 >= 180.0 * zoom * dpr);
    }
}

/// 卡片相机是透视投影：与聚焦观察镜头同一姿态/距离/FOV，中心平面可见高度为
/// `2·d·tan(fov/2)`（与旧的正交固定视口高度等价），因此进出聚焦尺寸连续。
#[test]
fn card_camera_is_perspective_matching_focus_lens() {
    let mut app = model_card_app();
    app.update();
    let camera = app.world().resource::<Previews>().cards["m"].camera;
    let projection = app.world().get::<Projection>(camera).unwrap();
    let Projection::Perspective(perspective) = projection else {
        panic!("卡片相机必须是透视投影，实际 {projection:?}");
    };
    assert_eq!(perspective.fov, crate::orbit_camera::ORBIT_DEFAULT_FOV);
    assert_eq!(perspective.near, crate::model3d::focus::FOCUS_NEAR);
    assert_eq!(perspective.far, crate::orbit_camera::ORBIT_DEFAULT_FAR);
    // 焦点平面高度与旧正交换算一致（用卡片相机的实际距离核对）。
    let pose = *app.world().get::<Transform>(camera).unwrap();
    let pivot = app.world().resource::<Previews>().pivot("m").unwrap();
    let distance = (pivot - pose.translation).length();
    let expected =
        crate::orbit_camera::orthographic_viewport_height(distance, perspective.fov);
    assert!(expected.is_finite() && expected > 0.0);
}

#[test]
fn preview_shrinks_to_displayed_physical_pixels_when_zoomed_out() {
    assert_eq!(preview_target_size(240.0, 180.0, 0.25, 2.0), UVec2::new(128, 96));
}

#[test]
fn nearby_zoom_values_reuse_texture_size() {
    assert_eq!(
        preview_target_size(240.0, 180.0, 1.01, 2.0),
        preview_target_size(240.0, 180.0, 1.02, 2.0),
    );
    assert_ne!(
        preview_target_size(240.0, 180.0, 1.0, 2.0),
        preview_target_size(240.0, 180.0, 2.0, 2.0),
    );
}

#[test]
fn texture_limit_preserves_wide_and_tall_card_aspect() {
    assert_eq!(
        preview_target_size(800.0, 400.0, 8.0, 3.0),
        UVec2::new(2048, 1024)
    );
    assert_eq!(
        preview_target_size(400.0, 800.0, 8.0, 3.0),
        UVec2::new(1024, 2048)
    );
}

#[test]
fn invalid_metrics_produce_a_valid_bounded_texture() {
    for value in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        let size = preview_target_size(value, value, value, value);
        assert!(size.x > 0 && size.x <= 2048);
        assert!(size.y > 0 && size.y <= 2048);
    }
}

#[test]
fn translation_reuses_cached_preview_and_zoom_refreshes_without_changing_framing() {
    let nodes = serde_json::from_str(
        r#"[{ "id": "m", "type": "model", "x": 0, "y": 0,
            "width": 272, "height": 248,
            "model": { "resourceKey": "model", "signature": "s" },
            "modelPreview": { "azimuth": 0.5, "elevation": 0.4, "distanceScale": 1 }
        }]"#,
    )
    .unwrap();
    let scene = crate::protocol::Scene { nodes, ..default() };
    let snapshot: crate::protocol::ModelSnapshot = serde_json::from_str(
        r##"{
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "s", "extent": 1,
        "ops": [{ "t": "sphere", "id": "body", "radius": 1,
            "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1], "color": "#ffffff" }]
    }"##,
    )
    .unwrap();
    let mut app = App::new();
    app.init_resource::<Previews>()
        .init_resource::<crate::app::PreviewLayerPool>()
        .init_resource::<Time>()
        .init_resource::<crate::app::FocusRig>()
        .init_resource::<Ready>()
        .init_resource::<render_work::RenderWork>()
        .init_resource::<Assets<Image>>()
        .init_resource::<model3d::ModelVisuals>()
        .init_resource::<crate::theme::ThemeResource>()
        .insert_resource(CurrentScene(scene))
        .insert_resource(SurfaceState::with_size(Vec2::new(1200.0, 800.0)))
        .insert_resource(crate::app::FrameFlags {
            changed: true,
            ..default()
        })
        .insert_resource(ModelAssetTable(HashMap::from([(
            "model".into(),
            Arc::new(snapshot),
        )])))
        .add_systems(Update, sync);
    app.update();
    let card = &app.world().resource::<Previews>().cards["m"];
    let (camera, sprite, image, size, generation) = (
        card.camera,
        card.sprite,
        card.image.clone(),
        card.size,
        card.generation,
    );
    let projection = format!("{:?}", app.world().get::<Projection>(camera).unwrap());
    assert_eq!(*app.world().get::<Msaa>(camera).unwrap(), Msaa::Sample4);
    app.world()
        .resource::<Ready>()
        .0
        .lock()
        .unwrap()
        .insert(camera, generation);
    app.world_mut()
        .resource_mut::<crate::app::FrameFlags>()
        .changed = false;
    app.update();
    assert!(!app.world().get::<Camera>(camera).unwrap().is_active);

    let old_pose = *app.world().get::<Transform>(camera).unwrap();
    {
        let mut scene = app.world_mut().resource_mut::<CurrentScene>();
        scene.0.nodes[0].x = 41.125;
        scene.0.nodes[0].y = 23.75;
    }
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    let card = &app.world().resource::<Previews>().cards["m"];
    assert_eq!(card.generation, generation);
    assert_eq!(card.image, image);
    assert_eq!(app.world().resource::<Assets<Image>>().len(), 1);
    assert!(!app.world().get::<Camera>(camera).unwrap().is_active);
    let moved_pose = *app.world().get::<Transform>(camera).unwrap();
    assert_ne!(moved_pose.translation, old_pose.translation);
    assert_eq!(moved_pose.rotation, old_pose.rotation);
    assert_eq!(format!("{:?}", app.world().get::<Projection>(camera).unwrap()), projection);
    // Reactivated live rendering follows the moved subject without a texture generation.
    app.world_mut().resource_mut::<CurrentScene>().0.hover = Some(
        serde_json::from_value(serde_json::json!({"nodeId":"m"})).unwrap());
    app.update();
    assert!(app.world().get::<Camera>(camera).unwrap().is_active);
    assert_eq!(app.world().resource::<Previews>().cards["m"].generation, generation);
    app.world_mut().resource_mut::<CurrentScene>().0.hover = None;

    app.world_mut()
        .resource_mut::<CurrentScene>()
        .0
        .viewport
        .zoom = 2.0;
    app.world_mut()
        .resource_mut::<crate::app::FrameFlags>()
        .changed = true;
    app.update();
    let card = &app.world().resource::<Previews>().cards["m"];
    assert_eq!(card.camera, camera);
    assert_eq!(card.sprite, sprite);
    assert_ne!(card.image, image);
    assert_eq!(card.displayed, image);
    assert!(card.size.x > size.x && card.size.y > size.y);
    assert!(card.generation > generation);
    assert!(app.world().get::<Camera>(camera).unwrap().is_active);
    assert_eq!(
        format!("{:?}", app.world().get::<Projection>(camera).unwrap()),
        projection
    );
    assert_eq!(app.world().resource::<Assets<Image>>().len(), 2);

    // Cancel an unfinished replacement by leaving the viewport. The displayed
    // and pending images survive the short grace, then both are reclaimed on
    // an idle frame; returning creates only the latest generation.
    app.world_mut().resource_mut::<CurrentScene>().0.viewport.x = -10_000.;
    app.update();
    assert!(!app.world().get::<Camera>(camera).unwrap().is_active);
    assert_eq!(app.world().resource::<Assets<Image>>().len(), 2);
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.world_mut().resource_mut::<Time>().advance_by(std::time::Duration::from_secs(2));
    app.update();
    assert!(app.world().resource::<Previews>().cards.is_empty());
    assert_eq!(app.world().resource::<Assets<Image>>().len(), 0);
    assert!(app.world().get_entity(camera).is_err());
    assert!(app.world().get_entity(sprite).is_err());
    assert!(app.world().resource::<Ready>().0.lock().unwrap().is_empty());
    app.world().resource::<Ready>().0.lock().unwrap().insert(camera, generation);
    app.update();
    assert!(app.world().resource::<Ready>().0.lock().unwrap().is_empty(), "late GPU readiness must not retain deleted cameras");
    app.world_mut().resource_mut::<CurrentScene>().0.viewport.x = 0.;
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    let card = &app.world().resource::<Previews>().cards["m"];
    assert_ne!(card.camera, camera);
    assert_eq!(app.world().resource::<Assets<Image>>().len(), 1);
    assert!(app.world().get::<Camera>(card.camera).unwrap().is_active);
}

/// 模型根晚于卡片出现（需求驱动 spawn 在另一系统）时，卡片必须重新武装：
/// 表示身份 `absent` → 具体质量/代数、代数递增、层重新写入。
///
/// 回归：`quality_identity` 曾把「根缺失」与「根刚创建（generation 0）」都表示为
/// `"High:0"`，卡片签名与 `quality_changed` 都不变，于是既不重渲染也不重写渲染层，
/// 卡片一直停在灰底，直到 hover 等交互强制推动。
#[test]
fn late_model_root_rearms_card_generation_and_layers() {
    let mut app = model_card_app();
    app.update();
    let card = &app.world().resource::<Previews>().cards["m"];
    let (camera, generation) = (card.camera, card.generation);
    assert!(generation > 0, "卡片视图先建立");
    assert_eq!(
        app.world().resource::<model3d::ModelVisuals>().quality_identity("m"),
        "absent",
        "根尚未 spawn"
    );
    assert!(
        app.world().get::<bevy::render::view::NoIndirectDrawing>(camera).is_some(),
        "参与就绪门禁的卡片相机必须直接绘制"
    );

    // 模型根就位后的下一帧：身份变化必须被签名与质量门禁感知。
    spawn_model_roots(&mut app);
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.update();

    let identity = app
        .world()
        .resource::<model3d::ModelVisuals>()
        .quality_identity("m");
    assert_ne!(identity, "absent");
    let (card_generation, card_layer, card_visible) = {
        let card = &app.world().resource::<Previews>().cards["m"];
        (card.generation, card.layer, card.visible)
    };
    assert!(card_generation > generation, "根出现后必须重渲染");
    assert!(card_visible, "卡片仍在视口内");
    let layers = model_mesh_layers(&mut app);
    assert!(!layers.is_empty(), "模型根实体已建立");
    for entity_layers in &layers {
        assert!(
            entity_layers.contains(&card_layer),
            "根实体必须带上卡片层 {layers:?}"
        );
    }
}

/// 根缺失时不得保留层去重记录，否则重新 spawn 的根永远拿不到卡片层。
///
/// 只靠表示身份还不够：根被回收后重建仍停在 `generation 0`，身份可能与回收前完全相同，
/// 层去重就会把新实体当作「已写入」而跳过，卡片画面从此缺模型。
#[test]
fn missing_root_drops_layer_dedup_so_respawned_root_is_rewritten() {
    let mut app = model_card_app();
    // 先让根存在并写入层，建立去重记录。
    spawn_model_roots(&mut app);
    app.update();
    let layer = app.world().resource::<Previews>().cards["m"].layer;
    assert!(app
        .world()
        .resource::<Previews>()
        .applied_layers
        .contains_key("m"));

    // 需求收缩：根被回收，但卡片（场景节点）仍在。
    let scene = app.world().resource::<CurrentScene>().0.clone();
    app.world_mut().resource_mut::<CurrentScene>().0 = Default::default();
    spawn_model_roots(&mut app);
    app.world_mut().insert_resource(CurrentScene(scene.clone()));
    assert_eq!(
        app.world()
            .resource::<model3d::ModelVisuals>()
            .quality_identity("m"),
        "absent",
        "根已回收"
    );
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.update();
    assert!(
        app.world()
            .resource::<Previews>()
            .applied_layers
            .get("m")
            .is_none(),
        "根缺失时不得保留已下发的层记录"
    );

    // 需求恢复：根以同一内容重建（generation 仍为 0），层必须重新写入。
    app.world_mut().insert_resource(CurrentScene(scene));
    spawn_model_roots(&mut app);
    assert_ne!(
        app.world()
            .resource::<model3d::ModelVisuals>()
            .quality_identity("m"),
        "absent",
        "根已重建"
    );
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.update();
    let applied = app
        .world()
        .resource::<Previews>()
        .applied_layers
        .get("m")
        .map(|(_, layers)| layers.clone());
    assert_eq!(applied, Some(RenderLayers::layer(layer)));
    let layers = model_mesh_layers(&mut app);
    assert!(!layers.is_empty(), "重建的根实体已建立");
    for entity_layers in layers {
        assert!(entity_layers.contains(&layer), "重建的根必须补写卡片层");
    }
}

/// 聚焦中的卡片不得被离屏回收：退出聚焦要靠它的相机把整屏相机对齐回卡片像素。
///
/// 回归：聚焦期间 `visible` 恒为 false，卡片 1 秒后被当作离屏回收；退出时
/// `overview_camera` 找不到卡片相机，只能退回等距画布 home，模型沿画布锚点下移
/// （表现为「后退时模型固定往下走」）。
#[test]
fn focused_card_survives_offscreen_expiry() {
    let mut app = model_card_app();
    app.update();
    let camera = app.world().resource::<Previews>().cards["m"].camera;
    app.world_mut().resource_mut::<crate::app::FocusRig>().focus_node = Some("m".into());
    app.world_mut()
        .resource_mut::<crate::app::FrameFlags>()
        .changed = false;
    // 第一帧：进入「聚焦中」状态，卡片开始记录离屏起点（此时尚未到期）。
    app.update();
    assert!(
        app.world().resource::<Previews>().cards["m"]
            .offscreen_since
            .is_some(),
        "聚焦期间卡片确实不可见"
    );
    // 推进超过离屏回收窗口（1 秒）：卡片仍必须存在且相机实体未被删除。
    app.world_mut()
        .resource_mut::<Time>()
        .advance_by(std::time::Duration::from_secs(3));
    app.update();
    {
        let state = app.world().resource::<Previews>();
        let card = state.cards.get("m").expect("聚焦中的卡片不得被离屏回收");
        assert_eq!(
            state.pivot("m"),
            Some(card.pivot),
            "退出聚焦需要卡片注视点"
        );
    }
    assert!(
        app.world().get_entity(camera).is_ok(),
        "卡片相机必须保留给退出过渡使用"
    );

    // 退出聚焦后（不再 occupied）才允许按离屏规则回收：旧相机被删除，卡片按需重建。
    app.world_mut().resource_mut::<crate::app::FocusRig>().focus_node = None;
    app.world_mut()
        .resource_mut::<Time>()
        .advance_by(std::time::Duration::from_secs(3));
    app.update();
    assert!(
        app.world().get_entity(camera).is_err(),
        "离开聚焦后旧卡片相机按既有离屏规则回收"
    );
}

/// 没有模型根的卡片不得长期占住调度槽：有界等待后让位，其它卡片才能推进。
#[test]
fn card_without_root_releases_its_scheduling_slot_after_a_bounded_wait() {
    let mut app = model_card_app();
    app.update();
    let camera = app.world().resource::<Previews>().cards["m"].camera;
    assert!(app.world().get::<Camera>(camera).unwrap().is_active, "无根期间保持活跃等待");
    assert!(app
        .world()
        .resource::<Previews>()
        .cards["m"]
        .awaiting_root_since
        .is_some());

    // 推进超过等待窗口：卡片让出槽位，相机停用（不再反复重画空画面）。
    let waited = super::policy::AWAITING_ROOT_FRAMES + 1;
    for _ in 0..waited {
        app.update();
    }
    assert!(
        !app.world().get::<Camera>(camera).unwrap().is_active,
        "超过有界等待后必须让出调度槽"
    );
}

/// 重复同步时未变化的 sprite / pose 不再重复下发命令
/// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D7）。
#[test]
fn repeated_sync_skips_unchanged_preview_sprite_and_pose_commands() {
    let nodes = serde_json::from_str(
        r#"[{ "id": "m", "type": "model", "x": 0, "y": 0,
            "width": 272, "height": 248,
            "model": { "resourceKey": "model", "signature": "s" },
            "modelPreview": { "azimuth": 0.5, "elevation": 0.4, "distanceScale": 1 }
        }]"#,
    )
    .unwrap();
    let scene = crate::protocol::Scene { nodes, ..default() };
    let snapshot: crate::protocol::ModelSnapshot = serde_json::from_str(
        r##"{
        "sceneVersion": "woohaa-model-scene-ir-v2", "signature": "s", "extent": 1,
        "ops": [{ "t": "sphere", "id": "body", "radius": 1,
            "position": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1], "color": "#ffffff" }]
    }"##,
    )
    .unwrap();
    let mut app = App::new();
    app.init_resource::<Previews>()
        .init_resource::<crate::app::PreviewLayerPool>()
        .init_resource::<Time>()
        .init_resource::<crate::app::FocusRig>()
        .init_resource::<Ready>()
        .init_resource::<render_work::RenderWork>()
        .init_resource::<Assets<Image>>()
        .init_resource::<model3d::ModelVisuals>()
        .init_resource::<crate::theme::ThemeResource>()
        .insert_resource(CurrentScene(scene))
        .insert_resource(SurfaceState::with_size(Vec2::new(1200.0, 800.0)))
        .insert_resource(crate::app::FrameFlags {
            changed: true,
            ..default()
        })
        .insert_resource(ModelAssetTable(HashMap::from([(
            "model".into(),
            Arc::new(snapshot),
        )])))
        .add_systems(Update, sync);

    app.update();
    let (sprites, poses) = {
        let models = app.world().resource::<model3d::ModelVisuals>();
        (
            models.hot_path.preview_sprite_inserts,
            models.hot_path.preview_pose_inserts,
        )
    };
    assert!(sprites > 0, "首帧必须写入 sprite");

    app.update();
    app.update();
    let models = app.world().resource::<model3d::ModelVisuals>();
    assert_eq!(
        models.hot_path.preview_sprite_inserts, sprites,
        "sprite 状态未变不应重复插入"
    );
    assert_eq!(
        models.hot_path.preview_pose_inserts, poses,
        "pose 未变不应重复写入"
    );
    assert!(models.hot_path.preview_sprite_skips >= 1);
    assert!(models.hot_path.preview_pose_skips >= 1);
}

/// 运行中（`busy`）时卡片画面必须让位给进度环
/// （change: show-agent-turn-running-state-on-node）。
///
/// 3D 卡片的实时预览 sprite 与图片纹理同层次；若运行中仍可见，会盖住
/// `canvas2d::sync_generation` 画在内容面上的进度环与百分比，节点看起来毫无反应。
#[test]
fn busy_card_sprite_yields_to_generation_ring() {
    let mut app = model_card_app();
    app.update();
    spawn_model_roots(&mut app);
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.update();
    assert!(
        app.world()
            .get::<Visibility>(app.world().resource::<Previews>().cards["m"].sprite)
            .is_none_or(|visibility| *visibility == Visibility::Inherited),
        "空闲卡片画面可见"
    );

    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].busy = true;
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    let visibility = *app
        .world()
        .get::<Visibility>(app.world().resource::<Previews>().cards["m"].sprite)
        .expect("busy 时也要显式写可见性");
    assert_eq!(visibility, Visibility::Hidden, "运行中卡片画面必须隐藏");

    // 回合结束后恢复可见，不需要重建卡片。
    let sprite = app.world().resource::<Previews>().cards["m"].sprite;
    app.world_mut().resource_mut::<CurrentScene>().0.nodes[0].busy = false;
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    assert_eq!(app.world().resource::<Previews>().cards["m"].sprite, sprite);
    assert_eq!(
        *app.world().get::<Visibility>(sprite).expect("恢复时写可见性"),
        Visibility::Inherited
    );
}

/// 卡片层只从共享层池租出，且租约在移除后归还
/// （change: 2026-10-23-scale-canvas-media-residency，design D6 / 任务 6.3）。
#[test]
fn card_layers_come_from_shared_pool_and_return_on_removal() {
    let mut app = model_card_app();
    app.update();
    let layer = app.world().resource::<Previews>().cards["m"].layer;
    assert!(
        !crate::preview_layers::PreviewLayers::is_reserved(layer),
        "卡片层不得落在保留层"
    );
    assert_eq!(
        app.world().resource::<crate::app::PreviewLayerPool>().0.slot_of("m").map(|slot| slot.layer),
        Some(layer),
        "层池必须记录该卡片租约"
    );

    // 离屏超过宽限后卡片被回收，层归还（供下一张卡片复用）。
    app.world_mut().resource_mut::<CurrentScene>().0.viewport.x = -10_000.;
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = false;
    app.world_mut().resource_mut::<Time>().advance_by(std::time::Duration::from_secs(2));
    app.update();
    assert!(app.world().resource::<Previews>().cards.is_empty());
    assert_eq!(
        app.world().resource::<crate::app::PreviewLayerPool>().0.active(),
        0,
        "移除卡片必须归还层"
    );
}

/// 固定可见需求时，文档新增大量离屏模型不得降低当前预览分辨率
/// （change: 2026-10-23-scale-canvas-media-residency，design D6 / 任务 6.6）。
#[test]
fn offscreen_model_count_does_not_shrink_visible_preview() {
    let mut app = model_card_app();
    app.update();
    let before = app.world().resource::<Previews>().cards["m"].size;

    // 再插入 999 个完全离屏的模型节点（同一资源）。
    {
        let mut scene = app.world_mut().resource_mut::<CurrentScene>();
        for index in 0..999 {
            let mut node = scene.0.nodes[0].clone();
            node.id = format!("off-{index}");
            node.x = 100_000.0 + index as f32 * 400.0;
            scene.0.nodes.push(node);
        }
    }
    app.world_mut().resource_mut::<crate::app::FrameFlags>().changed = true;
    app.update();
    let after = app.world().resource::<Previews>().cards["m"].size;
    assert_eq!(after, before, "离屏模型不参与预览像素预算分摊");
    assert_eq!(app.world().resource::<Previews>().cards.len(), 1, "只驻留可见卡片");
}
