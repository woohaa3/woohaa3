/**
 * 片场总览 LOD 的本地遥测采样（2026-10-28）。
 *
 * 回答的问题：**本地看画布时，声明总览 LOD 的片场实际停在哪一档**。数据源是渲染器已有的
 * `getWorkDiagnostics().models.overviewLod.roots`（`published`/`desired`/`viewportFraction`/
 * `preparing`），本模块只做聚合与采样，不新增几何遍历，也不改 LOD 决策。
 *
 * 采样口径（与 change 一致）：
 * - **缩放停止后**：zoom 变化会重臂一个 `settleMs` 定时器；到点后若仍有片场在准备
 *   （`preparing > 0` 或 desired ≠ published），按 `retryMs` 继续等，最多 `maxRetries` 次，
 *   避免把"刚滚完轮、还在分帧换层"的旧档位当成最终档位写进时间线。
 * - **定时心跳**：画布挂着且页面可见时每 `heartbeatMs` 采一次；与上次结果完全相同且距上次
 *   写入不足 `heartbeatDedupeMs` 时跳过，静止画布不会每秒/每分钟堆同一条事实。
 * - 页面隐藏时丢弃在途的缩放采样；恢复可见后重新采样。
 *
 * 原因分布里的 `high-owner` 会结合**最近一次提交的渲染场景**细分成选中 / 聚焦 / 编辑 / 声明缺失；
 * 读到的只是本地瞬时状态，落到事件里仍只有原因词，不写选择集合或聚焦目标。
 *
 * 隐私边界：事件只带档位计数、准备中数量、最大投影占比与原因分布；**不带完整 nodeId、标题、
 * 画布名或任何脚本内容**。dev 构建额外带 `owners`——非总览根的「节点 id 末 12 字符 + 原因」，
 * 用来把「停在 High 的是哪几个根」从计数落到可回查的摘要（最多 3 条，超出折成 `+N`）；
 * 发布构建不携带该属性。`perf.*` 出口本就不外发（remote 映射为 null）。
 */
import { activeTelemetryClient, telemetryBuildMode, telemetryNow } from "../../services/telemetry-performance.js";

/** 采样常量。窗口/延迟都是本机采集策略，不是契约的一部分。 */
export const OVERVIEW_LOD_TELEMETRY = {
  /** 最后一次 zoom 之后多久算"缩放停止"。 */
  settleMs: 1_500,
  /** 仍在准备时两次采样之间的等待。 */
  retryMs: 1_000,
  /** 最多重试次数；超过后按当前实际档位写入（含 `preparing` 计数）。 */
  maxRetries: 3,
  /** 定时心跳间隔。 */
  heartbeatMs: 60_000,
  /** 结果与上次完全相同且未超过这个间隔时跳过心跳。 */
  heartbeatDedupeMs: 10 * 60_000,
  /** 进入页面后补发运行侧状态（`raster`/`pacing`）的窗口：窗口内 2s 一次，之后回到 60s 心跳。 */
  stateBurstMs: 120_000
} as const;

/** 一个非总览根的可回查摘要：节点 id 末 12 字符 + 原因桶。 */
export type OverviewLodOwner = {
  /** 节点 id 的末 12 字符；本机可用它在画布文档里定位到具体根。 */
  readonly digest: string;
  /** 已归一的固定原因桶（`high-owner` / `offscreen` / ...）。 */
  readonly reason: string;
};

/** 一次采样得到的档位分布（`published` 是实际已发布档位）。 */
export type OverviewLodDistribution = {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  /** desired ≠ published 或 `preparing === true` 的根数量。 */
  readonly preparing: number;
  /** 所有根里最大的可视窗口高度占比；没有有限值时缺省。 */
  readonly fractionMax?: number;
  /** 按原因分桶的根数量；词表封闭，未知原因并入 `other`。 */
  readonly reasons?: Readonly<Record<string, number>>;
  /** 非 `overview` 根的摘要，按原因优先级排序；最多保留 8 条，出口再截到 3 条。 */
  readonly owners?: readonly OverviewLodOwner[];
  /**
   * 当前截图 pin 的目标摘要，排序去重；最多保留 8 条。
   *
   * 有 `captureRequests` 时形如 `<节点 id 末 12 字符>:<来源>`（`video-export` / `shot-image` /
   * `shot-recording` / `model-editor`），用来回答「哪条业务流程把根按在 High」；旧渲染器只有
   * `pins` 节点集合时退化为纯摘要。它与 `owners` 的区别：`owners` 是被 pin 住的根，
   * `pins` 是发起 pin 的截图目标。
   */
  readonly pins?: readonly string[];
  /** `pins` 超过保留上限时省略的条数。 */
  readonly pinsOmitted?: number;
  /**
   * 这一帧真正激活的离屏预览相机数（模型卡片 + 拍摄镜头卡片，仅 dev 构建写出）。
   *
   * draw call 是「所有视图」的合计：`views` 回答「是画得多，还是同一份几何被多个离屏
   * 相机各画了一遍」（2026-10-28 总览 draw call 分析）。
   */
  readonly views?: number;
  /** 渲染器当前持有的模型 mesh 实体数（每视图的绘制上限参考，仅 dev 构建写出）。 */
  readonly entities?: number;
  /** 全部根的总部件数（仅 dev 构建写出）。 */
  readonly parts?: number;
  /** 已进入静态批次的部件数（仅 dev 构建写出）。 */
  readonly batched?: number;
  /** 静态批次实体数（仅 dev 构建写出）。 */
  readonly batches?: number;
  /** 当次采样时的帧节奏标签（仅 dev）：`idle` / `dwell` / `active:<忙碌项>`。 */
  readonly pacing?: string;
  /** 总览片场栅格缓存状态（仅 dev）：`sets=N,live=M,high=..,...`。 */
  readonly raster?: string;
};

/**
 * 原因词表。原始 reason 来自 Rust 的 `overview_reason`（`overview` / `offscreen` /
 * `high-owner` / `degenerate` / `motion-bounds` / `medium-dwell` / `initial` / `preparing` /
 * `held` / `cancelled` / `prepare-failed`）。渲染器已把高优先消费者细分成
 * `high-selected` / `high-focus` / `high-edit` / `high-capture` / `high-export` / `high-world`；
 * 旧 WASM 只报 `high-owner`，采样侧再结合最近场景补分成 `high-selected` 等（另有
 * `high-undeclared` 声明缺失与 `high-missing` 根已离开场景）。其余（初始/准备中/保持/取消/
 * 失败）并入 `other`——它们要么是瞬态，要么已由 `preparing` 计数表达，保留原词只会让
 * `reasons` 长度随 Rust 词表增长而失界。
 */
const LOD_REASON_BUCKETS = [
  "overview",
  "offscreen",
  "high-owner",
  // 渲染器只报 `high-owner`；采样侧用最近一次场景把"谁把它按住"细分出来，
  // 避免再看到 High 时只知道"有高优先消费者"却不知道是哪一种。
  "high-selected",
  "high-focus",
  "high-edit",
  "high-capture",
  "high-export",
  "high-world",
  "high-undeclared",
  // 根已不在这一帧场景里：档位与原因是上一帧残留，渲染器不会再给出新的 LOD 决策。
  "high-missing",
  "degenerate",
  "motion-bounds",
  "other"
] as const;

/** `owners`/`pins` 出口条目上限；超出的条目只留一个 `+N` 计数。 */
const LOD_OWNER_EMIT_LIMIT = 3;

/** `pins` 在分布里保留的条数上限（出口只写 3 条，其余折成 `+N`）。 */
const LOD_PIN_RETAIN_LIMIT = 8;

/**
 * 非总览原因的诊断优先级：先回答「为什么还停在 High」（高优先消费者、退化 bounds、
 * 运动 bounds），再回答「只是不在屏内」。同一原因内按摘要排序，保证输出确定。
 */
const LOD_OWNER_REASON_ORDER = [
  "high-selected",
  "high-focus",
  "high-edit",
  "high-capture",
  "high-export",
  "high-world",
  "high-undeclared",
  "high-missing",
  "high-owner",
  "degenerate",
  "motion-bounds",
  "offscreen",
  "other"
] as const;

/** 摘要取节点 id 末尾多少个字符：12 足够在单个画布的根集合里唯一，又让一行装得下 3 条。 */
const LOD_OWNER_DIGEST_LENGTH = 12;

/**
 * 从工作诊断快照里提取分布。形状不合法（渲染器未就绪/旧 WASM 无该字段）返回 `null`，
 * 调用方静默跳过这次采样——宁可缺一条事实，也不写一条猜的档位。
 */
export function readOverviewLodDistribution(diagnostics: unknown, scene?: unknown): OverviewLodDistribution | null {
  const overview = readPath(diagnostics, ["models", "overviewLod"]);
  const roots = readPath(overview, ["roots"]);
  if (!Array.isArray(roots)) return null;
  let low = 0;
  let medium = 0;
  let high = 0;
  let preparing = 0;
  let fractionMax: number | undefined;
  const reasons: Record<string, number> = {};
  const owners: { digest: string; reason: string; rank: number }[] = [];
  for (const root of roots) {
    const published = readTier(readPath(root, ["published"]));
    if (published === "low") low += 1;
    else if (published === "medium") medium += 1;
    else if (published === "high") high += 1;
    // desired 与 published 不一致说明换层还在路上（High owner 也会这样），计一次准备中。
    const desired = readTier(readPath(root, ["desired"]));
    if (readPath(root, ["preparing"]) === true || (published !== null && desired !== null && desired !== published)) {
      preparing += 1;
    }
    const nodeId = readPath(root, ["nodeId"]);
    const reason = refineHighOwnerReason(readReasonBucket(readPath(root, ["reason"])), nodeId, scene);
    if (reason !== null) reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (reason !== null && reason !== "overview" && typeof nodeId === "string" && nodeId.length > 0) {
      owners.push({
        digest: nodeId.slice(-LOD_OWNER_DIGEST_LENGTH),
        reason,
        rank: ownerRank(reason)
      });
    }
    const fraction = readPath(root, ["viewportFraction"]);
    if (typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0) {
      fractionMax = fractionMax === undefined ? fraction : Math.max(fractionMax, fraction);
    }
  }
  // 离屏预览相机是「同一份几何被多画几遍」的来源：模型预览与拍摄卡片各自有界调度。
  const previewsActive = readCount(readPath(diagnostics, ["previews", "active"]));
  const shotPreviewsActive = readCount(readPath(diagnostics, ["shotPreviews", "active"]));
  const views = previewsActive === undefined && shotPreviewsActive === undefined
    ? undefined
    : (previewsActive ?? 0) + (shotPreviewsActive ?? 0);
  const entities = readCount(readPath(diagnostics, ["models", "modelEntities"]));
  const parts = readCount(readPath(diagnostics, ["models", "parts"]));
  const batched = readCount(readPath(diagnostics, ["models", "batchedParts"]));
  const batches = readCount(readPath(diagnostics, ["models", "staticBatches"]));
  const rasterValue = readPath(diagnostics, ["raster"]);
  const raster = typeof rasterValue === "string" && rasterValue.length > 0 ? rasterValue : undefined;
  const pacingValue = readPath(diagnostics, ["pacing"]);
  const pacing = typeof pacingValue === "string" && pacingValue.length > 0 ? pacingValue : undefined;
  const pinIds = readCapturePinEntries(overview);
  const pins = pinIds.slice(0, LOD_PIN_RETAIN_LIMIT);
  const pinsOmitted = pinIds.length - pins.length;
  const ownerList = owners
    .sort((left, right) => left.rank - right.rank || left.digest.localeCompare(right.digest))
    .map(({ digest, reason }) => ({ digest, reason }));
  return {
    low,
    medium,
    high,
    preparing,
    ...(fractionMax === undefined ? {} : { fractionMax }),
    ...(Object.keys(reasons).length === 0 ? {} : { reasons }),
    ...(ownerList.length === 0 ? {} : { owners: ownerList }),
    ...(pins.length === 0 ? {} : { pins, ...(pinsOmitted > 0 ? { pinsOmitted } : {}) }),
    ...(views === undefined ? {} : { views }),
    ...(entities === undefined ? {} : { entities }),
    ...(parts === undefined ? {} : { parts }),
    ...(batched === undefined ? {} : { batched }),
    ...(batches === undefined ? {} : { batches }),
    ...(pacing === undefined ? {} : { pacing }),
    ...(raster === undefined ? {} : { raster })
  };
}

export type OverviewLodTelemetryTimers = {
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export type OverviewLodTelemetryOptions = {
  /** 读取工作诊断快照（生产传入 `runtime.getWorkDiagnostics`）。 */
  readonly read: () => unknown;
  /**
   * 读取最近一次提交的渲染场景（生产传入 `runtime.lastScene`）。
   *
   * 只用来把渲染器笼统的 `high-owner` 细分成选中 / 聚焦 / 编辑 / 声明缺失；缺省或读取失败时
   * 保留 `high-owner`，不改变档位结论。
   */
  readonly readScene?: () => unknown;
  readonly isHidden?: () => boolean;
  readonly now?: () => number;
} & OverviewLodTelemetryTimers;

export type OverviewLodTelemetryHandle = {
  /** 视口变化回调；只有 zoom 真的变了才重臂"缩放停止"采样（平移不触发）。 */
  viewportChanged(zoom: number): void;
  /** 页面可见性变化（隐藏时丢弃在途采样）。 */
  visibilityChanged(hidden: boolean): void;
  dispose(): void;
};

export function installOverviewLodTelemetry(
  options: OverviewLodTelemetryOptions
): OverviewLodTelemetryHandle {
  const now = options.now ?? telemetryNow;
  const isHidden = options.isHidden ?? defaultIsHidden;
  const timers = resolveTimers(options);
  const doc = globalThis.document as
    | { addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void }
    | undefined;

  let disposed = false;
  let hidden = isHidden();
  let lastZoom: number | null = null;
  let pendingTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let stateTimer: unknown = null;
  let attempt = 0;
  let lastSignature: string | null = null;
  let lastEmittedAt = 0;
  /** 上一次看到的栅格缓存状态：变化时即时补一条，不必等一分钟心跳与 10 分钟去重。 */
  let lastRaster: string | null = null;

  const clearPending = (): void => {
    if (pendingTimer === null) return;
    try {
      timers.clearTimeout(pendingTimer);
    } catch {
      // 清理失败没有业务含义。
    }
    pendingTimer = null;
  };

  const emit = (distribution: OverviewLodDistribution): void => {
    const mode = telemetryBuildMode();
    const client = activeTelemetryClient();
    if (mode === undefined || !client) return;
    const attributes: Record<string, string | number> = {
      mode,
      low: distribution.low,
      medium: distribution.medium,
      high: distribution.high,
      preparing: distribution.preparing
    };
    if (distribution.fractionMax !== undefined) attributes.fractionMax = Math.round(distribution.fractionMax * 1000) / 1000;
    const reasons = formatReasons(distribution.reasons);
    if (reasons !== undefined) attributes.reasons = reasons;
    // 只有 dev 构建带根摘要：发布样本保持纯聚合，避免把节点身份写进长期时间线。
    const owners = mode === "dev" ? formatOwners(distribution.owners) : undefined;
    if (owners !== undefined) attributes.owners = owners;
    const pins = mode === "dev" ? formatPins(distribution.pins, distribution.pinsOmitted) : undefined;
    if (pins !== undefined) attributes.pins = pins;
    if (mode === "dev") {
      if (distribution.views !== undefined) attributes.views = distribution.views;
      if (distribution.entities !== undefined) attributes.entities = distribution.entities;
      if (distribution.parts !== undefined) attributes.parts = distribution.parts;
      if (distribution.batched !== undefined) attributes.batched = distribution.batched;
      if (distribution.batches !== undefined) attributes.batches = distribution.batches;
      // `pacing` 不再上报：静止降频默认关闭，它只占属性预算（契约 `maxAttributesBytes`）。
      if (distribution.raster !== undefined) attributes.raster = distribution.raster;
    }
    try {
      client.record({
        name: "perf.lod",
        result: "success",
        origin: "browser",
        surface: "canvas",
        attributes
      });
      lastSignature = signature(distribution, mode === "dev");
      lastEmittedAt = now();
    } catch {
      // 采集失败绝不进入画布路径（与 telemetry-primitives 同一取向）。
    }
  };

  /** 读取一次；没有声明根（典型：画布里没有片场）时不写任何东西。 */
  const sample = (): OverviewLodDistribution | null => {
    let diagnostics: unknown;
    try {
      diagnostics = options.read();
    } catch {
      return null;
    }
    // 场景只是细分原因用的旁证：读不到就退回笼统原因，不因此丢掉这次档位采样。
    let scene: unknown;
    try {
      scene = options.readScene?.();
    } catch {
      scene = undefined;
    }
    const distribution = readOverviewLodDistribution(diagnostics, scene);
    if (!distribution) return null;
    if (distribution.low + distribution.medium + distribution.high === 0) return null;
    return distribution;
  };

  const scheduleRetry = (): void => {
    clearPending();
    pendingTimer = timers.setTimeout(() => {
      pendingTimer = null;
      settleSample();
    }, OVERVIEW_LOD_TELEMETRY.retryMs);
  };

  const settleSample = (): void => {
    if (disposed || hidden) return;
    const distribution = sample();
    if (!distribution) return;
    if (distribution.preparing > 0 && attempt < OVERVIEW_LOD_TELEMETRY.maxRetries) {
      attempt += 1;
      scheduleRetry();
      return;
    }
    attempt = 0;
    emit(distribution);
  };

  const scheduleSettle = (): void => {
    if (disposed || hidden) return;
    clearPending();
    attempt = 0;
    pendingTimer = timers.setTimeout(() => {
      pendingTimer = null;
      settleSample();
    }, OVERVIEW_LOD_TELEMETRY.settleMs);
  };

  const heartbeat = (): void => {
    if (disposed || hidden || isHidden()) return;
    const distribution = sample();
    if (!distribution) return;
    const includeOwners = telemetryBuildMode() === "dev";
    if (
      lastSignature !== null &&
      signature(distribution, includeOwners) === lastSignature &&
      now() - lastEmittedAt < OVERVIEW_LOD_TELEMETRY.heartbeatDedupeMs
    ) {
      return;
    }
    emit(distribution);
  };

  const onVisibilityChange = (): void => {
    const next = isHidden();
    if (next === hidden) return;
    hidden = next;
    if (hidden) {
      clearPending();
      return;
    }
    // 隐藏期间档位可能已被别的消费者改变；恢复后立即排一次稳定采样。
    scheduleSettle();
  };

  try {
    doc?.addEventListener?.("visibilitychange", onVisibilityChange);
  } catch {
    // 没有 document（原生/测试环境）时仍按定时器采样。
  }
  heartbeatTimer = timers.setInterval(heartbeat, OVERVIEW_LOD_TELEMETRY.heartbeatMs);
  // 进入页面后的一小段窗口内（`stateBurstMs`）用 2s 轮询补发运行侧状态变化，之后交回 60s
  // 心跳：排障时不必等一分钟才拿到一条事实，稳态又不会把时间线刷满。
  const stateBurstUntil = now() + OVERVIEW_LOD_TELEMETRY.stateBurstMs;
  stateTimer = timers.setInterval(() => {
    if (disposed || hidden || isHidden() || now() > stateBurstUntil) return;
    const distribution = sample();
    if (!distribution) return;
    const raster = distribution.raster ?? "";
    if (lastRaster === null) {
      lastRaster = raster;
      return;
    }
    if (raster === lastRaster) return;
    lastRaster = raster;
    emit(distribution);
  }, 2_000);
  scheduleSettle();

  return {
    viewportChanged(zoom) {
      if (disposed) return;
      if (lastZoom !== null && zoom === lastZoom) return;
      lastZoom = zoom;
      scheduleSettle();
    },
    visibilityChanged(next) {
      if (next === hidden) return;
      hidden = next;
      if (hidden) clearPending();
      else scheduleSettle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearPending();
      if (stateTimer !== null) {
        try {
          timers.clearInterval(stateTimer);
        } catch {
          // 清理失败没有业务含义。
        }
        stateTimer = null;
      }
      if (heartbeatTimer !== null) {
        try {
          timers.clearInterval(heartbeatTimer);
        } catch {
          // 清理失败没有业务含义。
        }
        heartbeatTimer = null;
      }
      try {
        doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
      } catch {
        // 解绑失败没有业务含义。
      }
    }
  };
}

function resolveTimers(options: OverviewLodTelemetryTimers): Required<OverviewLodTelemetryTimers> {
  return {
    setTimeout:
      options.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms)),
    clearTimeout:
      options.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)),
    setInterval:
      options.setInterval ?? ((handler: () => void, ms: number) => globalThis.setInterval(handler, ms)),
    clearInterval:
      options.clearInterval ?? ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>))
  };
}

function defaultIsHidden(): boolean {
  const doc = globalThis.document as { hidden?: boolean; visibilityState?: string } | undefined;
  return doc?.hidden === true || doc?.visibilityState === "hidden";
}

function signature(distribution: OverviewLodDistribution, includeOwners: boolean): string {
  return [
    distribution.low,
    distribution.medium,
    distribution.high,
    distribution.preparing,
    distribution.fractionMax ?? "",
    formatReasons(distribution.reasons) ?? "",
    // 参与去重的是「实际会写出的属性」：发布构建不写 owners/pins，就不该因根集合变化多写一行。
    includeOwners ? (formatOwners(distribution.owners) ?? "") : "",
    includeOwners ? (formatPins(distribution.pins, distribution.pinsOmitted) ?? "") : "",
    includeOwners ? (distribution.views ?? "") : "",
    includeOwners ? (distribution.entities ?? "") : "",
    includeOwners ? (distribution.parts ?? "") : "",
    includeOwners ? (distribution.batched ?? "") : "",
    includeOwners ? (distribution.batches ?? "") : "",
    distribution.pacing ?? "",
    distribution.raster ?? ""
  ].join("|");
}

/**
 * 把非总览根摘要压成 `3e6abb0c-f350:high-owner,...` 的单行字符串。
 * 最多 3 条，剩下的折成 `+N`（N 是对外省略的根数），总长有界。
 */
function formatOwners(owners: readonly OverviewLodOwner[] | undefined): string | undefined {
  if (!owners || owners.length === 0) return undefined;
  const shown = owners.slice(0, LOD_OWNER_EMIT_LIMIT);
  const parts = shown.map((owner) => `${owner.digest}:${owner.reason}`);
  const omitted = owners.length - shown.length;
  if (omitted > 0) parts.push(`+${omitted}`);
  return parts.join(",");
}

/**
 * 读当前截图 pin 的目标身份。
 *
 * 优先用 `captureRequests`（节点 id + 来源），产出 `<末 12 字符>:<来源>`；只有 `pins`
 * 节点集合时退化为纯摘要。来源标签来自调用方（`requestCapture` 的 `source`），渲染器不解
 * 释它——这里只透传、不白名单，新来源不会因为采样侧表里没有就被丢掉。
 */
function readCapturePinEntries(overview: unknown): string[] {
  const requests = readPath(overview, ["captureRequests"]);
  if (Array.isArray(requests)) {
    const entries = requests.flatMap((request) => {
      const nodeId = readPath(request, ["nodeId"]);
      if (typeof nodeId !== "string" || nodeId.length === 0) return [];
      const source = readPath(request, ["source"]);
      const digest = nodeId.slice(-LOD_OWNER_DIGEST_LENGTH);
      return [typeof source === "string" && source.length > 0 ? `${digest}:${source}` : digest];
    });
    if (entries.length > 0) return [...new Set(entries)].sort();
  }
  const rawPins = readPath(overview, ["pins"]);
  if (!Array.isArray(rawPins)) return [];
  return [...new Set(rawPins
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => id.slice(-LOD_OWNER_DIGEST_LENGTH)))].sort();
}

/**
 * 把截图 pin 摘要压成 `3e6abb0c-f350,1f2770cab380,+2` 的单行字符串。
 * 最多 3 条，其余（含保留上限之外）折成 `+N`。
 */
function formatPins(pins: readonly string[] | undefined, omitted = 0): string | undefined {
  if (!pins || pins.length === 0) return undefined;
  const head = pins.slice(0, LOD_OWNER_EMIT_LIMIT);
  const extra = pins.length - head.length + omitted;
  return extra > 0 ? `${head.join(",")},+${extra}` : head.join(",");
}

/** 非总览原因 → 诊断优先级（未知原因排最后，与 `other` 同档）。 */
function ownerRank(reason: string): number {
  const index = (LOD_OWNER_REASON_ORDER as readonly string[]).indexOf(reason);
  return index === -1 ? LOD_OWNER_REASON_ORDER.length : index;
}

/**
 * 把原因计数压成 `overview=12,offscreen=2` 的单行字符串。词表封闭（见
 * `LOD_REASON_BUCKETS`），只输出非零项并按数量降序，长度与基数都有界。
 */
function formatReasons(reasons: Readonly<Record<string, number>> | undefined): string | undefined {
  if (!reasons) return undefined;
  const entries = LOD_REASON_BUCKETS.map((bucket) => [bucket, reasons[bucket] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (entries.length === 0) return undefined;
  return entries.map(([bucket, count]) => `${bucket}=${count}`).join(",");
}

/** 原始 `overview_reason` → 封闭词表；未知/缺失并入 `other`，保证计数仍能求和到根数量。 */
function readReasonBucket(value: unknown): string {
  return typeof value === "string" && (LOD_REASON_BUCKETS as readonly string[]).includes(value) ? value : "other";
}

/**
 * 渲染器只把"有高优先消费者"归成 `high-owner`。采样侧用最近一次提交的场景把它细分：
 * 选中 / 聚焦 / 编辑 / 声明缺失；对不上任何已知来源时保留笼统的 `high-owner`
 * （典型：截图或导出 pin 住的根）。没有场景（旧 fake / 未就绪）时同样保留笼统值。
 */
function refineHighOwnerReason(reason: string, nodeId: unknown, scene: unknown): string {
  if (reason !== "high-owner" || typeof nodeId !== "string" || nodeId.length === 0 || !scene) return reason;
  return highOwnerCause(nodeId, scene);
}

function highOwnerCause(nodeId: string, scene: unknown): string {
  const selection = readPath(scene, ["selection", "nodes"]);
  if (Array.isArray(selection) && selection.includes(nodeId)) return "high-selected";
  if (readPath(scene, ["modelFocus", "nodeId"]) === nodeId) return "high-focus";
  if (readPath(scene, ["modelEditor", "nodeId"]) === nodeId) return "high-edit";
  const nodes = readPath(scene, ["nodes"]);
  if (Array.isArray(nodes)) {
    const node = nodes.find((candidate) => readPath(candidate, ["id"]) === nodeId);
    // 根本轮不在场景里：渲染器不会再为它做 LOD 决策，档位与原因都是上一帧残留。
    if (node === undefined) return "high-missing";
    // 根在渲染器里仍按总览 LOD 存在，但这一帧场景没带声明：按非总览世界节点保持 High。
    if (readPath(node, ["compositeAsset", "geometryQuality"]) === undefined) return "high-undeclared";
  }
  return "high-owner";
}

/** `High` / `Medium` / `Low`（Rust `Debug` 输出）→ 小写；未知值 `null`。 */
function readTier(value: unknown): "low" | "medium" | "high" | null {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return null;
  }
}

/** 非负整数的计数；形状不合法就当"读不到"（不写猜的 0）。 */
function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
