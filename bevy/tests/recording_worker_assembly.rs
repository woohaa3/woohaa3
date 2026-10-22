//! Worker 装配边界（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 3.1 / 3.2）。
//!
//! 断言的是**结构**，不是渲染结果：
//! - `shot-recorder` 二进制只依赖录制模块，不加载窗口/UI/全局 facade；
//! - worker 路径不引用 `winit`、`bridge`、`app`、`canvas2d` 等可见画布入口；
//! - 共享的 ShotCamera / model3d 核心仍被两边复用（不是复制一份）。
//!
//! 这些检查在无 GPU 环境同样成立，因此可以在 CI 里跑。

use std::fs;
use std::path::{Path, PathBuf};

fn bevy_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    fs::read_to_string(bevy_root().join(relative))
        .unwrap_or_else(|error| panic!("无法读取 {relative}: {error}"))
}

/// 去掉行注释与块注释，避免解释性提及触发误报。
fn strip_comments(source: &str) -> String {
    let without_block = {
        let mut out = String::new();
        let mut rest = source;
        while let Some(start) = rest.find("/*") {
            out.push_str(&rest[..start]);
            match rest[start..].find("*/") {
                Some(end) => rest = &rest[start + end + 2..],
                None => {
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out
    };
    without_block
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn recorder_binary_does_not_load_window_or_global_facade() {
    let source = strip_comments(&read("src/bin/shot-recorder.rs"));
    // 独立进程：不得创建窗口、不启用 winit、不碰可见画布 facade。
    for forbidden in [
        "winit",
        "bevy_winit",
        "PrimaryWindow",
        "WindowPlugin",
        "canvas::set_scene",
        "bridge::",
        "crate::app::",
        "crate::canvas2d::",
        "crate::model_preview::",
    ] {
        assert!(
            !source.contains(forbidden),
            "shot-recorder 不应引用 {forbidden}（worker 必须脱离可见画布）"
        );
    }
    // 必须显式拥有自己的能力自述与租约看门狗。
    assert!(source.contains("--capability"), "worker 应能自述能力");
    assert!(source.contains("watch_lease"), "worker 应持有租约看门狗");
    // 真实执行在 lib 的 `recording_wire::run_submit_job`；入口只负责循环与参数。
    assert!(
        source.contains("recording_wire::run_submit_job"),
        "worker 应通过录制任务编排执行，而不是自己拼时间表"
    );
    let wire = strip_comments(&read("src/recording_wire.rs"));
    assert!(wire.contains("recording_job::run_job"), "执行必须走 recording_job::run_job");
    assert!(wire.contains("recording_session::prepare_submit"), "快照装配必须走 recording_session");
}

#[test]
fn recorder_binary_is_feature_gated() {
    let manifest = read("Cargo.toml");
    assert!(
        manifest.contains("name = \"shot-recorder\""),
        "Cargo.toml 应声明 shot-recorder binary"
    );
    assert!(
        manifest.contains("required-features = [\"recording-worker\"]"),
        "shot-recorder 必须由 recording-worker feature 门控，默认构建不应包含它"
    );
    assert!(
        manifest.contains("recording-worker = ["),
        "应声明 recording-worker feature"
    );
}

#[test]
fn recording_modules_are_shared_not_duplicated() {
    // 录制模块引用共享核心，而不是复制一份场景/镜头实现。
    let job = strip_comments(&read("src/recording_job.rs"));
    assert!(
        job.contains("recording_barrier") && job.contains("recording_timeline"),
        "录制编排应复用共享时间表与屏障模块"
    );
    // 共享核心仍对可见路径开放（任何 feature 都编译）。
    let lib = strip_comments(&read("src/lib.rs"));
    assert!(lib.contains("pub mod shot_camera"));
    assert!(lib.contains("pub mod model3d"));
    assert!(lib.contains("pub mod recording_protocol"));
    assert!(lib.contains("pub mod recording_timeline"));
    assert!(lib.contains("pub mod recording_barrier"));
    assert!(lib.contains("pub mod recording_job"));
}

#[test]
fn recording_pure_modules_do_not_depend_on_bevy() {
    // 这些模块必须能在任何 feature（含无 Bevy 渲染）下编译与测试。
    for module in [
        "src/recording_protocol.rs",
        "src/recording_timeline.rs",
        "src/recording_barrier.rs",
        "src/recording_resources.rs",
        "src/recording_job.rs",
    ] {
        let source = strip_comments(&read(module));
        for forbidden in ["use bevy::", "bevy::", "wasm_bindgen"] {
            assert!(
                !source.contains(forbidden),
                "{module} 不应依赖 {forbidden}（应保持纯逻辑，可无 GPU 测试）"
            );
        }
    }
}

#[test]
fn worker_source_files_stay_reviewable() {
    // 与仓库既有 file_size 守卫同阈值；这里只覆盖本 change 新增的文件，
    // 便于在既有超限文件存在时仍能守住新代码。
    const MAX_LINES: usize = 800;
    let mut files = Vec::new();
    for name in [
        "src/recording_protocol.rs",
        "src/recording_timeline.rs",
        "src/recording_barrier.rs",
        "src/recording_resources.rs",
        "src/recording_job.rs",
        "src/recording_encode.rs",
        "src/recording_mux.rs",
        "src/recording_openh264.rs",
        "src/bin/shot-recorder.rs",
    ] {
        files.push(PathBuf::from(name));
    }
    let mut violations = Vec::new();
    for path in files {
        let source = read(&path.to_string_lossy());
        let lines = source.lines().count();
        if lines > MAX_LINES {
            violations.push(format!("{}: {lines} 行", path.display()));
        }
    }
    assert!(
        violations.is_empty(),
        "以下新增录制文件超过 {MAX_LINES} 行：\n{}",
        violations.join("\n")
    );
}

#[test]
fn recorder_binary_is_a_single_file() {
    // worker 入口应保持薄：真正的逻辑在 lib 里，便于单测与复用。
    let source = read("src/bin/shot-recorder.rs");
    assert!(
        source.lines().count() <= 400,
        "shot-recorder.rs 应保持薄入口（当前 {} 行）",
        source.lines().count()
    );
    let mut bins = Vec::new();
    collect_rs(&bevy_root().join("src/bin"), &mut bins);
    let recorder_bins: Vec<_> = bins
        .iter()
        .filter(|path| path.file_name().is_some_and(|name| name == "shot-recorder.rs"))
        .collect();
    assert_eq!(recorder_bins.len(), 1, "只应存在一个 shot-recorder 入口");
}
