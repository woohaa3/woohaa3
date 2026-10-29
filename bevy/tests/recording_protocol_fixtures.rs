//! 跨语言 golden：录制控制协议的 Rust 投影与 web/contracts 共享同一 fixture
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.3）。
//!
//! fixture 由 `web/contracts/fixtures/recording-protocol/control-messages.json` 提供；
//! TS 侧 `web/contracts/src/canvas/recording-protocol.test.ts` 断言同一批结论。
//! 这里只验证 Rust 投影，不启动任何 GPU 或进程。

use std::fs;
use std::path::Path;

use serde::Deserialize;
use woohaa_bevy_canvas::recording_protocol::{
    ERROR_IDENTITY_INCOMPLETE, ERROR_PROTOCOL_VERSION_MISMATCH, ERROR_UNKNOWN_ENUM,
    ERROR_UNKNOWN_PAYLOAD, JobIdentity, JobState, MAX_RESOURCE_CHUNK_BYTES,
    RECORDING_PROTOCOL_VERSION, SequenceGuard, accepts_result, parse_control_message,
    validate_chunk,
};

#[derive(Deserialize)]
struct Fixture {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    identity: JobIdentity,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    expect: String,
    code: Option<String>,
    message: serde_json::Value,
}

fn fixture() -> Fixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../web/contracts/fixtures/recording-protocol/control-messages.json");
    serde_json::from_str(&fs::read_to_string(&path).expect("read fixture")).expect("parse fixture")
}

#[test]
fn fixture_declares_the_shared_protocol_version() {
    assert_eq!(fixture().protocol_version, RECORDING_PROTOCOL_VERSION);
}

#[test]
fn rust_projection_agrees_with_every_fixture_case() {
    let fixture = fixture();
    assert!(!fixture.cases.is_empty(), "fixture must carry cases");
    for case in &fixture.cases {
        let json = serde_json::to_string(&case.message).expect("serialize case");
        let result = parse_control_message(&json);
        match case.expect.as_str() {
            "accepted" => assert!(
                result.is_ok(),
                "{} 应被接受，实际错误：{:?}",
                case.name,
                result.err()
            ),
            "rejected" => {
                let error = result.expect_err(&format!("{} 应被拒绝", case.name));
                assert_eq!(
                    Some(error.code),
                    case.code.as_deref(),
                    "{} 的错误码不符",
                    case.name
                );
            }
            other => panic!("未知期望值 {other}"),
        }
    }
}

#[test]
fn rejects_a_version_that_is_not_the_shared_constant() {
    let json = r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_9","sequence":"1","capabilityRequest":{}}"#;
    let error = parse_control_message(json).expect_err("version mismatch");
    assert_eq!(error.code, ERROR_PROTOCOL_VERSION_MISMATCH);
}

#[test]
fn fixture_identity_is_complete_and_epoch_zero_is_allowed() {
    let identity = fixture().identity;
    assert!(identity.is_complete());
    assert_eq!(identity.execution_epoch, 3);

    let mut zero_epoch = identity.clone();
    zero_epoch.execution_epoch = 0;
    assert!(zero_epoch.is_complete());

    let mut empty_profile = identity;
    empty_profile.profile_key = String::new();
    assert!(!empty_profile.is_complete());
}

#[test]
fn identity_scoping_rejects_late_attempts_and_epochs() {
    let current = fixture().identity;
    assert!(accepts_result(&current, &current));

    let mut other_attempt = current.clone();
    other_attempt.attempt_id = "attempt-2".into();
    assert!(!accepts_result(&current, &other_attempt));
    assert!(other_attempt.supersedes(&current));

    let mut other_epoch = current.clone();
    other_epoch.execution_epoch = 8;
    assert!(!accepts_result(&current, &other_epoch));

    let mut other_executor = current.clone();
    other_executor.executor_instance_id = "executor-2".into();
    assert!(!accepts_result(&current, &other_executor));
    assert!(!current.supersedes(&current));
}

#[test]
fn sequence_guard_is_per_attempt() {
    let identity = fixture().identity;
    let mut guard = SequenceGuard::default();
    assert!(guard.accept(&identity.job_id, &identity.attempt_id, 1));
    assert!(guard.accept(&identity.job_id, &identity.attempt_id, 7));
    assert!(!guard.accept(&identity.job_id, &identity.attempt_id, 7));
    assert!(!guard.accept(&identity.job_id, &identity.attempt_id, 6));
    assert!(guard.accept(&identity.job_id, "attempt-2", 1));
    assert_eq!(guard.last(&identity.job_id, &identity.attempt_id), Some(7));
    assert_eq!(guard.last(&identity.job_id, "attempt-9"), None);
}

#[test]
fn chunk_budget_matches_the_typescript_constant() {
    assert_eq!(MAX_RESOURCE_CHUNK_BYTES, 1024 * 1024);
    assert!(validate_chunk(0, MAX_RESOURCE_CHUNK_BYTES, 0).is_ok());
    assert!(validate_chunk(1024, 16, 1024).is_ok());
    assert_eq!(
        validate_chunk(0, MAX_RESOURCE_CHUNK_BYTES + 1, 0)
            .expect_err("oversized")
            .code,
        "recording-chunk-too-large"
    );
    assert_eq!(
        validate_chunk(1024, 16, 0).expect_err("out of order").code,
        "recording-sequence-out-of-order"
    );
}

#[test]
fn unknown_payload_and_incomplete_identity_codes_are_stable() {
    let unknown = parse_control_message(
        r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","teleportJob":{}}"#,
    )
    .expect_err("unknown payload");
    assert_eq!(unknown.code, ERROR_UNKNOWN_PAYLOAD);

    let incomplete = parse_control_message(
        r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","cancelJob":{"job":{"jobId":"j"}}}"#,
    )
    .expect_err("incomplete identity");
    assert_eq!(incomplete.code, ERROR_IDENTITY_INCOMPLETE);

    let unknown_enum = parse_control_message(
        r#"{"protocolVersion":"RECORDING_PROTOCOL_VERSION_1_ALPHA_1","sequence":"1","stateChanged":{"job":{"jobId":"j","attemptId":"a","executorInstanceId":"e","executionEpoch":"1","snapshotHash":"s","contentIdentity":"c","profileKey":"p"},"error":{"stage":"RECORDING_ERROR_STAGE_VIBES"}}}"#,
    )
    .expect_err("unknown enum");
    assert_eq!(unknown_enum.code, ERROR_UNKNOWN_ENUM);
}

#[test]
fn terminal_state_helpers_are_stable() {
    assert!(JobState::Succeeded.is_terminal());
    assert!(JobState::Cancelled.is_terminal());
    assert!(!JobState::Committing.is_terminal());
}

#[test]
fn executor_lease_can_renew_without_a_job_but_not_without_identity() {
    for payload in ["leaseHeartbeat", "leaseRenewal"] {
        let mut value =
            serde_json::json!({"protocolVersion": RECORDING_PROTOCOL_VERSION, "sequence": "1"});
        value[payload] = serde_json::json!({"executorInstanceId":"desktop-1"});
        assert!(parse_control_message(&value.to_string()).is_ok());
        value[payload] = serde_json::json!({});
        assert!(parse_control_message(&value.to_string()).is_err());
        value[payload] = serde_json::json!({"executorInstanceId":"desktop-1", "job":{}});
        assert!(parse_control_message(&value.to_string()).is_err());
    }
}
