//! 历史快照、动作与数据驱动编辑的域贡献
//! （change: 2026-10-22-add-photocraft-history-automation-workflows，U74/U75/U76）。
//!
//! 本域只声明自己**实际接通**的命令；阶段聚合、全局版本、共享预算与跨语言 fixture 仍由集成
//! 负责人维护。`P7` 已交付，因此这里登记的 id 会立即进入唯一命令门
//! （[`crate::capability::command_allowed`]），未登记的条目继续被拒绝。
//!
//! 登记原则（design D2/D3）：**只登记不依赖本机路径/进程的上游命令**。
//!
//! - U74：`history.*` 快照/删除状态/自历史新建，以及 `edit.purge.*` 的按范围清理。清理入口在
//!   [`tools::Editor::history_purge`] 里另有一道显式确认门。
//! - U75：`actions.*` 录制/停止/播放/步骤与条件编辑、动作集与快捷键、ATN 导入导出。ATN 的路径
//!   读写在这里关闭，字节入口见 [`tools::Editor::actions_load`] / [`tools::Editor::actions_save`]。
//! - U76：变量定义与数据集（`image.variables.*`、`variables.list`）走内容命令；批处理、Image
//!   Processor、Contact Sheet、Load Stack、受限脚本与 CSV 数据集导入导出全部走本域**字节入口**，
//!   因此 `file.automate.batch`、`file.scripts.imageProcessor`、`file.scripts.loadFilesIntoStack`、
//!   `file.automate.contactSheetII`、`file.import.variableDataSets`、`file.export.dataSetsAsFiles`
//!   这些要求文件夹/路径的上游命令**不登记**：浏览器里它们必然失败，登记只会造出假入口。
//!
//! 明确暂缓（proposal「Dependencies and Non-goals」）：原生 Droplet（`file.automate.createDroplet`
//! / `runDroplet`）、任意脚本事件（`file.scripts.scriptEventsManager`）、后台批处理
//! （`batch.background`）与 MCP（`automation.mcp`）保持关闭。
//!
//! ## 能力 id 随 `P7` 发布
//!
//! [`HISTORY_CAPABILITIES`] 是本域实际交付的能力，登记进既有的已交付阶段 `P7`（`order`
//! 接在该阶段其它域之后，保证「声明顺序 = 发布顺序」稳定）。发布前必须同时具备：
//!
//! - 命令进唯一命令门（下方 `commands`）；
//! - 面板/手势入口与真实 WASM 主线（本域已完成，见 `tests/features/history/`）；
//! - 持久内容进入共享内容身份 —— `doc.variables` 由
//!   [`crate::document_content::project_content`] 与 [`crate::identity::canonicalize`]
//!   覆盖，协议侧 `image-project-content.ts` 用同一段文本；
//! - 工程核验器能拦住绑定错误的数据驱动内容（`project-verify` 的文档级钩子）。
//!
//! 能力 id 是**跨语言聚合数据**：`tests/fixtures/contract.json` 的 `capabilities` 与
//! `notes/feature-boundary-baseline.json` 的 `stages` 必须同序同值，否则两侧 fixture 测试
//! 会立即失败，能力协商也会与界面契约漂移。

use super::{FeatureContribution, StagedId};

/// 域内命令错误：与共享 `editor::tools::command_error` 形状一致，但域文件不能引用那个
/// 私有父模块（`features::history` 不是 `editor::tools` 的子模块）。
pub(crate) fn command_error(
    id: impl std::fmt::Display,
    message: impl std::fmt::Display,
) -> crate::error::EditorError {
    crate::error::EditorError::CommandFailed { id: id.to_string(), message: message.to_string() }
}

/// 本域自定义的 CSV 编解码（字节/文本输入，浏览器可用）。
pub mod csv;

/// U76 前台自动化：批处理队列、受限脚本、Contact Sheet 与 Load Stack。
pub mod automation;

/// U76 变量与数据集（含数据集导出为字节）。
pub mod data;

/// 逐步骤能力预检与前台队列的进程内存储。
pub mod preflight;

/// 本域在 `P7` 发布的能力 id（顺序即发布顺序；与协议 `HISTORY_CAPABILITIES` 同序同值）。
///
/// 只列**已接通整条链路**的项：命令门、真实 WASM、React 入口、内容身份与核验器。
pub const HISTORY_CAPABILITIES: &[&str] = &[
    "history.snapshots",
    "history.new-from-state",
    "history.purge",
    "actions.recording",
    "actions.atn",
    "actions.shortcuts",
    "data.variables",
    "data.data-sets",
    "automation.batch",
    "automation.contact-sheet",
    "automation.load-stack",
    "automation.scripts",
];

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "history",
    capabilities: &[
        // P7：历史快照 / 自历史新建 / 清理。
        StagedId { stage: "P7", order: 73, id: "history.snapshots" },
        StagedId { stage: "P7", order: 74, id: "history.new-from-state" },
        StagedId { stage: "P7", order: 75, id: "history.purge" },
        // P7：动作录制 / ATN / 快捷键。
        StagedId { stage: "P7", order: 76, id: "actions.recording" },
        StagedId { stage: "P7", order: 77, id: "actions.atn" },
        StagedId { stage: "P7", order: 78, id: "actions.shortcuts" },
        // P7：变量与数据集。
        StagedId { stage: "P7", order: 79, id: "data.variables" },
        StagedId { stage: "P7", order: 80, id: "data.data-sets" },
        // P7：前台自动化。
        StagedId { stage: "P7", order: 81, id: "automation.batch" },
        StagedId { stage: "P7", order: 82, id: "automation.contact-sheet" },
        StagedId { stage: "P7", order: 83, id: "automation.load-stack" },
        StagedId { stage: "P7", order: 84, id: "automation.scripts" },
    ],
    commands: &[
        // P0：撤销/重做（原有贡献，位置不变）。
        StagedId { stage: "P0", order: 0, id: "edit.undo" },
        StagedId { stage: "P0", order: 1, id: "edit.redo" },
        // U74：历史快照、自历史新建与删除状态。
        StagedId { stage: "P7", order: 40, id: "history.newSnapshot" },
        StagedId { stage: "P7", order: 41, id: "history.selectSnapshot" },
        StagedId { stage: "P7", order: 42, id: "history.renameSnapshot" },
        StagedId { stage: "P7", order: 43, id: "history.deleteSnapshot" },
        StagedId { stage: "P7", order: 44, id: "history.deleteState" },
        StagedId { stage: "P7", order: 45, id: "history.newDocument" },
        // U74：按范围清理（确认门在本域入口）。
        StagedId { stage: "P7", order: 46, id: "edit.purge.undo" },
        StagedId { stage: "P7", order: 47, id: "edit.purge.clipboard" },
        StagedId { stage: "P7", order: 48, id: "edit.purge.histories" },
        StagedId { stage: "P7", order: 49, id: "edit.purge.videoCache" },
        StagedId { stage: "P7", order: 50, id: "edit.purge.all" },
        // U75：动作录制、播放与编辑。
        StagedId { stage: "P7", order: 51, id: "actions.list" },
        StagedId { stage: "P7", order: 52, id: "actions.get" },
        StagedId { stage: "P7", order: 53, id: "actions.record" },
        StagedId { stage: "P7", order: 54, id: "actions.stop" },
        StagedId { stage: "P7", order: 55, id: "actions.play" },
        StagedId { stage: "P7", order: 56, id: "actions.delete" },
        StagedId { stage: "P7", order: 57, id: "actions.move" },
        StagedId { stage: "P7", order: 58, id: "actions.rename" },
        StagedId { stage: "P7", order: 59, id: "actions.toggle" },
        StagedId { stage: "P7", order: 60, id: "actions.dialog" },
        StagedId { stage: "P7", order: 61, id: "actions.setColor" },
        StagedId { stage: "P7", order: 62, id: "actions.insert" },
        StagedId { stage: "P7", order: 63, id: "actions.conditional" },
        StagedId { stage: "P7", order: 64, id: "actions.assignSet" },
        StagedId { stage: "P7", order: 65, id: "actions.load" },
        StagedId { stage: "P7", order: 66, id: "actions.save" },
        StagedId { stage: "P7", order: 67, id: "actions.stopMessage" },
        StagedId { stage: "P7", order: 68, id: "actions.photoshopStep" },
        // U76：变量与数据集（内容命令）。
        StagedId { stage: "P7", order: 69, id: "variables.list" },
        StagedId { stage: "P7", order: 70, id: "image.variables.define" },
        StagedId { stage: "P7", order: 71, id: "image.variables.dataSets" },
        // 应用数据集由本域字节入口实现（像素变量交字节，不走磁盘路径），因此只登记 id 供
        // 命令门与其它内容命令一致地判定，实际执行不经上游 `dispatch`。
        StagedId { stage: "P7", order: 72, id: "image.applyDataSet" },
    ],
};
