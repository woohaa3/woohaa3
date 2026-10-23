import { assistantInputController } from "@woohaa3/frontend/extension-api";
/**
 * 「转为片场」动作控制器：唯一任务发起/状态来源
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.5/3.8 / design D1/D5）。
 *
 * 横条按钮、右键菜单与聚焦标题栏共用**同一个**控制器实例：每个来源节点一份**固定身份**
 * （sourceNodeId + requestId + targetNodeId），因此三个入口不会产生不同目标或重复请求。
 * 控制器只保存就近呈现所需的**瞬态**（进行中/失败/成功提示与草稿），权威事实始终来自服务端
 * 状态接口；不缓存也不伪造第二份任务状态，后台完成不抢焦点。
 *
 * 非 React、可单元测试：视图（action.tsx）只读取快照并调用方法。
 */
import type {
  FilmSetConversionModelCandidate,
  FilmSetConversionSettings,
  FilmSetConversionSourceKind,
  FilmSetConversionStatus,
  FilmSetConversionRequest,
  ServerCanvas
} from "@woohaa3/contracts";
import {
  buildFilmSetConversionRequest,
  createFilmSetConversionIdentity,
  type FilmSetConversionClient,
  type FilmSetConversionIdentity
} from "./client.js";
import { defaultFilmSetConversionPrompt, readFilmSetConversionNodeStatus } from "@woohaa3/contracts";
import { resolveFilmSetConversionPreferredModelKey } from "./presentation.js";
import { filmSetConversionNeedsSettings } from "./view.js";
import type { FilmSetConversionPreferenceStore } from "./preference.js";

/** 单个来源节点的瞬态动作状态（不是权威任务状态）。 */
export type FilmSetConversionEntry = {
  nodeId: string;
  nodeType: string;
  identity: FilmSetConversionIdentity | null;
  status: FilmSetConversionStatus | null;
  busy: boolean;
  pending?: boolean;
  error: string | null;
  models: readonly FilmSetConversionModelCandidate[];
  modelsLoaded: boolean;
  /** 本来源上次提交的设置；跨来源偏好只保存模型。 */
  saved: FilmSetConversionSettings;
  /** 创建弹窗是否打开，以及当前来源的草稿。 */
  settingsOpen: boolean;
  draft: FilmSetConversionSettings;
  /** 当前身份绑定的**规范设置 key**；设置变化时必须换取新身份（避免同 ID 不同输入被拒）。 */
  boundSettingsKey: string | null;
  /**
   * 当前身份是否已被服务端**拒绝且未登记**（提交在创建占位片场前失败，如未配置模型）。
   *
   * 这类失败不会写入 `status`（仍是 `null`），因此仅靠终态判断会误判为可复用，导致再次提交命中
   * 旧身份却因服务端无记录/占位已删除而「没反应」。置位后必须换新身份（一次新的转换）。
   */
  attemptClosed: boolean;
};

export type FilmSetConversionControllerOptions = {
  canvasId: string;
  getDataScopeId?: () => string | null;
  client: FilmSetConversionClient;
  preferences: FilmSetConversionPreferenceStore;
  getCanvas: () => ServerCanvas | null;
  /** 当前会话是否可写（菜单/聚焦入口无 writable prop 时读取）。 */
  isWritable: () => boolean;
  openFilmSet?: (nodeId: string) => void;
  /** 三个入口统一打开宿主 Dialog，控制器只拥有草稿。 */
  openCreationDialog?: (input: { nodeId: string; nodeType: string }) => void;
};

const EMPTY_MODELS: readonly FilmSetConversionModelCandidate[] = [];

/** 视图默认条目（无瞬态前）：纯读取用途偏好，不在渲染期写控制器状态。 */
export function defaultFilmSetConversionEntry(nodeId: string, nodeType: string, saved: FilmSetConversionSettings): FilmSetConversionEntry {
  const draft = filmSetConversionNeedsSettings(nodeType)
    ? { ...saved, instruction: saved.instruction ?? defaultFilmSetConversionPrompt(nodeType as FilmSetConversionSourceKind) }
    : saved;
  return {
    nodeId, nodeType, identity: null, status: null, busy: false, error: null,
    models: EMPTY_MODELS, modelsLoaded: false, saved, settingsOpen: false, draft, boundSettingsKey: null, attemptClosed: false
  };
}

export function createFilmSetConversionController(options: FilmSetConversionControllerOptions) {
  const entries = new Map<string, FilmSetConversionEntry>();
  const listeners = new Set<() => void>();
  const observedRequests = new Set<string>();
  const modelLoads = new Map<string, number>();
  // 快照对象只在发布时更换引用，保证 useSyncExternalStore 读取稳定（渲染期无副作用）。
  let snapshot: { entries: ReadonlyMap<string, FilmSetConversionEntry> } = { entries };
  let dataScope = options.getDataScopeId?.() ?? "page";
  let scopeVersion = 0;
  const syncScope = () => {
    const next = options.getDataScopeId?.() ?? "page";
    if (next === dataScope) return;
    dataScope = next; scopeVersion++;
    entries.clear(); observedRequests.clear(); modelLoads.clear();
    snapshot = { entries: new Map() };
  };
  const currentScope = (version: number) => { syncScope(); return version === scopeVersion; };

  const publish = (nodeId: string, patch: Partial<FilmSetConversionEntry>): void => {
    const current = entries.get(nodeId);
    if (!current) return;
    entries.set(nodeId, { ...current, ...patch });
    snapshot = { entries: new Map(entries) };
    for (const listener of listeners) listener();
  };

  const entryFor = (nodeId: string, nodeType: string): FilmSetConversionEntry => {
    syncScope();
    const existing = entries.get(nodeId);
    if (existing) return existing;
    const preference = options.preferences.read();
    const created = defaultFilmSetConversionEntry(nodeId, nodeType, preference.modelKey ? { modelKey: preference.modelKey } : {});
    entries.set(nodeId, created);
    snapshot = { entries: new Map(entries) };
    return created;
  };

  const loadModels = async (nodeId: string): Promise<readonly FilmSetConversionModelCandidate[]> => {
    syncScope();
    const scope = scopeVersion;
    const generation = (modelLoads.get(nodeId) ?? 0) + 1;
    modelLoads.set(nodeId, generation);
    try {
      const result = await options.client.models();
      const models = result.ok ? result.value.models : EMPTY_MODELS;
      if (currentScope(scope) && modelLoads.get(nodeId) === generation) publish(nodeId, { models, modelsLoaded: true, error: result.ok ? null : result.error });
      return models;
    } catch (failure) {
      if (currentScope(scope) && modelLoads.get(nodeId) === generation) publish(nodeId, { models: EMPTY_MODELS, modelsLoaded: true, error: failure instanceof Error ? failure.message : "模型加载失败，请重试" });
      return EMPTY_MODELS;
    }
  };

  const statusForSource = (nodeId: string): FilmSetConversionStatus | null => {
    syncScope();
    const entry = entries.get(nodeId);
    const canvas = options.getCanvas();
    let own: FilmSetConversionStatus | null = null;
    for (const node of canvas?.document.nodes ?? []) {
      const status = readFilmSetConversionNodeStatus(canvas?.nodeData[node.id]);
      if (!status || status.sourceNodeId !== nodeId) continue;
      observedRequests.add(status.requestId);
      if (status.status === "running" || status.status === "unknown") return status;
      if (status.requestId === entry?.identity?.requestId) own = status;
    }
    if (own) return own;
    return entry?.status && !observedRequests.has(entry.status.requestId) ? entry.status : null;
  };

  /**
   * 主动发起新一次转换：固定**新的** requestId，并记录本次规范设置的稳定 key（幂等身份绑定输入）。
   * 丢弃上一终态的呈现；失败重试走 `retry`，未知走 `query`。
   */
  /** 规范设置的稳定 key（与 `buildFilmSetConversionRequest` 相同的省略规则，保证与服务端 hash 一致）。 */
  const settingsKey = (settings: FilmSetConversionSettings): string => JSON.stringify([
    settings.connection ?? null, settings.reasoningEffort ?? null,
    settings.modelKey ?? null,
    settings.instruction && settings.instruction.trim() !== "" ? settings.instruction : null,
    settings.range ? [settings.range.startSeconds, settings.range.endSeconds] : null
  ]);

  /**
   * 设置草稿的**可见预选**：无显式模型时预置推荐候选（见 `resolveFilmSetConversionPreferredModelKey`），
   * 使用户在弹窗里直接点「创建片场」就有可用模型，而不是以空选择提交后被拒。已有显式选择时不变。
   */
  const withPreferredModel = (
    draft: FilmSetConversionSettings,
    models: readonly FilmSetConversionModelCandidate[],
    nodeType: string
  ): FilmSetConversionSettings => {
    if (draft.modelKey) return draft;
    const modelKey = resolveFilmSetConversionPreferredModelKey({ models, sourceKind: nodeType as FilmSetConversionSourceKind });
    return modelKey ? { ...draft, modelKey } : draft;
  };

  /**
   * 提交一次转换。`mode`：
   * - `"reuse"`：复用当前身份（同一动作内的重试/继续，例如未知后重提交）；仍要求该身份未被
   *   服务端拒绝且未登记（`attemptClosed === false`）；
   * - `"new"`：固定新身份（终态后主动再点、或输入变化）。
   *
   * 幂等身份绑定**规范输入**：若本次设置与当前身份绑定的设置不同（用户改了设置后再次开始），
   * 必须使用新身份，否则服务端会以 `request-id-reused` 拒绝（同一 requestId 不同输入）。
   *
   * 返回是否**已被接受**：`false` 表示未创建占位片场的提交前失败（如未配置模型、来源无效），
   * 调用方可据此保持设置弹窗打开并就地显示原因，而不是静默关闭（「没反应」）。占位片场已创建
   * 的任务级失败（`status: "failed"`）返回 `true`——失败呈现在目标节点上，不占用源节点弹窗。
   */
  const sharedInput = (nodeId: string) => assistantInputController<FilmSetConversionRequest, FilmSetConversionStatus>(options.client, {
    dataScopeId: options.getDataScopeId?.() ?? "page", canvasId: options.canvasId, nodeId, purpose: "film-set-conversion",
  });
  const port = {
    async submit(request: FilmSetConversionRequest, requestId: string) {
      const result = await options.client.submit({ ...request, requestId });
      if (result.ok) return { kind: "accepted" as const, value: result.status };
      return { kind: ["network", "unavailable", "timeout", "transport-error", "storage-failed"].includes(result.code) ? "unknown" as const : "rejected" as const, message: result.error };
    },
    async query(request: FilmSetConversionRequest, requestId: string) {
      const result = await options.client.status({ canvasId: request.canvasId, requestId });
      if (!result.ok || !result.value.status) return { kind: "unknown" as const, message: result.ok ? "\u8bf7\u6c42\u5c1a\u672a\u786e\u8ba4\uff0c\u8bf7\u6838\u5bf9\u539f\u8bf7\u6c42" : result.error };
      if (result.value.status.requestId !== requestId || result.value.status.sourceNodeId !== request.sourceNodeId ||
        (result.value.status.execution && result.value.status.execution.targetNodeId !== request.targetNodeId)) return { kind: "unknown" as const, message: "返回的任务身份与原请求不符" };
      return { kind: "accepted" as const, value: result.value.status };
    },
  };
  const submit = async (entry: FilmSetConversionEntry, settings: FilmSetConversionSettings, _mode: "reuse" | "new" = "reuse"): Promise<boolean> => {
    syncScope();
    const scope = scopeVersion;
    const input = sharedInput(entry.nodeId);
    const previous = input.getSnapshot().pending;
    const identity = previous ? { sourceNodeId: previous.input.sourceNodeId, sourceKind: previous.input.sourceKind, targetNodeId: previous.input.targetNodeId, requestId: previous.requestId }
      : createFilmSetConversionIdentity({ sourceNodeId: entry.nodeId, sourceKind: entry.nodeType as FilmSetConversionSourceKind });
    const request = previous?.input ?? buildFilmSetConversionRequest({ canvasId: options.canvasId, identity, settings });
    const pending = input.submit(request, port);
    const frozen = input.getSnapshot().pending;
    publish(entry.nodeId, { busy: true, error: null, pending: true, identity: { ...identity, requestId: frozen?.requestId ?? identity.requestId }, boundSettingsKey: settingsKey(settings), attemptClosed: false });
    const result = await pending;
    if (!currentScope(scope)) return false;
    publish(entry.nodeId, { busy: false, pending: Boolean(input.getSnapshot().pending), error: input.getSnapshot().notice,
      ...(result?.kind === "accepted" ? { status: result.value, settingsOpen: false, attemptClosed: false } : { attemptClosed: result?.kind === "rejected" }) });
    return result?.kind === "accepted";
  };

  /** 打开创建弹窗（内部）：标记瞬态、预置推荐模型并确保模型候选已加载。 */
  const openSettings = (input: { nodeId: string; nodeType: string }): void => {
    const entry = entryFor(input.nodeId, input.nodeType);
    for (const [nodeId, other] of entries) {
      if (nodeId !== input.nodeId && other.settingsOpen) publish(nodeId, { settingsOpen: false });
    }
    publish(input.nodeId, { settingsOpen: true, error: null, draft: withPreferredModel(entry.draft, entry.models, input.nodeType) });
    if (filmSetConversionNeedsSettings(input.nodeType)) {
      publish(input.nodeId, { modelsLoaded: false });
      void loadModels(input.nodeId).then((models) => {
        const current = entries.get(input.nodeId);
        if (!current || !current.settingsOpen || current.draft.modelKey || current.models !== models) return;
        publish(input.nodeId, { draft: withPreferredModel(current.draft, models, input.nodeType) });
      });
    }
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getEntry(nodeId: string, nodeType: string): FilmSetConversionEntry {
      return entryFor(nodeId, nodeType);
    },
    /** 稳定快照（useSyncExternalStore 用）：引用只在发布时更换。 */
    getSnapshot(): { entries: ReadonlyMap<string, FilmSetConversionEntry> } {
      syncScope();
      return snapshot;
    },
    /**
     * 主按钮：图片/视频每次先打开创建弹窗；3D 保持直接复制。
     *
     * `requestSettings` 由宿主在命中主按钮时注入（横条模式下宿主持有设置弹窗的唯一渲染器）；
     * 聚焦标题栏等自渲染入口缺省时退回本控制器自己的 `settingsOpen` 瞬态。
     */
    async activate(input: { nodeId: string; nodeType: string; writable: boolean; requestSettings?: () => void }): Promise<void> {
      const entry = entryFor(input.nodeId, input.nodeType);
      if (entry.busy || !input.writable || !options.isWritable()) return;
      // 进行中：不重复推理；结果未知：先查询核对，不自动重跑（design D5）。
      if (!filmSetConversionNeedsSettings(input.nodeType)) {
        const accepted = await submit(entryFor(input.nodeId, input.nodeType), {}, entry.identity ? "new" : "reuse");
        const status = entries.get(input.nodeId)?.status;
        // 3D 复制在本次点击内完成；立即定位结果，避免结果在视野外或重叠时看起来毫无响应。
        // 图片/视频的后台生成仍不抢焦点；旧 owner 的迟到回执由 submit 拒绝。
        if (accepted && status?.status === "completed") options.openFilmSet?.(status.targetNodeId);
        return;
      }
      openSettings(input);
      if (options.openCreationDialog) options.openCreationDialog(input);
      else input.requestSettings?.();
    },
    async refreshModels(input: { nodeId: string; nodeType: string }): Promise<void> {
      const entry = entryFor(input.nodeId, input.nodeType);
      publish(input.nodeId, { modelsLoaded: false, error: null });
      const models = await loadModels(input.nodeId);
      const current = entries.get(input.nodeId);
      if (current && current.models === models && !current.draft.modelKey) publish(input.nodeId, { draft: withPreferredModel(current.draft, models, entry.nodeType) });
    },
    openSettings(input: { nodeId: string; nodeType: string }): void {
      openSettings(input);
    },
    /** 关闭弹窗保留本来源草稿，不写回跨来源偏好。 */
    closeSettings(input: { nodeId: string; nodeType: string }): void {
      publish(input.nodeId, { settingsOpen: false });
    },
    setDraft(input: { nodeId: string; nodeType: string; draft: FilmSetConversionSettings }): void {
      entryFor(input.nodeId, input.nodeType);
      publish(input.nodeId, { draft: input.draft });
    },
    /**
     * 「创建片场」：冻结本来源草稿，只共享模型偏好，然后提交本次。
     *
     * 终态（成功/失败/取消）后再点是一次**新转换**（新 requestId）：否则会复用旧身份命中服务端
     * 幂等回执，若占位片场已被删除就表现为「没反应」（design D5）。
     * 返回本次是否已被接受，供弹窗决定是否关闭并就地显示失败原因。
     */
    async startFromSettings(input: { nodeId: string; nodeType: string }): Promise<boolean> {
      const entry = entryFor(input.nodeId, input.nodeType);
      if (entry.busy || !options.isWritable()) return false;
      const draft = withPreferredModel(entry.draft, entry.models, input.nodeType);
      const saved: FilmSetConversionSettings = {
        ...(draft.connection ? { connection: draft.connection } : {}),
        ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
        ...(draft.modelKey ? { modelKey: draft.modelKey } : {}),
        ...(draft.instruction?.trim() ? { instruction: draft.instruction } : {})
      };
      if (!saved.instruction) delete saved.instruction;
      options.preferences.write({ modelKey: saved.modelKey });
      publish(input.nodeId, { saved, draft: saved });
      return submit(entryFor(input.nodeId, input.nodeType), saved, entry.identity ? "new" : "reuse");
    },
    async queryCreation(input: { nodeId: string }): Promise<boolean> {
      syncScope();
      const scope = scopeVersion;
      const controller = sharedInput(input.nodeId);
      const result = await controller.query(port);
      if (!currentScope(scope)) return false;
      publish(input.nodeId, { busy: false, pending: Boolean(controller.getSnapshot().pending), error: controller.getSnapshot().notice,
        ...(result?.kind === "accepted" ? { status: result.value, settingsOpen: false } : {}) });
      return result?.kind === "accepted";
    },
    async cancel(input: { nodeId: string }): Promise<void> {
      syncScope();
      const scope = scopeVersion;
      const entry = entries.get(input.nodeId);
      if (!entry?.identity) return;
      const result = await options.client.cancel({ canvasId: options.canvasId, requestId: entry.identity.requestId });
      if (!currentScope(scope)) return;
      if (result.ok) publish(input.nodeId, { status: result.value.status });
    },
    /**
     * 占位片场节点上的恢复动作（design D4）：按**持久 requestId**操作，不依赖源节点的瞬态条目，
     * 因此刷新/切换画布后从目标节点仍可重试/查询/取消。权威状态仍以节点 nodeData 为准。
     */
    async retryRequest(input: { requestId: string }): Promise<{ ok: boolean; error?: string }> {
      const result = await options.client.retry({ canvasId: options.canvasId, requestId: input.requestId });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    async queryRequest(input: { requestId: string }): Promise<{ ok: boolean; error?: string }> {
      const result = await options.client.status({ canvasId: options.canvasId, requestId: input.requestId });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    async cancelRequest(input: { requestId: string }): Promise<{ ok: boolean; error?: string }> {
      const result = await options.client.cancel({ canvasId: options.canvasId, requestId: input.requestId });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    async retry(input: { nodeId: string }): Promise<void> {
      syncScope();
      const scope = scopeVersion;
      const entry = entries.get(input.nodeId);
      if (!entry?.identity) return;
      publish(input.nodeId, { busy: true, error: null });
      const result = await options.client.retry({ canvasId: options.canvasId, requestId: entry.identity.requestId });
      if (!currentScope(scope)) return;
      if (result.ok) publish(input.nodeId, { busy: false, status: result.status, attemptClosed: false });
      else publish(input.nodeId, { busy: false, error: result.error, attemptClosed: true });
    },
    /** unknown 先查询核对，不自动重跑。 */
    async query(input: { nodeId: string }): Promise<void> {
      syncScope();
      const scope = scopeVersion;
      const entry = entries.get(input.nodeId);
      if (!entry?.identity) return;
      const result = await options.client.status({ canvasId: options.canvasId, requestId: entry.identity.requestId });
      if (!currentScope(scope)) return;
      if (result.ok) publish(input.nodeId, { status: result.value.status });
    },
    openFilmSet(nodeId: string): void {
      options.openFilmSet?.(nodeId);
    },
    state: { getCanvas: options.getCanvas, isWritable: options.isWritable, canvasId: options.canvasId, statusForSource }
  };
}

export type FilmSetConversionController = ReturnType<typeof createFilmSetConversionController>;
