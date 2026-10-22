/**
 * Extension 公共面板投影
 * （change: 2026-10-10-extract-optional-feature-extensions，design D4）。
 *
 * `projectModelConfig` 是通用的 catalog → `ExecutionPanelModelConfig` 纯投影（多处消费：核心
 * generic 面板与 RunningHub 专用面板）。作为公共纯投影经本入口转出，使扩展复用而不复制。
 */
export {
  projectModelConfig,
  currentPanelDefaultModelKey
} from "../cordis/plugins/task-execution/generic-panel-projection.js";
