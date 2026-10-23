import { sections } from "./sections.js";
import { ActionsPanel, AutomationPanel, DataSetsPanel, HistoryPanel } from "./panels.js";

/**
 * 历史/动作/数据驱动域（U74/U75/U76）
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 本域不新增画布工具：历史、动作、数据集和前台自动化都是面板工作流，不参与笔刷/指针仲裁。
 * 面板经 `FEATURE_PANELS` 暴露，同时由自己的 section 渲染；两处共用同一组件与同一域会话
 * （`controller.features.history`），不复制历史或命令表。
 */
export const feature = {
  id: "history",
  tools: [],
  sections,
  panels: { HistoryPanel, ActionsPanel, DataSetsPanel, AutomationPanel }
} as const;

export { HistoryPanel, ActionsPanel, DataSetsPanel, AutomationPanel } from "./panels.js";
export { toBase64, fromBase64, fileStem } from "./bytes.js";
export {
  decodeActionsState,
  decodeBatchProgress,
  decodeCsvImport,
  decodeExportedFiles,
  decodeHistorySample,
  decodeHistorySourceCheck,
  decodeHistoryState,
  decodePurgePlan,
  decodeQueueId,
  decodeScriptReport,
  decodeShortcuts,
  decodeUnsupported,
  decodeVariablesState,
  type ActionsStateView,
  type BatchProgressView,
  type ExportedFile,
  type HistorySampleView,
  type HistorySourceCheckView,
  type HistoryStateView,
  type PurgePlanView,
  type ScriptReportView,
  type UnsupportedStep,
  type VariablesStateView
} from "./model.js";
