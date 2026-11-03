use bevy::prelude::*;

use crate::{isometric_grid, model3d, theme::ThemeResource};

use super::{
    AnimationCameraState, CurrentScene, FocusRig, FrameFlags, ModelAssetTable, SurfaceState,
};

#[derive(Component)]
pub(super) struct SceneAreaLine;

pub(super) fn sync_scene_areas(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene: Res<CurrentScene>,
    flags: Res<FrameFlags>,
    lines: Query<Entity, With<SceneAreaLine>>,
    mut assets: Local<Option<(Handle<Mesh>, Handle<StandardMaterial>, Handle<StandardMaterial>)>>,
) {
    if !flags.scene_received { return; }
    for entity in &lines { commands.entity(entity).despawn(); }
    if scene.0.model_focus.is_some() || scene.0.image_focus.is_some() || scene.0.video_focus.is_some() { return; }
    let (mesh, normal, selected) = assets.get_or_insert_with(|| (
        meshes.add(Cuboid::new(1.0, 1.0, 1.0)),
        materials.add(StandardMaterial { base_color: Color::srgb(0.12, 0.65, 0.58), unlit: true, ..default() }),
        materials.add(StandardMaterial { base_color: Color::srgb(1.0, 0.62, 0.16), unlit: true, ..default() }),
    ));
    for area in &scene.0.scene_areas {
        let b = &area.bounds;
        if ![b.min.u, b.min.v, b.max.u, b.max.v].iter().all(|v| v.is_finite()) || b.min.u > b.max.u || b.min.v > b.max.v { continue; }
        let [x0, _, z0] = crate::protocol::world_to_renderer([b.min.u, b.min.v, 0.0]);
        let [x1, _, z1] = crate::protocol::world_to_renderer([b.max.u, b.max.v, 0.0]);
        let material = if scene.0.selection.nodes.contains(&area.node_id) { selected.clone() } else { normal.clone() };
        for (x, z, sx, sz) in [
            ((x0+x1)/2.0, z0, x1-x0, 1.0), ((x0+x1)/2.0, z1, x1-x0, 1.0),
            (x0, (z0+z1)/2.0, 1.0, (z1-z0).abs()), (x1, (z0+z1)/2.0, 1.0, (z1-z0).abs()),
        ] {
            commands.spawn((SceneAreaLine, Mesh3d(mesh.clone()), MeshMaterial3d(material.clone()),
                Transform::from_xyz(x as f32, 0.0, z as f32).with_scale(Vec3::new(sx.max(1.0) as f32, 1.0, sz.max(1.0) as f32))));
        }
    }
}

/// 共享世界对象的轻量呈现：空模型锚点、世界模型选择框与聚焦可见性。
///
/// 与模型根同步分开：即使没有可见模型（空模型只有世界实例身份），也必须在真实
/// world pose 处留下可辨认、可选择的指示，不能退回内容卡片。
pub(super) fn sync_world_presence(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    resources: Res<ModelAssetTable>,
    mut presence: ResMut<model3d::world_presence::WorldPresence>,
) {
    model3d::world_presence::sync(
        &mut commands,
        &mut meshes,
        &mut materials,
        &scene.0,
        &theme,
        &resources.0,
        &mut presence,
    );
}

pub(super) fn publish_model_poses(
    models: Res<model3d::ModelVisuals>,
    transforms: Query<(&Transform, &GlobalTransform)>,
    rig: Res<FocusRig>,
    _main_thread: bevy::ecs::system::NonSendMarker,
) {
    if crate::bridge::take_model_pose_request() {
        crate::bridge::set_model_poses(models.pose_snapshot(&transforms), rig.focus_node.as_deref());
    }
}

/// 网格 adapter：把 scene viewport/surface/theme 投影为通用网格插件的 config/target/style。
///
/// 网格 mesh/material 本身由 `IsometricGridPlugin` 拥有与回收；本系统只做领域适配与相机复位。
pub(super) fn sync_grid(
    mut style: ResMut<isometric_grid::IsometricGridStyle>,
    mut targets: Query<&mut isometric_grid::IsometricGridTarget>,
    theme: Res<ThemeResource>,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    flags: Res<FrameFlags>,
    rig: Res<FocusRig>,
    mut camera: Query<(&mut Transform, &mut Projection), With<model3d::grid::ModelCanvasCamera>>,
    mut grids: Query<&mut Visibility, With<isometric_grid::IsometricGrid>>,
) {
    // 二维媒体仍是画布正交取景，网格持续显示并与媒体共用 pan/zoom。
    let show_grid = scene.0.model_focus.is_none() && !rig.animating();
    let grid_visibility = if show_grid {
        Visibility::Inherited
    } else {
        Visibility::Hidden
    };
    for mut visibility in &mut grids {
        *visibility = grid_visibility;
    }
    if !flags.camera_changed {
        return;
    }
    model3d::grid::sync_theme(&theme, &mut style);
    if show_grid {
        let view = model3d::grid::scene_view(&scene.0);
        model3d::grid::sync_camera(surface.size, &view, &mut camera);
    }
    // 网格覆盖范围也要跟随纯视口增量，不能等完整场景提交后再补齐露出的区域。
    let Ok(mut target) = targets.single_mut() else {
        return;
    };
    model3d::grid::sync_target(&scene.0, surface.size, &mut target);
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync_models(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut visuals: ResMut<model3d::ModelVisuals>,
    mut focus: ResMut<model3d::FocusVisuals>,
    mut resources: ResMut<ModelAssetTable>,
    mut previous_assets: Local<std::collections::HashMap<String, std::sync::Weak<crate::protocol::ModelSnapshot>>>,
    scene: Res<CurrentScene>,
    flags: Res<FrameFlags>,
    rig: Res<FocusRig>,
    mut visible_focus: Local<Option<String>>,
    mut animation_camera: ResMut<AnimationCameraState>,
    time: Res<Time>,
    capture: Res<model3d::capture::ShotCaptureRouting>,
    (_main_thread, render_work): (bevy::ecs::system::NonSendMarker, Res<crate::model_preview::render_work::RenderWork>),
    opacity: Query<(
        Entity,
        &crate::canvas_ecs::components::OpacityMaterialInstance,
    )>,
) {
    // 门禁结算必须每帧运行：hover 可能未改变 `Scene` 指纹（如 pointer 位移落在同一节点），
    // 但重建/生命周期仍需要按最新 hover 初始化 playback（change: play-model-animations-on-hover，
    // design D3/D4）。
    let started = bevy::platform::time::Instant::now();
    let models = &mut *visuals;
    // 按需 spawn 集合（C2.1–C2.3）：descriptor 注册独立于 ECS/GPU 需求。
    // 截图（含等待 GPU ready/readback 期间）作为强制高质量消费者 pin 其节点（B1.6）。
    // 截图请求 pin 住的根需要 High；可见镜头卡片只让源片场保持驻留（不被回收），
    // 不构成高优先消费者——卡片内容已固化时没必要把整场按 High 加载
    // （2026-10-28 总览缩放时可见卡片把片场按在 High 的修复）。
    let capture_pins = capture.pins(&scene.0);
    let pins = capture_pins.clone();
    let now = time.elapsed_secs_f64();
    let demand_changed = model3d::demand::update(
        models,
        &scene.0,
        rig.focus_node.as_deref(),
        &pins,
        &capture_pins,
        now,
    );
    // 模型 payload lease：只有当前需求引用重型 IR（design D5）。先按最新需求收敛预算，
    // 再同步根：本次淘汰掉的 cold payload 会在同步里以缺资源跳过，等待重新取得需求。
    let leases = model3d::demand::payload_lease_keys(&scene.0, models);
    let (_retained, evicted) = crate::bridge::set_model_payload_leases(leases);
    if !evicted.is_empty() {
        // 淘汰后刷新只读快照资源，使本帧所有消费者看到同一份 payload 表。
        resources.0 = crate::bridge::model_assets_snapshot();
    }
    let assets_changed = previous_assets.len() != resources.0.len()
        || resources.0.iter().any(|(key, value)| {
            previous_assets.get(key).is_none_or(|old| !std::sync::Weak::ptr_eq(old, &std::sync::Arc::downgrade(value)))
        });
    if flags.changed || demand_changed || assets_changed {
        model3d::sync_models(
            &mut commands,
            &mut meshes,
            &mut materials,
            models,
            &mut focus,
            &resources.0,
            &scene.0,
        );
        *previous_assets = resources.0.iter().map(|(key, value)| (key.clone(), std::sync::Arc::downgrade(value))).collect();
    }
    model3d::apply_animation_playback(&mut commands, models, &scene.0);
    // 活动动画节点的运动求值（change: 2026-10-05-bind-model-animation-to-shots）：独立模型
    // 姿态与唯一时钟；相机姿态写入共享资源供 shot adapter / 聚焦相机复用。
    // 透明度实例状态从实体组件派生（Resource 只保留回收策略）。
    let opacity: std::collections::HashMap<
        Entity,
        crate::canvas_ecs::components::OpacityMaterialInstance,
    > = opacity
        .iter()
        .map(|(entity, instance)| (entity, instance.clone()))
        .collect();
    animation_camera.0 =
        model3d::apply_motion_playback(&mut commands, models, &mut materials, &opacity, &scene.0);
    // 质量档位只替换共享 handle，不重建 hierarchy、不执行脚本、不改 canonical AABB。
    let quality_changed = model3d::sync_quality_with_demand(
        &mut commands,
        &mut meshes,
        models,
        &scene.0,
        rig.focus_node.as_deref(),
        now,
        &pins,
        &capture_pins,
    );
    if quality_changed {
        models.trim_resources(&mut meshes, &mut materials);
    }
    // 准备管线的发布/取消/退役同样推进诊断快照；只在有变更时发布一次，不逐帧输出。
    let preparation_changed = false;
    if flags.changed || demand_changed || assets_changed || quality_changed || preparation_changed {
        // 诊断里把两种 pin 分开：真实截图请求带来源标签，可见卡片标 visible-card。
        let mut capture_requests = capture.requests();
        for node in &pins {
            if capture_requests.iter().any(|(pinned, _)| pinned == node) {
                continue;
            }
            let source = if capture_pins.contains(node) {
                "capture"
            } else {
                "visible-card"
            };
            capture_requests.push((node.clone(), source.to_owned()));
        }
        crate::bridge::set_model_render_diagnostics(models.budget_json_with_requests(
            &meshes,
            &materials,
            &capture_requests,
        ));
    }
    // 相机每帧推进过渡；即使没有新 scene，也要在结束帧恢复所有模型。
    if flags.changed || *visible_focus != rig.focus_node {
        visuals.set_visible_focus(&mut commands, rig.focus_node.as_deref(), &scene.0);
        *visible_focus = rig.focus_node.clone();
    }
    render_work.startup_models(
        scene.0.animation_playback.as_ref(),
        started.elapsed().as_secs_f64() * 1000.0,
    );
}

pub(super) fn sync_editor_gizmo(
    mut selection: ResMut<crate::transform_gizmo::TransformGizmoSelection>,
    mut style: ResMut<crate::transform_gizmo::TransformGizmoStyle>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
) {
    selection.view = crate::canvas_query::gizmo::gizmo_view(&scene.0);
    if !flags.changed {
        return;
    }
    model3d::editor::sync_editor_gizmo(
        &mut selection,
        &mut style,
        scene.0.model_editor.as_ref(),
        &theme,
    );
}

pub(super) fn sync_shot_adapter(
    mut commands: Commands,
    mut adapter: ResMut<model3d::shot_adapter::ShotAdapterState>,
    mut selection: ResMut<crate::shot_camera::ShotGizmoSelection>,
    mut viewport: ResMut<crate::shot_camera::ShotPreviewViewport>,
    mut clear: ResMut<crate::shot_camera::ShotPreviewClearColor>,
    models: Res<model3d::ModelVisuals>,
    resources: Res<ModelAssetTable>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
) {
    selection.view = crate::canvas_query::gizmo::gizmo_view(&scene.0);
    if !flags.changed {
        return;
    }
    selection.palette = model3d::editor::gizmo_palette(&theme);
    let editor = scene.0.model_editor.as_ref();
    selection.tool = editor
        .and_then(|e| e.camera_tool.clone())
        .unwrap_or_else(|| "orbit".into());
    selection.hover = editor
        .and_then(|e| e.feedback.as_ref())
        .and_then(|f| f.hover.clone());
    selection.active = editor
        .and_then(|e| e.feedback.as_ref())
        .and_then(|f| f.active.clone());
    model3d::shot_adapter::sync_shot_adapter(
        &mut commands,
        &mut adapter,
        &mut selection,
        &mut viewport,
        &mut clear,
        &scene.0,
        &models,
        &resources.0,
        theme.token_color("webSubtle"),
    );
}

/// 只保留 adapter 当前记录的那一台 rig。丢失跟踪的旧 rig 会继续占着窗口相机。
pub(super) fn reclaim_extra_shot_rigs(
    mut commands: Commands,
    adapter: Res<model3d::shot_adapter::ShotAdapterState>,
    rigs: Query<Entity, With<crate::shot_camera::ShotCameraPose>>,
) {
    for entity in &rigs {
        if adapter.rig != Some(entity) {
            commands.entity(entity).try_despawn();
        }
    }
}

/// 选中镜头时，rig 窗口相机缩到左下角，渲染它自己的视角；进入/退出过渡结束前保持禁用。
///
/// 主画面始终是观察相机。每帧写入。adapter 只在 scene 变化时创建 rig。
pub(super) fn sync_shot_main_view(
    scene: Res<CurrentScene>,
    rig: Res<super::FocusRig>,
    mut viewport: ResMut<crate::shot_camera::ShotPreviewViewport>,
) {
    let surface = scene.0.surface.as_ref();
    let width = surface.map(|size| size.width).unwrap_or(0.0);
    let height = surface.map(|size| size.height).unwrap_or(0.0);
    let right = surface.map(|size| size.content_right).unwrap_or(0.0);
    let right = if right.is_finite() && right > 0.0 {
        right
    } else {
        0.0
    };
    let aspect = scene
        .0
        .model_editor
        .as_ref()
        .and_then(|editor| editor.shot.as_ref())
        .map(|shot| shot_aspect_ratio(&shot.aspect))
        .unwrap_or(16.0 / 9.0);
    let animation_preview = scene
        .0
        .animation_playback
        .as_ref()
        .filter(|p| p.view_mode == "focus-preview");
    let aspect = animation_preview
        .map(|p| shot_aspect_ratio(&p.initial_camera.aspect))
        .unwrap_or(aspect);
    let has_shot = animation_preview.is_some()
        || scene
            .0
            .model_editor
            .as_ref()
            .is_some_and(|editor| editor.tool_mode == "camera" && editor.shot.is_some());
    viewport.hold = rig.animating();
    viewport.rect = if has_shot && width > 0.0 && height > 0.0 {
        Some(if animation_preview.is_some() {
            let rect = surface.and_then(|s| s.content_rect.as_ref());
            let x = rect.map(|r| r.x).unwrap_or(0.0);
            let y = rect.map(|r| r.y).unwrap_or(0.0);
            let w = rect.map(|r| r.width).unwrap_or((width - right).max(1.0));
            let h = rect.map(|r| r.height).unwrap_or(height);
            let frame_h = h.min(w / aspect);
            Vec4::new(
                x + (w - frame_h * aspect) / 2.0,
                y + (h - frame_h) / 2.0,
                frame_h * aspect,
                frame_h,
            )
        } else if let Some(rect) = surface.and_then(|surface| surface.content_rect.as_ref()) {
            let max_w = ((rect.width - 32.0) * 0.32).clamp(1.0, 340.0);
            let max_h = ((rect.height - 56.0) * 0.30).clamp(1.0, 220.0);
            let h = (max_w / aspect).min(max_h);
            Vec4::new(
                rect.x + 16.0,
                rect.y + (rect.height - h - 64.0).max(0.0),
                h * aspect,
                h,
            )
        } else {
            rig_preview_rect((width - right).max(1.0), height, aspect)
        })
    } else {
        None
    };
}

/// 与 `model3d::shot_adapter` 同源的画幅解析：受支持 `W:H` → 数值比例，非法回退 `16:9`。
fn shot_aspect_ratio(aspect: &str) -> f32 {
    crate::protocol::parse_shot_aspect_ratio(aspect).unwrap_or(16.0 / 9.0)
}

/// 左下角 rig 预览框（CSS 像素，y 从窗口顶部往下）。
fn rig_preview_rect(content_width: f32, height: f32, aspect: f32) -> Vec4 {
    let aspect = if aspect.is_finite() && aspect > 0.0 {
        aspect
    } else {
        16.0 / 9.0
    };
    let margin = 16.0;
    let max_w = ((content_width - margin * 2.0) * 0.32).clamp(180.0, 340.0);
    let max_h = ((height - margin * 2.0) * 0.30).clamp(120.0, 220.0);
    let mut preview_width = max_w;
    let mut preview_height = preview_width / aspect;
    if preview_height > max_h {
        preview_height = max_h;
        preview_width = preview_height * aspect;
    }
    Vec4::new(
        margin,
        (height - preview_height - margin).max(0.0),
        preview_width,
        preview_height,
    )
}

/// 观察相机始终铺满主画面，用来看 rig 和模型。它没有可画的本体。
pub(super) fn drive_observer_from_shot(
    scene: Res<CurrentScene>,
    rig: Res<FocusRig>,
    mut observer: Query<
        (&mut Camera, &mut bevy::camera::visibility::RenderLayers),
        With<model3d::grid::ModelCanvasCamera>,
    >,
) {
    for (mut camera, mut layers) in &mut observer {
        camera.is_active = !scene
                .0
                .animation_playback
                .as_ref()
                .is_some_and(|p| p.view_mode == "focus-preview");
        camera.order = 0;
        camera.viewport = None;
        *layers = bevy::camera::visibility::RenderLayers::layer(0);
    }
}

/// 没有选中镜头的主视图时隐藏 shot gizmo，避免退出聚焦后环留在画布上。
pub(super) fn hide_shot_gizmos_during_transition(
    scene: Res<CurrentScene>,
    viewport: Res<crate::shot_camera::ShotPreviewViewport>,
    mut gizmos: Query<&mut Visibility, With<crate::shot_camera::ShotGizmo>>,
) {
    let hidden = scene
        .0
        .animation_playback
            .as_ref()
            .is_some_and(|p| p.view_mode == "focus-preview")
        || viewport.rect.is_none()
        || viewport.hold;
    // The layout refresh restores each part every frame. Only suppress it here:
    // restoring Inherited would also reveal dashed/near-clipped layout segments.
    if hidden {
        for mut visibility in &mut gizmos {
            *visibility = Visibility::Hidden;
        }
    }
}

#[cfg(test)]
mod grid_tests {
    use super::*;
    use bevy::mesh::VertexAttributeValues;

    #[test]
    fn scene_area_outlines_preserve_overlapping_ground_bounds() {
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<CurrentScene>()
            .insert_resource(FrameFlags { scene_received: true, ..default() })
            .add_systems(Update, sync_scene_areas);
        app.world_mut().resource_mut::<CurrentScene>().0.scene_areas = serde_json::from_value(serde_json::json!([
            {"nodeId":"a", "bounds":{"min":{"u":0,"v":0},"max":{"u":3,"v":3}}},
            {"nodeId":"b", "bounds":{"min":{"u":2,"v":2},"max":{"u":4,"v":4}}}
        ])).unwrap();
        app.update();
        let world = app.world_mut();
        let lines: Vec<_> = world.query_filtered::<&Transform, With<SceneAreaLine>>().iter(world).copied().collect();
        assert_eq!(lines.len(), 8);
        assert!(lines.iter().all(|line| line.translation.y == 0.0));
        assert!(lines.iter().any(|line| line.translation == Vec3::new(96.0, 0.0, 0.0) && line.scale.x == 192.0));
        assert!(lines.iter().any(|line| line.translation == Vec3::new(192.0, 0.0, -128.0) && line.scale.x == 128.0));
    }

    fn model_test_app() -> App {
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<model3d::ModelVisuals>()
            .init_resource::<model3d::FocusVisuals>()
            .init_resource::<ModelAssetTable>()
            .init_resource::<CurrentScene>()
            .init_resource::<FrameFlags>()
            .init_resource::<FocusRig>()
            .init_resource::<AnimationCameraState>()
            .init_resource::<Time>()
            .init_resource::<model3d::capture::ShotCaptureRouting>()
            .init_resource::<crate::model_preview::render_work::RenderWork>()
            .init_resource::<super::super::NodeIndex>()
            .init_resource::<SurfaceState>()
            .init_resource::<super::super::positions::PositionIndex>()
            .init_resource::<ThemeResource>()
            .init_resource::<super::super::TextureBatch>()
            .init_resource::<super::super::ModelTextureBatch>()
            .init_resource::<crate::canvas2d::focus_details::FocusDetailBatch>()
            .init_resource::<ClearColor>()
            .add_message::<bevy::window::WindowResized>()
            .add_systems(Update, (super::super::input::ingest_bridge, super::super::input::sync_surface, sync_models).chain());
        app.world_mut().spawn((Window::default(), bevy::window::PrimaryWindow));
        app
    }

    #[test]
    fn shared_world_bridge_payload_lifecycle_runs_through_frame_system() {
        use crate::{bridge, protocol::{ModelAssetDescriptor, ModelOp, ModelPlacement, ModelReference, NodePosition}};
        bridge::clear_model_assets();
        let mut app = model_test_app();
        let key = "world-test".to_owned();
        let descriptor = ModelAssetDescriptor {
            resource_version: crate::protocol::MODEL_ASSET_VERSION.into(), resource_key: key.clone(),
            scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.into()), signature: "world-test".into(),
            extent: 2., aabb: None, ops: vec![ModelOp::Sphere { id: "sphere".into(), parent: None,
                position: [0.; 3], rotation: [0.; 3], scale: [1.; 3], color: None, material: None, radius: 1. }],
        };
        let mut node: crate::protocol::GraphNode = serde_json::from_value(serde_json::json!({"id":"n", "type":"model", "x":9000,"y":0,"width":100,"height":50,
            "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i",
            "transform":{"version":"shared-world-v1","position":{"u":1,"v":2,"h":3},"rotation":[0,0,0,1],"scale":1}}})).unwrap();
        node.model = Some(ModelReference { resource_key: key.clone(), scene_version: descriptor.scene_version.clone(), signature: descriptor.signature.clone(), placement: ModelPlacement::default() });
        bridge::queue_scene(crate::protocol::Scene { nodes: vec![node.clone()], ..default() });
        app.update();
        assert!(app.world().resource::<model3d::ModelVisuals>().test_root("n").is_none());
        bridge::queue_model_asset(descriptor.clone());
        app.update();
        let root = |app: &App| {
            let visuals = app.world().resource::<model3d::ModelVisuals>();
            let root = visuals.test_root("n").unwrap();
            (root, *app.world().get::<Transform>(root).unwrap())
        };
        let initial = root(&app);
        assert_eq!(initial.1.translation, Vec3::new(64., 192., -128.));
        node.shared_world_instance.as_mut().unwrap().transform.position.u = 4.;
        bridge::queue_scene(crate::protocol::Scene { nodes: vec![node.clone()], ..default() });
        app.update();
        let changed = root(&app);
        assert_eq!(changed.0, initial.0);
        assert_eq!(changed.1.translation, Vec3::new(256., 192., -128.));
        bridge::queue_positions(vec![NodePosition { id: "n".into(), x: -9000., y: 3000. }], None);
        app.update();
        assert_eq!(root(&app), changed);
        bridge::clear_model_assets();
        app.update();
        assert!(app.world().resource::<model3d::ModelVisuals>().test_root("n").is_none());
        bridge::queue_model_asset(descriptor);
        app.update();
        assert_eq!(root(&app).1.translation, Vec3::new(256., 192., -128.));
        bridge::clear_model_assets();
    }

    #[test]
    fn public_scene_motion_and_clear_follow_real_frame_schedule() {
        crate::bridge::clear_model_assets();
        let request = r##"{"resourceVersion":"woohaa-prepared-model-resource-v1","sceneVersion":"woohaa-model-scene-ir-v2","ops":[{"t":"box","id":"body","position":[0,1,0],"rotation":[0,0,0],"scale":[1,1,1],"color":"#ffffff","size":[2,2,2]}]}"##;
        let metadata: serde_json::Value = serde_json::from_str(&crate::prepare_and_register_model_resource(request).unwrap()).unwrap();
        let mut scene: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/shared-world/render-scene.json")).unwrap();
        scene["nodes"][0]["model"] = serde_json::json!({"resourceKey": metadata["resourceKey"]});
        scene["nodes"][0]["sharedWorldInstance"]["transform"] = serde_json::json!({"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},"rotation":[0,0,0,1],"scale":1});
        scene["animationPlayback"] = serde_json::json!({"nodeId":"model","version":"woohaa-motion-ir-v1","time":1,"duration":4,"initialCamera":{},"modelMotion":[{"targetId":"body","startTime":0,"endTime":4,"motion":{"kind":"move","axis":"x","speed":4,"range":[0,8]}}]});
        let mut app = model_test_app();
        let query = |generation, point: Vec3| {
            let screen = crate::isometric_grid::screen_point_from_world(point, &Default::default());
            let request = format!(r#"{{"generation":{generation},"x":{},"y":{},"width":800,"height":600}}"#, screen.x, screen.y);
            serde_json::from_str::<serde_json::Value>(&crate::query_model_pick(&request)).unwrap()["nodeId"].clone()
        };
        let generation = crate::set_scene(&scene.to_string()).unwrap();
        app.update();
        let part = app.world().resource::<model3d::ModelVisuals>().test_part("model", "body").unwrap();
        assert_eq!(app.world().get::<Transform>(part).unwrap().translation.x, 4.);
        assert_eq!(query(generation, Vec3::new(256., 64., 0.)), "model");
        assert!(query(generation, Vec3::new(0., 64., 0.)).is_null());
        scene["animationPlayback"]["modelMotion"] = serde_json::json!([{"targetId":"body","startTime":0,"endTime":4,"motion":{"kind":"keyframes","property":"opacity","frames":[{"time":0,"value":0,"easing":"linear"},{"time":4,"value":0,"easing":"linear"}]}}]);
        let hidden = crate::set_scene(&scene.to_string()).unwrap();
        app.update();
        assert_eq!(app.world().get::<Transform>(part).unwrap().translation.x, 0.);
        assert_eq!(app.world().get::<Visibility>(part), Some(&Visibility::Hidden));
        assert!(query(hidden, Vec3::new(0., 64., 0.)).is_null());
        scene.as_object_mut().unwrap().remove("animationPlayback");
        let reset = crate::set_scene(&scene.to_string()).unwrap();
        app.update();
        assert_ne!(app.world().get::<Visibility>(part), Some(&Visibility::Hidden));
        assert_eq!(app.world().get::<Transform>(part).unwrap().translation.x, 0.);
        assert_eq!(query(reset, Vec3::new(0., 64., 0.)), "model");
        assert!(query(reset, Vec3::new(256., 64., 0.)).is_null());
        scene["nodes"] = serde_json::json!([]);
        let cleared = crate::set_scene(&scene.to_string()).unwrap();
        app.update();
        assert!(query(cleared, Vec3::new(0., 64., 0.)).is_null());
        assert!(app.world().resource::<model3d::ModelVisuals>().test_root("model").is_none());
        crate::bridge::clear_model_assets();
    }

    #[test]
    fn shot_transition_preserves_layout_hidden_segments() {
        let mut app = App::new();
        app.init_resource::<CurrentScene>()
            .insert_resource(crate::shot_camera::ShotPreviewViewport {
                rect: Some(Vec4::new(0.0, 0.0, 320.0, 180.0)),
                ..default()
            })
            .add_systems(Update, hide_shot_gizmos_during_transition);
        let rig = app.world_mut().spawn_empty().id();
        let visible = app
            .world_mut()
            .spawn((crate::shot_camera::ShotGizmo { rig }, Visibility::Inherited))
            .id();
        let dashed = app
            .world_mut()
            .spawn((crate::shot_camera::ShotGizmo { rig }, Visibility::Hidden))
            .id();
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(visible).unwrap(),
            Visibility::Inherited
        );
        assert_eq!(
            *app.world().get::<Visibility>(dashed).unwrap(),
            Visibility::Hidden
        );
        app.world_mut()
            .resource_mut::<crate::shot_camera::ShotPreviewViewport>()
            .hold = true;
        app.update();
        assert_eq!(
            *app.world().get::<Visibility>(visible).unwrap(),
            Visibility::Hidden
        );
        assert_eq!(
            *app.world().get::<Visibility>(dashed).unwrap(),
            Visibility::Hidden
        );
    }

    // 只运行 ECS 与 CPU 网格生成，不创建窗口或 GPU。
    #[test]
    fn viewport_increments_refresh_grid_coverage_without_full_scene() {
        let mut app = App::new();
        app.init_resource::<Assets<Mesh>>()
            .init_resource::<Assets<StandardMaterial>>()
            .init_resource::<ThemeResource>()
            .init_resource::<CurrentScene>()
            .init_resource::<SurfaceState>()
            .init_resource::<FocusRig>()
            .insert_resource(FrameFlags {
                camera_changed: true,
                viewport_only: true,
                ..default()
            })
            .add_plugins(isometric_grid::IsometricGridPlugin)
            .add_systems(
                Update,
                sync_grid.before(isometric_grid::IsometricGridSet::Style),
            );
        let size = Vec2::new(1920.0, 1080.0);
        app.world_mut().resource_mut::<SurfaceState>().size = size;
        let target = app
            .world_mut()
            .spawn(isometric_grid::IsometricGridTarget::default())
            .id();
        let mut previous = Vec::new();
        for (x, y, zoom) in [
            (0.0, 0.0, 1.0),
            (8000.0, -6000.0, 1.0),
            (-9000.0, 7000.0, 0.25),
        ] {
            app.world_mut().resource_mut::<CurrentScene>().0.viewport =
                crate::protocol::Viewport { x, y, zoom };
            app.update();
            let world = app.world_mut();
            let view = world
                .get::<isometric_grid::IsometricGridTarget>(target)
                .unwrap()
                .view;
            assert_eq!((view.x, view.y, view.zoom), (x, y, zoom));
            let handles: Vec<_> = world
                .query_filtered::<&Mesh3d, With<isometric_grid::IsometricGrid>>()
                .iter(world)
                .map(|mesh| mesh.0.clone())
                .collect();
            assert_eq!(handles.len(), 2);
            assert_ne!(handles, previous);
            let meshes = world.resource::<Assets<Mesh>>();
            let mut min = Vec2::splat(f32::INFINITY);
            let mut max = Vec2::splat(f32::NEG_INFINITY);
            for handle in &handles {
                let Some(VertexAttributeValues::Float32x3(positions)) = meshes
                    .get(handle)
                    .unwrap()
                    .attribute(Mesh::ATTRIBUTE_POSITION)
                else {
                    panic!("网格缺少顶点");
                };
                for position in positions {
                    let point =
                        isometric_grid::screen_point_from_world(Vec3::from_array(*position), &view);
                    min = min.min(point);
                    max = max.max(point);
                }
            }
            assert!(min.x <= 0.0 && min.y <= 0.0 && max.x >= size.x && max.y >= size.y);
            assert_eq!(meshes.len(), 2, "旧网格应及时回收");
            previous = handles;
        }
        // 同一视口续帧时复用网格，不反复上传。
        app.update();
        let world = app.world_mut();
        let handles: Vec<_> = world
            .query_filtered::<&Mesh3d, With<isometric_grid::IsometricGrid>>()
            .iter(world)
            .map(|mesh| mesh.0.clone())
            .collect();
        assert_eq!(handles, previous);
    }
}

#[cfg(all(test, feature = "native-canvas", feature = "native-renderer"))]
#[path = "scene3d_hardware_tests.rs"]
mod hardware_tests;
