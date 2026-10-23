/**
 * 提交式任务协调器（change: split-web-runtime-services，任务 6.2）。
 *
 * 与旧 `task-coordinator` 的**结构性差异**：这个类**没有**等待终态、`completeNodeRun`、
 * `failNodeRun`、`buildResultAsset` 或 `persist` 的方法。它只：
 * 1. 在浏览器侧做可读的预检（目录可用、节点存在、模型匹配、prompt 长度）——权威校验仍在
 *    Canvas/Task 服务端；
 * 2. 调 `POST /api/canvases/:id/runs` 提交；
 * 3. 返回「已受理」，不等待 worker 终态、不写结果。
 *
 * 结果由服务端 projector 写入权威 Y.Doc 后经 Yjs 广播到达，前端只**观察**派生状态。
 * 因此「请求返回后页面即可关闭」「终态只由服务端写入」是结构性保证。
 */
import type { CanvasTaskCatalog, CanvasTaskModelType } from "@woohaa3/contracts";
import { CANVAS_TASK_LIMITS, APP_THEME_DEFAULT_TOKENS, freezeShotImageReferences, readyShotImageAsset, shotImageMappingsMatch, catalogModelBindings, type FrozenShotImageReference } from "@woohaa3/contracts";
import type { ExecutionLaunchEvent, ExecutionOrigin } from "./execution-launch.js";
import type { Woohaa3CanvasStoreState } from "../../services/canvas-state/index.js";
import type { CanvasRunRequest, CanvasRunResult } from "../../contracts.js";
import type {
  TaskActivityFinishedLocalRejection,
  TaskActivityStarted
} from "../../events/task-activity.js";

/** run/cancel 能力（由 Canvas Remote adapter 实现）。 */
export type CanvasRunClient = {
  run(request: CanvasRunRequest): Promise<CanvasRunResult>;
  cancel(input: { nodeId: string; runId: string }): Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * 提交协调器的 typed 事件出口（change: formalize-frontend-event-bus，design D6）。
 *
 * 协调器保持纯逻辑、不 import 全局 Context；Plugin 把两个 callback 接到 `ctx.emit` 的两个
 * catalog 字面量。Task Activity 缺失时 Cordis emission 无 listener，提交行为不变。
 */
export type TaskActivityEventSink = {
  launch?(event: ExecutionLaunchEvent): void;
  started(payload: TaskActivityStarted): void;
  localRejected(payload: TaskActivityFinishedLocalRejection): void;
};

/** 只需要能读当前画布这一小撮能力。 */
export type SubmitCanvasReader = Pick<Woohaa3CanvasStoreState, "canvas"> & {
  getState: () => Pick<Woohaa3CanvasStoreState, "canvas">;
};

export type SubmitCoordinatorOptions = {
  store: { getState: () => Pick<Woohaa3CanvasStoreState, "canvas"> };
  client: CanvasRunClient;
  /** 任务活动 typed 事件出口（optional；缺失时行为不变）。 */
  activity?: TaskActivityEventSink;
  /** 判断一次网关拒绝是否属于「等待镜头参考」等可自动续交状态。 */
  isWaiting?: (error: string) => boolean;
  imageReferenceBackground?: () => string;
  isWritable?: () => boolean;
  now?: () => string;
  createRunId?: () => string;
};

export type SubmitInput = {
  origin?: ExecutionOrigin;
  nodeId: string;
  modelKey: string;
  prompt: string;
  parameters: Record<string, unknown>;
  catalog: CanvasTaskCatalog;
  /** 该节点的期望模型类型（由面板 kind 推导）。 */
  expectedModelType: CanvasTaskModelType;
};

export type SubmitOutcome =
  | { ok: true; runId: string; jobId: string }
  | { ok: false; error: string; /** 属于「等待镜头参考」等可自动续交状态。 */ waiting?: boolean };

export type SubmitCoordinator = {
  submit(input: SubmitInput): Promise<SubmitOutcome>;
  cancel(input: { nodeId: string; runId: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * 画布/版本变化后重试等待中的提交（每个节点至多续交一次，成功后出队）。
   * 供插件在权威画布更新（例如镜头参考录制完成并冻结）后调用。
   */
  retryWaiting(): Promise<readonly SubmitOutcome[]>;
  /** 当前等待续交的节点 id。 */
  pendingWaiting(): readonly string[];
  subscribeWaiting?: (listener: () => void) => () => void;
  waitingMessage?: (nodeId: string) => string | null | undefined;
};

export function createSubmitCoordinator(options: SubmitCoordinatorOptions): SubmitCoordinator {
  const createRunId = options.createRunId ?? defaultRunId;
  type PendingInput = SubmitInput & { imageReferences?: FrozenShotImageReference[]; canvasId?: string };
  const waiting = new Map<string, PendingInput>();
  const submitting = new Set<string>();
  const waitingMessages = new Map<string, string | null>();
  const waitingListeners = new Set<() => void>();
  const message = (nodeId: string, value: string | null) => {
    if (waitingMessages.get(nodeId) === value) return;
    waitingMessages.set(nodeId, value); waitingListeners.forEach(listener => listener());
  };

  const attempt = async (input: PendingInput): Promise<SubmitOutcome> => {
    const canvas = options.store.getState().canvas;
    if (!canvas) return { ok: false, error: "画布尚未加载，无法提交任务" };
    if (options.isWritable?.() === false) return { ok: false, error: "shot-image-permission-denied: 画布当前不可写，请恢复连接后重新执行" };

    if (!input.catalog.available) {
      return { ok: false, error: input.catalog.reason ?? "任务目录不可用" };
    }
    const node = canvas.document.nodes.find((entry) => entry.id === input.nodeId);
    if (!node) return { ok: false, error: "节点已不存在，任务未提交" };
    const model = input.catalog.models.find((entry) => entry.modelKey === input.modelKey);
    if (!model) return { ok: false, error: `模型 ${input.modelKey} 不可用于该节点` };
    if (model.modelType !== input.expectedModelType) {
      return { ok: false, error: `模型 ${input.modelKey} 类型与节点不匹配` };
    }
    if (input.prompt.trim().length === 0) return { ok: false, error: "请先输入提示词" };
    if (input.prompt.length > CANVAS_TASK_LIMITS.promptMaxChars) {
      return { ok: false, error: `提示词超过 ${CANVAS_TASK_LIMITS.promptMaxChars} 字上限` };
    }
    if (input.canvasId && input.canvasId !== canvas.id) return { ok: false, error: "画布已切换，图片参考等待已取消" };
    if (!input.imageReferences) {
      const frozen = freezeShotImageReferences(canvas, input.nodeId, options.imageReferenceBackground?.() ?? APP_THEME_DEFAULT_TOKENS.webSubtle);
      if (typeof frozen === "string") return { ok: false, error: frozen };
      input = { ...input, parameters: structuredClone(input.parameters), canvasId: canvas.id, imageReferences: frozen };
    }
    const images = input.imageReferences ?? [];
    if (!shotImageMappingsMatch(canvas, input.nodeId, images)) return { ok: false, error: "输入连接已变化，请重新执行" };
    if (images.length) {
      const current = freezeShotImageReferences(canvas, input.nodeId, options.imageReferenceBackground?.() ?? APP_THEME_DEFAULT_TOKENS.webSubtle);
      if (typeof current === "string") return { ok: false, error: current };
      if (!catalogModelBindings(model).some(binding => binding.roles.includes("reference_image") && binding.mediaKinds.includes("image") && binding.mediaTypes.includes("image/png"))) {
        return { ok: false, error: "所选模型不接受图片参考（image/png）" };
      }
      for (const ref of images) {
        if (readyShotImageAsset(canvas.assets, ref)) continue;
        if (!current.some(candidate => candidate.slotId === ref.slotId && candidate.contentIdentity === ref.contentIdentity && candidate.profileKey === ref.profileKey)) {
          return { ok: false, error: "shot-image-version-stale: 图片参考版本已失效，请重新执行" };
        }
        waiting.set(input.nodeId, input);
        message(input.nodeId, "等待镜头参考图片准备完成");
        return { ok: false, error: "等待镜头参考图片准备完成", waiting: true };
      }
    }

    const runId = createRunId();
    message(input.nodeId, null);
    const jobId = `job-${runId}`;
    const now = options.now ?? (() => new Date().toISOString());
    const launch = (phase: ExecutionLaunchEvent["phase"]) => {
      try { if (input.origin) options.activity?.launch?.({ phase, origin: input.origin, nodeId: input.nodeId, operationId: runId }); }
      catch { /* Feedback cannot block or rewrite a submission. */ }
    };
    launch("started");
    // 提交即显示：在请求开始前抛出 started 事件（design D3/D6）。
    options.activity?.started({
      runId,
      jobId,
      nodeId: input.nodeId,
      state: "queued",
      modelType: model.modelType,
      modelKey: input.modelKey,
      createdAt: now()
    });
    const result = await options.client.run({
      nodeId: input.nodeId,
      runId,
      jobId,
      modelKey: input.modelKey,
      prompt: input.prompt,
      parameters: input.parameters,
      ...(images.length ? { shotImageReferences: images } : {})
    }).catch(() => ({ ok: false as const, error: "提交失败，请检查连接后重试" }));
    if (!result.ok) {
      launch("rejected");
      // 网关在接受前拒绝：抛出 local-rejection finished，不写 canonical 成功状态。
      options.activity?.localRejected({
        source: "local-rejection",
        activity: {
          runId,
          jobId,
          nodeId: input.nodeId,
          state: "failed",
          error: { message: result.error },
          updatedAt: now()
        }
      });
      const isWaiting = options.isWaiting?.(result.error) ?? false;
      if (isWaiting) waiting.set(input.nodeId, { ...input, origin: undefined });
      return { ok: false, error: result.error, ...(isWaiting ? { waiting: true } : {}) };
    }
    waiting.delete(input.nodeId);
    launch("accepted");
    return { ok: true, runId: result.runId, jobId: result.jobId };
  };

  return {
    async submit(input) {
      const imageInput = options.store.getState().canvas?.nodeData[input.nodeId]?.inputMapping?.some(mapping => mapping.role === "shot_image_reference");
      if (imageInput && submitting.has(input.nodeId)) return { ok: false, error: "任务正在提交" };
      if (imageInput) submitting.add(input.nodeId);
      waiting.delete(input.nodeId);
      try {
        const outcome = await attempt(input);
        message(input.nodeId, outcome.ok ? null : outcome.error);
        return outcome;
      } finally { if (imageInput) submitting.delete(input.nodeId); }
    },
    async retryWaiting() {
      const outcomes: SubmitOutcome[] = [];
      for (const [nodeId, input] of [...waiting.entries()]) {
        if (submitting.has(nodeId)) continue;
        submitting.add(nodeId);
        try {
          const outcome = await attempt(input);
          outcomes.push(outcome);
          if (!(outcome.ok === false && outcome.waiting)) waiting.delete(nodeId);
          message(nodeId, outcome.ok ? null : outcome.error);
        } finally {
          submitting.delete(nodeId);
        }
      }
      return outcomes;
    },
    pendingWaiting() {
      return [...waiting.keys()];
    },
    subscribeWaiting(listener) { waitingListeners.add(listener); return () => { waitingListeners.delete(listener); }; },
    waitingMessage(nodeId) { return waitingMessages.get(nodeId); },
    cancel(input) {
      waiting.delete(input.nodeId);
      message(input.nodeId, null);
      return options.client.cancel(input);
    }
  };
}

function defaultRunId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `run-${random}`;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 该协调器**没有**的写入口（结构性保证，供静态检查断言）。 */
export const SUBMIT_COORDINATOR_FORBIDDEN_METHODS = [
  "completeNodeRun",
  "failNodeRun",
  "buildResultAsset",
  "persist",
  "runToTerminal"
] as const;
