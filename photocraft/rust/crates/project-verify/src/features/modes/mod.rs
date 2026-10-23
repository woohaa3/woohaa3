//! 图像模式与调色板的工程核验贡献（U45）。
//!
//! 模式、颜色表与双色调油墨是**文档级**字段，而这条核验管线只在图层级调用检查器
//! （[`super::inspect_content`]），因此 [`inspect`] 继续返回 `None`，由绘制域检查栅格内容。
//! 文档级规则写在 [`validate_document`]：有界的颜色表、油墨、位深与颜色模型。
//!
//! [`validate_document`] 已由共享的 `project-verify/src/lib.rs::verify_container_with` 在样式
//! 校验之后调用一次。规则刻意**不比编辑器更严**：只校验颜色表、油墨与颜色模型；位深与像素格式
//! 不参与判定（实测 `file.new` 接受 `depth:16`/`cmyk`/`lab` 并能保存重开，置入层用素材自身格式）。

use super::*;
use photocraft_doc::{ColorMode, Document, Duotone};

/// 颜色表条目上限（与内核 `mode::MAX_TABLE_COLORS` 一致）。
const MAX_TABLE_COLORS: usize = 256;
/// 双色调油墨数上限。
const MAX_INKS: usize = 4;
/// 单条油墨曲线的最多控制点。
const MAX_INK_CURVE_POINTS: usize = 64;
/// 油墨名长度上限。
const MAX_INK_NAME: usize = 64;

pub(super) fn inspect(_layer: &photocraft_doc::Layer, _depth: usize, _out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    None
}

fn unsupported(message: &str) -> VerifyError {
    err(VerifyErrorCode::UnsupportedObject, message)
}

fn validate_table(table: &photocraft_doc::ColorTable) -> Result<(), VerifyError> {
    if table.colors.is_empty() || table.colors.len() > MAX_TABLE_COLORS {
        return Err(unsupported("工程颜色表条目数超出 1–256"));
    }
    if let Some(index) = table.transparent
        && usize::from(index) >= table.colors.len()
    {
        return Err(unsupported("工程颜色表的透明索引越界"));
    }
    Ok(())
}

fn validate_duotone(duotone: &Duotone) -> Result<(), VerifyError> {
    if duotone.inks.is_empty() || duotone.inks.len() > MAX_INKS {
        return Err(unsupported("工程双色调油墨数超出 1–4"));
    }
    for ink in &duotone.inks {
        if ink.name.is_empty() || ink.name.chars().count() > MAX_INK_NAME || ink.name.chars().any(char::is_control) {
            return Err(unsupported("工程双色调油墨名非法"));
        }
        if ink.color.iter().any(|value| !value.is_finite() || !(0.0..=1.0).contains(value)) {
            return Err(unsupported("工程双色调油墨颜色超出 0–1"));
        }
        if ink.curve.len() > MAX_INK_CURVE_POINTS {
            return Err(unsupported("工程双色调油墨曲线控制点过多"));
        }
        for point in &ink.curve {
            if !point.input.is_finite() || !(0.0..=1.0).contains(&point.input)
                || !point.output.is_finite() || !(0.0..=1.0).contains(&point.output)
            {
                return Err(unsupported("工程双色调油墨曲线超出 0–1"));
            }
        }
    }
    Ok(())
}

/// 文档级模式数据核验：颜色模型、位深、颜色表与油墨都必须在本范围的真实数据形状内。
///
/// **只检查本域拥有的模式数据**：位深、颜色模型是否属于已开放集合、颜色表与油墨是否自洽。
/// 像素格式与模式的对应关系不由这里判定——上游 `Document::pixel_format()` 已把它写死
/// （索引色/多通道按 RGB 展开、位图/双色调按灰度展开），本域再断言一次只会与内核重复，
/// 而且实测置入层在灰度/CMYK/Lab 文档里用的是**置入素材自身**的格式，那并不是模式错误。
///
/// 位深限制同理只覆盖本域承诺的转换范围：16 位文档不在本次转换范围，但它仍然是内核能创建、
/// 能保存、能重开的合法工程（`file.new` 接受 `depth:16`）。因此这里**不拒绝** 16 位工程，
/// 只拒绝本域无法解释的状态；把 16 位写进核验拒绝会让核验器比编辑器更严，产生假失败。
pub(crate) fn validate_document(document: &Document) -> Result<(), VerifyError> {
    // 已开放的颜色模型：本 change 交付的五种 + 内核本就支持且未收窄的 CMYK/Lab。
    // 其他（多通道等）仍按「未开放对象」拒绝。
    if !matches!(
        document.mode,
        ColorMode::Rgb
            | ColorMode::Grayscale
            | ColorMode::Bitmap
            | ColorMode::Duotone
            | ColorMode::Indexed
            | ColorMode::Cmyk
            | ColorMode::Lab
    ) {
        return Err(unsupported("工程包含未开放的色彩模型"));
    }
    match document.mode {
        ColorMode::Indexed => {
            let table = document.color_table.as_ref().ok_or_else(|| unsupported("索引色工程缺少颜色表"))?;
            validate_table(table)?;
        }
        _ => {
            if document.color_table.is_some() {
                return Err(unsupported("非索引色工程不得携带颜色表"));
            }
        }
    }
    match document.mode {
        ColorMode::Duotone => {
            let duotone = document.duotone.as_ref().ok_or_else(|| unsupported("双色调工程缺少油墨"))?;
            validate_duotone(duotone)?;
        }
        _ => {
            if document.duotone.is_some() {
                return Err(unsupported("非双色调工程不得携带油墨"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
// 测试用 panic/expect 表示失败即可：crate 级的 `deny(clippy::unwrap_used, …)` 面向生产代码。
// （`--all-targets` 下其它既有测试模块也使用同样的写法，见 verification.md 的 clippy 记录。）
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use photocraft_doc::{DuotoneInk, Layer, SampleType, Size};

    fn document(mode: ColorMode) -> Document {
        let mut doc = Document::new("mode", Size::new(4, 4), mode, SampleType::U8);
        doc.layers.push(Layer::raster("Background", doc.pixel_format()));
        doc
    }

    #[test]
    fn accepts_every_supported_mode_with_its_data() {
        for mode in [ColorMode::Rgb, ColorMode::Grayscale] {
            assert!(validate_document(&document(mode)).is_ok(), "{mode:?}");
        }
        let mut indexed = document(ColorMode::Indexed);
        indexed.color_table = Some(photocraft_doc::ColorTable { colors: vec![[0, 0, 0], [255, 255, 255]], transparent: Some(1) });
        assert!(validate_document(&indexed).is_ok());

        let mut bitmap = document(ColorMode::Bitmap);
        bitmap.layers[0] = Layer::raster("Background", bitmap.pixel_format());
        assert!(validate_document(&bitmap).is_ok());

        let mut duotone = document(ColorMode::Duotone);
        duotone.layers[0] = Layer::raster("Background", duotone.pixel_format());
        duotone.duotone = Some(Duotone { inks: vec![DuotoneInk::new("Black", [0.0, 0.0, 0.0])], psd_raw: None });
        assert!(validate_document(&duotone).is_ok());
    }

    #[test]
    fn rejects_palettes_and_inks_out_of_bounds() {
        let mut indexed = document(ColorMode::Indexed);
        assert!(validate_document(&indexed).is_err(), "缺少颜色表");
        indexed.color_table = Some(photocraft_doc::ColorTable { colors: Vec::new(), transparent: None });
        assert!(validate_document(&indexed).is_err(), "空颜色表");
        indexed.color_table = Some(photocraft_doc::ColorTable { colors: vec![[0, 0, 0]], transparent: Some(1) });
        assert!(validate_document(&indexed).is_err(), "透明索引越界");

        let mut duotone = document(ColorMode::Duotone);
        duotone.layers[0] = Layer::raster("Background", duotone.pixel_format());
        duotone.duotone = Some(Duotone { inks: Vec::new(), psd_raw: None });
        assert!(validate_document(&duotone).is_err(), "没有油墨");
        let mut ink = DuotoneInk::new("Black", [0.0, 0.0, 0.0]);
        ink.color = [1.5, 0.0, 0.0];
        duotone.duotone = Some(Duotone { inks: vec![ink], psd_raw: None });
        assert!(validate_document(&duotone).is_err(), "油墨颜色越界");
    }

    #[test]
    fn rejects_out_of_scope_models_and_mismatched_palette_state() {
        // 多通道没有对应的用户入口，仍按未开放模型拒绝。
        assert!(validate_document(&document(ColorMode::Multichannel)).is_err());
        // CMYK/Lab 是内核本就支持、能创建能保存的文档，核验器不能比编辑器更严。
        assert!(validate_document(&document(ColorMode::Cmyk)).is_ok());
        assert!(validate_document(&document(ColorMode::Lab)).is_ok());
        // 16 位不在本域转换范围，但 `file.new` 接受它、能保存能重开，因此不在这里拒绝。
        let mut deep = Document::new("deep", Size::new(2, 2), ColorMode::Rgb, SampleType::U16);
        deep.layers.push(Layer::raster("Background", deep.pixel_format()));
        assert!(validate_document(&deep).is_ok(), "16 位工程仍是合法工程");
        // 颜色表混进 RGB 工程。
        let mut rgb = document(ColorMode::Rgb);
        rgb.color_table = Some(photocraft_doc::ColorTable { colors: vec![[0, 0, 0]], transparent: None });
        assert!(validate_document(&rgb).is_err());
        // 像素格式不参与判定：置入层在灰度/CMYK/Lab 文档里用的是素材自身格式（实测），
        // 那不是模式错误，因此灰度工程里出现 RGB 像素层不得被拒绝。
        let mut gray = Document::new("gray", Size::new(2, 2), ColorMode::Grayscale, SampleType::U8);
        let rgb_doc = Document::new("rgb", Size::new(2, 2), ColorMode::Rgb, SampleType::U8);
        gray.layers.push(Layer::raster("Placed", rgb_doc.pixel_format()));
        assert!(validate_document(&gray).is_ok(), "置入层的像素格式不是模式错误");
    }

    /// 用**真实工程字节**核对：保存 → 重新解析 → 文档级规则。
    /// 这条覆盖「manifest 声明的模式」与「解析后的文档」是否一致，而不只是内存里构造的 Document。
    #[test]
    fn validates_mode_data_after_a_real_save_and_reload() {
        for (mode, setup) in [
            (ColorMode::Rgb, (|_: &mut Document| {}) as fn(&mut Document)),
            (ColorMode::Grayscale, (|doc: &mut Document| doc.layers[0] = Layer::raster("Background", doc.pixel_format())) as fn(&mut Document)),
        ] {
            let mut doc = document(mode);
            setup(&mut doc);
            let bytes = photocraft_format::save_to_bytes(&doc, &Default::default()).expect("保存工程");
            let loaded = photocraft_format::load_from_bytes(&bytes).expect("重开工程");
            assert_eq!(loaded.mode, mode);
            assert!(validate_document(&loaded).is_ok(), "{mode:?} 经真实工程往返后应通过");
        }

        let mut indexed = document(ColorMode::Indexed);
        indexed.color_table = Some(photocraft_doc::ColorTable {
            colors: vec![[0, 0, 0], [255, 0, 0], [0, 255, 0]],
            transparent: Some(2),
        });
        let bytes = photocraft_format::save_to_bytes(&indexed, &Default::default()).expect("保存索引色工程");
        let loaded = photocraft_format::load_from_bytes(&bytes).expect("重开索引色工程");
        assert_eq!(loaded.color_table.as_ref().map(|table| table.colors.len()), Some(3));
        assert_eq!(loaded.color_table.as_ref().and_then(|table| table.transparent), Some(2));
        assert!(validate_document(&loaded).is_ok());

        let mut duotone = document(ColorMode::Duotone);
        duotone.layers[0] = Layer::raster("Background", duotone.pixel_format());
        duotone.duotone = Some(Duotone {
            inks: vec![
                DuotoneInk::new("Black", [0.0, 0.0, 0.0]),
                DuotoneInk::new("Warm Brown", [0.62, 0.38, 0.18]),
            ],
            psd_raw: None,
        });
        let bytes = photocraft_format::save_to_bytes(&duotone, &Default::default()).expect("保存双色调工程");
        let loaded = photocraft_format::load_from_bytes(&bytes).expect("重开双色调工程");
        assert_eq!(loaded.duotone.as_ref().map(|ink| ink.inks.len()), Some(2));
        assert!(validate_document(&loaded).is_ok());
    }

    /// 核验器**不得比编辑器更严**：编辑器能创建并保存的工程，核验必须仍然通过。
    ///
    /// 这些组合来自真实 WASM 实测（`file.new` 接受 `mode:cmyk|lab`、`depth:16`，保存后
    /// `photocraft-project-verify` 返回 `ok:true`）。若把它们写进拒绝规则，接入
    /// `verify_container_with` 后就会出现「编辑器能存、核验说坏」的假失败。
    #[test]
    fn never_rejects_a_document_the_editor_can_create_and_save() {
        for (mode, depth) in [
            (ColorMode::Rgb, SampleType::U16),
            (ColorMode::Grayscale, SampleType::U16),
            (ColorMode::Cmyk, SampleType::U8),
            (ColorMode::Lab, SampleType::U8),
        ] {
            let mut doc = Document::new("creator", Size::new(4, 4), mode, depth);
            doc.layers.push(Layer::raster("Background", doc.pixel_format()));
            let bytes = photocraft_format::save_to_bytes(&doc, &Default::default())
                .unwrap_or_else(|error| panic!("{mode:?}/{depth:?} 应能保存：{error}"));
            let loaded = photocraft_format::load_from_bytes(&bytes)
                .unwrap_or_else(|error| panic!("{mode:?}/{depth:?} 应能重开：{error}"));
            validate_document(&loaded)
                .unwrap_or_else(|error| panic!("{mode:?}/{depth:?} 不该被核验拒绝：{}", error.message));
        }
    }
}
