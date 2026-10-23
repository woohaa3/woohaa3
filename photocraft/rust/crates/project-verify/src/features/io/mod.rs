//! 栅格交换域的核验贡献
//! （change: 2026-10-22-add-photocraft-raster-interchange，U05/U06/U07）。
//!
//! ## 为什么是空贡献
//!
//! 本 change **不新增任何持久内容**：没有新的图层类型、没有新的 `.pcraft` 字段、没有新的资源
//! 引用。格式矩阵、导出设置、导出预设、逐层/资产包都是**运行时**产物：
//!
//! - 打开：解码成功后才建普通文档（背景层或普通像素层），沿用既有对象类型；
//! - 导出/Save for Web/逐层/按名称资产：只读文档与选择，返回字节与报告，不写回文档；
//! - 导出预设属于本域本机设置（`packages/protocol` 的纯数据 + 宿主存储），不进入内容指纹。
//!
//! 因此核验器不需要认识新对象：任何本域「无法表达」的项都不落工程，而是**报告**在导出报告里
//! （逐层 `error`、资产 `rejected`、预检拒绝原因）。若将来本域引入持久字段，必须在这里补齐
//! 有界内容/引用验证，并同时给出旧运行时能力协商与解码前预算。
//!
//! ## 预算不改写
//!
//! 本域预算（单边、像素、文件数、字节、命名长度）是**更严或相等**的域内限制，由
//! `packages/protocol/src/features/io/interchange-budgets.json` 唯一声明；它不抬高
//! [`crate::limits`] 的工程上限（见本文件测试）。

use crate::{LayerInspection, VerifyError};

pub(super) fn inspect(_layer: &photocraft_doc::Layer, _depth: usize, _out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    None
}

#[cfg(test)]
mod tests {
    use photocraft_doc::{Adjustment, Color, ColorMode, Document, Layer, LayerContent, SampleType, Size};

    /// 本域预算的唯一权威文件（与编辑内核 `include_str!` 的是同一份）。
    const BUDGETS: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/src/features/io/interchange-budgets.json"
    ));

    fn layer_of(kind: &str, document: &Document) -> Layer {
        match kind {
            "raster" => Layer::raster("pixels", document.pixel_format()),
            "text" => Layer::new("t", LayerContent::Text(Default::default())),
            "adjustment" => Layer::new("a", LayerContent::Adjustment(Adjustment::Invert)),
            _ => unreachable!("未定义的夹具类型"),
        }
    }

    #[test]
    fn io_never_claims_a_layer_so_no_new_object_type_reaches_the_project() {
        let document = Document::with_background("d", Size::new(8, 8), ColorMode::Rgb, SampleType::U8, Color::rgb(0.0, 0.0, 0.0));
        let mut inspection = crate::LayerInspection { count: 0, depth: 0, kinds: Default::default(), manual_budget: 0 };
        for kind in ["raster", "text", "adjustment"] {
            let layer = layer_of(kind, &document);
            assert!(
                super::inspect(&layer, 0, &mut inspection, false).is_none(),
                "{kind} 不应由交换域认领"
            );
        }
        // 认领为空 ⇒ 不产生新的 kind、不改变计数与预算。
        assert!(inspection.kinds.is_empty());
        assert_eq!(inspection.count, 0);
        assert_eq!(inspection.manual_budget, 0);
    }

    #[test]
    fn interchange_budgets_never_raise_the_project_limits() {
        let budgets: serde_json::Value = serde_json::from_str(BUDGETS).expect("域预算 JSON 必须可解析");
        let number = |key: &str| budgets[key].as_u64().unwrap_or_else(|| panic!("缺少 {key}"));
        assert!(number("maxExportDimension") <= u64::from(crate::limits::MAX_CANVAS_SIDE));
        assert!(number("maxExportPixels") <= crate::limits::MAX_CANVAS_PIXELS);
        assert!(number("maxLayerBundlePixels") <= crate::limits::MAX_CANVAS_PIXELS);
        assert!(number("maxAssetPixels") <= crate::limits::MAX_CANVAS_PIXELS);
        // 域内的字节预算同样不得超过工程解压总量上限。
        assert!(number("maxLayerBundleBytes") <= crate::limits::MAX_DECOMPRESSED_RESOURCE_BYTES);
        assert!(number("maxAssetBytes") <= crate::limits::MAX_DECOMPRESSED_RESOURCE_BYTES);
        // 逐层文件数不得超过工程图层上限。
        assert!(number("maxLayerBundleFiles") <= crate::limits::MAX_LAYERS as u64);
    }
}
