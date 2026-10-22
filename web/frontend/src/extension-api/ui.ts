/**
 * Extension 前端公共 UI 能力
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.2 / design D2/D6；
 *  change: 2026-10-10-extract-optional-feature-extensions，任务 1.2：补齐可选扩展所需的公共 UI
 *  与 Dialog primitives）。
 *
 * 转出已确定为公共能力的生产 UI：`shared/ui`（Button/IconButton/Tooltip/Menu/Popover/
 * SegmentedControl/Collapsible/ScrollArea/icon facade 等）、Dialog primitives（`Dialog`/
 * `AlertDialog`）与 `ExecutionPanel` 及其 props。extension 作者从本入口消费，不直接 import
 * Radix/Lucide，也不复制面板实现。运行时依赖闭包限定在 `shared/ui`、Dialog primitives 与
 * `task-execution/execution-panel`，不含扫描器、装配根或业务插件。
 */
export * from "../shared/ui/index.js";

export { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../cordis/services/dialogs/Dialog.js";
export { AlertDialog } from "../cordis/services/dialogs/AlertDialog.js";
export { objectPayload } from "../cordis/services/dialogs/registry.js";
export type { DialogDefinition, DialogInstance, DialogVariant, DialogSize } from "../cordis/services/dialogs/types.js";
export type { DialogRenderer, DialogRendererProps } from "../cordis/services/dialogs/renderer-registry.js";

export { ExecutionPanel, ExecutionPanelShell } from "../cordis/plugins/task-execution/execution-panel/ExecutionPanel.js";
export type {
  ExecutionPanelData,
  ExecutionPanelModelConfig,
  ExecutionPanelParameterField,
  ExecutionPanelProps,
  ExecutionPanelRunSnapshot,
  ExecutionPanelStatus,
  ExecutionPanelSurface,
  ExecutionPanelTaskKind
} from "../cordis/plugins/task-execution/execution-panel/types.js";
export {
  resolveAgentDetailAction,
  type AgentDetailAction,
  type AgentDetailActionEmphasis,
  type AgentDetailStatus
} from "../cordis/plugins/task-execution/execution-panel/agent-detail-action.js";
