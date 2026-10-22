//! 通用等距网格插件的最小独立 App 测试
//! （change: refactor-bevy-reusable-components，任务 4.4 / 6.2）。

use bevy::prelude::*;
use woohaa_bevy_canvas::isometric_grid::{
    IsometricGrid, IsometricGridConfig, IsometricGridPlugin, IsometricGridTarget,
    IsometricGridStyle, IsometricGridView, plan_grid, spacing_for_zoom,
};

fn app() -> App {
    let mut app = App::new();
    app.init_resource::<Assets<Mesh>>();
    app.init_resource::<Assets<StandardMaterial>>();
    app.add_plugins(IsometricGridPlugin);
    app
}

#[test]
fn canvas_zoom_keeps_geometry_across_camera_plane() {
    use bevy::camera::CameraProjection;
    use woohaa_bevy_canvas::isometric_grid::{
        GRID_DEPTH, canvas_camera_projection, canvas_camera_transform, embed_screen_point,
    };

    let surface = Vec2::new(1200.0, 900.0);
    let camera = canvas_camera_transform(surface);
    let mut projection = canvas_camera_projection();
    projection.update(surface.x, surface.y);
    let clip_from_world = projection.get_clip_from_view() * camera.to_matrix().inverse();
    let anchor = embed_screen_point(Vec3::new(600.0, 450.0, 0.0), surface);

    // 高模型在放大时顶部越过相机平面，仍应在深度裁剪范围内。
    for zoom in [0.1, 1.0, 4.0, 12.0] {
        for height in [0.0, 100.0, 200.0] {
            let world = anchor + Vec3::Y * height * zoom;
            let clip = clip_from_world * world.extend(1.0);
            let depth = clip.z / clip.w;
            assert!(
                (0.0..=1.0).contains(&depth),
                "zoom={zoom}, height={height}, depth={depth}"
            );
        }
    }
    // 扩大近裁剪范围后，背景网格仍保留在远裁剪面以内。
    let grid = embed_screen_point(Vec3::new(600.0, 450.0, GRID_DEPTH), surface);
    let clip = clip_from_world * grid.extend(1.0);
    assert!((0.0..=1.0).contains(&(clip.z / clip.w)));
}

#[test]
fn plugin_creates_and_reuses_grid_entities() {
    let mut app = app();
    let target = app
        .world_mut()
        .spawn(IsometricGridTarget {
            view: IsometricGridView {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            surface: Vec2::new(800.0, 600.0),
            signature: String::new(),
        })
        .id();
    app.update();
    app.update();
    let count = {
        let world = app.world_mut();
        let mut q = world.query::<&IsometricGrid>();
        q.iter(world).count()
    };
    assert_eq!(count, 2, "minor + major 两条网格实体");

    // 相同 view 再 update：实体数不增长（signature 去重）。
    app.update();
    let count2 = {
        let world = app.world_mut();
        let mut q = world.query::<&IsometricGrid>();
        q.iter(world).count()
    };
    assert_eq!(count2, 2);
    let _ = target;
}

#[test]
fn plugin_rebuilds_on_view_change() {
    let mut app = app();
    let target = app
        .world_mut()
        .spawn(IsometricGridTarget {
            view: IsometricGridView {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            surface: Vec2::new(800.0, 600.0),
            signature: String::new(),
        })
        .id();
    app.update();
    app.world_mut().get_mut::<IsometricGridTarget>(target).unwrap().view.x = 64.0;
    app.update();
    let count = {
        let world = app.world_mut();
        let mut q = world.query::<&IsometricGrid>();
        q.iter(world).count()
    };
    assert_eq!(count, 2, "平移后仍只有两条网格实体（原地替换）");
}

#[test]
fn zero_surface_is_ignored() {
    let mut app = app();
    app.world_mut().spawn(IsometricGridTarget {
        view: IsometricGridView::default(),
        surface: Vec2::ZERO,
        signature: String::new(),
    });
    app.update();
    let count = {
        let world = app.world_mut();
        let mut q = world.query::<&IsometricGrid>();
        q.iter(world).count()
    };
    assert_eq!(count, 0);
}

#[test]
fn pure_plan_is_finite_for_defaults() {
    let view = IsometricGridView::default();
    let plan = plan_grid(&view, Vec2::new(800.0, 600.0));
    assert!(spacing_for_zoom(view.zoom).is_finite());
    assert!(plan.minor.iter().chain(plan.major.iter()).all(|(a, b)| a.is_finite() && b.is_finite()));
}

#[test]
fn config_default_does_not_panic_when_absent() {
    // 未显式写入 config/style 时插件使用默认值；网格仍可生成。
    let app = app();
    assert!(app.world().get_resource::<IsometricGridConfig>().is_some());
    assert!(app.world().get_resource::<IsometricGridStyle>().is_some());
}
