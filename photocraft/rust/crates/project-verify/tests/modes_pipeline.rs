//! 模式数据的核验接入回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 4.4）。
//!
//! `features/modes/mod.rs` 的单测直接调 `validate_document`；这里走**公开入口**
//! `photocraft_project_verify::verify`，确认共享管线真的调用了它，并确认它没有比编辑器更严。
//!
//! 只依赖本 crate 已有的 `photocraft-doc`/`photocraft-format`：用上游真实构造函数造文档，
//! 走真实保存路径，不引入新的跨 crate 依赖（那属于共享构建改动）。

use photocraft_doc::{Color, ColorMode, ColorTable, Document, Duotone, DuotoneInk, SampleType, Size};

fn document(mode: ColorMode, depth: SampleType) -> Document {
    Document::with_background("verify", Size::new(8, 6), mode, depth, Color::rgb(0.2, 0.4, 0.8))
}

fn save(document: &Document) -> Vec<u8> {
    photocraft_format::save_to_bytes(document, &Default::default()).expect("保存工程")
}

#[test]
fn the_shared_pipeline_accepts_indexed_and_duotone_documents() {
    let mut indexed = document(ColorMode::Indexed, SampleType::U8);
    indexed.color_table = Some(ColorTable {
        colors: vec![[0, 0, 0], [255, 255, 255], [0x33, 0x66, 0xcc]],
        transparent: None,
    });
    photocraft_project_verify::verify(&save(&indexed)).expect("索引色工程应通过核验");

    let mut duotone = document(ColorMode::Duotone, SampleType::U8);
    duotone.duotone = Some(Duotone {
        inks: vec![
            DuotoneInk::new("Black", [0.0, 0.0, 0.0]),
            DuotoneInk::new("Warm", [0.62, 0.38, 0.18]),
        ],
        psd_raw: None,
    });
    photocraft_project_verify::verify(&save(&duotone)).expect("双色调工程应通过核验");

    photocraft_project_verify::verify(&save(&document(ColorMode::Bitmap, SampleType::U8)))
        .expect("位图工程应通过核验");
    photocraft_project_verify::verify(&save(&document(ColorMode::Grayscale, SampleType::U8)))
        .expect("灰度工程应通过核验");
}

#[test]
fn the_verifier_is_not_stricter_than_the_editor() {
    // 编辑器能存、核验必须接受：16 位与范围外颜色模型都不在本域判定范围内。
    photocraft_project_verify::verify(&save(&document(ColorMode::Rgb, SampleType::U16)))
        .expect("RGB/U16 工程应通过核验");
    photocraft_project_verify::verify(&save(&document(ColorMode::Grayscale, SampleType::U16)))
        .expect("灰度/U16 工程应通过核验");
    photocraft_project_verify::verify(&save(&document(ColorMode::Cmyk, SampleType::U8)))
        .expect("CMYK 工程应通过核验（本域不判定）");
    photocraft_project_verify::verify(&save(&document(ColorMode::Lab, SampleType::U8)))
        .expect("Lab 工程应通过核验（本域不判定）");
}

#[test]
fn structurally_invalid_mode_data_is_still_rejected_through_the_pipeline() {
    // 反向约束：接入不能变成「什么都不查」。索引色缺颜色表就是结构损坏。
    let mut broken = document(ColorMode::Indexed, SampleType::U8);
    broken.color_table = None;
    assert!(
        photocraft_project_verify::verify(&save(&broken)).is_err(),
        "索引色工程缺颜色表应被拒绝"
    );

    // 空颜色表同样是结构损坏。
    let mut empty = document(ColorMode::Indexed, SampleType::U8);
    empty.color_table = Some(ColorTable { colors: Vec::new(), transparent: None });
    assert!(
        photocraft_project_verify::verify(&save(&empty)).is_err(),
        "空颜色表应被拒绝"
    );
}
