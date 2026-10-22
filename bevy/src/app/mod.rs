//! Bevy App 组装与帧系统顺序。
//!
//! 运行时资源和具体系统按职责位于同目录子模块；本模块只保留应用配置与调度契约。

mod animation_preview;
mod editor_overlay;
mod focus;
#[cfg(feature = "wasm")]
mod frame_pacing;
mod helpers;
mod input;
mod positions;
mod scene3d;
mod setup;
mod startup_timing;
mod state;

use bevy::{asset::AssetMetaCheck, prelude::*, window::Window};

use crate::{canvas2d, model3d, theme::ThemeResource};

pub(crate) use input::{
    ingest_bridge, publish_rendered_revision, publish_shot_diagnostics, sync_ready, sync_surface,
};
pub(crate) use state::{
    AnimationCameraState, CurrentScene, FilmSetTextureBatch, FocusRig, FrameFlags, ModelAssetTable,
    SurfaceState, TextureBatch,
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
            }),
    );
    configure_canvas(&mut app);
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
        .init_resource::<canvas2d::focus_details::FocusDetailBatch>()
        .init_resource::<canvas2d::focus_details::FocusDetailVisuals>()
        .init_resource::<FilmSetTextureBatch>()
        .init_resource::<model3d::film_set_media::FilmSetMediaVisuals>()
        .init_resource::<ModelAssetTable>()
        .init_resource::<SurfaceState>()
        .init_resource::<FrameFlags>()
        .init_resource::<FocusRig>()
        .init_resource::<AnimationCameraState>()
        .init_resource::<model3d::filmset_camera::FilmSetCameraAssets>()
        .init_resource::<model3d::filmset_camera::FilmSetCameraVisual>()
        .init_resource::<ThemeResource>()
        .init_resource::<canvas2d::GenerationClock>()
        .init_resource::<canvas2d::text_presentation::PresentationCache>()
        .add_plugins(crate::runtime_health::RuntimeHealthPlugin)
        .add_plugins(crate::shot_camera::ShotCameraPlugin)
        .add_plugins(crate::model_preview::ModelPreviewPlugin)
        .add_plugins(crate::shot_node_preview::ShotNodePreviewPlugin)
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
                    ingest_bridge,
                    sync_surface,
                    sync_ready,
                    canvas2d::sync_textures,
                    model3d::film_set_media::sync_film_set_planes,
                    model3d::film_set_media::sync_film_set_textures,
                    canvas2d::sync_camera,
                    focus::sync_focus,
                    scene3d::sync_grid.before(crate::isometric_grid::IsometricGridSet::Style),
                    // 门禁结算（含 hover stop/reset/start）与模型 spawn 同一系统，且在动画求值前
                    // 完成（change: play-model-animations-on-hover，design D4）。
                    scene3d::sync_models.in_set(model3d::TransformAnimationSet::Playback),
                    // Native 片场后台准备：非阻塞 poll + 全局预算装配，排在消费者之前
                    // （change: 2026-10-18-prepare-native-film-sets-in-background，design D4/D5）。
                    scene3d::advance_preparation,
                    crate::model_preview::sync,
                    // 卡片预览：消费同一帧的采样镜头/播放投影，并在模型落位后并入卡片渲染层
                    // （change: 2026-10-15-add-film-set-shooting-shot-previews，design D7）。
                    crate::shot_node_preview::sync,
                    scene3d::sync_editor_gizmo,
                    scene3d::sync_shot_adapter,
                    scene3d::reclaim_extra_shot_rigs,
                    scene3d::sync_shot_main_view,
                    (canvas2d::sync_scene, canvas2d::focus_details::sync).chain(),
                    (canvas2d::sync_generation, canvas2d::history_pulse::sync).chain(),
                    canvas2d::sync_attach_probe,
                )
                    .chain(),
                (publish_rendered_revision, publish_shot_diagnostics).chain(),
            )
                .chain(),
        )
        // 顶部操作横条覆盖层（change: 2026-10-13-add-node-to-film-set-shortcut）：独立小 mesh +
        // 独立标签池，逐帧读场景重建；排在 `sync_scene` 之后，不参与主场景 chain 的元组上限。
        .add_systems(
            Update,
            (
                canvas2d::sync_node_action_bars,
                canvas2d::sync_focus_backdrop,
                canvas2d::sync_group_motion,
            )
                .after(canvas2d::sync_scene),
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
                .after(canvas2d::sync_scene),
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
                animation_preview::apply_sampled_camera
                    .after(crate::shot_camera::ShotCameraSet::Derive)
                    .before(crate::shot_camera::ShotCameraSet::Preview),
                // 片场 overview 播放小相机：消费同一采样镜头，独立辅助层，不影响成片输出
                // （change: 2026-10-13-add-film-set-hover-camera-entity，任务 2.2）。
                animation_preview::sync_film_set_camera
                    .after(animation_preview::apply_sampled_camera),
                // 路由排在 capture 提交前：同一帧里把请求送进队列并建立离屏相机，
                // 否则每帧截图都要多等一帧（change: 2026-10-15，任务 8.10）。
                model3d::capture::route_capture_request
                    .after(crate::shot_camera::ShotCameraSet::Derive)
                    .before(crate::shot_camera::ShotCameraSet::Capture),
                model3d::capture::publish_capture_results
                    .after(crate::shot_camera::ShotCameraSet::Capture),
                scene3d::hide_shot_gizmos_during_transition
                    .after(crate::shot_camera::ShotCameraSet::Capture),
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
