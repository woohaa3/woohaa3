//! worker 的控制帧写出与 `submitJob` 执行
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.1）。
//!
//! `shot-recorder` 的入口只保留参数解析与循环；真正的「解析快照 → GPU 探针 + 编码器 →
//! 跑时间表 → 写回结果」放在这里，便于单测与保持入口可读。

use std::io::Write;

use serde_json::json;

use crate::recording_protocol::RECORDING_PROTOCOL_VERSION;

thread_local! {
    static ACTIVE_JOB: std::cell::RefCell<Option<serde_json::Value>> = const { std::cell::RefCell::new(None) };
}

pub fn write_frame(text: &str) {
    let mut message: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return,
    };
    ACTIVE_JOB.with(|job| {
        if let Some(job) = job.borrow().as_ref() {
            for key in ["stateChanged", "progress", "jobControlResponse"] {
                if let Some(payload) = message.get_mut(key).and_then(|value| value.as_object_mut())
                {
                    payload.insert("job".into(), job.clone());
                }
            }
        }
    });
    let text = message.to_string();
    let bytes = text.as_bytes();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&(bytes.len() as u32).to_be_bytes());
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

/// 写一条失败状态；`job_id` 缺失时只报阶段（例如协议错误）。
pub fn write_state_failure(
    sequence: u64,
    job_id: Option<&str>,
    stage: &str,
    code: &str,
    message: &str,
) {
    let mut payload = json!({
        "protocolVersion": RECORDING_PROTOCOL_VERSION,
        "sequence": sequence.to_string(),
        "stateChanged": {
            "sequence": sequence.to_string(),
            "state": "RECORDING_JOB_STATE_FAILED",
            "error": { "stage": stage, "code": code, "message": message }
        }
    });
    if let Some(job_id) = job_id {
        if let Some(state) = payload
            .get_mut("stateChanged")
            .and_then(|value| value.as_object_mut())
        {
            state.insert("job".into(), json!({ "jobId": job_id }));
        }
    }
    write_frame(&payload.to_string());
}

/// 写一条控制确认（cancel/pause/resume）。
pub fn write_control_ack(sequence: u64, state: &str) {
    write_frame(
        &json!({
            "protocolVersion": RECORDING_PROTOCOL_VERSION,
            "sequence": sequence.to_string(),
            "jobControlResponse": {
                "sequence": sequence.to_string(),
                "state": state,
                "applied": true
            }
        })
        .to_string(),
    );
}

/// 执行一次 `submitJob`：解析快照 → 装配 GPU 探针与编码器 → 按时间表跑完 → 回成片事实。
///
/// 失败按阶段回报；任何阶段失败都不留下成片（`ArtifactFile` 的 Drop 负责清理）。
pub fn run_submit_job(sequence: u64, text: &str) {
    let envelope = match crate::recording_protocol::parse_control_message(text) {
        Ok(envelope) => envelope,
        Err(error) => {
            write_state_failure(
                sequence,
                None,
                "RECORDING_ERROR_STAGE_CAPABILITY",
                error.code,
                &error.message,
            );
            return;
        }
    };
    let Some((_, payload)) = envelope.payload_value() else {
        write_state_failure(
            sequence,
            None,
            "RECORDING_ERROR_STAGE_CAPABILITY",
            "recording-malformed-message",
            "缺少 payload",
        );
        return;
    };
    ACTIVE_JOB.with(|job| *job.borrow_mut() = payload.get("job").cloned());
    let job_id = payload
        .get("job")
        .and_then(|job| job.get("jobId"))
        .and_then(|id| id.as_str())
        .map(str::to_owned);

    let prepared =
        match crate::recording_session::prepare_submit(payload, default_work_dir().as_deref()) {
            Ok(prepared) => prepared,
            Err(failure) => {
                write_state_failure(
                    sequence,
                    job_id.as_deref(),
                    failure.stage,
                    failure.code,
                    &failure.message,
                );
                return;
            }
        };

    let crate::recording_session::PreparedSubmit {
        job,
        plan,
        encoder_options,
    } = prepared;
    let probe = match crate::recording_probe_gpu::GpuFrameProbe::new(plan) {
        Ok(probe) => probe,
        Err(failure) => {
            write_state_failure(
                sequence,
                job_id.as_deref(),
                failure.stage,
                failure.code,
                &failure.message,
            );
            return;
        }
    };
    let mut encoder = match crate::recording_openh264::OpenH264Encoder::create(encoder_options) {
        Ok(encoder) => encoder,
        Err(error) => {
            write_state_failure(
                sequence,
                job_id.as_deref(),
                "RECORDING_ERROR_STAGE_CAPABILITY",
                error.code,
                &error.message,
            );
            return;
        }
    };

    let total = ((job.duration_numer as f64 / job.duration_denom as f64) * job.fps_numer as f64
        / job.fps_denom as f64)
        .ceil() as u32;
    let mut probe = ProgressProbe {
        inner: probe,
        sequence,
        completed: 0,
        total,
    };
    let outcome = crate::recording_job::run_job(
        &job,
        &mut probe,
        &mut encoder,
        &|| false,
        crate::recording_barrier::BarrierBudget::default(),
    );
    report_outcome(sequence, job_id.as_deref(), outcome);
}

/// worker 的私有工作目录（由 supervisor 通过环境变量指定）。
pub const ENV_WORK_DIR: &str = "WOOHAA3_RECORDING_WORK_DIR";

fn default_work_dir() -> Option<std::path::PathBuf> {
    std::env::var(ENV_WORK_DIR)
        .ok()
        .map(std::path::PathBuf::from)
}

fn report_outcome(sequence: u64, job_id: Option<&str>, outcome: crate::recording_job::JobOutcome) {
    use crate::recording_job::JobOutcome;
    match outcome {
        JobOutcome::Completed {
            artifact_path,
            size_bytes,
            content_sha256,
            frame_count,
            duration_numer,
            duration_denom,
            width,
            height,
        } => {
            write_frame(
                &serde_json::json!({
                    "protocolVersion": RECORDING_PROTOCOL_VERSION,
                    "sequence": sequence.to_string(),
                    "stateChanged": {
                        "sequence": sequence.to_string(),
                        "state": "RECORDING_JOB_STATE_SUCCEEDED",
                        "artifact": {
                            "path": artifact_path.to_string_lossy(),
                            "sizeBytes": size_bytes.to_string(),
                            "contentSha256": content_sha256,
                            "frameCount": frame_count.to_string(),
                            "durationNumer": duration_numer.to_string(),
                            "durationDenom": duration_denom.to_string(),
                            "width": width,
                            "height": height,
                            "container": "RECORDING_CONTAINER_MP4",
                            "codec": "RECORDING_VIDEO_CODEC_H264",
                            "mimeType": "video/mp4"
                        }
                    }
                })
                .to_string(),
            );
        }
        JobOutcome::Failed {
            stage,
            code,
            message,
            frame_index,
            sample_time,
        } => {
            let mut payload = serde_json::json!({
                "protocolVersion": RECORDING_PROTOCOL_VERSION,
                "sequence": sequence.to_string(),
                "stateChanged": {
                    "sequence": sequence.to_string(),
                    "state": "RECORDING_JOB_STATE_FAILED",
                    "error": {
                        "stage": stage,
                        "code": code,
                        "message": message,
                        "frameIndex": frame_index.map(|index| index.to_string()),
                        "sampleTime": sample_time
                    }
                }
            });
            if let Some(job_id) = job_id {
                if let Some(state) = payload
                    .get_mut("stateChanged")
                    .and_then(|value| value.as_object_mut())
                {
                    state.insert("job".into(), serde_json::json!({ "jobId": job_id }));
                }
            }
            write_frame(&payload.to_string());
        }
        JobOutcome::Cancelled { frame_index } => {
            write_frame(
                &serde_json::json!({
                    "protocolVersion": RECORDING_PROTOCOL_VERSION,
                    "sequence": sequence.to_string(),
                    "stateChanged": {
                        "sequence": sequence.to_string(),
                        "state": "RECORDING_JOB_STATE_CANCELLED",
                        "frameIndex": frame_index.map(|index| index.to_string())
                    }
                })
                .to_string(),
            );
        }
    }
}

struct ProgressProbe {
    inner: crate::recording_probe_gpu::GpuFrameProbe,
    sequence: u64,
    completed: u32,
    total: u32,
}
impl crate::recording_job::FrameProbe for ProgressProbe {
    fn prepare(
        &mut self,
        resources: &[crate::recording_resources::WrittenResource],
    ) -> Result<(), crate::recording_job::ProbeFailure> {
        self.inner.prepare(resources)
    }
    fn sample(
        &mut self,
        request: &crate::recording_job::FrameRequest,
        barrier: &mut crate::recording_barrier::FrameBarrier,
    ) -> crate::recording_job::FrameOutcome {
        let frame = self.inner.sample(request, barrier);
        if matches!(frame, crate::recording_job::FrameOutcome::Frame(_)) {
            self.completed += 1;
            write_frame(&json!({"protocolVersion": RECORDING_PROTOCOL_VERSION, "sequence": self.sequence.to_string(),
                "progress": {"sequence": self.sequence.to_string(), "state": "RECORDING_JOB_STATE_RENDERING", "completedFrames": self.completed, "totalFrames": self.total}}).to_string());
        }
        frame
    }
}
