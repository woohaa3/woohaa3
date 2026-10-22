use bevy::{
    prelude::*,
    window::{PrimaryWindow, WindowResized},
};

use crate::{bridge, canvas2d, theme::ThemeResource};

use super::{
    CurrentScene, FilmSetTextureBatch, FrameFlags, ModelAssetTable, SurfaceState, TextureBatch,
};

/// 重置帧标记，取走最新 scene/texture batch；检测 theme-only 变化。
pub(crate) fn ingest_bridge(
    mut flags: ResMut<FrameFlags>,
    mut scene: ResMut<CurrentScene>,
    mut positions: ResMut<super::positions::PositionIndex>,
    mut theme: ResMut<ThemeResource>,
    mut batch: ResMut<TextureBatch>,
    mut focus_details: ResMut<canvas2d::focus_details::FocusDetailBatch>,
    mut film_set_batch: ResMut<FilmSetTextureBatch>,
    mut resources: ResMut<ModelAssetTable>,
    mut clear_color: ResMut<ClearColor>,
) {
    let input = bridge::take_input();
    flags.film_set_media_changed = !input.film_set_textures.is_empty();
    flags.scene_received = input.scene.is_some();
    flags.positions_received = !input.positions.is_empty();
    flags.changed = false;
    flags.canvas_committed = false;
    flags.theme_changed = false;
    flags.viewport_only = false;
    flags.observer_changed = false;
    flags.mesh_rebuilt = false;
    flags.card_blocks_rebuilt = 0;
    flags.card_decorations_rebuilt = 0;
    flags.edge_blocks_rebuilt = 0;
    flags.container_blocks_rebuilt = 0;
    if let Some(next) = input.scene {
        flags.theme_changed = next.theme.fingerprint != theme.0.fingerprint;
        theme.0 = next.theme.clone();
        clear_color.0 = theme.backdrop_color();
        scene.0 = next;
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
    positions.apply(&mut scene.0, input.positions);
    batch.0 = input.textures;
    focus_details.0 = input.focus_details;
    film_set_batch.0 = input.film_set_textures;
    resources.0 = bridge::model_assets_snapshot();
}

/// 应用 surface/DPR；必要时补发 `WindowResized`；计算本帧是否变化。
pub(crate) fn sync_surface(
    mut flags: ResMut<FrameFlags>,
    mut surface: ResMut<SurfaceState>,
    scene: Res<CurrentScene>,
    mut windows: Query<(Entity, &mut Window), With<PrimaryWindow>>,
    mut window_resized: MessageWriter<WindowResized>,
) {
    let Ok((window_entity, mut window)) = windows.single_mut() else {
        flags.surface_changed = false;
        return;
    };
    if let Some(surface_size) = &scene.0.surface {
        let width = (surface_size.width * surface_size.pixel_ratio).round() as u32;
        let height = (surface_size.height * surface_size.pixel_ratio).round() as u32;
        if window.physical_width() != width
            || window.physical_height() != height
            || window.scale_factor() != surface_size.pixel_ratio
        {
            window
                .resolution
                .set_scale_factor_override(Some(surface_size.pixel_ratio));
            window.resolution.set_physical_resolution(width, height);
            window_resized.write(WindowResized {
                window: window_entity,
                width: window.width(),
                height: window.height(),
            });
        }
    }
    let size = Vec2::new(window.width(), window.height());
    flags.surface_changed = surface.size != size;
    surface.size = size;
    flags.changed = flags.scene_received
        || flags.positions_received
        || flags.surface_changed
        || flags.theme_changed;
    // 相机/网格跟随：full 变化或纯视口增量。
    flags.camera_changed = flags.changed || flags.viewport_only;
}

/// 按字体 asset 可用性更新 ready outbox。
pub(crate) fn sync_ready(fonts: Res<Assets<Font>>, visuals: Res<canvas2d::Visuals>) {
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
    bridge::note_container_block_builds(flags.container_blocks_rebuilt);
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
