/**
 * Canvas presentation navigation 纯 reducer/transition planner
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 1.3 / design D2/D5；
 *   change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，task 1.2/2.1–2.3）。
 *
 * 只做纯计算：给定当前 snapshot、可丢弃 focus transition session、intent、registry 校验结果与
 * adapter readiness，返回下一 snapshot/session 或稳定错误。副作用（adapter apply、cleanup）由
 * service 按 plan 执行，保证先校验后执行、失败不发布半状态。
 */
import {
  EMPTY_CANVAS_PRESENTATION,
  isFocusMode,
  normalizeCanvasPanelRoute,
  sameCanvasPanelIdentity,
  type CanvasFocusKind,
  type CanvasFocusTarget,
  type CanvasFocusTransition,
  type CanvasNavigationError,
  type CanvasNavigationIntent,
  type CanvasPanelRoute,
  type CanvasPresentationSnapshot,
  type FocusTransitionSession
} from "./contracts.js";

export type TransitionContext = {
  /** 目标 panel definition 是否已注册且通过 payload 校验。 */
  panelAvailable: (route: CanvasPanelRoute) => boolean;
  menuAvailable: (type: string) => boolean;
  /** focus adapter 是否已注册。 */
  focusAdapterReady: boolean;
  /** 聚焦目标是否合法（canonical 图片/模型）。 */
  focusTargetValid: (nodeId: string, kind: CanvasFocusKind) => boolean;
  focusTargetUnavailableReason?: (nodeId: string, kind: CanvasFocusKind) => string | null;
  /** 独立文档呈现目标是否合法（缺省视为合法）。 */
  documentTargetValid?: (documentId: string) => boolean;
  /** runtime 当前是否真的持有聚焦 projection（reconcile 一致性检查）。 */
  focusRuntimeFocused?: () => boolean;
};

export type TransitionEffect =
  | { type: "apply-focus"; target: CanvasFocusTarget | null; transition: CanvasFocusTransition }
  | { type: "close-panel"; panelType: string | null }
  | { type: "close-menu" };

export type TransitionPlan =
  | {
      ok: true;
      snapshot: CanvasPresentationSnapshot;
      /** 更新后的可丢弃 focus session（null 表示无 focus 返回上下文）。 */
      session: FocusTransitionSession | null;
      /** 需要执行的副作用序列（已按确定顺序排列）。 */
      effects: TransitionEffect[];
    }
  | { ok: false; error: CanvasNavigationError; reason: string; snapshot: CanvasPresentationSnapshot };

/**
 * 计算 transition plan；不触碰 registry 或 adapter 实现，仅消费其 readiness。
 */
export function planTransition(
  current: CanvasPresentationSnapshot,
  session: FocusTransitionSession | null,
  intent: CanvasNavigationIntent,
  ctx: TransitionContext
): TransitionPlan {
  switch (intent.type) {
    case "open-panel": {
      if (!ctx.panelAvailable(intent.route)) {
        return reject("panel-definition-unavailable", `panel ${intent.route.type} 未注册或 payload 非法`, current);
      }
      const next = normalizeCanvasPanelRoute(intent.route);
      const effects: TransitionEffect[] = [];
      let mode = current.mode;
      let nextSession = session;
      // 打开模型节点编辑面板前退出聚焦（design D5）；显式打开不恢复隐藏返回目标。
      // 独立文档工作区同样与节点编辑面板互斥（不留下两个活动呈现）。
      if (next.type === "model-node-editor" && isFocusMode(mode)) {
        effects.push({ type: "apply-focus", target: null, transition: { preserveSession: false } });
        mode = { type: "overview" };
        nextSession = null;
      }
      // 替换 panel：只在**跨 identity** 时清理旧 panel。同一 identity 的 presentation
      // replace（compact↔expanded）不运行 cleanup，因此不销毁 prompt/picker/draft 状态
      // （design D5）。
      if (current.panel && !sameCanvasPanelIdentity(current.panel, next)) {
        effects.push({ type: "close-panel", panelType: current.panel.type });
      }
      return ok({ mode, panel: next, menu: current.menu }, nextSession, effects);
    }

    case "close-panel": {
      if (!current.panel) return ok(current, session, []);
      if (intent.panelType && current.panel.type !== intent.panelType) return ok(current, session, []);
      return ok({ ...current, panel: null }, session, [{ type: "close-panel", panelType: current.panel.type }]);
    }

    case "open-menu": {
      if (!ctx.menuAvailable(intent.route.type)) {
        return reject("menu-definition-unavailable", `menu ${intent.route.type} 未注册`, current);
      }
      const effects: TransitionEffect[] = [];
      if (current.menu) effects.push({ type: "close-menu" });
      return ok({ ...current, menu: intent.route }, session, effects);
    }

    case "close-menu": {
      if (!current.menu) return ok(current, session, []);
      return ok({ ...current, menu: null }, session, [{ type: "close-menu" }]);
    }

    case "enter-node-focus": {
      return planFocusIntent(current, session, { nodeId: intent.nodeId, kind: intent.kind, owner: intent.owner }, ctx, {
        // 同 node owner 变化：保留 overview 返回上下文。
        sameNodeOwnerSwitch: true,
        panel: null,
        ...(intent.preserveOverviewReturn ? { preserveOverviewReturn: true } : {})
      });
    }

    case "enter-document-workspace": {
      return planDocumentWorkspace(current, session, intent.documentId, ctx, intent.preserveOverviewReturn === true);
    }

    case "open-node-history": {
      if (!ctx.panelAvailable({ type: "node-history", nodeId: intent.nodeId })) {
        return reject("panel-definition-unavailable", "node-history panel 未注册", current);
      }
      const historyPanel: CanvasPanelRoute = { type: "node-history", nodeId: intent.nodeId };
      return planFocusIntent(current, session, { nodeId: intent.nodeId, kind: intent.kind,
        owner: current.mode.type === "node-focus" && current.mode.nodeId === intent.nodeId && current.panel?.type === "node-history" ? current.mode.owner : "direct"
      }, ctx, {
        sameNodeOwnerSwitch: true, panel: historyPanel,
        historyFromDirect: current.mode.type === "node-focus" && current.mode.nodeId === intent.nodeId
          ? (current.panel?.type === "node-history" ? session?.historyFromDirect === true : true) : false
      });
    }

    case "close-node-history": {
      if (current.mode.type !== "node-focus" || current.panel?.type !== "node-history") return ok(current, session, []);
      const nodeId = current.mode.nodeId;
      const kind = current.mode.kind;
      const fromDirect = session?.historyFromDirect === true && session.nodeId === nodeId;
      if (fromDirect) {
        return ok(
          { mode: { type: "node-focus", nodeId, kind, owner: "direct" }, panel: null, menu: null },
          { ...(session as FocusTransitionSession), historyFromDirect: false },
          [{ type: "apply-focus", target: { nodeId, kind, owner: "direct" }, transition: { preserveSession: true, restoreDirectCamera: true } }]
        );
      }
      // 从 overview 进入的历史：退出 focus 并恢复首次进入前 panel。
      const restore = session?.nodeId === nodeId ? session.overviewReturn.panel : null;
      const panel = restore && ctx.panelAvailable(restore) ? restore : null;
      return ok({ mode: { type: "overview" }, panel, menu: null }, null, [
        { type: "apply-focus", target: null, transition: { preserveSession: false } }
      ]);
    }

    case "exit-node-focus": {
      if (current.mode.type !== "node-focus" && current.mode.type !== "document-workspace") {
        // 防御：focus 已不在时仍确保 history panel 被关闭（不留 stale route）。
        if (current.panel?.type === "node-history") {
          return ok({ ...current, panel: null }, null, [{ type: "close-panel", panelType: "node-history" }]);
        }
        return ok(current, session, []);
      }
      const focusId = current.mode.type === "node-focus" ? current.mode.nodeId
        : current.mode.type === "document-workspace" ? current.mode.documentId : null;
      const restore = session && focusId !== null && session.nodeId === focusId ? session.overviewReturn.panel : null;
      const panel = restore && ctx.panelAvailable(restore) ? restore : null;
      return ok({ mode: { type: "overview" }, panel, menu: null }, null, [
        { type: "apply-focus", target: null, transition: { preserveSession: false } }
      ]);
    }

    case "invalidate-node-focus": {
      if (!isFocusMode(current.mode)) return ok(current, null, []);
      // 目标/投影失效：丢弃返回目标，收敛到干净 overview。
      return ok(EMPTY_CANVAS_PRESENTATION, null, [
        { type: "apply-focus", target: null, transition: { preserveSession: false } },
        ...(current.panel ? [{ type: "close-panel" as const, panelType: current.panel.type }] : []),
        ...(current.menu ? [{ type: "close-menu" as const }] : [])
      ]);
    }

    case "clear-transient-surfaces": {
      // Dialog pre-commit：按来源收敛 history focus（direct 或 overview），丢弃隐藏返回 panel。
      if (current.mode.type === "node-focus" && current.mode.owner === "history") {
        const nodeId = current.mode.nodeId;
        const kind = current.mode.kind;
        const fromDirect = session?.historyFromDirect === true && session.nodeId === nodeId;
        if (fromDirect) {
          return ok(
            { mode: { type: "node-focus", nodeId, kind, owner: "direct" }, panel: null, menu: null },
            { ...(session as FocusTransitionSession), historyFromDirect: false, overviewReturn: { panel: null } },
            [{ type: "apply-focus", target: { nodeId, kind, owner: "direct" }, transition: { preserveSession: true, restoreDirectCamera: true } }]
          );
        }
        return ok(EMPTY_CANVAS_PRESENTATION, null, [
          { type: "apply-focus", target: null, transition: { preserveSession: false } }
        ]);
      }
      const effects: TransitionEffect[] = [];
      if (current.panel) effects.push({ type: "close-panel", panelType: current.panel.type });
      if (current.menu) effects.push({ type: "close-menu" });
      const nextSession = session ? { ...session, overviewReturn: { panel: null } } : null;
      return ok({ mode: current.mode, panel: null, menu: null }, nextSession, effects);
    }

    case "reset-presentation": {
      const effects: TransitionEffect[] = [];
      if (isFocusMode(current.mode)) {
        effects.push({ type: "apply-focus", target: null, transition: { preserveSession: false } });
      }
      if (current.panel) effects.push({ type: "close-panel", panelType: current.panel.type });
      if (current.menu) effects.push({ type: "close-menu" });
      return ok(EMPTY_CANVAS_PRESENTATION, null, effects);
    }

    case "reconcile": {
      const effects: TransitionEffect[] = [];
      let panel = current.panel;
      let menu = current.menu;
      if (panel && panel.nodeId && !intent.validNodeIds.has(panel.nodeId)) {
        // Agent 详情按会话/回合 identity 定位，不因来源节点删除而销毁可查询历史
        // （change: 2026-10-12-add-agent-conversation-panel，design D6a）。
        if (panel.type !== "agent-conversation") {
          effects.push({ type: "close-panel", panelType: panel.type });
          panel = null;
        }
      } else if (panel && !ctx.panelAvailable(panel)) {
        // definition 已 dispose（如插件卸载）：route 引用失效，关闭并清理。
        effects.push({ type: "close-panel", panelType: panel.type });
        panel = null;
      }
      if (menu && menu.nodeId && !intent.validNodeIds.has(menu.nodeId)) {
        effects.push({ type: "close-menu" });
        menu = null;
      }
      // focus 目标失效 / runtime 不再持有 projection → 原子收敛到 overview，丢弃返回目标。
      if (current.mode.type === "node-focus") {
        const targetValid = intent.validNodeIds.has(current.mode.nodeId) && ctx.focusTargetValid(current.mode.nodeId, current.mode.kind);
        const runtimeFocused = ctx.focusRuntimeFocused?.() ?? true;
        if (!targetValid || !runtimeFocused) {
          effects.push({ type: "apply-focus", target: null, transition: { preserveSession: false } });
          return ok(EMPTY_CANVAS_PRESENTATION, null, effects);
        }
      } else if (current.mode.type === "document-workspace") {
        // 独立文档没有画布节点身份：只校验编辑 feature 报告的目标仍然有效（关闭/失效文档
        // 不得继续占用活动呈现）。
        const valid = ctx.documentTargetValid?.(current.mode.documentId) ?? true;
        if (!valid) {
          effects.push({ type: "apply-focus", target: null, transition: { preserveSession: false } });
          return ok(EMPTY_CANVAS_PRESENTATION, null, effects);
        }
      }
      return ok({ ...current, panel, menu }, session, effects);
    }

    default: {
      return reject("not-allowed", "未知 intent", current);
    }
  }
}

/**
 * 计算 focus 相关 intent（enter / open-history）的 next snapshot + session。
 *
 * `options.panel` 为聚焦建立后要显示的 panel（`null` 表示不显示，仅切换 owner）。
 * `options.preserveOverviewReturn` 表示本次切换属于同一呈现期的文档 tab 切换：保留首次
 * 进入时捕获的 overview 返回位置，不重新捕获（change: 2026-10-21-add-photocraft-document-workspace，D4）。
 * 所有可失败校验（adapter / target）在 mutation 前完成。
 */
function planFocusIntent(
  current: CanvasPresentationSnapshot,
  session: FocusTransitionSession | null,
  intent: { nodeId: string; kind: CanvasFocusKind; owner: "direct" | "history" },
  ctx: TransitionContext,
  options: { sameNodeOwnerSwitch: boolean; panel: CanvasPanelRoute | null; historyFromDirect?: boolean; preserveOverviewReturn?: boolean }
): TransitionPlan {
  if (!ctx.focusAdapterReady) {
    return reject("focus-adapter-unavailable", "model focus adapter 未注册", current);
  }
  if (!ctx.focusTargetValid(intent.nodeId, intent.kind)) {
    return reject("focus-target-invalid", ctx.focusTargetUnavailableReason?.(intent.nodeId, intent.kind) ?? "聚焦目标不可用", current);
  }
  const effects: TransitionEffect[] = [];
  const sameNode = current.mode.type === "node-focus" && current.mode.nodeId === intent.nodeId;
  const sameOwner = sameNode && current.mode.type === "node-focus" && current.mode.owner === intent.owner;

  // 与聚焦互斥的 model-node-editor panel：进入聚焦前关闭（design D5）。
  const editorPanel = current.panel?.type === "model-node-editor" ? current.panel : null;

  // 同节点同 owner：仅确保目标 panel 就位（幂等），不重复 adapter effect。
  if (sameNode && sameOwner) {
    const panel = options.panel ?? current.panel;
    if (editorPanel && panel?.type !== "model-node-editor") {
      effects.push({ type: "close-panel", panelType: "model-node-editor" });
    } else if (panel && current.panel && current.panel.type === panel.type && current.panel.nodeId !== panel.nodeId) {
      effects.push({ type: "close-panel", panelType: current.panel.type });
    }
    const nextSession = session && options.historyFromDirect !== undefined ? { ...session, historyFromDirect: options.historyFromDirect } : session;
    return ok({ mode: current.mode, panel, menu: null }, nextSession, effects);
  }

  // 同节点 owner 切换（direct <-> history）：保留同一 focus session / overview 返回目标。
  if (sameNode && options.sameNodeOwnerSwitch) {
    const nodeId = intent.nodeId;
    const kind = intent.kind;
    const currentOwner = current.mode.type === "node-focus" ? current.mode.owner : "direct";
    // 进入 history 时记录是否由 direct 打开（决定关闭历史回到 direct）。
    const historyFromDirect = options.historyFromDirect ?? session?.historyFromDirect ?? (currentOwner === "direct");
    const panel = options.panel ?? (current.panel?.type === "node-history" && current.panel.nodeId === nodeId ? current.panel : null);
    const nextSession: FocusTransitionSession = session
      ? { ...session, nodeId, historyFromDirect }
      : { nodeId, overviewReturn: { panel: null }, historyFromDirect };
    // 清理与目标 owner 不兼容的 panel：切 direct 时关闭 history；切 history 时关闭 model-node-editor。
    if (editorPanel && options.panel?.type !== "model-node-editor") {
      effects.push({ type: "close-panel", panelType: "model-node-editor" });
    } else if (current.panel && current.panel.type === "node-history" && panel?.type !== "node-history") {
      effects.push({ type: "close-panel", panelType: "node-history" });
    }
    effects.push({
      type: "apply-focus",
      target: { nodeId, kind, owner: intent.owner },
      transition:
        intent.owner === "direct"
          ? { preserveSession: true, restoreDirectCamera: true }
          : { preserveSession: true }
    });
    return ok({ mode: { type: "node-focus", nodeId, kind, owner: intent.owner }, panel, menu: null }, nextSession, effects);
  }

  // 全新进入（overview -> focus，或聚焦其它节点、文件文档 -> 节点文档）。
  // 文档 tab 切换（preserveOverviewReturn）复用当前呈现期首次进入时捕获的返回位置：本轮
  // 返回画布必须回到用户进入工作区前的 overview，而不是被中间节点的局部取景覆盖。
  const preserved = options.preserveOverviewReturn === true && session !== null ? session.overviewReturn.panel : undefined;
  const overviewReturn = { panel: preserved ?? editorPanel };
  if (editorPanel) effects.push({ type: "close-panel", panelType: "model-node-editor" });
  const nextSession: FocusTransitionSession = {
    nodeId: intent.nodeId,
    overviewReturn,
    historyFromDirect: options.historyFromDirect ?? false
  };
  effects.push({ type: "apply-focus", target: { nodeId: intent.nodeId, kind: intent.kind, owner: intent.owner }, transition: { preserveSession: false } });
  return ok(
    { mode: { type: "node-focus", nodeId: intent.nodeId, kind: intent.kind, owner: intent.owner }, panel: options.panel, menu: null },
    nextSession,
    effects
  );
}

/**
 * 计算独立文档工作区 intent 的 next snapshot + session（change: 2026-10-21，D1/D4）。
 *
 * 与节点聚焦互斥、不伪造节点：目标只带不透明 `documentId`，adapter 清除节点投影与历史
 * override。同一 documentId 的重入是幂等无操作（不重新捕获返回上下文）。文档间切换保留
 * 首次进入的 overview 返回位置。
 */
function planDocumentWorkspace(
  current: CanvasPresentationSnapshot,
  session: FocusTransitionSession | null,
  documentId: string,
  ctx: TransitionContext,
  preserveOverviewReturn: boolean
): TransitionPlan {
  if (!ctx.focusAdapterReady) {
    return reject("focus-adapter-unavailable", "model focus adapter 未注册", current);
  }
  if (!(ctx.documentTargetValid?.(documentId) ?? true)) {
    return reject("focus-target-invalid", "文档工作区不可用，请重新打开该文档", current);
  }
  // 同一文档重复激活：无操作（不重放 entrance、不覆盖返回上下文）。
  if (current.mode.type === "document-workspace" && current.mode.documentId === documentId) {
    return ok(current, session, []);
  }
  const effects: TransitionEffect[] = [];
  const editorPanel = current.panel?.type === "model-node-editor" ? current.panel : null;
  if (editorPanel) effects.push({ type: "close-panel", panelType: "model-node-editor" });
  // 节点历史 drawer 属于节点文档；切到文件文档先关闭（旧预览归属清除）。
  if (current.panel?.type === "node-history") effects.push({ type: "close-panel", panelType: "node-history" });
  const previous = current.mode.type === "document-workspace" ? session : null;
  const fromNodeFocus = current.mode.type === "node-focus";
  const overviewReturn = (preserveOverviewReturn || fromNodeFocus) && session
    ? session.overviewReturn
    : { panel: editorPanel };
  const nextSession: FocusTransitionSession = {
    // 返回上下文的 `nodeId` 是本次呈现期身份：文件文档用不透明 documentId（不伪造节点）。
    nodeId: previous?.nodeId ?? documentId,
    overviewReturn,
    historyFromDirect: false
  };
  effects.push({ type: "apply-focus", target: { kind: "document", documentId }, transition: { preserveSession: false } });
  return ok(
    { mode: { type: "document-workspace", documentId }, panel: null, menu: null },
    nextSession,
    effects
  );
}

function ok(
  snapshot: CanvasPresentationSnapshot,
  session: FocusTransitionSession | null,
  effects: TransitionEffect[]
): TransitionPlan {
  return { ok: true, snapshot, session, effects };
}

function reject(
  error: CanvasNavigationError,
  reason: string,
  current: CanvasPresentationSnapshot
): TransitionPlan {
  return { ok: false, error, reason, snapshot: current };
}

/** scope dispose 时的收敛状态。 */
export function emptyPresentation(): CanvasPresentationSnapshot {
  return EMPTY_CANVAS_PRESENTATION;
}
