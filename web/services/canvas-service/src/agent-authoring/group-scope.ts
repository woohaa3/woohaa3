/**
 * 2D 组创作作用域（group scope）的宿主运行时。
 *
 * 旧的普通组版本随 `f510576d` 删除；这里重建同一套语义，但成员来自
 * `nodeData.workflowGroup2d.memberNodeIds`（见 `@woohaa3/contracts` 的 `group-authoring-scope`），
 * 而不是 `parentId` 树：
 *
 * - 作用域只存在于宿主进程内的 `AsyncLocalStorage`，从不来自模型参数；
 * - `scopedCanvas` 把任意读取投影成“只有根组与成员”的画布；
 * - 命令提交与脚本校验在作用域内走 `validateCanvasGroupChange`，保证组外零影响；
 * - 每次提交前复核授权令牌与 `scopeEpoch`，过期即拒绝，不靠调用方自觉。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { projectCanvasGroup, type CanvasGroupScope, type ServerCanvas } from "@woohaa3/contracts";

export type TrustedCanvasGroupScope = CanvasGroupScope & {
  owner: string;
  /** 授权令牌仍有效且作用域未被作废。 */
  valid: () => boolean;
  authorize?: (permission: "read" | "write") => Promise<boolean>;
  /** 本轮只能停止自己启动的运行。 */
  ownsRun?: (nodeId: string, runId: string) => boolean;
  onAction?: (action: { canvasId: string; nodeId?: string; commandId?: string; revision?: number; runId?: string; jobId?: string }) => void;
};

const active = new AsyncLocalStorage<TrustedCanvasGroupScope>();
const epochs = new Map<string, number>();
type EpochStore = { read(canvasId: string, groupNodeId: string): number; advance(canvasId: string, groupNodeId: string): number };
let epochStore: EpochStore | undefined;

/** 宿主持久化的代次账本（可选）；grant 本身仍是进程内事实，重启后一律失效。 */
export function bindCanvasGroupEpochStore(store: EpochStore): () => void {
  epochStore = store;
  return () => {
    if (epochStore === store) epochStore = undefined;
  };
}

const key = (canvasId: string, groupNodeId: string) => JSON.stringify([canvasId, groupNodeId]);

export const canvasGroupEpoch = (canvasId: string, groupNodeId: string): number =>
  Math.max(epochs.get(key(canvasId, groupNodeId)) ?? 0, epochStore?.read(canvasId, groupNodeId) ?? 0);

/** 组被删除时作废仍在途的授权：内存围栏立即生效，账本写入失败也不阻塞。 */
export function invalidateRemovedCanvasGroups(before: ServerCanvas, after: ServerCanvas): void {
  for (const node of before.document.nodes) {
    if (node.type !== "workflow-group-2d") continue;
    if (after.document.nodes.some((next) => next.id === node.id && next.type === "workflow-group-2d")) continue;
    epochs.set(key(before.id, node.id), canvasGroupEpoch(before.id, node.id) + 1);
    try {
      epochStore?.advance(before.id, node.id);
    } catch {
      /* 内存围栏足够让本轮失效；重启后 grant 不复存在。 */
    }
  }
}

export const currentCanvasGroupScope = (): TrustedCanvasGroupScope | undefined => active.getStore();

export function withCanvasGroupScope<T>(scope: TrustedCanvasGroupScope, run: () => T): T {
  return active.run(scope, run);
}

/** 组作用域内的只读投影；作用域失效直接抛错，绝不退化成整张画布。 */
export function scopedCanvas(canvas: ServerCanvas): ServerCanvas {
  const scope = active.getStore();
  if (!scope) return canvas;
  if (!scope.valid() || canvas.id !== scope.canvasId) throw new Error("group-scope-revoked");
  return projectCanvasGroup(canvas, scope.rootGroupId);
}
