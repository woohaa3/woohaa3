// @vitest-environment jsdom
/**
 * 节点合并插件装配与确认流程
 * （change: 2026-10-27-merge-same-type-node-history，任务 2.3 / 2.4）。
 *
 * 用最小 ctx 假实现驱动：高亮随 preview/画布/viewport 刷新；释放只打开共享 AlertDialog，
 * 确认才调用 `canvasRemote.mergeNodeHistory`；取消不发请求；失败保留弹窗并显示稳定原因；
 * 重复确认共用一个在途请求。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { nodeMerge, type NodeMergeDrag } from "../../services/node-merge/index.js";
import { nodeMergeExtension, NODE_MERGE_ACTION_PREFIX, nodeMergeFailureText } from "./plugin.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

type AlertAction = () => Promise<{ ok: true } | { ok: false; error: string }>;

function dialogsHarness() {
  const actions = new Map<string, AlertAction>();
  const opened = new Map<string, { dialogId: string; payload: Record<string, unknown> }>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  let sequence = 0;
  return {
    actions,
    opened,
    registerAlertAction(key: string, action: AlertAction) {
      actions.set(key, action);
      return () => {
        if (actions.get(key) === action) actions.delete(key);
      };
    },
    open(request: { dialogId: string; payload: unknown }) {
      const instanceId = `dlg-${++sequence}`;
      opened.set(instanceId, { dialogId: request.dialogId, payload: request.payload as Record<string, unknown> });
      notify();
      return { ok: true as const, instance: { instanceId, dialogId: request.dialogId, payload: request.payload } };
    },
    close(instanceId: string) {
      const removed = opened.delete(instanceId);
      if (removed) notify();
      return removed;
    },
    find(instanceId: string) {
      const entry = opened.get(instanceId);
      return entry ? { instanceId, ...entry } : null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resolveAction(actionKey: string | undefined) {
      return actionKey ? actions.get(actionKey) ?? null : null;
    }
  };
}

function mount(options: {
  nodes?: Array<{ id: string; type?: string; x: number; y: number; data?: Record<string, unknown> }>;
  merge?: (input: Record<string, unknown>) => Promise<unknown>;
  refreshNode?: (nodeId: string) => Promise<void>;
} = {}) {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const canvas = {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: (options.nodes ?? [
        { id: "source", x: 0, y: 0 },
        { id: "target", x: 300, y: 0 }
      ]).map((node) => ({
        id: node.id,
        type: node.type ?? "image",
        position: { x: node.x, y: node.y },
        width: 248,
        height: 232
      }))
    },
    nodeData: Object.fromEntries((options.nodes ?? []).filter((node) => node.data).map((node) => [node.id, node.data!]))
  } as ServerCanvas;
  const dialogs = dialogsHarness();
  const merge = vi.fn(options.merge ?? (async () => ({
    ok: true,
    value: {
      targetNodeId: "target", sourceNodeId: "source", revision: 2,
      copied: 1, duplicates: 0, evicted: 0, alreadyMerged: false
    }
  })));
  const selectNode = vi.fn();
  const refreshNode = vi.fn(options.refreshNode ?? (async () => {}));
  const listeners = { viewport: new Set<() => void>(), canvas: new Set<() => void>() };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let cleanup = () => {};
  nodeMergeExtension()({
    canvasRuntime: {
      worldToClient: (point: { x: number; y: number }) => point,
      subscribeViewport: (listener: () => void) => { listeners.viewport.add(listener); return () => listeners.viewport.delete(listener); },
      controller: () => ({ selectNode })
    },
    canvasState: {
      getWorkingCanvas: () => canvas,
      subscribe: (listener: () => void) => { listeners.canvas.add(listener); return () => listeners.canvas.delete(listener); }
    },
    dialogs,
    canvasRemote: { mergeNodeHistory: merge },
    get: (key: string) => key === "inlineHistoryVersions" ? { refreshNode } : undefined,
    effect: (effect: () => () => void) => { cleanup = effect(); }
  } as never, undefined);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; cleanup(); } };
  cleanups.push(dispose);
  return {
    canvas,
    dialogs,
    merge,
    selectNode,
    refreshNode,
    listeners,
    frames,
    dispose,
    flush: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0)); },
    notify: (kind: keyof typeof listeners) => listeners[kind].forEach((listener) => listener())
  };
}

const drag: NodeMergeDrag = { sourceNodeIds: ["source"], targetNodeId: "target", point: { x: 424, y: 116 } };

it("拖动候选在高亮层显示，viewport/画布变更后重算", () => {
  const host = mount();
  nodeMerge.preview(drag);
  host.flush();
  expect(document.querySelector('[data-node-id="target"]')).not.toBeNull();
  // 已经排队的刷新不应重复建层。
  host.notify("viewport");
  host.notify("canvas");
  host.flush();
  expect(document.querySelectorAll(".node-merge-overlay")).toHaveLength(1);
  nodeMerge.clear();
  expect(document.querySelector(".node-merge-overlays")).toBeNull();
});

it("释放打开共享确认框，确认后调用远端、关闭弹窗并选中目标", async () => {
  const host = mount();
  nodeMerge.preview(drag);
  expect(nodeMerge.drop(drag)).toBe(true);
  const [opened] = [...host.dialogs.opened.values()];
  expect(opened?.dialogId).toBe("alert");
  expect(String(opened?.payload.description)).toContain("不可撤销");
  const actionKey = String(opened?.payload.actionKey);
  const action = host.dialogs.resolveAction(actionKey);
  expect(action).not.toBeNull();

  const result = await action!();
  expect(result).toEqual({ ok: true });
  expect(host.merge).toHaveBeenCalledTimes(1);
  const input = host.merge.mock.calls[0]![0] as Record<string, unknown>;
  expect(input).toMatchObject({ canvasId: "c1", targetNodeId: "target", sourceNodeId: "source" });
  expect(String(input.operationId).startsWith(NODE_MERGE_ACTION_PREFIX)).toBe(false);
  expect(String(input.operationId)).not.toBe("");
  // 成功：弹窗关闭、一次性 action 释放、目标被选中。
  expect(host.dialogs.opened.size).toBe(0);
  expect(host.dialogs.resolveAction(actionKey)).toBeNull();
  expect(host.selectNode).toHaveBeenCalledWith("target");
  // 同图合并不改变目标 outputAssetId，仍要显式刷新目标历史（面板/历史条）。
  expect(host.refreshNode).toHaveBeenCalledWith("target");
});

it("取消关闭弹窗不调用远端并释放一次性 action", () => {
  const host = mount();
  nodeMerge.drop(drag);
  const [instanceId] = [...host.dialogs.opened.keys()];
  const actionKey = String([...host.dialogs.opened.values()][0]?.payload.actionKey);
  host.dialogs.close(instanceId!);
  expect(host.dialogs.resolveAction(actionKey)).toBeNull();
  expect(host.merge).not.toHaveBeenCalled();
});

it("失败在框内显示稳定原因，弹窗保持打开且画布不变", async () => {
  const host = mount({
    merge: async () => ({ ok: false, code: "NODE_HISTORY_CONFLICT", error: "原始错误" })
  });
  nodeMerge.drop(drag);
  const actionKey = String([...host.dialogs.opened.values()][0]?.payload.actionKey);
  const result = await host.dialogs.resolveAction(actionKey)!();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("进行中的生成");
  expect(host.dialogs.opened.size).toBe(1);
  expect(host.selectNode).not.toHaveBeenCalled();
  expect(host.dialogs.actions.size).toBe(1);
});

it("重复确认共用同一个在途请求", async () => {
  let resolve: ((value: unknown) => void) | undefined;
  const host = mount({
    merge: () => new Promise((settle) => { resolve = settle; })
  });
  nodeMerge.drop(drag);
  const actionKey = String([...host.dialogs.opened.values()][0]?.payload.actionKey);
  const action = host.dialogs.resolveAction(actionKey)!;
  const first = action();
  const second = action();
  expect(host.merge).toHaveBeenCalledTimes(1);
  resolve!({ ok: true, value: { targetNodeId: "target", sourceNodeId: "source", revision: 2, copied: 1, duplicates: 0, evicted: 0, alreadyMerged: false } });
  expect(await first).toEqual({ ok: true });
  expect(await second).toEqual({ ok: true });
  expect(host.merge).toHaveBeenCalledTimes(1);
});

it("释放时候选已失效则不消费（不同类型/托管）", () => {
  const host = mount({
    nodes: [
      { id: "source", x: 0, y: 0 },
      { id: "target", type: "video", x: 300, y: 0 }
    ]
  });
  expect(nodeMerge.drop(drag)).toBe(false);
  expect(host.dialogs.opened.size).toBe(0);

  const managed = mount({
    nodes: [
      { id: "source", x: 0, y: 0 },
      {
        id: "target", x: 300, y: 0,
        data: { managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "owner", entityId: "e", lifecycle: "owner-managed" } }
      }
    ]
  });
  expect(nodeMerge.drop(drag)).toBe(false);
  expect(managed.dialogs.opened.size).toBe(0);
});

it("卸载后清理高亮与订阅", () => {
  const host = mount();
  nodeMerge.preview(drag);
  host.flush();
  expect(document.querySelector(".node-merge-overlays")).not.toBeNull();
  host.dispose();
  expect(document.querySelector(".node-merge-overlays")).toBeNull();
  expect(host.listeners.viewport.size).toBe(0);
  expect(host.listeners.canvas.size).toBe(0);
});

it("失败文案映射稳定错误码", () => {
  expect(nodeMergeFailureText("NODE_HISTORY_CONFLICT", "")).toContain("进行中");
  expect(nodeMergeFailureText("NODE_HISTORY_UNRECOVERABLE", "")).toContain("不可恢复");
  // 同一稳定码下有「没有对应历史版本」与「媒体不可恢复」两种原因，优先展示服务端的具体原因。
  expect(nodeMergeFailureText("NODE_HISTORY_UNRECOVERABLE", "来源节点的当前内容没有对应的历史版本"))
    .toBe("来源节点的当前内容没有对应的历史版本");
  expect(nodeMergeFailureText("NODE_HISTORY_NOT_FOUND", "")).toContain("不存在");
  expect(nodeMergeFailureText("unavailable", "")).toContain("无法连接");
  expect(nodeMergeFailureText("SOMETHING", "后端原因")).toBe("后端原因");
});
