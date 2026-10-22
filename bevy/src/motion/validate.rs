//! 运动 IR 原始 JSON DTO 与边界校验（change: 2026-10-05-bind-model-animation-to-shots）。

use super::{
    Axis3, CameraProperty, CameraTrack, MOTION_COORD_LIMIT, MOTION_IR_VERSION,
    MOTION_MAX_CAMERA_TRACKS, MOTION_MAX_DURATION_SECONDS, MOTION_MAX_MODEL_TRACKS,
    MOTION_MAX_TRACKS, ModelMotion, ModelTrack, MotionEasing, MotionIr, MotionIrError,
    OscillateMode, fail,
};

/// 校验原始 JSON 轨道，构造受控 `MotionIr`。
pub fn validate(
    version: &str,
    camera_motion: Vec<RawCameraTrack>,
    model_motion: Vec<RawModelTrack>,
    duration: f32,
) -> Result<MotionIr, MotionIrError> {
    if version != MOTION_IR_VERSION {
        return Err(fail(
            "version-mismatch",
            format!("未知 Motion IR 版本 {version}"),
        ));
    }
    if !duration.is_finite() || duration < 0.0 || duration > MOTION_MAX_DURATION_SECONDS {
        return Err(fail(
            "invalid-time-range",
            format!("时间线时长非法：{duration}"),
        ));
    }
    if camera_motion.len() > MOTION_MAX_CAMERA_TRACKS {
        return Err(fail("too-many-tracks", "镜头轨道超过上限".to_owned()));
    }
    if model_motion.len() > MOTION_MAX_MODEL_TRACKS {
        return Err(fail("too-many-tracks", "模型轨道超过上限".to_owned()));
    }
    if camera_motion.len() + model_motion.len() > MOTION_MAX_TRACKS {
        return Err(fail("too-many-tracks", "运动轨道总数超过上限".to_owned()));
    }

    let mut camera = Vec::new();
    for raw in camera_motion {
        let property = CameraProperty::parse(&raw.property).ok_or_else(|| {
            fail(
                "invalid-track",
                format!("镜头轨道属性非法：{}", raw.property),
            )
        })?;
        let (start_time, end_time) = check_time(raw.start_time, raw.end_time, duration)?;
        if !finite(raw.from) || !finite(raw.to) {
            return Err(fail("invalid-track", "镜头轨道 from/to 非法".to_owned()));
        }
        let easing = match raw.easing.as_deref() {
            None => MotionEasing::Linear,
            Some(value) => MotionEasing::parse(value)
                .ok_or_else(|| fail("invalid-track", format!("镜头轨道 easing 非法：{value}")))?,
        };
        camera.push(CameraTrack {
            property,
            start_time,
            end_time,
            from: raw.from,
            to: raw.to,
            easing,
        });
    }
    check_camera_overlap(&camera)?;

    let mut model = Vec::new();
    for raw in model_motion {
        let (start_time, end_time) = check_time(raw.start_time, raw.end_time, duration)?;
        let motion = raw.motion.parse()?;
        if let ModelMotion::Keyframes { frames, .. } = &motion {
            if frames[0].time != start_time || frames.last().unwrap().time != end_time {
                return Err(fail(
                    "invalid-motion",
                    "首末关键帧时间必须等于 startTime/endTime".into(),
                ));
            }
        }
        for other in &model {
            let other: &ModelTrack = other;
            if other.target_id == raw.target_id
                && other.motion.property() == motion.property()
                && start_time < other.end_time - 1e-9
                && end_time > other.start_time + 1e-9
            {
                return Err(fail(
                    "overlapping-model-track",
                    format!("模型部件 {} 的同属性轨道区间重叠", raw.target_id),
                ));
            }
        }
        model.push(ModelTrack {
            target_id: raw.target_id,
            start_time,
            end_time,
            motion,
        });
    }
    Ok(MotionIr {
        camera_motion: camera,
        model_motion: model,
    })
}

fn check_camera_overlap(tracks: &[CameraTrack]) -> Result<(), MotionIrError> {
    const EPS: f32 = 1e-9;
    for (index, track) in tracks.iter().enumerate() {
        for other in &tracks[index + 1..] {
            if track.property != other.property {
                continue;
            }
            if track.start_time < other.end_time - EPS && track.end_time > other.start_time + EPS {
                return Err(fail(
                    "overlapping-camera-track",
                    "同属性镜头轨道区间重叠".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn check_time(
    start: Option<f32>,
    end: Option<f32>,
    duration: f32,
) -> Result<(f32, f32), MotionIrError> {
    let start = start.unwrap_or(0.0);
    let end = end.unwrap_or(duration);
    if !start.is_finite() || !end.is_finite() {
        return Err(fail("invalid-time-range", "轨道时间非法".to_owned()));
    }
    if !(start < end) {
        return Err(fail(
            "invalid-time-range",
            "轨道必须满足 startTime < endTime".to_owned(),
        ));
    }
    if start < 0.0 || end > duration + 1e-9 {
        return Err(fail(
            "track-out-of-range",
            format!("轨道区间超出 [0, {duration}]"),
        ));
    }
    Ok((start, end))
}

fn finite(value: f32) -> bool {
    value.is_finite() && value.abs() <= MOTION_COORD_LIMIT
}

// ── 原始（未校验）DTO ─────────────────────────────────────────────────────────

/// 原始镜头轨道；字段缺失由 serde 默认补齐。
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCameraTrack {
    pub property: String,
    #[serde(default)]
    pub start_time: Option<f32>,
    #[serde(default)]
    pub end_time: Option<f32>,
    pub from: f32,
    pub to: f32,
    #[serde(default)]
    pub easing: Option<String>,
}

/// 原始模型动作（闭合判别由 `parse` 完成）。
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModelMotion {
    pub kind: String,
    #[serde(default)]
    pub property: Option<String>,
    #[serde(default)]
    pub frames: Vec<super::RawModelKeyframe>,
    #[serde(default)]
    pub axis: Option<String>,
    #[serde(default)]
    pub speed: Option<f32>,
    #[serde(default)]
    pub range: Option<[f32; 2]>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub amplitude: Option<f32>,
    #[serde(default)]
    pub phase: Option<f32>,
}

impl RawModelMotion {
    /// 解析为受控 `ModelMotion`；必填项缺失或非法时稳定拒绝。
    pub fn parse(&self) -> Result<ModelMotion, MotionIrError> {
        if self.kind == "keyframes" {
            let property = self
                .property
                .as_deref()
                .and_then(OscillateMode::parse)
                .ok_or_else(|| {
                    fail(
                        "invalid-motion",
                        "关键帧 property 必须是 position/rotation/scale".into(),
                    )
                })?;
            let frames = super::keyframes::parse_frames(&self.frames, property)?;
            return Ok(ModelMotion::Keyframes { property, frames });
        }
        let axis = match &self.axis {
            None => Axis3::Y,
            Some(value) => Axis3::parse(value)
                .ok_or_else(|| fail("invalid-motion", format!("axis 非法：{value}")))?,
        };
        match self.kind.as_str() {
            "rotate" => {
                let speed = self
                    .speed
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| fail("invalid-motion", "rotate.speed 必填且有限".to_owned()))?;
                Ok(ModelMotion::Rotate { axis, speed })
            }
            "move" => {
                let speed = self
                    .speed
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| fail("invalid-motion", "move.speed 必填且有限".to_owned()))?;
                let range = self
                    .range
                    .filter(|range| range.iter().all(|value| value.is_finite()))
                    .ok_or_else(|| {
                        fail("invalid-motion", "move.range 必填且为 [min,max]".to_owned())
                    })?;
                Ok(ModelMotion::Move { axis, speed, range })
            }
            "oscillate" => {
                let mode = match &self.mode {
                    None => OscillateMode::Position,
                    Some(value) => OscillateMode::parse(value)
                        .ok_or_else(|| fail("invalid-motion", format!("mode 非法：{value}")))?,
                };
                let speed = self
                    .speed
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| {
                        fail("invalid-motion", "oscillate.speed 必填且有限".to_owned())
                    })?;
                let amplitude = self
                    .amplitude
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| {
                        fail(
                            "invalid-motion",
                            "oscillate.amplitude 必填且有限".to_owned(),
                        )
                    })?;
                let phase = self.phase.unwrap_or(0.0);
                if !phase.is_finite() {
                    return Err(fail("invalid-motion", "oscillate.phase 非法".to_owned()));
                }
                Ok(ModelMotion::Oscillate {
                    axis,
                    mode,
                    speed,
                    amplitude,
                    phase,
                })
            }
            other => Err(fail(
                "invalid-motion",
                format!("未知模型动作 kind：{other}"),
            )),
        }
    }
}

/// 原始模型轨道。
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModelTrack {
    pub target_id: String,
    #[serde(default)]
    pub start_time: Option<f32>,
    #[serde(default)]
    pub end_time: Option<f32>,
    pub motion: RawModelMotion,
}
