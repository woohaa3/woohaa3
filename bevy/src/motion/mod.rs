//! 动画节点运动 IR（`woohaa-motion-ir-v1`）的受控 DTO、校验与确定性求值器
//! （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1–4.3）。
//!
//! 运行时不执行 JavaScript：前端编译 `motionScript` 得到 `MotionIr`，Bevy 只做 serde、
//! 边界校验与按时间求值。求值语义与 contracts `motion-ir.ts` 逐位一致（相机属性插值、
//! rotate/move/oscillate 增量），供浏览器 WASM 与原生 renderer 共用。
//!
//! 本模块无领域协议、bridge 或 DOM 依赖，可独立测试。子模块：
//! - [`evaluate`]：按时间求值（纯函数）。
//! - [`validate`]：原始 JSON 轨道的边界校验与默认值补齐。

mod evaluate;
mod keyframes;
pub use keyframes::{MOTION_MAX_KEYFRAMES_PER_TRACK, RawKeyframeValue, RawModelKeyframe};
mod validate;

pub use evaluate::{clamp_elevation, evaluate};
pub use validate::{RawCameraTrack, RawModelMotion, RawModelTrack, validate};

use bevy::prelude::*;

/// 受支持的 Motion IR 版本。
pub const MOTION_IR_VERSION: &str = "woohaa-motion-ir-v1";
/// 运动预算（与 contracts 一致）。
pub const MOTION_MAX_CAMERA_TRACKS: usize = 256;
pub const MOTION_MAX_MODEL_TRACKS: usize = 256;
pub const MOTION_MAX_TRACKS: usize = 512;
pub const MOTION_MAX_DURATION_SECONDS: f32 = 3600.0;
/// 数值有限上限（与 Scene IR 同量级）。
pub const MOTION_COORD_LIMIT: f32 = 1_000_000.0;

/// 镜头可动画属性。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CameraProperty {
    Azimuth,
    Elevation,
    Distance,
    FocusOffsetX,
    FocusOffsetY,
    FocusOffsetZ,
}

impl CameraProperty {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "azimuth" => Some(Self::Azimuth),
            "elevation" => Some(Self::Elevation),
            "distance" => Some(Self::Distance),
            "focusOffset.x" => Some(Self::FocusOffsetX),
            "focusOffset.y" => Some(Self::FocusOffsetY),
            "focusOffset.z" => Some(Self::FocusOffsetZ),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionEasing {
    Linear,
    Smoothstep,
    EaseIn,
    EaseOut,
    EaseInOut,
}

impl MotionEasing {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "linear" => Some(Self::Linear),
            "smoothstep" => Some(Self::Smoothstep),
            "easeIn" => Some(Self::EaseIn),
            "easeOut" => Some(Self::EaseOut),
            "easeInOut" => Some(Self::EaseInOut),
            _ => None,
        }
    }
}

/// 进度曲线：边界精确为 0 与 1；与 contracts `easingProgress` 同一公式。
pub(crate) fn easing_progress(easing: MotionEasing, t: f32) -> f32 {
    let clamped = t.clamp(0.0, 1.0);
    match easing {
        MotionEasing::Linear => clamped,
        MotionEasing::Smoothstep => clamped * clamped * (3.0 - 2.0 * clamped),
        MotionEasing::EaseIn => clamped * clamped * clamped,
        MotionEasing::EaseOut => {
            let inverse = 1.0 - clamped;
            1.0 - inverse * inverse * inverse
        }
        MotionEasing::EaseInOut => {
            if clamped < 0.5 {
                4.0 * clamped * clamped * clamped
            } else {
                let shifted = -2.0 * clamped + 2.0;
                1.0 - shifted * shifted * shifted / 2.0
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis3 {
    X,
    Y,
    Z,
}

impl Axis3 {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "x" => Some(Self::X),
            "y" => Some(Self::Y),
            "z" => Some(Self::Z),
            _ => None,
        }
    }

    pub(crate) fn vector(self) -> Vec3 {
        match self {
            Self::X => Vec3::X,
            Self::Y => Vec3::Y,
            Self::Z => Vec3::Z,
        }
    }

    pub(crate) fn index(self) -> usize {
        match self {
            Self::X => 0,
            Self::Y => 1,
            Self::Z => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OscillateMode {
    Position,
    Rotation,
    Scale,
}

impl OscillateMode {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "position" => Some(Self::Position),
            "rotation" => Some(Self::Rotation),
            "scale" => Some(Self::Scale),
            _ => None,
        }
    }
}

/// 模型轨道属性（change: 2026-10-19-extend-film-set-for-motion-graphics，D1）。
///
/// `opacity` 为标量通道，只有 tween/keyframes 可以使用；其余是三维向量。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelTrackProperty {
    Position,
    Rotation,
    Scale,
    Opacity,
}

impl ModelTrackProperty {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "position" => Some(Self::Position),
            "rotation" => Some(Self::Rotation),
            "scale" => Some(Self::Scale),
            "opacity" => Some(Self::Opacity),
            _ => None,
        }
    }

    /// 是否为标量（opacity）通道。
    pub(crate) fn is_scalar(self) -> bool {
        matches!(self, Self::Opacity)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelMotion {
    Keyframes {
        property: ModelTrackProperty,
        frames: Vec<ModelKeyframe>,
    },
    Rotate {
        axis: Axis3,
        speed: f32,
    },
    Move {
        axis: Axis3,
        speed: f32,
        range: [f32; 2],
    },
    Oscillate {
        axis: Axis3,
        mode: OscillateMode,
        speed: f32,
        amplitude: f32,
        phase: f32,
    },
}

/// 单个关键帧：三维属性用 `value`，opacity 用 `opacity`（二选一，由轨道属性决定）。
#[derive(Clone, Debug, PartialEq)]
pub struct ModelKeyframe {
    pub time: f32,
    /// 三维属性（position/rotation/scale）的值。
    pub value: Vec3,
    /// opacity 通道的值（0..=1）；三维属性固定为 1。
    pub opacity: f32,
    pub easing: MotionEasing,
}

impl ModelMotion {
    pub fn property(&self) -> ModelTrackProperty {
        match self {
            Self::Keyframes { property, .. } => *property,
            Self::Rotate { .. } => ModelTrackProperty::Rotation,
            Self::Move { .. } => ModelTrackProperty::Position,
            Self::Oscillate { mode, .. } => match mode {
                OscillateMode::Position => ModelTrackProperty::Position,
                OscillateMode::Rotation => ModelTrackProperty::Rotation,
                OscillateMode::Scale => ModelTrackProperty::Scale,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct CameraTrack {
    pub property: CameraProperty,
    pub start_time: f32,
    pub end_time: f32,
    pub from: f32,
    pub to: f32,
    pub easing: MotionEasing,
}

#[derive(Clone, Debug)]
pub struct ModelTrack {
    pub target_id: String,
    pub start_time: f32,
    pub end_time: f32,
    pub motion: ModelMotion,
}

#[derive(Clone, Debug, Default)]
pub struct MotionIr {
    pub camera_motion: Vec<CameraTrack>,
    pub model_motion: Vec<ModelTrack>,
}

/// 初始镜头状态（第 0 秒）。
#[derive(Clone, Copy, Debug)]
pub struct InitialCameraState {
    pub azimuth: f32,
    pub elevation: f32,
    pub distance: f32,
    pub focus_offset: Vec3,
}

/// 求值后的镜头姿态。
#[derive(Clone, Copy, Debug)]
pub struct CameraState {
    pub azimuth: f32,
    pub elevation: f32,
    pub distance: f32,
    pub focus_offset: Vec3,
}

/// 部位增量（相对基础姿态）：旋转乘在基础旋转之后，平移/缩放叠加，透明度相乘。
#[derive(Clone, Copy, Debug)]
pub struct ModelDelta {
    pub rotation: Quat,
    pub translation: Vec3,
    pub scale: Vec3,
    /// 透明度乘数（0..=1，缺省 1）。
    pub opacity: f32,
}

/// 由分量数组构造初始镜头状态；供 protocol（不依赖 Bevy 类型）复用。
pub fn camera_state_from_arrays(
    azimuth: f32,
    elevation: f32,
    distance: f32,
    focus_offset: [f32; 3],
) -> InitialCameraState {
    InitialCameraState {
        azimuth,
        elevation,
        distance,
        focus_offset: Vec3::from_array(focus_offset),
    }
}

impl Default for ModelDelta {
    fn default() -> Self {
        Self {
            rotation: Quat::IDENTITY,
            translation: Vec3::ZERO,
            scale: Vec3::ONE,
            opacity: 1.0,
        }
    }
}

/// 运动校验错误（稳定 code）。
#[derive(Clone, Debug, PartialEq)]
pub struct MotionIrError {
    pub code: &'static str,
    pub message: String,
}

pub(crate) fn fail(code: &'static str, message: String) -> MotionIrError {
    MotionIrError { code, message }
}
