/**
 * 历史/动作/数据驱动域的能力与面板声明
 * （change: 2026-10-22-add-photocraft-history-automation-workflows，U74/U75/U76）。
 *
 * 能力 id 随已交付阶段 `P7` 发布（与 Rust `features/history/mod.rs` 的 `HISTORY_CAPABILITIES`
 * 同序同值、同 `order`）。发布前提是整条链路都接通：命令门、真实 WASM、React 入口、
 * 共享内容身份（`doc.variables` 已进入 `image-project-content.ts` / `identity.rs` /
 * `document_content.rs`）与工程核验器（文档级钩子拦住变量绑定错误）。
 */

/** 本域在 `P7` 发布的能力 id（顺序即发布顺序）。 */
export const HISTORY_CAPABILITIES = [
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
  "automation.scripts"
] as const;

export type HistoryCapability = (typeof HISTORY_CAPABILITIES)[number];

export const feature = {
  id: "history",
  capabilities: [
    { stage: "P7", order: 73, id: "history.snapshots" },
    { stage: "P7", order: 74, id: "history.new-from-state" },
    { stage: "P7", order: 75, id: "history.purge" },
    { stage: "P7", order: 76, id: "actions.recording" },
    { stage: "P7", order: 77, id: "actions.atn" },
    { stage: "P7", order: 78, id: "actions.shortcuts" },
    { stage: "P7", order: 79, id: "data.variables" },
    { stage: "P7", order: 80, id: "data.data-sets" },
    { stage: "P7", order: 81, id: "automation.batch" },
    { stage: "P7", order: 82, id: "automation.contact-sheet" },
    { stage: "P7", order: 83, id: "automation.load-stack" },
    { stage: "P7", order: 84, id: "automation.scripts" }
  ]
} as const;
