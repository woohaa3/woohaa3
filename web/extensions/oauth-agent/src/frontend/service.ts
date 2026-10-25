/**
 * ChatGPT 授权与生成 Service（extension 前端 owner）
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.1 / design D5；由宿主
 *  `cordis/plugins/chatgpt/service.ts` 迁入）。
 *
 * 拥有授权状态、个人模型目录、按目标隔离的生成草稿/运行状态与 remote adapter。**token 从不
 * 进入此 Service、localStorage 或任何浏览器存储**（服务端以 owner 加密保存）；此 Service 只
 * 保存不可由 owner 派生的非敏感展示状态。
 *
 * 草稿按 `{canvasId, nodeId, mode}` 隔离；同一目标切换 tab 保留输入；不同节点不复用运行身份。
 */
import type { ChatGptAuthSnapshot, ChatGptGenerationMode, ChatGptGenerationReceipt, ChatGptModelView, ChatGptReasoningEffort } from "@woohaa3/contracts";
import type { ChatGptGenerationSink, ChatGptRemote } from "./remote.js";

export type ChatGptRunState =
  | { phase: "idle" }
  | { phase: "running"; progress: string; startedAt: number }
  | { phase: "succeeded"; commandId: string; llmOutput?: string }
  | { phase: "partial"; llmOutput?: string; applied: string[]; failed: Array<{ part: string; code: string; message: string }> }
  | { phase: "failed"; message: string; retryable: boolean; llmOutput?: string };

export type ChatGptTarget = { canvasId: string; nodeId: string; mode: ChatGptGenerationMode; clipId?: string; itemId?: string };

export type ChatGptReasoningSelection = ChatGptReasoningEffort | "default";

export type ChatGptSnapshotView = {
  auth: ChatGptAuthSnapshot | null;
  loading: boolean;
  error: string | null;
  models: ChatGptModelView[];
  modelsError: string | null;
  /** 账户模型目录是否已完成一次加载（区分「加载中」与「已加载但为空」）。 */
  modelsLoaded: boolean;
  /** 当前目标草稿提示词。 */
  draftPrompt: string;
  /** 当前目标选中的模型 id（缺省第一个）。 */
  selectedModel: string;
  /** 当前目标思考强度；default 表示不覆盖模型默认配置。 */
  reasoningEffort: ChatGptReasoningSelection;
  run: ChatGptRunState;
};

export type ChatGptService = {
  getSnapshot: () => ChatGptSnapshotView;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  stop: () => void;
  dispose: () => void;
  refresh: () => Promise<void>;
  /** 当前授权是否可用于生成。 */
  isReady: () => boolean;
  setTarget: (target: ChatGptTarget | null) => void;
  target: () => ChatGptTarget | null;
  setDraft: (prompt: string) => void;
  /** 选择当前目标的账户模型。 */
  setSelectedModel: (modelId: string) => void;
  setReasoningEffort: (effort: ChatGptReasoningSelection) => void;
  /** 授权：打开授权 URL（同源 popup）；由调用方提供打开实现。 */
  authorize: (open: (url: string) => void) => Promise<{ ok: boolean; error?: string }>;
  cancelAuthorization?: () => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<{ ok: boolean; error?: string }>;
  loadModels: () => Promise<void>;
  /** 发起生成；必须显式捕获目标身份，避免用户切换后被旧请求改投。 */
  generate: (input: { model: string; prompt: string; reasoningEffort?: ChatGptReasoningSelection; expectedContentHash?: string; selectedCameraId?: string }) => { requestId: string } | null;
  cancel: () => void;
  onAuthMessage: () => void;
};

export type ChatGptServiceOptions = {
  remote: ChatGptRemote;
  /** 稳定 requestId 生成器（测试注入确定性实现）。 */
  createRequestId?: () => string;
  pollIntervalMs?: number;
};

const IDLE: ChatGptRunState = { phase: "idle" };

export function createChatGptService(options: ChatGptServiceOptions): ChatGptService {
  const listeners = new Set<() => void>();
  let auth: ChatGptAuthSnapshot | null = null;
  let loading = true;
  let error: string | null = null;
  let models: ChatGptModelView[] = [];
  let modelsError: string | null = null;
  let modelsLoaded = false;
  let disposed = false;
  let authorizationEpoch = 0;
  let statusSequence = 0;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  let target: ChatGptTarget | null = null;
  const keyFor = (t: ChatGptTarget) => `${t.canvasId}\u0000${t.nodeId}\u0000${t.mode}\u0000${t.clipId ?? ""}\u0000${t.itemId ?? ""}`;
  const drafts = new Map<string, string>();
  const selectedModels = new Map<string, string>();
  const reasoningEfforts = new Map<string, ChatGptReasoningSelection>();
  const runs = new Map<string, ChatGptRunState>();
  let active: { requestId: string; target: ChatGptTarget; cancel: () => void } | null = null;

  // `useSyncExternalStore` 要求 getSnapshot 返回稳定引用：缓存快照，仅在状态变化（publish）时失效。
  let snapshotCache: ChatGptSnapshotView | null = null;
  const runFor = (t: ChatGptTarget | null): ChatGptRunState => (t ? runs.get(keyFor(t)) ?? IDLE : IDLE);
  const promptFor = (t: ChatGptTarget | null): string => (t ? drafts.get(keyFor(t)) ?? "" : "");
  const selectedModelFor = (t: ChatGptTarget | null): string => (t ? selectedModels.get(keyFor(t)) ?? "" : "");
  const reasoningEffortFor = (t: ChatGptTarget | null): ChatGptReasoningSelection => (t ? reasoningEfforts.get(keyFor(t)) ?? "default" : "default");

  const computeSnapshot = (): ChatGptSnapshotView => {
    if (snapshotCache) return snapshotCache;
    snapshotCache = {
      auth,
      loading,
      error,
      models,
      modelsError,
      modelsLoaded,
      draftPrompt: promptFor(target),
      selectedModel: selectedModelFor(target),
      reasoningEffort: reasoningEffortFor(target),
      run: runFor(target)
    };
    return snapshotCache;
  };

  const publish = () => {
    if (disposed) return;
    snapshotCache = null;
    for (const listener of listeners) listener();
  };

  let modelsLoading = false;
  const loadModels = async (): Promise<void> => {
    if (disposed || modelsLoading) return;
    modelsLoading = true;
    const epoch = authorizationEpoch;
    const result = await options.remote.fetchModels();
    modelsLoading = false;
    if (disposed || authorizationEpoch !== epoch) return;
    modelsLoaded = true;
    if (!result.ok) {
      models = [];
      modelsError = result.error;
      publish();
      return;
    }
    models = result.snapshot.models;
    modelsError = result.snapshot.error ?? null;
    publish();
  };

  const refresh = async (): Promise<void> => {
    const sequence = ++statusSequence, epoch = authorizationEpoch;
    const result = await options.remote.fetchStatus();
    if (disposed || sequence !== statusSequence || epoch !== authorizationEpoch) return;
    loading = false;
    if (!result.ok) {
      error = result.error;
      publish();
      return;
    }
    error = null;
    auth = result.snapshot;
    // 授权变为 ready 时自动加载本账户模型目录（不依赖面板挂载，刷新页面即生效）。
    if (auth.state === "ready" && models.length === 0 && !modelsLoading) {
      void loadModels();
    }
    publish();
  };

  const createRequestId = options.createRequestId ?? (() => `chatgpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  return {
    getSnapshot: computeSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (disposed || started) return;
      started = true;
      void refresh();
      timer = setInterval(() => void refresh(), options.pollIntervalMs ?? 30_000);
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    dispose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      active?.cancel();
      active = null;
      listeners.clear();
    },
    refresh,
    isReady: () => auth?.state === "ready",
    target: () => target,
    setTarget: (next) => {
      target = next;
      publish();
    },
    setDraft: (prompt) => {
      if (!target) return;
      drafts.set(keyFor(target), prompt);
      publish();
    },
    setSelectedModel: (modelId) => {
      if (!target) return;
      selectedModels.set(keyFor(target), modelId);
      publish();
    },
    setReasoningEffort: (effort) => {
      if (!target) return;
      reasoningEfforts.set(keyFor(target), effort);
      publish();
    },
    authorize: async (open) => {
      const epoch = ++authorizationEpoch;
      const result = await options.remote.startAuthorize();
      if (disposed || epoch !== authorizationEpoch) return { ok: false, error: "授权已取消" };
      if (!result.ok) return { ok: false, error: result.error };
      open(result.url);
      return { ok: true };
    },
    cancelAuthorization: async () => {
      ++authorizationEpoch;
      return await options.remote.cancelAuthorization?.() ?? { ok: false, error: "当前宿主不支持取消授权" };
    },
    disconnect: async () => {
      ++authorizationEpoch;
      const result = await options.remote.disconnect();
      if (!result.ok) return { ok: false, error: result.error };
      auth = result.snapshot;
      // 切换账户/断开：清除旧展示与草稿，避免复用旧授权身份。
      models = [];
      modelsError = null;
      modelsLoaded = false;
      // Authorization changes do not discard the user's unsent work.
      publish();
      return { ok: true };
    },
    loadModels,
    generate: (input) => {
      if (!target || !auth || auth.state !== "ready") return null;
      const captured: ChatGptTarget = { ...target };
      const reasoningEffort = input.reasoningEffort ?? reasoningEffortFor(captured);
      const requestId = createRequestId();
      const startedAt = Date.now();
      runs.set(keyFor(captured), { phase: "running", progress: "提交中…", startedAt });
      publish();
      const sink: ChatGptGenerationSink = {
        progress: (event) => {
          runs.set(keyFor(captured), { phase: "running", progress: event.stage, startedAt });
          publish();
        },
        done: (receipt) => {
          runs.set(keyFor(captured), receiptToRun(receipt));
          active = null;
          publish();
        }
      };
      const handle = options.remote.generate(
        {
          requestId,
          canvasId: captured.canvasId,
          nodeId: captured.nodeId,
          mode: captured.mode,
          ...(captured.clipId ? { clipId: captured.clipId } : {}),
          ...(captured.itemId ? { itemId: captured.itemId } : {}),
          model: input.model,
          prompt: input.prompt,
          ...(reasoningEffort === "default" ? {} : { reasoningEffort }),
          ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
          ...(input.selectedCameraId ? { selectedCameraId: input.selectedCameraId } : {})
        },
        sink
      );
      active = { requestId, target: captured, cancel: handle.cancel };
      return { requestId };
    },
    cancel: () => {
      active?.cancel();
      if (active) {
        runs.set(keyFor(active.target), { phase: "failed", message: "已取消", retryable: true });
        active = null;
        publish();
      }
    },
    onAuthMessage: () => {
      void refresh();
    }
  };
}

function receiptToRun(receipt: ChatGptGenerationReceipt): ChatGptRunState {
  switch (receipt.status) {
    case "succeeded":
      return { phase: "succeeded", commandId: receipt.commandId, llmOutput: receipt.llmOutput };
    case "partial":
      return { phase: "partial", applied: receipt.applied, failed: receipt.failed, llmOutput: receipt.llmOutput };
    case "failed":
      return { phase: "failed", message: receipt.message, retryable: true, ...(receipt.llmOutput ? { llmOutput: receipt.llmOutput } : {}) };
    case "cancelled":
      return { phase: "failed", message: "已取消", retryable: true };
    default:
      return { phase: "idle" };
  }
}
