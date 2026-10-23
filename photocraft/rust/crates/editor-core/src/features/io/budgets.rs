//! 本域交换预算（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
//!
//! 唯一权威是 `packages/protocol/src/features/io/interchange-budgets.json`：TypeScript 协议包直接
//! import，本模块 `include_str!` 同一份文件并解析。**不**在 Rust 侧另写一份数字，也**不**抬高
//! `rust/project-limits.json` 的工程上限 —— 这些预算只约束本域打开预检、导出参数和逐层/按名称
//! 资产包，工程候选仍须满足全局预算。
//!
//! 这些数值进入全局 limits/fixture 的登记属于集成负责人职责（见 change 的 parallel-work）。

use serde::Deserialize;
use std::sync::LazyLock;

/// 域内交换预算（字段名与 JSON 的 camelCase 一一对应）。
#[derive(Debug, Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterchangeBudgets {
    /// 导出/缩放后单边像素上限（与工程单边一致，不抬高）。
    pub max_export_dimension: u32,
    /// 导出/缩放后像素总量上限。
    pub max_export_pixels: u64,
    /// 一次逐层包最多包含的图层文件数。
    pub max_layer_bundle_files: usize,
    /// 一次逐层包所有图层像素总量上限。
    pub max_layer_bundle_pixels: u64,
    /// 一次逐层包字节上限。
    pub max_layer_bundle_bytes: usize,
    /// 一次按名称资产包最多文件数（Layer Transfer/资产语法的逐项展开）。
    pub max_asset_files: usize,
    /// 一次按名称资产包像素总量上限。
    pub max_asset_pixels: u64,
    /// 一次按名称资产包字节上限。
    pub max_asset_bytes: usize,
    /// 单个输出文件名（不含目录）的最大字符数。
    pub max_file_name_length: usize,
    /// 资产相对路径（含目录）的最大字符数。
    pub max_relative_path_length: usize,
    /// 导出预设条数上限。
    pub max_export_presets: usize,
    /// 导出预设名的最大字符数。
    pub max_preset_name_length: usize,
}

static BUDGETS: LazyLock<InterchangeBudgets> = LazyLock::new(|| {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/protocol/src/features/io/interchange-budgets.json"
    )))
    .expect("本域交换预算 JSON 无法解析")
});

/// 读取域内交换预算。
pub fn budgets() -> &'static InterchangeBudgets {
    &BUDGETS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_are_bounded_and_do_not_raise_the_project_budget() {
        let b = budgets();
        // 域预算不得高于全局工程上限（单边 8192、像素 64 Mi）。
        assert!(b.max_export_dimension <= photocraft_project_verify::MAX_CANVAS_SIDE);
        assert!(b.max_export_pixels <= photocraft_project_verify::MAX_CANVAS_PIXELS);
        assert!(b.max_layer_bundle_files > 0 && b.max_layer_bundle_files <= 1024);
        assert!(b.max_asset_files >= b.max_layer_bundle_files);
        assert!(b.max_file_name_length >= 32);
        assert!(b.max_export_presets > 0);
    }
}
