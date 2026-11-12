use bevy::{
    camera::Viewport,
    prelude::*,
    window::{PrimaryWindow, WindowResized},
};

use crate::{bridge, canvas2d, theme::ThemeResource};

use super::{
    helpers::place_native_surface, CurrentScene, FrameFlags, ModelAssetTable, ModelTextureBatch,
    NodeIndex, SurfaceState, TextureBatch,
};

/// 重置帧标记，取走最新 scene/texture batch；检测 theme-only 变化。
pub(crate) fn ingest_bridge(
    _main_thread: bevy::ecs::system::NonSendMarker,
    mut flags: ResMut<FrameFlags>,
    mut scene: ResMut<CurrentScene>,
    mut index: ResMut<NodeIndex>,
    mut positions: ResMut<super::positions::PositionIndex>,
    mut theme: ResMut<ThemeResource>,
    mut batch: ResMut<TextureBatch>,
    mut focus_details: ResMut<canvas2d::focus_details::FocusDetailBatch>,
    mut model_textures: ResMut<ModelTextureBatch>,
    mut resources: ResMut<ModelAssetTable>,
    mut clear_color: ResMut<ClearColor>,
) {
    let input = bridge::take_input();
    flags.model_textures_changed = !input.model_textures.is_empty();
    flags.scene_received = input.scene.is_some();
    flags.positions_received = !input.positions.is_empty();
    flags.resource_nodes.clear();
    flags.changed = false;
    flags.canvas_committed = false;
    flags.theme_changed = false;
    flags.viewport_only = false;
    flags.observer_changed = false;
    flags.mesh_rebuilt = false;
    flags.card_blocks_rebuilt = 0;
    flags.card_decorations_rebuilt = 0;
    flags.edge_blocks_rebuilt = 0;
    if let Some(next) = input.scene {
        flags.theme_changed = next.theme.fingerprint != theme.0.fingerprint;
        theme.0 = next.theme.clone();
        clear_color.0 = theme.backdrop_color();
        scene.0 = next;
        // 完整场景接受点重建同代节点索引；纯视口/位置增量不重建（design D7 / 任务 7.2）。
        index.rebuild(&scene.0);
        positions.reset(&scene.0);
    }
    if let Some(viewport) = input.viewport {
        // 纯视口增量：只应用到最近 full scene 的 viewport，不重建场景几何
        // （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
        scene.0.viewport = viewport;
        flags.viewport_only = !flags.scene_received && !flags.positions_received;
    }
    if let Some(observer) = input.observer {
        crate::protocol::apply_observer(&mut scene.0, &observer);
        flags.observer_changed = !flags.scene_received;
    }
    // Taking a mutable scene reference marks it changed even when there is no input.
    if !input.positions.is_empty() {
        positions.apply(&mut scene.0, input.positions);
    }
    for (id, resource) in input.resource_states {
        if let Some(slot) = index.position(&id) {
            let node = &scene.0.nodes[slot];
            if node.texture != resource.texture || node.media_loading != resource.media_loading {
                let node = &mut scene.0.nodes[slot];
                node.texture = resource.texture;
                node.media_loading = resource.media_loading;
                flags.resource_nodes.push(slot);
            }
        }
    }
    batch.0 = input.textures;
    focus_details.0 = input.focus_details;
    model_textures.0 = input.model_textures;
    resources.0 = bridge::model_assets_snapshot();
}

fn same_viewport(current: &Option<Viewport>, next: &Option<Viewport>) -> bool {
    match (current, next) {
        (None, None) => true,
        (Some(current), Some(next)) => {
            current.physical_position == next.physical_position
                && current.physical_size == next.physical_size
                && current.depth == next.depth
        }
        _ => false,
    }
}

/// 应用 surface/DPR；必要时补发 `WindowResized`；计算本帧是否变化。
///
/// 表面可以相对窗口原点内缩（桌面顶栏）。交换链覆盖整个客户区，主相机视口对齐
/// DOM 画布；逻辑尺寸仍是画布本身，命中与投影不把顶栏算进画布。
pub(crate) fn sync_surface(
    mut flags: ResMut<FrameFlags>,
    mut surface: ResMut<SurfaceState>,
    scene: Res<CurrentScene>,
    mut windows: Query<(Entity, &mut Window), With<PrimaryWindow>>,
    mut window_resized: MessageWriter<WindowResized>,
    mut canvas_cameras: Query<
        &mut Camera,
        Or<(
            With<canvas2d::MainCanvasCamera>,
            With<crate::model3d::grid::ModelCanvasCamera>,
        )>,
    >,
) {
    let Ok((window_entity, mut window)) = windows.single_mut() else {
        flags.surface_changed = false;
        return;
    };
    let logical = if let Some(surface_size) = &scene.0.surface {
        let placed = place_native_surface(
            surface_size.origin_x,
            surface_size.origin_y,
            surface_size.width,
            surface_size.height,
            surface_size.pixel_ratio,
        );
        if window.physical_width() != placed.window_width
            || window.physical_height() != placed.window_height
            || window.scale_factor() != surface_size.pixel_ratio
        {
            window
                .resolution
                .set_scale_factor_override(Some(surface_size.pixel_ratio));
            window
                .resolution
                .set_physical_resolution(placed.window_width, placed.window_height);
            window_resized.write(WindowResized {
                window: window_entity,
                width: window.width(),
                height: window.height(),
            });
        }
        let viewport = placed.inset.then(|| Viewport {
            physical_position: UVec2::new(placed.viewport_x, placed.viewport_y),
            physical_size: UVec2::new(placed.viewport_width, placed.viewport_height),
            depth: 0.0..1.0,
        });
        for mut camera in &mut canvas_cameras {
            if !same_viewport(&camera.viewport, &viewport) {
                camera.viewport = viewport.clone();
            }
        }
        Vec2::new(placed.logical_width, placed.logical_height)
    } else {
        for mut camera in &mut canvas_cameras {
            if camera.viewport.is_some() {
                camera.viewport = None;
            }
        }
        Vec2::new(window.width(), window.height())
    };
    flags.surface_changed = surface.size != logical;
    // DPR-only 变化（同 CSS 尺寸）也必须进入文字呈现失效：`surface_changed` 只比较逻辑尺寸，
    // 因此单独记录目标 DPR（change: 2026-10-22-improve-canvas-text-clarity，design D4）。
    if surface.pixel_ratio != window.scale_factor() {
        surface.pixel_ratio = window.scale_factor();
    }
    if surface.size != logical {
        surface.size = logical;
    }
    flags.changed = flags.scene_received
        || flags.positions_received
        || flags.surface_changed
        || flags.theme_changed;
    // 相机/网格跟随：full 变化或纯视口增量。
    flags.camera_changed = flags.changed || flags.viewport_only;
}

/// 按字体 asset 可用性更新 ready outbox。
pub(crate) fn sync_ready(fonts: Res<Assets<Font>>, visuals: Res<canvas2d::CanvasOverlayCache>) {
    bridge::set_ready(canvas2d::font_ready(&fonts, &visuals));
}

/// 只在 2D scene 提交后发布 revision（空几何也发布，与既有行为一致）。
pub(crate) fn publish_rendered_revision(flags: Res<FrameFlags>, scene: Res<CurrentScene>) {
    if flags.canvas_committed {
        bridge::set_revision(scene.0.revision);
    }
    if flags.canvas_committed || flags.viewport_only || flags.observer_changed {
        crate::runtime_health::mark_applied(crate::canvas_query::interaction::current_generation());
    }
    // 实际工作计数：本帧重建了静态 2D mesh（change: 2026-10-10-optimize-canvas-interaction-hot-path）。
    if flags.mesh_rebuilt {
        bridge::note_mesh_build();
    }
    bridge::note_card_block_builds(flags.card_blocks_rebuilt);
    bridge::note_local_block_builds(flags.card_decorations_rebuilt, flags.edge_blocks_rebuilt);
}

/// 发布 shot camera 运行时诊断快照（不进入 canonical 状态）。
pub(crate) fn publish_shot_diagnostics(
    diagnostics: Res<crate::shot_camera::ShotCameraDiagnosticsOutbox>,
) {
    let value = diagnostics.0;
    bridge::set_shot_diagnostics(format!(
        "{{\"rigs\":{},\"previewImages\":{},\"gizmoEntities\":{},\"capturesInFlight\":{},\"capturesQueued\":{}}}",
        value.rigs,
        value.preview_images,
        value.gizmo_entities,
        value.captures_in_flight,
        value.captures_queued,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_observer_keeps_director_edges_aligned_with_ground_queries() {
        use crate::isometric_grid::{self, IsometricGridView};
        use bevy::camera::{CameraProjection, visibility::RenderLayers};

        let mut world = World::new();
        world.insert_resource(CurrentScene::default());
        world.insert_resource(super::super::FocusRig::default());
        world.insert_resource(FrameFlags::default());
        world.insert_resource(SurfaceState::default());
        world.insert_resource(Messages::<WindowResized>::default());
        let window = world.spawn((Window::default(), PrimaryWindow)).id();
        let observer = world.spawn((
            Camera::default(),
            crate::model3d::grid::ModelCanvasCamera,
            RenderLayers::default(),
        )).id();
        let mut schedule = Schedule::default();
        // Run both writers in their real frame order: the later observer routing
        // must preserve the viewport chosen by surface synchronization.
        schedule.add_systems((sync_surface, super::super::scene3d::drive_observer_from_shot).chain());
        let view = IsometricGridView { x: 210., y: 160., zoom: 0.75 };
        let ground = Vec2::new(120., -80.);
        let point = Vec3::new(ground.x, 0., ground.y);
        let expected = isometric_grid::screen_point_from_world(point, &view);
        // Includes moving from a Retina display to an external screen, resizing,
        // a left inset, and browser mode without any native chrome inset.
        for (left, top, width, height, dpr) in [
            (0., 26., 1600., 974., 2.),
            (0., 26., 1600., 974., 1.),
            (180., 24., 1024., 744., 1.25),
            (0., 0., 1280., 720., 1.),
        ] {
            world.resource_mut::<CurrentScene>().0.surface = Some(serde_json::from_value(
                serde_json::json!({"width":width,"height":height,"pixelRatio":dpr,"originX":left,"originY":top})
            ).unwrap());
            schedule.run(&mut world);
            let window = world.get::<Window>(window).unwrap();
            let viewport = world.get::<Camera>(observer).unwrap().viewport.as_ref();
            let position = viewport.map(|v| v.physical_position.as_vec2()).unwrap_or(Vec2::ZERO) / dpr;
            let size = viewport.map(|v| v.physical_size.as_vec2()).unwrap_or(Vec2::new(
                window.physical_width() as f32, window.physical_height() as f32,
            )) / dpr;
            let mut lens = isometric_grid::canvas_camera_projection_for_view(&view);
            lens.update(size.x, size.y);
            let pose = isometric_grid::canvas_camera_transform_for_view(Vec2::new(width, height), &view);
            let clip = lens.get_clip_from_view() * pose.to_matrix().inverse() * point.extend(1.);
            let ndc = clip.truncate() / clip.w;
            let client = position + Vec2::new(ndc.x + 1., 1. - ndc.y) * size * 0.5;
            let local = client - Vec2::new(left, top);
            assert!((local - expected).length() < 0.01,
                "rendered director edge must match CSS picking at DPR {dpr}: {local:?} != {expected:?}");
            let picked = isometric_grid::screen_to_ground(&view, local);
            assert!((picked - ground).length() < 0.05,
                "pointer on the rendered edge must recover its actual ground position");
        }
    }

    #[test]
    fn unchanged_surface_and_camera_do_not_publish_change_ticks_but_dpr_does() {
        let mut world = World::new();
        let mut scene = CurrentScene::default();
        scene.0.surface = Some(
            serde_json::from_value(serde_json::json!({
                "width":800,"height":600,"pixelRatio":1,
            }))
            .unwrap(),
        );
        world.insert_resource(scene);
        world.insert_resource(FrameFlags::default());
        world.insert_resource(SurfaceState::default());
        world.insert_resource(Messages::<WindowResized>::default());
        world.spawn((Window::default(), PrimaryWindow));
        let camera = world
            .spawn((Camera::default(), canvas2d::MainCanvasCamera))
            .id();
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_surface);
        schedule.run(&mut world);
        assert!(world.resource::<FrameFlags>().surface_changed);
        world.clear_trackers();
        schedule.run(&mut world);
        assert!(!world.resource::<FrameFlags>().surface_changed);
        assert!(
            !world
                .get_resource_ref::<SurfaceState>()
                .unwrap()
                .is_changed()
        );
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<Camera>>()
                .iter(&world)
                .count(),
            0
        );

        world
            .resource_mut::<CurrentScene>()
            .0
            .surface
            .as_mut()
            .unwrap()
            .pixel_ratio = 2.;
        schedule.run(&mut world);
        assert_eq!(world.resource::<SurfaceState>().pixel_ratio, 2.);
        assert_eq!(world.resource::<SurfaceState>().size, Vec2::new(800., 600.));
        assert!(
            !world.resource::<FrameFlags>().surface_changed,
            "DPR keeps CSS dimensions"
        );
        assert!(
            world
                .get_resource_ref::<SurfaceState>()
                .unwrap()
                .is_changed(),
            "DPR-only input still invalidates text presentation"
        );

        // The fallback window-sized surface also leaves an already-empty camera viewport alone.
        world.resource_mut::<CurrentScene>().0.surface = None;
        world.get_mut::<Camera>(camera).unwrap().viewport = Some(Viewport {
            physical_position: UVec2::ZERO,
            physical_size: UVec2::new(800, 600),
            depth: 0.0..1.0,
        });
        schedule.run(&mut world);
        assert!(world.get::<Camera>(camera).unwrap().viewport.is_none());
        world.clear_trackers();
        schedule.run(&mut world);
        assert!(
            !world
                .get_resource_ref::<SurfaceState>()
                .unwrap()
                .is_changed()
        );
        assert_eq!(
            world
                .query_filtered::<Entity, Changed<Camera>>()
                .iter(&world)
                .count(),
            0
        );
    }
}
