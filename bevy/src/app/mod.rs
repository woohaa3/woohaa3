//! Bevy App 组装与帧系统顺序。
//!
//! 运行时资源和具体系统按职责位于同目录子模块；本模块只保留应用配置与调度契约。

mod animation_preview;
mod editor_overlay;
mod focus;
mod frame_pacing;

/// JS→WASM 提交后立即唤醒停帧的渲染循环（仅 WASM 有事件循环代理）。
#[cfg(feature = "wasm")]
pub(crate) use frame_pacing::{set_enabled as set_idle_frame_pacing, wake};
mod helpers;
mod input;
mod positions;
mod scene3d;
mod setup;
mod startup_timing;
mod state;

use bevy::{asset::AssetMetaCheck, log::DEFAULT_FILTER, prelude::*, window::Window};

use crate::{canvas2d, model3d, theme::ThemeResource};

pub(crate) use input::{
    ingest_bridge, publish_rendered_revision, publish_shot_diagnostics, sync_ready, sync_surface,
};
pub(crate) use state::{
    AnimationCameraState, CurrentScene, FocusRig, FrameFlags, ModelAssetTable, ModelTextureBatch,
    NodeIndex, PreviewLayerPool, SurfaceState, TextureBatch,
};

#[cfg(feature = "wasm")]
pub(crate) fn start() {
    let mut app = App::new();
    app.insert_resource(frame_pacing::settings());
    app.add_plugins(
        DefaultPlugins
            .set(bevy::pbr::PbrPlugin {
                use_gpu_instance_buffer_builder: {
                    #[cfg(feature = "explicit-instancing")]
                    {
                        !model3d::instancing::enabled()
                    }
                    #[cfg(not(feature = "explicit-instancing"))]
                    {
                        true
                    }
                },
                ..default()
            })
            .set(WindowPlugin {
                primary_window: Some(Window {
                    title: "Bevy Flow".into(),
                    present_mode: bevy::window::PresentMode::Fifo,
                    canvas: Some("#bevy-canvas".into()),
                    fit_canvas_to_parent: true,
                    prevent_default_event_handling: false,
                    ..default()
                }),
                ..default()
            })
            .set(AssetPlugin {
                file_path: "assets".into(),
                meta_check: AssetMetaCheck::Never,
                ..default()
            })
            .set(bevy::log::LogPlugin {
                // 浏览器控制台只保留真正需要人看的信息（change: 2026-10-22-enhance-film-set-running-effects）：
                // - bevy_ecs::world::command_queue 的 WARN 在 WASM 主循环里每帧重复刷屏，会淹没真实的
                //   shader/渲染错误，对诊断无价值。压到 error。
                // - mesh_view_bindings 等模块缺失、shader 编译失败这类问题只在 WARN/ERROR 出现，
                //   因此不能整体降级 `level`；只按 target 静音已知噪音。
                filter: format!("{DEFAULT_FILTER}bevy_ecs::world::command_queue=error,"),
                ..default()
            }),
    );
    configure_canvas(&mut app);
    // 静止降频（change: 2026-10-28 draw call 优化）：静态画布不再按 120 FPS 重画同一张画面。
    app.init_resource::<frame_pacing::PacingState>()
        .add_systems(Startup, frame_pacing::install_wake)
        .add_systems(Last, frame_pacing::sync_pacing);
    app.run();
}

#[cfg(feature = "native-canvas")]
pub fn build_native_canvas_app(
    window: Window,
    handle: bevy::window::RawHandleWrapper,
    assets: String,
) -> App {
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                primary_window: Some(window),
                exit_condition: bevy::window::ExitCondition::DontExit,
                close_when_requested: false,
                ..default()
            })
            .set(AssetPlugin {
                file_path: assets,
                meta_check: AssetMetaCheck::Never,
                ..default()
            })
            .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>(),
    );
    let entity = app
        .world_mut()
        .query_filtered::<Entity, With<bevy::window::PrimaryWindow>>()
        .single(app.world())
        .expect("primary window");
    app.world_mut().entity_mut(entity).insert(handle);
    configure_canvas(&mut app);
    app
}

fn configure_canvas(app: &mut App) {
    app.init_resource::<startup_timing::StartupTiming>()
        .add_systems(First, startup_timing::begin)
        .add_systems(Last, startup_timing::end)
        .insert_resource(ClearColor(ThemeResource::default().backdrop_color()))
        .init_resource::<CurrentScene>()
        .init_resource::<positions::PositionIndex>()
        .init_resource::<TextureBatch>()
        .init_resource::<ModelTextureBatch>()
        .init_resource::<canvas2d::focus_details::FocusDetailBatch>()
        .init_resource::<canvas2d::focus_details::FocusDetailVisuals>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<NodeIndex>()
        .init_resource::<crate::canvas_ecs::CanvasProjectionState>()
        .init_resource::<canvas2d::LabelRequests>()
        .init_resource::<crate::canvas_ecs::SelectionOutlineBatch>()
        .init_resource::<crate::canvas_ecs::SelectionOutlineLayer>()
        .init_resource::<crate::app::PreviewLayerPool>()
        .init_resource::<SurfaceState>()
        .init_resource::<FrameFlags>()
        .init_resource::<FocusRig>()
        .init_resource::<AnimationCameraState>()
        .init_resource::<ThemeResource>()
        .init_resource::<canvas2d::GenerationClock>()
        .init_resource::<canvas2d::text_presentation::PresentationCache>()
        .add_plugins(crate::runtime_health::RuntimeHealthPlugin)
        .add_plugins(crate::shot_camera::ShotCameraPlugin)
        .add_plugins(crate::model_preview::ModelPreviewPlugin)
        .add_plugins(crate::history_preview::HistoryThumbnailPlugin)
        .add_plugins(crate::isometric_grid::IsometricGridPlugin)
        .add_plugins(crate::orbit_camera::OrbitCameraPlugin)
        .add_plugins(crate::transform_gizmo::TransformGizmoPlugin)
        .configure_sets(
            Update,
            model3d::TransformAnimationSet::Playback
                .before(model3d::TransformAnimationSet::Evaluate),
        )
        .add_systems(
            Startup,
            (setup::setup_2d, setup::setup_3d, editor_overlay::setup).chain(),
        )
        // 此顺序是同帧渲染语义：输入 -> surface -> ready -> 纹理 -> views -> scene -> revision。
        // 21 个系统超过元组上限，因此按「场景派生」与「发布」两段各自 chain 后再串联，
        // 语义仍是全序（chain 会在相邻系统间插入 ApplyDeferred）。
        .add_systems(
            Update,
            (
                (
                    (
                        (
                            ingest_bridge,
                            crate::canvas_ecs::project_canvas_nodes
                                .run_if(crate::canvas_ecs::projection_requested),
                            bevy::ecs::schedule::ApplyDeferred,
                        )
                            .chain(),
                        sync_surface,
                        sync_ready,
                        canvas2d::sync_textures,
                        // GLB 内嵌纹理 → 共享 Image（先于模型 spawn）。
                        model3d::model_textures::sync_model_textures,
                        canvas2d::sync_camera,
                        focus::sync_focus,
                        scene3d::sync_grid.before(crate::isometric_grid::IsometricGridSet::Style),
                        scene3d::sync_scene_areas,
                        // 门禁结算（含 hover stop/reset/start）与模型 spawn 同一系统，且在动画求值前
                        // 完成（change: play-model-animations-on-hover，design D4）。
                        scene3d::sync_models.in_set(model3d::TransformAnimationSet::Playback),
                        // 页面内历史缩略图：同一 App 内一次性离屏渲染，排在模型根同步之后
                        // （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
                        crate::history_preview::sync,
                        crate::model_preview::sync,
                        scene3d::sync_editor_gizmo,
                        scene3d::sync_shot_main_view,
                    )
                        .chain(),
                    // ECS 画布帧（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs）：
                    // presentation → 分类型几何 → 选中描边批次 → 标签/文字。每个 set 边界都会
                    // 应用 deferred，producer 当帧即可读到投影实体与展示子实体。
                    (
                        (
                            canvas2d::produce_card_geometry,
                            canvas2d::produce_card_hover,
                            canvas2d::produce_edges,
                            canvas2d::sync_canvas_overlay,
                        )
                            .chain()
                            .in_set(crate::canvas_ecs::CanvasRenderSet::Geometry),
                        (
                            canvas2d::begin_selection_outlines,
                            canvas2d::produce_card_selection,
                            crate::canvas_ecs::flush_selection_outlines,
                        )
                            .chain()
                            .in_set(crate::canvas_ecs::CanvasRenderSet::Selection)
                            .run_if(canvas2d::canvas_render_requested),
                        (
                            canvas2d::sync_canvas_labels,
                            canvas2d::focus_details::sync,
                        )
                            .chain()
                            .in_set(crate::canvas_ecs::CanvasRenderSet::Labels),
                    )
                        .chain(),
                    (canvas2d::sync_generation, canvas2d::history_pulse::sync).chain(),
                    canvas2d::sync_attach_probe,
                )
                    .chain(),
                (publish_rendered_revision, publish_shot_diagnostics).chain(),
            )
                .chain(),
        )
        // 顶部操作横条覆盖层（change: 2026-10-13-add-node-to-film-set-shortcut）：独立小 mesh +
        // 独立标签池，逐帧读场景重建；排在画布几何之后，不参与主场景 chain 的元组上限。
        .add_systems(
            Update,
            (
                canvas2d::sync_node_action_bars,
                canvas2d::sync_focus_backdrop,
            )
                .after(crate::canvas_ecs::CanvasRenderSet::Geometry),
        )
        // 画布文字栅格呈现（change: 2026-10-22-improve-canvas-text-clarity，design D4）：
        // 必须排在**全部**标签生产者与 deferred 命令应用之后，Bevy 的文字布局在 PostUpdate
        // 执行，因此这里处于同帧「标签已就绪、字体尚未栅格化」的唯一窗口。显式应用 deferred，
        // 保证新建实体（`commands.spawn`）在本帧就带上正确档位，而不是下一个可呈现帧。
        .add_systems(
            Update,
            (
                bevy::ecs::schedule::ApplyDeferred,
                canvas2d::text_presentation::sync,
            )
                .chain()
                .after(canvas2d::sync_node_action_bars)
                .after(canvas2d::sync_attach_probe)
                .after(canvas2d::sync_generation)
                .after(crate::canvas_ecs::CanvasRenderSet::Labels),
        )
        // 动画求值在门禁结算之后（同帧 Playback.before(Evaluate)），且不在 scene chain 内：
        // hover 持续播放期间不要求重新序列化场景（change: play-model-animations-on-hover，D4）。
        .add_systems(
            Update,
            crate::transform_animation::animate_transforms
                .in_set(model3d::TransformAnimationSet::Evaluate),
        )
        .add_systems(
            PostUpdate,
            (
                scene3d::publish_model_poses.after(bevy::transform::TransformSystems::Propagate),
                animation_preview::apply_sampled_camera
                    .after(crate::shot_camera::ShotCameraSet::Derive)
                    .before(crate::shot_camera::ShotCameraSet::Preview),
                // 路由排在 capture 提交前：同一帧里把请求送进队列并建立离屏相机，
                // 否则每帧截图都要多等一帧（change: 2026-10-15，任务 8.10）。
                model3d::capture::route_capture_request
                    .after(crate::shot_camera::ShotCameraSet::Derive)
                    .before(crate::shot_camera::ShotCameraSet::Capture),
                model3d::capture::publish_capture_results
                    .after(crate::shot_camera::ShotCameraSet::Capture),
                scene3d::hide_shot_gizmos_during_transition
                    .after(crate::shot_camera::ShotCameraSet::Gizmo),
                scene3d::drive_observer_from_shot
                    .after(crate::shot_camera::ShotCameraSet::Preview)
                    .after(crate::orbit_camera::sync_orbit_rigs)
                    .before(model3d::capture::sync_capture_chrome),
                editor_overlay::sync
                    .after(scene3d::drive_observer_from_shot)
                    .before(bevy::transform::TransformSystems::Propagate),
                model3d::capture::sync_capture_chrome
                    .after(scene3d::hide_shot_gizmos_during_transition),
            ),
        );
}
