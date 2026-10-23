use super::*;

/// 非破坏羽化上限：源像素。与 `layer.layerMask.edit` 的命令门一致（U24）。
pub(crate) const MAX_MASK_FEATHER: f32 = 1000.0;

pub(super) fn inspect(_layer: &photocraft_doc::Layer, _depth: usize, _out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    None
}

pub(crate) fn inspect_mask(layer: &photocraft_doc::Layer) -> Result<(), VerifyError> {
    if let Some(mask) = &layer.mask {
        // 像素蒙版（U24）：density/feather 是非破坏属性，必须有限且在命令接受范围内；
        // 蒙版表面必须是灰度，否则重开后合成读到的通道与保存前不一致。
        if !mask.density.is_finite() || !(0.0..=1.0).contains(&mask.density) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "像素蒙版密度越界"));
        }
        if !mask.feather.is_finite() || !(0.0..=MAX_MASK_FEATHER).contains(&mask.feather) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "像素蒙版羽化越界"));
        }
        let format = mask.surface.format();
        if format.mode != photocraft_doc::ColorMode::Grayscale || format.sample != photocraft_doc::SampleType::U8 {
            return Err(err(VerifyErrorCode::UnsupportedObject, "像素蒙版表面必须是 8 位灰度"));
        }
    }
    if let Some(mask) = &layer.vector_mask {
        // 矢量蒙版（change: 2026-10-22，P7）：几何必须有界，且不能是空路径。
        if mask.path.is_empty() {
            return Err(err(VerifyErrorCode::UnsupportedObject, "工程包含空的矢量蒙版路径"));
        }
        if !mask.density.is_finite() || !(0.0..=1.0).contains(&mask.density)
            || !mask.feather.is_finite() || !(0.0..=2048.0).contains(&mask.feather) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "矢量蒙版密度或羽化越界"));
        }
        if !path_bounded(&mask.path) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "矢量蒙版几何越界"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{ColorMode, Document, Layer, SampleType, Size};

    fn raster() -> Layer {
        let mut document = Document::new("t", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        let format = document.pixel_format();
        let _ = &mut document;
        Layer::raster("带蒙版", format)
    }

    #[test]
    fn pixel_mask_attributes_must_stay_inside_the_command_range() {
        let mut layer = raster();
        assert!(inspect_mask(&layer).is_ok(), "无蒙版时不受限");
        layer.mask = Some(photocraft_doc::LayerMask::reveal_all());
        assert!(inspect_mask(&layer).is_ok(), "density=1、feather=0 合法");
        for (density, feather) in [(0.0, 0.0), (0.5, 6.0), (1.0, MAX_MASK_FEATHER)] {
            layer.mask.as_mut().expect("蒙版").density = density;
            layer.mask.as_mut().expect("蒙版").feather = feather;
            assert!(inspect_mask(&layer).is_ok(), "合法属性 {density}/{feather}");
        }
        for (density, feather) in [
            (1.5, 0.0),
            (-0.1, 0.0),
            (f32::NAN, 0.0),
            (f32::INFINITY, 0.0),
            (1.0, -1.0),
            (1.0, MAX_MASK_FEATHER + 0.5),
            (1.0, f32::NAN),
        ] {
            layer.mask.as_mut().expect("蒙版").density = density;
            layer.mask.as_mut().expect("蒙版").feather = feather;
            let failure = inspect_mask(&layer).expect_err("越界属性必须被拒绝");
            assert_eq!(failure.code, VerifyErrorCode::UnsupportedObject);
        }
    }

    #[test]
    fn pixel_mask_surface_must_be_eight_bit_grayscale() {
        let mut layer = raster();
        let mut mask = photocraft_doc::LayerMask::reveal_all();
        mask.surface = photocraft_doc::Surface::new(
            Document::new("t", Size::new(4, 4), ColorMode::Rgb, SampleType::U8).pixel_format(),
        );
        layer.mask = Some(mask);
        let failure = inspect_mask(&layer).expect_err("彩色蒙版表面必须被拒绝");
        assert_eq!(failure.code, VerifyErrorCode::UnsupportedObject);
    }
}
