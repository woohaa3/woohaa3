/**
 * 多文档工作区 presentation 回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 2.1/2.5 / design D1/D4）。
 *
 * 覆盖独立文档 mode 的原子切换、与节点聚焦互斥、overview 返回上下文复用，以及活动操作门禁。
 * 纯 reducer/service 测试，不涉及 React 或渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CANVAS_PRESENTATION, type CanvasPresentationSnapshot } from "./contracts.js";
import { planTransition, type TransitionContext } from "./transition.js";
import { CanvasNavigationStore } from "./store.js";

function ctx(overrides: Partial<TransitionContext> = {}): TransitionContext {
  return {
    panelAvailable: () => true,
    menuAvailable: () => true,
    focusAdapterReady: true,
    focusTargetValid: () => true,
    ...overrides
  };
}

const overview: CanvasPresentationSnapshot = EMPTY_CANVAS_PRESENTATION;

describe("独立文档 presentation", () => {
  it("从 overview 进入文件文档：只发布 document-workspace，不伪造节点", () => {
    const plan = planTransition(overview, null, { type: "enter-document-workspace", documentId: "doc-1" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.mode).toEqual({ type: "document-workspace", documentId: "doc-1" });
    expect(plan.snapshot.panel).toBeNull();
    expect(plan.effects).toContainEqual({
      type: "apply-focus",
      target: { kind: "document", documentId: "doc-1" },
      transition: { preserveSession: false }
    });
    // 返回上下文只含 presentation identity，不含字节/取景/控制器。
    expect(plan.session).toMatchObject({ overviewReturn: { panel: null } });
  });

  it("同一 documentId 重入为无操作（不重放 entrance、不换 session）", () => {
    const focused: CanvasPresentationSnapshot = {
      mode: { type: "document-workspace", documentId: "doc-1" }, panel: null, menu: null
    };
    const session = { nodeId: "doc-1", overviewReturn: { panel: null }, historyFromDirect: false };
    const plan = planTransition(focused, session, { type: "enter-document-workspace", documentId: "doc-1" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.effects).toHaveLength(0);
    expect(plan.session).toBe(session);
  });

  it("文档目标不可用时拒绝并保留原呈现", () => {
    const plan = planTransition(overview, null, { type: "enter-document-workspace", documentId: "gone" },
      ctx({ documentTargetValid: () => false }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("focus-target-invalid");
    expect(plan.snapshot).toBe(overview);
  });

  it("节点 → 文件文档：保留首次进入的 overview 返回位置", () => {
    const nodeFocused: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "n1", kind: "image", owner: "direct" }, panel: null, menu: null
    };
    const session = {
      nodeId: "n1",
      overviewReturn: { panel: { type: "node-execution", nodeId: "source" } as const },
      historyFromDirect: false
    };
    const plan = planTransition(nodeFocused, session, { type: "enter-document-workspace", documentId: "doc-1" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.mode).toEqual({ type: "document-workspace", documentId: "doc-1" });
    // 返回上下文沿用本轮首次进入捕获的 panel（tab 切换不覆盖）。
    expect(plan.session?.overviewReturn.panel).toEqual({ type: "node-execution", nodeId: "source" });
  });

  it("文件文档 → 节点文档：preserveOverviewReturn 复用同一返回位置", () => {
    const fileFocused: CanvasPresentationSnapshot = {
      mode: { type: "document-workspace", documentId: "doc-1" }, panel: null, menu: null
    };
    const session = {
      nodeId: "doc-1",
      overviewReturn: { panel: { type: "node-execution", nodeId: "source" } as const },
      historyFromDirect: false
    };
    const plan = planTransition(fileFocused, session, {
      type: "enter-node-focus", nodeId: "n2", kind: "image", owner: "direct", preserveOverviewReturn: true
    }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.mode).toEqual({ type: "node-focus", nodeId: "n2", kind: "image", owner: "direct" });
    expect(plan.session?.overviewReturn.panel).toEqual({ type: "node-execution", nodeId: "source" });
  });

  it("返回画布清除返回上下文（下一轮重新捕获）", () => {
    const fileFocused: CanvasPresentationSnapshot = {
      mode: { type: "document-workspace", documentId: "doc-1" }, panel: null, menu: null
    };
    const session = {
      nodeId: "doc-1",
      overviewReturn: { panel: { type: "node-execution", nodeId: "source" } as const },
      historyFromDirect: false
    };
    const plan = planTransition(fileFocused, session, { type: "exit-node-focus" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot).toEqual({
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "source" },
      menu: null
    });
    expect(plan.session).toBeNull();
  });

  it("独立文件文档与 node-history panel 互斥", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" }, panel: { type: "node-history", nodeId: "n1" }, menu: null
    };
    const plan = planTransition(current, null, { type: "enter-document-workspace", documentId: "doc-1" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toBeNull();
    expect(plan.effects.some((effect) => effect.type === "close-panel" && effect.panelType === "node-history")).toBe(true);
  });

  it("关闭已失效文档目标时 reconcile 原子收敛到 overview", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "document-workspace", documentId: "doc-1" }, panel: null, menu: null
    };
    const plan = planTransition(current, null, { type: "reconcile", validNodeIds: new Set() },
      ctx({ documentTargetValid: () => false }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot).toEqual(EMPTY_CANVAS_PRESENTATION);
    expect(plan.session).toBeNull();
  });
});

describe("活动操作门禁", () => {
  function store(gate: () => string | null) {
    const navigation = new CanvasNavigationStore({ focusSwitchGate: gate });
    const applied: unknown[] = [];
    navigation.registerPanel({ type: "node-history", owner: "test", render: () => null });
    navigation.setFocusAdapter({
      apply: (target) => { applied.push(target); return { ok: true }; },
      isFocused: () => true,
      isTargetValid: () => true
    });
    return { navigation, applied };
  }

  it("门禁拒绝切换与返回，保留当前呈现", () => {
    const { navigation } = store(() => "请先确认或取消文字编辑");
    navigation.enterNodeFocus({ nodeId: "n1", kind: "image" });
    const switched = navigation.enterDocumentWorkspace("doc-1");
    expect(switched).toMatchObject({ ok: false, error: "not-allowed", reason: "请先确认或取消文字编辑" });
    expect(navigation.getSnapshot().mode).toEqual({ type: "node-focus", nodeId: "n1", kind: "image", owner: "direct" });
    expect(navigation.exitNodeFocus()).toMatchObject({ ok: false, error: "not-allowed" });
  });

  it("重复激活同一文档不受门禁影响（幂等）", () => {
    let reason: string | null = null;
    const { navigation } = store(() => reason);
    navigation.enterDocumentWorkspace("doc-1");
    reason = "请先确认或取消自由变换";
    expect(navigation.enterDocumentWorkspace("doc-1")).toMatchObject({ ok: true });
    // 切到另一个文档仍被拒绝。
    reason = "请先确认或取消自由变换";
    expect(navigation.enterDocumentWorkspace("doc-2")).toMatchObject({ ok: false, error: "not-allowed" });
  });

  it("只开关 panel 不受门禁影响", () => {
    const { navigation } = store(() => "请先确认或取消文字编辑");
    navigation.enterNodeFocus({ nodeId: "n1", kind: "image" });
    expect(navigation.openPanel({ type: "node-history", nodeId: "n1" })).toMatchObject({ ok: true });
    expect(navigation.closePanel()).toMatchObject({ ok: true });
  });
});

describe("独立文档与请求串行", () => {
  it("requestEnterDocumentWorkspace 结算后原子发布；等待期间聚焦改变则丢弃", async () => {
    const navigation = new CanvasNavigationStore({});
    navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => false, isTargetValid: () => true, isDocumentTargetValid: () => true });
    const result = await navigation.requestEnterDocumentWorkspace("doc-1");
    expect(result.ok).toBe(true);
    expect(navigation.getSnapshot().mode).toEqual({ type: "document-workspace", documentId: "doc-1" });
  });

  it("requestExitNodeFocus 对文件文档同样生效", async () => {
    const navigation = new CanvasNavigationStore({});
    navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => false, isTargetValid: () => true, isDocumentTargetValid: () => true });
    navigation.enterDocumentWorkspace("doc-1");
    const exit = await navigation.requestExitNodeFocus();
    expect(exit.ok).toBe(true);
    expect(navigation.getSnapshot().mode).toEqual({ type: "overview" });
  });

  it("prepareExit 失败时保留文档呈现", async () => {
    const prepareExit = vi.fn(async () => ({ ok: false as const, reason: "保存失败" }));
    const navigation = new CanvasNavigationStore({ prepareExit });
    navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => false, isTargetValid: () => true, isDocumentTargetValid: () => true });
    navigation.enterDocumentWorkspace("doc-1");
    const exit = await navigation.requestExitNodeFocus();
    expect(exit).toMatchObject({ ok: false, error: "not-allowed", reason: "保存失败" });
    expect(navigation.getSnapshot().mode).toEqual({ type: "document-workspace", documentId: "doc-1" });
  });
});
