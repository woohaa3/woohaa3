//! 栅格格式与导出交付域
//! （change: 2026-10-22-add-photocraft-raster-interchange，U05/U06/U07）。
//!
//! 本域只持有**格式矩阵、编码候选与交付批次**：文件文档注册、来源/保存基线与关闭结算都不在
//! 这里，导出与逐层/资产打包只产生字节与报告，不改文档、不产生历史、不推进保存基线。
//!
//! 模块分工：
//! - [`formats`]：U05 逐格式矩阵、打开准入与真实解码预检；
//! - [`export`]：U06 通用导出 / Save for Web 的设置归一化与唯一编码入口（预览与交付同源）；
//! - [`layers`]、[`assets`]：U07 逐层交付与按图层名称生成的资产包；
//! - [`naming`]、[`budgets`]：有界命名与本域预算（预算唯一权威在协议包 JSON）。
//!
//! 能力清单保持**域内声明**（[`interchange_capabilities`]）；把它注册进共享阶段清单与
//! fixture 属于集成负责人职责，本域不并改共享文件。
use super::{FeatureContribution, StagedId};

pub mod assets;
pub mod budgets;
pub mod export;
pub mod formats;
pub mod layers;
mod editor_interchange;
pub mod naming;

#[cfg(test)]
pub(crate) mod tests_support;

#[cfg(test)]
#[path = "tests_editor.rs"]
mod tests_editor;

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "io",
    capabilities: &[
        StagedId { stage: "P2", order: 3, id: "file.place-image" },
        StagedId { stage: "P3", order: 0, id: "format.psd-import" },
        StagedId { stage: "P3", order: 1, id: "format.psd-export" },
        StagedId { stage: "P3", order: 2, id: "format.psd-loss-report" },
    ],
    commands: &[
    ],
};

/// 本 change 新增的交换能力 id（**域内声明**，尚未登记进共享阶段清单）。
///
/// 登记需要同时改集成方拥有的 `tests/fixtures/contract.json`、
/// `notes/feature-boundary-wasm-baseline.json` 与阶段清单，因此本域只声明、由集成负责人
/// 顺序合入；在此之前这些入口仍由本域自己的按钮/面板调用（不经共享能力门）。
pub const INTERCHANGE_CAPABILITIES: &[&str] = &[
    "format.raster-matrix",
    "format.open-raster",
    "format.export",
    "format.export.save-for-web",
    "format.export.preview",
    "format.export.presets",
    "format.layers.export",
    "format.layers.files",
    "format.image-assets",
];

/// 域内逐层/资产交付的默认扩展名。
pub const DEFAULT_LAYER_EXTENSION: &str = "png";

/// 解析逐层/资产请求的 `format`（缺省 PNG），只接受本构建可写且非暂缓的格式。
pub(crate) fn layers_extension(params: &serde_json::Value) -> crate::error::Result<&'static str> {
    let requested = match params.get("format") {
        None | Some(serde_json::Value::Null) => DEFAULT_LAYER_EXTENSION,
        Some(value) => value
            .as_str()
            .ok_or_else(|| crate::error::EditorError::CommandFailed {
                id: "format.layers".into(),
                message: "`format` 必须是扩展名字符串".into(),
            })?,
    };
    let format = formats::format_for_extension(requested).ok_or_else(|| crate::error::EditorError::CommandFailed {
        id: "format.layers".into(),
        message: format!("未知导出格式 `{requested}`"),
    })?;
    let (status, reason) = formats::open_status(format);
    if status == formats::OpenStatus::Deferred {
        return Err(crate::error::EditorError::CommandFailed {
            id: "format.layers".into(),
            message: format!("{} 暂不支持导出：{}", format.name(), reason.unwrap_or("缺少编码路径")),
        });
    }
    if !format.caps().write || !formats::exportable_formats().contains(&format) {
        return Err(crate::error::EditorError::CommandFailed {
            id: "format.layers".into(),
            message: format!("{} 在本构建中不可写", format.name()),
        });
    }
    Ok(format.extensions()[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn layer_extension_defaults_to_png_and_rejects_read_only_targets() {
        assert_eq!(layers_extension(&json!({})).unwrap(), "png");
        assert_eq!(layers_extension(&json!({"format": ".JPEG"})).unwrap(), "jpg");
        // 只读交换格式不能当交付格式。
        assert!(layers_extension(&json!({"format": "pcx"})).is_err());
        assert!(layers_extension(&json!({"format": "exr"})).is_err());
        assert!(layers_extension(&json!({"format": "not-a-format"})).is_err());
        assert!(layers_extension(&json!({"format": 3})).is_err());
    }

    #[test]
    fn interchange_capabilities_are_domain_local_and_do_not_touch_the_stage_manifest() {
        // 共享阶段清单（`FEATURES`）里不能出现本 change 的能力，否则就是并改集成方 fixture。
        let staged: Vec<&str> = crate::features::FEATURES
            .iter()
            .flat_map(|feature| feature.capabilities.iter())
            .map(|entry| entry.id)
            .collect();
        for id in INTERCHANGE_CAPABILITIES {
            assert!(!staged.contains(id), "{id} 不应出现在共享阶段清单");
        }
        assert!(INTERCHANGE_CAPABILITIES.contains(&"format.export"));
    }
}
