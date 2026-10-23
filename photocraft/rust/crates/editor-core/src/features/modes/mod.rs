//! 图像模式与调色板域贡献（U45）。
//!
//! 本域的真实实现位于 [`mode`]（转换、报告、预览）、[`tools`]（`Editor` 入口）与 [`content`]
//! （内容身份贡献）。能力与命令已在
//! change `2026-10-22-add-photocraft-image-mode-workflows` 中发布到 P7：
//!
//! - 内容身份：`document_content::project_content` 写入 `mode` 字段，`identity::canonicalize`
//!   追加模式行（缺省 RGB/8 位不产生行，旧工程指纹不变）；
//! - 能力握手：本清单与协议 `packages/protocol/src/features/modes/index.ts`、
//!   `tests/fixtures/contract.json` 逐项一致；
//! - 命令门：六条 `image.mode.*` 通过 [`crate::capability::command_allowed`]，与上游注册表一致。
//!
//! 陷印仍需 CMYK（本次范围排除），因此没有对应能力。

use super::{FeatureContribution, StagedId};

pub mod content;
pub mod gate;
pub mod mode;

/// 本域能力 id（已在 P7 发布）。
///
/// 顺序即发布顺序；与协议域 `IMAGE_MODE_CAPABILITIES` 逐项一致，由测试锁定。
pub const CAPABILITIES: &[&str] = &[
    "image.modes",
    "image.color-table",
    "image.duotone",
];

/// 本域命令 id（模式转换与颜色表编辑的真实命令）。
///
/// 与 [`mode::MODE_COMMANDS`] 逐项一致，且必须都在上游命令注册表里（`capability` 的单测校验）。
pub const COMMANDS: &[&str] = &[
    "image.mode.rgb",
    "image.mode.grayscale",
    "image.mode.indexedColor",
    "image.mode.bitmap",
    "image.mode.duotone",
    "image.mode.colorTable",
];

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "modes",
    capabilities: &[
        StagedId { stage: "P7", order: 40, id: "image.modes" },
        StagedId { stage: "P7", order: 41, id: "image.color-table" },
        StagedId { stage: "P7", order: 42, id: "image.duotone" },
    ],
    commands: &[
        StagedId { stage: "P7", order: 40, id: "image.mode.rgb" },
        StagedId { stage: "P7", order: 41, id: "image.mode.grayscale" },
        StagedId { stage: "P7", order: 42, id: "image.mode.indexedColor" },
        StagedId { stage: "P7", order: 43, id: "image.mode.bitmap" },
        StagedId { stage: "P7", order: 44, id: "image.mode.duotone" },
        StagedId { stage: "P7", order: 45, id: "image.mode.colorTable" },
    ],
};

#[cfg(test)]
#[path = "tests_contribution.rs"]
mod tests_contribution;
