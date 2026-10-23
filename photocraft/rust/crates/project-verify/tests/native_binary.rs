//! 原生核验工具的真实子进程回归（change: 2026-10-22-complete-photocraft-webui-editing，任务 10.1）。
//!
//! 只用本 change 新增内容的工程字节，验证**实际构建的原生二进制**会接受它们；这补上了
//! 「核验器在进程内被调用」之外的证据。产物路径由 `PHOTOCRAFT_PROJECT_VERIFIER` 覆盖，
//! 缺省按当前平台在 `packages/project-verifier/dist/bin/` 查找；产物不存在时跳过（不失败）。

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use photocraft_doc::{
    Adjustment, Color, ColorMode, Document, Layer, LayerContent, SampleType, Size, TextLayer,
    vector::{Path, Subpath, VectorMask},
};

fn verifier() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("PHOTOCRAFT_PROJECT_VERIFIER") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    // CARGO_MANIFEST_DIR = rust/crates/project-verify
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/project-verifier/dist/bin");
    let name = if cfg!(windows) { "photocraft-project-verify.exe" } else { "photocraft-project-verify" };
    let path = root.join(name);
    path.is_file().then_some(path)
}

fn run(bytes: &[u8]) -> (i32, String) {
    let path = verifier().expect("调用方先确认产物存在");
    let mut child = Command::new(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("启动原生核验工具");
    child.stdin.as_mut().expect("stdin").write_all(bytes).expect("写入工程字节");
    let output = child.wait_with_output().expect("等待核验结果");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
    )
}

/// 一个包含本 change 全部新内容类型的工程：新区调整、形状层、矢量蒙版、排版参数。
fn delivered_document() -> Document {
    let mut document = Document::with_background(
        "验证",
        Size::new(64, 48),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.5, 0.5, 0.5),
    );
    document.layers.push(Layer::new(
        "色阶",
        LayerContent::Adjustment(Adjustment::identity_levels()),
    ));
    document.layers.push(Layer::new(
        "自然饱和度",
        LayerContent::Adjustment(Adjustment::Vibrance { vibrance: 20.0, saturation: -5.0 }),
    ));
    document.layers.push(Layer::new(
        "黑白",
        LayerContent::Adjustment(Adjustment::BlackWhite {
            weights: [40.0, 60.0, 40.0, 60.0, 20.0, 80.0],
            tint: None,
        }),
    ));
    // U43 的九类调整现已发布：核验器与原生二进制都必须接受，不能只接受直接调整。
    document.layers.push(Layer::new(
        "曝光",
        LayerContent::Adjustment(Adjustment::Exposure { exposure: 1.0, offset: 0.0, gamma: 1.0 }),
    ));
    document.layers.push(Layer::new(
        "阈值",
        LayerContent::Adjustment(Adjustment::Threshold { level: 0.5 }),
    ));
    document.layers.push(Layer::new(
        "可选颜色",
        LayerContent::Adjustment(Adjustment::SelectiveColor { relative: true, adjustments: [[0.0; 4]; 9] }),
    ));
    let path = Path::new(vec![Subpath::polygon(&[(2.0, 2.0), (30.0, 2.0), (30.0, 20.0)])]);
    let mut mask_target = Layer::raster("带矢量蒙版", document.pixel_format());
    mask_target.vector_mask = Some(VectorMask::new(path.clone()));
    document.layers.push(mask_target);
    let mut text = TextLayer {
        text: "排版".into(),
        font_family: "Inter".into(),
        ..Default::default()
    };
    if let Some(run) = text.runs.first_mut() {
        run.style.leading_pt = Some(18.0);
        run.style.tracking = 120.0;
        run.style.baseline_shift_pt = -2.0;
    }
    document.layers.push(Layer::new("排版", LayerContent::Text(text)));
    document
}

#[test]
fn native_verifier_accepts_delivered_content() {
    if verifier().is_none() {
        eprintln!("跳过：未找到原生核验产物（先运行 `pnpm run verifier`）");
        return;
    }
    let bytes = photocraft_format::save_to_bytes(&delivered_document(), &Default::default())
        .expect("保存工程");
    let (code, output) = run(&bytes);
    assert_eq!(code, 0, "原生核验应接受本 change 的合法内容：{output}");
    assert!(output.contains("\"ok\":true"), "{output}");
    assert!(output.contains("\"adjustment\""), "{output}");
    assert!(output.contains("\"shape\"") || output.contains("\"raster\""), "{output}");
}

#[test]
fn native_verifier_rejects_undelivered_content() {
    if verifier().is_none() {
        eprintln!("跳过：未找到原生核验产物（先运行 `pnpm run verifier`）");
        return;
    }
    // 曝光在本 change 已发布并接受；范围外的 LUT（`adjust.lut` 是永久非目标）必须仍被拒绝，
    // 否则「核验通过、运行时拒绝」会同时成立。
    let mut document = delivered_document();
    document.layers.push(Layer::new(
        "LUT",
        LayerContent::Adjustment(Adjustment::ColorLookup {
            name: "Look.cube".into(),
            lut: None,
            size: 2,
            tetrahedral: false,
            dither: false,
        }),
    ));
    let bytes = photocraft_format::save_to_bytes(&document, &Default::default()).expect("保存工程");
    let (code, output) = run(&bytes);
    assert_eq!(code, 2, "范围外的调整必须被拒绝：{output}");
    assert!(output.contains("\"ok\":false"), "{output}");
}

#[test]
fn native_verifier_reports_corrupt_input_without_crashing() {
    if verifier().is_none() {
        eprintln!("跳过：未找到原生核验产物（先运行 `pnpm run verifier`）");
        return;
    }
    let (code, output) = run(b"not a project at all");
    assert_eq!(code, 2);
    assert!(output.contains("\"code\""), "{output}");
}
