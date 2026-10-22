//! 有限三维关键帧的校验与采样；轨道末态保持，rotation 使用局部 Y-X-Z 弧度。
use super::{
    MOTION_COORD_LIMIT, ModelDelta, ModelKeyframe, MotionEasing, MotionIrError, OscillateMode, fail,
};
use bevy::prelude::*;

pub const MOTION_MAX_KEYFRAMES_PER_TRACK: usize = 1024;

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct RawModelKeyframe {
    pub time: f32,
    pub value: [f32; 3],
    #[serde(default)]
    pub easing: Option<String>,
}

pub(super) fn parse_frames(
    raw: &[RawModelKeyframe],
    property: OscillateMode,
) -> Result<Vec<ModelKeyframe>, MotionIrError> {
    if raw.len() < 2 || raw.len() > MOTION_MAX_KEYFRAMES_PER_TRACK {
        return Err(fail("invalid-motion", "关键帧数量必须为 2–1024".into()));
    }
    let mut frames = Vec::new();
    for point in raw {
        if !point.time.is_finite()
            || point.time < 0.0
            || frames
                .last()
                .is_some_and(|last: &ModelKeyframe| last.time >= point.time)
        {
            return Err(fail(
                "invalid-motion",
                "关键帧时间必须有限且严格递增".into(),
            ));
        }
        if point.value.iter().any(|v| {
            !v.is_finite()
                || v.abs() > MOTION_COORD_LIMIT
                || (property == OscillateMode::Scale && *v < 0.0)
        }) {
            return Err(fail("invalid-motion", "关键帧 value 非法".into()));
        }
        let easing = match point.easing.as_deref() {
            None => MotionEasing::Linear,
            Some(value) => MotionEasing::parse(value)
                .ok_or_else(|| fail("invalid-motion", "关键帧 easing 非法".into()))?,
        };
        frames.push(ModelKeyframe {
            time: point.time,
            value: Vec3::from_array(point.value),
            easing,
        });
    }
    Ok(frames)
}

pub(super) fn sample_frames(
    frames: &[ModelKeyframe],
    property: OscillateMode,
    now: f32,
) -> ModelDelta {
    let mut value = frames.last().expect("validated frames").value;
    for segment in frames.windows(2) {
        let [a, b] = segment else { unreachable!() };
        if now < b.time {
            let progress = ((now - a.time) / (b.time - a.time)).clamp(0.0, 1.0);
            let t = match a.easing {
                MotionEasing::Linear => progress,
                MotionEasing::Smoothstep => progress * progress * (3.0 - 2.0 * progress),
            };
            value = a.value.lerp(b.value, t);
            break;
        }
    }
    match property {
        OscillateMode::Position => ModelDelta {
            translation: value,
            ..Default::default()
        },
        OscillateMode::Rotation => ModelDelta {
            rotation: Quat::from_euler(EulerRot::YXZ, value.y, value.x, value.z),
            ..Default::default()
        },
        OscillateMode::Scale => ModelDelta {
            scale: value,
            ..Default::default()
        },
    }
}
