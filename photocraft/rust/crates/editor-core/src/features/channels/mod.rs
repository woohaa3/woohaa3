//! P7：通道面板与通道计算（U25/U26）
//! （change: 2026-10-22-add-photocraft-channel-workflows）。
//!
//! 本域是 Alpha/屏幕专色通道的**唯一**规范表示：内容和元数据都在上游
//! `photocraft_doc::Document::channels`，这里只做命令/参数门禁、只读快照与有界预览，
//! 不复制第二套通道模型。
//!
//! 能力按整条链路（协议、命令门、WASM、React、核验器）接通后才在这里登记；
//! 目标/显隐等查看态来自上游 `channel_view`，不进内容身份。
use super::{FeatureContribution, StagedId};

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "channels",
    capabilities: &[
        StagedId { stage: "P7", order: 38, id: "channel.panel" },
        StagedId { stage: "P7", order: 39, id: "channel.color-target" },
        StagedId { stage: "P7", order: 40, id: "channel.alpha" },
        StagedId { stage: "P7", order: 41, id: "channel.spot" },
        StagedId { stage: "P7", order: 42, id: "channel.split-merge" },
        StagedId { stage: "P7", order: 43, id: "channel.apply-image" },
        StagedId { stage: "P7", order: 44, id: "channel.calculations" },
        StagedId { stage: "P7", order: 45, id: "channel.luminosity-selection" },
    ],
    commands: &[
        StagedId { stage: "P7", order: 38, id: "channel.new" },
        StagedId { stage: "P7", order: 39, id: "channel.newSpot" },
        StagedId { stage: "P7", order: 40, id: "channel.duplicate" },
        StagedId { stage: "P7", order: 41, id: "channel.delete" },
        StagedId { stage: "P7", order: 42, id: "channel.rename" },
        StagedId { stage: "P7", order: 43, id: "channel.move" },
        StagedId { stage: "P7", order: 44, id: "channel.target" },
        StagedId { stage: "P7", order: 45, id: "channel.setVisible" },
        StagedId { stage: "P7", order: 46, id: "channel.options" },
        StagedId { stage: "P7", order: 47, id: "channel.mergeSpot" },
        StagedId { stage: "P7", order: 48, id: "channel.split" },
        StagedId { stage: "P7", order: 49, id: "channel.merge" },
        StagedId { stage: "P7", order: 50, id: "channel.list" },
        StagedId { stage: "P7", order: 51, id: "image.applyImage" },
        StagedId { stage: "P7", order: 52, id: "image.calculations" },
        StagedId { stage: "P7", order: 53, id: "select.loadLuminosity" },
    ],
};

/// 通道内容身份贡献（任务 3.2）：共享 `document_content.rs` 通过 `#[path]` 引入本模块。
pub mod content;
