/**
 * Canvas Navigation Service
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 3.1–3.3 / design D2/D3/D5；
 *   change: 2026-09-28-fix-model-focus-navigation-and-camera-parity，task 1.3/2.1–2.4）。
 *
 * 画布 presentation identity（mode / panel / menu）的唯一权威状态源与 transition 入口。
 * 通过 definition registry + focus adapter 与既有 owner 协作；transition 串行化（重入时排队），
 * 保证快速 open/close 与迟到结果不覆盖较新的 route。
 *
 * 另持有 store-private、可丢弃的 `FocusTransitionSession`（overview 返回 panel / history 来源），
 * 不进入公开业务状态、URL、Y.Doc 或 Task History。
 */
import {
  EMPTY_CANVAS_PRESENTATION,
  isFocusMode,
  type CanvasFocusKind,
  type CanvasFocusTarget,
  type CanvasLayoutAdapter,
  type CanvasMenuDefinition,
  type CanvasMenuRoute,
  type CanvasModalOpenResult,
  type CanvasMode,
  type CanvasNavigationIntent,
  type CanvasNavigationResult,
  type CanvasNavigationService,
  type CanvasPanelDefinition,
  type CanvasPanelRoute,
  type CanvasPresentationSnapshot,
  type CanvasSurfaceCleanup,
  type FocusTransitionSession
} from "./contracts.js";
import { planTransition, type TransitionEffect } from "./transition.js";

/**
 * 聚焦呈现身份是否变化（递增 focus epoch，用于迟到结果隔离）。
 *
 * 节点文档切换、节点↔文件文档切换、进入/退出聚焦都算；只开关 panel/menu 不算。
 */
function affectsFocusEpoch(before: CanvasMode, after: CanvasMode): boolean {
  if (before.type !== after.type) return true;
  if (before.type === "node-focus" && after.type === "node-focus") {
    return before.nodeId !== after.nodeId || before.kind !== after.kind;
  }
  if (before.type === "document-workspace" && after.type === "document-workspace") {
    return before.documentId !== after.documentId;
  }
  return false;
}

export type CanvasNavigationOptions = {
  /** 聚焦目标合法性（缺省由 adapter.isTargetValid 提供，再否则视为合法）。 */
  isFocusTargetValid?: (nodeId: string, kind: CanvasFocusKind) => boolean;
  /** Dialog facade：把请求交给 Dialog Service（design D4）。 */
  openDialog?: (request: { dialogId: string; payload?: unknown }) => { ok: boolean; error?: string };
  /** 退出协调前置（change: 图片聚焦编辑，design D7）：返回失败保留现场。 */
  prepareExit?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * 活动操作门禁（change: 2026-10-21-add-photocraft-document-workspace，D3/D4）。
   *
   * 文档切换/返回画布前同步校验：当前文档仍有活动笔迹或未确认草稿时返回原因，transition
   * 被拒绝且现场保留。缺省表示无门禁。
   */
  focusSwitchGate?: () => string | null;
  /** 当前画布身份（受控异步模态打开用于迟到结果隔离；缺省视为未知）。 */
  canvasIdentity?: () => string | null;
  /** 是否有未结算的聚焦编辑（同步查询；受控异步模态打开据此决定是否先结算）。 */
  hasUnsavedChanges?: () => boolean;
};

export class CanvasNavigationStore implements CanvasNavigationService {
  private snapshot: CanvasPresentationSnapshot = EMPTY_CANVAS_PRESENTATION;
  /** store-private、可丢弃的 focus 返回上下文（design D1）。 */
  private focusSession: FocusTransitionSession | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly panels = new Map<string, CanvasPanelDefinition>();
  private readonly menus = new Map<string, CanvasMenuDefinition>();
  private readonly cleanups = new Map<string, CanvasSurfaceCleanup>();
  private focusAdapter: CanvasLayoutAdapter | null = null;
  private diagnostic: string | null = null;
  /** 重入保护：transition 执行期间再次 dispatch 会排队串行执行。 */
  private transitioning = false;
  private pending: CanvasNavigationIntent[] = [];
  private requestQueue: Promise<unknown> = Promise.resolve();
  private focusEpoch = 0;
  private readonly entryGuards = new Map<string, (input: { nodeId: string; kind: CanvasFocusKind; owner: "direct" | "history"; preserveOverviewReturn?: boolean }) => string | null>();

  registerNodeFocusGuard(id: string, guard: (input: { nodeId: string; kind: CanvasFocusKind; owner: "direct" | "history"; preserveOverviewReturn?: boolean }) => string | null): () => void {
    if (this.entryGuards.has(id)) throw new Error(`Duplicate node focus guard: ${id}`);
    this.entryGuards.set(id, guard);
    return () => { if (this.entryGuards.get(id) === guard) this.entryGuards.delete(id); };
  }

  private entryGuardFor(intent: CanvasNavigationIntent): string | null {
    if (intent.type !== "enter-node-focus") return null;
    const mode = this.snapshot.mode;
    if (mode.type === "node-focus" && mode.nodeId === intent.nodeId && mode.kind === intent.kind && mode.owner === intent.owner) return null;
    for (const guard of this.entryGuards.values()) {
      const reason = guard(intent);
      if (reason) return reason;
    }
    return null;
  }

  constructor(private readonly options: CanvasNavigationOptions = {}) {}

  getSnapshot = (): CanvasPresentationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getDiagnostic = (): string | null => this.diagnostic;

  // --- registry -----------------------------------------------------------

  registerPanel(definition: CanvasPanelDefinition): () => void {
    const key = `${definition.owner}:${definition.type}`;
    if (this.panels.has(key)) {
      throw new Error(`panel ${definition.type} 已被 ${definition.owner} 注册`);
    }
    this.panels.set(key, definition);
    return () => {
      if (this.panels.get(key) === definition) this.panels.delete(key);
    };
  }

  registerMenu(definition: CanvasMenuDefinition): () => void {
    const key = `${definition.owner}:${definition.type}`;
    if (this.menus.has(key)) {
      throw new Error(`menu ${definition.type} 已被 ${definition.owner} 注册`);
    }
    this.menus.set(key, definition);
    return () => {
      if (this.menus.get(key) === definition) this.menus.delete(key);
    };
  }

  registerCleanup(key: string, cleanup: CanvasSurfaceCleanup): () => void {
    this.cleanups.set(key, cleanup);
    return () => {
      if (this.cleanups.get(key) === cleanup) this.cleanups.delete(key);
    };
  }

  setFocusAdapter(adapter: CanvasLayoutAdapter): () => void {
    this.focusAdapter = adapter;
    return () => {
      if (this.focusAdapter === adapter) this.focusAdapter = null;
    };
  }

  /** 供 Host 解析当前 route 对应的渲染器。 */
  resolvePanel(type: string): CanvasPanelDefinition | null {
    for (const definition of this.panels.values()) {
      if (definition.type === type) return definition;
    }
    return null;
  }

  /**
   * route 对应的 definition 是否可用（已注册且通过 payload 校验）。
   * （change: 2026-09-28-align-execution-reference-and-expansion，task 1.3）
   */
  panelAvailable(route: CanvasPanelRoute): boolean {
    const definition = this.resolvePanel(route.type);
    if (!definition) return false;
    return definition.validate ? definition.validate(route) : true;
  }

  resolveMenu(type: string): CanvasMenuDefinition | null {
    for (const definition of this.menus.values()) {
      if (definition.type === type) return definition;
    }
    return null;
  }

  // --- transition ---------------------------------------------------------

  dispatch = (intent: CanvasNavigationIntent): CanvasNavigationResult => {
    if (this.transitioning) {
      // 重入：排队，返回当前 snapshot（迟到结果不覆盖较新 route）。
      this.pending.push(intent);
      return { ok: true, snapshot: this.snapshot };
    }
    this.transitioning = true;
    let result: CanvasNavigationResult;
    try {
      result = this.applyIntent(intent);
    } finally {
      this.transitioning = false;
    }
    // 结算排队 intent（串行）。
    while (this.pending.length > 0) {
      const next = this.pending.shift()!;
      const queued = this.applyIntent(next);
      if (queued.ok) result = queued;
    }
    return result;
  };

  private applyIntent(intent: CanvasNavigationIntent): CanvasNavigationResult {
    // 活动操作门禁（change: 2026-10-21-add-photocraft-document-workspace，D3）：切换或退出聚焦前
    // 拒绝仍在进行的笔迹与未确认草稿，现场与活动 tab 保留；同一呈现身份的幂等重入不受影响。
    const gate = this.entryGuardFor(intent) ?? this.switchGateFor(intent);
    if (gate) {
      this.diagnostic = gate;
      for (const listener of this.listeners) listener();
      return { ok: false, error: "not-allowed", reason: gate, snapshot: this.snapshot };
    }
    const plan = planTransition(this.snapshot, this.focusSession, intent, {
      panelAvailable: (route) => this.panelAvailable(route),
      menuAvailable: (type) => this.resolveMenu(type) !== null,
      focusAdapterReady: this.focusAdapter !== null,
      focusTargetValid: (nodeId, kind) =>
        this.options.isFocusTargetValid?.(nodeId, kind) ?? this.focusAdapter?.isTargetValid?.(nodeId, kind) ?? true,
      focusRuntimeFocused: () => this.focusAdapter?.isFocused() ?? true,
      focusTargetUnavailableReason: (nodeId, kind) => this.focusAdapter?.targetUnavailableReason?.(nodeId, kind) ?? null,
      documentTargetValid: (documentId) => this.focusAdapter?.isDocumentTargetValid?.(documentId) ?? true
    });

    if (!plan.ok) {
      this.diagnostic = plan.reason;
      for (const listener of this.listeners) listener();
      return plan;
    }

    const applied = this.runEffects(plan.effects);
    if (!applied.ok) {
      this.diagnostic = applied.reason;
      for (const listener of this.listeners) listener();
      // 副作用失败：不发布半状态；回到最后一个完整 snapshot 与 session。
      return { ok: false, error: "panel-cleanup-failed", reason: applied.reason, snapshot: this.snapshot };
    }
    this.diagnostic = intent.type === "invalidate-node-focus" ? intent.reason ?? null : null;
    // close 类副作用执行后统一运行 owner cleanup（幂等）。
    if (affectsFocusEpoch(this.snapshot.mode, plan.snapshot.mode)) this.focusEpoch++;
    this.focusSession = plan.session;
    this.publish(plan.snapshot);
    return { ok: true, snapshot: plan.snapshot };
  }

  /**
   * 当前 intent 是否要离开/替换现有活动呈现，且存在未结束的活动操作。
   *
   * 只对真正改变呈现身份的 intent 生效：重复激活同一文档、或只开关 panel/menu 时不拦。
   */
  private switchGateFor(intent: CanvasNavigationIntent): string | null {
    const gate = this.options.focusSwitchGate?.() ?? null;
    if (!gate) return null;
    const mode = this.snapshot.mode;
    if (!isFocusMode(mode)) return null;
    switch (intent.type) {
      case "enter-node-focus":
        if (mode.type === "node-focus" && mode.nodeId === intent.nodeId && mode.kind === intent.kind) return null;
        return gate;
      case "enter-document-workspace":
        if (mode.type === "document-workspace" && mode.documentId === intent.documentId) return null;
        return gate;
      case "exit-node-focus":
      case "invalidate-node-focus":
      case "close-node-history":
      case "reset-presentation":
        return gate;
      case "open-panel":
        // 打开与聚焦互斥的编辑面板同样离开当前呈现。
        return intent.route.type === "model-node-editor" ? gate : null;
      default:
        return null;
    }
  }

  private runEffects(effects: readonly TransitionEffect[]): { ok: true } | { ok: false; reason: string } {
    // 先执行 close cleanup（release input/session），再执行 focus apply，保证顺序确定。
    if (effects.some((effect) => effect.type === "close-panel" || effect.type === "close-menu")) {
      this.runCleanups();
    }
    for (const effect of effects) {
      try {
        if (effect.type === "apply-focus") {
          const applied = this.focusAdapter?.apply(effect.target as CanvasFocusTarget | null, effect.transition);
          if (applied && !applied.ok) return { ok: false, reason: `focus-apply-failed: ${applied.reason}` };
        }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: true };
  }

  private runCleanups(): void {
    for (const cleanup of this.cleanups.values()) {
      try {
        cleanup();
      } catch {
        // cleanup 失败不影响 transition 收敛；owner 自身负责幂等。
      }
    }
  }

  private publish(next: CanvasPresentationSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  // --- convenience --------------------------------------------------------

  openPanel(route: CanvasPanelRoute): CanvasNavigationResult {
    return this.dispatch({ type: "open-panel", route });
  }
  closePanel(panelType?: CanvasPanelRoute["type"]): CanvasNavigationResult {
    return this.dispatch({ type: "close-panel", ...(panelType ? { panelType } : {}) });
  }
  openMenu(route: CanvasMenuRoute): CanvasNavigationResult {
    return this.dispatch({ type: "open-menu", route });
  }
  closeMenu(): CanvasNavigationResult {
    return this.dispatch({ type: "close-menu" });
  }
  enterNodeFocus(input: { nodeId: string; kind: CanvasFocusKind; owner?: "direct" | "history"; preserveOverviewReturn?: boolean }): CanvasNavigationResult {
    return this.dispatch({ type: "enter-node-focus", nodeId: input.nodeId, kind: input.kind, owner: input.owner ?? "direct", ...(input.preserveOverviewReturn ? { preserveOverviewReturn: true } : {}) });
  }
  enterDocumentWorkspace(documentId: string, options: { preserveOverviewReturn?: boolean } = {}): CanvasNavigationResult {
    return this.dispatch({ type: "enter-document-workspace", documentId, ...(options.preserveOverviewReturn ? { preserveOverviewReturn: true } : {}) });
  }
  exitNodeFocus(): CanvasNavigationResult {
    return this.dispatch({ type: "exit-node-focus" });
  }
  openNodeHistory(input: { nodeId: string; kind: CanvasFocusKind }): CanvasNavigationResult {
    return this.dispatch({ type: "open-node-history", nodeId: input.nodeId, kind: input.kind });
  }
  closeNodeHistory(): CanvasNavigationResult {
    return this.dispatch({ type: "close-node-history" });
  }
  invalidateNodeFocus(reason?: string): CanvasNavigationResult {
    return this.dispatch({ type: "invalidate-node-focus", ...(reason ? { reason } : {}) });
  }
  clearTransientSurfaces(): CanvasNavigationResult {
    return this.dispatch({ type: "clear-transient-surfaces" });
  }
  resetPresentation(): CanvasNavigationResult {
    return this.dispatch({ type: "reset-presentation" });
  }
  reconcile(validNodeIds: ReadonlySet<string>): CanvasNavigationResult {
    return this.dispatch({ type: "reconcile", validNodeIds });
  }

  openDialog(request: { dialogId: string; payload?: unknown }): { ok: boolean; error?: string } {
    return this.options.openDialog?.(request) ?? { ok: false, error: "dialog-facade-unavailable" };
  }

  /**
   * 受控异步模态打开（change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.1）。
   *
   * 与 `request(...)` 一样串行：等待期间只对**前置结算**做异步，snapshot 仍由同步 dispatch
   * 原子发布。合法性用 focus epoch + 画布身份双重复核，避免「换画布后旧请求抢新页面」。
   */
  requestOpenDialog(request: {
    dialogId: string;
    payload?: unknown;
    canvasId?: string | null;
  }): Promise<CanvasModalOpenResult> {
    const result = this.requestQueue.then(async (): Promise<CanvasModalOpenResult> => {
      const epoch = this.focusEpoch;
      const candidateCanvasId = request.canvasId ?? this.options.canvasIdentity?.() ?? null;
      const sameCanvas = () =>
        request.canvasId === undefined || (this.options.canvasIdentity?.() ?? null) === candidateCanvasId;
      if (!sameCanvas()) return { ok: false, code: "stale", reason: "画布已切换" };
      const dirty = this.options.hasUnsavedChanges?.() ?? false;
      if (dirty && this.options.prepareExit) {
        const prepared = await this.options.prepareExit();
        if (!prepared.ok) {
          return { ok: false, code: "not-allowed", reason: prepared.reason };
        }
        // 迟到结果不得抢当前画布/聚焦现场。
        if (this.focusEpoch !== epoch || !sameCanvas()) {
          return { ok: false, code: "stale", reason: "编辑现场已改变" };
        }
      }
      const opened = this.openDialog({
        dialogId: request.dialogId,
        ...(request.payload !== undefined ? { payload: request.payload } : {})
      });
      return opened.ok
        ? { ok: true }
        : { ok: false, code: "dialog-unavailable", reason: opened.error ?? "无法打开弹窗" };
    });
    this.requestQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * 受控退出聚焦：异步结算净变化后再 dispatch（change: 图片聚焦编辑，design D7）。
   * `options.prepareExit` 由 Canvas navigation plugin 注入（持有退出协调器）。
   */
  private request(intent: CanvasNavigationIntent, shouldPrepare: () => boolean, signal?: AbortSignal): Promise<CanvasNavigationResult> {
    const result = this.requestQueue.then(async () => {
      if (signal?.aborted) return { ok: false as const, error: "not-allowed" as const, reason: "已取消进入编辑器", snapshot: this.snapshot };
      const blocked = this.entryGuardFor(intent);
      if (blocked) return { ok: false as const, error: "not-allowed" as const, reason: blocked, snapshot: this.snapshot };
      const mode = this.snapshot.mode;
      const epoch = this.focusEpoch;
      if (shouldPrepare() && this.options.prepareExit) {
        const prepared = await this.options.prepareExit();
        if (!prepared.ok) return { ok: false as const, error: "not-allowed" as const, reason: prepared.reason, snapshot: this.snapshot };
        // A forced invalidation or synchronous owner switch must not be overwritten by a late result.
        const current = this.snapshot.mode;
        const sameMode = current.type === mode.type
          && (current.type !== "node-focus" || (mode.type === "node-focus" && current.nodeId === mode.nodeId && current.kind === mode.kind && current.owner === mode.owner))
          && (current.type !== "document-workspace" || (mode.type === "document-workspace" && current.documentId === mode.documentId));
        if (this.focusEpoch !== epoch || !sameMode) return { ok: false as const, error: "not-allowed" as const, reason: "聚焦目标已改变", snapshot: this.snapshot };
      }
      if (signal?.aborted) return { ok: false as const, error: "not-allowed" as const, reason: "已取消进入编辑器", snapshot: this.snapshot };
      return this.dispatch(intent);
    });
    this.requestQueue = result.catch(() => undefined);
    return result;
  }

  requestEnterNodeFocus(input: { nodeId: string; kind: CanvasFocusKind; owner?: "direct" | "history"; preserveOverviewReturn?: boolean; signal?: AbortSignal }): Promise<CanvasNavigationResult> {
    const { signal, ...target } = input;
    return this.request({ type: "enter-node-focus", ...target, owner: target.owner ?? "direct" }, () => this.isDifferentFocus(target), signal);
  }

  /**
   * 请求进入独立文档工作区呈现（change: 2026-10-21-add-photocraft-document-workspace，D4）。
   *
   * 先经退出协调器结算当前文档的净变化（由编辑 feature 决定是否需要结算），再原子发布；
   * 等待期间聚焦/画布已变化时迟到结果被丢弃。
   */
  requestEnterDocumentWorkspace(documentId: string, options: { preserveOverviewReturn?: boolean } = {}): Promise<CanvasNavigationResult> {
    const mode = this.snapshot.mode;
    const different = mode.type !== "document-workspace" || mode.documentId !== documentId;
    return this.request({ type: "enter-document-workspace", documentId, ...(options.preserveOverviewReturn ? { preserveOverviewReturn: true } : {}) }, () => different);
  }

  requestOpenNodeHistory(input: { nodeId: string; kind: CanvasFocusKind }): Promise<CanvasNavigationResult> {
    return this.request({ type: "open-node-history", ...input }, () => this.isDifferentFocus(input));
  }

  /** 聚焦身份是否与目标不同（节点或文件文档都算已聚焦）。 */
  private isDifferentFocus(input: { nodeId: string; kind: CanvasFocusKind }): boolean {
    const mode = this.snapshot.mode;
    if (mode.type === "document-workspace") return true;
    return mode.type === "node-focus" && (mode.nodeId !== input.nodeId || mode.kind !== input.kind);
  }

  requestExitNodeFocus(): Promise<CanvasNavigationResult> {
    return this.request({ type: "exit-node-focus" }, () => isFocusMode(this.snapshot.mode));
  }

  requestCloseNodeHistory(): Promise<CanvasNavigationResult> {
    return this.request({ type: "close-node-history" }, () => this.snapshot.mode.type === "node-focus" && !this.focusSession?.historyFromDirect);
  }
}
