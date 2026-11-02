/**
 * 画布控制器的 E2E/排障观察镜像
 * （change: 2026-09-28-split-frontend-god-plugins 后续拆分；从 `interaction-controller` 抽出）。
 *
 * 只在 `target` 上挂只读/驱动钩子（选择、本地视口、聚焦编辑门禁），生产无副作用；
 * 抽出以保持在文件体积上限内。
 */
import { nodeSelectionStore } from "../../services/selection-store.js";
import type { InteractionState, Viewport } from "./interaction-core.js";
import type { ModelGestureFamily } from "./model-gesture-family.js";
import { installInputDiagnostics } from "./input-diagnostics.js";
import type { InteractionCore } from "./interaction-core.js";

export function installCanvasDiagnostics(deps: {
  core: InteractionCore;
  target: Window & typeof globalThis;
  state: InteractionState;
  activeViewport: () => Viewport;
  setSelection: (ids: string[]) => void;
  model: ModelGestureFamily;
  renderError: () => string | null;
  queryCounters: () => { queries: number; unavailableQueries: number };
}): () => void {
  const { target, state, activeViewport, setSelection, model } = deps;
  const hooks = target as unknown as Record<string, unknown>;
  // 供 E2E 驱动选中（生产无副作用）。
  hooks.__canvasSetSelection = (ids: string[]) => setSelection(ids);
  // 供 E2E 读取当前选择（诊断用；change: add-canvas-node-grouping）。
  hooks.__canvasSelection = () => ({ nodeIds: state.selected, store: nodeSelectionStore.getSnapshot().nodeIds });
  // 供 E2E 读取当前本地视口以换算世界↔屏幕坐标（生产无副作用）。
  hooks.__canvasViewport = () => activeViewport();
  hooks.__canvasRenderError = deps.renderError;
  // 供 E2E 观察聚焦编辑门禁（change: replace-model-node-focus-interactions）。
  hooks.__canvasModelFocusEdit = { editable: () => model.placementEditable(), camera: () => model.cameraSnapshot() };
  return installInputDiagnostics(deps.core, deps.renderError, deps.queryCounters);
}
