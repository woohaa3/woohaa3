//! 本机录制执行器控制协议的 Rust 投影
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.3 / design D2）。
//!
//! 唯一契约来源是 `api/proto/woohaa/recording/v1alpha1/recording.proto`；本模块只做
//! **protobuf JSON 表示的 serde 投影**，不引入第二套 schema：
//! - 字段名用 ProtoJSON 的 lowerCamelCase；枚举用 ProtoJSON 的 UPPER_SNAKE 符号；
//! - 64 位整数按 ProtoJSON 以字符串承载，本模块用 `u64_str` 兼容字符串与数字；
//! - `ControlMessage.payload` 对应 protobuf `oneof`：同一 JSON 里最多一个 payload 键，
//!   多于一个或缺失都是非法消息；
//! - 版本、任务身份、sequence、分块上限在**解析阶段**校验，解析失败就拒绝，不进入业务。
//!
//! 本模块不依赖 Bevy，可在任何 feature 下编译与单测；跨语言 fixtures 见
//! `web/contracts/fixtures/recording-protocol/control-messages.json`，由 TS 与 Rust
//! 两侧共同消费。

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// 控制协议版本；`api/proto` 的 `RECORDING_PROTOCOL_VERSION_1_ALPHA_1`。
pub const RECORDING_PROTOCOL_VERSION: &str = "RECORDING_PROTOCOL_VERSION_1_ALPHA_1";
/// 控制消息体上限（与 proto 注释一致）：元数据帧不得超过 8 MiB。
pub const MAX_CONTROL_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
/// 资源/成片分块上限：每块至多 1 MiB，禁止一次传整段媒体或逐帧 RGBA JSON。
pub const MAX_RESOURCE_CHUNK_BYTES: usize = 1024 * 1024;
/// 快照 schema；worker 只接受自己编译版本生成的快照。
pub const RECORDING_SNAPSHOT_SCHEMA_VERSION: &str = "woohaa-recording-snapshot-v1";

/// 稳定错误码；与 TS 侧 `RECORDING_ERROR_CODES` 一致。
pub const ERROR_PROTOCOL_VERSION_MISMATCH: &str = "recording-protocol-version-mismatch";
pub const ERROR_MALFORMED_MESSAGE: &str = "recording-malformed-message";
pub const ERROR_UNKNOWN_PAYLOAD: &str = "recording-unknown-payload";
pub const ERROR_IDENTITY_INCOMPLETE: &str = "recording-identity-incomplete";
pub const ERROR_STALE_EPOCH: &str = "recording-stale-epoch";
pub const ERROR_CHUNK_TOO_LARGE: &str = "recording-chunk-too-large";
pub const ERROR_UNKNOWN_ENUM: &str = "recording-unknown-enum";
pub const ERROR_SEQUENCE_OUT_OF_ORDER: &str = "recording-sequence-out-of-order";

/// 把 ProtoJSON 的 64 位整数（字符串）或普通数字读成 `u64`。
fn de_u64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    use serde::de::Error as _;
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => text.parse::<u64>().map_err(D::Error::custom),
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| D::Error::custom("expected unsigned 64-bit integer")),
        other => Err(D::Error::custom(format!(
            "expected ProtoJSON uint64, got {other}"
        ))),
    }
}

fn de_u64_opt<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    use serde::de::Error as _;
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(None),
        Value::String(text) => text.parse::<u64>().map(Some).map_err(D::Error::custom),
        Value::Number(number) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| D::Error::custom("expected unsigned 64-bit integer")),
        other => Err(D::Error::custom(format!(
            "expected ProtoJSON uint64, got {other}"
        ))),
    }
}

/// 记录任务的完整身份；任何字段缺失都拒绝，避免「按旧 attempt 覆盖新结果」。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobIdentity {
    #[serde(default)]
    pub job_id: String,
    #[serde(default)]
    pub attempt_id: String,
    #[serde(default)]
    pub executor_instance_id: String,
    #[serde(default, deserialize_with = "de_u64")]
    pub execution_epoch: u64,
    #[serde(default)]
    pub snapshot_hash: String,
    #[serde(default)]
    pub content_identity: String,
    #[serde(default)]
    pub profile_key: String,
}

impl JobIdentity {
    /// 身份是否完整（7 个字段全部非空，epoch 可为 0）。
    pub fn is_complete(&self) -> bool {
        !self.job_id.is_empty()
            && !self.attempt_id.is_empty()
            && !self.executor_instance_id.is_empty()
            && !self.snapshot_hash.is_empty()
            && !self.content_identity.is_empty()
            && !self.profile_key.is_empty()
    }

    /// 是否为同一任务的不同尝试或不同执行代际（用于拒绝迟到结果）。
    pub fn supersedes(&self, other: &Self) -> bool {
        self.job_id == other.job_id
            && (self.attempt_id != other.attempt_id
                || self.executor_instance_id != other.executor_instance_id
                || self.execution_epoch != other.execution_epoch)
    }
}

/// 录制用途；参考录制可因源变化变 stale，显式导出固定提交时版本。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecordingPurpose {
    #[default]
    #[serde(rename = "RECORDING_PURPOSE_UNSPECIFIED")]
    Unspecified,
    #[serde(rename = "RECORDING_PURPOSE_REFERENCE")]
    Reference,
    #[serde(rename = "RECORDING_PURPOSE_EXPORT")]
    Export,
}

impl RecordingPurpose {
    /// 严格解析 ProtoJSON 符号；整数与未知符号都拒绝（未知枚举不能被当成默认值）。
    pub fn parse(symbol: &str) -> Option<Self> {
        match symbol {
            "RECORDING_PURPOSE_UNSPECIFIED" => Some(Self::Unspecified),
            "RECORDING_PURPOSE_REFERENCE" => Some(Self::Reference),
            "RECORDING_PURPOSE_EXPORT" => Some(Self::Export),
            _ => None,
        }
    }
}

/// 宿主可见的生命周期。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobState {
    #[default]
    #[serde(rename = "RECORDING_JOB_STATE_UNSPECIFIED")]
    Unspecified,
    #[serde(rename = "RECORDING_JOB_STATE_QUEUED")]
    Queued,
    #[serde(rename = "RECORDING_JOB_STATE_PREPARING")]
    Preparing,
    #[serde(rename = "RECORDING_JOB_STATE_RENDERING")]
    Rendering,
    #[serde(rename = "RECORDING_JOB_STATE_PAUSED")]
    Paused,
    #[serde(rename = "RECORDING_JOB_STATE_ENCODING")]
    Encoding,
    #[serde(rename = "RECORDING_JOB_STATE_UPLOADING")]
    Uploading,
    #[serde(rename = "RECORDING_JOB_STATE_COMMITTING")]
    Committing,
    #[serde(rename = "RECORDING_JOB_STATE_SUCCEEDED")]
    Succeeded,
    #[serde(rename = "RECORDING_JOB_STATE_CANCELLED")]
    Cancelled,
    #[serde(rename = "RECORDING_JOB_STATE_FAILED")]
    Failed,
    #[serde(rename = "RECORDING_JOB_STATE_STALE")]
    Stale,
}

impl JobState {
    pub fn parse(symbol: &str) -> Option<Self> {
        Some(match symbol {
            "RECORDING_JOB_STATE_UNSPECIFIED" => Self::Unspecified,
            "RECORDING_JOB_STATE_QUEUED" => Self::Queued,
            "RECORDING_JOB_STATE_PREPARING" => Self::Preparing,
            "RECORDING_JOB_STATE_RENDERING" => Self::Rendering,
            "RECORDING_JOB_STATE_PAUSED" => Self::Paused,
            "RECORDING_JOB_STATE_ENCODING" => Self::Encoding,
            "RECORDING_JOB_STATE_UPLOADING" => Self::Uploading,
            "RECORDING_JOB_STATE_COMMITTING" => Self::Committing,
            "RECORDING_JOB_STATE_SUCCEEDED" => Self::Succeeded,
            "RECORDING_JOB_STATE_CANCELLED" => Self::Cancelled,
            "RECORDING_JOB_STATE_FAILED" => Self::Failed,
            "RECORDING_JOB_STATE_STALE" => Self::Stale,
            _ => return None,
        })
    }

    /// 终态一旦出现不得回退（迟到 progress 不能复活任务）。
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Cancelled | Self::Failed | Self::Stale
        )
    }
}

/// 失败阶段；区分「真正 readiness 超时」与「执行器不在 / 编码不支持」。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorStage {
    #[default]
    #[serde(rename = "RECORDING_ERROR_STAGE_UNSPECIFIED")]
    Unspecified,
    #[serde(rename = "RECORDING_ERROR_STAGE_CAPABILITY")]
    Capability,
    #[serde(rename = "RECORDING_ERROR_STAGE_COMPILE")]
    Compile,
    #[serde(rename = "RECORDING_ERROR_STAGE_RESOURCE_FETCH")]
    ResourceFetch,
    #[serde(rename = "RECORDING_ERROR_STAGE_DECODE")]
    Decode,
    #[serde(rename = "RECORDING_ERROR_STAGE_FRAME_READY")]
    FrameReady,
    #[serde(rename = "RECORDING_ERROR_STAGE_READBACK")]
    Readback,
    #[serde(rename = "RECORDING_ERROR_STAGE_ENCODE")]
    Encode,
    #[serde(rename = "RECORDING_ERROR_STAGE_MUX")]
    Mux,
    #[serde(rename = "RECORDING_ERROR_STAGE_UPLOAD")]
    Upload,
    #[serde(rename = "RECORDING_ERROR_STAGE_COMMIT")]
    Commit,
    #[serde(rename = "RECORDING_ERROR_STAGE_EXECUTOR_LOST")]
    ExecutorLost,
}

impl ErrorStage {
    pub fn parse(symbol: &str) -> Option<Self> {
        Some(match symbol {
            "RECORDING_ERROR_STAGE_UNSPECIFIED" => Self::Unspecified,
            "RECORDING_ERROR_STAGE_CAPABILITY" => Self::Capability,
            "RECORDING_ERROR_STAGE_COMPILE" => Self::Compile,
            "RECORDING_ERROR_STAGE_RESOURCE_FETCH" => Self::ResourceFetch,
            "RECORDING_ERROR_STAGE_DECODE" => Self::Decode,
            "RECORDING_ERROR_STAGE_FRAME_READY" => Self::FrameReady,
            "RECORDING_ERROR_STAGE_READBACK" => Self::Readback,
            "RECORDING_ERROR_STAGE_ENCODE" => Self::Encode,
            "RECORDING_ERROR_STAGE_MUX" => Self::Mux,
            "RECORDING_ERROR_STAGE_UPLOAD" => Self::Upload,
            "RECORDING_ERROR_STAGE_COMMIT" => Self::Commit,
            "RECORDING_ERROR_STAGE_EXECUTOR_LOST" => Self::ExecutorLost,
            _ => return None,
        })
    }
}

/// 结构化失败；`transient` 决定参考录制是否按退避重试。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingError {
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default, deserialize_with = "de_u64_opt")]
    pub frame_index: Option<u64>,
    #[serde(default)]
    pub sample_time: Option<f64>,
    #[serde(default)]
    pub subject_id: String,
    #[serde(default)]
    pub transient: bool,
}

impl RecordingError {
    /// 阶段符号必须是已声明枚举，否则宿主无法按阶段反馈。
    pub fn stage_known(&self) -> bool {
        self.stage.is_empty() || ErrorStage::parse(&self.stage).is_some()
    }
}

/// 一条控制消息的 envelope：版本 + 单调 sequence + 唯一 payload。
///
/// `payload` 保留为 JSON 对象，由 [`parse_control_message`] 保证「恰好一个键」；
/// 各 payload 的具体结构在需要时用 `serde_json::from_value` 投影到强类型。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEnvelope {
    #[serde(default)]
    pub protocol_version: String,
    #[serde(default, deserialize_with = "de_u64")]
    pub sequence: u64,
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

/// 解析失败原因：稳定错误码 + 可读说明（不含凭据或媒体内容）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// 已校验 envelope 的序列号游标：同一 (jobId, attemptId) 的 sequence 必须严格递增。
///
/// 乱序/重复消息被丢弃而不是覆盖状态；终态由调用方另行保证不可复活。
#[derive(Debug, Default)]
pub struct SequenceGuard {
    last: std::collections::HashMap<(String, String), u64>,
}

impl SequenceGuard {
    /// 接受并推进游标；重复或倒退返回 `false`。
    pub fn accept(&mut self, job_id: &str, attempt_id: &str, sequence: u64) -> bool {
        let key = (job_id.to_owned(), attempt_id.to_owned());
        match self.last.get(&key) {
            Some(last) if sequence <= *last => false,
            _ => {
                self.last.insert(key, sequence);
                true
            }
        }
    }

    /// 已接受的最大 sequence；未知任务返回 `None`。
    pub fn last(&self, job_id: &str, attempt_id: &str) -> Option<u64> {
        self.last
            .get(&(job_id.to_owned(), attempt_id.to_owned()))
            .copied()
    }
}

/// 校验一条控制消息的版本、payload 唯一性、身份完整与已知枚举。
///
/// 通过后调用方再用 `serde_json::from_value(envelope.payload_value())` 投影到具体类型。
pub fn parse_control_message(json: &str) -> Result<ControlEnvelope, ProtocolError> {
    if json.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(ProtocolError::new(
            ERROR_MALFORMED_MESSAGE,
            format!("控制消息超过 {MAX_CONTROL_MESSAGE_BYTES} 字节上限"),
        ));
    }
    let envelope: ControlEnvelope = serde_json::from_str(json)
        .map_err(|error| ProtocolError::new(ERROR_MALFORMED_MESSAGE, error.to_string()))?;
    if envelope.protocol_version != RECORDING_PROTOCOL_VERSION {
        return Err(ProtocolError::new(
            ERROR_PROTOCOL_VERSION_MISMATCH,
            format!(
                "协议版本不兼容：期望 {RECORDING_PROTOCOL_VERSION}，收到 {}",
                if envelope.protocol_version.is_empty() {
                    "<空>"
                } else {
                    &envelope.protocol_version
                }
            ),
        ));
    }
    if envelope.payload.len() != 1 {
        return Err(ProtocolError::new(
            ERROR_UNKNOWN_PAYLOAD,
            format!(
                "控制消息必须恰好包含一个 payload，收到 {} 个：{:?}",
                envelope.payload.len(),
                envelope.payload.keys().collect::<Vec<_>>()
            ),
        ));
    }
    let (name, value) = envelope
        .payload
        .iter()
        .next()
        .expect("payload map has exactly one entry");
    validate_payload(name, value)?;
    Ok(envelope)
}

impl ControlEnvelope {
    /// 唯一 payload 的 `(名称, 值)`。
    pub fn payload_value(&self) -> Option<(&str, &Value)> {
        self.payload.iter().next().map(|(name, value)| (name.as_str(), value))
    }
}

/// 已声明的 payload 名称；未知名称在解析期拒绝（不能静默忽略新消息）。
pub const CONTROL_PAYLOADS: [&str; 19] = [
    "capabilityRequest",
    "capabilityResponse",
    "submitJob",
    "submitJobResponse",
    "getJob",
    "listJobs",
    "jobList",
    "cancelJob",
    "cancelJobResponse",
    "pauseJob",
    "resumeJob",
    "jobControlResponse",
    "leaseHeartbeat",
    "leaseRenewal",
    "progress",
    "frameDiagnostic",
    "stateChanged",
    "artifactChunkRequest",
    "artifactChunk",
];

fn validate_payload(name: &str, value: &Value) -> Result<(), ProtocolError> {
    if !CONTROL_PAYLOADS.contains(&name) {
        return Err(ProtocolError::new(
            ERROR_UNKNOWN_PAYLOAD,
            format!("未知控制 payload：{name}"),
        ));
    }
    // 携带完整任务身份的 payload：身份不完整直接拒绝，避免按半份身份归并状态。
    const JOB_SCOPED: [&str; 12] = [
        "submitJobResponse",
        "getJob",
        "cancelJob",
        "cancelJobResponse",
        "pauseJob",
        "resumeJob",
        "jobControlResponse",
        "leaseHeartbeat",
        "leaseRenewal",
        "progress",
        "frameDiagnostic",
        "stateChanged",
    ];
    if JOB_SCOPED.contains(&name) && !(
        matches!(name, "leaseHeartbeat" | "leaseRenewal")
        && value.get("job").is_none()
        && value.get("executorInstanceId").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
    ) {
        let job = value.get("job").unwrap_or(&Value::Null);
        let identity: JobIdentity = serde_json::from_value(job.clone())
            .map_err(|error| ProtocolError::new(ERROR_IDENTITY_INCOMPLETE, error.to_string()))?;
        if !identity.is_complete() {
            return Err(ProtocolError::new(
                ERROR_IDENTITY_INCOMPLETE,
                format!("{name} 缺少完整任务身份（jobId/attemptId/executorInstanceId/snapshotHash/contentIdentity/profileKey）"),
            ));
        }
    }
    if let Some(stage) = value.get("error").and_then(|error| error.get("stage")) {
        if let Some(symbol) = stage.as_str() {
            if !symbol.is_empty() && ErrorStage::parse(symbol).is_none() {
                return Err(ProtocolError::new(
                    ERROR_UNKNOWN_ENUM,
                    format!("未知失败阶段枚举：{symbol}"),
                ));
            }
        }
    }
    Ok(())
}

/// 校验一个资源/成片分块的偏移与大小；乱序或超限都在写入前拒绝。
pub fn validate_chunk(offset: u64, data_len: usize, expected_offset: u64) -> Result<(), ProtocolError> {
    if data_len > MAX_RESOURCE_CHUNK_BYTES {
        return Err(ProtocolError::new(
            ERROR_CHUNK_TOO_LARGE,
            format!("分块 {data_len} 字节超过 {MAX_RESOURCE_CHUNK_BYTES} 字节上限"),
        ));
    }
    if offset != expected_offset {
        return Err(ProtocolError::new(
            ERROR_SEQUENCE_OUT_OF_ORDER,
            format!("分块偏移乱序：期望 {expected_offset}，收到 {offset}"),
        ));
    }
    Ok(())
}

/// 拒绝来自其它 worktree 或旧 execution epoch 的结果。
///
/// `current` 是执行器/宿主当前认账的尝试；任何身份不一致都返回 `false`。
pub fn accepts_result(current: &JobIdentity, incoming: &JobIdentity) -> bool {
    current == incoming
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(job: &str, attempt: &str) -> JobIdentity {
        JobIdentity {
            job_id: job.into(),
            attempt_id: attempt.into(),
            executor_instance_id: "exec-1".into(),
            execution_epoch: 7,
            snapshot_hash: "snap".into(),
            content_identity: "content".into(),
            profile_key: "profile".into(),
        }
    }

    #[test]
    fn parses_identity_with_string_uint64() {
        let json = r#"{"jobId":"j","attemptId":"a","executorInstanceId":"e","executionEpoch":"18446744073709551615","snapshotHash":"s","contentIdentity":"c","profileKey":"p"}"#;
        let parsed: JobIdentity = serde_json::from_str(json).expect("uint64 string");
        assert_eq!(parsed.execution_epoch, u64::MAX);
        assert!(parsed.is_complete());
    }

    #[test]
    fn rejects_protocol_version_mismatch() {
        let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_9","sequence":"1","capabilityRequest":{}}"#;
        let error = parse_control_message(json).expect_err("version mismatch");
        assert_eq!(error.code, ERROR_PROTOCOL_VERSION_MISMATCH);
    }

    #[test]
    fn rejects_multiple_payloads() {
        let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","capabilityRequest":{},"listJobs":{}}"#;
        let error = parse_control_message(json).expect_err("two payloads");
        assert_eq!(error.code, ERROR_UNKNOWN_PAYLOAD);
    }

    #[test]
    fn rejects_incomplete_job_identity() {
        let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","cancelJob":{"job":{"jobId":"j"}}}"#;
        let error = parse_control_message(json).expect_err("identity incomplete");
        assert_eq!(error.code, ERROR_IDENTITY_INCOMPLETE);
    }

    #[test]
    fn rejects_unknown_stage_enum() {
        let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","stateChanged":{"job":{"jobId":"j","attemptId":"a","executorInstanceId":"e","executionEpoch":"1","snapshotHash":"s","contentIdentity":"c","profileKey":"p"},"state":"RECORDING_JOB_STATE_RENDERING","error":{"stage":"RECORDING_ERROR_STAGE_TELEPORT"}}}"#;
        let error = parse_control_message(json).expect_err("unknown enum");
        assert_eq!(error.code, ERROR_UNKNOWN_ENUM);
    }

    #[test]
    fn accepts_job_scoped_message_with_complete_identity() {
        let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"9","progress":{"job":{"jobId":"j","attemptId":"a","executorInstanceId":"e","executionEpoch":"3","snapshotHash":"s","contentIdentity":"c","profileKey":"p"},"state":"RECORDING_JOB_STATE_RENDERING","completedFrames":"4","totalFrames":"10","sampleTime":0.5}}"#;
        let envelope = parse_control_message(json).expect("valid");
        assert_eq!(envelope.sequence, 9);
        assert_eq!(envelope.payload_value().map(|(name, _)| name), Some("progress"));
    }

    #[test]
    fn sequence_guard_drops_out_of_order_and_duplicate() {
        let mut guard = SequenceGuard::default();
        assert!(guard.accept("j", "a", 1));
        assert!(guard.accept("j", "a", 2));
        assert!(!guard.accept("j", "a", 2));
        assert!(!guard.accept("j", "a", 1));
        assert_eq!(guard.last("j", "a"), Some(2));
        // 新 attempt 独立计数，旧 attempt 的游标不被复用。
        assert!(guard.accept("j", "b", 1));
    }

    #[test]
    fn stale_epoch_and_attempt_are_rejected() {
        let current = identity("j", "a");
        assert!(accepts_result(&current, &current));
        assert!(!accepts_result(&current, &identity("j", "b")));
        let mut other_epoch = identity("j", "a");
        other_epoch.execution_epoch = 8;
        assert!(!accepts_result(&current, &other_epoch));
        assert!(other_epoch.supersedes(&current));
        assert!(!current.supersedes(&current));
    }

    #[test]
    fn chunk_budget_and_offset_are_enforced() {
        assert!(validate_chunk(0, MAX_RESOURCE_CHUNK_BYTES, 0).is_ok());
        assert_eq!(
            validate_chunk(0, MAX_RESOURCE_CHUNK_BYTES + 1, 0)
                .expect_err("oversized")
                .code,
            ERROR_CHUNK_TOO_LARGE
        );
        assert_eq!(
            validate_chunk(10, 4, 4).expect_err("out of order").code,
            ERROR_SEQUENCE_OUT_OF_ORDER
        );
    }

    #[test]
    fn terminal_states_are_classified() {
        assert!(JobState::Succeeded.is_terminal());
        assert!(JobState::Cancelled.is_terminal());
        assert!(JobState::Failed.is_terminal());
        assert!(JobState::Stale.is_terminal());
        assert!(!JobState::Committing.is_terminal());
        assert!(!JobState::Paused.is_terminal());
    }

    #[test]
    fn purpose_and_state_parsers_reject_unknown_symbols() {
        assert_eq!(RecordingPurpose::parse("RECORDING_PURPOSE_EXPORT"), Some(RecordingPurpose::Export));
        assert_eq!(RecordingPurpose::parse("EXPORT"), None);
        assert_eq!(JobState::parse("RECORDING_JOB_STATE_COMMITTING"), Some(JobState::Committing));
        assert_eq!(JobState::parse("COMMITTING"), None);
    }
}
