//! 智能对象域：转换、共享/独立复制、子文档会话、源替换与导出、转回图层。
//!
//! 子模块直接放在本域目录内，由本文件登记，避免修改 crate 根的共享装配。
pub(crate) mod smart_source_io;
pub(crate) mod unpack;

use super::{FeatureContribution, StagedId};

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "smart",
    capabilities: &[
        StagedId { stage: "P4", order: 0, id: "layer.smart-object" },
        StagedId { stage: "P4", order: 1, id: "layer.smart-object.child-document" },
        StagedId { stage: "P4", order: 2, id: "layer.smart-object.replace" },
        StagedId { stage: "P4", order: 3, id: "layer.smart-object.copy-independent" },
    ],
    commands: &[
    ],
};
