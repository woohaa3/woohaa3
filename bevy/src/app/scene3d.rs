use bevy::prelude::*;

use crate::{isometric_grid, model3d, theme::ThemeResource};

use super::{AnimationCameraState, CurrentScene, FocusRig, FrameFlags, ModelAssetTable, SurfaceState};

/// Native 片场后台准备推进（独占系统）：非阻塞 poll + 分帧装配
/// （change: 2026-10-18-prepare-native-film-sets-in-background，design D4/D5）。
///
/// 独立成独占系统是为了**直接写 World** 并让真实装配/命令应用进入计时，而不是把重活推成
/// 帧尾无界 drain。它排在 `sync_models` 之后、预览/捕获之前，因此同一帧的消费者能看到
/// 本次新发布的根或 Pending 状态。
pub(super) fn advance_preparation(world: &mut World) {
    let scene = world.resource::<CurrentScene>().0.clone();
    let resources = world.resource::<ModelAssetTable>().0.clone();
    model3d::advance_preparation(world, &scene, &resources);
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
    resources: Res<ModelAssetTable>,
    scene: Res<CurrentScene>,
    flags: Res<FrameFlags>,
    rig: Res<FocusRig>,
    mut visible_focus: Local<Option<String>>,
    mut animation_camera: ResMut<AnimationCameraState>,
    time: Res<Time>,
    capture: Res<model3d::capture::ShotCaptureRouting>,
    render_work: Res<crate::model_preview::render_work::RenderWork>,
) {
    // 门禁结算必须每帧运行：hover 可能未改变 `Scene` 指纹（如 pointer 位移落在同一节点），
    // 但重建/生命周期仍需要按最新 hover 初始化 playback（change: play-model-animations-on-hover，
    // design D3/D4）。
    let started = bevy::platform::time::Instant::now();
    let models = &mut *visuals;
    // 按需 spawn 集合（C2.1–C2.3）：descriptor 注册独立于 ECS/GPU 需求。
    // 截图（含等待 GPU ready/readback 期间）作为强制高质量消费者 pin 其节点（B1.6）。
    let pins = capture.pins(&scene.0);
    let now = time.elapsed_secs_f64();
    let demand_changed = model3d::demand::update(models, &scene.0, rig.focus_node.as_deref(), &pins, now);
    if flags.changed || demand_changed {
        model3d::sync_models(
            &mut commands,
            &mut meshes,
            &mut materials,
            models,
            &mut focus,
            &resources.0,
            &scene.0,
        );
    }
    model3d::apply_animation_playback(&mut commands, models, &scene.0);
    // 活动动画节点的运动求值（change: 2026-10-05-bind-model-animation-to-shots）：独立模型
    // 姿态与唯一时钟；相机姿态写入共享资源供 shot adapter / 聚焦相机复用。
    animation_camera.0 = model3d::apply_motion_playback(&mut commands, models, &mut materials, &scene.0);
    // 质量档位只替换共享 handle，不重建 hierarchy、不执行脚本、不改 canonical AABB。
    let quality_changed = model3d::sync_quality(
        &mut commands,
        &mut meshes,
        models,
        &scene.0,
        rig.focus_node.as_deref(),
        now,
        &pins,
    );
    if quality_changed {
        models.trim_resources(&mut meshes, &mut materials);
    }
    // 准备管线的发布/取消/退役同样推进诊断快照；只在有变更时发布一次，不逐帧输出。
    let preparation_changed = models.take_preparation_changed();
    if flags.changed || demand_changed || quality_changed || preparation_changed {
        crate::bridge::set_model_render_diagnostics(models.budget_json(&meshes, &materials));
    }
    // 相机每帧推进过渡；即使没有新 scene，也要在结束帧恢复所有模型。
    if flags.changed || *visible_focus != rig.focus_node {
        visuals.set_visible_focus(&mut commands, rig.focus_node.as_deref());
        *visible_focus = rig.focus_node.clone();
    }
    render_work.startup_models(scene.0.animation_playback.as_ref(), started.elapsed().as_secs_f64() * 1000.0);
}

pub(super) fn sync_editor_gizmo(
    mut selection: ResMut<crate::transform_gizmo::TransformGizmoSelection>,
    mut style: ResMut<crate::transform_gizmo::TransformGizmoStyle>,
    scene: Res<CurrentScene>,
    theme: Res<ThemeResource>,
    flags: Res<FrameFlags>,
) {
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
    if !flags.changed {
        return;
    }
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
///
/// 拍摄镜头卡片预览的 rig 也带 `ShotCameraPose`，但不是 adapter 的窗口 rig，因此按
/// `ShotPreviewRig` 显式排除（change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
pub(super) fn reclaim_extra_shot_rigs(
    mut commands: Commands,
    adapter: Res<model3d::shot_adapter::ShotAdapterState>,
    rigs: Query<
        Entity,
        (
            With<crate::shot_camera::ShotCameraPose>,
            Without<crate::shot_node_preview::ShotPreviewRig>,
        ),
    >,
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
    let right = if right.is_finite() && right > 0.0 { right } else { 0.0 };
    let aspect = scene
        .0
        .model_editor
        .as_ref()
        .and_then(|editor| editor.shot.as_ref())
        .map(|shot| shot_aspect_ratio(&shot.aspect))
        .unwrap_or(16.0 / 9.0);
    let animation_preview = scene.0.animation_playback.as_ref().filter(|p| p.view_mode == "focus-preview");
    let aspect = animation_preview.map(|p| shot_aspect_ratio(&p.initial_camera.aspect)).unwrap_or(aspect);
    let has_shot = animation_preview.is_some() || scene.0.model_editor.as_ref().is_some_and(|editor| {
        editor.tool_mode == "camera" && editor.shot.is_some()
    });
    viewport.hold = rig.animating();
    viewport.rect = if has_shot && width > 0.0 && height > 0.0 {
        Some(if animation_preview.is_some() {
            let rect = surface.and_then(|s| s.content_rect.as_ref());
            let x = rect.map(|r| r.x).unwrap_or(0.0);
            let y = rect.map(|r| r.y).unwrap_or(0.0);
            let w = rect.map(|r| r.width).unwrap_or((width - right).max(1.0));
            let h = rect.map(|r| r.height).unwrap_or(height);
            let frame_h = h.min(w / aspect);
            Vec4::new(x + (w - frame_h * aspect) / 2.0, y + (h - frame_h) / 2.0, frame_h * aspect, frame_h)
        } else if let Some(rect) = surface.and_then(|surface| surface.content_rect.as_ref()) {
            let max_w = ((rect.width - 32.0) * 0.32).clamp(1.0, 340.0);
            let max_h = ((rect.height - 56.0) * 0.30).clamp(1.0, 220.0);
            let h = (max_w / aspect).min(max_h);
            Vec4::new(rect.x + 16.0, rect.y + (rect.height - h - 16.0).max(0.0), h * aspect, h)
        } else { rig_preview_rect((width - right).max(1.0), height, aspect) })
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
    Vec4::new(margin, (height - preview_height - margin).max(0.0), preview_width, preview_height)
}

/// 观察相机始终铺满主画面，用来看 rig 和模型。它没有可画的本体。
pub(super) fn drive_observer_from_shot(
    scene: Res<CurrentScene>,
    mut observer: Query<
        (&mut Camera, &mut bevy::camera::visibility::RenderLayers),
        With<model3d::grid::ModelCanvasCamera>,
    >,
) {
    for (mut camera, mut layers) in &mut observer {
        camera.is_active = !scene.0.animation_playback.as_ref().is_some_and(|p| p.view_mode == "focus-preview");
        camera.order = 0;
        camera.viewport = None;
        *layers = bevy::camera::visibility::RenderLayers::from_layers(&[0, model3d::RUN_EFFECT_LAYER]);
    }
}

/// 没有选中镜头的主视图时隐藏 shot gizmo，避免退出聚焦后环留在画布上。
pub(super) fn hide_shot_gizmos_during_transition(
    scene: Res<CurrentScene>,
    viewport: Res<crate::shot_camera::ShotPreviewViewport>,
    mut gizmos: Query<&mut Visibility, With<crate::shot_camera::ShotGizmo>>,
) {
    let hidden = scene.0.animation_playback.as_ref().is_some_and(|p| p.view_mode == "focus-preview") || viewport.rect.is_none() || viewport.hold;
    for mut visibility in &mut gizmos {
        *visibility = if hidden {
            Visibility::Hidden
        } else {
            Visibility::Inherited
        };
    }
}

#[cfg(test)]
mod grid_tests {
    use super::*;
    use bevy::mesh::VertexAttributeValues;

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
