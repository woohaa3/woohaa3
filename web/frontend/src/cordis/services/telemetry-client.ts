/**
 * 浏览器侧遥测采集客户端
 * （change: 2026-10-20-add-local-client-telemetry，任务 4.1 / design D7）。
 *
 * **硬约束：采集不得进入业务路径。** 这里的所有入口都是同步的、永不 awaits、永不抛错：
 * - `record()` 只做白名单过滤 + 入有界内存缓冲，随后立刻返回；一次失败最多让这条事实丢掉，
 *   不会让编辑/保存/同步多一次等待，也不会多一个异常路径；
 * - 投递走同源 `fetch` 并 `void` 掉 Promise：HTTP 非 2xx 与网络异常都只累加计数，
 *   **不重试、不弹错、不 console.error**（本机 intake 若不可用，说明宿主已不可用，重试无意义；
 *   重试还会在无响应的 intake 上堆积请求）；
 * - 服务可能根本不存在（插件/测试只创建画布会话时）：调用点用可选的 `TelemetryClient` 或
 *   本模块的 `activeTelemetryClient()` 解析，缺失即 no-op。遥测永远不是画布启动的前置条件。
 *
 * 事件形状与服务端归一（`normalizeTelemetryEvent`）是同一份契约：客户端只做**明显非法**的
 * 预过滤（`name`/`result`/`origin` 不在白名单）以免浪费带宽，其余字段的越界修正留给宿主。
 * 禁止项沿用 design D3：不采集 prompt、标题、文件名、画布名、URL、媒体地址等任何用户内容。
 */
import {
  TELEMETRY_LIMITS,
  isTelemetryEventName,
  isTelemetryOrigin,
  isTelemetryResult,
  type TelemetryEventInput
} from "@woohaa3/contracts";
import type { Context } from "@deepseek-ai/cordis";
import { getAppPublicFetch } from "./app-base-path.js";
import { TELEMETRY_EVENTS_PATH } from "./paths.js";
import { activeTelemetryClient, setActiveTelemetryClient } from "./telemetry-primitives.js";
import { appBuildVersion } from "./build-info.js";

export { activeTelemetryClient, setTelemetryClientForTesting, stableTelemetryErrorCode, telemetryNow } from "./telemetry-primitives.js";

/**
 * 客户端侧边界（与契约的 `TELEMETRY_LIMITS` 互补）。
 *
 * `TELEMETRY_LIMITS.maxBatchEvents` 是**协议**上限（一次请求最多 100 条），必须读契约；
 * 这里的 512/32/5s 是**本机**采集策略，只影响缓冲与投递节奏，不进契约。
 */
export const TELEMETRY_CLIENT_LIMITS = {
  /** 有界内存缓冲；满则丢最旧。 */
  bufferEvents: 512,
  /** 达到该条数立即投递（不必等定时器）。 */
  flushThreshold: 32,
  /** 定时投递间隔。 */
  flushIntervalMs: 5_000,
  /** 单批上限（契约值）。 */
  maxBatchEvents: TELEMETRY_LIMITS.maxBatchEvents
} as const;

export type TelemetryClientStatus = {
  /** 仍在内存缓冲里、尚未投递的事件数。 */
  queued: number;
  /** 缓冲满丢掉的条数。 */
  droppedOverflow: number;
  /** 明显非法（不在白名单）而丢掉的条数。 */
  droppedInvalid: number;
  /** 投递失败（HTTP 非 2xx 或网络异常）而丢掉的条数；失败不重试。 */
  droppedFailed: number;
  /** 最近一次投递失败的稳定短码（如 `http-503` / `unavailable`）；不含响应正文。 */
  lastError?: string;
};

export type TelemetryClient = {
  /** 同步入队；绝不抛错、绝不 await、绝不改变调用方结果。 */
  record(input: TelemetryEventInput): void;
  /** 立即投递（测试与离开页面用）；仍不 await。 */
  flush(): void;
  /** 采集自述：供复盘/诊断界面显示缺口。 */
  status(): TelemetryClientStatus;
  /** 停止定时器与页面监听，并做一次 best-effort 投递（`keepalive`）。 */
  dispose(): void;
};

/**
 * 页面环境端口（测试注入）。
 *
 * 只依赖最小面：定时器、`document` 的 `visibilitychange`、window/globalThis 的 `pagehide`。
 * 缺任何一项都退化为"不装该触发器"，不抛错。
 */
export type TelemetryClientTarget = {
  document?: {
    hidden?: boolean;
    visibilityState?: string;
    addEventListener?(type: string, handler: () => void): void;
    removeEventListener?(type: string, handler: () => void): void;
  };
  addEventListener?(type: string, handler: () => void): void;
  removeEventListener?(type: string, handler: () => void): void;
  setInterval?(handler: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
};

export type TelemetryClientOptions = {
  /** 同源 fetch（测试注入）；缺省经挂载前缀解析的 `globalThis.fetch`。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 页面环境（测试注入）；缺省读 `globalThis`/`document`。 */
  target?: TelemetryClientTarget;
  /** 以下三项仅供测试缩短路径；缺省取 `TELEMETRY_CLIENT_LIMITS`。 */
  bufferLimit?: number;
  flushThreshold?: number;
  flushIntervalMs?: number;
  maxBatchEvents?: number;
  /**
   * 盖在每条事件上的构建标识；缺省取构建期注入的 {@link appBuildVersion}（短提交号，未注入为空串）。
   *
   * 显式传 `""` 表示"这条通道不盖章"（测试与特殊宿主）；调用点自己带了 `frontendVersion`
   * 时不覆盖——单条事实比客户端级默认更具体。
   */
  frontendVersion?: string;
};

// `telemetryNow` / `stableTelemetryErrorCode` 住在 `telemetry-primitives.ts`：它们在入口静态闭包里
// 被画布会话直接引用，而这个文件（采集实现）由 App scope 启动时动态加载，不进启动闭包。

/** 创建采集客户端。**不**开始任何 I/O，直到第一条事件或第一次 flush。 */
export function createTelemetryClient(options: TelemetryClientOptions = {}): TelemetryClient {
  const bufferLimit = Math.max(1, Math.trunc(options.bufferLimit ?? TELEMETRY_CLIENT_LIMITS.bufferEvents));
  const flushThreshold = Math.max(1, Math.trunc(options.flushThreshold ?? TELEMETRY_CLIENT_LIMITS.flushThreshold));
  const flushIntervalMs = Math.max(1, Math.trunc(options.flushIntervalMs ?? TELEMETRY_CLIENT_LIMITS.flushIntervalMs));
  const maxBatchEvents = Math.max(1, Math.trunc(options.maxBatchEvents ?? TELEMETRY_CLIENT_LIMITS.maxBatchEvents));
  const target = options.target ?? (globalThis as unknown as TelemetryClientTarget);
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  // 构建标识在创建时解析一次：它是构建期常量；空串表示"这次构建没有注入"，此时不盖章。
  const frontendVersion = options.frontendVersion ?? appBuildVersion();

  let buffer: TelemetryEventInput[] = [];
  let droppedOverflow = 0;
  let droppedInvalid = 0;
  let droppedFailed = 0;
  let lastError: string | undefined;
  let disposed = false;
  let cancelInterval: (() => void) | null = null;
  const detachListeners: Array<() => void> = [];

  const failure = (count: number, code: string) => {
    if (count <= 0) return;
    droppedFailed += count;
    lastError = code;
  };

  /** 投递一批；返回的 Promise 完全由内部消化（成功/失败都不冒泡）。 */
  const send = (batch: readonly TelemetryEventInput[], keepalive: boolean): void => {
    let request: Promise<Response>;
    try {
      request = fetchImpl(TELEMETRY_EVENTS_PATH, {
        method: "POST",
        credentials: "same-origin",
        keepalive,
        headers: { "content-type": "application/json", "x-requested-with": "woohaa3" },
        body: JSON.stringify({ events: batch })
      });
    } catch {
      // fetch 本身同步抛错（例如环境没有 fetch）：按失败计数，不重试。
      failure(batch.length, "unavailable");
      return;
    }
    // 非 2xx 整批丢弃：不保留重发（避免无界重试与把接受端拖垮）。
    void request.then(
      (response) => {
        if (!response || typeof response.ok !== "boolean" || !response.ok) {
          failure(batch.length, `http-${response?.status ?? 0}`);
        }
      },
      () => {
        failure(batch.length, "unavailable");
      }
    );
  };

  /** 把缓冲全部按 ≤maxBatchEvents 切批投递（同步清空缓冲，避免重复投递）。 */
  const drain = (keepalive: boolean): void => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, maxBatchEvents);
      send(batch, keepalive);
    }
  };

  const flush = (keepalive = false): void => {
    if (disposed) return;
    try {
      drain(keepalive);
    } catch {
      // 投递路径的任何意外都不能冒泡到业务调用点。
    }
  };

  const record = (input: TelemetryEventInput): void => {
    if (disposed) return;
    try {
      if (!isRecordable(input)) {
        droppedInvalid += 1;
        return;
      }
      if (buffer.length >= bufferLimit) {
        // 溢出时优先丢 `perf.frame`：它是窗口聚合的可重算事实，而 `perf.interaction`
        // 记录的是不可重放的一次输入（change: 2026-10-25-enhance-telemetry-performance-collection，D4）。
        const frameIndex = buffer.findIndex((entry) => entry.name === "perf.frame");
        if (frameIndex >= 0) buffer.splice(frameIndex, 1);
        else buffer.shift();
        droppedOverflow += 1;
      }
      // 构建标识在这里**单点**补盖：新增事件类型/调用点都不必记得传版本。调用点显式带了
      // `frontendVersion` 时以它为准——单条事实比客户端级默认更具体。
      buffer.push(
        frontendVersion === "" || input.frontendVersion !== undefined ? input : { ...input, frontendVersion }
      );
      // 满 32 条立即投递；此时不等待结果。
      if (buffer.length >= flushThreshold) flush(false);
    } catch {
      // 单条事实的失败不得影响调用方。
    }
  };

  const status = (): TelemetryClientStatus => ({
    queued: buffer.length,
    droppedOverflow,
    droppedInvalid,
    droppedFailed,
    ...(lastError === undefined ? {} : { lastError })
  });

  // 定时投递：5s 一次；环境没有定时器就只保留"满批/离开页面"两条触发路径。
  try {
    if (typeof target.setInterval === "function") {
      const handle = target.setInterval(() => flush(false), flushIntervalMs);
      const clear = target.clearInterval;
      if (typeof clear === "function") cancelInterval = () => clear.call(target, handle);
    }
  } catch {
    cancelInterval = null;
  }

  // visibilitychange（hidden）与 pagehide 都用 keepalive：页面可能在请求完成前被销毁。
  const listen = (
    owner: { addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void } | undefined,
    type: string,
    handler: () => void
  ) => {
    if (!owner || typeof owner.addEventListener !== "function") return;
    owner.addEventListener(type, handler);
    detachListeners.push(() => {
      try {
        owner.removeEventListener?.(type, handler);
      } catch {
        // 忽略：离开页面时的解绑失败没有业务含义。
      }
    });
  };
  const onVisibilityChange = () => {
    const doc = target.document;
    const hidden = doc?.hidden === true || doc?.visibilityState === "hidden";
    if (hidden) flush(true);
  };
  const onPageHide = () => flush(true);
  listen(target.document, "visibilitychange", onVisibilityChange);
  // `pagehide` 在 window 上派发；桌面壳/测试可能只提供 document 级监听。
  listen(target, "pagehide", onPageHide);

  const dispose = (): void => {
    if (disposed) return;
    // 关闭前最后试一次（keepalive），然后不再接受事件。
    flush(true);
    disposed = true;
    try {
      cancelInterval?.();
    } catch {
      // 忽略。
    }
    cancelInterval = null;
    for (const detach of detachListeners.splice(0)) detach();
    buffer = [];
    if (activeTelemetryClient() === client) setActiveTelemetryClient(undefined);
  };

  const client: TelemetryClient = { record, flush: () => flush(false), status, dispose };
  return client;
}

function isRecordable(input: TelemetryEventInput): boolean {
  if (!input || typeof input !== "object") return false;
  const raw = input as { name?: unknown; result?: unknown; origin?: unknown };
  return isTelemetryEventName(raw.name) && isTelemetryResult(raw.result) && isTelemetryOrigin(raw.origin);
}

/**
 * 在 **App scope** 安装一次采集客户端（跨页面存活：切画布/进入复盘页都不停止采集）。
 *
 * `install-services.ts` 只需调用本函数；画布会话与传输通过 `activeTelemetryClient()` 解析它，
 * 不需要把客户端逐层透传。缺失时（插件/测试自建会话）埋点整体 no-op。
 */
export function installTelemetryClient(ctx: Context, options: TelemetryClientOptions = {}): TelemetryClient {
  const client = createTelemetryClient(options);
  setActiveTelemetryClient(client);
  ctx.provide("telemetryClient" as never, client as never);
  ctx.effect(() => () => client.dispose(), "telemetry client");
  return client;
}
