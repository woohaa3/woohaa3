/**
 * 扩展渲染故障跟踪与会话内熔断
 * （change: 2026-10-21-harden-extension-fault-isolation，design D2/D3，任务 2.4）。
 *
 * App scope 单例 `extensionFaults`：
 * - `report()` 接收 ContributionBoundary 捕获的渲染错误，记录有界诊断 `extension.render-failed`；
 * - 同一可选扩展在时间窗内错误次数**超过**阈值（默认 60s 内 > 3 次）时熔断：调用装配方登记的
 *   `trip()` 释放该扩展（其全部贡献随 fiber 撤销），本会话内不自动重试；
 * - required 扩展只记录、不熔断（撤销 required 等于让 scope 失败）；
 * - 熔断只在内存中，不写站点配置或浏览器偏好；`reload()` 清零计数并让装配方以新 epoch 重新装配。
 *
 * 幂等：已熔断的扩展再报错不计数、不重复通知；旧 epoch 的迟到报告被忽略。
 * 宿主不按扩展 ID 分支：身份只来自宿主盖章的 origin。
 */

import { activeTelemetryClient } from "./services/telemetry-primitives.js";

export const RENDER_FAULT_WINDOW_MS = 60_000;
export const RENDER_FAULT_THRESHOLD = 3;
const MAX_DIAGNOSTICS = 50;

/**
 * 故障类别（遥测 `errorCode`）：只区分发生在哪类路径，不携带错误消息或堆栈。
 * - `render`：React 渲染抛错（ContributionBoundary）；
 * - `callback`：宿主同步调用扩展回调抛错（guardContributionCall）。
 */
export type ExtensionFaultKind = "render" | "callback";

export type ExtensionRenderFailure = {
  extensionId: string;
  epoch: number;
  slot: string;
  contributionId: string;
  /** 仅用于本地诊断与设置卡片提示；MUST NOT 进入遥测。 */
  message: string;
  kind?: ExtensionFaultKind;
};

export type ExtensionRenderFailedDiagnostic = ExtensionRenderFailure & {
  event: "extension.render-failed";
  at: number;
};

/** 装配方（kernel / reconciler）为一个已装配扩展登记的控制。 */
export type ExtensionFaultHandle = {
  required: boolean;
  /** 当前装配 epoch；只有该 epoch 的报告计入。 */
  epoch: number;
  /** 熔断：释放该扩展的当前装配。 */
  trip: (reason: "render-fault-threshold") => void;
  /** 重新加载：以新 epoch 重新装配（可选；缺省时设置面板只提示刷新）。 */
  reload?: () => void;
};

export type ExtensionFaultState = {
  extensionId: string;
  tripped: boolean;
  reason: "render-fault-threshold" | null;
  recentFailures: number;
  lastMessage: string | null;
  reloadable: boolean;
};

export interface ExtensionFaultService {
  report(failure: ExtensionRenderFailure): void;
  /** 装配方登记；返回注销函数（释放装配时调用）。重复登记同一扩展以最新为准。 */
  attach(extensionId: string, handle: ExtensionFaultHandle): () => void;
  isTripped(extensionId: string): boolean;
  stateOf(extensionId: string): ExtensionFaultState | null;
  /** 解除熔断并请求重新装配；返回是否已发起。 */
  reload(extensionId: string): boolean;
  diagnostics(): readonly ExtensionRenderFailedDiagnostic[];
  subscribe(listener: () => void): () => void;
  version(): number;
}

type Entry = {
  handle: ExtensionFaultHandle | null;
  /** 最近一次登记的重新装配入口；熔断释放后 handle 已注销，仍需保留它供「重新加载」使用。 */
  reloader: (() => void) | null;
  failures: number[];
  tripped: boolean;
  /** 熔断时的 epoch：该 epoch 的迟到报告不再计数。 */
  trippedEpoch: number | null;
  lastMessage: string | null;
};

export type ExtensionFaultServiceOptions = {
  now?: () => number;
  windowMs?: number;
  threshold?: number;
  logger?: (event: Record<string, unknown>) => void;
  /** 遥测出口（缺省为当前已安装的本机遥测客户端；未安装即 no-op）。 */
  telemetry?: () => { record(input: import("@woohaa3/contracts").TelemetryEventInput): void } | undefined;
};

export function createExtensionFaultService(options: ExtensionFaultServiceOptions = {}): ExtensionFaultService {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? RENDER_FAULT_WINDOW_MS;
  const threshold = options.threshold ?? RENDER_FAULT_THRESHOLD;
  const log = options.logger ?? ((event: Record<string, unknown>) => console.warn("[extension-faults]", event));
  const telemetry = options.telemetry ?? activeTelemetryClient;
  /** 本机遥测：只带身份、slot、epoch 与类别；绝不抛错、不影响隔离流程。 */
  const recordTelemetry = (failure: ExtensionRenderFailure) => {
    try {
      telemetry()?.record({
        name: "extension.render-failed",
        result: "failure",
        // 与 canvas-session 等既有前端埋点一致：浏览器 WebView（含桌面壳）统一记 browser。
        origin: "browser",
        errorCode: `extension.${failure.kind ?? "render"}`,
        attributes: { extension: failure.extensionId, slot: failure.slot, epoch: String(failure.epoch) }
      });
    } catch {
      // 遥测永远不进入业务路径。
    }
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const diagnostics: ExtensionRenderFailedDiagnostic[] = [];
  let revision = 0;

  const emit = () => {
    revision += 1;
    for (const listener of [...listeners]) listener();
  };
  const entryOf = (extensionId: string): Entry => {
    let entry = entries.get(extensionId);
    if (!entry) {
      entry = { handle: null, reloader: null, failures: [], tripped: false, trippedEpoch: null, lastMessage: null };
      entries.set(extensionId, entry);
    }
    return entry;
  };

  return {
    report(failure) {
      const at = now();
      const record: ExtensionRenderFailedDiagnostic = { event: "extension.render-failed", at, ...failure };
      diagnostics.push(record);
      recordTelemetry(failure);
      if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
      log({ ...record });
      const entry = entryOf(failure.extensionId);
      entry.lastMessage = failure.message;
      // 已熔断：不计数、不重复通知。
      if (entry.tripped) return;
      const handle = entry.handle;
      // 旧 epoch 的迟到报告不计入当前装配。
      if (handle && failure.epoch !== handle.epoch) {
        emit();
        return;
      }
      entry.failures = entry.failures.filter((time) => at - time < windowMs);
      entry.failures.push(at);
      if (entry.failures.length > threshold && handle && !handle.required) {
        entry.tripped = true;
        entry.trippedEpoch = handle.epoch;
        log({ event: "extension.render-fault-tripped", extensionId: failure.extensionId, epoch: handle.epoch, failures: entry.failures.length });
        try {
          handle.trip("render-fault-threshold");
        } catch (error) {
          log({ event: "extension.render-fault-trip-failed", extensionId: failure.extensionId, message: error instanceof Error ? error.message : String(error) });
        }
      }
      emit();
    },
    attach(extensionId, handle) {
      const entry = entryOf(extensionId);
      entry.handle = handle;
      entry.reloader = handle.reload ?? null;
      // 新 epoch 的装配（重新加载或重新激活）自然清零上一装配的计数。
      if (entry.trippedEpoch !== handle.epoch) {
        entry.failures = [];
        if (entry.tripped && entry.trippedEpoch !== null) {
          entry.tripped = false;
          entry.trippedEpoch = null;
        }
      }
      emit();
      return () => {
        if (entry.handle === handle) entry.handle = null;
        emit();
      };
    },
    isTripped: (extensionId) => entries.get(extensionId)?.tripped ?? false,
    stateOf(extensionId) {
      const entry = entries.get(extensionId);
      if (!entry) return null;
      return {
        extensionId,
        tripped: entry.tripped,
        reason: entry.tripped ? "render-fault-threshold" : null,
        recentFailures: entry.failures.length,
        lastMessage: entry.lastMessage,
        reloadable: entry.reloader !== null
      };
    },
    reload(extensionId) {
      const entry = entries.get(extensionId);
      if (!entry?.tripped) return false;
      const reload = entry.reloader;
      if (!reload) return false;
      entry.tripped = false;
      entry.trippedEpoch = null;
      entry.failures = [];
      emit();
      reload();
      return true;
    },
    diagnostics: () => diagnostics,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => revision
  };
}
