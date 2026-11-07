/**
 * 画布会话的页面级 E2E 钩子（从 `canvas-session.ts` 原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`canvas-session.ts` 曾越过 800 物理行上限，而这两个钩子
 * 与真正的会话时序逻辑无关 —— 它们只往 `globalThis` 上挂调试入口。分开之后读会话
 * 逻辑不必先翻过一整套 E2E 表面。
 *
 * 生产环境同样会执行（钩子本身无副作用，只是挂几个函数）；是否使用由 E2E 决定。
 */
import type { CanvasCommand } from "@woohaa3/contracts";
import type { CanvasSession, CanvasSessionStatus } from "../contracts.js";
import { woohaa3CanvasStore, type CanvasEditService } from "./canvas-state/index.js";

let testSeq = 0;

/**
 * 页面级调试/test 钩子：把会话命令出口挂到 `window.__canvasSubmitCommands`，供 E2E 直接
 * 提交语义命令（等价于交互控制器完成一次手势）。生产无副作用。
 */
export function installCanvasSessionTestHooks(session: CanvasSession): void {
  const target = globalThis as unknown as {
    __canvasSubmitCommands?: (commands: CanvasCommand[], commandId?: string) => { ok: boolean; reason?: string };
    __canvasIsWritable?: () => boolean;
  };
  target.__canvasSubmitCommands = (commands, commandId) => {
    const id = commandId ?? `e2e-${Date.now().toString(36)}-${testSeq++}`;
    const result = session.submitCommands(commands, id);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  };
  target.__canvasIsWritable = () => session.isWritable();
  // E2E 观察同步状态（含断线只读相位）。
  const mirror = (status: CanvasSessionStatus) => {
    (globalThis as unknown as { __canvasSessionStatus?: unknown }).__canvasSessionStatus = status;
  };
  mirror(session.getStatus());
  session.subscribe(mirror);
  // 供 E2E 断言 working projection 与 canonical 的分离（生产无副作用）。
  (globalThis as unknown as { __canvasStoreState?: unknown }).__canvasStoreState = () =>
    woohaa3CanvasStore.getState();
}

/**
 * 页面级调试/test 钩子：暴露编辑历史（撤销/重做、记录、冲突跳过）供 E2E 驱动
 * （change: 2026-10-09-improve-canvas-workflow，任务 7.1）。生产无副作用。
 */
export function installCanvasEditTestHooks(edit: CanvasEditService): void {
  const target = globalThis as unknown as {
    __canvasEdit?: {
      record: (commands: readonly CanvasCommand[], label: string) => Promise<{ ok: boolean; reason?: string }>;
      recordParameter: (input: { nodeId: string; modelKey: string; before: Record<string, unknown>; after: Record<string, unknown>; label: string }) => void;
      undo: () => Promise<{ ok: boolean; reason?: string }>;
      redo: () => Promise<{ ok: boolean; reason?: string }>;
      snapshot: () => unknown;
      skipConflict: (entryId: string) => boolean;
    };
  };
  target.__canvasEdit = {
    async record(commands, label) {
      const result = await edit.record(commands, label);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    recordParameter(input) {
      edit.recordParameter({
        label: input.label,
        nodeId: input.nodeId,
        modelKey: input.modelKey,
        before: input.before,
        after: input.after,
        apply: () => undefined
      });
    },
    undo: () => edit.undo(),
    redo: () => edit.redo(),
    snapshot: () => {
      const snapshot = edit.getSnapshot();
      return {
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
        size: snapshot.size,
        pending: snapshot.pending,
        undoLabel: snapshot.undoLabel,
        redoLabel: snapshot.redoLabel,
        lastAction: snapshot.lastAction
      };
    },
    skipConflict: (entryId) => edit.skipConflict(entryId)
  };
}
