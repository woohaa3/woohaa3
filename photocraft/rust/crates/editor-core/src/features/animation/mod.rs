//! U77 时间轴、视频图层与浏览器动画交付
//! （change: 2026-10-22-add-photocraft-animation-workflows）。
//!
//! 本域只声明自己实际接通的命令；阶段聚合、全局版本、共享预算与跨语言 fixture 仍由集成负责人
//! 维护。`P7` 已交付，因此这里登记的 id 会立即进入唯一命令门
//! （[`crate::capability::command_allowed`]），未登记的条目继续被拒绝：
//!
//! - 时间轴：创建/删除/定位/步进/属性/读取。上游这些命令 `journal: false`，定位只推进修订，
//!   不产生历史步骤（design D1：播放不新增历史）。
//! - 视频图层与逐帧编辑：空白视频层、插入/复制/删除/恢复帧、显示原始帧、栅格化，以及**解释素材帧率**
//!   （`layer.videoLayers.interpretFootage` 在固定上游里只改视频层 `fps`，不读文件、不需要原生
//!   解复用，因此浏览器可用；见本文件末尾的暂缓清单）。
//!
//! 以下**不登记**，因为依赖原生进程或文件系统路径，浏览器里没有等价能力（design D2）：
//! `layer.videoLayers.newVideoLayerFromFile`、`layer.videoLayers.replaceFootage`、
//! `layer.videoLayers.reloadFrame`、`file.import.videoFramesToLayers`、`file.export.renderVideo`。
//! 帧导入走本域的字节入口，交付走本域的分步编码（[`export`]），二者都不接受路径。
//!
//! ## 能力 id（已发布）
//!
//! 本域发布四个能力：`animation.timeline`、`animation.video-layers`、`animation.frame-import`、
//! `animation.frame-delivery`（`P7`，order 11–14）。发布意味着**整条链路已接通**：命令注册表、
//! WASM 绑定、React 入口与核验器都覆盖了这四个能力所描述的行为，`capabilityHandshake` 因此
//! 会与界面契约一致地声明它们。
//!
//! 发布同时要求三处同步：本文件的 [`CONTRIBUTION`]、`tests/fixtures/contract.json` 的
//! `capabilities` 与 `packages/protocol/src/features/animation/index.ts` 的 `feature.capabilities`。
//! 任一处漏改，`contract_fixture.rs` 与 `contract-fixture.test.ts` 会立即失败——这是刻意的：
//! 能力协商漂移比缺少能力更危险（界面会渲染出运行时拒绝的入口）。
//!
//! 能力发布**不**宣称原生编解码可用：`file.export.renderVideo` 等依赖原生进程的命令仍在
//! 暂缓清单里，MP4/WebM 交付依赖宿主注入的 `AnimationCodecPort`，端口缺席时面板会明确报
//! 「当前浏览器没有 WebCodecs 视频编解码能力」而不是静默降级。
use super::{FeatureContribution, StagedId};

/// 本域发布的能力 id（与 [`CONTRIBUTION`] 的 `capabilities` 同源）。
pub const CAPABILITIES: &[&str] = &[
    "animation.timeline",
    "animation.video-layers",
    "animation.frame-import",
    "animation.frame-delivery",
];

pub const CONTRIBUTION: FeatureContribution = FeatureContribution {
    id: "animation",
    capabilities: &[
        StagedId { stage: "P7", order: 11, id: "animation.timeline" },
        StagedId { stage: "P7", order: 12, id: "animation.video-layers" },
        StagedId { stage: "P7", order: 13, id: "animation.frame-import" },
        StagedId { stage: "P7", order: 14, id: "animation.frame-delivery" },
    ],
    commands: &[
        StagedId { stage: "P7", order: 20, id: "timeline.create" },
        StagedId { stage: "P7", order: 21, id: "timeline.delete" },
        StagedId { stage: "P7", order: 22, id: "timeline.setFrame" },
        StagedId { stage: "P7", order: 23, id: "timeline.nextFrame" },
        StagedId { stage: "P7", order: 24, id: "timeline.previousFrame" },
        StagedId { stage: "P7", order: 25, id: "timeline.setProps" },
        StagedId { stage: "P7", order: 26, id: "timeline.info" },
        StagedId { stage: "P7", order: 27, id: "layer.videoLayers.newBlankVideoLayer" },
        StagedId { stage: "P7", order: 28, id: "layer.videoLayers.insertBlankFrame" },
        StagedId { stage: "P7", order: 29, id: "layer.videoLayers.duplicateFrame" },
        StagedId { stage: "P7", order: 30, id: "layer.videoLayers.deleteFrame" },
        StagedId { stage: "P7", order: 31, id: "layer.videoLayers.restoreFrame" },
        StagedId { stage: "P7", order: 32, id: "layer.videoLayers.restoreAllFrames" },
        StagedId { stage: "P7", order: 33, id: "layer.videoLayers.showAlteredVideo" },
        StagedId { stage: "P7", order: 34, id: "layer.videoLayers.rasterize" },
        StagedId { stage: "P7", order: 35, id: "layer.rasterize.video" },
        StagedId { stage: "P7", order: 38, id: "layer.videoLayers.interpretFootage" },
    ],
};

pub mod content;
pub mod export;
pub mod limits;
