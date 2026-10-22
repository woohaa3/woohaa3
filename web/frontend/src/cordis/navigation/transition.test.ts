/**
 * Canvas Navigation transition 不变量测试
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 1.3；
 *   change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，task 1.1–2.3）。
 */
import { describe, expect, it } from "vitest";
import { EMPTY_CANVAS_PRESENTATION, type CanvasPresentationSnapshot } from "./contracts.js";
import { planTransition, type TransitionContext } from "./transition.js";

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

describe("Canvas Navigation transition 不变量", () => {
  it("单 panel：打开新 panel 会关闭旧 panel", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "n1" },
      menu: null
    };
    const plan = planTransition(current, null, { type: "open-panel", route: { type: "node-history", nodeId: "n1" } }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toEqual({ type: "node-history", nodeId: "n1" });
    expect(plan.effects.some((effect) => effect.type === "close-panel")).toBe(true);
  });

  it("单 menu：打开新 menu 会关闭旧 menu", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: null,
      menu: { type: "canvas-context", nodeId: null, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } }
    };
    const plan = planTransition(
      current,
      null,
      { type: "open-menu", route: { type: "canvas-context", nodeId: "n1", screen: { x: 1, y: 2 }, world: { x: 3, y: 4 } } },
      ctx()
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.menu?.nodeId).toBe("n1");
    expect(plan.effects.some((effect) => effect.type === "close-menu")).toBe(true);
  });

  it("模型聚焦与 model-node-editor panel 双向互斥", () => {
    // 1) panel 活动 → 进入聚焦会先关闭 panel 并记录返回目标。
    const withPanel: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "model-node-editor", nodeId: "m1" },
      menu: null
    };
    const entered = planTransition(withPanel, null, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx());
    expect(entered.ok).toBe(true);
    if (entered.ok) {
      expect(entered.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
      expect(entered.snapshot.panel).toBeNull();
      expect(entered.effects.some((effect) => effect.type === "close-panel")).toBe(true);
      // 返回上下文记录可恢复 panel。
      expect(entered.session?.overviewReturn.panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
    }

    // 2) 聚焦中 → 打开 model-node-editor 会先退出聚焦。
    const focused: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: null,
      menu: null
    };
    const opened = planTransition(focused, null, { type: "open-panel", route: { type: "model-node-editor", nodeId: "m1" } }, ctx());
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.snapshot.mode).toEqual({ type: "overview" });
      expect(opened.snapshot.panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
      expect(opened.effects.some((effect) => effect.type === "apply-focus" && effect.target === null)).toBe(true);
    }
  });

  it("模型历史复合 intent 原子建立 focus + node-history panel", () => {
    const plan = planTransition(overview, null, { type: "open-node-history", nodeId: "m1", kind: "model" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(plan.snapshot.panel).toEqual({ type: "node-history", nodeId: "m1" });
    expect(plan.effects.some((effect) => effect.type === "apply-focus" && effect.target && "owner" in effect.target && effect.target.owner === "direct")).toBe(true);
  });

  it("同一 node owner 变化也产生 adapter effect（design D2）", () => {
    const direct: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: null,
      menu: null
    };
    const toHistory = planTransition(direct, { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: false }, { type: "open-node-history", nodeId: "m1", kind: "model" }, ctx());
    expect(toHistory.ok).toBe(true);
    if (!toHistory.ok) return;
    expect(toHistory.snapshot.mode).toEqual(direct.mode);
    expect(toHistory.effects.filter(effect => effect.type === "apply-focus")).toHaveLength(0);
    const selected = planTransition(toHistory.snapshot, toHistory.session, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "history" }, ctx());
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.effects.some(effect => effect.type === "apply-focus" && effect.target && "owner" in effect.target && effect.target.owner === "history")).toBe(true);
      expect(selected.snapshot.panel).toEqual({ type: "node-history", nodeId: "m1" });
    }
    expect(toHistory.session?.historyFromDirect).toBe(true);

    // 同 node 同 owner：幂等，不重复 adapter effect。
    const idempotent = planTransition(direct, { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: false }, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx());
    expect(idempotent.ok).toBe(true);
    if (idempotent.ok) {
      expect(idempotent.snapshot).toEqual(direct);
      expect(idempotent.effects.filter((effect) => effect.type === "apply-focus")).toHaveLength(0);
    }
  });

  it("进入 history 记录来源；从 direct 来源关闭 history 恢复 direct（design D3）", () => {
    const historyFromDirect: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "history" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: null
    };
    const session = { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: true };
    const closed = planTransition(historyFromDirect, session, { type: "close-node-history" }, ctx());
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(closed.snapshot.panel).toBeNull();
    const effect = closed.effects.find((entry) => entry.type === "apply-focus");
    expect(effect && effect.type === "apply-focus" ? effect.transition.restoreDirectCamera : false).toBe(true);

    // 从 overview 进入的 history：关闭后退出 overview 并恢复 entry panel。
    const fromOverview: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "history" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: null
    };
    const overviewSession = { nodeId: "m1", overviewReturn: { panel: { type: "model-node-editor", nodeId: "m1" } as const }, historyFromDirect: false };
    const exitPlan = planTransition(fromOverview, overviewSession, { type: "close-node-history" }, ctx());
    expect(exitPlan.ok).toBe(true);
    if (!exitPlan.ok) return;
    expect(exitPlan.snapshot.mode).toEqual({ type: "overview" });
    expect(exitPlan.snapshot.panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
    expect(exitPlan.session).toBeNull();
  });

  it("多次 owner 往返不覆盖 overview 返回目标；exit 恢复该 panel（design D1/D4）", () => {
    const start: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "model-node-editor", nodeId: "m1" },
      menu: null
    };
    const entered = planTransition(start, null, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx());
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;
    let session = entered.session;
    // direct -> history -> direct。
    const toHistory = planTransition(entered.snapshot, session, { type: "open-node-history", nodeId: "m1", kind: "model" }, ctx());
    expect(toHistory.ok).toBe(true);
    if (!toHistory.ok) return;
    session = toHistory.session;
    const toDirect = planTransition(toHistory.snapshot, session, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx());
    expect(toDirect.ok).toBe(true);
    if (!toDirect.ok) return;
    expect(toDirect.session?.overviewReturn.panel).toEqual({ type: "model-node-editor", nodeId: "m1" });

    const exited = planTransition(toDirect.snapshot, toDirect.session, { type: "exit-node-focus" }, ctx());
    expect(exited.ok).toBe(true);
    if (!exited.ok) return;
    expect(exited.snapshot.mode).toEqual({ type: "overview" });
    expect(exited.snapshot.panel).toEqual({ type: "model-node-editor", nodeId: "m1" });
    expect(exited.session).toBeNull();
  });

  it("invalidate-node-focus 丢弃返回目标并收敛到干净 overview", () => {
    const focused: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "history" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: null
    };
    const session = { nodeId: "m1", overviewReturn: { panel: { type: "model-node-editor", nodeId: "m1" } as const }, historyFromDirect: true };
    const plan = planTransition(focused, session, { type: "invalidate-node-focus", reason: "x" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot).toEqual(EMPTY_CANVAS_PRESENTATION);
    expect(plan.session).toBeNull();
  });

  it("clear-transient-surfaces：direct focus 保留、history 从 direct 来源收敛到 direct 且丢弃返回 panel", () => {
    const direct: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: null
    };
    const directSession = { nodeId: "m1", overviewReturn: { panel: { type: "model-node-editor", nodeId: "m1" } as const }, historyFromDirect: false };
    const cleared = planTransition(direct, directSession, { type: "clear-transient-surfaces" }, ctx());
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(cleared.snapshot.panel).toBeNull();
    expect(cleared.session?.overviewReturn.panel).toBeNull();

    const history: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "history" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: null
    };
    const historySession = { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: true };
    const toDirect = planTransition(history, historySession, { type: "clear-transient-surfaces" }, ctx());
    expect(toDirect.ok).toBe(true);
    if (!toDirect.ok) return;
    expect(toDirect.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(toDirect.snapshot.panel).toBeNull();
  });

  it("focus adapter 拒绝目标时不发布半状态", () => {
    const plan = planTransition(overview, null, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx({ focusTargetValid: () => false }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("focus-target-invalid");
    expect(plan.snapshot).toEqual(overview);
  });

  it("未注册 panel definition 时拒绝", () => {
    const plan = planTransition(overview, null, { type: "open-panel", route: { type: "node-history", nodeId: "n1" } }, ctx({ panelAvailable: () => false }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("panel-definition-unavailable");
  });

  it("同一 identity 的 compact↔expanded replace 不运行 close cleanup", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "n1", presentation: "compact" },
      menu: null
    };
    const expanded = planTransition(
      current,
      null,
      { type: "open-panel", route: { type: "node-execution", nodeId: "n1", presentation: "expanded" } },
      ctx()
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.snapshot.panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "expanded" });
    expect(expanded.effects.some((effect) => effect.type === "close-panel")).toBe(false);

    const collapsed = planTransition(
      expanded.snapshot,
      null,
      { type: "open-panel", route: { type: "node-execution", nodeId: "n1", presentation: "compact" } },
      ctx()
    );
    expect(collapsed.ok).toBe(true);
    if (!collapsed.ok) return;
    expect(collapsed.snapshot.panel).toEqual({ type: "node-execution", nodeId: "n1", presentation: "compact" });
    expect(collapsed.effects.some((effect) => effect.type === "close-panel")).toBe(false);
  });

  it("跨节点同类型 replace 仍运行 close cleanup", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "n1", presentation: "expanded" },
      menu: null
    };
    const plan = planTransition(
      current,
      null,
      { type: "open-panel", route: { type: "node-execution", nodeId: "n2", presentation: "compact" } },
      ctx()
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toEqual({ type: "node-execution", nodeId: "n2", presentation: "compact" });
    expect(plan.effects.some((effect) => effect.type === "close-panel")).toBe(true);
  });

  it("非法 presentation payload 被 validate 拒绝且保持最后一个完整 snapshot", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "n1", presentation: "compact" },
      menu: null
    };
    const plan = planTransition(
      current,
      null,
      { type: "open-panel", route: { type: "node-execution", nodeId: "n1", presentation: "huge" as never } },
      ctx({
        panelAvailable: (route) =>
          route.type !== "node-execution" ||
          route.presentation === undefined ||
          route.presentation === "compact" ||
          route.presentation === "expanded"
      })
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe("panel-definition-unavailable");
    expect(plan.snapshot).toEqual(current);
  });

  it("reconcile 关闭 definition 已失效的 panel", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "n1", presentation: "compact" },
      menu: null
    };
    const plan = planTransition(current, null, { type: "reconcile", validNodeIds: new Set(["n1"]) }, ctx({ panelAvailable: () => false }));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toBeNull();
    expect(plan.effects.some((effect) => effect.type === "close-panel")).toBe(true);
  });

  it("dialog active 推论：clearTransientSurfaces 清空 panel 与 menu 但不改 mode", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: { type: "node-history", nodeId: "m1" },
      menu: { type: "canvas-context", nodeId: null, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } }
    };
    const plan = planTransition(current, null, { type: "clear-transient-surfaces" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toBeNull();
    expect(plan.snapshot.menu).toBeNull();
    expect(plan.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
  });

  it("reconcile 关闭引用失效 nodeId 的 panel 与 menu", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "overview" },
      panel: { type: "node-execution", nodeId: "gone" },
      menu: { type: "canvas-context", nodeId: "gone", screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } }
    };
    const plan = planTransition(current, null, { type: "reconcile", validNodeIds: new Set(["keep"]) }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot.panel).toBeNull();
    expect(plan.snapshot.menu).toBeNull();
  });

  it("reconcile 在 focus 目标失效或 runtime 未聚焦时收敛到 overview", () => {
    const focused: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: null,
      menu: null
    };
    const session = { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: false };
    const gone = planTransition(focused, session, { type: "reconcile", validNodeIds: new Set(["m1"]) }, ctx({ focusTargetValid: () => false }));
    expect(gone.ok).toBe(true);
    if (gone.ok) {
      expect(gone.snapshot).toEqual(EMPTY_CANVAS_PRESENTATION);
      expect(gone.session).toBeNull();
    }
    const notFocused = planTransition(focused, session, { type: "reconcile", validNodeIds: new Set(["m1"]) }, ctx({ focusRuntimeFocused: () => false }));
    expect(notFocused.ok).toBe(true);
    if (notFocused.ok) expect(notFocused.snapshot).toEqual(EMPTY_CANVAS_PRESENTATION);

    const kept = planTransition(focused, session, { type: "reconcile", validNodeIds: new Set(["m1"]) }, ctx());
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.snapshot).toEqual(focused);
  });

  it("reset-presentation 收敛 focus、panel 与 menu", () => {
    const current: CanvasPresentationSnapshot = {
      mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" },
      panel: { type: "model-node-editor", nodeId: "m1" },
      menu: { type: "canvas-context", nodeId: null, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } }
    };
    const plan = planTransition(current, null, { type: "reset-presentation" }, ctx());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.snapshot).toEqual(EMPTY_CANVAS_PRESENTATION);
    expect(plan.session).toBeNull();
  });

  it("非法 payload（未注册 definition）拒绝且保持最后一个完整 snapshot", () => {
    const plan = planTransition(overview, null, { type: "open-menu", route: { type: "canvas-context", nodeId: null, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } } }, ctx({ menuAvailable: () => false }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.snapshot).toEqual(overview);
  });

  it("video 是独立聚焦 kind，可与 image/model 互相切换并使用统一 direct/history owner", () => {
    // 进入 video 聚焦。
    const entered = planTransition(overview, null, { type: "enter-node-focus", nodeId: "v1", kind: "video", owner: "direct" }, ctx());
    expect(entered.ok).toBe(true);
    if (!entered.ok) return;
    expect(entered.snapshot.mode).toEqual({ type: "node-focus", nodeId: "v1", kind: "video", owner: "direct" });
    // image → video 切换：仍是同一 focus 类型，但 kind 变化必须重新 apply。
    const image: CanvasPresentationSnapshot = { mode: { type: "node-focus", nodeId: "i1", kind: "image", owner: "direct" }, panel: null, menu: null };
    const switched = planTransition(image, { nodeId: "i1", overviewReturn: { panel: null }, historyFromDirect: false }, { type: "enter-node-focus", nodeId: "v1", kind: "video", owner: "direct" }, ctx());
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.snapshot.mode).toEqual({ type: "node-focus", nodeId: "v1", kind: "video", owner: "direct" });
    expect(switched.effects.some((effect) => effect.type === "apply-focus" && effect.target?.kind === "video")).toBe(true);
  });

  it("extension 工作区聚焦与 model 聚焦互斥：Navigation 单一 mode，切换替换而非并行（任务 5.10）", () => {
    // 从普通模型聚焦切到 extension 聚焦（双击炼丹炉节点）：mode 被替换，不产生并行 focus。
    const model: CanvasPresentationSnapshot = { mode: { type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" }, panel: null, menu: null };
    const toExtension = planTransition(model, { nodeId: "m1", overviewReturn: { panel: null }, historyFromDirect: false }, { type: "enter-node-focus", nodeId: "g1", kind: "extension", owner: "direct" }, ctx());
    expect(toExtension.ok).toBe(true);
    if (!toExtension.ok) return;
    expect(toExtension.snapshot.mode).toEqual({ type: "node-focus", nodeId: "g1", kind: "extension", owner: "direct" });
    expect(toExtension.effects.some((effect) => effect.type === "apply-focus" && effect.target?.kind === "extension")).toBe(true);
    // 反向：extension → model 聚焦同样替换 mode。
    const extension: CanvasPresentationSnapshot = { mode: { type: "node-focus", nodeId: "g1", kind: "extension", owner: "direct" }, panel: null, menu: null };
    const backToModel = planTransition(extension, { nodeId: "g1", overviewReturn: { panel: null }, historyFromDirect: false }, { type: "enter-node-focus", nodeId: "m1", kind: "model", owner: "direct" }, ctx());
    expect(backToModel.ok).toBe(true);
    if (!backToModel.ok) return;
    expect(backToModel.snapshot.mode).toEqual({ type: "node-focus", nodeId: "m1", kind: "model", owner: "direct" });
    expect(backToModel.effects.some((effect) => effect.type === "apply-focus" && effect.target?.kind === "model")).toBe(true);
  });

  it("video 目标非法时不进入聚焦并保持完整状态", () => {
    const plan = planTransition(overview, null, { type: "enter-node-focus", nodeId: "v1", kind: "video", owner: "direct" }, ctx({ focusTargetValid: (_id, kind) => kind !== "video" }));
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.snapshot).toEqual(overview);
  });
});
