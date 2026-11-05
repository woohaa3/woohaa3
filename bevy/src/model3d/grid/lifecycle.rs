//! 网格 Canvas adapter：模型工作区 ↔ 通用 `IsometricGridPlugin`
//! （change: refactor-bevy-reusable-components，任务 4.2/4.3 / design D2）。
//!
//! 纯投影/规划与 mesh/material 生命周期已迁到协议无关的 [`crate::isometric_grid`]。本模块只
//! 保留 model3d 侧的**适配**：3D 相机/灯光 setup、`ModelCanvasCamera` 标记，以及把 Canvas
//! `Scene`/`ThemeResource`/viewport 投影为通用插件的 config/style/target。网格实体本身由
//! `IsometricGridPlugin` 拥有与回收。

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;
use bevy::render::view::{DebandDither, Tonemapping};

use crate::isometric_grid::{
    IsometricGridConfig, IsometricGridStyle, IsometricGridTarget, canvas_camera_projection,
};
use crate::protocol::Scene;
use crate::theme::ThemeResource;

/// 主画布使用的 3D 相机。截图/预览相机不得参与聚焦与网格相机同步。
#[derive(Component)]
pub(crate) struct ModelCanvasCamera;

/// 网格 line 实体标记（截图时隐藏 chrome 用）。
#[derive(Component)]
pub(crate) struct ModelGrid;

/// 3D 相机与灯光 setup；返回主观察相机实体（供 adapter 绑定 orbit rig）。
pub(crate) fn setup_camera(commands: &mut Commands) -> Entity {
    let camera = commands
        .spawn((
            Camera3d::default(),
            ModelCanvasCamera,
            RenderLayers::from_layers(&[0, crate::preview_layers::WORLD_CAMERA_GIZMO_LAYER]),
            Projection::Orthographic(canvas_camera_projection()),
            crate::isometric_grid::canvas_camera_transform(Vec2::ZERO),
            Tonemapping::None,
            DebandDither::Disabled,
        ))
        .id();
    commands.insert_resource(GlobalAmbientLight {
        color: Color::WHITE,
        brightness: 600.0,
        ..default()
    });
    commands.spawn((
        DirectionalLight {
            color: Color::srgb_u8(255, 245, 223),
            illuminance: 4_000.0,
            shadow_maps_enabled: false,
            ..default()
        },
        Transform {
            translation: Vec3::new(180.0, 260.0, 300.0),
            rotation: crate::isometric_grid::canvas_camera_rotation(),
            scale: Vec3::ONE,
        },
        // 灯光也覆盖截图层（7）：preview/capture 相机只渲染该层，否则模型在预览里不被照亮。
        model_light_layers(),
    ));
    camera
}

/// 3D 灯光覆盖的渲染层：主画布层 + 截图层，保证离屏 preview/capture 也能被照亮。
fn model_light_layers() -> RenderLayers {
    #[cfg(feature = "canvas-core")]
    {
        RenderLayers::from_layers(&[0, crate::model3d::capture::CAPTURE_LAYER])
    }
    #[cfg(not(feature = "canvas-core"))]
    {
        RenderLayers::layer(0)
    }
}

/// 网格可见层：主画布 3D 层（0），排除 editor layer 与截图层。
fn grid_layers() -> RenderLayers {
    RenderLayers::layer(0)
}

/// 初始化 Canvas adapter：写入网格 target/config，并挂上 grid line 标记实体。
pub(crate) fn setup(commands: &mut Commands, theme: &ThemeResource) {
    commands.insert_resource(IsometricGridConfig {
        layers: grid_layers(),
        ..Default::default()
    });
    commands.insert_resource(grid_style(theme));
    commands.spawn((ModelGrid, IsometricGridTarget::default()));
}

/// 由主题解析网格颜色样式（唯一读取 ThemeResource 的位置，属 adapter 职责）。
fn grid_style(theme: &ThemeResource) -> IsometricGridStyle {
    IsometricGridStyle {
        minor: theme.token_color("gridMinor"),
        major: theme.token_color("gridMajor"),
        fingerprint: fingerprint(theme),
    }
}

/// 主题指纹（与 `ThemeResource::fingerprint` 一致）。
fn fingerprint(theme: &ThemeResource) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    theme.fingerprint().hash(&mut hasher);
    hasher.finish()
}

/// 把 scene viewport/surface 写入网格 target（宿主在变化帧调用）。
pub(crate) fn sync_target(scene: &Scene, surface: Vec2, target: &mut IsometricGridTarget) {
    let view = crate::model3d::grid::scene_view(scene);
    let signature = format!(
        "{:.3}:{:.3}:{:.3}:{:.2}:{:.2}",
        view.x, view.y, view.zoom, surface.x, surface.y
    );
    if target.signature == signature {
        return;
    }
    target.signature = signature;
    target.view = view;
    target.surface = surface;
}

/// theme 变化时刷新网格样式（由 `IsometricGridPlugin` 应用颜色）。
pub(crate) fn sync_theme(theme: &ThemeResource, style: &mut IsometricGridStyle) {
    let next = grid_style(theme);
    if style.fingerprint != next.fingerprint {
        *style = next;
    }
}

/// 3D 相机跟随 viewport（pan/zoom 由相机承担，正交 scale=1/zoom；design D3）。
pub(crate) fn sync_camera(
    size: Vec2,
    view: &crate::isometric_grid::IsometricGridView,
    camera: &mut Query<(&mut Transform, &mut Projection), With<ModelCanvasCamera>>,
) {
    if let Ok((mut transform, mut projection)) = camera.single_mut() {
        *transform = crate::isometric_grid::canvas_camera_transform_for_view(size, view);
        if let Projection::Orthographic(ortho) = &mut *projection {
            let zoom = if view.zoom.is_finite() && view.zoom > 0.0 {
                view.zoom
            } else {
                1.0
            };
            ortho.scale = 1.0 / zoom;
        }
    }
}
