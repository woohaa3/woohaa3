//! 关键帧校验与采样；轨道末态保持，rotation 使用局部 Y-X-Z 弧度。
//!
//! 三维属性（position/rotation/scale）使用 `[f32;3]`；opacity 是 0..=1 的标量
//! （change: 2026-10-19-extend-film-set-for-motion-graphics，D1）。
use super::{
    MOTION_COORD_LIMIT, ModelDelta, ModelKeyframe, ModelTrackProperty, MotionEasing, MotionIrError,
    easing_progress, fail,
};
use bevy::prelude::*;

pub const MOTION_MAX_KEYFRAMES_PER_TRACK: usize = 1024;

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct RawModelKeyframe {
    pub time: f32,
    /// 三维属性值；opacity 轨道忽略该字段（ProtoJSON 里是标量，缺失即可）。
    #[serde(default)]
    pub value: Option<RawKeyframeValue>,
    /// opacity 通道的标量值。
    #[serde(default)]
    pub opacity: Option<f32>,
    #[serde(default)]
    pub easing: Option<String>,
}

/// 关键帧值：JSON 里既可能是三维数组，也可能是标量（opacity）。
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(untagged)]
pub enum RawKeyframeValue {
    Vector([f32; 3]),
    Scalar(f32),
}

impl RawKeyframeValue {
    fn vector(&self) -> Option<[f32; 3]> {
        match self {
            Self::Vector(value) => Some(*value),
            Self::Scalar(_) => None,
        }
    }

    fn scalar(&self) -> Option<f32> {
        match self {
            Self::Scalar(value) => Some(*value),
            Self::Vector(_) => None,
        }
    }
}

pub(super) fn parse_frames(
    raw: &[RawModelKeyframe],
    property: ModelTrackProperty,
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
        let (value, opacity) = if property.is_scalar() {
            let opacity = point
                .opacity
                .or_else(|| point.value.as_ref().and_then(RawKeyframeValue::scalar))
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                .ok_or_else(|| {
                    fail(
                        "invalid-motion",
                        "opacity 关键帧 value 必须是 0–1 的数字".into(),
                    )
                })?;
            (Vec3::ZERO, opacity)
        } else {
            let value = point
                .value
                .as_ref()
                .and_then(RawKeyframeValue::vector)
                .ok_or_else(|| fail("invalid-motion", "关键帧 value 必须是有限三维坐标".into()))?;
            if value.iter().any(|v| {
                !v.is_finite()
                    || v.abs() > MOTION_COORD_LIMIT
                    || (property == ModelTrackProperty::Scale && *v < 0.0)
            }) {
                return Err(fail("invalid-motion", "关键帧 value 非法".into()));
            }
            (Vec3::from_array(value), 1.0)
        };
        let easing = match point.easing.as_deref() {
            None => MotionEasing::Linear,
            Some(value) => MotionEasing::parse(value)
                .ok_or_else(|| fail("invalid-motion", "关键帧 easing 非法".into()))?,
        };
        frames.push(ModelKeyframe {
            time: point.time,
            value,
            opacity,
            easing,
        });
    }
    Ok(frames)
}

pub(super) fn sample_frames(
    frames: &[ModelKeyframe],
    property: ModelTrackProperty,
    now: f32,
) -> ModelDelta {
    let last = frames.last().expect("validated frames");
    if property.is_scalar() {
        let value = sample_scalar(frames, last.opacity, now);
        return ModelDelta {
            opacity: value,
            ..Default::default()
        };
    }
    let value = sample_vector(frames, last.value, now);
    match property {
        ModelTrackProperty::Position => ModelDelta {
            translation: value,
            ..Default::default()
        },
        ModelTrackProperty::Rotation => ModelDelta {
            rotation: Quat::from_euler(EulerRot::YXZ, value.y, value.x, value.z),
            ..Default::default()
        },
        ModelTrackProperty::Scale => ModelDelta {
            scale: value,
            ..Default::default()
        },
        ModelTrackProperty::Opacity => unreachable!("handled above"),
    }
}

fn segment_progress(frames: &[ModelKeyframe], now: f32) -> Option<(usize, f32)> {
    for index in 1..frames.len() {
        if now < frames[index].time {
            let a = &frames[index - 1];
            let b = &frames[index];
            let span = b.time - a.time;
            let raw = if span.abs() > f32::EPSILON {
                (now - a.time) / span
            } else {
                1.0
            };
            let progress = raw.clamp(0.0, 1.0);
            return Some((index - 1, easing_progress(a.easing, progress)));
        }
    }
    None
}

fn sample_vector(frames: &[ModelKeyframe], last: Vec3, now: f32) -> Vec3 {
    let Some((index, t)) = segment_progress(frames, now) else {
        return last;
    };
    frames[index].value.lerp(frames[index + 1].value, t)
}

fn sample_scalar(frames: &[ModelKeyframe], last: f32, now: f32) -> f32 {
    let Some((index, t)) = segment_progress(frames, now) else {
        return last;
    };
    let a = frames[index].opacity;
    let b = frames[index + 1].opacity;
    a + (b - a) * t
}
