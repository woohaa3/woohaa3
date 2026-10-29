//! 无窗口录制 worker 的进程入口
//! （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.1 / design D1）。
//!
//! 运行形态：
//! - 由桌面 supervisor 以**独立进程**启动，每个 attempt 一个进程，结束即回收；
//! - 只有 `recording-worker` feature 才编译；不加载窗口、UI、全局 facade、可见播放 owner；
//! - 通过本机通道接收冻结快照与资源分块，输出成片事实；
//! - 自身持有 lease watchdog：supervisor 消失时自行退出，不只依赖父进程 kill。
//!
//! 渲染能力：真实取帧走 GPU（复用预览渲染入口）。提交任务时先组装渲染计划；
//! 没有可用适配器/IR 非法/尺寸不合规都在**接受前**明确失败并给出阶段码，
//! 绝不产出占位帧；纯编码自检走 `--probe`。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use woohaa_bevy_canvas::recording_encode::{EncoderProfile, MAX_ARTIFACT_BYTES};
use woohaa_bevy_canvas::recording_protocol::{
    RECORDING_PROTOCOL_VERSION, RECORDING_SNAPSHOT_SCHEMA_VERSION,
};

/// supervisor 通过环境变量传入的定位信息；不接受任意命令行路径。
pub const ENV_SOCKET: &str = "WOOHAA3_RECORDING_SOCKET";
pub const ENV_NONCE: &str = "WOOHAA3_RECORDING_NONCE_FILE";
pub const ENV_LEASE: &str = "WOOHAA3_RECORDING_LEASE_MS";
pub const ENV_WORK_DIR: &str = "WOOHAA3_RECORDING_WORK_DIR";
pub const ENV_EXECUTOR_ID: &str = "WOOHAA3_RECORDING_EXECUTOR_ID";

/// 默认 lease 时长；与宿主注册表一致。
pub const DEFAULT_LEASE_MS: u64 = 30_000;

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--version") {
        println!("{RECORDING_PROTOCOL_VERSION}");
        return;
    }
    if arguments.iter().any(|argument| argument == "--capability") {
        println!("{}", capability_report_json());
        return;
    }
    if arguments.iter().any(|argument| argument == "--probe") {
        // 纯编码自检：不需要 GPU，可在无 GPU 机器上跑出真实 MP4。
        match run_encode_probe() {
            Ok(path) => println!("{}", path.display()),
            Err(error) => {
                eprintln!("shot-recorder: {error}");
                std::process::exit(2);
            }
        }
        return;
    }

    let work_dir = std::env::var(ENV_WORK_DIR).ok().map(PathBuf::from);
    let lease_ms = std::env::var(ENV_LEASE)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_LEASE_MS);

    eprintln!(
        "shot-recorder 就绪（{}，snapshot {}，lease {lease_ms}ms）",
        capability_report(),
        RECORDING_SNAPSHOT_SCHEMA_VERSION
    );

    if let Some(directory) = work_dir.clone() {
        watch_lease(directory, lease_ms);
    }

    serve_control_loop();
    eprintln!("shot-recorder 退出");
}

/// 从 stdin 读 framed JSON 控制消息。
///
/// `submitJob` 会真正执行：装配 GPU 探针 + OpenH264 编码器，按冻结时间表逐帧渲染编码，
/// 成功后回 `stateChanged(succeeded)` 携带成片事实；失败回真实阶段码。
fn serve_control_loop() {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut header = [0u8; 4];
        if input.read_exact(&mut header).is_err() {
            break;
        }
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > woohaa_bevy_canvas::recording_protocol::MAX_CONTROL_MESSAGE_BYTES
        {
            eprintln!("shot-recorder: 非法控制帧长度 {length}");
            std::process::exit(64);
        }
        let mut body = vec![0u8; length];
        if input.read_exact(&mut body).is_err() {
            break;
        }
        let text = String::from_utf8_lossy(&body);
        match woohaa_bevy_canvas::recording_protocol::parse_control_message(&text) {
            Ok(envelope) => {
                let name = envelope
                    .payload_value()
                    .map(|(name, _)| name)
                    .unwrap_or("<none>");
                let sequence = envelope.sequence;
                match name {
                    "submitJob" => {
                        woohaa_bevy_canvas::recording_wire::run_submit_job(sequence, &text);
                    }
                    "cancelJob" => {
                        write_control_ack(sequence, "RECORDING_JOB_STATE_CANCELLED");
                    }
                    "pauseJob" => write_control_ack(sequence, "RECORDING_JOB_STATE_PAUSED"),
                    "resumeJob" => write_control_ack(sequence, "RECORDING_JOB_STATE_RENDERING"),
                    "leaseRenewal" => {}
                    other => eprintln!("shot-recorder: 收到未处理的控制消息 {other}"),
                }
            }
            Err(error) => {
                eprintln!("shot-recorder: 协议拒绝 {}：{}", error.code, error.message);
                write_frame(
                    &serde_json::json!({
                        "protocolVersion": RECORDING_PROTOCOL_VERSION,
                        "sequence": "0",
                        "capabilityResponse": {
                            "accepted": false,
                            "error": {
                                "stage": "RECORDING_ERROR_STAGE_CAPABILITY",
                                "code": error.code,
                                "message": error.message
                            }
                        }
                    })
                    .to_string(),
                );
            }
        }
    }
}

use woohaa_bevy_canvas::recording_wire::{write_control_ack, write_frame, write_state_failure};

/// 进程级能力自述；GPU 适配器与解码器由真实渲染层补充（此处不伪造）。
pub fn capability_report() -> String {
    format!(
        "codec={} snapshot={} protocol={}",
        woohaa_bevy_canvas::recording_openh264::backend_version(),
        RECORDING_SNAPSHOT_SCHEMA_VERSION,
        RECORDING_PROTOCOL_VERSION
    )
}

fn capability_report_json() -> String {
    let gpu = woohaa_bevy_canvas::recording_prepare::detect_gpu_adapter();
    serde_json::json!({
        "protocolVersion": RECORDING_PROTOCOL_VERSION,
        "supportedProtocolVersions": [RECORDING_PROTOCOL_VERSION],
        "compilerVersion": "film-set-recording-compiler-1",
        "gpuBackend": gpu.as_ref().map(|info| info.backend.as_str()).unwrap_or(""),
        "videoEncoders": ["h264"], "videoDecoders": ["h264"],
        "maxResourceChunkBytes": 1048576, "maxConcurrentJobs": 1, "maxQueuedJobs": 8,
        "maxSnapshotBytes": 8388608,
        "snapshotSchemaVersion": RECORDING_SNAPSHOT_SCHEMA_VERSION,
        "codecVersion": woohaa_bevy_canvas::recording_openh264::backend_version(),
        "rendererVersion": "bevy-shot-recorder-1",
        "colorRevision": "srgb-bt709-limited-1",
        "maxArtifactBytes": MAX_ARTIFACT_BYTES,
        // 无窗口 worker 只做离屏渲染；GPU 适配器探测由真实渲染层上报。
        "gpuAdapter": gpu.as_ref().map(|info| info.name.as_str()).unwrap_or(""),
        "softwareAdapter": gpu.as_ref().map(|info| info.software).unwrap_or(true)
    })
    .to_string()
}

/// lease watchdog：读取宿主写入的 lease 文件；过期或文件消失即退出。
///
/// 这是**自我终止**路径：即使 supervisor 被杀（无法发 kill），worker 也会结束。
fn watch_lease(directory: PathBuf, lease_ms: u64) {
    let path = directory.join("lease.json");
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let alive = std::fs::metadata(&path)
                .map(|metadata| {
                    metadata
                        .modified()
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .map(|age| age.as_millis() as u64 <= lease_ms)
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if !alive {
                eprintln!("shot-recorder: 宿主租约失效，worker 自行退出");
                std::process::exit(75);
            }
        }
    });
}

/// 无 GPU 的编码自检：产出真实 MP4 以便宿主/CI 验证编码链路。
fn run_encode_probe() -> Result<PathBuf, String> {
    let directory = std::env::var(ENV_WORK_DIR)
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("wo-recording-probe"));
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建目录：{error}"))?;
    let output = directory.join("encode-probe.mp4");
    let profile = EncoderProfile {
        width: 64,
        height: 48,
        bitrate: 400_000,
        fps_numer: 30,
        fps_denom: 1,
    };
    woohaa_bevy_canvas::recording_openh264::encode_solid_frames(
        &output,
        profile,
        6,
        0.2,
        [32, 96, 160, 255],
    )
    .map_err(|error| format!("编码自检失败：{} {}", error.code, error.message))?;
    verify_probe(&output)?;
    Ok(output)
}

fn verify_probe(path: &Path) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("无法读取产物：{error}"))?
        .len();
    woohaa_bevy_canvas::recording_encode::verify_mp4(path, size)
        .map(|_| ())
        .map_err(|error| format!("产物校验失败：{} {}", error.code, error.message))
}
