//! 真实 GPU 取帧探针
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.2 / 3.5）。
//!
//! 复用**既有**离屏渲染入口 `model3d::preview::render_rgba`（同一份场景构建、ShotCamera 取景
//! 数学、GPU 资产/管线就绪判定与 readback），而不是再写一套渲染：
//! - 每个采样时刻传一个 `RenderRequest`（编译后的 Scene IR + 该时刻的 motion 求值）；
//! - 拿到 RGBA8 直接交给编码器，不落 PNG、不经过页面、不共享可见可见播放 owner；
//! - 无窗口：`primary_window: None`、不启用 winit（与 `model-renderer` 同一条路径）。
//!
//! 因此 worker 与预览的差异只在**调度**（固定时间表、常驻进程、编码），渲染语义保持一致。
//!
//! 只有 `recording-gpu` feature 编译。

use crate::recording_encode::EncoderFrame;
use crate::recording_job::{FrameOutcome, FrameProbe, FrameRequest, ProbeFailure};
use crate::recording_resources::WrittenResource;
use crate::renderer_protocol::{CaptureOptions, RenderRequest};

/// 把冻结快照的编译产物转成渲染请求。
///
/// `ops` 是已经编译好的 Scene IR；本结构不含脚本源码。
///
/// `motion` 是**整条轨道**（时间线时长、相机/模型轨道、对象播放映射），逐帧只改
/// `time_seconds`；渲染器按该时刻求值，不自己推进时钟。
#[derive(Clone)]
pub struct RecordingRenderPlan {
    pub scene_version: String,
    pub signature: String,
    pub extent: f32,
    pub ops: Vec<crate::protocol::ModelOp>,
    pub(crate) media_planes: Vec<RecordingMediaPlane>,
    pub(crate) composite_asset_frame: Option<crate::renderer_protocol::CompositeAssetFrameRequest>,
    pub motion: crate::renderer_protocol::MotionRequest,
    pub capture: CaptureOptions,
    /// 每个媒体资源的冻结 playback 映射（资源 id → 映射）。
    pub media_playback: Vec<RecordingMediaPlayback>,
    /// 每个媒体资源的真实内容类型（决定用图片还是视频解码）。
    pub media_content_types: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingMediaPlane {
    resource_id: String,
    #[serde(flatten)]
    plane: crate::protocol::ModelMediaPlane,
}

/// 冻结的媒体播放映射（与 contracts / proto `ResourceDescriptor` 同语义）。
#[derive(Clone, Debug, PartialEq)]
pub struct RecordingMediaPlayback {
    pub resource_id: String,
    pub start_time: f64,
    pub time_scale: f64,
    pub looped: bool,
    pub end_time: f64,
    pub media_duration: f64,
}

impl std::fmt::Debug for RecordingRenderPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 不打印 ops 全文（可能很大），只给可定位的摘要。
        formatter
            .debug_struct("RecordingRenderPlan")
            .field("scene_version", &self.scene_version)
            .field("signature", &self.signature)
            .field("extent", &self.extent)
            .field("ops", &format_args!("{} ops", self.ops.len()))
            .field("size", &(self.capture.width, self.capture.height))
            .finish()
    }
}

impl RecordingRenderPlan {
    /// 生成 `time_seconds` 时刻的渲染请求。
    pub fn request_at(&self, time_seconds: f32, request_id: &str) -> RenderRequest {
        let mut motion = self.motion.clone();
        motion.time_seconds = time_seconds;
        let mut request = RenderRequest::for_recording(
            request_id.to_owned(),
            self.scene_version.clone(),
            self.signature.clone(),
            self.extent,
            self.ops.clone(),
            self.capture.clone(),
            motion,
        );
        request.composite_asset_frame = self.composite_asset_frame.clone();
        request
    }
}

/// 真实 GPU 探针。
///
/// 每次采样启动一次离屏渲染（与预览同一入口）；不创建窗口、不依赖页面。
pub struct GpuFrameProbe {
    plan: RecordingRenderPlan,
    requested_size: (u32, u32),
    /// 已注册的媒体源（由 `prepare` 填充）；采样时按冻结 playback 映射取帧。
    #[cfg(feature = "recording-media")]
    media: Vec<(crate::recording_media::MediaSource, crate::recording_media::PlaybackMap)>,
    #[cfg(feature = "recording-media")]
    decoder: Option<crate::recording_media_native::NativeMediaDecoder>,
    #[cfg(feature = "recording-media")]
    cache: crate::recording_media::FrameCache,
}

impl GpuFrameProbe {
    /// 校验尺寸并记录计划；真正的 GPU 可用性在第一次采样时暴露为明确失败。
    pub fn new(plan: RecordingRenderPlan) -> Result<Self, ProbeFailure> {
        if plan.capture.width == 0 || plan.capture.height == 0 {
            return Err(ProbeFailure {
                stage: "RECORDING_ERROR_STAGE_CAPABILITY",
                code: "recording-invalid-size",
                message: "录制尺寸必须为正".into(),
            });
        }
        // H.264 要求偶数尺寸；奇数直接拒绝而不是悄悄裁一像素。
        if plan.capture.width % 2 != 0 || plan.capture.height % 2 != 0 {
            return Err(ProbeFailure {
                stage: "RECORDING_ERROR_STAGE_CAPABILITY",
                code: "recording-invalid-size",
                message: "H.264 录制尺寸必须是偶数".into(),
            });
        }
        Ok(Self {
            requested_size: (plan.capture.width, plan.capture.height),
            plan,
            #[cfg(feature = "recording-media")]
            media: Vec::new(),
            #[cfg(feature = "recording-media")]
            decoder: None,
            #[cfg(feature = "recording-media")]
            cache: crate::recording_media::FrameCache::new(64),
        })
    }

    /// 采样尺寸。
    pub fn size(&self) -> (u32, u32) {
        self.requested_size
    }
}

impl FrameProbe for GpuFrameProbe {
    fn prepare(&mut self, resources: &[WrittenResource]) -> Result<(), ProbeFailure> {
        // 场景由冻结快照的 IR 携带；媒体在这里**解码一次**并登记，采样时按 T 取帧。
        #[cfg(feature = "recording-media")]
        {
            use crate::recording_media::{DecodeBudget, MediaSource};
            let mut decoder = crate::recording_media_native::NativeMediaDecoder::new(DecodeBudget::default());
            let mut media = Vec::with_capacity(resources.len());
            for resource in resources {
                if self.plan.composite_asset_frame.is_none() || !self.plan.media_planes.iter().any(|plane| plane.resource_id == resource.resource_id) {
                    return Err(ProbeFailure { stage: "RECORDING_ERROR_STAGE_COMPILE", code: "recording-media-plane-missing", message: format!("素材 {} 缺少冻结平面", resource.resource_id) });
                }
                // 快照里的 playback 由 `recording_session` 写入 plan；缺声明时用默认（首帧）。
                let playback = self
                    .plan
                    .media_playback
                    .iter()
                    .find(|entry| entry.resource_id == resource.resource_id)
                    .map(|entry| crate::recording_media::PlaybackMap {
                        start_time: entry.start_time,
                        duration: entry.end_time,
                        time_scale: entry.time_scale,
                        looped: entry.looped,
                        media_duration: entry.media_duration,
                    })
                    .unwrap_or_default();
                let source = MediaSource {
                    resource_id: resource.resource_id.clone(),
                    path: resource.path.clone(),
                    content_type: self
                        .plan
                        .media_content_types
                        .get(&resource.resource_id)
                        .cloned()
                        .unwrap_or_else(|| "video/mp4".into()),
                };
                // 提交后用真实媒体时长补全映射（配置 duration 为 0 时据此取尾帧）。
                let playback = crate::recording_media::with_media_duration(&mut decoder, &source, playback)
                    .map_err(|failure| ProbeFailure {
                        stage: failure.stage.proto_symbol(),
                        code: failure.code,
                        message: failure.message,
                    })?;
                media.push((source, playback));
            }
            self.decoder = Some(decoder);
            self.media = media;
        }
        Ok(())
    }

    fn sample(&mut self, request: &FrameRequest, _barrier: &mut crate::recording_barrier::FrameBarrier) -> FrameOutcome {
        let seconds = request.sample_seconds_micros as f64 / 1_000_000.0;
        let render_request = self.plan.request_at(seconds as f32, &format!(
            "{}:{}",
            request.frame.attempt_id, request.frame.frame_index
        ));
        // 目标时刻的媒体帧：缺失/解码失败都明确失败，不用上一帧冒充。
        #[cfg(feature = "recording-media")]
        let media_frame = match self.sample_media(seconds) {
            Ok(frame) => frame,
            Err(failure) => {
                return FrameOutcome::NotReady(crate::recording_barrier::BarrierFailure::StaleAck {
                    stage: crate::recording_barrier::BarrierStage::MediaReady,
                    reason: format!("{}: {}", failure.code, failure.message),
                });
            }
        };
        #[cfg(feature = "recording-media")]
        let render_request = {
            let mut request = render_request;
            if let Some(frame) = request.composite_asset_frame.as_mut() { frame.media = media_frame; }
            request
        };
        match crate::model3d::preview::render_rgba(&render_request, &self.plan.capture) {
            Ok(rgba) => {
                let expected = (self.plan.capture.width as usize) * (self.plan.capture.height as usize) * 4;
                if rgba.len() != expected {
                    return FrameOutcome::NotReady(crate::recording_barrier::BarrierFailure::StaleAck {
                        stage: crate::recording_barrier::BarrierStage::Readback,
                        reason: format!("回读像素 {} 字节与期望 {expected} 不符", rgba.len()),
                    });
                }
                FrameOutcome::Frame(EncoderFrame {
                    rgba,
                    width: self.plan.capture.width,
                    height: self.plan.capture.height,
                    pts_seconds: seconds,
                    // 帧时长只来自时间表（含末帧短于一帧的情况），探针不自行假设 1/F。
                    duration_seconds: request.duration_numer as f64 / request.duration_denom.max(1) as f64,
                })
            }
            Err(message) => {
                // 渲染器把「没有可用 GPU 适配器」也归为 RenderFailed；据此给出能力阶段，
                // 让宿主能区分「设备不可用」与「画面没画出来」。
                if message.contains("No suitable GPU adapters") || message.contains("adapter") {
                    return FrameOutcome::NotReady(crate::recording_barrier::BarrierFailure::DeviceLost {
                        stage: crate::recording_barrier::BarrierStage::Rendered,
                    });
                }
                FrameOutcome::NotReady(crate::recording_barrier::BarrierFailure::Timeout {
                    stage: crate::recording_barrier::BarrierStage::Rendered,
                    waited_ms: 0,
                })
            }
        }
    }
}

#[cfg(feature = "recording-media")]
impl GpuFrameProbe {
    /// 按冻结映射取目标时刻的媒体帧（多源时取第一个视频；图片按自身像素）。
    fn sample_media(
        &mut self,
        timeline_seconds: f64,
    ) -> Result<Vec<crate::renderer_protocol::NativeMediaFrame>, crate::recording_media::DecodeFailure> {
        let Some(decoder) = self.decoder.as_mut() else { return Ok(Vec::new()) };
        let mut selected = Vec::new();
        for (source, playback) in self.media.clone() {
            let frame = crate::recording_media::sample_media(
                decoder,
                &mut self.cache,
                &source,
                &playback,
                timeline_seconds,
            )?;
            let plane = self.plan.media_planes.iter().find(|plane| plane.resource_id == source.resource_id)
                .expect("media plane validated during prepare");
            selected.push(crate::renderer_protocol::NativeMediaFrame {
                plane: plane.plane.clone(), width: frame.width, height: frame.height, rgba: frame.rgba,
            });
        }
        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(width: u32, height: u32) -> RecordingRenderPlan {
        RecordingRenderPlan {
            scene_version: "woohaa-model-scene-ir-v2".into(),
            signature: "sig".into(),
            extent: 4.0,
            ops: Vec::new(),
            media_planes: Vec::new(),
            composite_asset_frame: None,
            motion: crate::renderer_protocol::MotionRequest::default_for_test(1.0),
            capture: CaptureOptions {
                width,
                height,
                background: "#000000".into(),
                camera_preset: "initial".into(),
            },
            media_playback: Vec::new(),
            media_content_types: std::collections::BTreeMap::new(),
        }
    }

    fn error_code(result: Result<GpuFrameProbe, ProbeFailure>) -> &'static str {
        match result {
            Ok(_) => "ok",
            Err(failure) => failure.code,
        }
    }

    #[test]
    fn rejects_odd_and_zero_sizes_before_touching_the_gpu() {
        assert_eq!(error_code(GpuFrameProbe::new(plan(0, 720))), "recording-invalid-size");
        assert_eq!(error_code(GpuFrameProbe::new(plan(1281, 720))), "recording-invalid-size");
        assert_eq!(error_code(GpuFrameProbe::new(plan(1280, 721))), "recording-invalid-size");
        assert_eq!(error_code(GpuFrameProbe::new(plan(1280, 720))), "ok");
    }

    #[test]
    fn request_uses_the_given_sample_time_only() {
        let plan = plan(1280, 720);
        let first = plan.request_at(0.0, "a");
        let second = plan.request_at(2.5, "b");
        assert_eq!(first.motion.as_ref().map(|m| m.time_seconds), Some(0.0));
        assert_eq!(second.motion.as_ref().map(|m| m.time_seconds), Some(2.5));
        // 除时刻/请求 id 外，其余编译产物完全一致（同一冻结快照）。
        assert_eq!(first.scene_version, second.scene_version);
        assert_eq!(first.signature, second.signature);
        assert_eq!(first.ops.len(), second.ops.len());
    }

    #[test]
    fn size_is_reported_for_the_encoder() {
        let probe = match GpuFrameProbe::new(plan(1280, 720)) {
            Ok(probe) => probe,
            Err(failure) => panic!("probe should construct: {}", failure.message),
        };
        assert_eq!(probe.size(), (1280, 720));
    }
}
