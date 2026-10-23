//! 本域测试共用的文档夹具（只在 `cfg(test)` 下编译）。
//!
//! 文档直接在 `photocraft_doc` 里构造，不经命令注册表：这里验证的是编码/打包/预算，不是命令
//! 语义，因此不引入命令层依赖，也不依赖渲染后端。

use photocraft_doc::{Color, ColorMode, Document, Layer, LayerContent, SampleType, Size};

/// 空白像素层（`fill` 为 None 时保持全透明）。
pub fn raster_layer(document: &Document, name: &str, rect: Option<(i32, i32, i32, i32)>, fill: Option<[f32; 4]>) -> Layer {
    let mut layer = Layer::raster(name, document.pixel_format());
    if let (Some((x, y, width, height)), Some(rgba)) = (rect, fill)
        && let Some(surface) = layer.surface_mut()
    {
        let area = photocraft_geom::Rect::new(x, y, x + width, y + height);
        let pixel = photocraft_raster::from_rgba(&surface.format(), rgba);
        surface.fill_rect(area, &pixel);
    }
    layer
}

/// 40×30 的 RGB/U8 文档：不透明背景 + 一个 12×8、半透明的像素层 + 一个按资产语法命名的图层。
pub fn document() -> Document {
    let mut document = Document::with_background(
        "sample",
        Size::new(40, 30),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    document.resolution_dpi = 72.0;
    document.layers.push(raster_layer(&document, "半透明", Some((4, 5, 12, 8)), Some([1.0, 0.5, 0.25, 0.5])));
    document.layers.push(raster_layer(&document, "图标.png", Some((20, 10, 6, 6)), Some([0.9, 0.9, 0.1, 1.0])));
    // 名称里带路径片段与保留字符的图层（命名清理与包内路径安全）。
    document.layers.push(raster_layer(&document, "../CON/边框:1", Some((10, 2, 5, 5)), Some([0.1, 0.8, 0.2, 1.0])));
    document
}

/// 多色渐变文档：Save for Web 的调色板/抖动只有在真实多色内容上才有可观察差异。
///
/// 逐列/逐行填充不同颜色（不是单色块），因此量化、抖动与颜色数都会真实改变输出字节。
pub fn gradient_document() -> Document {
    let mut document = Document::with_background(
        "gradient",
        Size::new(64, 48),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.0, 0.0, 0.0),
    );
    let mut layer = Layer::raster("渐变", document.pixel_format());
    if let Some(surface) = layer.surface_mut() {
        for y in 0..48 {
            for x in 0..64 {
                let rgba = [x as f32 / 63.0, y as f32 / 47.0, (x + y) as f32 / 110.0, 1.0];
                let area = photocraft_geom::Rect::new(x, y, x + 1, y + 1);
                let pixel = photocraft_raster::from_rgba(&surface.format(), rgba);
                surface.fill_rect(area, &pixel);
            }
        }
    }
    document.layers.push(layer);
    document
}

/// 只含背景层的文档（逐层导出的「无可交付文件」分支）。
pub fn background_only() -> Document {
    Document::with_background(
        "blank",
        Size::new(8, 8),
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.5, 0.5, 0.5),
    )
}

/// 一个没有可见像素的图层（全透明）。
pub fn empty_layer(document: &Document, name: &str) -> Layer {
    let layer = raster_layer(document, name, None, None);
    assert!(matches!(layer.content, LayerContent::Raster(_)));
    layer
}
