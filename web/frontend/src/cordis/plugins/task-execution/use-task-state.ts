/**
 * 任务宿主与规范 store / 选中状态之间的 React 绑定（change: add-image-text-node-execution；
 * change: adopt-frontend-cordis-plugin-runtime 改用注入的 Task Catalog Service）。
 *
 * 用 `useSyncExternalStore` 而不是 `useState`：规范状态的生命周期长于任何组件，
 * 页面刷新后要从 IndexedDB 恢复，因此 store 是唯一来源，组件只是订阅者。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { woohaa3CanvasStore, type Woohaa3CanvasStoreState } from "../../services/canvas-state/index.js";
import { useOptionalService } from "../../react.js";
import { type RunStateService } from "../service-keys.js";
import { nodeDraftStore, type NodeExecutionDraft } from "./drafts.js";
import type { CatalogState, TaskCatalogService } from "../../contracts.js";

export function useCanvasStoreState(): Woohaa3CanvasStoreState {
  return useSyncExternalStore(woohaa3CanvasStore.subscribe, woohaa3CanvasStore.getState);
}

/**
 * 统一生成运行状态：该节点是否有任何非终态操作（busy 门禁）
 * （change: 2026-10-12-unify-generation-history-strip，design D2）。
 *
 * canonical `nodeData.taskStatus` 仍是权威；本 hook 作为「提交即出现」的补充来源，覆盖本地
 * 拒绝尚未回流与本地操作（截图/导出）场景。服务缺失时回退 false（不阻断核心）。
 */
export function useRunStateBusy(canvasId: string, nodeId: string): boolean {
  const service = useOptionalService("runState") as RunStateService | undefined;
  const subscribe = useCallback(
    (listener: () => void) => service?.subscribe(listener) ?? (() => undefined),
    [service]
  );
  const getSnapshot = useCallback(
    () => (service ? service.isBusy(canvasId, nodeId) : false),
    [service, canvasId, nodeId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 节点当前是否处于「媒体准备中」。
 *
 * 复用统一 run-state 读模型里的 `mediaState`（由 task.activity 的 materializing 结果投影），
 * 不新增第二份任务状态；服务缺失时返回 false。
 */
export function useNodeMediaPreparing(canvasId: string, nodeId: string): boolean {
  const service = useOptionalService("runState") as RunStateService | undefined;
  const subscribe = useCallback(
    (listener: () => void) => service?.subscribe(listener) ?? (() => undefined),
    [service]
  );
  const getSnapshot = useCallback(
    () => service?.getNodeSummary(canvasId, nodeId)?.active?.mediaState === "materializing",
    [service, canvasId, nodeId]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 某个 `{ nodeId, modelKey }` 的未提交草稿；返回引用稳定。 */
export function useNodeDraft(
  nodeId: string | null,
  modelKey?: string
): NodeExecutionDraft | undefined {
  const getSnapshot = useCallback(() => nodeDraftStore.get(nodeId, modelKey), [nodeId, modelKey]);
  return useSyncExternalStore(nodeDraftStore.subscribe, getSnapshot);
}

/**
 * 目录状态（来自注入的 Task Catalog Service）。
 *
 * 目录在运行期是静态的，只拉一次；Service 拥有缓存与 dispose 语义，组件不再维护模块级
 * Promise。
 */
export function useTaskCatalog(service: TaskCatalogService): { state: CatalogState; reload: () => void } {
  const state = useSyncExternalStore(service.subscribe, service.getState, service.getState);
  useEffect(() => {
    void service.load();
  }, [service]);
  const reload = useCallback(() => {
    void service.load(true);
  }, [service]);
  return { state, reload };
}
