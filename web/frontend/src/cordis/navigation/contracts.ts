/**
 * Canvas presentation navigation 契约
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 1.2 / design D2/D3）。
 *
 * 只承载稳定 presentation identity 与经过校验的轻量 payload：当前 mode、至多一个 panel
 * route、至多一个 menu route。规范画布、selection 集合、任务状态、Dialog stack、表单草稿
 * 与 Bevy 状态都**不**进入这里。
 */
import type { ComponentType } from "react";

/**
 * 可聚焦节点内容种类（design D1：统一 image/video/model focus identity）。
 *
 * `"extension"`：通用纯模型扩展节点（如 `composite-asset`）聚焦到的**扩展工作区**，工作区覆盖层由
 * extension 经 `canvas.overlay` 贡献；宿主只提供通用导航/呈现（change: 2026-10-10-add-game-furnace-extension）。
 */
export type CanvasFocusKind = "image" | "video" | "model" | "extension";

/**
 * 独立 PhotoCraft 文档的轻量 presentation identity
 * （change: 2026-10-21-add-photocraft-document-workspace，design D1/D4）。
 *
 * 只带不透明文档 id；**不**伪造画布节点、不携带字节/草稿/取景。完整文档列表与实例仍归
 * 编辑 feature。它与其他 focus 互斥，同一时刻只有一个活动呈现。
 */
export type CanvasDocumentPresentation = { documentId: string };

/** 画布 presentation mode。 */
export type CanvasMode =
  | { type: "overview" }
  /**
   * 统一节点聚焦（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D1）。
   *
   * `kind` 区分图片与模型；`owner=direct` 表示中央为可编辑当前内容/草稿，
   * `owner=history` 表示由节点历史打开的只读旧版本。历史 drawer 是否打开与 owner 无关。
   */
  | { type: "node-focus"; nodeId: string; kind: CanvasFocusKind; owner: "direct" | "history" }
  /**
   * 独立文档工作区呈现（change: 2026-10-21-add-photocraft-document-workspace，design D1/D4）。
   *
   * 与 `node-focus` 互斥：文件文档没有画布节点身份，也不操纵底层画布。`documentId` 是不透明
   * 文档 identity，由编辑 feature 分配与解释；navigation 只保存它用于原子切换。
   */
  | { type: "document-workspace"; documentId: string };

/** 任何聚焦呈现（节点聚焦或独立文档工作区）。 */
export type CanvasFocusMode = Extract<CanvasMode, { type: "node-focus" } | { type: "document-workspace" }>;

/** 当前 mode 是否为聚焦呈现。 */
export function isFocusMode(mode: CanvasMode): mode is CanvasFocusMode {
  return mode.type === "node-focus" || mode.type === "document-workspace";
}

/** 聚焦呈现的节点身份；独立文档工作区（或未聚焦）返回 null。 */
export function focusedNodeId(mode: CanvasMode): string | null {
  return mode.type === "node-focus" ? mode.nodeId : null;
}

/** 聚焦呈现的文档身份；节点聚焦返回 null（节点文档由编辑 feature 自行派生）。 */
export function focusedDocumentId(mode: CanvasMode): string | null {
  return mode.type === "document-workspace" ? mode.documentId : null;
}

/**
 * 执行面板的轻量 presentation（change: 2026-09-28-align-execution-reference-and-expansion，design D5）。
 *
 * `compact` 与 `expanded` 是同一 panel route 的两种受控呈现，不是两个 panel，也不进入
 * Dialog stack。host 渲染 fullscreen 时仍复用同一 nodeId 与 draft。
 */
export type ExecutionPanelPresentation = "compact" | "expanded";

/**
 * 面板 route：只带稳定 nodeId、类型与有限 presentation（不复制 prompt/参数/草稿）。
 *
 * `agent-conversation` 是 Agent 对话详情的**唯一展开状态源**（change:
 * 2026-10-12-add-agent-conversation-panel，design D6a）：只带稳定会话/回合与适用领域运行身份，
 * 不复制消息/事件/工具输出。默认不产生本 route；只有用户明确点击详情动作才打开。
 */
export type CanvasPanelRoute =
  | { type: "node-execution"; nodeId: string; presentation?: ExecutionPanelPresentation }
  | { type: "model-node-editor"; nodeId: string }
  | { type: "node-history"; nodeId: string }
  | {
      type: "agent-conversation";
      conversationId: string;
      requestId: string;
      /** 来源生成面板节点（合法返回目标）；历史/活动入口可为空。 */
      nodeId?: string;
      /** 显式领域运行关联（打开确切运行，不按 nodeId 跳到最近会话）。 */
      runId?: string;
      taskId?: string;
    };

export type CanvasPanelType = CanvasPanelRoute["type"];

/** 菜单 route：屏幕坐标用于定位，世界坐标用于插入。 */
export type CanvasMenuRoute = {
  type: "canvas-context";
  nodeId: string | null;
  screen: { x: number; y: number };
  world: { x: number; y: number };
  connectFrom?: { nodeId: string; nodeType: string };
};

export type CanvasMenuType = CanvasMenuRoute["type"];

export type CanvasPresentationSnapshot = {
  mode: CanvasMode;
  panel: CanvasPanelRoute | null;
  menu: CanvasMenuRoute | null;
};

// ---------------------------------------------------------------------------
// Panel route helpers（change: 2026-09-28-align-execution-reference-and-expansion）
// ---------------------------------------------------------------------------

/**
 * 规范化 panel route：执行面板缺省为 `compact`；其它 panel 不含 presentation 字段。
 *
 * 每次写进 snapshot 的 route 都经过本函数，保证「同 identity」比较不受字段缺省影响。
 */
export function normalizeCanvasPanelRoute(route: CanvasPanelRoute): CanvasPanelRoute {
  if (route.type === "node-execution") {
    return { type: "node-execution", nodeId: route.nodeId, presentation: route.presentation ?? "compact" };
  }
  return route;
}

/**
 * 两个 panel 是否同一 panel identity（type + nodeId）。
 *
 * identity **不包含** presentation：compact↔expanded 是同一 panel 的呈现替换，不应触发
 * close cleanup（不销毁 prompt/picker/draft）。也不包含 prompt、参数、chosen model 或 draft。
 */
export function sameCanvasPanelIdentity(a: CanvasPanelRoute | null, b: CanvasPanelRoute | null): boolean {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  if (a.type === "agent-conversation" && b.type === "agent-conversation") {
    // 详情身份由确切会话/回合决定；同节点不同运行是不同 panel，不视为同一呈现替换。
    return a.conversationId === b.conversationId && a.requestId === b.requestId;
  }
  return a.nodeId === b.nodeId;
}

export const EMPTY_CANVAS_PRESENTATION: CanvasPresentationSnapshot = {
  mode: { type: "overview" },
  panel: null,
  menu: null
};

// ---------------------------------------------------------------------------
// Intent（Feature 只能通过 intent 请求，不能直接改 snapshot）
// ---------------------------------------------------------------------------

export type CanvasNavigationIntent =
  | { type: "open-panel"; route: CanvasPanelRoute }
  | { type: "close-panel"; panelType?: CanvasPanelType }
  | { type: "open-menu"; route: CanvasMenuRoute }
  | { type: "close-menu" }
  /** 进入/切换统一节点聚焦（image/model + direct/history owner）。 */
  | {
      type: "enter-node-focus";
      nodeId: string;
      kind: CanvasFocusKind;
      owner: "direct" | "history";
      /**
       * 复用当前呈现期已捕获的 overview 返回上下文。
       *
       * 文档工作区的 tab 切换（节点↔节点、节点↔文件）不覆盖首次进入时记录的返回位置
       * （change: 2026-10-21-add-photocraft-document-workspace，D4）。从 overview 首次进入或
       * 显式跨节点跳转保持缺省 false（重新捕获用户当前位置）。
       */
      preserveOverviewReturn?: boolean;
    }
  /**
   * 进入/切换独立文档工作区呈现（change: 2026-10-21-add-photocraft-document-workspace，D1/D4）。
   *
   * 与节点聚焦互斥且不伪造节点；同一 `documentId` 的重入为无操作，不重新捕获返回上下文。
   */
  | { type: "enter-document-workspace"; documentId: string; preserveOverviewReturn?: boolean }
  | { type: "exit-node-focus" }
  /** 复合：进入/复用聚焦 + 打开 node-history panel（图片/模型历史）。 */
  | { type: "open-node-history"; nodeId: string; kind: CanvasFocusKind }
  /** 复合：关闭聚焦历史：从 direct 进入的恢复 direct，从 overview 进入的退出并恢复 entry panel。 */
  | { type: "close-node-history" }
  /** runtime 报告聚焦目标/projection 失效：原子收敛到 overview 并丢弃返回目标。 */
  | { type: "invalidate-node-focus"; reason?: string }
  | { type: "clear-transient-surfaces" }
  /** scope dispose：收敛到空 presentation（不恢复隐藏 panel/focus owner）。 */
  | { type: "reset-presentation" }
  /** 节点失效回收：只清理引用已失效 nodeId 的 panel/menu；聚焦目标失效时退出并丢弃返回目标。 */
  | { type: "reconcile"; validNodeIds: ReadonlySet<string> };

/** 稳定 transition 错误码。 */
export type CanvasNavigationError =
  | "panel-definition-unavailable"
  | "menu-definition-unavailable"
  | "focus-adapter-unavailable"
  | "focus-target-invalid"
  | "panel-cleanup-failed"
  | "not-allowed";

export type CanvasNavigationResult =
  | { ok: true; snapshot: CanvasPresentationSnapshot }
  | { ok: false; error: CanvasNavigationError; reason: string; snapshot: CanvasPresentationSnapshot };

/**
 * 受控异步模态打开结果（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.1）。
 *
 * `stale` 表示请求在等待结算期间失去了合法性（换画布/聚焦变更/协调器被释放），调用方 MUST NOT
 * 重试或据此改页面；`not-allowed` 表示用户取消或结算失败，现场保留。
 */
export type CanvasModalOpenResult =
  | { ok: true }
  | { ok: false; code: "not-allowed" | "stale" | "dialog-unavailable"; reason: string };

// ---------------------------------------------------------------------------
// Focus transition session（design D1；store-private，可丢弃）
// ---------------------------------------------------------------------------

/**
 * 一次 focus transition 的可丢弃返回上下文。
 *
 * - `nodeId`：节点聚焦的目标节点；独立文档工作区为编辑 feature 分配的不透明文档 identity。
 * - `overviewReturn.panel`：首次从 overview 进入 focus 前可恢复的 `model-node-editor` route
 *   （普通返回/Escape 恢复；Dialog/target 失效丢弃）。
 * - `historyFromDirect`：当前 history owner 是否由 direct focus 打开（决定关闭历史回到 direct）。
 *
 * 只保存稳定 presentation identity；**不**包含 viewport、相机矩阵、gesture、controller 内容
 * 或规范 Canvas 数据，也不写入 URL/Y.Doc/IndexedDB/Task History。
 */
export type FocusTransitionSession = {
  nodeId: string;
  overviewReturn: { panel: CanvasPanelRoute | null };
  historyFromDirect: boolean;
};

// ---------------------------------------------------------------------------
// Definition registry 与 adapter（task 1.2 / design D2）
// ---------------------------------------------------------------------------

export type CanvasPanelDefinition = {
  type: CanvasPanelType;
  owner: string;
  /** 校验 route payload；返回 false 时 transition 被拒绝。 */
  validate?: (route: CanvasPanelRoute) => boolean;
  /**
   * 聚焦态呈现（可选，change: 2026-10-12-add-agent-conversation-panel，design D6a）。
   *
   * `sidebar` 表示该 panel 在 `node-focus` 时占用**公共聚焦侧栏容器**（与工作区检查器共用
   * 同一栏、互斥，不额外并列一栏）；缺省只在 overview 由 `CanvasPanelHost` 渲染。
   */
  focusPresentation?: "sidebar";
  /** 面板渲染器。 */
  render: ComponentType<CanvasPanelRenderProps>;
};

export type CanvasPanelRenderProps = {
  route: CanvasPanelRoute;
  writable: boolean;
};

export type CanvasMenuDefinition = {
  type: CanvasMenuType;
  owner: string;
  render: ComponentType<CanvasMenuRenderProps>;
};

export type CanvasMenuRenderProps = {
  route: CanvasMenuRoute;
  writable: boolean;
};

/** 节点聚焦目标（有 nodeId）。 */
export type CanvasNodeFocusTarget = { kind: CanvasFocusKind; nodeId: string; owner: "direct" | "history" };

/** 独立文件文档聚焦目标（无节点身份）。 */
export type CanvasDocumentFocusTarget = { kind: "document"; documentId: string };

/** adapter 接收的完整聚焦目标（design D2）：`null` 表示未聚焦。 */
export type CanvasFocusTarget = CanvasNodeFocusTarget | CanvasDocumentFocusTarget;

/** 是否为节点聚焦目标。 */
export function isNodeFocusTarget(target: CanvasFocusTarget | null): target is CanvasNodeFocusTarget {
  return target !== null && target.kind !== "document";
}

/** 是否为独立文件文档目标。 */
export function isDocumentFocusTarget(target: CanvasFocusTarget | null): target is CanvasDocumentFocusTarget {
  return target !== null && target.kind === "document";
}

/**
 * 一次 focus target transition 的上下文（design D2/D4）。
 *
 * - `preserveSession`：owner 切换保持同一 overview 返回上下文（进入/退出忽略该标志）。
 * - `restoreDirectCamera`：history -> direct 时恢复进入 history 前的 direct 主观察相机。
 */
export type CanvasFocusTransition = {
  preserveSession: boolean;
  restoreDirectCamera?: boolean;
};

export type CanvasLayoutAdapter = {
  /**
   * 应用完整 from/to 聚焦目标。`null` 退出聚焦并恢复进入前 overview。owner 变化（即使
   * nodeId 相同）必须到达这里；失败时不得留下与 snapshot 不一致的 owner/projection。
   *
   * 独立文档工作区的目标为 `{ kind: "document" }`：adapter 只清除节点投影与历史 override，
   * 不为文件文档伪造画布节点（change: 2026-10-21-add-photocraft-document-workspace，D4）。
   */
  apply: (
    target: CanvasFocusTarget | null,
    transition: CanvasFocusTransition
  ) => { ok: true } | { ok: false; reason: string };
  /** 是否仍有合法聚焦目标（用于 reconcile）。 */
  isFocused: () => boolean;
  isTargetValid?: (nodeId: string, kind: CanvasFocusKind) => boolean;
  targetUnavailableReason?: (nodeId: string, kind: CanvasFocusKind) => string | null;
  /** 独立文档呈现目标是否合法（缺省视为合法；由编辑 feature 注入）。 */
  isDocumentTargetValid?: (documentId: string) => boolean;
  /** 聚焦只读模式（历史 owner）。 */
  mode?: () => "edit" | "history";
};

/** Panel/menu owner 在关闭时注册的 cleanup（取消本地 session / input scope）。 */
export type CanvasSurfaceCleanup = () => void;

export interface CanvasNavigationService {
  getSnapshot(): CanvasPresentationSnapshot;
  subscribe(listener: () => void): () => void;
  /** 串行 transition 入口。 */
  dispatch(intent: CanvasNavigationIntent): CanvasNavigationResult;

  // 便捷 facade（等价于 dispatch）。
  openPanel(route: CanvasPanelRoute): CanvasNavigationResult;
  closePanel(panelType?: CanvasPanelType): CanvasNavigationResult;
  openMenu(route: CanvasMenuRoute): CanvasNavigationResult;
  closeMenu(): CanvasNavigationResult;
  enterNodeFocus(input: { nodeId: string; kind: CanvasFocusKind; owner?: "direct" | "history"; preserveOverviewReturn?: boolean }): CanvasNavigationResult;
  /** 进入/切换独立文档工作区呈现（不伪造节点；同一 documentId 重入为无操作）。 */
  enterDocumentWorkspace(documentId: string, options?: { preserveOverviewReturn?: boolean }): CanvasNavigationResult;
  exitNodeFocus(): CanvasNavigationResult;
  openNodeHistory(input: { nodeId: string; kind: CanvasFocusKind }): CanvasNavigationResult;
  closeNodeHistory(): CanvasNavigationResult;
  invalidateNodeFocus(reason?: string): CanvasNavigationResult;
  clearTransientSurfaces(): CanvasNavigationResult;
  resetPresentation(): CanvasNavigationResult;
  reconcile(validNodeIds: ReadonlySet<string>): CanvasNavigationResult;
  /**
   * Dialog facade（design D4）：把打开请求交给 Dialog Service；Dialog 入栈前由
   * pre-commit participant 清理 menu/panel。
   */
  openDialog(request: { dialogId: string; payload?: unknown }): { ok: boolean; error?: string };

  /**
   * 受控异步模态打开（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.1）。
   *
   * 与 `openDialog` 的区别：先经聚焦编辑结算（dirty focus 由用户决定保存/放弃，取消或失败
   * 则不入栈也不清理现场），再打开 Dialog。请求串行处理，并校验原 canvas/focus generation：
   * 等待期间切换画布、聚焦目标或 exit coordinator 状态改变时，迟到结果一律丢弃。
   */
  requestOpenDialog(request: {
    dialogId: string;
    payload?: unknown;
    /** 发起时的画布身份（可选；用于迟到结果隔离）。 */
    canvasId?: string | null;
  }): Promise<CanvasModalOpenResult>;

  /**
   * 请求受控退出聚焦（change: 图片聚焦编辑，design D7）
   * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
   *
   * 先经退出协调器异步结算净变化，成功后再 dispatch `exit-node-focus`；失败保留现场。
   * 无净变化时同步可逆退出。重复请求合并。
   */
  requestExitNodeFocus(): Promise<CanvasNavigationResult>;
  requestEnterNodeFocus(input: { nodeId: string; kind: CanvasFocusKind; owner?: "direct" | "history"; preserveOverviewReturn?: boolean }): Promise<CanvasNavigationResult>;
  /** 请求进入独立文档工作区呈现（先结算当前聚焦的净变化，再原子发布）。 */
  requestEnterDocumentWorkspace(documentId: string, options?: { preserveOverviewReturn?: boolean }): Promise<CanvasNavigationResult>;
  requestOpenNodeHistory(input: { nodeId: string; kind: CanvasFocusKind }): Promise<CanvasNavigationResult>;

  /** 取消聚焦历史：先复制返回意图，由退出协调器接管。 */
  requestCloseNodeHistory(): Promise<CanvasNavigationResult>;

  // registry（返回 disposer；重复 type/owner 抛错）。
  registerPanel(definition: CanvasPanelDefinition): () => void;
  registerMenu(definition: CanvasMenuDefinition): () => void;
  /** 解析当前注册的 panel/menu definition（供 Host 渲染）。 */
  resolvePanel(type: string): CanvasPanelDefinition | null;
  resolveMenu(type: string): CanvasMenuDefinition | null;
  /**
   * route 对应的 definition 是否已注册且通过 payload 校验
   * （change: 2026-09-28-align-execution-reference-and-expansion，task 1.3）。
   */
  panelAvailable(route: CanvasPanelRoute): boolean;
  /** 注册 panel/menu owner 的 surface cleanup；返回 disposer。 */
  registerCleanup(key: string, cleanup: CanvasSurfaceCleanup): () => void;
  /** 注册 mode effect adapter（canvas-runtime）。 */
  setFocusAdapter(adapter: CanvasLayoutAdapter): () => void;

  /** 诊断。 */
  getDiagnostic(): string | null;
}
