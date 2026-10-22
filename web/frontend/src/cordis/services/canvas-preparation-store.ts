/**
 * 首次打开准备 store（单 owner 轮询）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.5 / design D4、D5）。
 *
 * App scope 的准备态读模型：来源目录缓存、prepare 显式触发、status 轮询。所有异步结果经
 * `requestSerial` + `disposed` 双重隔离：切换画布/dispose 后迟到响应不再发布，过期 scope 的
 * 轮询被 abort。
 *
 * 轮询由单个内部 AbortController 拥有（单 owner）；每次 `observe`/`prepare` 开始前 abort 上一次，
 * 保证同一时刻只有一个在途轮询。
 */
import type {
  CanvasPreparationRemote,
  CanvasPreparationService,
  CanvasPreparationState
} from "../contract/canvas-preparation.js";
import type { PreparationState } from "@woohaa3/contracts";

export type CanvasPreparationStoreOptions = {
  remote: CanvasPreparationRemote;
  /** 轮询上限（避免无限轮询；达到上限转 failed）。测试可注入小值。 */
  maxPollAttempts?: number;
  /** 测试注入：等待 pollAfterMs（缺省 setTimeout）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const CANVAS_PREPARATION_MAX_POLL_ATTEMPTS = 600;

export class CanvasPreparationStore implements CanvasPreparationService {
  private readonly remote: CanvasPreparationRemote;
  private readonly maxPollAttempts: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly listeners = new Set<() => void>();
  private state: CanvasPreparationState;
  private requestSerial = 0;
  private disposed = false;
  private activePoll: AbortController | null = null;
  private sourcesLoaded = false;

  constructor(options: CanvasPreparationStoreOptions) {
    this.remote = options.remote;
    this.maxPollAttempts = options.maxPollAttempts ?? CANVAS_PREPARATION_MAX_POLL_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
    this.state = initialPreparationState();
  }

  getState = (): CanvasPreparationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async listSources(force = false): Promise<void> {
    if (!force && this.sourcesLoaded) return;
    const serial = this.requestSerial;
    const result = await this.remote.listSources();
    if (this.isStale(serial)) return;
    if (!result.ok) {
      this.patch({ error: result.error });
      return;
    }
    this.sourcesLoaded = true;
    this.patch({ sources: result.sources, error: null });
  }

  async listAccessible(input: { sourceId: string; cursor: string | null; limit?: number }): Promise<{
    items: import("@woohaa3/contracts").SourceCanvasSummary[];
    nextCursor: string | null;
  }> {
    const result = await this.remote.listAccessible(input);
    if (!result.ok) throw new Error(result.error);
    return { items: result.page.items, nextCursor: result.page.nextCursor };
  }

  /**
   * 显式准备：POST prepare（幂等）后**后台**轮询；本方法在 POST 返回后立即 resolve，
   * 由订阅者观察 `preparing`→`ready`。需要阻塞等待结论时用 `observe`。
   */
  async prepare(input: { canvasId: string; sourceId?: string }): Promise<void> {
    const serial = ++this.requestSerial;
    this.patch({
      status: "loading",
      canvasId: input.canvasId,
      jobId: null,
      phase: null,
      completedMedia: 0,
      totalMedia: 0,
      error: null,
      code: null,
      retryable: true
    });
    const result = await this.remote.prepare(input);
    if (this.isStale(serial)) return;
    if (!result.ok) {
      this.patch({ status: "failed", error: result.error, code: result.code });
      return;
    }
    this.applyState(result.state);
    if (result.state.state === "preparing") {
      // 后台轮询；结果经订阅发布（dispose/切换后由 serial 隔离）。
      void this.runPoll(input.canvasId, serial, this.newPollController());
    }
  }

  async observe(input: { canvasId: string; signal?: AbortSignal }): Promise<PreparationState> {
    const serial = ++this.requestSerial;
    const controller = this.newPollController(input.signal);
    const initial = await this.step(input.canvasId, serial, controller.signal);
    if (!initial) return { state: "deleted", code: "DELETED" };
    this.applyState(initial);
    if (initial.state !== "preparing") return initial;
    return (await this.runPoll(input.canvasId, serial, controller)) ?? initial;
  }

  dispose(): void {
    this.disposed = true;
    this.requestSerial += 1;
    this.activePoll?.abort();
    this.activePoll = null;
    this.state = initialPreparationState();
    this.listeners.clear();
  }

  /** 轮询直到结论态 / 超限 / stale / abort；返回结论态（未收敛返回 null）。 */
  private async runPoll(canvasId: string, serial: number, controller: AbortController): Promise<PreparationState | null> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      try {
        await this.sleep(this.state.pollAfterMs, controller.signal);
      } catch {
        return null;
      }
      if (this.isStale(serial) || controller.signal.aborted) return null;
      const next = await this.step(canvasId, serial, controller.signal);
      if (!next) return null;
      this.applyState(next);
      if (next.state !== "preparing") return next;
    }
    const exhausted: PreparationState = { state: "failed", code: "SOURCE_UNAVAILABLE", retryable: true, message: "准备超时" };
    this.applyState(exhausted);
    return exhausted;
  }

  /** 单次 status 请求；stale/aborted 返回 null（不发布）。 */
  private async step(canvasId: string, serial: number, signal: AbortSignal): Promise<PreparationState | null> {
    if (this.isStale(serial) || signal.aborted) return null;
    const result = await this.remote.status(canvasId);
    if (this.isStale(serial) || signal.aborted) return null;
    if (!result.ok) return { state: "failed", code: result.code, retryable: true, message: result.error };
    return result.state;
  }

  private newPollController(external?: AbortSignal): AbortController {
    const controller = new AbortController();
    this.activePoll?.abort();
    this.activePoll = controller;
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller;
  }

  private applyState(state: PreparationState): void {
    switch (state.state) {
      case "ready":
        this.patch({ status: "ready", canvasId: state.canvasId, jobId: null, error: null, code: null });
        return;
      case "preparing":
        this.patch({
          status: "preparing",
          jobId: state.jobId,
          phase: state.phase,
          completedMedia: state.completedMedia,
          totalMedia: state.totalMedia,
          pollAfterMs: state.pollAfterMs,
          error: null,
          code: null
        });
        return;
      case "failed":
        this.patch({ status: "failed", error: state.message, code: state.code, retryable: state.retryable });
        return;
      case "deleted":
        this.patch({ status: "deleted", error: null, code: "DELETED", retryable: false });
        return;
    }
  }

  private patch(patch: Partial<CanvasPreparationState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private isStale(serial: number): boolean {
    return this.disposed || serial !== this.requestSerial;
  }
}

export function initialPreparationState(): CanvasPreparationState {
  return {
    status: "idle",
    canvasId: null,
    jobId: null,
    phase: null,
    completedMedia: 0,
    totalMedia: 0,
    pollAfterMs: 1_500,
    error: null,
    code: null,
    retryable: true,
    sources: []
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
