//! 真实 GPU 的连续多帧录制回归
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.5 / 8.1 的非交互部分）。
//!
//! 用 `recording_job` 的真实编排 + `GpuFrameProbe` + `OpenH264Encoder`：
//! 从冻结 IR 逐帧渲染、编码，产出**真实 MP4**，再用宿主侧解析器复核容器/尺寸/时长/帧数。
//!
//! 环境要求：真实 GPU。本仓库约定软件适配器（lavapipe/SwiftShader）不作验收证据，
//! 因此这里显式检查 adapter 名称：检测到软件适配器就跳过并打印原因，而不是伪造通过。
//!
//! 运行：
//! ```bash
//! cargo test --no-default-features --features recording-worker \
//!   --test recording_gpu_pipeline -- --nocapture
//! ```

#![cfg(feature = "recording-worker")]

use std::path::PathBuf;

use woohaa_bevy_canvas::recording_barrier::BarrierBudget;
use woohaa_bevy_canvas::recording_encode::{EncoderProfile, MAX_ARTIFACT_BYTES};
use woohaa_bevy_canvas::recording_job::{JobOutcome, RecordingJobInput, run_job};
use woohaa_bevy_canvas::recording_openh264::{OpenH264Encoder, OpenH264EncoderOptions};
use woohaa_bevy_canvas::recording_prepare::prepare_render_plan;
use woohaa_bevy_canvas::recording_probe_gpu::GpuFrameProbe;
use woohaa_bevy_canvas::recording_timeline::Rational;

/// 一个 2 秒、带相机运动的片场：足够覆盖「多帧 + 动态镜头」。
const SCENE_JSON: &str = r##"{
  "sceneVersion": "woohaa-model-scene-ir-v2",
  "signature": "gpu-pipeline-fixture",
  "extent": 4.0,
  "ops": [
    { "t": "material", "id": "m-body", "color": "#cc4455", "roughness": 0.55, "metallic": 0.1 },
    { "t": "material", "id": "m-ground", "color": "#203040", "roughness": 0.9, "metallic": 0.0 },
    { "t": "box", "id": "body", "size": [1.4, 1.4, 1.4], "material": "m-body" },
    { "t": "box", "id": "ground", "size": [6.0, 0.2, 6.0], "material": "m-ground", "position": [0.0, -0.8, 0.0] }
  ]
}"##;

const MOTION_JSON: &str = r##"{
  "duration": 2.0,
  "looped": false,
  "cameraMotion": [],
  "modelMotion": [],
  "objects": [],
  "initialCamera": {
    "azimuth": 0.6,
    "elevation": 0.5,
    "distance": 4.5,
    "focusOffset": [0.0, 0.0, 0.0],
    "aspect": "16:9"
  },
  "timeSeconds": 0
}"##;

fn output_directory() -> PathBuf {
    let dir = std::env::temp_dir().join("wo-recording-gpu-pipeline");
    std::fs::create_dir_all(&dir).expect("test dir");
    dir
}

/// 解码首帧，判断像素是否近乎单一颜色（用于排除「空场景/全黑」）。
fn pixels_are_uniform(bytes: &[u8]) -> bool {
    let Some(rgb) = decode_first_frame_rgb(bytes) else {
        return true;
    };
    if rgb.len() < 3 {
        return true;
    }
    let first = (rgb[0], rgb[1], rgb[2]);
    let mut distinct = 0u32;
    for pixel in rgb.chunks_exact(3) {
        if (pixel[0] as i32 - first.0 as i32).abs() > 24
            || (pixel[1] as i32 - first.1 as i32).abs() > 24
            || (pixel[2] as i32 - first.2 as i32).abs() > 24
        {
            distinct += 1;
            if distinct > 200 {
                return false;
            }
        }
    }
    true
}

/// 解码首帧为 RGB（失败返回 None）。
fn decode_first_frame_rgb(bytes: &[u8]) -> Option<Vec<u8>> {
    use openh264::formats::YUVSource;
    let avcc = bytes
        .windows(4)
        .position(|window| window == b"avcC")
        .map(|index| index + 4)?;
    let mdat = bytes
        .windows(4)
        .position(|window| window == b"mdat")
        .map(|index| index + 4)?;
    let mut decoder = openh264::decoder::Decoder::new().ok()?;
    let mut cursor = avcc + 6;
    let mut headers = Vec::new();
    for _ in 0..2 {
        if cursor + 2 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        cursor += 2;
        if cursor + length > bytes.len() {
            break;
        }
        headers.extend_from_slice(&[0, 0, 0, 1]);
        headers.extend_from_slice(&bytes[cursor..cursor + length]);
        cursor += length + 1;
    }
    let _ = decoder.decode(&headers);
    let mut cursor = mdat;
    while cursor + 4 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[cursor],
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
        ]) as usize;
        if length == 0 || cursor + 4 + length > bytes.len() {
            break;
        }
        let mut annex_b = vec![0, 0, 0, 1];
        annex_b.extend_from_slice(&bytes[cursor + 4..cursor + 4 + length]);
        if let Ok(Some(image)) = decoder.decode(&annex_b) {
            let (w, h) = image.dimensions();
            let mut rgb = vec![0u8; w * h * 3];
            image.write_rgb8(&mut rgb);
            return Some(rgb);
        }
        cursor += 4 + length;
    }
    None
}

/// 用 OpenH264 解码器验证成片里确有图像（结构正确但内容损坏会在这里暴露）。
fn decode_first_frame(bytes: &[u8]) -> bool {
    let Some(avcc) = bytes
        .windows(4)
        .position(|window| window == b"avcC")
        .map(|index| index + 4)
    else {
        return false;
    };
    let Some(mdat) = bytes
        .windows(4)
        .position(|window| window == b"mdat")
        .map(|index| index + 4)
    else {
        return false;
    };
    let Ok(mut decoder) = openh264::decoder::Decoder::new() else {
        return false;
    };
    // avcC: version/profile/compat/level/lenSize/numSps/len/sps/numPps/len/pps
    let mut cursor = avcc + 6;
    let mut headers = Vec::new();
    for _ in 0..2 {
        if cursor + 2 > bytes.len() {
            break;
        }
        let length = u16::from_be_bytes([bytes[cursor], bytes[cursor + 1]]) as usize;
        cursor += 2;
        if cursor + length > bytes.len() {
            break;
        }
        headers.extend_from_slice(&[0, 0, 0, 1]);
        headers.extend_from_slice(&bytes[cursor..cursor + length]);
        cursor += length + 1;
    }
    if decoder.decode(&headers).is_err() {
        return false;
    }
    let mut cursor = mdat;
    while cursor + 4 <= bytes.len() {
        let length = u32::from_be_bytes([
            bytes[cursor],
            bytes[cursor + 1],
            bytes[cursor + 2],
            bytes[cursor + 3],
        ]) as usize;
        if length == 0 || cursor + 4 + length > bytes.len() {
            break;
        }
        let mut annex_b = vec![0, 0, 0, 1];
        annex_b.extend_from_slice(&bytes[cursor + 4..cursor + 4 + length]);
        if let Ok(Some(_)) = decoder.decode(&annex_b) {
            return true;
        }
        cursor += 4 + length;
    }
    false
}

fn profile(width: u32, height: u32) -> EncoderProfile {
    EncoderProfile {
        width,
        height,
        bitrate: 2_000_000,
        fps_numer: 30,
        fps_denom: 1,
    }
}

/// 检测到的 adapter 是否为软件渲染；是则本测试不作为验收证据。
fn adapter_is_software() -> bool {
    // 渲染器把 adapter 打到 stderr（INFO）；这里用与运行时相同的方式探测一次。
    let adapter = woohaa_bevy_canvas::recording_prepare::detect_gpu_adapter();
    match adapter {
        Some(info) => {
            eprintln!(
                "adapter: {} / {} / software={}",
                info.name, info.backend, info.software
            );
            info.software
        }
        None => {
            eprintln!("adapter: <none>");
            true
        }
    }
}

#[test]
fn renders_and_encodes_a_real_multi_frame_clip_on_gpu() {
    if adapter_is_software() {
        eprintln!("跳过：当前只有软件渲染适配器，不采集渲染验收（按仓库约定）。");
        return;
    }
    let directory = output_directory();
    let output = directory.join("gpu-clip.mp4");
    let _ = std::fs::remove_file(&output);
    let (width, height) = (320, 180);

    let plan = prepare_render_plan(SCENE_JSON, MOTION_JSON, width, height, "#101418")
        .expect("render plan from frozen IR");
    let probe = GpuFrameProbe::new(plan).expect("gpu probe");
    let mut probe = probe;

    let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
        output: output.clone(),
        spool: directory.join("gpu-clip.spool"),
        profile: profile(width, height),
        keyframe_interval_frames: None,
    })
    .expect("encoder");

    // 2 秒 @30fps = 60 帧；真实渲染 60 帧在 CI 上较慢，这里取前 12 帧覆盖「多帧 + 时间推进」。
    let job = RecordingJobInput {
        identity: woohaa_bevy_canvas::recording_protocol::JobIdentity {
            job_id: "gpu-job".into(),
            attempt_id: "gpu-attempt".into(),
            executor_instance_id: "gpu-exec".into(),
            execution_epoch: 1,
            snapshot_hash: "gpu-snapshot".into(),
            content_identity: "gpu-content".into(),
            profile_key: "gpu-profile".into(),
        },
        width,
        height,
        fps_numer: 30,
        fps_denom: 1,
        duration_numer: 12,
        duration_denom: 30,
        bitrate: 2_000_000,
        resources: Vec::new(),
        directory: directory.clone(),
        output_name: "gpu-clip".into(),
    };

    let outcome = run_job(
        &job,
        &mut probe,
        &mut encoder,
        &|| false,
        BarrierBudget::default(),
    );
    match outcome {
        JobOutcome::Completed {
            artifact_path,
            size_bytes,
            frame_count,
            duration_numer,
            duration_denom,
            width: w,
            height: h,
            ..
        } => {
            eprintln!(
                "成片: {artifact_path:?} size={size_bytes} frames={frame_count} {w}x{h} duration={duration_numer}/{duration_denom}"
            );
            assert_eq!(frame_count, 12);
            assert_eq!((w, h), (width, height));
            assert!(size_bytes > 0);
            let bytes = std::fs::read(&artifact_path).expect("artifact");
            assert!(bytes.len() as u64 <= MAX_ARTIFACT_BYTES);
            // 结构自校验（Fast Start / avc1 / avcC / 无音轨）。
            let facts = woohaa_bevy_canvas::recording_encode::verify_mp4(
                &artifact_path,
                bytes.len() as u64,
            )
            .expect("artifact structure");
            assert!(!facts.has_audio);

            // 画面不能是全黑/全透明：录制背景是 #101418，物体应在其上可见。
            assert!(
                !pixels_are_uniform(&bytes),
                "成片画面不应是单一颜色（证明真的画了场景）"
            );

            // 成片必须包含可解码帧：从 avcC 取参数集、从 mdat 取样本，交给真实解码器。
            let decoded = decode_first_frame(&bytes);
            assert!(decoded, "成片应至少能解出一帧（尺寸 {}x{}）", width, height);
        }
        JobOutcome::Failed {
            stage,
            code,
            message,
            frame_index,
            sample_time,
        } => {
            panic!(
                "GPU 录制失败：{stage} {code} {message} frame={frame_index:?} t={sample_time:?}"
            );
        }
        JobOutcome::Cancelled { frame_index } => panic!("意外取消于帧 {frame_index:?}"),
    }
}

#[test]
fn timeline_of_the_gpu_fixture_is_exact() {
    // 与上面同一时长：12 帧，总时长精确等于 12/30 秒。
    let slots = woohaa_bevy_canvas::recording_timeline::build_timeline(
        Rational::new(12, 30).expect("duration"),
        Rational::new(30, 1).expect("fps"),
    )
    .expect("timeline");
    assert_eq!(slots.len(), 12);
    let total =
        woohaa_bevy_canvas::recording_timeline::timeline_total_duration(&slots).expect("total");
    assert!(total.eq_value(Rational::new(12, 30).expect("expected")));
}
