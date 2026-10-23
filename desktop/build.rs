// Tauri 构建脚本（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，任务 1.1）。
//
// 生成 Tauri 所需的权限/上下文代码。原型不声明自定义命令与默认窗口（窗口在 Rust setup 中
// 创建，以便控制透明 WebView 与 native view 装配）。

// Build-script executables can be reused after moving the checkout. Cargo supplies
// the current manifest directory at execution time; env! would retain the old path.
fn client_root() -> std::path::PathBuf {
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
    );
    manifest.parent().expect("client root").to_path_buf()
}

fn main() {
    println!("cargo:rerun-if-changed=../bevy/src");
    println!("cargo:rerun-if-changed=../bevy/Cargo.toml");
    println!("cargo:rerun-if-changed=../scripts/build-shot-recorder.mjs");
    let root = client_root();
    let revision=std::process::Command::new("git").args(["rev-parse","HEAD"]).current_dir(&root).output().ok()
        .filter(|o|o.status.success()).map(|o|String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_else(||"unknown".into());
    println!("cargo:rustc-env=WOOHAA_DIAGNOSTIC_REVISION={revision}");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let mut command = std::process::Command::new("node");
    command
        .arg(root.join("scripts/build-shot-recorder.mjs"))
        .current_dir(&root);
    if !release {
        command.arg("--debug");
    }
    assert!(
        command.status().expect("build recording worker").success(),
        "recording worker build failed"
    );
    let profile = if release { "release" } else { "debug" };
    // Windows 的产物带 .exe；构建脚本与桌面可执行文件旁的名字都必须使用同一后缀。
    let suffix = std::env::consts::EXE_SUFFIX;
    let source = root.join(format!("bevy/target/{profile}/shot-recorder{suffix}"));
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let target = out
        .ancestors()
        .nth(3)
        .unwrap()
        .join(format!("shot-recorder{suffix}"));
    std::fs::copy(source, target).expect("copy recording worker beside desktop executable");
    tauri_build::build();
}
