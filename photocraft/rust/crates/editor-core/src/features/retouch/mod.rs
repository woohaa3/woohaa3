//! 修饰域的静态贡献（change: 2026-10-22-add-photocraft-retouch-workflows，U37/U38/U39）。
//!
//! **命令**是本域唯一可立即生效的门禁数据：它进唯一命令门
//! （[`crate::capability::command_allowed`]），未登记的命令继续被拒绝。
//!
//! **能力 id** 在 U37/U38/U39 的像素/历史/工程往返验收与共享聚合同时完成后开放：
//! [`CONTRIBUTION`] 里的 8 个 `retouch.*` 与 `tests/fixtures/contract.json` 的 `P6`、
//! `notes/feature-boundary-*.json` 逐项一致（`contract_fixture` 与 `features:check` 守住）。
//! [`PENDING_CAPABILITIES`] 保留为「与 TS 侧同序同值」的对照清单，并由
//! `pending_capability_ids_match_the_delivered_contribution` 锁定「已声明 == 已交付」，
//! 防止只加 TS 或只加 Rust 造成一侧假开放。
use super::{FeatureContribution, StagedId};

/// 本域发布的能力 id（U37/U38/U39），与 [`CONTRIBUTION`] 的 `capabilities` 同序同值。
///
/// 与 `packages/protocol/src/features/retouch/index.ts` 的
/// `PENDING_RETOUCH_CAPABILITIES` 同序同值；两边都进各自的能力聚合，握手与共享 fixture
/// 因此必须同时更新，不出现「UI 说有、链未接通」。
pub const PENDING_CAPABILITIES: &[&str] = &[
    "retouch.patch",
    "retouch.content-aware-move",
    "retouch.remove",
    "retouch.red-eye",
    "retouch.pattern-stamp",
    "retouch.history-brush",
    "retouch.tool-options",
    "retouch.clone-sources",
];

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "retouch",
    capabilities: &[
        StagedId { stage: "P6", order: 0, id: "tool.clone" },
        StagedId { stage: "P6", order: 1, id: "tool.healing" },
        StagedId { stage: "P6", order: 2, id: "tool.retouch-brush" },
        // U37：区域命令与移除。
        StagedId { stage: "P6", order: 40, id: "retouch.patch" },
        StagedId { stage: "P6", order: 41, id: "retouch.content-aware-move" },
        StagedId { stage: "P6", order: 42, id: "retouch.remove" },
        StagedId { stage: "P6", order: 43, id: "retouch.red-eye" },
        // U38：图案图章与历史画笔。
        StagedId { stage: "P6", order: 44, id: "retouch.pattern-stamp" },
        StagedId { stage: "P6", order: 45, id: "retouch.history-brush" },
        // U39：逐工具参数与多仿制源。
        StagedId { stage: "P6", order: 46, id: "retouch.tool-options" },
        StagedId { stage: "P6", order: 47, id: "retouch.clone-sources" },
    ],
    commands: &[
        StagedId { stage: "P6", order: 0, id: "paint.cloneStamp" },
        StagedId { stage: "P6", order: 1, id: "paint.healingBrush" },
        StagedId { stage: "P6", order: 2, id: "paint.spotHealing" },
        StagedId { stage: "P6", order: 3, id: "paint.blur" },
        StagedId { stage: "P6", order: 4, id: "paint.sharpen" },
        StagedId { stage: "P6", order: 5, id: "paint.smudge" },
        StagedId { stage: "P6", order: 6, id: "paint.dodge" },
        StagedId { stage: "P6", order: 7, id: "paint.burn" },
        StagedId { stage: "P6", order: 8, id: "paint.sponge" },
        // U37：区域命令与移除。
        StagedId { stage: "P6", order: 20, id: "paint.patch" },
        StagedId { stage: "P6", order: 21, id: "paint.contentAwareMove" },
        StagedId { stage: "P6", order: 22, id: "paint.remove" },
        StagedId { stage: "P6", order: 23, id: "paint.redEye" },
        // U38：图案图章与历史画笔。
        StagedId { stage: "P6", order: 24, id: "paint.patternStamp" },
        StagedId { stage: "P6", order: 25, id: "paint.historyBrush" },
        // U39：多仿制源（取样源面板的数据来源）。
        StagedId { stage: "P6", order: 26, id: "cloneSource.list" },
        StagedId { stage: "P6", order: 27, id: "cloneSource.select" },
        StagedId { stage: "P6", order: 28, id: "cloneSource.set" },
        StagedId { stage: "P6", order: 29, id: "cloneSource.resetTransform" },
        StagedId { stage: "P6", order: 30, id: "cloneSource.overlay" },
    ],
};
