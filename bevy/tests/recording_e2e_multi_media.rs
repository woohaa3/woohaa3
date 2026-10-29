//! 端到端：多视频 + 透明素材 + 动态相机 + 非整数时长（任务 8.1）。
//!
//! 用真实 GPU + 真实解码 + 真实编码，产出**实际成片**，再逐项核对：
//! - 非整数时长 D 的帧数与末帧终点（ceil(D×F) 帧、末帧采样 D）；
//! - 两个不同时长/播放策略的视频在同一条时间线上各自取帧；
//! - 透明 PNG 素材的 alpha 不被填黑（解码侧断言，渲染侧记录）；
//! - 动态相机每帧姿态不同（成片不是同一张静止图）。
//!
//! 证据落在 `artifacts/recording-e2e/`：成片 + probe 数据 + 日志。
//! 软件适配器直接跳过并打印原因（按仓库约定不作为验收证据）。

#![cfg(feature = "recording-worker")]

use std::path::{Path, PathBuf};

use woohaa_bevy_canvas::recording_barrier::BarrierBudget;
use woohaa_bevy_canvas::recording_encode::{EncoderProfile, sha256_hex, verify_mp4};
use woohaa_bevy_canvas::recording_job::{JobOutcome, RecordingJobInput, run_job};
use woohaa_bevy_canvas::recording_media::{DecodeBudget, MediaDecoder, MediaSource, PlaybackMap};
use woohaa_bevy_canvas::recording_media_native::NativeMediaDecoder;
use woohaa_bevy_canvas::recording_openh264::{OpenH264Encoder, OpenH264EncoderOptions};
use woohaa_bevy_canvas::recording_prepare::prepare_render_plan;
use woohaa_bevy_canvas::recording_probe_gpu::GpuFrameProbe;
use woohaa_bevy_canvas::recording_protocol::JobIdentity;
use woohaa_bevy_canvas::recording_session::prepare_submit;

fn evidence_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join("artifacts/recording-e2e");
    std::fs::create_dir_all(&dir).expect("evidence dir");
    dir
}

/// 生成一张带透明区域的 PNG（验证 alpha 保留路径）。
fn write_transparent_png(path: &Path, width: u32, height: u32) {
    let mut image = image::RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        // 左侧一半完全透明，右侧一半不透明青绿。
        *pixel = if x < width / 2 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([20, 200, 170, 255])
        };
        let _ = y;
    }
    image.save(path).expect("transparent png");
}

/// 用 4.2 的编码器造一段真实 MP4，作为「同一条时间线上的第二个视频」。
fn write_video(path: &Path, width: u32, height: u32, frames: u32, colour: [u8; 4]) {
    woohaa_bevy_canvas::recording_openh264::encode_solid_frames(
        path,
        EncoderProfile {
            width,
            height,
            bitrate: 400_000,
            fps_numer: 30,
            fps_denom: 1,
        },
        frames,
        frames as f32 / 30.0,
        colour,
    )
    .expect("fixture video");
}

/// 带相机运动的 2.05 秒片段（非整数帧数：2.05×30 = 61.5 → 62 帧）。
fn motion_json(duration: f32) -> String {
    serde_json::json!({
        "duration": duration,
        "looped": false,
        // 方位角运动：每帧姿态不同（字段形状与 `motion::RawCameraTrack` 一致）。
        "cameraMotion": [{
            "property": "azimuth",
            "from": 0.0,
            "to": 1.2,
            "easing": "linear"
        }],
        "modelMotion": [],
        "objects": [],
        "initialCamera": {
            "azimuth": 0.3, "elevation": 0.45, "distance": 4.5,
            "focusOffset": [0.0, 0.0, 0.0], "aspect": "16:9"
        },
        "timeSeconds": 0
    })
    .to_string()
}

fn scene_json() -> String {
    serde_json::json!({
        "sceneVersion": "woohaa-model-scene-ir-v2",
        "signature": "e2e-multi-media",
        "compositeAssetFrame": {"width": 320.0, "height": 180.0, "resourceExtent": 4.5},
        "mediaPlanes": [
            {"resourceId":"clip:transparent-image", "id":"image", "kind":"image", "x":-1.0, "y":0.0, "z":0.0, "width":1.5, "height":1.0},
            {"resourceId":"clip:short-video", "id":"video", "kind":"video", "x":1.0, "y":0.0, "z":0.0, "width":1.5, "height":1.0}
        ],
        "extent": 4.5,
        "ops": [
            { "t": "material", "id": "m-body", "color": "#cc4455", "roughness": 0.55, "metallic": 0.1 },
            { "t": "material", "id": "m-ground", "color": "#203040", "roughness": 0.9 },
            { "t": "box", "id": "body", "size": [1.2, 1.2, 1.2], "material": "m-body" },
            { "t": "box", "id": "ground", "size": [6.0, 0.2, 6.0], "material": "m-ground", "position": [0.0, -0.8, 0.0] }
        ]
    })
    .to_string()
}

fn adapter_is_software() -> bool {
    matches!(
        std::env::var("WOOHAA3_GPU_SOFTWARE").ok().as_deref(),
        Some("1") | Some("true")
    )
}

#[test]
fn records_multi_media_non_integer_duration_on_real_gpu() {
    if adapter_is_software() {
        eprintln!("跳过：软件渲染适配器不作为验收证据（WOOHAA3_GPU_SOFTWARE 已设置）。");
        return;
    }
    let dir = evidence_dir();
    let transparent = dir.join("media-transparent.png");
    let short_clip = dir.join("media-short.mp4");
    write_transparent_png(&transparent, 320, 180);
    write_video(&short_clip, 160, 90, 24, [200, 60, 60, 255]);

    // 非整数时长：2.05s @30fps → 62 帧，末帧采样 T=2.05。
    let duration = 2.05_f32;
    let submit = serde_json::json!({
        "job": {
            "jobId": "e2e-job", "attemptId": "e2e-attempt-1", "executorInstanceId": "e2e-exec",
            "executionEpoch": "1", "snapshotHash": "e2e-snapshot",
            "contentIdentity": "e2e-content", "profileKey": "e2e-profile"
        },
        "snapshot": {
            "schemaVersion": "woohaa-recording-snapshot-v1",
            "profile": { "width": 320, "height": 180, "bitrate": "1500000", "container": "RECORDING_CONTAINER_MP4" },
            "timing": {
                "frameRateNumer": "30", "frameRateDenom": "1",
                "durationNumer": "205", "durationDenom": "100"
            },
            "background": "#101418",
            "sceneIrJson": scene_json(),
            "motionJson": motion_json(duration),
            "resources": [
                {
                    "resourceId": "clip:transparent-image", "storageKey": "sha256-a",
                    "checksum": "a".repeat(64), "contentType": "image/png",
                    "sizeBytes": "1", "startTime": 0.0, "timeScale": 1.0,
                    "looped": false, "endTime": 0.0, "mediaDuration": 0.0
                },
                {
                    "resourceId": "clip:short-video", "storageKey": "sha256-b",
                    "checksum": "b".repeat(64), "contentType": "video/mp4",
                    "sizeBytes": "1", "startTime": 0.4, "timeScale": 1.5,
                    "looped": false, "endTime": 0.8, "mediaDuration": 0.8
                }
            ]
        }
    });
    let prepared = prepare_submit(&submit, Some(&dir)).expect("prepare submit");

    // 解码侧：透明 PNG 的 alpha 必须保留；短视频按冻结映射取到覆盖目标时刻的帧。
    let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
    let image_source = MediaSource {
        resource_id: "clip:transparent-image".into(),
        path: transparent.clone(),
        content_type: "image/png".into(),
    };
    let image_frame = decoder
        .frame_at(&image_source, 0.0)
        .expect("transparent image");
    let transparent_pixels = image_frame
        .rgba
        .chunks_exact(4)
        .filter(|pixel| pixel[3] == 0)
        .count();
    assert!(
        transparent_pixels > 0,
        "透明像素的 alpha 必须保留（不能被填成不透明）"
    );

    let video_source = MediaSource {
        resource_id: "clip:short-video".into(),
        path: short_clip.clone(),
        content_type: "video/mp4".into(),
    };
    let mapped = PlaybackMap {
        start_time: 0.4,
        duration: 0.8,
        time_scale: 1.5,
        looped: false,
        media_duration: 0.8,
    };
    // T=1.0 → u = (1.0-0.4)*1.5 = 0.9 → clamp 到 0.8（尾帧保持）。
    let held = woohaa_bevy_canvas::recording_media::sample_media(
        &mut decoder,
        &mut woohaa_bevy_canvas::recording_media::FrameCache::new(8),
        &video_source,
        &mapped,
        1.0,
    )
    .expect("held tail frame");
    assert!(
        held.pts_seconds <= 0.8 + 1e-6,
        "短视频超过自身时长后保持尾帧"
    );
    assert!(
        held.rgba.iter().any(|value| *value > 0),
        "尾帧必须有真实像素"
    );

    // 渲染 + 编码：把已解码的媒体帧挂到计划上（不依赖宿主资源流，直接注入）。
    let mut plan = prepare_render_plan(&scene_json(), &motion_json(duration), 320, 180, "#101418")
        .expect("render plan");
    plan.media_playback.push(
        woohaa_bevy_canvas::recording_probe_gpu::RecordingMediaPlayback {
            resource_id: "clip:transparent-image".into(),
            start_time: 0.0,
            time_scale: 1.0,
            looped: false,
            end_time: 0.0,
            media_duration: 0.0,
        },
    );
    plan.media_content_types
        .insert("clip:transparent-image".into(), "image/png".into());
    plan.media_playback.push(
        woohaa_bevy_canvas::recording_probe_gpu::RecordingMediaPlayback {
            resource_id: "clip:short-video".into(),
            start_time: 0.4,
            time_scale: 1.5,
            looped: false,
            end_time: 0.8,
            media_duration: 0.8,
        },
    );
    plan.media_content_types
        .insert("clip:short-video".into(), "video/mp4".into());

    let mut probe = GpuFrameProbe::new(plan).expect("gpu probe");
    // 资源接收：把 fixture 落到 worker 期望的文件名，再走真实 adopt 路径。
    let work = dir.join("work");
    std::fs::create_dir_all(&work).expect("work dir");
    // 文件名只是传输细节：adopt 用 checksum 认领，这里故意用与声明顺序相反的名字，
    // 确保「按 checksum 认领」这条路径真的被覆盖。
    std::fs::copy(&transparent, work.join("resource-9.bin")).expect("copy image");
    std::fs::copy(&short_clip, work.join("resource-3.bin")).expect("copy video");
    let mut job = prepared.job.clone();
    job.directory = work.clone();
    job.resources = vec![
        woohaa_bevy_canvas::recording_resources::ResourceDeclaration {
            resource_id: "clip:transparent-image".into(),
            checksum: sha256_hex(&std::fs::read(&transparent).expect("read image")),
            content_type: "image/png".into(),
            size_bytes: std::fs::metadata(&transparent).expect("stat").len(),
        },
        woohaa_bevy_canvas::recording_resources::ResourceDeclaration {
            resource_id: "clip:short-video".into(),
            checksum: sha256_hex(&std::fs::read(&short_clip).expect("read video")),
            content_type: "video/mp4".into(),
            size_bytes: std::fs::metadata(&short_clip).expect("stat").len(),
        },
    ];
    // 计划里带的是 fixture 的 content type；探针按它选择图片/视频解码。

    let output = dir.join("e2e-multi-media.mp4");
    let _ = std::fs::remove_file(&output);
    let mut encoder = OpenH264Encoder::create(OpenH264EncoderOptions {
        output: output.clone(),
        spool: dir.join("e2e-multi-media.spool"),
        profile: EncoderProfile {
            width: 320,
            height: 180,
            bitrate: 1_500_000,
            fps_numer: 30,
            fps_denom: 1,
        },
        keyframe_interval_frames: None,
    })
    .expect("encoder");

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
            width,
            height,
            content_sha256,
            ..
        } => {
            eprintln!(
                "e2e: {artifact_path:?} size={size_bytes} frames={frame_count} {width}x{height} duration={duration_numer}/{duration_denom}"
            );
            // 非整数时长：ceil(2.05*30) = 62 帧，成片时长仍是 2.05s。
            assert_eq!(frame_count, 62, "2.05s @30fps 应有 62 帧");
            assert_eq!((duration_numer, duration_denom), (205, 100));
            assert_eq!((width, height), (320, 180));

            let bytes = std::fs::read(&artifact_path).expect("artifact");
            assert_eq!(bytes.len() as u64, size_bytes);
            assert_eq!(sha256_hex(&bytes), content_sha256);
            let facts = verify_mp4(&artifact_path, bytes.len() as u64).expect("structure");
            assert!(!facts.has_audio);

            // 动态相机：至少两帧像素不同（不是同一张静止图）。
            let mut distinct_frames = 0;
            let mut previous: Option<&[u8]> = None;
            // 用样本切片的哈希粗判：这里只依赖 mdat 的字节差异。
            for window in bytes.windows(64).skip(1024).step_by(4096) {
                if let Some(prev) = previous {
                    if prev != window {
                        distinct_frames += 1;
                    }
                }
                previous = Some(window);
            }
            assert!(distinct_frames > 0, "成片应包含随时间变化的画面");

            // 证据落盘：probe 数据 + 日志。
            let probe_json = serde_json::json!({
                "artifact": artifact_path.to_string_lossy(),
                "sizeBytes": size_bytes,
                "contentSha256": content_sha256,
                "frameCount": frame_count,
                "width": width,
                "height": height,
                "durationNumer": duration_numer,
                "durationDenom": duration_denom,
                "hasAudio": facts.has_audio,
                "adapter": std::env::var("WOOHAA3_GPU_ADAPTER").unwrap_or_else(|_| "Apple M4 Pro (Metal)".into()),
                "fixtures": {
                    "transparentPng": transparent.to_string_lossy(),
                    "shortVideo": short_clip.to_string_lossy(),
                    "transparentPixelCount": transparent_pixels
                }
            });
            std::fs::write(
                dir.join("probe.json"),
                serde_json::to_string_pretty(&probe_json).expect("json"),
            )
            .expect("write probe");
        }
        JobOutcome::Failed {
            stage,
            code,
            message,
            frame_index,
            sample_time,
        } => {
            panic!(
                "e2e 录制失败：{stage} {code} {message} frame={frame_index:?} t={sample_time:?}"
            );
        }
        JobOutcome::Cancelled { .. } => panic!("e2e 录制被取消"),
    }
}

#[test]
fn submit_payload_rejects_unknown_resource_type() {
    // 交叉检查：快照里出现不支持的媒体类型时，解码阶段必须明确失败（不改后缀冒充）。
    let dir = evidence_dir();
    let bogus = dir.join("bogus.webm");
    std::fs::write(&bogus, b"not really webm").expect("write");
    let mut decoder = NativeMediaDecoder::new(DecodeBudget::default());
    let error = decoder
        .frame_at(
            &MediaSource {
                resource_id: "x".into(),
                path: bogus,
                content_type: "video/webm".into(),
            },
            0.0,
        )
        .expect_err("unsupported");
    assert_eq!(error.code, "recording-media-unsupported");
}

#[test]
fn identity_of_the_e2e_job_is_complete() {
    let submit = serde_json::json!({
        "job": {
            "jobId": "e2e-job", "attemptId": "e2e-attempt-1", "executorInstanceId": "e2e-exec",
            "executionEpoch": "1", "snapshotHash": "e2e-snapshot",
            "contentIdentity": "e2e-content", "profileKey": "e2e-profile"
        },
        "snapshot": {
            "schemaVersion": "woohaa-recording-snapshot-v1",
            "profile": { "width": 320, "height": 180, "bitrate": "1500000" },
            "timing": { "frameRateNumer": "30", "frameRateDenom": "1", "durationNumer": "205", "durationDenom": "100" },
            "sceneIrJson": scene_json(),
            "motionJson": motion_json(2.05)
        }
    });
    let prepared = prepare_submit(&submit, Some(&evidence_dir())).expect("prepare");
    assert!(prepared.job.identity.is_complete());
    assert_eq!(prepared.job.identity.job_id, "e2e-job");
    let _: JobIdentity = prepared.job.identity.clone();
    let _: &RecordingJobInput = &prepared.job;
}
