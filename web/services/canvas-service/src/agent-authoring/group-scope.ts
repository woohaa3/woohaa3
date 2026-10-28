import { AsyncLocalStorage } from "node:async_hooks";
import { projectCanvasGroup, type CanvasGroupScope, type ServerCanvas } from "@woohaa3/contracts";

export type TrustedCanvasGroupScope = CanvasGroupScope & { owner: string; valid: () => boolean; authorize?: (permission: "read" | "write") => Promise<boolean>; ownsRun?: (nodeId: string, runId: string) => boolean; onAction?: (action: import("@woohaa3/contracts").CanvasGroupAction) => void };
const active = new AsyncLocalStorage<TrustedCanvasGroupScope>();
const epochs = new Map<string, number>();
type EpochStore = { read(canvasId: string, rootGroupId: string): number; advance(canvasId: string, rootGroupId: string): number };
let epochStore: EpochStore | undefined;
/** Host-owned durable ledger. Grants themselves remain process-local and never survive restart. */
export function bindCanvasGroupEpochStore(store: EpochStore): () => void { epochStore = store; return () => { if (epochStore === store) epochStore = undefined; }; }
const key = (canvasId: string, rootGroupId: string) => JSON.stringify([canvasId, rootGroupId]);
export const canvasGroupEpoch = (canvasId: string, rootGroupId: string) => Math.max(epochs.get(key(canvasId, rootGroupId)) ?? 0, epochStore?.read(canvasId, rootGroupId) ?? 0);
export function invalidateRemovedCanvasGroups(before: ServerCanvas, after: ServerCanvas): void {
  for (const n of before.document.nodes) if (n.type === "group" && !after.document.nodes.some(next => next.id === n.id && next.type === "group")) {
    const next = canvasGroupEpoch(before.id, n.id) + 1;
    epochs.set(key(before.id, n.id), next);
    // The in-memory fence takes effect even if the separate application ledger is
    // temporarily unavailable. A restart destroys every bearer grant regardless.
    try { epochStore?.advance(before.id, n.id); } catch { /* rechecked against root existence on recovery */ }
  }
}
export const currentCanvasGroupScope = () => active.getStore();
export function withCanvasGroupScope<T>(scope: TrustedCanvasGroupScope, run: () => T): T { return active.run(scope, run); }
/**
 * Projected group reads deliberately hide the root's parent so the group looks like a
 * top-level canvas. The planner then emits a root `node.update` with `parentId: null`;
 * applying that to a nested group would detach it from its manager. Preserve the root's
 * existing parent (omit the field) and let the existing group validator decide whether
 * any other root structure changed.
 */
export function normalizeGroupScopeCommands<T extends import("@woohaa3/contracts").CanvasCommand>(commands: readonly T[], rootGroupId: string): T[] {
  return commands.map(command => {
    if (command.type !== "node.update" || command.nodeId !== rootGroupId || command.parentId === undefined) return command;
    const { parentId: _parentId, ...rest } = command;
    return rest as T;
  });
}

export function scopedCanvas(canvas: ServerCanvas): ServerCanvas {
  const scope = active.getStore();
  if (!scope) return canvas;
  if (!scope.valid() || canvas.id !== scope.canvasId) throw new Error("group-scope-revoked");
  return projectCanvasGroup(canvas, scope.rootGroupId);
}
