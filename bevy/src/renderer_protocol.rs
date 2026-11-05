//! 原生 renderer 的 framed 进程协议（change: enhance-model-scene-authoring-api，任务 6.3）。
//!
//! Canvas Service 通过本机 stdio 与常驻 `model-renderer` 进程通信：
//! - 请求：4 字节大端长度 + JSON（含 `requestId`、`sceneVersion`、`ops`、capture options）；
//! - 响应：4 字节大端长度 + JSON；成功时附 4 字节 PNG 长度 + PNG bytes（framed，不 base64）。
//!
//! 本模块只描述**线上格式与边界校验**，不含 Bevy 依赖，便于 Node 侧镜像与单测。
//! Renderer MUST NOT 执行 JavaScript，也 MUST NOT 接受未声明版本或结构非法的 Scene IR。

use serde::{Deserialize, Serialize};

use crate::protocol::ModelOp;

/// 协议版本；结构变化时必须升级。
///
/// v2 起携带动画采样：`motion`、`placement`、`initialCamera`、`timeSeconds`
/// （change: 2026-10-06-fix-model-media-references-and-animation-preview，任务 4.1）。
/// 旧 worker 只认识 v1，收到 v2 会稳定拒绝，不会忽略运动字段后返回静态帧。
pub const RENDERER_PROTOCOL_VERSION: &str = "woohaa-model-renderer-protocol-v4";
pub const WORLD_RENDERER_PROTOCOL_VERSION: &str = "woohaa-world-renderer-protocol-v1";
/// 单条消息体上限（防止超大消息耗尽内存）。
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// 预览尺寸上限。
pub const MAX_PREVIEW_EDGE: u32 = 2048;
/// 默认预设名。
pub const DEFAULT_CAMERA_PRESET: &str = "dimetric";
/// 支持的相机 preset：`dimetric`（几何检查）与 `initial`（动画保存镜头）。
pub const CAMERA_PRESETS: [&str; 2] = ["dimetric", "initial"];

/// 时间线动画请求：受控 Motion IR + 初始镜头 + 采样时刻。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionRequest {
    /// 时间线时长（秒）。
    pub(crate) duration: f32,
    #[serde(default)]
    #[allow(dead_code)] // 线格式字段：随请求下发；循环由采样时刻语义表达，Rust 侧暂不读取。
    pub(crate) looped: bool,
    pub(crate) camera_motion: Vec<crate::motion::RawCameraTrack>,
    pub(crate) model_motion: Vec<crate::motion::RawModelTrack>,
    /// 初始镜头（第 0 秒）。
    pub(crate) initial_camera: InitialCameraRequest,
    /// 采样时刻（秒）。
    #[serde(default)]
    pub(crate) time_seconds: f32,
}

impl MotionRequest {
    /// 测试/录制装配用的最小运动请求（无轨道、固定初始镜头）。
    #[doc(hidden)]
    pub fn default_for_test(duration: f32) -> Self {
        Self {
            duration,
            looped: false,
            camera_motion: Vec::new(),
            model_motion: Vec::new(),
            initial_camera: InitialCameraRequest {
                azimuth: 0.0,
                elevation: default_elevation(),
                distance: default_distance(),
                focus_offset: [0.0, 0.0, 0.0],
                aspect: default_aspect(),
            },
            time_seconds: 0.0,
        }
    }
}

/// 初始镜头请求（与 `motion::InitialCameraState` 同构）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialCameraRequest {
    #[serde(default)]
    pub(crate) azimuth: f32,
    #[serde(default = "default_elevation")]
    pub(crate) elevation: f32,
    #[serde(default = "default_distance")]
    pub(crate) distance: f32,
    #[serde(default)]
    pub(crate) focus_offset: [f32; 3],
    #[serde(default = "default_aspect")]
    #[allow(dead_code)]
    // 线格式字段：随请求下发；画幅由调用方按 `aspect` 字符串解析，结构内暂不读取。
    pub(crate) aspect: String,
}

fn default_elevation() -> f32 {
    crate::isometric_grid::CANVAS_CAMERA_PITCH
}

fn default_distance() -> f32 {
    8.0
}

fn default_aspect() -> String {
    "16:9".to_owned()
}

impl InitialCameraRequest {
    pub(crate) fn state(&self) -> crate::motion::InitialCameraState {
        crate::motion::camera_state_from_arrays(
            self.azimuth,
            self.elevation,
            self.distance,
            self.focus_offset,
        )
    }
}

/// 支持的 Scene IR 版本（change: 2026-10-07-remove-residual-compatibility —— V2-only）。
pub const SUPPORTED_SCENE_VERSIONS: [&str; 1] = ["woohaa-model-scene-ir-v2"];

/// 预览捕获选项（受控子集）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    #[serde(default = "default_width")]
    pub(crate) width: u32,
    #[serde(default = "default_height")]
    pub(crate) height: u32,
    /// 背景：`transparent` 或 `#rrggbb`。
    #[serde(default = "default_background")]
    pub(crate) background: String,
    #[serde(default = "default_preset")]
    pub(crate) camera_preset: String,
    /// 输出格式：`png`（默认）或 `rgba`（动态取景逐帧编码用，避免 PNG 编解码往返）。
    #[serde(default = "default_format")]
    pub(crate) format: String,
}

fn default_format() -> String {
    "png".to_owned()
}

/// 支持的输出帧格式。
pub const CAPTURE_FORMATS: [&str; 2] = ["png", "rgba"];

fn default_width() -> u32 {
    512
}

fn default_height() -> u32 {
    512
}

fn default_background() -> String {
    "transparent".to_owned()
}

fn default_preset() -> String {
    DEFAULT_CAMERA_PRESET.to_owned()
}

impl Default for CaptureOptions {
    fn default() -> Self {
        Self {
            width: default_width(),
            height: default_height(),
            background: default_background(),
            camera_preset: default_preset(),
            format: default_format(),
        }
    }
}

/// 渲染请求：**只接受规范化 Scene IR**，不接受 JavaScript 源码。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub(crate) protocol_version: String,
    pub(crate) request_id: String,
    pub(crate) scene_version: String,
    pub(crate) signature: String,
    #[serde(default = "default_extent")]
    pub(crate) extent: f32,
    pub(crate) ops: Vec<ModelOp>,
    #[serde(default)]
    pub(crate) capture: CaptureOptions,
    /// 实例 placement（动画/静态节点均可携带；缺省为单位 transform）。
    #[serde(default)]
    pub(crate) placement: Option<PlacementRequest>,
    /// 动画采样；缺省为静态预览。
    #[serde(default)]
    pub(crate) motion: Option<MotionRequest>,
    #[serde(default)]
    pub(crate) world: Option<WorldRenderRequest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldRenderRequest {
    pub(crate) camera: crate::protocol::WorldCamera,
    pub(crate) instances: Vec<WorldRenderInstance>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldRenderInstance {
    pub(crate) instance: crate::protocol::WorldInstance,
    pub(crate) ops: Vec<ModelOp>,
    #[serde(default)]
    pub(crate) textures: Vec<WorldRenderTexture>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct WorldRenderTexture {
    pub(crate) id: String,
    pub(crate) mime_type: String,
    pub(crate) bytes_base64: String,
}

fn default_extent() -> f32 {
    2.0
}

/// 实例 placement（与 `protocol::ModelPlacement` 同构）。
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRequest {
    #[serde(default)]
    pub(crate) offset: [f32; 3],
    #[serde(default = "default_placement_scale")]
    pub(crate) scale: f32,
    #[serde(default)]
    pub(crate) yaw: f32,
}

fn default_placement_scale() -> f32 {
    1.0
}

impl PlacementRequest {
    pub(crate) fn to_model_placement(self) -> crate::protocol::ModelPlacement {
        crate::protocol::ModelPlacement {
            offset: crate::protocol::ModelOffset {
                x: self.offset[0],
                y: self.offset[1],
                z: self.offset[2],
            },
            scale: self.scale,
            yaw: self.yaw,
        }
    }
}

/// 稳定错误码。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenderErrorCode {
    MalformedRequest,
    UnsupportedProtocolVersion,
    UnsupportedSceneVersion,
    InvalidScene,
    ScriptSourceRejected,
    RenderFailed,
}

impl RenderErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::MalformedRequest => "malformed-request",
            Self::UnsupportedProtocolVersion => "unsupported-protocol-version",
            Self::UnsupportedSceneVersion => "unsupported-scene-version",
            Self::InvalidScene => "render-invalid-scene",
            Self::ScriptSourceRejected => "render-script-source-rejected",
            Self::RenderFailed => "render-failed",
        }
    }
}

/// 渲染响应。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResponse {
    pub(crate) request_id: String,
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
    /// PNG 字节数（PNG 本体在 JSON 之后作为 framed bytes 追加）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) png_len: Option<u32>,
}

impl RenderResponse {
    #[allow(dead_code)]
    pub(crate) fn error(
        request_id: &str,
        code: RenderErrorCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            request_id: request_id.to_owned(),
            ok: false,
            code: Some(code.as_str().to_owned()),
            message: Some(message.into()),
            width: None,
            height: None,
            png_len: None,
        }
    }
}

/// 校验请求：版本、结构、脚本源码拒绝与尺寸上限。
pub(crate) fn validate_request(request: &RenderRequest) -> Result<(), (RenderErrorCode, String)> {
    if request.protocol_version != if request.world.is_some() { WORLD_RENDERER_PROTOCOL_VERSION } else { RENDERER_PROTOCOL_VERSION } {
        // 旧 worker 收到 v2 会在此稳定拒绝，不静默忽略运动字段后返回静态帧（任务 4.1）。
        return Err((
            RenderErrorCode::UnsupportedProtocolVersion,
            format!("未知 renderer 协议版本 {}", request.protocol_version),
        ));
    }
    if !SUPPORTED_SCENE_VERSIONS.contains(&request.scene_version.as_str()) {
        return Err((
            RenderErrorCode::UnsupportedSceneVersion,
            format!("不支持的 Scene IR 版本 {}", request.scene_version),
        ));
    }
    if request.request_id.trim().is_empty() {
        return Err((
            RenderErrorCode::MalformedRequest,
            "缺少 requestId".to_owned(),
        ));
    }
    if !request.extent.is_finite() || request.extent <= 0.0 {
        return Err((RenderErrorCode::InvalidScene, "extent 非法".to_owned()));
    }
    if request.ops.is_empty() && request.world.is_none() {
        return Err((RenderErrorCode::InvalidScene, "ops 不能为空".to_owned()));
    }
    let capture = &request.capture;
    if let Some(world) = &request.world {
        world.camera.validate().map_err(|error| (RenderErrorCode::InvalidScene, error.to_owned()))?;
        if request.motion.is_some() || request.placement.is_some() || !request.ops.is_empty() {
            return Err((RenderErrorCode::InvalidScene, "World capture cannot mix model framing".into()));
        }
        let mut ids = std::collections::HashSet::new();
        for entry in &world.instances {
            entry.instance.validate().map_err(|error| (RenderErrorCode::InvalidScene, error.to_owned()))?;
            if !ids.insert(&entry.instance.instance_id) || world.camera.bound_instance_id.as_ref().is_some_and(|id| id != &entry.instance.instance_id) {
                return Err((RenderErrorCode::InvalidScene, "Invalid world capture binding".into()));
            }
        }
        if world.camera.bound_instance_id.is_some() && world.instances.len() != 1 {
            return Err((RenderErrorCode::InvalidScene, "Bound world capture requires one instance".into()));
        }
    }
    if capture.width == 0
        || capture.height == 0
        || capture.width > MAX_PREVIEW_EDGE
        || capture.height > MAX_PREVIEW_EDGE
    {
        return Err((RenderErrorCode::MalformedRequest, "预览尺寸越界".to_owned()));
    }
    if !CAPTURE_FORMATS.contains(&capture.format.as_str()) {
        return Err((RenderErrorCode::MalformedRequest, "未知 capture format".to_owned()));
    }
    if !CAMERA_PRESETS.contains(&capture.camera_preset.as_str()) {
        return Err((
            RenderErrorCode::MalformedRequest,
            "未知 camera preset".to_owned(),
        ));
    }
    if capture.background != "transparent" && !is_hex_color(&capture.background) {
        return Err((RenderErrorCode::MalformedRequest, "背景非法".to_owned()));
    }
    if let Some(motion) = &request.motion {
        if !motion.duration.is_finite() || motion.duration < 0.0 {
            return Err((
                RenderErrorCode::MalformedRequest,
                "motion duration 非法".to_owned(),
            ));
        }
        if !motion.time_seconds.is_finite()
            || motion.time_seconds < 0.0
            || motion.time_seconds > motion.duration + 1e-9
        {
            return Err((
                RenderErrorCode::MalformedRequest,
                "timeSeconds 非法".to_owned(),
            ));
        }
        if !motion.initial_camera.distance.is_finite() || motion.initial_camera.distance <= 0.0 {
            return Err((
                RenderErrorCode::MalformedRequest,
                "initialCamera 非法".to_owned(),
            ));
        }
    }
    if request.capture.camera_preset == "initial" && request.motion.is_none() {
        return Err((
            RenderErrorCode::MalformedRequest,
            "initial preset 需要 motion/initialCamera".to_owned(),
        ));
    }
    // 边界级 defense in depth：若反序列化后混入 Material 之外的未知 op 由 serde 拒绝；
    // 这里额外拒绝任何携带脚本字段的请求（结构上不可能，但显式表达契约）。
    Ok(())
}

/// 解析请求 JSON；若 JSON 中含 `modelScript`/`source` 字段则视为脚本源码注入并拒绝。
pub(crate) fn parse_request(json: &str) -> Result<RenderRequest, (RenderErrorCode, String)> {
    if json.contains("\"modelScript\"") || json.contains("\"source\"") {
        return Err((
            RenderErrorCode::ScriptSourceRejected,
            "renderer 不接受 JavaScript 源码，只接受规范化 Scene IR".to_owned(),
        ));
    }
    serde_json::from_str(json)
        .map_err(|error| (RenderErrorCode::MalformedRequest, error.to_string()))
}

fn is_hex_color(value: &str) -> bool {
    let source = value.strip_prefix('#').unwrap_or(value);
    matches!(source.len(), 3 | 6 | 8) && source.chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(test)]
#[path = "renderer_protocol_tests.rs"]
mod tests;
