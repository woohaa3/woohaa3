/**
 * 预览派生物（缩略图/海报）的受控读取与有界后台生成
 * （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.1-4.2）。
 *
 * 边界：
 * - 字节只经**注入的** `MediaStorage` 读写；服务不知道后端是 local、COS 还是服务端托管。
 * - 编码/缩放由**注入的** `MediaDerivativeGenerator` 完成（宿主 Worker/受控工具）。本模块
 *   **不**在主事件循环同步解码，也不自带 codec 依赖。
 * - 派生物是可清理缓存，不是 canonical 资产：不产生 asset/job/history，不改原图。
 * - 缓存键由 `contracts` 的稳定派生身份派生，不含 nodeId、展示 URL 或临时授权参数。
 *
 * 三条硬不变量：
 * 1. **缓存命中仍要验证访问**：每次读取都先按当前作用域探测原资产；缺权限/原资产失效时
 *    直接失败，不回退到「本机有缓存就返回字节」。
 * 2. **有界**：同时在跑 `concurrency` 个转换，其余排队（队列有上限）；输入字节、输入像素、
 *    输出像素与派生磁盘占用都有上限；同 key 在途任务合并；失败清理未完成对象并可显式重试。
 * 3. **不谎报**：存储不支持 `delete` 时不做假淘汰（记账删了字节还在），按 `cache-full` 失败。
 */
import {
  MEDIA_DERIVATIVE_FORMATS,
  isDerivableSourceKey,
  isMediaObjectNotFoundError,
  mediaDerivativeCacheKey,
  type MediaDerivativeIdentity,
  type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";

export type MediaDerivativeErrorCode =
  | "malformed-request"
  | "unsupported"
  | "source-unavailable"
  | "payload-too-large"
  | "pixel-limit"
  | "cache-full"
  | "background-busy"
  | "generation-failed";

/** 派生物错误：稳定 code + HTTP 语义，供 public handler 与进程内调用共用。 */
export class MediaDerivativeError extends Error {
  constructor(
    readonly code: MediaDerivativeErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "MediaDerivativeError";
  }
}

/** 转换输入：已通过上限校验的原资产字节。 */
export type MediaDerivativeGenerateInput = {
  identity: MediaDerivativeIdentity;
  bytes: Uint8Array;
  contentType: string;
  /** 允许的输出长边（身份档位）。 */
  edge: number;
  /** 解码前必须复核的输入像素上限（防解压炸弹）。 */
  maxInputPixels: number;
};

/** 转换结果；`width/height` 用于输出像素上限与档位复核。 */
export type MediaDerivativeGenerateResult = {
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
};

/**
 * 转换执行器端口：由宿主注入（Worker/受控工具）。
 *
 * 实现必须在自己的后台执行环境里解码；本模块只负责并发/排队/预算/缓存，不假设 codec。
 */
export type MediaDerivativeGenerator = (
  input: MediaDerivativeGenerateInput
) => Promise<MediaDerivativeGenerateResult>;

export type MediaDerivativeLimits = {
  /** 同时在跑的转换数（design D3：2 个后台任务）。 */
  concurrency: number;
  /** 排队上限；超出直接以可重试错误结束，不无限堆积。 */
  maxQueued: number;
  /** 单次转换输入的字节上限。 */
  maxInputBytes: number;
  /** 单次转换解码后的输入像素上限（防解压炸弹；由生成器在解码前复核）。 */
  maxInputPixels: number;
  /** 单次转换输出像素上限。 */
  maxOutputPixels: number;
  /** 每个作用域（画布/无作用域）的派生磁盘预算。 */
  cacheBytesPerScope: number;
  /** 单次读取最多等待生成完成的毫秒数；超时以 `pending` 结束，由调用方重试。 */
  waitMs: number;
};

export const DEFAULT_DERIVATIVE_LIMITS: MediaDerivativeLimits = {
  concurrency: 2,
  maxQueued: 64,
  maxInputBytes: 64 * 1024 * 1024,
  maxInputPixels: 64 * 1024 * 1024,
  maxOutputPixels: 4 * 1024 * 1024,
  cacheBytesPerScope: 512 * 1024 * 1024,
  waitMs: 4_000
};

export type MediaDerivativeReadResult =
  | { status: "ready"; bytes: Uint8Array; contentType: string }
  /** 已排队/正在生成，调用方保持占位或上次合法图并稍后重试。 */
  | { status: "pending" };

export type MediaDerivativeStats = {
  /** 成功生成的派生物数。 */
  generated: number;
  failed: number;
  /** 同 key 合并掉的请求数。 */
  merged: number;
  /** 缓存命中次数（仍然做过原资产授权探测）。 */
  hits: number;
  evicted: number;
  /** 当前在跑/排队数量与各作用域已记账的字节数。 */
  running: number;
  queued: number;
  cacheBytes: Record<string, number>;
};

type ScopeKey = string;
type Entry = { bytes: number; at: number };
type Task = { key: string; start: () => void; promise: Promise<void> };

function scopeKeyOf(scope?: MediaStorageScope): ScopeKey {
  return scope?.canvasId ?? "";
}

/** 结算或超时：`false` 表示仍在进行（调用方保持占位并稍后重试）。 */
function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createMediaDerivatives(options: {
  storage: MediaStorage;
  /** 缺省表示本部署不支持派生：读取直接以 `unsupported` 结束，调用方回退原图。 */
  generator?: MediaDerivativeGenerator;
  limits?: Partial<MediaDerivativeLimits>;
  /** 时钟注入（LRU 判定）。 */
  now?: () => number;
}): MediaDerivativeReadFacade {
  const storage = options.storage;
  const generator = options.generator;
  const limits: MediaDerivativeLimits = { ...DEFAULT_DERIVATIVE_LIMITS, ...options.limits };
  const now = options.now ?? (() => Date.now());

  const inFlight = new Map<string, Promise<void>>();
  const queue: Task[] = [];
  /** 每作用域的 LRU：缓存键 → 字节数与最后使用时间。 */
  const cache = new Map<ScopeKey, Map<string, Entry>>();
  let running = 0;
  let generated = 0;
  let failed = 0;
  let merged = 0;
  let hits = 0;
  let evicted = 0;

  const cacheOf = (scopeKey: ScopeKey): Map<string, Entry> => {
    let entries = cache.get(scopeKey);
    if (!entries) {
      entries = new Map();
      cache.set(scopeKey, entries);
    }
    return entries;
  };
  const usedBytes = (scopeKey: ScopeKey): number => {
    let total = 0;
    for (const entry of cache.get(scopeKey)?.values() ?? []) total += entry.bytes;
    return total;
  };

  /**
   * 淘汰最久未使用的派生物为 `needed` 字节腾位置。
   *
   * 存储不支持 `delete` 时**不做假淘汰**，直接返回 false：调用方按 `cache-full` 失败并继续
   * 显示原图，而不是让记账比真实占用乐观。
   */
  const makeRoom = async (
    scopeKey: ScopeKey,
    scope: MediaStorageScope | undefined,
    needed: number
  ): Promise<boolean> => {
    if (usedBytes(scopeKey) + needed <= limits.cacheBytesPerScope) return true;
    if (typeof storage.delete !== "function") return false;
    const entries = cacheOf(scopeKey);
    while (usedBytes(scopeKey) + needed > limits.cacheBytesPerScope) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return false;
      try {
        await storage.delete(oldestKey, scope);
      } catch {
        // 删除失败不能留下「记账已删」的错误状态。
        return false;
      }
      entries.delete(oldestKey);
      evicted++;
    }
    return true;
  };

  const pump = (): void => {
    while (running < limits.concurrency && queue.length > 0) {
      const task = queue.shift()!;
      running++;
      task.start();
      void task.promise
        .catch(() => undefined)
        .finally(() => {
          running--;
          if (inFlight.get(task.key) === task.promise) inFlight.delete(task.key);
          pump();
        });
    }
  };

  /**
   * 授权探测：按**当前作用域**证明原资产仍可读。
   *
   * 缓存命中也要先过这一步：缓存是本机字节，不能替代当前画布/资产权限。
   */
  const authorize = async (
    identity: MediaDerivativeIdentity,
    scope: MediaStorageScope | undefined
  ): Promise<{ bytes: Uint8Array; contentType: string } | { probeOnly: true }> => {
    const denied = (error: unknown): never => {
      if (isMediaObjectNotFoundError(error)) {
        throw new MediaDerivativeError("source-unavailable", 404, "原资产不存在或当前作用域不可访问");
      }
      throw new MediaDerivativeError("source-unavailable", 403, "原资产读取被拒绝");
    };
    if (typeof storage.stat === "function") {
      try {
        const stat = await storage.stat(identity.sourceKey, scope);
        if (!Number.isFinite(stat.size) || stat.size <= 0) {
          throw new MediaDerivativeError("source-unavailable", 404, "原资产不存在或当前作用域不可访问");
        }
        if (stat.size > limits.maxInputBytes) {
          throw new MediaDerivativeError("payload-too-large", 413, "原资产超过派生物输入上限");
        }
      } catch (error) {
        if (error instanceof MediaDerivativeError) throw error;
        return denied(error);
      }
      return { probeOnly: true };
    }
    // 没有 stat 的存储只能整取；字节同样受上限约束。
    try {
      const object = await storage.get(identity.sourceKey, scope);
      if (object.bytes.byteLength > limits.maxInputBytes) {
        throw new MediaDerivativeError("payload-too-large", 413, "原资产超过派生物输入上限");
      }
      return { bytes: object.bytes, contentType: object.contentType ?? "application/octet-stream" };
    } catch (error) {
      if (error instanceof MediaDerivativeError) throw error;
      return denied(error);
    }
  };

  const readSource = async (
    identity: MediaDerivativeIdentity,
    scope: MediaStorageScope | undefined,
    probe: { bytes: Uint8Array; contentType: string } | { probeOnly: true }
  ): Promise<{ bytes: Uint8Array; contentType: string }> => {
    if ("bytes" in probe) return probe;
    try {
      const object = await storage.get(identity.sourceKey, scope);
      if (object.bytes.byteLength > limits.maxInputBytes) {
        throw new MediaDerivativeError("payload-too-large", 413, "原资产超过派生物输入上限");
      }
      return { bytes: object.bytes, contentType: object.contentType ?? "application/octet-stream" };
    } catch (error) {
      if (error instanceof MediaDerivativeError) throw error;
      if (isMediaObjectNotFoundError(error)) {
        throw new MediaDerivativeError("source-unavailable", 404, "原资产不存在或当前作用域不可访问");
      }
      throw new MediaDerivativeError("source-unavailable", 403, "原资产读取被拒绝");
    }
  };

  const validateOutput = (identity: MediaDerivativeIdentity, result: MediaDerivativeGenerateResult): void => {
    const { width, height } = result;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new MediaDerivativeError("generation-failed", 500, "派生物尺寸非法");
    }
    if (Math.max(width, height) > identity.edge) {
      throw new MediaDerivativeError("generation-failed", 500, "派生物超过请求档位");
    }
    if (width * height > limits.maxOutputPixels) {
      throw new MediaDerivativeError("pixel-limit", 413, "派生物输出像素超限");
    }
    const expected = MEDIA_DERIVATIVE_FORMATS[identity.format];
    if (result.contentType && result.contentType !== expected) {
      throw new MediaDerivativeError("generation-failed", 500, "派生物内容类型与身份不符");
    }
    if (result.bytes.byteLength === 0) {
      throw new MediaDerivativeError("generation-failed", 500, "派生物为空");
    }
  };

  /** 入队一次转换；失败不写缓存，也不留「已记账」的假条目。 */
  const enqueue = (
    identity: MediaDerivativeIdentity,
    key: string,
    scope: MediaStorageScope | undefined
  ): Promise<void> => {
    if (!generator) {
      return Promise.reject(new MediaDerivativeError("unsupported", 415, "本部署未启用派生物生成"));
    }
    if (queue.length + running >= limits.maxQueued) {
      return Promise.reject(new MediaDerivativeError("background-busy", 429, "派生物生成队列已满，请稍后重试"));
    }
    const scopeKey = scopeKeyOf(scope);
    let start!: () => void;
    const started = new Promise<void>(resolve => {
      start = resolve;
    });
    const promise = (async () => {
      // 由 `pump` 决定何时真正开始：创建即执行会让并发上限形同虚设。
      await started;
      try {
        const probe = await authorize(identity, scope);
        const source = await readSource(identity, scope, probe);
        const result = await generator({
          identity,
          bytes: source.bytes,
          contentType: source.contentType,
          edge: identity.edge,
          maxInputPixels: limits.maxInputPixels
        });
        validateOutput(identity, result);
        if (!(await makeRoom(scopeKey, scope, result.bytes.byteLength))) {
          throw new MediaDerivativeError("cache-full", 507, "派生物缓存已满，暂时无法写入新缩略图");
        }
        await storage.put(key, result.bytes, result.contentType, scope);
        cacheOf(scopeKey).set(key, { bytes: result.bytes.byteLength, at: now() });
        generated++;
      } catch (error) {
        failed++;
        throw error;
      }
    })();
    inFlight.set(key, promise);
    queue.push({ key, start, promise });
    pump();
    return promise;
  };

  const cachedRead = async (
    key: string,
    scope: MediaStorageScope | undefined,
    scopeKey: ScopeKey,
    fallbackType: string
  ): Promise<MediaDerivativeReadResult> => {
    const object = await storage.get(key, scope);
    cacheOf(scopeKey).set(key, { bytes: object.bytes.byteLength, at: now() });
    hits++;
    return { status: "ready", bytes: object.bytes, contentType: object.contentType ?? fallbackType };
  };

  return {
    limits,
    async read({ identity, scope, waitMs }) {
      const key = mediaDerivativeCacheKey(identity);
      if (!key) throw new MediaDerivativeError("malformed-request", 400, "派生物身份非法");
      if (!isDerivableSourceKey(identity.sourceKey)) {
        throw new MediaDerivativeError("malformed-request", 400, "只有内容寻址资产可以派生预览");
      }
      // ① 授权：缓存命中也要先按当前作用域探测原资产（缓存不是访问许可）。
      await authorize(identity, scope);
      const scopeKey = scopeKeyOf(scope);
      const contentType = MEDIA_DERIVATIVE_FORMATS[identity.format];
      // ② 缓存（内存记账或存储中已存在——进程重启后仍复用同一 variant）。
      const exists = cacheOf(scopeKey).has(key)
        || (typeof storage.exists === "function" && (await storage.exists(key, scope)));
      if (exists) return cachedRead(key, scope, scopeKey, contentType);
      // ③ 合并同 key 在途任务，否则入队。
      const pending = inFlight.get(key);
      const task = pending ?? enqueue(identity, key, scope);
      if (pending) merged++;
      if (!(await settlesWithin(task, waitMs ?? limits.waitMs))) return { status: "pending" };
      return cachedRead(key, scope, scopeKey, contentType);
    },
    stats() {
      return {
        generated,
        failed,
        merged,
        hits,
        evicted,
        running,
        queued: queue.length,
        cacheBytes: Object.fromEntries(
          [...cache].map(([scope, entries]) => [
            scope,
            [...entries.values()].reduce((total, entry) => total + entry.bytes, 0)
          ])
        )
      };
    },
    async drain() {
      while (queue.length > 0 || running > 0 || inFlight.size > 0) {
        await Promise.allSettled([...inFlight.values()]);
        if (queue.length === 0 && running === 0 && inFlight.size === 0) break;
      }
    }
  };
}

/** 派生物读取面（组合根与 handler 共用）。 */
export type MediaDerivativeReadFacade = {
  readonly limits: MediaDerivativeLimits;
  read(input: {
    identity: MediaDerivativeIdentity;
    scope?: MediaStorageScope;
    waitMs?: number;
  }): Promise<MediaDerivativeReadResult>;
  stats(): MediaDerivativeStats;
  drain(): Promise<void>;
};
