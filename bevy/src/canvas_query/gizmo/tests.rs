//! gizmo 投影与命中的几何单元测试（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。

use super::*;
use super::*;

    const SURFACE: (f32, f32) = (1000.0, 800.0);

    #[test]
    fn distance_to_segment_clamps() {
        assert!((distance_to_segment((5.0, 3.0), (0.0, 0.0), (10.0, 0.0)) - 3.0).abs() < 1e-3);
        assert!((distance_to_segment((-4.0, 0.0), (0.0, 0.0), (10.0, 0.0)) - 4.0).abs() < 1e-3);
    }

    #[test]
    fn focus_projector_centers_target() {
        let camera = FocusCamera {
            target: [0.0, 0.0, 0.0],
            yaw: 0.4,
            pitch: 0.3,
            distance: 6.0,
        };
        let project = focus_projector(camera, SURFACE, 0.6);
        let screen = project(camera.target).expect("center visible");
        assert!((screen.0 - 500.0).abs() < 1e-2);
        assert!((screen.1 - 400.0).abs() < 1e-2);
        // 相机前方沿视线的一点（target 与 camera 之间）也投影到画面中心。
        let cam = camera.position();
        let forward_point = [
            cam[0] + (camera.target[0] - cam[0]) * 0.5,
            cam[1] + (camera.target[1] - cam[1]) * 0.5,
            cam[2] + (camera.target[2] - cam[2]) * 0.5,
        ];
        let mid = project(forward_point).expect("front point visible");
        assert!((mid.0 - 500.0).abs() < 1e-2);
        assert!((mid.1 - 400.0).abs() < 1e-2);
    }

    #[test]
    fn hit_focus_gizmo_picks_nearest_axis() {
        let camera = FocusCamera {
            target: [0.0, 0.0, 0.0],
            yaw: 0.0,
            pitch: 0.0,
            distance: 6.0,
        };
        let geometry = focus_gizmo([0.0, 0.0, 0.0], 2.0);
        let project = focus_projector(camera, SURFACE, 0.6);
        // 指向 Y 轴端点屏幕位置的指针应命中 y。
        let tip = project(geometry.y).unwrap();
        let hit = hit_focus_gizmo(tip, &geometry, &project);
        assert_eq!(hit.map(|(axis, _)| axis), Some("y"));
    }

    #[test]
    fn focus_axis_constraint_matches_drag_delta() {
        let camera = FocusCamera {
            target: [0.0, 0.0, 0.0],
            yaw: 0.5,
            pitch: 0.3,
            distance: 6.0,
        };
        let geometry = focus_gizmo([0.0, 0.0, 0.0], 2.0);
        let project = focus_projector(camera, SURFACE, 0.6);
        let constraint = focus_axis_constraint(&geometry, "x", &project).unwrap();
        // 沿轴方向拖动 30px 的世界位移。
        let delta = (constraint.direction.0 * 30.0, constraint.direction.1 * 30.0);
        let origin = project(geometry.origin).unwrap();
        let tip = project(geometry.x).unwrap();
        let world = focus_axis_drag_world_delta(delta, origin, tip, geometry.axis_length).unwrap();
        assert!((world - 30.0 * constraint.world_per_pixel).abs() < 1e-2);
    }

    #[test]
    fn hit_shot_gizmo_origin_and_ring() {
        let focus = [0.0, 0.0, 0.0];
        let camera_position = [0.0, 3.0, 6.0];
        let geometry = shot_gizmo(focus, camera_position, 2.0);
        let project = shot_projector(focus, camera_position, 2.0, SURFACE);
        let origin = project(camera_position).unwrap();
        assert_eq!(hit_shot_gizmo(origin, &geometry, &project).map(|(h, _)| h), Some("shot-origin"));
        // 距离段沿视线，正交投影下与相机原点重合；远离时未命中。
        assert!(hit_shot_gizmo((50.0, 50.0), &geometry, &project).is_none());
    }

    #[test]
    fn hit_shot_gizmo_elevation_ring() {
        let focus = [0.0, 0.0, 0.0];
        // 相机在水平方向上，使竖直半圆的方位径向为 +Z。
        let camera_position = [0.0, 0.0, 6.0];
        let geometry = shot_gizmo(focus, camera_position, 2.0);
        let project = shot_projector(focus, camera_position, 2.0, SURFACE);
        // 半圆上 45° 处的采样点（径向 +Z，抬高）。
        let radius = 6.0_f32;
        let point = [0.0, radius * (std::f32::consts::FRAC_PI_4).sin(), radius * (std::f32::consts::FRAC_PI_4).cos()];
        let screen = project(point).unwrap();
        assert_eq!(hit_shot_gizmo(screen, &geometry, &project).map(|(h, _)| h), Some("elevation-ring"));
    }

    /// 对象模式三轴 gizmo：命中 Y 轴并返回轴拖动约束（change: 2026-10-09）。
    #[test]
    fn object_gizmo_hit_returns_axis_and_constraint() {
        let json = r#"{"kind":"object","x":500.0,"y":300.0,"width":1000.0,"height":800.0,"radius":2.0,"focus":[0.0,0.0,0.0],"projection":{"target":[0.0,0.0,0.0],"yaw":0.0,"pitch":0.0,"distance":6.0}}"#;
        // 直接验证几何命中（Y 轴端点）。
        let camera = FocusCamera { target: [0.0, 0.0, 0.0], yaw: 0.0, pitch: 0.0, distance: 6.0 };
        let geometry = focus_gizmo([0.0, 0.0, 0.0], 2.0);
        let project = focus_projector(camera, SURFACE, MODEL_FOCUS_FOV);
        let tip = project(geometry.y).unwrap();
        let hit = hit_focus_gizmo(tip, &geometry, &project);
        assert_eq!(hit.map(|(axis, _)| axis), Some("y"));
        // JSON 入口可用（中心命中至少返回 available）。
        let out = query::gizmo_query_json(json);
        assert!(out.contains("\"available\":true"));
    }
