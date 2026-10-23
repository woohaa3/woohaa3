//! U57：填充层的核验贡献——纯色/渐变/图案是可重编内容，必须逐参数有界并引用工程内资源。
//!
//! 只做结构与范围检查，不合成像素、不加载图案 surface：
//! - 颜色通道与 alpha 必须有限且在 0..1（与 `Fill` 的序列化字段一致）；
//! - 渐变端点数量、位置、缩放与中点有界，`style` 由上游枚举保证；
//! - 图案引用必须是工程内已声明且通过资源上限的图案（`pattern_support`）。
use photocraft_doc::{Document, Fill, LayerContent};

/// 渐变颜色的端点数上限（与上游一致）。
pub const MAX_GRADIENT_STOPS: usize = 1024;

/// 一个填充层内容是否可保存与重开（需要文档以核对图案引用）。
///
/// 图案引用是文档级信息，逐层 `inspect` 只拿得到 `&Layer`，因此整文档检查入口是
/// [`supported_document`]，由共享 `lib.rs` 在 `verify_container_with` 里调用一次
/// （与既有的 `style_support::supported_document` 同位置）。
pub fn supported(doc: &Document, layer: &photocraft_doc::Layer) -> bool {
    shallow(layer) && match &layer.content {
        // 图案必须随工程保存，否则重开后无法渲染。
        LayerContent::Fill(Fill::Pattern { name, id, .. }) => doc.patterns.iter().any(|pattern| pattern.id == *id && pattern.name == *name),
        _ => true,
    }
}

/// 整文档的填充层检查：逐层参数 + 图案引用必须由工程内资源满足。
pub fn supported_document(doc: &Document) -> bool {
    doc.walk().into_iter().all(|(_, _, layer)| match &layer.content {
        LayerContent::Fill(_) => supported(doc, layer),
        _ => true,
    })
}

/// 不依赖文档的逐参数检查：图层遍历期间用这一份，图案引用由 [`supported`] 在整文档检查。
pub fn shallow(layer: &photocraft_doc::Layer) -> bool {
    let LayerContent::Fill(fill) = &layer.content else { return false };
    match fill {
        Fill::Solid(color) => valid_color(color),
        Fill::Gradient { stops, angle, scale, reverse: _, style: _, opacity_stops, midpoints, offset, dither: _, align: _ } => {
            stops.len() >= 2
                && stops.len() <= MAX_GRADIENT_STOPS
                // 端点位置必须递增（保存前已排序；乱序说明内容被外部改写）。
                && stops.windows(2).all(|pair| pair[0].0 <= pair[1].0)
                && stops.iter().all(|(at, color)| at.is_finite() && (0.0..=1.0).contains(at) && valid_color(color))
                && angle.is_finite()
                && scale.is_finite()
                && (0.1..=1.5).contains(scale)
                && opacity_stops.len() <= MAX_GRADIENT_STOPS
                && opacity_stops.iter().all(|(at, alpha)| at.is_finite() && (0.0..=1.0).contains(at) && alpha.is_finite() && (0.0..=1.0).contains(alpha))
                && midpoints.len() < stops.len().max(1)
                && midpoints.iter().all(|mid| mid.is_finite() && (0.0..=1.0).contains(mid))
                && offset.0.is_finite()
                && offset.1.is_finite()
                && offset.0.abs() <= 1.0e5
                && offset.1.abs() <= 1.0e5
        }
        Fill::Pattern { name, scale, id: _, angle, link: _, phase } => {
            !name.trim().is_empty()
                && name.encode_utf16().count() <= 200
                && scale.is_finite()
                && *scale > 0.0
                && *scale <= 10.0
                && angle.is_finite()
                && (-360.0..=360.0).contains(angle)
                && phase.0.is_finite()
                && phase.1.is_finite()
                && phase.0.abs() <= 1.0e7
                && phase.1.abs() <= 1.0e7
        }
    }
}

fn valid_color(color: &photocraft_doc::Color) -> bool {
    color.c.iter().all(|channel| channel.is_finite() && (-1.0e4..=1.0e4).contains(channel))
        && color.alpha.is_finite()
        && (0.0..=1.0).contains(&color.alpha)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, ColorMode, GradientStyle, Layer, Pattern, SampleType, Size, Surface};

    fn base_document() -> Document {
        let mut doc = Document::new("test", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        doc.patterns = vec![Pattern { id: "grid".into(), name: "格子".into(), width: 8, height: 8, surface: Surface::new(doc.pixel_format()) }];
        doc.layers = vec![Layer::new("填充", LayerContent::Fill(Fill::Solid(Color::WHITE)))];
        doc
    }

    fn with(fill: Fill) -> (Document, Layer) {
        let doc = base_document();
        let layer = Layer::new("填充", LayerContent::Fill(fill));
        (doc, layer)
    }

    #[test]
    fn solid_and_gradient_and_pattern_fills_are_accepted_within_bounds() {
        let (doc, layer) = with(Fill::Solid(Color::rgba(0.2, 0.4, 0.6, 1.0)));
        assert!(supported(&doc, &layer));
        let (doc, layer) = with(Fill::gradient(vec![(0.0, Color::WHITE), (1.0, Color::BLACK)], 45.0, 1.0, GradientStyle::Linear, false));
        assert!(supported(&doc, &layer));
        let (doc, layer) = with(Fill::Pattern { name: "格子".into(), scale: 1.0, id: "grid".into(), angle: 0.0, link: true, phase: (0.0, 0.0) });
        assert!(supported(&doc, &layer));
    }

    #[test]
    fn out_of_range_colours_stops_scale_and_missing_patterns_are_rejected() {
        let (doc, layer) = with(Fill::Solid(Color::rgba(0.0, 0.0, 0.0, 2.0)));
        assert!(!supported(&doc, &layer));
        let (doc, layer) = with(Fill::gradient(vec![(0.9, Color::WHITE), (0.1, Color::BLACK)], 0.0, 1.0, GradientStyle::Linear, false));
        assert!(!supported(&doc, &layer), "端点必须递增");
        let (doc, layer) = with(Fill::gradient(vec![(0.0, Color::WHITE)], 0.0, 1.0, GradientStyle::Linear, false));
        assert!(!supported(&doc, &layer), "至少两个端点");
        let (doc, layer) = with(Fill::gradient(vec![(0.0, Color::WHITE), (1.0, Color::BLACK)], 0.0, 50.0, GradientStyle::Linear, false));
        assert!(!supported(&doc, &layer), "缩放超范围");
        let (doc, layer) = with(Fill::Pattern { name: "缺失".into(), scale: 1.0, id: "missing".into(), angle: 0.0, link: true, phase: (0.0, 0.0) });
        assert!(!supported(&doc, &layer), "图案必须随工程保存");
        let (doc, layer) = with(Fill::Pattern { name: "格子".into(), scale: 0.0, id: "grid".into(), angle: 0.0, link: true, phase: (0.0, 0.0) });
        assert!(!supported(&doc, &layer), "缩放必须为正");
        let mut stops: Vec<(f32, Color)> = (0..=(MAX_GRADIENT_STOPS as u32)).map(|i| (i as f32 / MAX_GRADIENT_STOPS as f32, Color::WHITE)).collect();
        stops[1].0 = 0.0;
        let (doc, layer) = with(Fill::gradient(stops, 0.0, 1.0, GradientStyle::Linear, false));
        assert!(!supported(&doc, &layer), "端点数超上限");
        let base = base_document();
        let raster = Layer::raster("像素", base.pixel_format());
        assert!(!supported(&base, &raster));
    }
}
