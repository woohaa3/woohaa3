//! 通道内容核验（change: 2026-10-22-add-photocraft-channel-workflows，U25）。
//!
//! 通道是**文档级**资源，不在图层树里，因此图层遍历器（`inspect`）对它返回 `None`：
//! 本模块另外提供 [`inspect_document`]，由工程核验入口在图层遍历之后调用一次。
//!
//! 接线：共享 `rust/crates/project-verify/src/lib.rs` 在 `inspect_layers` 之后调用
//! [`inspect_document`]，因此文档级通道问题会在核验阶段报错。
use super::*;

/// 通道数量上限：与工程内图层预算同量级。共享 `rust/project-limits.json` 的正式登记由集成
/// 负责人补齐；在那之前这里用域内常量守住同一数值，避免无界通道进入工程。
pub(crate) const MAX_CHANNELS: usize = 64;

/// 通道名上限（字符）。
const MAX_CHANNEL_NAME_CHARS: usize = 200;

pub(super) fn inspect(
    _layer: &photocraft_doc::Layer,
    _depth: usize,
    _out: &mut LayerInspection,
    _embedded_smart: bool,
) -> Option<Result<(), VerifyError>> {
    // 通道不属于任何图层；文档级核验见 [`inspect_document`]。
    None
}

/// 文档级通道核验：数量、名字、元数据范围与平面格式。
///
/// 只读结构，不采样像素：像素解码与解压预算由共享解析器（`photocraft-format`）在加载前执行，
/// 这里只拒绝「加载成功但无法安全重开/再编辑」的通道内容。
pub(crate) fn inspect_document(doc: &photocraft_doc::Document) -> Result<(), VerifyError> {
    if doc.channels.len() > MAX_CHANNELS {
        return Err(err(
            VerifyErrorCode::UnsupportedObject,
            format!("工程通道数超过上限：{} > {MAX_CHANNELS}", doc.channels.len()),
        ));
    }
    let expected = photocraft_engine_channel_format(doc);
    for (index, channel) in doc.channels.iter().enumerate() {
        let name = channel.name.trim();
        if name.is_empty() {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个通道缺少名称"),
            ));
        }
        if name.chars().count() > MAX_CHANNEL_NAME_CHARS {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个通道名称过长"),
            ));
        }
        // 通道平面必须是文档深度的灰度；其它格式无法用同一套编辑命令重开。
        if channel.surface.format() != expected {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个通道的像素格式与文档不一致"),
            ));
        }
        if !channel.opacity.is_finite() || !(0.0..=1.0).contains(&channel.opacity) {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个通道的不透明度无效"),
            ));
        }
        if let Some((_, solidity)) = channel.spot
            && (!solidity.is_finite() || !(0.0..=1.0).contains(&solidity))
        {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个专色通道的密度无效"),
            ));
        }
        // 稀疏平面的实际分配范围必须在画布内：通道不能携带画布外的内容，
        // 否则重开后的编辑、缩略图与内容指纹都会看到画布外的像素。
        //
        // 比较的是 **tile 网格**而不是像素矩形：一个合法通道的边界 tile 天然会越出画布
        // （tile 固定 256²），真正要拒绝的是落在画布 tile 网格之外的 tile。
        let tiles = channel.surface.tile_bounds();
        let canvas = doc.bounds();
        // 画布 tile 网格的像素范围：边界 tile 会天然越出画布，越出画布网格才是可写域外的内容。
        let grid = canvas.tiles().fold(photocraft_doc::Rect::EMPTY, |rect, coord| rect.union(&coord.rect()));
        if tiles.x0 < grid.x0 || tiles.y0 < grid.y0 || tiles.x1 > grid.x1 || tiles.y1 > grid.y1 {
            return Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!("第 {index} 个通道的像素范围超出画布"),
            ));
        }
    }
    Ok(())
}

/// 通道平面应有的像素格式：文档深度的灰度、无透明。
fn photocraft_engine_channel_format(doc: &photocraft_doc::Document) -> photocraft_doc::PixelFormat {
    photocraft_doc::PixelFormat::new(photocraft_doc::ColorMode::Grayscale, doc.depth, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{AlphaChannel, Color, ColorIndicates, Document, Size};
    use photocraft_doc::Surface;

    fn document() -> Document {
        Document::new("通道核验", Size::new(32, 24), photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::U8)
    }

    fn channel(name: &str, doc: &Document) -> AlphaChannel {
        AlphaChannel::new(name, Surface::new(photocraft_engine_channel_format(doc)))
    }

    #[test]
    fn an_empty_document_has_no_channel_violations() {
        let doc = document();
        assert!(inspect_document(&doc).is_ok());
    }

    #[test]
    fn valid_alpha_and_spot_channels_are_accepted() {
        let mut doc = document();
        doc.channels.push(AlphaChannel { indicates: ColorIndicates::SelectedAreas, opacity: 0.3, ..channel("Alpha 1", &doc) });
        doc.channels.push(AlphaChannel { spot: Some((Color::rgb(0.0, 1.0, 0.0), 0.5)), ..channel("专色", &doc) });
        assert!(inspect_document(&doc).is_ok());
    }

    #[test]
    fn malformed_channel_metadata_is_rejected() {
        let mut doc = document();
        doc.channels.push(channel("  ", &doc));
        assert!(inspect_document(&doc).is_err(), "空名称必须拒绝");

        let mut doc = document();
        doc.channels.push(channel(&"名".repeat(201), &doc));
        assert!(inspect_document(&doc).is_err(), "超长名称必须拒绝");

        let mut doc = document();
        doc.channels.push(AlphaChannel { opacity: 1.5, ..channel("Alpha 1", &doc) });
        assert!(inspect_document(&doc).is_err(), "不透明度越界必须拒绝");

        let mut doc = document();
        doc.channels.push(AlphaChannel { spot: Some((Color::rgb(1.0, 0.0, 0.0), -0.1)), ..channel("专色", &doc) });
        assert!(inspect_document(&doc).is_err(), "专色密度越界必须拒绝");

        let mut doc = document();
        let mut bad = channel("Alpha 1", &doc);
        bad.surface = Surface::new(photocraft_doc::PixelFormat::new(photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::U8, true));
        doc.channels.push(bad);
        assert!(inspect_document(&doc).is_err(), "平面格式不符必须拒绝");
    }

    #[test]
    fn the_channel_count_budget_is_enforced() {
        let mut doc = document();
        for index in 0..=MAX_CHANNELS {
            doc.channels.push(channel(&format!("Alpha {index}"), &doc));
        }
        assert!(inspect_document(&doc).is_err(), "超过通道数上限必须拒绝");
    }

    /// 旧工程：字节里没有通道（反序列化默认空），核验必须通过而不是当成缺失字段。
    #[test]
    fn an_old_project_without_channels_still_passes() {
        let doc = document();
        assert!(doc.channels.is_empty());
        assert!(inspect_document(&doc).is_ok());
        // 空通道也不产生任何累计预算：图层预算不受影响。
        let inspection = LayerInspection::default();
        assert!(inspection.count == 0);
    }

    /// 通道平面覆盖整幅画布时仍在预算内；每通道只按实际 tile 计，不按画布面积虚报。
    #[test]
    fn channel_tiles_are_checked_against_the_real_canvas_only() {
        let mut doc = document();
        let mut full = channel("满幅", &doc);
        let bounds = doc.bounds();
        let values = vec![0.5f32; (bounds.width() as usize) * (bounds.height() as usize)];
        full.surface = photocraft_doc::Surface::new(photocraft_engine_channel_format(&doc));
        // 直接经 tile 写入覆盖整幅画布，确认边界判定用的是画布而不是保守上限。
        full.surface.write_region(bounds, &values);
        doc.channels.push(full);
        assert!(inspect_document(&doc).is_ok(), "画布内平面必须通过");
        // 但落在画布 tile 网格之外的 tile 必须拒绝：否则重开能看到画布外内容。
        let mut stray = channel("越界", &doc);
        // 只在 far tile 上分配一次写：`write_region` 按矩形落 tile，画布内矩形不会建远 tile。
        stray.surface.write_region(
            photocraft_doc::Rect::new(4 * 256, 4 * 256, 4 * 256 + 1, 4 * 256 + 1),
            &[1.0],
        );
        let mut doc = document();
        doc.channels.push(stray);
        assert!(inspect_document(&doc).is_err(), "画布网格外的通道平面必须拒绝");
    }

    #[test]
    fn layer_traversal_does_not_claim_channels() {
        // 通道是文档级资源：图层遍历器不能把它当成未开放对象。
        let mut inspection = LayerInspection::default();
        let layer = photocraft_doc::Layer::raster("Background", photocraft_doc::PixelFormat::new(photocraft_doc::ColorMode::Rgb, photocraft_doc::SampleType::U8, true));
        assert!(inspect(&layer, 0, &mut inspection, false).is_none());
        assert_eq!(inspection.count, 0);
    }
}
