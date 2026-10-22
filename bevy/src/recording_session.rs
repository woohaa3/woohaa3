//! 把协议里的 `submitJob` payload 装配成可执行任务
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.1 / 4.3）。
//!
//! 输入是**冻结快照**（ProtoJSON）。这里只做「解析 + 校验 + 组装配件」：
//! - 时间表参数（ratio、时长）与 profile 尺寸；
//! - 渲染计划（复用 `recording_prepare`）；
//! - 编码器选项与输出路径（私有目录内，文件名由内部生成）。
//!
//! 不做业务判断（权限、源是否存在、内容版本）——那些在宿主侧完成。
//! 只有 `recording-worker` feature 编译。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::recording_encode::EncoderProfile;
use crate::recording_job::{ProbeFailure, RecordingJobInput};
use crate::recording_openh264::OpenH264EncoderOptions;
use crate::recording_prepare::prepare_render_plan;
use crate::recording_probe_gpu::RecordingRenderPlan;
use crate::recording_protocol::{JobIdentity, RECORDING_SNAPSHOT_SCHEMA_VERSION};

/// 装配结果。
///
/// 手写 `Debug`：`RecordingJobInput` 含资源目录，`RecordingRenderPlan` 含大数组，
/// 只在测试断言里需要可打印，避免 derive 后误把内容打进日志。
pub struct PreparedSubmit {
    pub job: RecordingJobInput,
    pub plan: RecordingRenderPlan,
    pub encoder_options: OpenH264EncoderOptions,
}

impl std::fmt::Debug for PreparedSubmit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedSubmit")
            .field("attempt", &self.job.identity.attempt_id)
            .field("size", &(self.job.width, self.job.height))
            .field("output", &self.encoder_options.output)
            .finish()
    }
}

fn fail(code: &'static str, message: impl Into<String>) -> ProbeFailure {
    ProbeFailure { stage: "RECORDING_ERROR_STAGE_COMPILE", code, message: message.into() }
}

/// 读取必需的正整数（ProtoJSON 用字符串承载 64 位整数）。
fn required_u64(payload: &Value, path: &[&str]) -> Result<u64, ProbeFailure> {
    let mut cursor = payload;
    for segment in path {
        cursor = cursor
            .get(*segment)
            .ok_or_else(|| fail("recording-snapshot-invalid", format!("缺少字段 {}", path.join("."))))?;
    }
    match cursor {
        Value::String(text) => text
            .parse::<u64>()
            .map_err(|_| fail("recording-snapshot-invalid", format!("{} 不是合法整数", path.join(".")))),
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| fail("recording-snapshot-invalid", format!("{} 不是合法整数", path.join(".")))),
        _ => Err(fail("recording-snapshot-invalid", format!("{} 类型非法", path.join(".")))),
    }
}

fn required_str<'a>(payload: &'a Value, path: &[&str]) -> Result<&'a str, ProbeFailure> {
    let mut cursor = payload;
    for segment in path {
        cursor = cursor
            .get(*segment)
            .ok_or_else(|| fail("recording-snapshot-invalid", format!("缺少字段 {}", path.join("."))))?;
    }
    cursor
        .as_str()
        .ok_or_else(|| fail("recording-snapshot-invalid", format!("{} 类型非法", path.join("."))))
}

/// 解析 `submitJob` payload 为可执行任务。
pub fn prepare_submit(payload: &Value, work_dir: Option<&Path>) -> Result<PreparedSubmit, ProbeFailure> {
    let schema = required_str(payload, &["snapshot", "schemaVersion"])?;
    if schema != RECORDING_SNAPSHOT_SCHEMA_VERSION {
        return Err(ProbeFailure {
            stage: "RECORDING_ERROR_STAGE_CAPABILITY",
            code: "recording-snapshot-schema-unsupported",
            message: format!("不支持的快照 schema：{schema}"),
        });
    }
    let identity = read_identity(payload)?;
    let width = u32::try_from(required_u64(payload, &["snapshot", "profile", "width"])?)
        .map_err(|_| fail("recording-snapshot-invalid", "宽度超出范围"))?;
    let height = u32::try_from(required_u64(payload, &["snapshot", "profile", "height"])?)
        .map_err(|_| fail("recording-snapshot-invalid", "高度超出范围"))?;
    let bitrate = u32::try_from(required_u64(payload, &["snapshot", "profile", "bitrate"]).unwrap_or(4_000_000))
        .unwrap_or(4_000_000);
    let fps_numer = u32::try_from(required_u64(payload, &["snapshot", "timing", "frameRateNumer"])?)
        .map_err(|_| fail("recording-snapshot-invalid", "帧率分子超出范围"))?;
    let fps_denom = u32::try_from(required_u64(payload, &["snapshot", "timing", "frameRateDenom"])?)
        .map_err(|_| fail("recording-snapshot-invalid", "帧率分母超出范围"))?;
    if fps_denom == 0 {
        return Err(fail("recording-snapshot-invalid", "帧率分母不能为 0"));
    }
    let duration_numer = required_u64(payload, &["snapshot", "timing", "durationNumer"])?;
    let duration_denom = required_u64(payload, &["snapshot", "timing", "durationDenom"])?;
    if duration_numer == 0 || duration_denom == 0 {
        return Err(fail("recording-invalid-duration", "时长必须为正"));
    }

    let decode_json = |text: &str| -> Result<String, ProbeFailure> {
        // ProtoJSON bytes use base64. Raw JSON remains accepted by in-process tests.
        if text.trim_start().starts_with('{') { return Ok(text.to_owned()); }
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(text)
            .map_err(|_| fail("recording-snapshot-invalid", "快照 JSON 编码非法"))?;
        String::from_utf8(bytes).map_err(|_| fail("recording-snapshot-invalid", "快照不是 UTF-8"))
    };
    let scene_ir_json = decode_json(required_str(payload, &["snapshot", "sceneIrJson"])?)?;
    let motion_json = decode_json(required_str(payload, &["snapshot", "motionJson"])?)?;
    let background = payload
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("background"))
        .and_then(|value| value.as_str())
        .unwrap_or("#000000");
    let mut plan = prepare_render_plan(&scene_ir_json, &motion_json, width, height, background)?;
    // 媒体声明：把冻结的 playback 映射与真实内容类型带进渲染计划。
    let resources = payload
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("resources"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for resource in &resources {
        let resource_id = resource
            .get("resourceId")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_owned();
        if resource_id.is_empty() {
            continue;
        }
        let number = |key: &str| resource.get(key).and_then(|value| value.as_f64()).unwrap_or(0.0);
        plan.media_playback.push(crate::recording_probe_gpu::RecordingMediaPlayback {
            resource_id: resource_id.clone(),
            start_time: number("startTime"),
            time_scale: if number("timeScale") > 0.0 { number("timeScale") } else { 1.0 },
            looped: resource.get("looped").and_then(|value| value.as_bool()).unwrap_or(false),
            end_time: number("endTime"),
            media_duration: number("mediaDuration"),
        });
        if let Some(content_type) = resource.get("contentType").and_then(|value| value.as_str()) {
            plan.media_content_types.insert(resource_id, content_type.to_owned());
        }
    }

    let directory = work_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("wo-recording-work"));
    std::fs::create_dir_all(&directory).map_err(|error| {
        fail("recording-workdir-failed", format!("无法创建任务目录：{error}"))
    })?;
    let output_name = format!("artifact-{}", sanitize(&identity.attempt_id));

    let job = RecordingJobInput {
        identity: identity.clone(),
        width,
        height,
        fps_numer,
        fps_denom,
        duration_numer,
        duration_denom,
        bitrate,
        // 资源声明进入任务：worker 在 `prepare` 里解码并绑定到渲染计划。
        resources: resource_declarations(&resources, &directory)?,
        directory: directory.clone(),
        output_name: output_name.clone(),
    };
    let profile = EncoderProfile { width, height, bitrate, fps_numer, fps_denom };
    let encoder_options = OpenH264EncoderOptions {
        output: directory.join(format!("{output_name}.mp4")),
        spool: directory.join(format!("{output_name}.spool")),
        profile,
        keyframe_interval_frames: None,
    };
    Ok(PreparedSubmit { job, plan, encoder_options })
}

/// 把快照里的 `resources` 转成接收器声明。
///
/// 文件路径由**内部序号**生成（见 `recording_resources`），不使用快照里的字符串；
/// 因此路径注入不可能成立，而 checksum 校验仍绑定真实字节。
fn resource_declarations(
    resources: &[Value],
    _directory: &Path,
) -> Result<Vec<crate::recording_resources::ResourceDeclaration>, ProbeFailure> {
    use crate::recording_resources::{MAX_RESOURCE_BYTES, ResourceDeclaration};
    let mut declarations = Vec::with_capacity(resources.len());
    for (index, resource) in resources.iter().enumerate() {
        let resource_id = resource
            .get("resourceId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| fail("recording-snapshot-invalid", "素材缺少 resourceId"))?;
        let checksum = resource
            .get("checksum")
            .and_then(|value| value.as_str())
            .ok_or_else(|| fail("recording-snapshot-invalid", "素材缺少 checksum"))?;
        let content_type = resource
            .get("contentType")
            .and_then(|value| value.as_str())
            .ok_or_else(|| fail("recording-snapshot-invalid", "素材缺少 contentType"))?;
        let size_bytes = resource
            .get("sizeBytes")
            .and_then(|value| value.as_str().and_then(|text| text.parse::<u64>().ok()).or_else(|| value.as_u64()))
            .unwrap_or(0);
        if size_bytes == 0 || size_bytes > MAX_RESOURCE_BYTES {
            return Err(fail("recording-resource-too-large", "素材大小超出预算"));
        }
        // 序号决定落地文件名，与实际写入顺序一致。
        let _ = index;
        declarations.push(ResourceDeclaration {
            resource_id: resource_id.to_owned(),
            checksum: checksum.to_owned(),
            content_type: content_type.to_owned(),
            size_bytes,
        });
    }
    Ok(declarations)
}

fn read_identity(payload: &Value) -> Result<JobIdentity, ProbeFailure> {
    let identity = JobIdentity {
        job_id: required_str(payload, &["job", "jobId"])?.to_owned(),
        attempt_id: required_str(payload, &["job", "attemptId"])?.to_owned(),
        executor_instance_id: required_str(payload, &["job", "executorInstanceId"])?.to_owned(),
        execution_epoch: required_u64(payload, &["job", "executionEpoch"])?,
        snapshot_hash: required_str(payload, &["job", "snapshotHash"])?.to_owned(),
        content_identity: required_str(payload, &["job", "contentIdentity"])?.to_owned(),
        profile_key: required_str(payload, &["job", "profileKey"])?.to_owned(),
    };
    if !identity.is_complete() {
        return Err(fail("recording-identity-incomplete", "任务身份不完整"));
    }
    Ok(identity)
}

/// 文件名只允许 ASCII 安全字符；attempt id 来自宿主但仍做最小化清洗。
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "attempt".to_owned()
    } else {
        cleaned
    }
}

/// 供测试/文档：默认输出路径的后缀。
pub fn output_path_for(directory: &Path, attempt_id: &str) -> PathBuf {
    directory.join(format!("artifact-{}.mp4", sanitize(attempt_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "sequence": "1",
            "requestId": "r1",
            "purpose": "RECORDING_PURPOSE_EXPORT",
            "priority": "RECORDING_PRIORITY_EXPORT",
            "job": {
                "jobId": "job-1",
                "attemptId": "attempt-1",
                "executorInstanceId": "exec-1",
                "executionEpoch": "1",
                "snapshotHash": "snap",
                "contentIdentity": "content",
                "profileKey": "profile"
            },
            "snapshot": {
                "schemaVersion": RECORDING_SNAPSHOT_SCHEMA_VERSION,
                "profile": { "width": 320, "height": 180, "bitrate": "2000000", "container": "RECORDING_CONTAINER_MP4" },
                "timing": {
                    "frameRateNumer": "30", "frameRateDenom": "1",
                    "durationNumer": "12", "durationDenom": "30"
                },
                "background": "#101418",
                "sceneIrJson": "{\"sceneVersion\":\"woohaa-model-scene-ir-v2\",\"signature\":\"s\",\"extent\":4.0,\"ops\":[{\"t\":\"box\",\"id\":\"b\",\"size\":[1,1,1],\"color\":\"#ffffff\"}]}",
                "motionJson": "{\"duration\":2.0,\"looped\":false,\"cameraMotion\":[],\"modelMotion\":[],\"objects\":[],\"initialCamera\":{\"azimuth\":0.5,\"elevation\":0.5,\"distance\":4.0,\"focusOffset\":[0,0,0],\"aspect\":\"16:9\"},\"timeSeconds\":0}"
            }
        })
    }

    #[test]
    fn assembles_a_runnable_job() {
        let prepared = prepare_submit(&payload(), None).expect("prepare");
        assert_eq!(prepared.job.width, 320);
        assert_eq!(prepared.job.height, 180);
        assert_eq!(prepared.job.fps_numer, 30);
        assert_eq!((prepared.job.duration_numer, prepared.job.duration_denom), (12, 30));
        assert_eq!(prepared.job.identity.attempt_id, "attempt-1");
        assert_eq!(prepared.encoder_options.profile.width, 320);
        assert!(prepared.encoder_options.output.to_string_lossy().ends_with("artifact-attempt-1.mp4"));
        assert_eq!(prepared.plan.capture.width, 320);
    }

    #[test]
    fn rejects_unsupported_schema_with_capability_stage() {
        let mut value = payload();
        value["snapshot"]["schemaVersion"] = json!("woohaa-recording-snapshot-v0");
        let error = prepare_submit(&value, None).expect_err("schema");
        assert_eq!(error.code, "recording-snapshot-schema-unsupported");
        assert_eq!(error.stage, "RECORDING_ERROR_STAGE_CAPABILITY");
    }

    #[test]
    fn rejects_incomplete_identity() {
        let mut value = payload();
        value["job"]["snapshotHash"] = json!("");
        let error = prepare_submit(&value, None).expect_err("identity");
        assert_eq!(error.code, "recording-identity-incomplete");
    }

    #[test]
    fn rejects_zero_duration_and_zero_frame_rate() {
        let mut zero_duration = payload();
        zero_duration["snapshot"]["timing"]["durationNumer"] = json!("0");
        assert_eq!(
            prepare_submit(&zero_duration, None).expect_err("duration").code,
            "recording-invalid-duration"
        );

        let mut zero_fps = payload();
        zero_fps["snapshot"]["timing"]["frameRateDenom"] = json!("0");
        assert_eq!(
            prepare_submit(&zero_fps, None).expect_err("fps").code,
            "recording-snapshot-invalid"
        );
    }

    #[test]
    fn never_uses_caller_strings_as_paths() {
        let mut value = payload();
        value["job"]["attemptId"] = json!("../../escape");
        let prepared = prepare_submit(&value, None).expect("prepare");
        let path = prepared.encoder_options.output.to_string_lossy().into_owned();
        assert!(!path.contains(".."), "输出路径不得包含上级跳转：{path}");
        assert_eq!(
            output_path_for(Path::new("/tmp/x"), "../../escape"),
            Path::new("/tmp/x/artifact-______escape.mp4")
        );
    }

    #[test]
    fn rejects_malformed_ir_before_rendering() {
        let mut bad_scene = payload();
        // Valid ProtoJSON bytes containing invalid Scene IR must reach the IR validator.
        use base64::Engine;
        bad_scene["snapshot"]["sceneIrJson"] = json!(
            base64::engine::general_purpose::STANDARD.encode(b"not json")
        );
        assert_eq!(
            prepare_submit(&bad_scene, None).expect_err("scene").code,
            "recording-scene-ir-invalid"
        );

        let mut bad_motion = payload();
        bad_motion["snapshot"]["motionJson"] = json!("{}");
        assert_eq!(
            prepare_submit(&bad_motion, None).expect_err("motion").code,
            "recording-motion-invalid"
        );
    }
}
