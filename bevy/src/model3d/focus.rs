//! 模型聚焦查看的相机数学与可见性
//! （change: add-model-focus-viewing，任务 2.1 / 2.2 / 2.3；design D2/D3）。
//!
//! 与 Web `model-focus.ts` 共享同一 yaw/pitch/distance 公式、FOV 与取景规则；本模块只拥有
//! 相机 pose 计算与可见性判定，不拥有规范状态、不写 Y.Doc。

use bevy::prelude::*;

use crate::protocol::ModelFocus;

/// 与 Web `MODEL_FOCUS_FOV` 默认一致的垂直 FOV，仅用于 payload 缺失 fov 时无；
/// 实际使用 payload 携带的 fov（Web 已算好）。
pub(crate) const FOCUS_NEAR: f32 = 0.05;
pub(crate) const FOCUS_FAR: f32 = 200_000.0;

/// 主观察 orbit rig 的 distance 边界（与 Web `MODEL_FOCUS_MIN/MAX_DISTANCE` 一致）。
pub(crate) const FOCUS_OBSERVER_MIN_DISTANCE: f32 = 0.4;
pub(crate) const FOCUS_OBSERVER_MAX_DISTANCE: f32 = 10_000_000.0;

/// 聚焦相机的位置：`target + R(yaw,pitch) * (0, 0, distance)`。
pub(crate) fn focus_camera_position(focus: &ModelFocus) -> Vec3 {
    let cp = focus.pitch.cos();
    let dir = Vec3::new(
        focus.yaw.sin() * cp,
        -focus.pitch.sin(),
        focus.yaw.cos() * cp,
    );
    Vec3::from_array(focus.target) + dir * focus.distance
}

/// 聚焦相机朝向：看向 target（-Z 指向前方）。
pub(crate) fn focus_camera_rotation(focus: &ModelFocus) -> Quat {
    let position = focus_camera_position(focus);
    let target = Vec3::from_array(focus.target);
    let forward = (target - position).normalize_or_zero();
    if forward == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    Transform::from_translation(position)
        .looking_at(target, Vec3::Y)
        .rotation
}

/// 聚焦相机的完整 Transform + 透视投影。
pub(crate) fn focus_camera_transform(focus: &ModelFocus) -> Transform {
    Transform {
        translation: focus_camera_position(focus),
        rotation: focus_camera_rotation(focus),
        scale: Vec3::ONE,
    }
}

/// 该节点是否应为聚焦目标（可见）；非聚焦时全部可见。
///
/// 仅用于聚焦可见性 golden 测试；生产可见性由 shader/visibility 直接表达。
#[cfg(test)]
pub(crate) fn is_node_visible(focus: Option<&ModelFocus>, node_id: &str) -> bool {
    match focus {
        Some(focus) => focus.node_id == node_id,
        None => true,
    }
}

/// 该节点是否应被排除（隐藏）。等价于 `!is_node_visible` 但显式表达意图。
#[cfg(test)]
pub(crate) fn is_node_hidden(focus: Option<&ModelFocus>, node_id: &str) -> bool {
    !is_node_visible(focus, node_id)
}

/// 聚焦进入/退出过渡时长（秒）；与参考实现 `xyflow-bevy` 一致。
pub(crate) const FOCUS_TRANSITION_SECS: f32 = 0.42;

/// 进入聚焦过渡的**起点姿态**：沿聚焦相机视线方向、但比目标距离更远的位置。
///
/// 为什么不能直接用普通正交相机姿态作为起点（design D5 修订）：普通画布是**正交**相机，
/// 且等距视角旋转烘焙在**模型 transform**里；若从正交 home 的姿态 slerp 到聚焦姿态，
/// 相机会绕目标转过一个大角度，整个画面看起来「往左飞、模型从右侧飞入」，而不是「推近模型」。
///
/// 因此进入时相机**朝向立即切到聚焦方向**（与目标同 rotation），只把距离从
/// `home_distance` 插值到聚焦距离 —— 表现为原地推近。`home_distance` 取「可见世界高度
/// `surface_height / zoom` 下 1 世界单位 ≈ 1 CSS 像素」的透视等效距离
/// `surface_height / (2 * zoom * tan(fov/2))`，使过渡首帧的观感尺寸接近正交画面
/// （change: make-shot-framing-zoom-invariant，design D5）。
///
/// 当前过渡起点由 `camera_transition` 从实时姿态派生；本函数保留为 golden 对照。
#[cfg(test)]
pub(crate) fn focus_enter_start(focus: &ModelFocus, surface_height: f32, zoom: f32) -> Transform {
    let target = focus_camera_transform(focus);
    let half = (focus.fov / 2.0).tan();
    let height = if surface_height.is_finite() && surface_height > 1.0 {
        surface_height
    } else {
        1.0
    };
    let zoom = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    let home_distance = (height / (2.0 * zoom * half)).max(focus.distance);
    // 视线方向：从目标指向相机的单位向量（聚焦姿态已含朝向）。
    let dir = (target.translation - Vec3::from_array(focus.target)).normalize_or_zero();
    let start_translation = if dir == Vec3::ZERO {
        target.translation
    } else {
        Vec3::from_array(focus.target) + dir * home_distance
    };
    Transform {
        translation: start_translation,
        rotation: target.rotation,
        scale: Vec3::ONE,
    }
}

/// 普通正交画布相机 home 姿态（与 `grid::sync_camera` 一致：viewport 平移/缩放、等距朝向）。
///
/// `surface` 为当前画布 CSS 尺寸；`viewport` 为需恢复的 pan/zoom。缺失 surface 时回退原点。
pub(crate) fn home_camera_transform(
    surface: Option<(f32, f32)>,
    viewport: &crate::isometric_grid::IsometricGridView,
) -> Transform {
    let size = match surface {
        Some((width, height)) => Vec2::new(width, height),
        None => Vec2::ZERO,
    };
    crate::isometric_grid::canvas_camera_transform_for_view(size, viewport)
}

/// 协议 `ModelFocus` → 通用 orbit adapter 的 target/pose/lens
/// （change: refactor-bevy-reusable-components，任务 3.4 / design D1）。
///
/// Godot/Web 聚焦相机约定 `dir = (sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch))`；
/// orbit 约定 `dir = (sin(yaw)cos(pitch), +sin(pitch), cos(yaw)cos(pitch))`。两者仅在 pitch
/// 符号上不同，故 `orbit.yaw = yaw`、`orbit.pitch = -pitch`、`orbit.distance = distance`、
/// `target.point = focus.target` 时**逐位等价**。透视 lens 使用有效 fov（非法时回退默认）。
pub(crate) fn focus_to_orbit(
    focus: &ModelFocus,
) -> (
    crate::orbit_camera::OrbitCameraTarget,
    crate::orbit_camera::OrbitCameraPose,
    crate::orbit_camera::OrbitCameraLens,
) {
    use crate::orbit_camera::{
        ORBIT_DEFAULT_FOV, OrbitCameraLens, OrbitCameraPose, OrbitCameraTarget,
    };
    let fov = if focus.fov.is_finite() && focus.fov > 0.0 {
        focus.fov
    } else {
        ORBIT_DEFAULT_FOV
    };
    (
        OrbitCameraTarget {
            point: Vec3::from_array(focus.target),
        },
        OrbitCameraPose {
            yaw: focus.yaw,
            pitch: -focus.pitch,
            distance: focus.distance,
            pan: Vec3::ZERO,
        },
        OrbitCameraLens {
            projection: crate::orbit_camera::OrbitProjection::Perspective { fov },
            near: FOCUS_NEAR,
            far: FOCUS_FAR,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn focus(yaw: f32, pitch: f32, distance: f32) -> ModelFocus {
        ModelFocus {
            version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
            node_id: "n1".to_owned(),
            target: [0.0, 1.0, 0.0],
            yaw,
            pitch,
            distance,
            fov: 0.87,
            radius: 2.0,
        }
    }

    #[test]
    fn camera_position_matches_yaw_pitch_distance() {
        let position = focus_camera_position(&focus(0.0, 0.0, 10.0));
        assert!((position.x).abs() < 1e-5);
        assert!((position.y - 1.0).abs() < 1e-5);
        assert!((position.z - 10.0).abs() < 1e-5);
    }

    #[test]
    fn camera_rotation_looks_toward_target() {
        let f = focus(0.3, -0.4, 8.0);
        let rotation = focus_camera_rotation(&f);
        let forward = rotation * Vec3::NEG_Z;
        let expected = (Vec3::from_array(f.target) - focus_camera_position(&f)).normalize();
        assert!(forward.abs_diff_eq(expected, 1e-4));
    }

    #[test]
    fn visibility_isolates_target_only() {
        let f = focus(0.0, 0.0, 5.0);
        assert!(is_node_visible(Some(&f), "n1"));
        assert!(!is_node_visible(Some(&f), "n2"));
        assert!(is_node_hidden(Some(&f), "n2"));
        // 非聚焦：全部可见。
        assert!(is_node_visible(None, "anything"));
        assert!(!is_node_hidden(None, "anything"));
    }

    #[test]
    fn camera_transform_is_finite() {
        let transform = focus_camera_transform(&focus(1.2, -1.0, 42.0));
        assert!(transform.translation.is_finite());
        assert!(transform.rotation.is_finite());
    }

    
    #[test]
    fn focus_enter_start_keeps_focus_rotation_and_dollies_in() {
        // 进入起点：与聚焦目标同朝向（避免旋转摆动），但距离更远（先看到更大范围）。
        let f = focus(0.0, -0.35, 8.0);
        let target = focus_camera_transform(&f);
        let start = focus_enter_start(&f, 900.0, 1.0);
        // 朝向一致（否则会「画面往左飞」）。
        assert!(start.rotation.abs_diff_eq(target.rotation, 1e-6));
        // 起点比目标更远，且位于 target 到相机的同一射线上。
        let to_start = (start.translation - Vec3::from_array(f.target)).normalize_or_zero();
        let to_target = (target.translation - Vec3::from_array(f.target)).normalize_or_zero();
        assert!(to_start.abs_diff_eq(to_target, 1e-4));
        let start_dist = (start.translation - Vec3::from_array(f.target)).length();
        assert!(start_dist > f.distance);
    }

    #[test]
    fn focus_enter_start_scales_with_zoom() {
        // 可见世界高度 = surface_height / zoom：放大画布（zoom 大）等效距离更近。
        let f = focus(0.0, 0.0, 1.0);
        let wide = focus_enter_start(&f, 900.0, 1.0);
        let zoomed = focus_enter_start(&f, 900.0, 3.0);
        let wide_dist = (wide.translation - Vec3::from_array(f.target)).length();
        let zoomed_dist = (zoomed.translation - Vec3::from_array(f.target)).length();
        assert!((wide_dist / zoomed_dist - 3.0).abs() < 1e-4);
    }

    #[test]
    fn focus_enter_start_falls_back_without_surface() {
        let f = focus(0.0, 0.0, 4.0);
        // 非法 surface 高度不应产生 NaN，且距离不小于聚焦距离。
        let start = focus_enter_start(&f, 0.0, 1.0);
        assert!(start.translation.is_finite());
        let dist = (start.translation - Vec3::from_array(f.target)).length();
        assert!(dist >= f.distance - 1e-4);
    }

    
    #[test]
    fn home_camera_transform_centers_on_surface() {
        let origin = crate::isometric_grid::IsometricGridView::default();
        let home = home_camera_transform(Some((1000.0, 800.0)), &origin);
        // 画布中心世界点应投影回画布中心（500, 400）。
        let screen = crate::isometric_grid::screen_point_from_world(home_center_world(&home), &origin);
        assert!((screen.x - 500.0).abs() < 1e-3);
        assert!((screen.y - 400.0).abs() < 1e-3);
        // 无 surface：中心为固定观察深度下的原点。
        let origin_home = home_camera_transform(None, &origin);
        assert!(
            (origin_home.translation
                - crate::isometric_grid::canvas_camera_rotation() * Vec3::new(0.0, 0.0, 300.0))
            .length()
                < 1e-4
        );
    }

    /// home 相机看向的世界中心点（相机沿观察平面前方的焦点）。
    fn home_center_world(home: &Transform) -> Vec3 {
        // 画布中心世界点 = 相机位置沿观察平面前方的世界坐标；对默认 view 即 R × (W/2,-H/2,0)。
        home.translation
            - crate::isometric_grid::canvas_camera_rotation() * Vec3::new(0.0, 0.0, 300.0)
    }

    #[test]
    fn home_camera_transform_respects_viewport() {
        let view = crate::isometric_grid::IsometricGridView {
            x: 100.0,
            y: 50.0,
            zoom: 2.0,
        };
        let home = home_camera_transform(Some((1000.0, 800.0)), &view);
        let expected = crate::isometric_grid::canvas_camera_transform_for_view(
            Vec2::new(1000.0, 800.0),
            &view,
        );
        assert!((home.translation - expected.translation).length() < 1e-4);
    }

    #[test]
    fn focus_to_orbit_is_bit_equivalent_to_focus_transform() {
        // 聚焦相机与 orbit rig 仅在 pitch 符号上不同；转换后应逐位等价。
        for f in [focus(0.0, 0.0, 10.0), focus(0.7, -0.35, 8.0), focus(-1.2, 0.9, 42.0)] {
            let expected = focus_camera_transform(&f);
            let (target, pose, _lens) = focus_to_orbit(&f);
            let (position, rotation) = crate::orbit_camera::derive_orbit_transform(&target, &pose);
            assert!(
                position.abs_diff_eq(expected.translation, 1e-4),
                "position {:?} vs {:?}",
                position,
                expected.translation
            );
            let forward_expected = expected.rotation * Vec3::NEG_Z;
            let forward_actual = rotation * Vec3::NEG_Z;
            assert!(forward_actual.abs_diff_eq(forward_expected, 1e-4));
        }
    }
}
