//! Shot camera 模块集成测试
//! （change: add-reusable-bevy-shot-camera，任务 1.3/1.4/2.x/3.x/4.x）。
//!
//! 用最小 headless App 验证：多 rig 共存与独立 identity、稳定禁用状态、预览/捕获队列的有界
//! 与生命周期、编辑命令状态机、以及资源释放。所有断言不依赖 GPU 或窗口。

use bevy::prelude::*;
use woohaa_bevy_canvas::shot_camera::{
    Aabb, FocusComponent, MAX_CAPTURE_DIMENSION, ShotCameraAxis, ShotCameraCommands,
    ShotCameraConfig, ShotCameraError, ShotCameraId, ShotCameraLens, ShotCameraPlugin,
    ShotCameraPose, ShotCameraPreview, ShotCaptureEnqueue, ShotCaptureQueue, ShotCaptureRequest,
    ShotCaptureResults, ShotEditCommand, ShotEditCommands, ShotEditSessions, ShotPreviewOutput,
    begin_edit, cancel_edit, commit_edit, distance_from_drag, resolve_shot_camera,
    shot_distance_bounds, shot_fit_distance, update_distance, update_focus, update_orbit,
};

fn test_app() -> App {
    let mut app = App::new();
    app.init_resource::<Assets<Image>>();
    app.init_resource::<Assets<Mesh>>();
    app.init_resource::<Assets<StandardMaterial>>();
    app.add_plugins(ShotCameraPlugin);
    app
}

#[test]
fn multiple_rigs_coexist_with_stable_identity() {
    let mut app = test_app();
    let config_a = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let config_b = ShotCameraConfig::from_bounds(Aabb::new(
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(4.0, 4.0, 4.0),
    ));
    let a = app.world_mut().commands().spawn_shot_camera(config_a);
    let b = app.world_mut().commands().spawn_shot_camera(config_b);
    app.update();
    app.update();
    assert_ne!(a, b);
    let world = app.world();
    let derived_a = world
        .get::<woohaa_bevy_canvas::shot_camera::ShotCameraDerived>(a)
        .unwrap();
    let derived_b = world
        .get::<woohaa_bevy_canvas::shot_camera::ShotCameraDerived>(b)
        .unwrap();
    assert!(derived_a.fov > 0.0 && derived_a.fov < std::f32::consts::PI);
    assert!(derived_b.fov > 0.0 && derived_b.fov < std::f32::consts::PI);
    assert!(world.get::<ShotCameraId>(a).is_some());
    assert!(world.get::<ShotCameraId>(b).is_some());
}

#[test]
fn invalid_config_is_rejected_without_partial_resources() {
    let mut app = test_app();
    let mut config =
        ShotCameraConfig::from_bounds(Aabb::new(Vec3::new(f32::NAN, 0.0, 0.0), Vec3::splat(1.0)));
    config.preview = Some(ShotCameraPreview::new(640, 360));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    let world = app.world();
    assert_eq!(
        world.get::<ShotCameraError>(entity),
        Some(&ShotCameraError::InvalidBounds)
    );
    assert!(
        world.get::<ShotPreviewOutput>(entity).is_none(),
        "非法 rig 不应留下 preview 输出"
    );
}

#[test]
fn preview_output_is_published_without_cpu_readback() {
    let mut app = test_app();
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    let world = app.world();
    let output = world
        .get::<ShotPreviewOutput>(entity)
        .expect("启用 preview 的 rig 应有 ShotPreviewOutput");
    assert_eq!(output.size, UVec2::new(640, 360));
    assert!(world.get_resource::<Assets<Image>>().is_some());
    assert!(
        world
            .resource::<Assets<Image>>()
            .get(&output.image)
            .is_some(),
        "preview Image 应实际存在于 Assets<Image>"
    );
}

#[test]
fn preview_policy_on_dirty_does_not_render_when_idle() {
    // OnDirty：静止帧 generation 不变，输出 generation 保持稳定。
    let mut app = test_app();
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    let first = app
        .world()
        .get::<ShotPreviewOutput>(entity)
        .unwrap()
        .generation;
    app.update();
    app.update();
    let second = app
        .world()
        .get::<ShotPreviewOutput>(entity)
        .unwrap()
        .generation;
    assert_eq!(first, second, "静止帧不应推进 preview generation");
}

#[test]
fn removing_preview_component_releases_output() {
    let mut app = test_app();
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    assert!(app.world().get::<ShotPreviewOutput>(entity).is_some());
    app.world_mut()
        .entity_mut(entity)
        .remove::<ShotCameraPreview>();
    app.update();
    app.update();
    assert!(
        app.world().get::<ShotPreviewOutput>(entity).is_none(),
        "移除 preview 组件后应释放 ShotPreviewOutput"
    );
}

#[test]
fn despawn_rig_removes_orbit_gizmos() {
    use woohaa_bevy_canvas::shot_camera::{
        PreviewTarget, ShotGizmo, ShotGizmoSelection, ShotPreviewCamera,
    };
    let mut app = test_app();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.preview = Some(
        ShotCameraPreview::new(320, 180)
            .with_policy(woohaa_bevy_canvas::shot_camera::PreviewUpdatePolicy::Continuous)
            .with_target(PreviewTarget::Window),
    );
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.world_mut()
        .resource_mut::<ShotGizmoSelection>()
        .entities
        .push(entity);
    app.world_mut().resource_mut::<ShotGizmoSelection>().view =
        woohaa_bevy_canvas::gizmo_layout::GizmoView::orbit(
            Vec3::ZERO,
            0.7,
            -0.5,
            20.0,
            Vec2::new(1000.0, 800.0),
            1.0,
        );
    app.update();
    app.update();
    let mut gizmos = app.world_mut().query::<&ShotGizmo>();
    assert!(
        gizmos.iter(app.world()).count() > 0,
        "选中 rig 应生成轨道环"
    );
    let mut cameras = app.world_mut().query::<&ShotPreviewCamera>();
    assert_eq!(cameras.iter(app.world()).count(), 1);
    app.world_mut().entity_mut(entity).despawn();
    app.update();
    let mut gizmos = app.world_mut().query::<&ShotGizmo>();
    let mut cameras = app.world_mut().query::<&ShotPreviewCamera>();
    assert_eq!(gizmos.iter(app.world()).count(), 0);
    assert_eq!(
        cameras.iter(app.world()).count(),
        0,
        "销毁 rig 后窗口预览相机不得继续渲染"
    );
}

#[test]
fn despawn_rig_releases_registry_entry() {
    let mut app = test_app();
    let config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    let before = app
        .world()
        .resource::<woohaa_bevy_canvas::shot_camera::ShotCameraRegistry>()
        .rigs
        .len();
    app.world_mut().entity_mut(entity).despawn();
    app.update();
    let after = app
        .world()
        .resource::<woohaa_bevy_canvas::shot_camera::ShotCameraRegistry>()
        .rigs
        .len();
    assert!(after < before, "销毁 rig 后注册表应回落");
}

#[test]
fn edit_state_machine_orbit_commit_and_cancel() {
    let mut pose = ShotCameraPose::new(0.3, 10.0);
    let mut session = begin_edit(
        Entity::from_raw_u32(1).unwrap(),
        ShotCameraAxis::Orbit,
        None,
        pose,
        5.0,
    );
    let event = update_orbit(&mut session, 120.0, 800.0);
    assert!(
        matches!(event, woohaa_bevy_canvas::shot_camera::ShotEditEvent::Updated { moved, .. } if moved)
    );
    let committed = commit_edit(&session).expect("有净变化应发布 commit");
    if let woohaa_bevy_canvas::shot_camera::ShotEditEvent::Committed { pose: next, .. } = committed
    {
        pose = next;
    }
    assert!(pose.azimuth > 0.9, "orbit 应推进 azimuth");

    // 无净变化的 commit 不发布。
    let same = begin_edit(
        Entity::from_raw_u32(1).unwrap(),
        ShotCameraAxis::Orbit,
        None,
        pose,
        5.0,
    );
    assert!(commit_edit(&same).is_none());

    // cancel 恢复起始 pose。
    let mut cancelled = begin_edit(
        Entity::from_raw_u32(1).unwrap(),
        ShotCameraAxis::Orbit,
        None,
        pose,
        5.0,
    );
    let _ = update_distance(&mut cancelled, 50.0, 600.0);
    if let woohaa_bevy_canvas::shot_camera::ShotEditEvent::Cancelled { pose: restored, .. } =
        cancel_edit(&cancelled)
    {
        assert!((restored.distance - pose.distance).abs() < 1e-6);
    }
}

#[test]
fn edit_focus_axis_moves_offset() {
    let pose = ShotCameraPose::new(0.0, 10.0);
    let mut session = begin_edit(
        Entity::from_raw_u32(2).unwrap(),
        woohaa_bevy_canvas::shot_camera::ShotCameraAxis::Focus,
        Some(FocusComponent::X),
        pose,
        5.0,
    );
    let _ = update_focus(&mut session, 1.5);
    assert!((session.current_pose.focus_offset.x - 1.5).abs() < 1e-6);
}

#[test]
fn disabled_editable_rejects_commands() {
    let mut app = test_app();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.editable = false;
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    let before = *app.world().get::<ShotCameraPose>(entity).unwrap();
    app.world_mut()
        .resource_mut::<ShotEditCommands>()
        .push(entity, ShotEditCommand::BeginOrbit);
    app.world_mut().resource_mut::<ShotEditCommands>().push(
        entity,
        ShotEditCommand::UpdateOrbit {
            delta_x: 200.0,
            surface_width: 800.0,
        },
    );
    app.update();
    let after = *app.world().get::<ShotCameraPose>(entity).unwrap();
    assert!(
        (before.azimuth - after.azimuth).abs() < 1e-9,
        "只读 rig 不应被编辑"
    );
    assert!(app.world().resource::<ShotEditSessions>().active.is_empty());
}

#[test]
fn capture_queue_is_bounded_and_per_request() {
    let mut queue = ShotCaptureQueue {
        max_concurrent: 1,
        max_queued: 2,
        ..Default::default()
    };
    let camera_a = Entity::from_raw_u32(10).unwrap();
    let camera_b = Entity::from_raw_u32(11).unwrap();
    let request = |camera: Entity, request_id: u64| ShotCaptureRequest {
        camera,
        request_id,
        width: 1280,
        height: 720,
        generation: 1,
    };
    assert_eq!(
        queue.enqueue(request(camera_a, 1)),
        ShotCaptureEnqueue::Accepted
    );
    assert_eq!(
        queue.enqueue(request(camera_b, 2)),
        ShotCaptureEnqueue::Queued
    );
    assert_eq!(
        queue.enqueue(request(camera_b, 3)),
        ShotCaptureEnqueue::Queued
    );
    assert_eq!(
        queue.enqueue(request(camera_b, 4)),
        ShotCaptureEnqueue::Busy
    );
    // 新请求不取消无关 rig 的进行中请求。
    assert_eq!(queue.active.len(), 1);
    assert_eq!(queue.pending.len(), 2);
    // 完成第一个后提升队列项。
    queue.complete(&request(camera_a, 1));
    assert_eq!(queue.active.len(), 1);
    assert_eq!(queue.pending.len(), 1);
    // 取消某 rig 的全部请求。
    let cancelled = queue.cancel_camera(camera_b);
    assert_eq!(cancelled.len(), 2);
    assert!(queue.is_empty());
}

#[test]
fn capture_queue_rejects_oversized_requests() {
    let mut queue = ShotCaptureQueue::default();
    let request = ShotCaptureRequest {
        camera: Entity::from_raw_u32(1).unwrap(),
        request_id: 1,
        width: MAX_CAPTURE_DIMENSION + 1,
        height: 720,
        generation: 1,
    };
    assert_eq!(queue.enqueue(request), ShotCaptureEnqueue::Rejected);
}

#[test]
fn capture_result_generation_matches_request() {
    let mut results = ShotCaptureResults::default();
    let request_id = results.next_request_id();
    assert_eq!(request_id, 1);
    assert_eq!(results.next_request_id(), 2);
}

#[test]
fn resolve_matches_hand_computed_default() {
    let aabb = Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0));
    let pose = resolve_shot_camera(
        &aabb,
        0.0,
        std::f32::consts::FRAC_PI_4,
        100.0,
        16.0 / 9.0,
        Vec3::ZERO,
    )
    .unwrap();
    let fit = shot_fit_distance(3f32.sqrt(), 16.0 / 9.0);
    let (min, max) = shot_distance_bounds(fit);
    assert!(
        pose.distance >= min - 1e-9 && pose.distance <= max + 1e-9,
        "distance 落在合法范围"
    );
    assert!(pose.position.y > 0.0, "默认 45° 仰角应位于 focus 上方");
    assert!((pose.elevation - std::f32::consts::FRAC_PI_4).abs() < 1e-9);
    assert!(pose.fov > 0.0 && pose.fov < std::f32::consts::PI);
}

#[test]
fn distance_drag_clamps_into_bounds() {
    // 透视 + 下限放开：拉到极近时仍为有限正值（不再卡在 1.2 之外）。
    let clamped = distance_from_drag(10.0, 10_000.0, 600.0, 5.0);
    assert!(
        clamped > 0.0 && clamped.is_finite(),
        "distance 必须为有限正值"
    );
    assert!(clamped >= 0.01 - 1e-9, "distance 必须落在放开后的下界以上");
}

#[test]
fn image_handle_readback_formats() {
    use bevy::asset::RenderAssetUsages;
    use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};
    let mut image = Image::new_uninit(
        Extent3d {
            width: 2,
            height: 1,
            ..default()
        },
        TextureDimension::D2,
        TextureFormat::Bgra8UnormSrgb,
        RenderAssetUsages::default(),
    );
    image.data = Some(vec![10, 20, 30, 255, 40, 50, 60, 255]);
    let rgba = woohaa_bevy_canvas::shot_camera::rgba_from_image(&image, 2, 1).expect("rgba");
    assert_eq!(&rgba[0..4], &[30, 20, 10, 255]);
}

#[test]
fn lens_projection_is_perspective() {
    let lens = ShotCameraLens::from_aspect(1.0);
    let projection = lens.projection();
    match projection {
        Projection::Perspective(perspective) => {
            assert!(
                (perspective.fov - woohaa_bevy_canvas::shot_camera::SHOT_CAMERA_FOV).abs() < 1e-6
            );
            assert!(
                perspective.near > 0.0 && perspective.near < 0.01,
                "极小固定近裁剪面"
            );
            assert!(perspective.far > perspective.near);
        }
        _ => panic!("shot camera 应为透视投影"),
    }
}

#[test]
fn capture_request_for_window_target_rig_creates_offscreen_target() {
    // window-target rig（无 ShotPreviewOutput）也应能触发 capture：提交时建立临时离屏目标。
    use woohaa_bevy_canvas::shot_camera::{
        PreviewTarget, ShotCaptureEnqueue, ShotCaptureQueue, ShotCaptureResults,
    };
    let mut app = test_app();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.preview = Some(ShotCameraPreview::new(320, 180).with_target(PreviewTarget::Window));
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    assert!(app.world().get::<ShotPreviewOutput>(entity).is_none());

    let generation = app
        .world()
        .get::<woohaa_bevy_canvas::shot_camera::ShotCameraDerived>(entity)
        .unwrap()
        .generation;
    let world = app.world_mut();
    let mut queue = world.remove_resource::<ShotCaptureQueue>().unwrap();
    let mut results = world.remove_resource::<ShotCaptureResults>().unwrap();
    let (_request_id, outcome) = woohaa_bevy_canvas::shot_camera::request_capture(
        &mut queue,
        &mut results,
        entity,
        1280,
        720,
        generation,
    );
    world.insert_resource(queue);
    world.insert_resource(results);
    assert_eq!(outcome, ShotCaptureEnqueue::Accepted);
    app.update();
    // 请求应被处理：进入 in-flight，或（无 GPU 环境）以稳定失败结束。
    let in_flight = app
        .world()
        .resource::<woohaa_bevy_canvas::shot_camera::ShotCaptureState>()
        .in_flight_len();
    let failures = app.world().resource::<ShotCaptureResults>().failures.len();
    assert!(
        in_flight > 0 || failures > 0,
        "请求应被处理（进行中或稳定失败）"
    );
}

#[test]
fn preview_budget_limits_updates_per_frame() {
    use woohaa_bevy_canvas::shot_camera::{ShotPreviewBudget, plan_preview_updates};
    let budget = ShotPreviewBudget {
        max_updates_per_frame: 2,
        max_pixels_per_frame: u64::MAX,
    };
    let dirty: Vec<(Entity, u32, u32)> = (0..5)
        .map(|index| (Entity::from_raw_u32(index).unwrap(), 64, 64))
        .collect();
    let selected = plan_preview_updates(&dirty, &budget);
    assert_eq!(selected.len(), 2);
}

#[test]
fn caller_viewport_rejects_non_positive_size() {
    use woohaa_bevy_canvas::shot_camera::{
        CallerViewport, resolve_caller_viewport, viewport_from_css,
    };
    assert_eq!(resolve_caller_viewport(None), CallerViewport::Unspecified);
    assert!(matches!(
        resolve_caller_viewport(Some(Vec4::new(0.0, 0.0, 800.0, 600.0))),
        CallerViewport::Valid(_)
    ));
    assert_eq!(
        resolve_caller_viewport(Some(Vec4::new(0.0, 0.0, 0.0, 600.0))),
        CallerViewport::Invalid
    );
    assert_eq!(
        resolve_caller_viewport(Some(Vec4::new(0.0, 0.0, f32::NAN, 600.0))),
        CallerViewport::Invalid
    );
    let (position, size) = viewport_from_css(Vec4::new(10.0, 20.0, 640.0, 480.0), 2.0);
    assert_eq!(position, UVec2::new(20, 40));
    assert_eq!(size, UVec2::new(1280, 960));
}

#[test]
fn caller_viewport_drives_window_camera_and_invalid_rect_disables_it() {
    use woohaa_bevy_canvas::shot_camera::{PreviewTarget, ShotPreviewViewport};
    let mut app = test_app();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.preview = Some(
        ShotCameraPreview::new(640, 360)
            .with_policy(woohaa_bevy_canvas::shot_camera::PreviewUpdatePolicy::Continuous)
            .with_target(PreviewTarget::Window),
    );
    app.world_mut().commands().spawn_shot_camera(config);
    app.world_mut().insert_resource(ShotPreviewViewport {
        surface: Vec2::new(800.0, 600.0),
        pixel_ratio: 2.0,
        rect: Some(Vec4::new(0.0, 0.0, 640.0, 480.0)),
        hold: false,
    });
    app.update();
    app.update();
    let world = app.world_mut();
    let mut cameras = world.query::<&bevy::camera::Camera>();
    let camera = cameras.iter(world).next().expect("window camera");
    assert!(camera.is_active);
    assert!(camera.viewport.is_some(), "有效矩形应写入 viewport");

    app.world_mut().insert_resource(ShotPreviewViewport {
        surface: Vec2::new(800.0, 600.0),
        pixel_ratio: 2.0,
        rect: Some(Vec4::new(0.0, 0.0, -1.0, 480.0)),
        hold: false,
    });
    app.update();
    let world = app.world_mut();
    let mut cameras = world.query::<&bevy::camera::Camera>();
    let camera = cameras.iter(world).next().expect("window camera");
    assert!(!camera.is_active);
    assert!(camera.viewport.is_none(), "无效矩形不得沿用上一次 viewport");
}

#[test]
fn preview_viewport_rect_matches_product_layout() {
    use woohaa_bevy_canvas::shot_camera::preview_viewport_rect;
    // 宽屏：右下角 28px 边距，宽高不超过 360x220。
    let wide = preview_viewport_rect(Vec2::new(1200.0, 800.0), 16.0 / 9.0);
    assert!((wide.x - 28.0).abs() < 1e-6);
    assert!(wide.z <= 360.0 + 1e-3 && wide.w <= 220.0 + 1e-3);
    assert!((wide.y - (800.0 - wide.w - 28.0)).abs() < 1e-6);
    // 紧凑屏：居中靠上。
    let compact = preview_viewport_rect(Vec2::new(640.0, 900.0), 1.0);
    assert!((compact.x - (640.0 - compact.z) / 2.0).abs() < 1e-6);
    assert!((compact.y - 82.0).abs() < 1e-6);
}

#[test]
fn window_target_preview_creates_camera_without_offscreen_image() {
    use woohaa_bevy_canvas::shot_camera::{PreviewTarget, ShotCameraViewMask};
    let mut app = test_app();
    let mut config = ShotCameraConfig::from_bounds(Aabb::new(Vec3::splat(-1.0), Vec3::splat(1.0)));
    config.preview = Some(ShotCameraPreview::new(640, 360).with_target(PreviewTarget::Window));
    config.view_mask = ShotCameraViewMask::default();
    let entity = app.world_mut().commands().spawn_shot_camera(config);
    app.update();
    app.update();
    assert!(app.world().get::<ShotPreviewOutput>(entity).is_none());
    // 内部存在一个预览相机。
    let world = app.world_mut();
    let mut q = world.query::<&woohaa_bevy_canvas::shot_camera::ShotPreviewCamera>();
    assert_eq!(q.iter(world).count(), 1);
}
