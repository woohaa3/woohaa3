//! 滤镜域的核验贡献（U46–U49）。
//!
//! 本域的滤镜全部是**破坏性像素滤镜**：确认时把结果落到光栅层像素并记一步历史，工程里不会
//! 多出滤镜命令、参数或资源引用字段（design D4：画廊组合一次性落为像素，不引入持久智能滤镜
//! 栈）。因此这里没有新的图层种类要盘点，也不该伪造一个 `filters` 内容类型。
//!
//! 仍然保留两条有意义的边界检查：
//!
//! 1. **不重复占用图层种类**：光栅层由 `painting` 认领；滤镜结果就是普通光栅，`kinds` 里不该
//!    出现第二个条目。这里对任何已认领的图层返回 `None`，让上层继续向下派发。
//! 2. **智能滤镜栈保持关闭**：若某份工程把 `filter.*` 命令塞进智能对象的滤镜栈（`smart-filter`
//!    是本 change 的 NON_GOAL），一律按未开放对象拒绝，不当作不透明载荷保存。

use super::*;

pub(super) fn inspect(
    layer: &photocraft_doc::Layer,
    _depth: usize,
    _out: &mut LayerInspection,
    _embedded_smart: bool,
) -> Option<Result<(), VerifyError>> {
    match &layer.content {
        // 防御性检查：智能对象本身的开放范围由 `smart` 贡献与源树核验决定；这里只保证
        // 「滤镜栈里出现滤镜命令」这条本域边界不会因为派发顺序调整而漏过去。
        LayerContent::Smart(smart) => {
            let filters: Vec<&str> = smart
                .smart_filters
                .iter()
                .map(|filter| filter.command.as_str())
                .filter(|command| command.starts_with("filter."))
                .collect();
            if filters.is_empty() {
                return None;
            }
            Some(Err(err(
                VerifyErrorCode::UnsupportedObject,
                format!(
                    "工程包含未开放的智能滤镜栈：{}（滤镜结果应已落为像素）",
                    filters.join("、")
                ),
            )))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use photocraft_doc::{
        Affine, BlendMode, ColorMode, Document, Layer, LayerContent, SampleType, Size, SmartContentsId, SmartFilter,
        SmartObject, SmartSource,
    };
    use photocraft_format::SaveOptions;

    use crate::{VerifyErrorCode, verify};

    fn raster(name: &str) -> Layer {
        let format = Document::new("t", Size::new(1, 1), ColorMode::Rgb, SampleType::U8).pixel_format();
        let mut layer = Layer::raster(name, format);
        layer.blend = BlendMode::Normal;
        layer
    }

    fn bytes(document: &Document) -> Vec<u8> {
        photocraft_format::save_to_bytes(document, &SaveOptions::default()).expect("保存工程")
    }

    #[test]
    fn filtered_raster_output_has_no_extra_object_kind() {
        // 滤镜确认后工程里只有普通光栅层：核验报告的种类集合不因滤镜而增加。
        let mut document = Document::new("滤镜结果", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
        document.layers = vec![raster("背景"), raster("滤镜后")];
        let summary = verify(&bytes(&document)).expect("滤镜结果应通过核验");
        assert_eq!(summary.object_kinds, vec!["raster"]);
    }

    #[test]
    fn smart_filter_stacks_carrying_our_commands_stay_rejected() {
        // 智能滤镜栈是 NON_GOAL：即使命令属于本域已开放的滤镜，也不能随工程保存。
        let inner = Document::new("内层", Size::new(4, 4), ColorMode::Rgb, SampleType::U8);
        let smart = Layer::new(
            "智能对象",
            LayerContent::Smart(SmartObject {
                contents_id: SmartContentsId::fresh(),
                source: SmartSource::Embedded {
                    file_name: "inner.pcraft".into(),
                    bytes: Arc::new(bytes(&inner)),
                },
                transform: Affine::IDENTITY,
                smart_filters: vec![SmartFilter {
                    command: "filter.blur.gaussianBlur".into(),
                    params: serde_json::json!({ "radius": 2 }),
                    visible: true,
                    blend: BlendMode::Normal,
                    opacity: 1.0,
                }],
                cache: None,
                psd_raw: None,
                filters_enabled: true,
                filter_mask: None,
                warp: None,
                stack_mode: None,
                perspective: None,
            }),
        );
        let mut document = Document::new("工程", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
        document.layers = vec![raster("背景"), smart];
        assert_eq!(
            verify(&bytes(&document)).unwrap_err().code,
            VerifyErrorCode::UnsupportedObject
        );
    }
}
