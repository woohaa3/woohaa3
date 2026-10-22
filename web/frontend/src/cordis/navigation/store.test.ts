/**
 * Canvas Navigation Service 行为测试
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 3.5 / 5.5 / 7.5；
 *   change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，task 1.3–2.4）。
 */
import { describe, expect, it } from "vitest";
import { CanvasNavigationStore } from "./store.js";
import type { CanvasFocusTarget, CanvasFocusTransition, CanvasLayoutAdapter } from "./contracts.js";

function registerBasics(store: CanvasNavigationStore) {
  store.registerPanel({ type: "node-execution", owner: "task-execution", render: () => null });
  store.registerPanel({ type: "model-node-editor", owner: "task-execution", render: () => null });
  store.registerPanel({ type: "node-history", owner: "node-history", render: () => null });
  store.registerMenu({ type: "canvas-context", owner: "canvas-menu", render: () => null });
}

function focusAdapter(log: string[], valid = true): CanvasLayoutAdapter {
  return {
    apply: (target, transition) => {
      log.push(`apply:${target ? ("nodeId" in target ? `${target.nodeId}:${target.owner}` : `document:${target.documentId}`) : "null"}:${transition.restoreDirectCamera ? "restore" : "plain"}`);
      return valid ? { ok: true } : { ok: false, reason: "invalid" };
    },
    isFocused: () => false,
    isTargetValid: () => valid
  };
}

describe("CanvasNavigationStore 行为", () => {
  it("transition 串行：重入 intent 排队且不被迟到结果覆盖", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.openPanel({ type: "node-execution", nodeId: "n1" });
    store.openMenu({ type: "canvas-context", nodeId: null, screen: { x: 1, y: 2 }, world: { x: 3, y: 4 } });
    expect(store.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });
    expect(store.getSnapshot().menu?.type).toBe("canvas-context");
  });

  it("openPanel 切换 panel identity 会运行 cleanup", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    let cleanups = 0;
    store.registerCleanup("task-execution", () => {
      cleanups += 1;
    });
    store.openPanel({ type: "node-execution", nodeId: "n1" });
    store.openPanel({ type: "node-history", nodeId: "n1" });
    expect(cleanups).toBeGreaterThanOrEqual(1);
    expect(store.getSnapshot().panel).toEqual({ type: "node-history", nodeId: "n1" });
  });

  it("focus adapter 失败不发布半状态", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const log: string[] = [];
    store.setFocusAdapter(focusAdapter(log, false));
    const result = store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("模型聚焦 ↔ model-node-editor 双向互斥（通过真实 store+adapter）", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const log: string[] = [];
    store.setFocusAdapter(focusAdapter(log));

    // panel → focus：先关闭 panel。
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    expect(store.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(store.getSnapshot().panel).toBeNull();

    // focus → panel：先退出聚焦。
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
    expect(store.getSnapshot().panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
    expect(log).toContain("apply:null:plain");
  });

  it("打开历史先显示当前版本，选旧版本才切 history owner", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const log: string[] = [];
    store.setFocusAdapter(focusAdapter(log));
    expect(store.openNodeHistory({ nodeId: "m1", kind: "model" }).ok).toBe(true);
    expect(store.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(store.getSnapshot().panel).toEqual({ type: "node-history", nodeId: "m1" });
    expect(log).toContain("apply:m1:direct:plain");
    store.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "history" });
    expect(log).toContain("apply:m1:history:plain");
    store.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "direct" });
    expect(log).toContain("apply:m1:direct:restore");
    expect(store.getSnapshot().panel).toEqual({ type: "node-history", nodeId: "m1" });
  });

  it("close-node-history：从 direct 来源恢复 direct；history 经 Escape 全局退出恢复 panel", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const log: string[] = [];
    store.setFocusAdapter(focusAdapter(log));

    // 从 model-node-editor 进入 direct，再打开历史，关闭 → 恢复 direct（panel null）。
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    store.openNodeHistory({ nodeId: "m1", kind: "model" });
    store.closeNodeHistory();
    expect(store.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(store.getSnapshot().panel).toBeNull();
    expect(log).toContain("apply:m1:direct:restore");

    // 全局退出 → 恢复进入前 model-node-editor panel。
    store.exitNodeFocus();
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
    expect(store.getSnapshot().panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
  });

  it("从 overview 打开历史，关闭 → 退出并恢复 entry panel", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.setFocusAdapter(focusAdapter([]));
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    // 打开历史会关闭 model-node-editor 并记录 overview 返回目标。
    store.openNodeHistory({ nodeId: "m1", kind: "model" });
    expect(store.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    store.closeNodeHistory();
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
    expect(store.getSnapshot().panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
  });

  it("历史选择当前版本原子恢复 direct，保留历史面板", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const log: string[] = [];
    store.setFocusAdapter(focusAdapter(log));
    store.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "history" });
    expect(store.getSnapshot().panel).toBeNull();
    store.openNodeHistory({ nodeId: "m1", kind: "model" });
    expect(store.getSnapshot().panel).toEqual({ type: "node-history", nodeId: "m1" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "history" });
    // 选择当前版本（direct）。
    const result = store.enterNodeFocus({ nodeId: "m1", kind: "model", owner: "direct" });
    expect(result.ok).toBe(true);
    expect(store.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(store.getSnapshot().panel).toEqual({ type: "node-history", nodeId: "m1" });
    expect(log).toContain("apply:m1:direct:restore");
  });

  it("重复 close-node-history 幂等", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.setFocusAdapter(focusAdapter([]));
    store.openNodeHistory({ nodeId: "m1", kind: "model" });
    store.closeNodeHistory();
    const second = store.closeNodeHistory();
    expect(second.ok).toBe(true);
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("invalidate-node-focus 丢弃返回目标", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.setFocusAdapter(focusAdapter([]));
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    store.invalidateNodeFocus("gone");
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
    expect(store.getSnapshot().panel).toBeNull();
  });

  it("focus adapter 拒绝目标时不发布孤立 panel", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.setFocusAdapter(focusAdapter([], false));
    const result = store.openNodeHistory({ nodeId: "m1", kind: "model" });
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().panel).toBeNull();
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("未注册 optional panel 的请求被拒绝且保持当前状态", () => {
    const store = new CanvasNavigationStore();
    store.registerPanel({ type: "node-execution", owner: "task-execution", render: () => null });
    store.openPanel({ type: "node-execution", nodeId: "n1" });
    const result = store.openPanel({ type: "node-history", nodeId: "n1" });
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });
  });

  it("remote 删除目标节点后 reconcile 关闭 panel 与 menu 并退出 focus", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    const runtimeFocused = { value: true };
    store.setFocusAdapter({
      apply: (_target: CanvasFocusTarget | null, _transition: CanvasFocusTransition) => ({ ok: true }),
      isFocused: () => runtimeFocused.value,
      isTargetValid: () => true
    });
    store.openPanel({ type: "node-execution", nodeId: "gone" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    store.reconcile(new Set(["keep"]));
    expect(store.getSnapshot().panel).toBeNull();
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });

    // runtime 不再聚焦时 reconcile 也收敛。
    store.enterNodeFocus({ nodeId: "keep", kind: "model" });
    runtimeFocused.value = false;
    store.reconcile(new Set(["keep"]));
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("resetPresentation 清除 focus session（后续 overview 不再恢复 panel）", () => {
    const store = new CanvasNavigationStore();
    registerBasics(store);
    store.setFocusAdapter(focusAdapter([]));
    store.openPanel({ type: "model-node-editor", nodeId: "m1" });
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    store.resetPresentation();
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
    expect(store.getSnapshot().panel).toBeNull();
    // 再进入并退出不会恢复已丢弃的 panel。
    store.enterNodeFocus({ nodeId: "m1", kind: "model" });
    store.exitNodeFocus();
    expect(store.getSnapshot().panel).toBeNull();
  });
  it.each(["image", "model"] as const)("%s 切换目标先保存；失败保留原现场，同节点历史不保存", async kind => {
    let calls = 0;
    let allow = false;
    const store = new CanvasNavigationStore({ prepareExit: async () => { calls++; return allow ? { ok: true } : { ok: false, reason: "保存失败" }; } });
    registerBasics(store); store.setFocusAdapter(focusAdapter([]));
    store.enterNodeFocus({ nodeId: "original", kind });
    expect((await store.requestOpenNodeHistory({ nodeId: "original", kind })).ok).toBe(true);
    expect(calls).toBe(0);
    expect((await store.requestEnterNodeFocus({ nodeId: "other", kind })).ok).toBe(false);
    expect(store.getSnapshot().mode).toMatchObject({ nodeId: "original" });
    allow = true;
    expect((await store.requestEnterNodeFocus({ nodeId: "other", kind })).ok).toBe(true);
    expect(store.getSnapshot().mode).toMatchObject({ nodeId: "other" });
    expect(calls).toBe(2);
  });

  it("迟到的退出结果不会退出后进入的新目标", async () => {
    let settle!: (result: { ok: true }) => void;
    const store = new CanvasNavigationStore({ prepareExit: () => new Promise(resolve => { settle = resolve; }) });
    registerBasics(store); store.setFocusAdapter(focusAdapter([]));
    store.enterNodeFocus({ nodeId: "original", kind: "image" });
    const exiting = store.requestExitNodeFocus();
    await Promise.resolve();
    store.invalidateNodeFocus();
    store.enterNodeFocus({ nodeId: "new", kind: "model" });
    settle({ ok: true });
    expect((await exiting).ok).toBe(false);
    expect(store.getSnapshot().mode).toMatchObject({ nodeId: "new", kind: "model" });
  });

  it("同一聚焦会话的重新发布不会取消已经准备好的返回", async () => {
    let settle!: (result: { ok: true }) => void;
    const store = new CanvasNavigationStore({ prepareExit: () => new Promise(resolve => { settle = resolve; }) });
    registerBasics(store); store.setFocusAdapter(focusAdapter([]));
    store.enterNodeFocus({ nodeId: "same", kind: "model" });
    const exiting = store.requestExitNodeFocus();
    await Promise.resolve();
    store.enterNodeFocus({ nodeId: "same", kind: "model", owner: "history" });
    store.enterNodeFocus({ nodeId: "same", kind: "model", owner: "direct" });
    settle({ ok: true });
    expect((await exiting).ok).toBe(true);
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("requestOpenDialog：dirty focus 先结算，取消则不入栈也不清理现场", async () => {
    // change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.1 / design D3。
    const opened: string[] = [];
    let dirty = true;
    let settle!: (result: { ok: true } | { ok: false; reason: string }) => void;
    let prepareEntered!: () => void;
    const entered = new Promise<void>((resolve) => { prepareEntered = resolve; });
    const store = new CanvasNavigationStore({
      openDialog: (request) => {
        opened.push(request.dialogId);
        return { ok: true };
      },
      hasUnsavedChanges: () => dirty,
      prepareExit: () => new Promise((resolve) => { settle = resolve; prepareEntered(); }),
      canvasIdentity: () => "c1"
    });
    registerBasics(store);
    store.openPanel({ type: "node-execution", nodeId: "n1" });

    const request = store.requestOpenDialog({ dialogId: "settings", canvasId: "c1" });
    // 等待结算期间菜单/panel 未被提前清理，也没有入栈。
    await entered;
    expect(opened).toEqual([]);
    expect(store.getSnapshot().panel).not.toBeNull();

    settle({ ok: false, reason: "用户取消" });
    await expect(request).resolves.toEqual({ ok: false, code: "not-allowed", reason: "用户取消" });
    expect(opened).toEqual([]);
    expect(store.getSnapshot().panel).not.toBeNull();
  });

  it("requestOpenDialog：等待结算期间切换画布则丢弃迟到结果", async () => {
    const opened: string[] = [];
    let canvasId = "c1";
    let settle!: (result: { ok: true }) => void;
    let prepareEntered!: () => void;
    const entered = new Promise<void>((resolve) => { prepareEntered = resolve; });
    const store = new CanvasNavigationStore({
      openDialog: (request) => {
        opened.push(request.dialogId);
        return { ok: true };
      },
      hasUnsavedChanges: () => true,
      prepareExit: () => new Promise((resolve) => { settle = resolve; prepareEntered(); }),
      canvasIdentity: () => canvasId
    });
    registerBasics(store);
    const request = store.requestOpenDialog({ dialogId: "settings", canvasId: "c1" });
    await entered;
    canvasId = "c2";
    settle({ ok: true });
    await expect(request).resolves.toEqual({ ok: false, code: "stale", reason: "编辑现场已改变" });
    expect(opened).toEqual([]);
  });

  it("requestOpenDialog：干净 focus 直接打开；结算成功后才入栈", async () => {
    const opened: string[] = [];
    let settle!: (result: { ok: true }) => void;
    let prepareEntered!: () => void;
    const entered = new Promise<void>((resolve) => { prepareEntered = resolve; });
    const store = new CanvasNavigationStore({
      openDialog: (request) => {
        opened.push(`${request.dialogId}:${JSON.stringify(request.payload ?? null)}`);
        return { ok: true };
      },
      hasUnsavedChanges: () => true,
      prepareExit: () => new Promise((resolve) => { settle = resolve; prepareEntered(); }),
      canvasIdentity: () => "c1"
    });
    registerBasics(store);
    const request = store.requestOpenDialog({ dialogId: "settings", payload: { section: "plugins" }, canvasId: "c1" });
    await entered;
    expect(opened).toEqual([]);
    settle({ ok: true });
    await expect(request).resolves.toEqual({ ok: true });
    expect(opened).toEqual(['settings:{"section":"plugins"}']);

    // 干净状态：同步路径立即入栈。
    const clean = new CanvasNavigationStore({
      openDialog: (request) => {
        opened.push(request.dialogId);
        return { ok: true };
      },
      hasUnsavedChanges: () => false
    });
    await expect(clean.requestOpenDialog({ dialogId: "settings" })).resolves.toEqual({ ok: true });
    expect(opened.at(-1)).toBe("settings");
  });

  it("requestOpenDialog：Dialog 不可用时返回稳定原因（不重试、不导航）", async () => {
    const store = new CanvasNavigationStore({
      openDialog: () => ({ ok: false, error: "dialog open participant 拒绝或失败" }),
      hasUnsavedChanges: () => false
    });
    await expect(store.requestOpenDialog({ dialogId: "settings" })).resolves.toEqual({
      ok: false,
      code: "dialog-unavailable",
      reason: "dialog open participant 拒绝或失败"
    });
    expect(store.getSnapshot().mode).toEqual({ type: "overview" });
  });

});

it("feature entry guards block direct editing before changing focus, but preserve history viewing", async () => {
  const store = new CanvasNavigationStore(); registerBasics(store);
  const log: string[] = []; store.setFocusAdapter(focusAdapter(log));
  const unregister = store.registerNodeFocusGuard("image-editor", input => input.kind === "image" && input.owner === "direct" ? "图片编辑组件未安装" : null);
  expect((await store.requestEnterNodeFocus({ nodeId: "n", kind: "image" })).ok).toBe(false);
  expect(store.getSnapshot().mode.type).toBe("overview"); expect(log).toEqual([]);
  expect(store.enterNodeFocus({ nodeId: "n", kind: "image", owner: "history" }).ok).toBe(true);
  unregister();
  expect((await store.requestEnterNodeFocus({ nodeId: "n", kind: "image" })).ok).toBe(true);
});

it("aborted focus requests cannot dispatch after exit settlement", async () => {
  let finish!: () => void;
  const store = new CanvasNavigationStore({ prepareExit: () => new Promise(resolve => { finish = () => resolve({ ok: true }); }) });
  registerBasics(store); const log: string[] = []; store.setFocusAdapter(focusAdapter(log));
  store.enterNodeFocus({ nodeId: "original", kind: "model", owner: "direct" }); log.length = 0;
  const abort = new AbortController();
  const pending = store.requestEnterNodeFocus({ nodeId: "n", kind: "image", signal: abort.signal });
  await Promise.resolve();
  abort.abort(); finish();
  expect((await pending).ok).toBe(false);
  expect(store.getSnapshot().mode).toMatchObject({ type: "node-focus", nodeId: "original" }); expect(log).toEqual([]);
});

it("idempotent entry to the already active view does not prepare it again", async () => {
  const store = new CanvasNavigationStore(); registerBasics(store); store.setFocusAdapter(focusAdapter([]));
  store.enterNodeFocus({ nodeId: "n", kind: "image", owner: "direct" });
  let checks = 0;
  store.registerNodeFocusGuard("image", () => { checks++; return "准备中"; });
  expect((await store.requestEnterNodeFocus({ nodeId: "n", kind: "image", owner: "direct" })).ok).toBe(true);
  expect(checks).toBe(0);
});
