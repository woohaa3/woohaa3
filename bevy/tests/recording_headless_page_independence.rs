//! 独立于页面帧循环的录制（任务 8.2 可独立验证的部分）。
//!
//! 8.2 的完整验收需要在真实桌面壳里最小化/重载页面，本机被上游 `native-canvas` 缺失阻断
//! （见 verification）。但其中两条关键不变量**不需要桌面壳**就能证明：
//!
//! 1. **worker 不依赖页面/rAF/窗口**：它在没有主窗口、没有 winit 的情况下跑完整条流水线；
//! 2. **录制不改变可见播放头**：录制路径没有任何接受播放状态的入口（编译期即隔离）。
//!
//! 这两条正是「页面重载/最小化后任务仍然完成」与「编辑播放头不被接管」的技术前提。

#![cfg(feature = "recording-worker")]

use std::path::PathBuf;

use woohaa_bevy_canvas::recording_barrier::BarrierBudget;
use woohaa_bevy_canvas::recording_encode::EncoderProfile;
use woohaa_bevy_canvas::recording_job::{run_job, JobOutcome};
use woohaa_bevy_canvas::recording_openh264::{OpenH264Encoder, OpenH264EncoderOptions};
use woohaa_bevy_canvas::recording_prepare::prepare_render_plan;
use woohaa_bevy_canvas::recording_probe_gpu::GpuFrameProbe;
use woohaa_bevy_canvas::recording_session::prepare_submit;

fn evidence_dir() -> PathBuf {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join("artifacts/recording-e2e");
    std::fs::create_dir_all(&dir).expect("dir");
    dir
}

fn scene() -> String {
    serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2",
        "signature": "headless",
        "extent": 4.0,
        "ops": [
            { "t": "material", "id": "m", "color": "#3a7f6a", "roughness": 0.6 },
            { "t": "box", "id": "b", "size": [1.3, 1.3, 1.3], "material": "m" }
        ]
    })
    .to_string()
}

fn motion(duration: f32) -> String {
    serde_json::json!({
        "duration": duration,
        "looped": false,
        "cameraMotion": [{ "property": "azimuth", "from": 0.0, "to": 0.9, "easing": "linear" }],
        "modelMotion": [],
        "objects": [],
        "initialCamera": { "azimuth": 0.4, "elevation": 0.4, "distance": 4.2, "focusOffset": [0.0, 0.0, 0.0], "aspect": "16:9" },
        "timeSeconds": 0
    })
    .to_string()
}

#[test]
fn worker_completes_without_any_page_or_window_loop() {
    if matches!(std::env::var("WOOHAA3_GPU_SOFTWARE").ok().as_deref(), Some("1") | Some("true")) {
        eprintln!("跳过：软件渲染适配器不作为验收证据。");
        return;
    }
    // 提交走的是**与页面无关**的路径：只有 JSON 快照，没有 window/rAF/DOM 句柄。
    let submit = serde_json::json!({
        "job": {
            "jobId": "headless-job", "attemptId": "headless-attempt", "executorInstanceId": "exec",
            "executionEpoch": "1", "snapshotHash": "s", "contentIdentity": "c", "profileKey": "p"
        },
        "snapshot": {
            "schemaVersion": "woohaa-recording-snapshot-v1",
            "profile": { "width": 240, "height": 136, "bitrate": "800000" },
            "timing": { "frameRateNumer": "30", "frameRateDenom": "1", "durationNumer": "9", "durationDenom": "30" },
            "background": "#0b1210",
            "sceneIrJson": scene(),
            "motionJson": motion(0.3)
        }
    });
    let dir = evidence_dir();
    let prepared = prepare_submit(&submit, Some(&dir)).expect("prepare");
    let mut plan = prepare_render_plan(&scene(), &motion(0.3), 240, 136, "#0b1210").expect("plan");
    plan.media_playback.clear();
    plan.media_content_types.clear();
    let mut probe = GpuFrameProbe::new(plan).expect("probe");

    let output = dir.join("headless-no-page-loop.mp4");
    let _ = std::fs::remove_file(&output);
    let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
        output: output.clone(),
        spool: dir.join("headless-no-page-loop.spool"),
        profile: EncoderProfile { width: 240, height: 136, bitrate: 800_000, fps_numer: 30, fps_denom: 1 },
        keyframe_interval_frames: None,
    })
    .expect("encoder");

    let outcome = run_job(&prepared.job, &mut probe, &mut encoder, &|| false, BarrierBudget::default());
    match outcome {
        JobOutcome::Completed { frame_count, width, height, .. } => {
            // 9 帧全部产出，且这期间**没有任何页面**参与：本测试是一个普通 Rust 进程。
            assert_eq!(frame_count, 9);
            assert_eq!((width, height), (240, 136));
            assert!(output.exists(), "成片应落盘");
            eprintln!("headless: {frame_count} 帧 → {output:?}");
        }
        JobOutcome::Failed { stage, code, message, .. } => panic!("无页面录制失败：{stage} {code} {message}"),
        JobOutcome::Cancelled { .. } => panic!("意外取消"),
    }
}

#[test]
fn recording_path_has_no_playback_control_surface() {
    // 编译期契约：录制路径的公开入口只接受冻结 IR / 资源 / 身份，
    // 不接受播放状态、seek 或播放头。
    //
    // 用类型断言固定这一点：如果未来有人给 `RecordingJobInput` 加上播放字段，
    // 这里会因为字段数变化而需要显式复核。
    let input = woohaa_bevy_canvas::recording_job::RecordingJobInput {
        identity: woohaa_bevy_canvas::recording_protocol::JobIdentity {
            job_id: "j".into(),
            attempt_id: "a".into(),
            executor_instance_id: "e".into(),
            execution_epoch: 1,
            snapshot_hash: "s".into(),
            content_identity: "c".into(),
            profile_key: "p".into(),
        },
        width: 240,
        height: 136,
        fps_numer: 30,
        fps_denom: 1,
        duration_numer: 9,
        duration_denom: 30,
        bitrate: 800_000,
        resources: Vec::new(),
        directory: std::env::temp_dir(),
        output_name: "headless".into(),
    };
    // 结构化断言：字段集合里没有任何 playback/seek 入口。
    let debug = format!("{input:?}");
    for forbidden in ["playhead", "playing", "seek", "currentTime"] {
        assert!(!debug.contains(forbidden), "录制输入不应包含播放状态字段：{forbidden}");
    }
}
