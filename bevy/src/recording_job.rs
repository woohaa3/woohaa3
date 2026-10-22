//! 录制任务执行编排
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.2 / 3.4 / design D4）。
//!
//! 把「时间表 + 帧屏障 + 资源接收 + 编码」串成一次任务：
//!
//! ```text
//! submitJob（冻结快照）
//!   → 接收资源分块（checksum 校验）
//!   → 逐帧：应用 T → 屏障就绪 → 读回 RGBA → 推进编码
//!   → finish（mux + 成片自查）
//!   → 交付成片事实
//! ```
//!
//! 本模块把**取帧**抽象成 [`FrameProbe`]：真实实现由带 GPU 的 Bevy App 提供，
//! 因此这里可以在无 GPU 环境完整测试时间、屏障推进、回压与取消，而不会伪造像素。

use std::path::PathBuf;

use crate::recording_barrier::{
    BarrierBudget, BarrierFailure, BarrierStage, FrameBarrier, FrameIdentity,
};
use crate::recording_encode::{
    EncodeFailure, EncodeStage, EncoderFrame, EncoderProfile, VideoEncoder,
};
use crate::recording_protocol::{JobIdentity, RECORDING_SNAPSHOT_SCHEMA_VERSION};
use crate::recording_resources::{
    ResourceDeclaration, ResourceFailure, ResourceReceiver, WrittenResource,
};
use crate::recording_timeline::{build_timeline, FrameSlot, Rational, TimelineError};

/// 冻结快照的 worker 侧投影（只保留渲染/编码需要的字段）。
#[derive(Clone, Debug)]
pub struct RecordingJobInput {
    pub identity: JobIdentity,
    pub width: u32,
    pub height: u32,
    pub fps_numer: u32,
    pub fps_denom: u32,
    /// 时长（秒的有理表示）。
    pub duration_numer: u64,
    pub duration_denom: u64,
    pub bitrate: u32,
    pub resources: Vec<ResourceDeclaration>,
    /// 任务私有目录（接收资源与写临时成片）。
    pub directory: PathBuf,
    pub output_name: String,
}

/// 一次取帧的请求：**只**含一个时刻与帧身份，不含像素。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameRequest {
    pub frame: FrameIdentity,
    /// 采样时刻（秒）；由时间表给出，取帧方不得自行加减。
    pub sample_seconds_micros: u64,
    /// 该帧的呈现时长（有理数，秒）；末帧短于一帧时由时间表给出，探针不得自行假设 1/F。
    pub duration_numer: u64,
    pub duration_denom: u64,
}

/// 取帧结果：真实 RGBA 或结构化失败。
pub enum FrameOutcome {
    /// 帧已就绪并回读。
    Frame(EncoderFrame),
    /// 屏障未就绪（缺媒体/相机/管线/真实 pass）。
    NotReady(BarrierFailure),
    /// 设备丢失。
    DeviceLost,
    /// 取消。
    Cancelled,
}

/// 取帧端口：真实实现由无窗口 Bevy App 提供。
pub trait FrameProbe {
    /// 按任务开始时确定的资源准备（解码/上传）；失败即整任务失败。
    fn prepare(&mut self, resources: &[WrittenResource]) -> Result<(), ProbeFailure>;
    /// 取一帧；`barrier` 由本模块管理，探针只负责推进并回读。
    fn sample(&mut self, request: &FrameRequest, barrier: &mut FrameBarrier) -> FrameOutcome;
}

/// 探针失败（解码/上传阶段）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeFailure {
    pub stage: &'static str,
    pub code: &'static str,
    pub message: String,
}

/// 任务结论；失败带真实阶段与帧信息。
///
/// 含 `f64` 采样时刻，因此只实现 `PartialEq`。
#[derive(Clone, Debug, PartialEq)]
pub enum JobOutcome {
    Completed {
        artifact_path: PathBuf,
        size_bytes: u64,
        content_sha256: String,
        frame_count: u64,
        duration_numer: u64,
        duration_denom: u64,
        width: u32,
        height: u32,
    },
    Failed {
        stage: &'static str,
        code: &'static str,
        message: String,
        frame_index: Option<u32>,
        sample_time: Option<f64>,
    },
    Cancelled {
        frame_index: Option<u32>,
    },
}

/// 执行一次任务。
///
/// `cancel` 每帧检查一次：取消发生在帧边界，不打断当前 GPU pass。
pub fn run_job(
    input: &RecordingJobInput,
    probe: &mut dyn FrameProbe,
    encoder: &mut dyn VideoEncoder,
    cancelled: &dyn Fn() -> bool,
    budget: BarrierBudget,
) -> JobOutcome {
    if input.identity.snapshot_hash.is_empty() || input.identity.job_id.is_empty() {
        return JobOutcome::Failed {
            stage: "RECORDING_ERROR_STAGE_CAPABILITY",
            code: "recording-identity-incomplete",
            message: "任务身份不完整".into(),
            frame_index: None,
            sample_time: None,
        };
    }
    let duration = match Rational::new(input.duration_numer, input.duration_denom) {
        Some(value) if value.numer > 0 => value,
        _ => {
            return JobOutcome::Failed {
                stage: "RECORDING_ERROR_STAGE_COMPILE",
                code: "recording-invalid-duration",
                message: "任务时长非法".into(),
                frame_index: None,
                sample_time: None,
            }
        }
    };
    let fps = match Rational::new(u64::from(input.fps_numer), u64::from(input.fps_denom.max(1))) {
        Some(value) if value.numer > 0 => value,
        _ => {
            return JobOutcome::Failed {
                stage: "RECORDING_ERROR_STAGE_COMPILE",
                code: "recording-invalid-frame-rate",
                message: "任务帧率非法".into(),
                frame_index: None,
                sample_time: None,
            }
        }
    };
    let timeline = match build_timeline(duration, fps) {
        Ok(slots) => slots,
        Err(error) => return timeline_failure(error),
    };

    let profile = EncoderProfile {
        width: input.width,
        height: input.height,
        bitrate: input.bitrate,
        fps_numer: input.fps_numer,
        fps_denom: input.fps_denom.max(1),
    };
    if let Err(error) = profile.validate() {
        return encode_failure(&error, None, None);
    }

    // 资源必须在本机收齐并校验通过后才开始渲染。
    let mut receiver = match ResourceReceiver::new(&input.directory, input.resources.clone()) {
        Ok(receiver) => receiver,
        Err(error) => return resource_failure(&error),
    };
    // 资源流写入的私有文件先接管（逐块校验大小与 checksum）；仍缺则明确失败。
    if !input.resources.is_empty() {
        if let Err(error) = receiver.adopt_existing_files() {
            receiver.cancel();
            return resource_failure(&error);
        }
    }
    if !input.resources.is_empty() && !receiver.is_complete() {
        // 宿主通过独立资源流发送分块；没有分块时明确失败，而不是用占位纹理继续。
        let error = ResourceFailure {
            code: "recording-resource-missing",
            message: "尚未收到素材分块".into(),
        };
        receiver.cancel();
        return resource_failure(&error);
    }
    let resources = match receiver.finish() {
        Ok(resources) => resources,
        Err(error) => return resource_failure(&error),
    };
    if let Err(failure) = probe.prepare(&resources) {
        return JobOutcome::Failed {
            stage: failure.stage,
            code: failure.code,
            message: failure.message,
            frame_index: None,
            sample_time: None,
        };
    }

    for slot in &timeline {
        if cancelled() {
            return JobOutcome::Cancelled { frame_index: Some(slot.index) };
        }
        let identity = frame_identity(input, slot, fps);
        let mut barrier = FrameBarrier::begin(identity.clone(), budget);
        let sample = slot.sample.as_seconds();
        let request = FrameRequest {
            frame: identity,
            sample_seconds_micros: (sample * 1_000_000.0).round() as u64,
            // 末帧可能是 D-(N-1)/F（短于一帧）；编码器必须拿到真实值，否则成片会被拉长。
            duration_numer: slot.duration.numer,
            duration_denom: slot.duration.denom,
        };
        match probe.sample(&request, &mut barrier) {
            FrameOutcome::Frame(frame) => {
                if let Err(error) = encoder.push(frame) {
                    return encode_failure(&error, Some(slot.index), Some(slot.sample.as_seconds()));
                }
            }
            FrameOutcome::NotReady(failure) => {
                return barrier_outcome(&failure, slot);
            }
            FrameOutcome::DeviceLost => {
                return JobOutcome::Failed {
                    stage: "RECORDING_ERROR_STAGE_FRAME_READY",
                    code: "recording-device-lost",
                    message: "GPU 设备丢失".into(),
                    frame_index: Some(slot.index),
                    sample_time: Some(slot.sample.as_seconds()),
                };
            }
            FrameOutcome::Cancelled => {
                return JobOutcome::Cancelled { frame_index: Some(slot.index) };
            }
        }
    }

    match encoder.finish() {
        Ok(artifact) => JobOutcome::Completed {
            artifact_path: artifact.path,
            size_bytes: artifact.size_bytes,
            content_sha256: artifact.content_sha256,
            frame_count: artifact.frame_count,
            duration_numer: duration.numer,
            duration_denom: duration.denom,
            width: artifact.width,
            height: artifact.height,
        },
        Err(error) => encode_failure(&error, None, None),
    }
}

fn frame_identity(input: &RecordingJobInput, slot: &FrameSlot, _fps: Rational) -> FrameIdentity {
    FrameIdentity {
        job_id: input.identity.job_id.clone(),
        attempt_id: input.identity.attempt_id.clone(),
        execution_epoch: input.identity.execution_epoch,
        snapshot_hash: input.identity.snapshot_hash.clone(),
        frame_index: slot.index,
        sample: slot.sample,
        // 相机 generation 由探针在应用场景后确认；这里用 0 表示「由本次采样决定」。
        camera_generation: 0,
        // 媒体身份由快照声明；真实探针按 resourceId@T 绑定。
        media_identities: input
            .resources
            .iter()
            .map(|resource| format!("{}@{}", resource.resource_id, slot.sample.as_seconds()))
            .collect(),
    }
}

fn timeline_failure(error: TimelineError) -> JobOutcome {
    JobOutcome::Failed {
        stage: "RECORDING_ERROR_STAGE_COMPILE",
        code: error.code(),
        message: match error {
            TimelineError::ZeroDuration => "片段时长为零".into(),
            TimelineError::ZeroFrameRate => "帧率为零".into(),
            TimelineError::TooManyFrames => "片段帧数超过预算".into(),
        },
        frame_index: None,
        sample_time: None,
    }
}

fn resource_failure(error: &ResourceFailure) -> JobOutcome {
    JobOutcome::Failed {
        stage: error.proto_stage(),
        code: error.code,
        message: error.message.clone(),
        frame_index: None,
        sample_time: None,
    }
}

fn barrier_outcome(failure: &BarrierFailure, slot: &FrameSlot) -> JobOutcome {
    JobOutcome::Failed {
        stage: match failure.stage() {
            BarrierStage::Applied => "RECORDING_ERROR_STAGE_FRAME_READY",
            BarrierStage::MediaReady => "RECORDING_ERROR_STAGE_DECODE",
            BarrierStage::PipelineReady | BarrierStage::Rendered => "RECORDING_ERROR_STAGE_FRAME_READY",
            BarrierStage::Readback => "RECORDING_ERROR_STAGE_READBACK",
        },
        code: failure.code(),
        message: match failure {
            BarrierFailure::Timeout { stage, waited_ms } => {
                format!("{} 超时（{waited_ms}ms）", stage.code())
            }
            BarrierFailure::StaleAck { reason, .. } => reason.clone(),
            BarrierFailure::MissingMedia { missing } => format!("缺少媒体帧：{}", missing.join(", ")),
            BarrierFailure::DeviceLost { .. } => "GPU 设备丢失".into(),
            BarrierFailure::Cancelled { .. } => "已取消".into(),
        },
        frame_index: Some(slot.index),
        sample_time: Some(slot.sample.as_seconds()),
    }
}

fn encode_failure(error: &EncodeFailure, frame_index: Option<u32>, sample_time: Option<f64>) -> JobOutcome {
    JobOutcome::Failed {
        stage: match error.stage {
            EncodeStage::Encode => "RECORDING_ERROR_STAGE_ENCODE",
            EncodeStage::Mux => "RECORDING_ERROR_STAGE_MUX",
        },
        code: error.code,
        message: error.message.clone(),
        frame_index,
        sample_time,
    }
}

/// 快照 schema 是否受支持；不支持时在接受任务前拒绝。
pub fn supports_snapshot_schema(schema_version: &str) -> bool {
    schema_version == RECORDING_SNAPSHOT_SCHEMA_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_encode::{EncodedArtifact, sha256_hex};

    struct NullProbe {
        prepared: bool,
        seen: usize,
    }

    impl FrameProbe for NullProbe {
        fn prepare(&mut self, _resources: &[WrittenResource]) -> Result<(), ProbeFailure> {
            self.prepared = true;
            Ok(())
        }

        fn sample(&mut self, request: &FrameRequest, _barrier: &mut FrameBarrier) -> FrameOutcome {
            self.seen += 1;
            FrameOutcome::Frame(EncoderFrame {
                rgba: vec![0u8; 4],
                width: 2,
                height: 2,
                pts_seconds: request.sample_seconds_micros as f64 / 1_000_000.0,
                duration_seconds: 1.0 / 30.0,
            })
        }
    }

    struct NotReadyProbe;

    impl FrameProbe for NotReadyProbe {
        fn prepare(&mut self, _resources: &[WrittenResource]) -> Result<(), ProbeFailure> {
            Ok(())
        }

        fn sample(&mut self, _request: &FrameRequest, _barrier: &mut FrameBarrier) -> FrameOutcome {
            FrameOutcome::NotReady(BarrierFailure::Timeout {
                stage: BarrierStage::Rendered,
                waited_ms: 5_000,
            })
        }
    }

    struct FailingPrepare;

    impl FrameProbe for FailingPrepare {
        fn prepare(&mut self, _resources: &[WrittenResource]) -> Result<(), ProbeFailure> {
            Err(ProbeFailure {
                stage: "RECORDING_ERROR_STAGE_DECODE",
                code: "recording-media-unsupported",
                message: "不支持的编码".into(),
            })
        }

        fn sample(&mut self, _request: &FrameRequest, _barrier: &mut FrameBarrier) -> FrameOutcome {
            FrameOutcome::Cancelled
        }
    }

    struct CountingEncoder {
        frames: Vec<EncoderFrame>,
        finish_error: Option<EncodeFailure>,
    }

    impl VideoEncoder for CountingEncoder {
        fn push(&mut self, frame: EncoderFrame) -> Result<(), EncodeFailure> {
            self.frames.push(frame);
            Ok(())
        }

        fn finish(&mut self) -> Result<EncodedArtifact, EncodeFailure> {
            if let Some(error) = self.finish_error.take() {
                return Err(error);
            }
            Ok(EncodedArtifact {
                path: PathBuf::from("/tmp/artifact.mp4"),
                size_bytes: 1_024,
                content_sha256: sha256_hex(b"x"),
                width: 2,
                height: 2,
                frame_count: self.frames.len() as u64,
                duration_seconds: 0.1,
                has_audio: false,
            })
        }

        fn cancel(&mut self) -> Result<(), EncodeFailure> {
            Ok(())
        }
    }

    fn input(duration_numer: u64, duration_denom: u64) -> RecordingJobInput {
        RecordingJobInput {
            identity: JobIdentity {
                job_id: "job".into(),
                attempt_id: "attempt".into(),
                executor_instance_id: "exec".into(),
                execution_epoch: 1,
                snapshot_hash: "snap".into(),
                content_identity: "content".into(),
                profile_key: "profile".into(),
            },
            width: 2,
            height: 2,
            fps_numer: 30,
            fps_denom: 1,
            duration_numer,
            duration_denom,
            bitrate: 100_000,
            resources: Vec::new(),
            directory: std::env::temp_dir().join("wo-job-run"),
            output_name: "out".into(),
        }
    }

    #[test]
    fn runs_every_frame_in_the_timeline_and_reports_total_duration() {
        let job = input(1, 1);
        let mut probe = NullProbe { prepared: false, seen: 0 };
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let outcome = run_job(&job, &mut probe, &mut encoder, &|| false, BarrierBudget::default());
        assert!(probe.prepared);
        assert_eq!(probe.seen, 30);
        match outcome {
            JobOutcome::Completed { frame_count, duration_numer, duration_denom, .. } => {
                assert_eq!(frame_count, 30);
                assert_eq!((duration_numer, duration_denom), (1, 1));
            }
            other => panic!("expected completion, got {other:?}"),
        }
    }

    #[test]
    fn non_integer_duration_produces_the_ceil_frame_count() {
        // 1.05s @30fps → 32 帧。
        let job = input(105, 100);
        let mut probe = NullProbe { prepared: false, seen: 0 };
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        run_job(&job, &mut probe, &mut encoder, &|| false, BarrierBudget::default());
        assert_eq!(probe.seen, 32);
    }

    #[test]
    fn cancellation_is_honored_at_the_frame_boundary() {
        let job = input(1, 1);
        let mut probe = NullProbe { prepared: false, seen: 0 };
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let calls = std::cell::Cell::new(0u32);
        let outcome = run_job(
            &job,
            &mut probe,
            &mut encoder,
            &|| {
                // 取消检查在每帧开头调用一次；第 4 次起返回 true。
                let next = calls.get() + 1;
                calls.set(next);
                next > 3
            },
            BarrierBudget::default()
        );
        assert!(matches!(outcome, JobOutcome::Cancelled { .. }));
    }

    #[test]
    fn readiness_failure_reports_the_real_stage_and_frame() {
        let job = input(1, 1);
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let outcome = run_job(&job, &mut NotReadyProbe, &mut encoder, &|| false, BarrierBudget::default());
        match outcome {
            JobOutcome::Failed { stage, code, frame_index, sample_time, .. } => {
                assert_eq!(stage, "RECORDING_ERROR_STAGE_FRAME_READY");
                assert_eq!(code, "capture-readiness-timeout");
                assert_eq!(frame_index, Some(0));
                assert!(sample_time.is_some());
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn decode_prepare_failure_has_the_decode_stage() {
        let job = input(1, 1);
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let outcome = run_job(&job, &mut FailingPrepare, &mut encoder, &|| false, BarrierBudget::default());
        match outcome {
            JobOutcome::Failed { stage, code, .. } => {
                assert_eq!(stage, "RECORDING_ERROR_STAGE_DECODE");
                assert_eq!(code, "recording-media-unsupported");
            }
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_duration_and_frame_rate_before_rendering() {
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let zero = run_job(
            &input(0, 1),
            &mut NullProbe { prepared: false, seen: 0 },
            &mut encoder,
            &|| false,
            BarrierBudget::default()
        );
        assert!(matches!(zero, JobOutcome::Failed { code: "recording-invalid-duration", .. }));

        let mut bad_fps = input(1, 1);
        bad_fps.fps_numer = 0;
        let outcome = run_job(
            &bad_fps,
            &mut NullProbe { prepared: false, seen: 0 },
            &mut encoder,
            &|| false,
            BarrierBudget::default()
        );
        assert!(matches!(outcome, JobOutcome::Failed { code: "recording-invalid-frame-rate", .. }));
    }

    #[test]
    fn rejects_empty_identity_at_the_worker_boundary() {
        let mut job = input(1, 1);
        job.identity.snapshot_hash = String::new();
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let outcome = run_job(
            &job,
            &mut NullProbe { prepared: false, seen: 0 },
            &mut encoder,
            &|| false,
            BarrierBudget::default()
        );
        assert!(matches!(outcome, JobOutcome::Failed { code: "recording-identity-incomplete", .. }));
    }

    #[test]
    fn mux_failure_is_reported_after_rendering() {
        let job = input(1, 30);
        let mut encoder = CountingEncoder {
            frames: Vec::new(),
            finish_error: Some(EncodeFailure::new(EncodeStage::Mux, "recording-artifact-too-large", "too big"))
        };
        let outcome = run_job(
            &job,
            &mut NullProbe { prepared: false, seen: 0 },
            &mut encoder,
            &|| false,
            BarrierBudget::default()
        );
        match outcome {
            JobOutcome::Failed { stage, code, .. } => {
                assert_eq!(stage, "RECORDING_ERROR_STAGE_MUX");
                assert_eq!(code, "recording-artifact-too-large");
            }
            other => panic!("expected mux failure, got {other:?}"),
        }
    }

    #[test]
    fn missing_resources_fail_before_rendering() {
        let mut job = input(1, 1);
        job.resources = vec![ResourceDeclaration {
            resource_id: "clip:video".into(),
            checksum: "a".repeat(64),
            content_type: "video/mp4".into(),
            size_bytes: 16,
        }];
        let mut probe = NullProbe { prepared: false, seen: 0 };
        let mut encoder = CountingEncoder { frames: Vec::new(), finish_error: None };
        let outcome = run_job(&job, &mut probe, &mut encoder, &|| false, BarrierBudget::default());
        match outcome {
            JobOutcome::Failed { stage, code, .. } => {
                assert_eq!(stage, "RECORDING_ERROR_STAGE_RESOURCE_FETCH");
                assert_eq!(code, "recording-resource-missing");
            }
            other => panic!("expected resource failure, got {other:?}"),
        }
        assert!(!probe.prepared, "缺素材时不应开始渲染");
    }

    #[test]
    fn snapshot_schema_is_versioned() {
        assert!(supports_snapshot_schema(RECORDING_SNAPSHOT_SCHEMA_VERSION));
        assert!(!supports_snapshot_schema("woohaa-recording-snapshot-v0"));
    }
}
