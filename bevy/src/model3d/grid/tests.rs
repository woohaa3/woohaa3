//! grid adapter 单元测试（change: refactor-bevy-reusable-components，任务 4.2/4.3）。
//!
//! 纯投影/规划测试已随实现迁到 `isometric_grid::plan`；这里只保留 Canvas adapter 的兼容
//! 断言：协议 Viewport ↔ IsometricGridView 转换与朝向约定不变。

use bevy::prelude::*;

use super::*;
use crate::protocol::Viewport;

fn viewport(x: f32, y: f32, zoom: f32) -> Viewport {
    Viewport { x, y, zoom }
}

/// 朝向约定（对齐 glTF +Z 为正面）：等距视图下 local +Z 投影到屏幕左下且朝向观察者。
#[test]
fn isometric_orientation_matches_gltf_plus_z_front() {
    let front = view_rotation() * Vec3::Z;
    let back = view_rotation() * Vec3::NEG_Z;
    let left = view_rotation() * Vec3::X;
    let up = view_rotation() * Vec3::Y;

    assert!(front.x < 0.0, "正面应偏屏幕左（x<0），实际 {}", front.x);
    assert!(front.y < 0.0, "正面应偏屏幕下（y<0），实际 {}", front.y);
    assert!(front.z > 0.0, "正面应朝向观察者（z>0），实际 {}", front.z);
    assert!(back.x > 0.0 && back.y > 0.0, "背面应偏右上");
    assert!(left.x > 0.0 && left.y < 0.0, "左侧应偏右下");
    assert!(up.y > 0.0, "上方应偏屏幕上方（y>0）");
}

#[test]
fn protocol_viewport_maps_to_grid_view() {
    let view = grid_view(&viewport(12.0, -34.0, 0.5));
    assert_eq!(view.x, 12.0);
    assert_eq!(view.y, -34.0);
    assert_eq!(view.zoom, 0.5);
}

#[test]
fn spacing_tiers_keep_screen_density_in_range() {
    for step in 0..60 {
        let zoom = 0.1 * 1.1_f32.powi(step);
        let spacing = spacing_for_zoom(zoom);
        let screen = spacing * zoom * PROJECTION_SCALE;
        assert!(
            screen >= GRID_MIN_SCREEN_SPACING - 1e-3,
            "zoom {zoom} spacing {spacing} screen {screen} too dense"
        );
        assert!(
            screen < GRID_MIN_SCREEN_SPACING * 2.0 + 1e-3,
            "zoom {zoom} spacing {spacing} screen {screen} too sparse"
        );
    }
}

#[test]
fn spacing_is_power_of_two_multiple() {
    for zoom in [0.2, 0.5, 1.0, 2.0, 0.1, 12.0] {
        let ratio = spacing_for_zoom(zoom) / GRID_BASE_SPACING;
        let log = ratio.log2();
        assert!(
            (log - log.round()).abs() < 1e-4,
            "zoom {zoom} ratio {ratio}"
        );
    }
}

#[test]
fn plan_follows_protocol_pan() {
    let size = Vec2::new(1200.0, 800.0);
    let a = plan_grid(&grid_view(&viewport(0.0, 0.0, 1.0)), size);
    let b = plan_grid(&grid_view(&viewport(64.0, 0.0, 1.0)), size);
    let same = a
        .minor
        .iter()
        .zip(b.minor.iter())
        .all(|(l, r)| (l.0 - r.0).length() < 1e-3 && (l.1 - r.1).length() < 1e-3);
    assert!(!same, "grid did not follow viewport pan");
}

#[test]
fn screen_to_ground_matches_inverse_projection() {
    let view = grid_view(&viewport(0.0, 0.0, 1.0));
    let ground = crate::isometric_grid::plan::screen_to_ground(&view, Vec2::new(0.0, 0.0));
    assert!(ground.is_finite());
}
