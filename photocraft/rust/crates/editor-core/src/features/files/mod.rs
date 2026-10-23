//! 文档创建、来源与关闭结算（change: 2026-10-22-add-photocraft-file-workflows）。
//!
//! 本域拥有 U01–U04 的内核侧入口：新建空白文档、从图片字节建立文档、整份复制为工程字节、
//! 新建预设/最近设置、有界 File Info 与从工作区保存基线恢复。文档槽位、标签注册、批量关闭
//! 的串行结算仍归共享工作区与宿主适配（`document-workspace.ts` / `integrations/woohaa`），
//! 本域只提供它们所需的**语义原子操作**，不复制第二份文档状态。
//!
//! 命令白名单只追加本域真正接通的 id：新建预设/最近设置、File Info。
//!
//! `file.closeAll` / `file.closeOthers` **不是**内核命令：上游只有单文档 `file.close`，
//! 批量关闭的语义是「工作区逐文档串行结算」，由宿主（`integrations/woohaa` 的
//! `closeAllDocuments` / `closeOtherDocuments`）用本域 `close-plan` 的纯规则执行。
//! 因此它们不进入这里的白名单，也不该被当成内核能力渲染。
//! `file.revert` 仍需要原生保存路径，宿主未提供，保持关闭。
use super::{FeatureContribution, StagedId};

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "files",
    capabilities: &[
    ],
    commands: &[
        // P0：原有多文档注册入口（宿主按文档槽位调用，本域不放宽语义）。
        StagedId { stage: "P0", order: 12, id: "file.new" },
        StagedId { stage: "P0", order: 13, id: "file.close" },
        // U04：新建预设、最近设置与 File Info（本 change 新接通）。
        StagedId { stage: "P7", order: 40, id: "document.presets.list" },
        StagedId { stage: "P7", order: 41, id: "document.presets.save" },
        StagedId { stage: "P7", order: 42, id: "document.presets.delete" },
        StagedId { stage: "P7", order: 43, id: "document.recent.list" },
        StagedId { stage: "P7", order: 44, id: "document.recent.add" },
        StagedId { stage: "P7", order: 45, id: "file.fileInfo" },
    ],
};

#[cfg(test)]
#[path = "../../../../../../tests/features/files/domain.rs"]
mod domain_tests;
