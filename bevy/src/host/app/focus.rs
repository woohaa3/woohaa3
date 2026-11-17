use bevy::prelude::*;

use crate::camera_transition::projection::FocusProjectionBlend;
use crate::model3d;
use crate::orbit_camera;

use super::helpers::{apply_focus_projection, surface_size};
use super::setup::FocusObserverRig;
use super::{CurrentScene, FocusRig};

/// 主观察相机是否应由 adapter 直接写（挂起 orbit rig）。
///
/// 非聚焦时保留正交 home 与相机复位；过渡进行中由 adapter 逐帧插值。只有「聚焦且过渡结束」
/// 才交回 orbit runtime 派生（此时派生 transform 与聚焦相机逐位等价）。
pub(super) fn observer_should_suspend(focused: bool, animating: bool) -> bool {
    !focused || animating
}

/// 聚焦相机切换：主观察相机由一个通用 orbit rig 拥有。
///
/// 聚焦期间 adapter 把 `scene.modelFocus` 投影为 rig 的 target/pose/lens；过渡结束且仍聚焦时
/// 交回 orbit runtime 派生透视 transform。非聚焦/过渡中挂起 rig，adapter 保留既有正交 home、
/// 相机复位与平滑过渡语义。投影切换、可见性、恢复策略仍是 adapter 责任（design D6）。
#[allow(clippy::too_many_arguments)]
pub(super) fn sync_focus(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<CurrentScene>,
    observer: Res<FocusObserverRig>,
    mut rig: ResMut<FocusRig>,
    mut observer_rig: Query<(
        &mut orbit_camera::OrbitCameraPose,
        &mut orbit_camera::OrbitCameraTarget,
        &mut orbit_camera::OrbitCameraLens,
        Option<&orbit_camera::OrbitCameraSuspended>,
    )>,
    mut camera3d: Query<(&mut Transform, &mut Projection), With<model3d::grid::ModelCanvasCamera>>,
    mut camera2d: Query<&mut Camera, (With<crate::canvas2d::MainCanvasCamera>, Without<Camera3d>)>,
) {
    let Ok((mut transform, mut projection)) = camera3d.single_mut() else {
        return;
    };
    let focused = scene.0.model_focus.is_some();
    let view = model3d::grid::scene_view(&scene.0);
    // 聚焦只在世界相机与画布相机之间过渡：模型没有卡片相机，退出时不再对齐卡片取景
    // （change: 2026-11-10-remove-legacy-model-card-nodes）。
    let preview_id = scene
        .0
        .model_focus
        .as_ref()
        .map(|focus| focus.node_id.as_str())
        .or(rig.focus_node.as_deref());
    let target = match &scene.0.model_focus {
        Some(focus) => model3d::focus::focus_camera_transform(focus),
        None => model3d::focus::home_camera_transform(surface_size(&scene.0), &view),
    };
    let duration = model3d::focus::FOCUS_TRANSITION_SECS;

    // 注入本帧公共进度（design D6/D7）：合法时 `advance` 按进度求值，不消耗独立 delta。
    // 退出过渡期间 `model_focus` 已为 None，需回落到 `rig.focus_node`（退出的是刚刚聚焦的节点），
    // 否则退出进度会被判为「不匹配当前目标」而被丢弃。
    let progress_node = preview_id.map(str::to_string);
    let _uses_public_progress =
        rig.accept_transition_progress(scene.0.focus_transition.as_ref(), progress_node.as_deref());

    if !rig.initialized {
        // 首帧：直接落到目标，不产生启动动画。
        rig.initialized = true;
        rig.active = focused;
        rig.transition = crate::camera_transition::CameraTransition::settled(target, duration);
        apply_focus_projection(&mut projection, focused, &scene, &mut camera2d);
    } else if focused && !rig.active {
        // 进入聚焦：从当前画布相机姿态推近目标，投影同步渐变，首帧屏幕位置保持一致。
        rig.active = true;
        let (from, from_projection) = if rig.animating() {
            (*transform, projection.clone())
        } else {
            (*transform, projection.clone())
        };
        rig.transition = crate::camera_transition::CameraTransition {
            from,
            target,
            duration,
            elapsed: 0.0,
        };
        let mut to_projection = projection.clone();
        apply_focus_projection(&mut to_projection, true, &scene, &mut camera2d);
        to_projection.update(
            surface_size(&scene.0).map(|s| s.0).unwrap_or(1.0),
            surface_size(&scene.0).map(|s| s.1).unwrap_or(1.0),
        );
        let pivot = scene
            .0
            .model_focus
            .as_ref()
            .map(|focus| Vec3::from_array(focus.target))
            .unwrap_or(Vec3::ZERO);
        rig.projection_pivot = pivot;
        rig.projection_blend = Some(FocusProjectionBlend::new(
            from_projection.clone(),
            to_projection.clone(),
            from,
            target,
            pivot,
        ));
    } else if !focused && rig.active {
        // 退出聚焦：从当前聚焦姿态平滑恢复到正交 home（位置 + 朝向），与进入对称。
        rig.active = false;
        rig.transition = crate::camera_transition::CameraTransition {
            from: *transform,
            target,
            duration,
            elapsed: 0.0,
        };
        let from_projection = projection.clone();
        let mut to_projection = projection.clone();
        apply_focus_projection(&mut to_projection, false, &scene, &mut camera2d);
        to_projection.update(
            surface_size(&scene.0).map(|s| s.0).unwrap_or(1.0),
            surface_size(&scene.0).map(|s| s.1).unwrap_or(1.0),
        );
        for mut cam in &mut camera2d {
            cam.is_active = false;
        }
        let pivot = rig.projection_pivot;
        rig.projection_blend = Some(FocusProjectionBlend::new(
            from_projection,
            to_projection,
            *transform,
            target,
            pivot,
        ));
    } else {
        // 静止/导航帧：保持终点，不重启过渡。
        rig.transition.target = target;
    }

    // 把 scene.modelFocus 投影到 observer rig；决定是否挂起 orbit 写入。
    let suspend = observer_should_suspend(focused, rig.animating());
    if let Ok((mut pose, mut orbit_target, mut lens, suspended)) = observer_rig.get_mut(observer.0)
    {
        if let Some(focus) = &scene.0.model_focus {
            let (next_target, next_pose, next_lens) = model3d::focus::focus_to_orbit(focus);
            *orbit_target = next_target;
            *pose = next_pose;
            *lens = next_lens;
        }
        if suspend && suspended.is_none() {
            commands
                .entity(observer.0)
                .insert(orbit_camera::OrbitCameraSuspended);
        } else if !suspend && suspended.is_some() {
            commands
                .entity(observer.0)
                .remove::<orbit_camera::OrbitCameraSuspended>();
        }
    }

    // 挂起期间 adapter 逐帧写 transform（过渡 / 正交 home）；非挂起交给 orbit runtime。
    if suspend {
        // 有公共进度时按进度映射 elapsed，不使用独立 delta（design D6/D7：单一时间源）。
        let advanced = rig.advance(time.delta_secs());
        let animating = rig.animating();
        let progress =
            crate::camera_transition::smoothstep(rig.transition.elapsed / rig.transition.duration);
        // 姿态与投影必须来自同一过渡：有投影混合时由它逐帧反解相机平移，保证锚点沿屏幕
        // 直线移动（否则独立插值世界平移会让模型中途鼓出、再「从视口外飞入」）。
        let next = if let Some(blend) = &mut rig.projection_blend {
            blend.progress = progress;
            *projection = if animating {
                Projection::custom(blend.clone())
            } else {
                blend.to.clone()
            };
            blend.pose_at(progress)
        } else {
            advanced
        };
        *transform = next;
        if !animating {
            let completed_transition = rig.projection_blend.is_some();
            rig.projection_blend = None;
            for mut cam in &mut camera2d {
                cam.is_active = !focused || !scene.0.model_focus_context.is_empty();
            }
            if !focused && completed_transition {
                // The 2D card takes over at the same pixels; restore the ordinary 3D camera.
                *transform = model3d::focus::home_camera_transform(surface_size(&scene.0), &view);
                apply_focus_projection(&mut projection, false, &scene, &mut camera2d);
            }
        }
        if focused && !rig.animating() {
            *transform = rig.transition.target;
        }
    } else {
        // 已交回 orbit：结束过渡计时，避免下次进入时被判定仍在动画。
        rig.transition.elapsed = rig.transition.duration;
    }
    if focused && !rig.animating() {
        for mut cam in &mut camera2d {
            cam.is_active = !scene.0.model_focus_context.is_empty();
        }
    }
    rig.sync_focus_node(
        scene
            .0
            .model_focus
            .as_ref()
            .map(|focus| focus.node_id.as_str()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observer_suspend_only_when_unfocused_or_animating() {
        assert!(observer_should_suspend(false, false));
        assert!(observer_should_suspend(false, true));
        assert!(observer_should_suspend(true, true));
        assert!(!observer_should_suspend(true, false));
    }

    #[test]
    fn focus_rig_animating_until_elapsed_reaches_duration() {
        let mut rig = FocusRig::default();
        rig.transition.elapsed = 0.0;
        rig.transition.duration = model3d::focus::FOCUS_TRANSITION_SECS;
        assert!(rig.animating(), "刚开始应处于过渡中");
        rig.transition.elapsed = model3d::focus::FOCUS_TRANSITION_SECS;
        assert!(!rig.animating(), "到达时长后过渡结束");
        rig.transition.elapsed = model3d::focus::FOCUS_TRANSITION_SECS + 1.0;
        assert!(!rig.animating());
    }
}
