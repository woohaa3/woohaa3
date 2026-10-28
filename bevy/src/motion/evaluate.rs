//! 运动 IR 的确定性求值（纯函数，change: 2026-10-05-bind-model-animation-to-shots）。

use bevy::prelude::*;

use super::{
    CameraProperty, CameraState, InitialCameraState, ModelDelta, ModelMotion, ModelTrack,
    ModelTrackProperty, MotionIr, OscillateMode, easing_progress,
};

/// 在 `time` 秒对运动求值（确定性纯函数）。
///
/// - 镜头从 `initial` 开始；已结束轨道保持 `to`，未开始轨道不生效。
/// - 模型轨道按目标与属性合成；开始前返回 None，结束后保持末态。
pub fn evaluate(
    motion: &MotionIr,
    time: f32,
    initial: InitialCameraState,
) -> (CameraState, Vec<(String, ModelDelta)>) {
    let now = if time.is_finite() { time.max(0.0) } else { 0.0 };
    let mut camera = CameraState {
        azimuth: initial.azimuth,
        elevation: initial.elevation,
        distance: initial.distance,
        focus_offset: initial.focus_offset,
    };
    let mut camera_tracks: Vec<_> = motion.camera_motion.iter().collect();
    camera_tracks.sort_by(|a, b| a.start_time.total_cmp(&b.start_time));
    for track in camera_tracks {
        if now < track.start_time {
            continue;
        }
        let value = if now >= track.end_time {
            track.to
        } else {
            let span = track.end_time - track.start_time;
            let t = if span.abs() > f32::EPSILON {
                (now - track.start_time) / span
            } else {
                1.0
            };
            track.from + (track.to - track.from) * easing_progress(track.easing, t)
        };
        apply_camera(&mut camera, track.property, value);
    }

    let mut model: Vec<(String, ModelDelta)> = Vec::new();
    let mut tracks: Vec<_> = motion.model_motion.iter().collect();
    tracks.sort_by(|a, b| a.start_time.total_cmp(&b.start_time));
    for track in tracks {
        if let Some(delta) = evaluate_model_track(track, now) {
            if let Some((_, previous)) = model.iter_mut().find(|(id, _)| id == &track.target_id) {
                match track.motion.property() {
                    ModelTrackProperty::Position => previous.translation = delta.translation,
                    ModelTrackProperty::Rotation => previous.rotation = delta.rotation,
                    ModelTrackProperty::Scale => previous.scale = delta.scale,
                    ModelTrackProperty::Opacity => previous.opacity = delta.opacity,
                }
            } else {
                model.push((track.target_id.clone(), delta));
            }
        }
    }
    (camera, model)
}

fn evaluate_model_track(track: &ModelTrack, now: f32) -> Option<ModelDelta> {
    if now < track.start_time {
        return None;
    }
    let now = now.min(track.end_time);
    let delta = match &track.motion {
        ModelMotion::Keyframes { property, frames } => {
            super::keyframes::sample_frames(frames, *property, now)
        }
        ModelMotion::Rotate { axis, speed } => ModelDelta {
            rotation: Quat::from_axis_angle(axis.vector(), (now - track.start_time) * *speed),
            ..Default::default()
        },
        ModelMotion::Move { axis, speed, range } => {
            let span = range[1] - range[0];
            let value = if span > f32::EPSILON {
                let local = (now - track.start_time) * *speed;
                range[0] + local.rem_euclid(span)
            } else {
                range[0]
            };
            let mut translation = Vec3::ZERO;
            translation[axis.index()] = value;
            ModelDelta {
                translation,
                ..Default::default()
            }
        }
        ModelMotion::Oscillate {
            axis,
            mode,
            speed,
            amplitude,
            phase,
        } => {
            let wave = ((now - track.start_time) * *speed + *phase).sin() * *amplitude;
            match mode {
                OscillateMode::Rotation => ModelDelta {
                    rotation: Quat::from_axis_angle(axis.vector(), wave),
                    ..Default::default()
                },
                OscillateMode::Scale => {
                    let mut scale = Vec3::ONE;
                    scale[axis.index()] = 1.0 + wave;
                    ModelDelta {
                        scale,
                        ..Default::default()
                    }
                }
                OscillateMode::Position => {
                    let mut translation = Vec3::ZERO;
                    translation[axis.index()] = wave;
                    ModelDelta {
                        translation,
                        ..Default::default()
                    }
                }
            }
        }
    };
    Some(delta)
}

fn apply_camera(camera: &mut CameraState, property: CameraProperty, value: f32) {
    match property {
        CameraProperty::Azimuth => camera.azimuth = value,
        CameraProperty::Elevation => camera.elevation = clamp_elevation(value),
        CameraProperty::Distance => camera.distance = value,
        CameraProperty::FocusOffsetX => camera.focus_offset.x = value,
        CameraProperty::FocusOffsetY => camera.focus_offset.y = value,
        CameraProperty::FocusOffsetZ => camera.focus_offset.z = value,
    }
}

/// 仰角钳制到 `[-PI/2, PI/2]`；非有限值回退画布全局 pitch（与 contracts 一致）。
pub fn clamp_elevation(elevation: f32) -> f32 {
    if !elevation.is_finite() {
        return crate::isometric_grid::CANVAS_CAMERA_PITCH;
    }
    elevation.clamp(-std::f32::consts::FRAC_PI_2, std::f32::consts::FRAC_PI_2)
}
